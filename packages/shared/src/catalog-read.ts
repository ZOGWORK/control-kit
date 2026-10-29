import { boreConflict, configurationValues, coversNumbers, findBestMatch, findLibraryMapping, libraryMapKey, nameCoverage, nameSimilarity, vendorTag, normalizeName, normalizeSku, rankVendorAlternatives, skuCandidates, spellSizes, type LibraryMapping, type MatchResult, type VendorId, type VendorRecord } from './matching';
import { decisionRecord, recalculatePurchasing, type MatchDecision, type ScanResult } from './index';
import { knownProduct, successorOf, withKnownPack } from './known-products';

/**
 * Reading published vendor catalogs. Storage layout (written by the Worker's ingestion and staged publish):
 *   cat:{vendor}:pointer              live generation { gen, batches, records, complete, ... }
 *   cat:{vendor}:gen:{gen}:index      [normalizedSku, normalizedName, batch, previousBatch?] for every record
 *   cat:{vendor}:gen:{gen}:batch:{n}  VendorRecord[]
 * Generation keys never change once written, so a browser may cache them indefinitely.
 */
export type CatalogReader = { get(key: string): Promise<string | null> };
export type IndexEntry = [normalizedSku: string, normalizedName: string, batch: number, previousBatch?: number];
export const catalogVendors: VendorId[] = ['gobilda', 'servocity', 'andymark', 'rev', 'pitsco'];
export const pointerKey = (vendor: VendorId) => `cat:${vendor}:pointer`;
export const batchKey = (vendor: VendorId, gen: string, batch: number) => `cat:${vendor}:gen:${gen}:batch:${batch}`;
export const indexKey = (vendor: VendorId, gen: string) => `cat:${vendor}:gen:${gen}:index`;
/** The keys a catalog reader may fetch: a vendor pointer, an index or batch of a generation, or a document's library mappings. */
export const catalogReadKey = /^(?:cat:(?:gobilda|servocity|andymark|rev|pitsco):(?:pointer|gen:[a-z0-9]{1,16}:(?:index|batch:\d{1,5}))|library-map:[\w-]{1,128})$/;
type ReaderPointer = { gen: string; records: number; batches?: number };
const vendors = catalogVendors;
type Kv = CatalogReader;
type CatalogPointer = ReaderPointer;
export function clearCatalogMemoryCache() { memory.clear(); indexes.clear(); }

const memory = new Map<string, { value: string | null; expires: number }>();
let activeGets = 0;
const waiters: Array<() => void> = [];
async function limitedGet(kv: Kv, key: string, signal?: AbortSignal) {
  if (signal?.aborted) throw signal.reason;
  if (activeGets < 20) activeGets++;
  else await new Promise<void>((resolve, reject) => {
    const resume = () => { signal?.removeEventListener('abort', stop); resolve(); };
    const stop = () => { const index = waiters.indexOf(resume); if (index >= 0) waiters.splice(index, 1); reject(signal?.reason); };
    waiters.push(resume);
    signal?.addEventListener('abort', stop, { once: true });
  });
  try {
    if (signal?.aborted) throw signal.reason;
    return await kv.get(key);
  } finally {
    const next = waiters.shift();
    if (next) next();
    else activeGets--;
  }
}
const read = async (kv: Kv, key: string, cache: Map<string, Promise<string | null>>, signal?: AbortSignal) => {
  if (signal?.aborted) throw signal.reason;
  if (!cache.has(key)) {
    const found = memory.get(key);
    if (found && found.expires > Date.now()) cache.set(key, Promise.resolve(found.value));
    else cache.set(key, limitedGet(kv, key, signal).then(value => { if (memory.size > 2000) memory.clear(); memory.set(key, { value, expires: Date.now() + 60000 }); return value; }));
  }
  return cache.get(key)!;
};

function isVendorRecord(value: unknown): value is VendorRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<VendorRecord>;
  return vendors.includes(record.vendorId as VendorId) && typeof record.name === 'string' && record.name.length > 0
    && typeof record.normalizedName === 'string' && typeof record.normalizedSku === 'string' && /^[A-Z0-9]+$/.test(record.normalizedSku)
    && typeof record.sku === 'string' && typeof record.url === 'string' && /^https:\/\//.test(record.url)
    && (record.priceUsd === null || (typeof record.priceUsd === 'number' && Number.isFinite(record.priceUsd) && record.priceUsd >= 0))
    && ['in', 'out', 'low', 'unknown'].includes(record.stock ?? '')
    && (record.packSize === null || (typeof record.packSize === 'number' && Number.isInteger(record.packSize) && record.packSize >= 1))
    && typeof record.packSizeVerified === 'boolean' && (record.stockQty === null || (typeof record.stockQty === 'number' && Number.isFinite(record.stockQty)))
    && typeof record.category === 'string' && typeof record.updatedAt === 'string' && ['feed', 'sitemap', 'scrape'].includes(record.source ?? '');
}

