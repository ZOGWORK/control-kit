import { findBestMatch, nameSimilarity, normalizeName, normalizeSku, rankVendorAlternatives, recalculatePurchasing, skuCandidates, type CatalogHealth, type MatchDecision, type ScanResult, type VendorHealth, type VendorId, type VendorRecord } from '@control-kit/shared';
import type { Kv } from './index';
import { batchKey, indexKey, pointerKey, snapshotKey, type CatalogPointer, type IndexEntry, type VendorSnapshot } from './vendor-ingest';

const vendors: VendorId[] = ['gobilda', 'servocity', 'andymark', 'rev', 'pitsco'];
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

export function clearCatalogMemoryCache() { memory.clear(); indexes.clear(); }

/** Reads only the five snapshot keys; never crawl state, indexes, or records. */
export async function catalogHealth(kv: Kv, staleHours = 336, signal?: AbortSignal, cache = new Map<string, Promise<string | null>>()): Promise<CatalogHealth> {
  const health = await Promise.all(vendors.map(async (vendorId): Promise<VendorHealth> => {
    const raw = await read(kv, snapshotKey(vendorId), cache, signal);
    let snapshot: VendorSnapshot | null = null;
    try { snapshot = raw ? JSON.parse(raw) as VendorSnapshot : null; } catch { /* Treated as never run. */ }
    const published = Boolean(snapshot?.version);
    const lastRunFailed = snapshot?.status === 'failed';
    const updated = snapshot?.updatedAt ? Date.parse(snapshot.updatedAt) : NaN;
    const state = published ? 'published' : lastRunFailed ? 'failing' : snapshot ? 'building' : 'never-run';
    return { vendorId, state, complete: published && snapshot?.complete === true, recordCount: published ? snapshot?.recordCount ?? 0 : 0, updatedAt: published ? snapshot?.updatedAt ?? null : null, lastRunAt: snapshot?.lastRunAt ?? null,
      stale: published && (!Number.isFinite(updated) || Date.now() - updated > staleHours * 3600000), lastRunFailed, error: lastRunFailed ? snapshot?.error ?? 'Unknown ingestion error' : null,
      skipped: snapshot?.skipped ?? {},
      progress: snapshot?.progress ? { sitemapsDone: snapshot.progress.sitemapsDone, sitemapsTotal: snapshot.progress.sitemapsTotal, pagesDoneInSitemap: snapshot.progress.pagesDoneInSitemap, pagesInSitemap: snapshot.progress.pagesInSitemap, recordsCollected: snapshot.progress.recordsCollected } : null };
  }));
  return { checkedAt: new Date().toISOString(), vendors: health };
}

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
    if (Array.isArray(parsed)) entries = parsed.filter((entry): entry is IndexEntry => Array.isArray(entry) && typeof entry[0] === 'string' && typeof entry[1] === 'string' && Number.isInteger(entry[2]) && entry[2] < published);
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

export async function enrichScan(result: ScanResult, kv: Kv, getDecision: (key: string, signal?: AbortSignal) => Promise<MatchDecision | null> = async () => null, signal?: AbortSignal, staleHours = 336) {
  const cache = new Map<string, Promise<string | null>>();
  const catalogs = (await Promise.all(vendors.map(vendor => vendorIndex(kv, vendor, cache, signal)))).filter((value): value is VendorIndex => Boolean(value));
  const batches = new Map<string, Promise<Map<string, VendorRecord>>>();
  const batch = (index: VendorIndex, number: number) => {
    const key = batchKey(index.vendor, index.gen, number);
    let found = batches.get(key);
    if (!found) {
      found = read(kv, key, cache, signal).then(raw => {
        const records = new Map<string, VendorRecord>();
        try { for (const value of JSON.parse(raw ?? '[]') as unknown[]) if (isVendorRecord(value)) records.set(value.normalizedSku, value); } catch { /* A malformed batch is a miss. */ }
        return records;
      });
      batches.set(key, found);
    }
    return found;
  };
  const jobs = result.lines.map(async line => {
    if (signal?.aborted) throw signal.reason;
    const wanted: Array<[VendorIndex, number]> = [];
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
    const match = findBestMatch(line, [...candidates.values()]);
    line.vendor = match.vendor;
    line.matchConfidence = match.confidence;
    line.matchStatus = match.status;
    line.matchReasons = match.reasons;
    if (match.status === 'exact') { line.classification = 'commercial'; line.classificationReasons = ['exact vendor SKU forces Commercial']; }
    if (match.vendor && match.status !== 'exact') {
      const choice = await getDecision(line.bomLineKey, signal);
      if (choice?.vendorId === match.vendor.vendorId && choice.normalizedSku === match.vendor.normalizedSku) {
        line.matchStatus = choice.status;
        if (choice.status === 'rejected') line.vendor = null;
      }
    }
    line.alternatives = rankVendorAlternatives(line.name, line.vendor, [...candidates.values()]);
  });
  await Promise.all(jobs);
  // Health is diagnostic: a failed read leaves it absent rather than failing a scan whose BOM is complete.
  try { result.catalogHealth = await catalogHealth(kv, staleHours, signal, cache); }
  catch (error) {
    if (signal?.aborted) throw error;
    console.error('Catalog health read failed', error instanceof Error ? error.name : 'unknown');
  }
  // Price and stock are as of each matched record's fetch, so the oldest one dates the whole result.
  const fetched = result.lines.map(line => line.vendor?.updatedAt).filter((value): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value)));
  result.vendorDataUpdatedAt = fetched.length ? [...fetched].sort()[0] : null;
  const used = new Set(result.lines.map(line => line.vendor?.vendorId).filter((id): id is VendorId => Boolean(id)));
  result.stats.staleVendorData = fetched.some(value => Date.now() - Date.parse(value) > staleHours * 3600000)
    || (!result.catalogHealth && used.size > 0)
    || Boolean(result.catalogHealth?.vendors.some(vendor => used.has(vendor.vendorId) && (vendor.stale || vendor.lastRunFailed)));
  return recalculatePurchasing(result);
}
