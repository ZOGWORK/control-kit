import { matchCatalog, type CatalogHealth, type MatchDecision, type ScanResult, type VendorHealth } from '@control-kit/shared';
import type { Kv } from './index';
import { snapshotKey, type VendorSnapshot } from './vendor-ingest';

export { clearCatalogMemoryCache } from '@control-kit/shared';
const vendors = ['gobilda', 'servocity', 'andymark', 'rev', 'pitsco'] as const;
const read = async (kv: Kv, key: string, cache: Map<string, Promise<string | null>>, signal?: AbortSignal) => {
  if (signal?.aborted) throw signal.reason;
  if (!cache.has(key)) cache.set(key, kv.get(key));
  return cache.get(key)!;
};

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

/**
 * Catalog health plus the shared matcher, for callers that match in the Worker (tests, the export job's reclassify).
 * Scans no longer call this: matching a large assembly against every catalog exceeds the Worker's CPU limit, so the
 * browser runs `matchCatalog` on the scan result instead (see `/api/catalog/raw`).
 */
export async function enrichScan(result: ScanResult, kv: Kv, getDecision: (key: string, signal?: AbortSignal) => Promise<MatchDecision | null> = async () => null, signal?: AbortSignal, staleHours = 336) {
  try { result.catalogHealth = await catalogHealth(kv, staleHours, signal); }
  catch (error) {
    if (signal?.aborted) throw error;
    console.error('Catalog health read failed', error instanceof Error ? error.name : 'unknown');
  }
  return matchCatalog(result, kv, getDecision, signal, staleHours);
}