/** One vendor's published index, parsed once per isolate per generation size. */
type VendorIndex = { vendor: VendorId; gen: string; bySku: Map<string, number>; byToken: Map<string, number[]>; entries: IndexEntry[] };
const indexes = new Map<string, { value: VendorIndex; expires: number }>();
const tokensOf = (name: string) => [...new Set(normalizeName(name).split(' ').filter(token => token.length > 2))];
async function vendorIndex(kv: Kv, vendor: VendorId, cache: Map<string, Promise<string | null>>, signal?: AbortSignal): Promise<VendorIndex | null> {
  const rawPointer = await read(kv, pointerKey(vendor), cache, signal);
  let pointer: CatalogPointer | null = null;
  try { pointer = rawPointer ? JSON.parse(rawPointer) as CatalogPointer : null; } catch { /* No usable catalog. */ }
  if (!pointer?.gen) return null;
  const cacheKey = `${vendor}:${pointer.gen}:${pointer.records}:${pointer.batches ?? 'all'}`;
  const cached = indexes.get(cacheKey);
  if (cached && cached.expires > Date.now()) return cached.value;
  let entries: IndexEntry[] = [];
  try {
    const parsed: unknown = JSON.parse(await read(kv, indexKey(vendor, pointer.gen), cache, signal) ?? '[]');
    // Entries that are not [sku, name, batch] are dropped one by one rather than failing the scan.
    // Entries in batches the pointer has not published yet may not have reached this location, so they are ignored.
    const published = pointer.batches ?? Infinity;
    // A re-listed SKU stays readable from its previous batch until its newer batch is published.
    if (Array.isArray(parsed)) entries = parsed.flatMap((entry): IndexEntry[] => {
      if (!Array.isArray(entry) || typeof entry[0] !== 'string' || typeof entry[1] !== 'string' || !Number.isInteger(entry[2])) return [];
      if (entry[2] < published) return [[entry[0], entry[1], entry[2]]];
      return Number.isInteger(entry[3]) && entry[3] < published ? [[entry[0], entry[1], entry[3]]] : [];
    });
  } catch { /* A malformed index is a miss. */ }
  const value: VendorIndex = { vendor, gen: pointer.gen, bySku: new Map(), byToken: new Map(), entries };
  entries.forEach(([sku, name], position) => {
    value.bySku.set(sku, position);
    for (const token of tokensOf(name)) { const list = value.byToken.get(token); if (list) list.push(position); else value.byToken.set(token, [position]); }
  });
  if (indexes.size > 20) indexes.clear();
  indexes.set(cacheKey, { value, expires: Date.now() + 60000 });
  return value;
}

/**
 * Name candidates share a word with the part name and are ranked with the matcher's own score (including its
 * size/number penalty), so the shortlist cut cannot drop the record the matcher would have chosen.
 */
function nameCandidates(index: VendorIndex, name: string, limit = 12): number[] {
  const positions = new Set<number>();
  for (const token of tokensOf(name).slice(0, 6)) for (const position of index.byToken.get(token) ?? []) positions.add(position);
  return [...positions].map(position => [position, nameSimilarity(name, index.entries[position][1])] as const)
    .sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, limit).map(([position]) => position);
}

/**
 * Matches every line against the published vendor catalogs, applies the person's saved match decisions, and prices
 * the result. `result.catalogHealth` should already be set; it decides whether matched data counts as stale. Runs in
 * the Worker or in the browser: `reader.get` returns the raw catalog value for a key, from KV or over HTTP.
 */
