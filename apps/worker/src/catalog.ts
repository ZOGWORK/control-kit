import { findBestMatch, normalizeName, normalizeSku, recalculatePurchasing, skuCandidates, type MatchDecision, type ScanResult, type VendorId, type VendorRecord } from '@control-kit/shared';
import type { Kv } from './index';
import type { VendorSnapshot } from './vendor-ingest';

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

export function clearCatalogMemoryCache() { memory.clear(); }

function isVendorRecord(value: unknown): value is VendorRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<VendorRecord>;
  return vendors.includes(record.vendorId as VendorId) && typeof record.name === 'string' && record.name.length > 0
    && typeof record.normalizedName === 'string' && typeof record.normalizedSku === 'string' && record.normalizedSku.length > 0
    && typeof record.sku === 'string' && typeof record.url === 'string' && /^https:\/\//.test(record.url)
    && (record.priceUsd === null || (typeof record.priceUsd === 'number' && Number.isFinite(record.priceUsd) && record.priceUsd >= 0))
    && ['in', 'out', 'low', 'unknown'].includes(record.stock ?? '')
    && (record.packSize === null || (typeof record.packSize === 'number' && Number.isInteger(record.packSize) && record.packSize >= 1))
    && typeof record.packSizeVerified === 'boolean' && (record.stockQty === null || (typeof record.stockQty === 'number' && Number.isFinite(record.stockQty)))
    && typeof record.category === 'string' && typeof record.updatedAt === 'string' && ['feed', 'sitemap', 'scrape'].includes(record.source ?? '');
}

export async function enrichScan(result: ScanResult, kv: Kv, getDecision: (key: string, signal?: AbortSignal) => Promise<MatchDecision | null> = async () => null, signal?: AbortSignal, staleHours = 24) {
  const cache = new Map<string, Promise<string | null>>();
  const versions = new Map(await Promise.all(vendors.map(async vendor => [vendor, await read(kv, `vendor:${vendor}:__lastgood__`, cache, signal)] as const)));
  const recordKey = (vendor: VendorId, sku: string) => versions.get(vendor) ? `vendor-version:${vendor}:${versions.get(vendor)}:${sku}` : `vendor:${vendor}:${sku}`;
  const jobs = result.lines.map(async line => {
    if (signal?.aborted) throw signal.reason;
    const keys: string[] = [];
    for (const sku of skuCandidates(line.name, line.partNumber)) for (const vendor of vendors) keys.push(recordKey(vendor, normalizeSku(sku, vendor)));
    const tokens = [...new Set(normalizeName(line.name).split(' ').filter(token => token.length > 2))].slice(0, 4);
    for (const token of tokens) {
      for (const vendor of vendors) {
        const indexKey = versions.get(vendor) ? `vendor-index-version:${vendor}:${versions.get(vendor)}:${token}` : `vendor-index:${token}`;
        const value = await read(kv, indexKey, cache, signal);
        if (value) {
          try { for (const id of JSON.parse(value) as string[]) {
            const [candidateVendor, sku] = id.split(':');
            if (candidateVendor === vendor && /^[A-Z0-9]+$/.test(sku)) keys.push(recordKey(vendor, sku));
          } } catch { /* A malformed index is a cache miss, not a failed scan. */ }
        }
      }
    }
    const uniqueKeys = [...new Set(keys)];
    const candidates: VendorRecord[] = [];
    for (let offset = 0; offset < uniqueKeys.length; offset += 20) {
      if (signal?.aborted) throw signal.reason;
      const raw = await Promise.all(uniqueKeys.slice(offset, offset + 20).map(key => read(kv, key, cache, signal)));
      for (const value of raw) if (value) { try { const parsed: unknown = JSON.parse(value); if (isVendorRecord(parsed)) candidates.push(parsed); } catch { /* Ignore malformed catalog records. */ } }
    }
    const match = findBestMatch(line, candidates);
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
  });
  // KV is not a network scrape, but keep in-flight gets bounded at 20 per batch and results deterministic.
  await Promise.all(jobs);
  const used = [...new Set(result.lines.map(line => line.vendor?.vendorId).filter((id): id is VendorId => Boolean(id)))];
  const snapshots = await Promise.all(used.map(async vendor => {
    const value = await read(kv, `vendor:${vendor}:__snapshot__`, cache, signal);
    if (!value) return null;
    try { return JSON.parse(value) as VendorSnapshot; } catch { return null; }
  }));
  const timestamps = used.map((vendor, index) => snapshots[index]?.updatedAt ?? result.lines.find(line => line.vendor?.vendorId === vendor)?.vendor?.updatedAt ?? null).filter((value): value is string => Boolean(value));
  result.vendorDataUpdatedAt = timestamps.length ? timestamps.sort()[0] : null;
  result.stats.staleVendorData = used.some((vendor, index) => {
    const snapshot = snapshots[index];
    const updatedAt = snapshot?.updatedAt ?? result.lines.find(line => line.vendor?.vendorId === vendor)?.vendor?.updatedAt;
    return snapshot?.status === 'failed' || !updatedAt || !Number.isFinite(Date.parse(updatedAt)) || Date.now() - Date.parse(updatedAt) > staleHours * 3600000;
  });
  return recalculatePurchasing(result);
}
