import { type VendorId, type VendorRecord } from '@control-kit/shared';
import type { Kv } from './index';
import { batchKey, crawlKey, indexKey, manifestKey, pointerKey, snapshotKey, type CatalogPointer, type IndexEntry, type SkipReason, type VendorSnapshot } from './vendor-ingest';

export { manifestKey };
/** KV can take about 60 seconds to reach every location; a staged generation is published only after that. */
export const propagationMs = 65000;

/**
 * Staged catalogs: one path for any complete set of records, whether a one-time crawl or an official vendor feed.
 * Staging writes a new generation (batches, index, manifest) that no reader sees. Validation checks it against the
 * live catalog and expected SKUs. Publishing points readers at it and keeps the live generation as `previous` for
 * rollback, exactly as a finished cron crawl does.
 */
export type CatalogSource = 'crawl' | 'official-feed';
export type StagedCatalog = { vendor: VendorId; gen: string; source: CatalogSource; records: number; batches: number; stagedAt: string; skipped: Partial<Record<SkipReason, number>>; rejected: number; note: string | null };
const json = async <T>(kv: Kv, key: string): Promise<T | null> => { const raw = await kv.get(key); if (!raw) return null; try { return JSON.parse(raw) as T; } catch { return null; } };

export async function stageCatalog(vendor: VendorId, records: VendorRecord[], kv: Kv, options: { source: CatalogSource; gen?: string; batchSize?: number; skipped?: StagedCatalog['skipped']; rejected?: number; note?: string; now?: Date } ) {
  const gen = options.gen ?? crypto.randomUUID().slice(0, 8);
  // One record per SKU; a later row for the same SKU wins, as a later crawl batch would.
  const unique = [...new Map(records.filter(record => record.vendorId === vendor).map(record => [record.normalizedSku, { ...record, catalogVersion: gen }])).values()];
  if (!unique.length) throw new Error(`${vendor}: nothing to stage`);
  const size = Math.max(50, options.batchSize ?? 1000);
  const index: IndexEntry[] = [];
  let batches = 0;
  for (let start = 0; start < unique.length; start += size, batches++) {
    const batch = unique.slice(start, start + size);
    await kv.put(batchKey(vendor, gen, batches), JSON.stringify(batch));
    for (const record of batch) index.push([record.normalizedSku, record.normalizedName, batches]);
  }
  await kv.put(indexKey(vendor, gen), JSON.stringify(index));
  const manifest: StagedCatalog = { vendor, gen, source: options.source, records: unique.length, batches, stagedAt: (options.now ?? new Date()).toISOString(), skipped: options.skipped ?? {}, rejected: options.rejected ?? 0, note: options.note ?? null };
  await kv.put(manifestKey(vendor, gen), JSON.stringify(manifest));
  return manifest;
}

export type Validation = { ok: boolean; records: number; priced: number; verifiedPacks: number; liveRecords: number | null; missingSkus: string[]; problems: string[] };
/**
 * Gate before publishing. A staged catalog must read back whole, must not be much smaller than a complete live
 * catalog (a truncated feed would otherwise replace good data), and must contain every SKU the caller expects.
 */
export async function validateStaged(vendor: VendorId, kv: Kv, gen: string, checks: { minRecords?: number; expectSkus?: string[]; maxDrop?: number } = {}): Promise<Validation> {
  const problems: string[] = [];
  const manifest = await json<StagedCatalog>(kv, manifestKey(vendor, gen));
  if (!manifest) return { ok: false, records: 0, priced: 0, verifiedPacks: 0, liveRecords: null, missingSkus: [], problems: ['No staged manifest for this generation'] };
  const index = await json<IndexEntry[]>(kv, indexKey(vendor, gen)) ?? [];
  if (index.length !== manifest.records) problems.push(`Index has ${index.length} entries, manifest says ${manifest.records}`);
  let read = 0; let priced = 0; let verifiedPacks = 0;
  const skus = new Set<string>();
  for (let batch = 0; batch < manifest.batches; batch++) {
    const records = await json<VendorRecord[]>(kv, batchKey(vendor, gen, batch));
    if (!records) { problems.push(`Batch ${batch} is missing`); continue; }
    read += records.length;
    for (const record of records) { skus.add(record.normalizedSku); if (record.priceUsd !== null) priced++; if (record.packSizeVerified) verifiedPacks++; }
  }
  if (read !== manifest.records) problems.push(`Batches hold ${read} records, manifest says ${manifest.records}`);
  if (checks.minRecords && read < checks.minRecords) problems.push(`Only ${read} records; expected at least ${checks.minRecords}`);
  const live = await json<CatalogPointer>(kv, pointerKey(vendor));
  const maxDrop = checks.maxDrop ?? 0.2;
  if (live?.complete && live.gen !== gen && read < live.records * (1 - maxDrop)) problems.push(`${read} records is more than ${Math.round(maxDrop * 100)}% below the live catalog's ${live.records}`);
  const missingSkus = (checks.expectSkus ?? []).filter(sku => !skus.has(sku));
  if (missingSkus.length) problems.push(`Expected SKUs missing: ${missingSkus.join(', ')}`);
  return { ok: problems.length === 0, records: read, priced, verifiedPacks, liveRecords: live?.records ?? null, missingSkus, problems };
}