/** What the matcher has done so far, for a progress display: catalogs read and their products, parts matched. */
export type MatchProgress = { catalogs: number; catalogsTotal: number; products: number; matched: number; lines: number };
export async function matchCatalog(result: ScanResult, kv: CatalogReader, getDecision: (key: string, signal?: AbortSignal) => Promise<MatchDecision | null> = async () => null, signal?: AbortSignal, staleHours = 336, onProgress?: (progress: MatchProgress) => void) {
  const progress: MatchProgress = { catalogs: 0, catalogsTotal: vendors.length, products: 0, matched: 0, lines: result.lines.length };
  const report = () => onProgress?.({ ...progress });
  report();
  const cache = new Map<string, Promise<string | null>>();
  const catalogs = (await Promise.all(vendors.map(vendor => vendorIndex(kv, vendor, cache, signal).then(index => {
    progress.catalogs++; progress.products += index?.entries.length ?? 0; report();
    return index;
  })))).filter((value): value is VendorIndex => Boolean(value));
  const batches = new Map<string, Promise<Map<string, VendorRecord>>>();
  const batch = (index: VendorIndex, number: number) => {
    const key = batchKey(index.vendor, index.gen, number);
    let found = batches.get(key);
    if (!found) {
      found = read(kv, key, cache, signal).then(raw => {
        const records = new Map<string, VendorRecord>();
        try { for (const value of JSON.parse(raw ?? '[]') as unknown[]) if (isVendorRecord(value)) records.set(value.normalizedSku, withKnownPack(value)); } catch { /* A malformed batch is a miss. */ }
        return records;
      });
      batches.set(key, found);
    }
    return found;
  };
  // Library mappings (a parts library's part → vendor SKU), one KV read per linked document; none exist until a library provides them.
  const mappings = new Map<string, Promise<LibraryMapping[]>>();
  const mappingsFor = (documentId: string) => {
    let found = mappings.get(documentId);
    if (!found) {
      found = read(kv, libraryMapKey(documentId), cache, signal).then(raw => { try { const value = JSON.parse(raw ?? '[]') as unknown; return Array.isArray(value) ? value as LibraryMapping[] : []; } catch { return []; } });
      mappings.set(documentId, found);
    }
    return found;
  };
  /** One SKU's record at a vendor, or null. */
  const recordAt = async (vendor: VendorId, sku: string) => {
    const index = catalogs.find(item => item.vendor === vendor);
    const position = index?.bySku.get(normalizeSku(sku, vendor));
    return index && position !== undefined ? (await batch(index, index.entries[position][2])).get(index.entries[position][0]) ?? null : null;
  };
  const jobs = result.lines.map(async line => {
    if (signal?.aborted) throw signal.reason;
    const wanted: Array<[VendorIndex, number]> = [];
    // An unresolved instance has no document, so there is no library to ask (and `library-map:` alone is not a key).
    const mapping = line.documentId && line.documentId !== result.documentId ? findLibraryMapping(await mappingsFor(line.documentId), line) : null;
    const skus = skuCandidates(line.name, line.partNumber);
    for (const index of catalogs) {
      for (const sku of skus) { const position = index.bySku.get(normalizeSku(sku, index.vendor)); if (position !== undefined) wanted.push([index, position]); }
      for (const position of nameCandidates(index, line.name)) wanted.push([index, position]);
    }
    const candidates = new Map<string, VendorRecord>();
    for (const [index, position] of wanted) {
      const [sku, , number] = index.entries[position];
      const record = (await batch(index, number)).get(sku);
      if (record) candidates.set(`${record.vendorId}:${record.normalizedSku}`, record);
    }
    // A library mapping names the vendor and the SKU together, so that exact product wins over any same number elsewhere.
    const mappedIndex = mapping ? catalogs.find(index => index.vendor === mapping.vendorId) : undefined;
    const mappedPosition = mappedIndex ? mappedIndex.bySku.get(normalizeSku(mapping!.sku, mapping!.vendorId)) : undefined;
    const mapped = mappedIndex && mappedPosition !== undefined ? (await batch(mappedIndex, mappedIndex.entries[mappedPosition][2])).get(mappedIndex.entries[mappedPosition][0]) ?? null : null;
    let match: MatchResult = mapped ? { vendor: mapped, confidence: 1, status: 'exact', reasons: [`SKU ${mapping!.sku} from ${mapping!.library} part mapping`] }
      : findBestMatch(line, [...candidates.values()]);
    // A parts library's vendor tag ("Servo Hub (GB)") names the vendor, so only that vendor's products are candidates,
    // ranked by how much of the part name and its configuration ("6000rpm Bare REX") each covers. Still a question:
    // the closest few are offered as choices.
    // Exact SKU choices already name the products, so they are kept as they are.
    const tag = !mapped && match.status !== 'exact' && !match.choices?.length ? vendorTag(line.name) : null;
    const tagged = tag ? catalogs.find(index => index.vendor === tag.vendor) : undefined;
    // Without that vendor's catalog the part stays unmatched rather than falling back to another vendor.
    if (tag && !tagged) match = { vendor: null, confidence: 0, status: 'unmatched', reasons: [`no published ${tag.vendor} catalog to match "${tag.name}"`] };
    if (tag && tagged) {
      // Sizes in the name ("8x14x5mm") outrank a configuration's own size field, which may be written another way.
      const namedSizes = spellSizes(tag.name) !== tag.name;
      const wanted = [tag.name, ...configurationValues(line.configuration).filter(value => !(namedSizes && /\d\s*[x×]\s*\d/i.test(value)))].join(' ');
      const positions = new Set<number>();
      for (const token of tokensOf(spellSizes(wanted).replace(/(\d)(rpm)\b/gi, '$1 $2'))) for (const position of tagged.byToken.get(token) ?? []) positions.add(position);
      const ranked = [...positions].filter(position => !boreConflict(tag.name, tagged.entries[position][1]))
        .map(position => [position, nameCoverage(wanted, tagged.entries[position][1])] as const)
        .filter(([, score]) => score >= 0.5).sort((a, b) => b[1] - a[1] || a[0] - b[0]);
      const close = ranked.filter(([, score]) => ranked[0][1] - score <= 0.25).slice(0, 4);
      const records = (await Promise.all(close.map(async ([position]) => (await batch(tagged, tagged.entries[position][2])).get(tagged.entries[position][0]) ?? null)))
        .filter((record): record is VendorRecord => Boolean(record));
      const named = `"(${line.name.match(/\(([^)]*)\)\s*$/)![1]})" in the name means ${tag.vendor}`;
      // One product left that carries every size and number the part names is that product: the tag fixes the vendor
      // and the numbers fix the item ("8x14x5mm Bearing - Round Bore (GB)" is goBILDA's 8mm x 14mm x 5mm round-bore bearing).
      match = records.length === 1 && /\d/.test(tag.name) && coversNumbers(tag.name, records[0].normalizedName)
        ? { vendor: records[0], confidence: 1, status: 'exact', reasons: [`${named}, and its only product with every size in the name is ${records[0].sku}`] }
        : records.length ? { vendor: records[0], confidence: 0.9, status: 'possible', choices: records, reasons: [`${named}; closest products by name and configuration, confirm which one`] }
        : { vendor: null, confidence: 0, status: 'unmatched', reasons: [`no ${tag.vendor} product matches "${tag.name}"`] };
    }
    // A part numbered with a SKU its vendor has discontinued is ordered as the product sold in its place.
    const next = !mapped && match.status !== 'exact' ? skus.map(successorOf).find(Boolean) : null;
    if (next) {
      const old = next.old;
      const records = (await Promise.all(next.skus.map(([vendor, sku]) => recordAt(vendor, sku)))).filter((record): record is VendorRecord => Boolean(record));
      if (records.length === 1 && next.skus.length === 1) match = { vendor: records[0], confidence: 1, status: 'exact', reasons: [`${old} is discontinued; ${next.product} is sold as ${records[0].sku}`] };
      else if (records.length) match = { vendor: records[0], confidence: 0.9, status: 'possible', choices: records, reasons: [`${old} is discontinued; ${next.product} is sold as ${records.map(record => record.sku).join(' or ')}; pick one`] };
    }
    // A part named exactly like a known FTC product ("Pinpoint", "Control Hub") is that product; with several SKUs, a person picks.
    const found = !mapped && match.status !== 'exact' ? knownProduct(tag ? tag.name : line.name) : null;
    // A vendor tag keeps only that vendor's SKUs: "Control Hub (GB)" is not REV's Control Hub.
    const known = found && tag ? { ...found, skus: found.skus.filter(([vendor]) => vendor === tag.vendor) } : found;
    const knownRecords = known ? (await Promise.all(known.skus.map(([vendor, sku]) => recordAt(vendor, sku)))).filter((record): record is VendorRecord => Boolean(record)) : [];
    // A name sold as several SKUs stays a question even when only one of them is readable right now.
    if (known && knownRecords.length === 1 && known.skus.length === 1) match = { vendor: knownRecords[0], confidence: 1, status: 'exact', reasons: [`named as the ${known.product}, SKU ${knownRecords[0].sku}`] };
    else if (known && knownRecords.length) match = { vendor: knownRecords[0], confidence: 0.9, status: 'possible', reasons: [`named as the ${known.product}, sold as ${knownRecords.map(record => record.sku).join(' or ')}; confirm which one`], choices: knownRecords };
    // A product whose own bodies name a different SKU of the same family (an imported motor named 5000-0002-0001 whose
    // bodies say 5000-0002-4008) is a question: the name may be a template's, the bodies the real product's.
    if (match.status === 'exact' && match.vendor && !mapped && line.purchasedAssembly?.inside?.length) {
      // A family is the number's first four digits at the same vendor (goBILDA 5000-0002-xxxx, REV-31-15xx).
      const family = (sku: string) => sku.toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^[A-Z]+/, '').slice(0, 4);
      const own = match.vendor;
      const innerSkus = [...new Set(line.purchasedAssembly.inside.flatMap(name => skuCandidates(name, null)))].filter(sku => family(sku) === family(own.sku));
      const inner = new Map<string, VendorRecord>();
      for (const record of await Promise.all(innerSkus.map(sku => recordAt(own.vendorId, sku)))) if (record && record.normalizedSku !== own.normalizedSku) inner.set(record.normalizedSku, record);
      if (inner.size) match = { vendor: own, confidence: 0.9, status: 'possible', reasons: [`${own.sku} in the name, but parts inside name ${[...inner.values()].map(record => record.sku).join(', ')}; confirm which product this is`], choices: [own, ...inner.values()] };
    }
    line.vendor = match.vendor;
    line.choices = match.choices ?? [];
    // The closest records not chosen, for the AI review and for a person to pick from.
    const shown = new Set([match.vendor, ...line.choices].flatMap(record => record ? [`${record.vendorId}:${record.normalizedSku}`] : []));
    line.nearMatches = match.status === 'exact' ? [] : [...candidates.values()].filter(record => !shown.has(`${record.vendorId}:${record.normalizedSku}`))
      .map(record => [record, nameSimilarity(line.name, record.normalizedName)] as const).filter(([, score]) => score >= 0.25)
      .sort((a, b) => b[1] - a[1] || a[0].sku.localeCompare(b[0].sku)).slice(0, 3).map(([record]) => record);
    line.matchConfidence = match.confidence;
    line.matchStatus = match.status;
    line.matchReasons = match.reasons;
    if (match.status === 'exact') { line.classification = 'commercial'; line.classificationReasons = ['exact vendor SKU forces Commercial']; }
    if (match.status !== 'exact' && (match.vendor || line.nearMatches.length)) {
      const choice = await getDecision(line.bomLineKey, signal);
      // A saved decision may name the shown match or any of the line's choices.
      const picked = decisionRecord(line, choice);
      if (choice && picked) {
        // The match it replaces stays a near match, so a later decision can name it again.
        const shownMatch = match.vendor;
        if (shownMatch && picked !== shownMatch && !line.nearMatches.some(record => record.vendorId === shownMatch.vendorId && record.normalizedSku === shownMatch.normalizedSku)) line.nearMatches = [shownMatch, ...line.nearMatches];
        line.vendor = picked;
        line.matchStatus = choice.status;
        if (choice.status === 'rejected') line.vendor = null;
      }
    }
    line.alternatives = rankVendorAlternatives(line.name, line.vendor, [...candidates.values()]);
    if (mapped) line.libraryMatch = { library: mapping!.library, attribution: mapping!.attribution };
    // Only licensed images ever reach a line: a library's own image first, then one from an official vendor feed.
    line.thumbnail = mapping?.image ?? line.vendor?.image ?? null;
  });
  await Promise.all(jobs.map(job => job.then(() => { progress.matched++; report(); })));
  // Price and stock are as of each matched record's fetch, so the oldest one dates the whole result.
  const fetched = result.lines.map(line => line.vendor?.updatedAt).filter((value): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value)));
  result.vendorDataUpdatedAt = fetched.length ? [...fetched].sort()[0] : null;
  const used = new Set(result.lines.map(line => line.vendor?.vendorId).filter((id): id is VendorId => Boolean(id)));
  result.stats.staleVendorData = fetched.some(value => Date.now() - Date.parse(value) > staleHours * 3600000)
    || (!result.catalogHealth && used.size > 0)
    || Boolean(result.catalogHealth?.vendors.some(vendor => used.has(vendor.vendorId) && (vendor.stale || vendor.lastRunFailed)));
  return recalculatePurchasing(result);
}