/** Points readers at a validated staged generation. The cron's unfinished crawl, if any, is dropped so it cannot replace it. */
export async function publishStaged(vendor: VendorId, kv: Kv, gen: string, options: { now?: Date; retireAfterMs?: number } = {}) {
  const manifest = await json<StagedCatalog>(kv, manifestKey(vendor, gen));
  if (!manifest) throw new Error(`${vendor}: generation ${gen} is not staged`);
  const live = await json<CatalogPointer>(kv, pointerKey(vendor));
  if (live?.gen === gen) return live;
  const now = (options.now ?? new Date()).toISOString();
  const age = Date.parse(now) - Date.parse(manifest.stagedAt);
  if (age < propagationMs) throw new Error(`${vendor}: staged ${Math.round(age / 1000)}s ago; publish after ${propagationMs / 1000}s so every KV location has the staged batches`);
  // Every generation that loses its place is queued for deletion: the live one as \`previous\`, an older previous and an
  // unfinished crawl in \`retiring\`. Nothing is dropped untracked.
  const crawl = await json<{ gen: string; batches: number }>(kv, crawlKey(vendor));
  const retiring = [...(live?.retiring ?? []), ...(live?.previous && live.previous.gen !== gen ? [live.previous] : []),
    ...(crawl && crawl.gen !== live?.gen && crawl.gen !== gen && crawl.gen !== live?.previous?.gen ? [{ gen: crawl.gen, batches: crawl.batches, deleteAfter: Date.parse(now), deleted: 0 }] : [])]
    .filter((entry, position, list) => entry.gen !== gen && entry.gen !== live?.gen && list.findIndex(other => other.gen === entry.gen) === position);
  const pointer: CatalogPointer = { gen, complete: true, records: manifest.records, batches: manifest.batches, publishedAt: now, completedAt: now, skipped: manifest.skipped, source: manifest.source,
    previous: live ? { gen: live.gen, batches: live.batches ?? 0, deleteAfter: Date.parse(now) + (options.retireAfterMs ?? 24 * 3600000), deleted: 0 } : null,
    ...(retiring.length ? { retiring } : {}) };
  await kv.delete(crawlKey(vendor));
  await kv.put(pointerKey(vendor), JSON.stringify(pointer));
  const snapshot: VendorSnapshot = { status: 'ok', updatedAt: now, lastRunAt: now, recordCount: manifest.records, source: manifest.source === 'official-feed' ? 'official-feed' : 'sitemap', version: gen, complete: true, skipped: manifest.skipped };
  await kv.put(snapshotKey(vendor), JSON.stringify(snapshot));
  return pointer;
}

export type SpotCheck = { sku: string; url: string; price: number | null; skuOnPage: boolean; priceOnPage: boolean };
/** Fetches a sample of product pages and checks that each record's SKU and price appear on the vendor's own page. */
export async function spotCheck(records: VendorRecord[], fetcher: (url: string) => Promise<Response>, count = 20, pauseMs = 600, pick = Math.random): Promise<SpotCheck[]> {
  const sample = [...records].map(record => [pick(), record] as const).sort((a, b) => a[0] - b[0]).slice(0, count).map(([, record]) => record);
  const results: SpotCheck[] = [];
  for (const record of sample) {
    const html = await fetcher(record.sourceUrl ?? record.url).then(response => response.ok ? response.text() : '').catch(() => '');
    const price = record.priceUsd === null ? null : record.priceUsd.toFixed(2);
    results.push({ sku: record.sku, url: record.url, price: record.priceUsd, skuOnPage: html.includes(record.sku), priceOnPage: price === null || html.includes(price) });
    if (pauseMs) await new Promise(resolve => setTimeout(resolve, pauseMs));
  }
  return results;
}
