import { findBestMatch, normalizeName, normalizeSku, recalculatePurchasing, skuCandidates, type ScanResult, type VendorId, type VendorRecord } from '@control-kit/shared';
import type { Kv } from './index';

const vendors: VendorId[] = ['gobilda', 'servocity', 'andymark', 'rev', 'pitsco'];
const memory = new Map<string, { value: string | null; expires: number }>();
let activeGets = 0;
const waiters: Array<() => void> = [];
async function limitedGet(kv: Kv, key: string) {
  if (activeGets >= 20) await new Promise<void>(resolve => waiters.push(resolve));
  activeGets++;
  try { return await kv.get(key); }
  finally { activeGets--; waiters.shift()?.(); }
}
const read = async (kv: Kv, key: string, cache: Map<string, Promise<string | null>>) => {
  if (!cache.has(key)) {
    const found = memory.get(key);
    if (found && found.expires > Date.now()) cache.set(key, Promise.resolve(found.value));
    else cache.set(key, limitedGet(kv, key).then(value => { if (memory.size > 2000) memory.clear(); memory.set(key, { value, expires: Date.now() + 60000 }); return value; }));
  }
  return cache.get(key)!;
};

export function clearCatalogMemoryCache() { memory.clear(); }

export async function enrichScan(result: ScanResult, kv: Kv, decisions: Record<string, 'confirmed' | 'rejected'> = {}) {
  const cache = new Map<string, Promise<string | null>>();
  const jobs = result.lines.map(async line => {
    if (decisions[line.bomLineKey] === 'rejected') { line.matchStatus = 'rejected'; return; }
    const keys: string[] = [];
    for (const sku of skuCandidates(line.name, line.partNumber)) for (const vendor of vendors) keys.push(`vendor:${vendor}:${normalizeSku(sku, vendor)}`);
    const tokens = [...new Set(normalizeName(line.name).split(' ').filter(token => token.length > 2))].slice(0, 4);
    for (const token of tokens) {
      const value = await read(kv, `vendor-index:${token}`, cache);
      if (value) {
        try { for (const id of JSON.parse(value) as string[]) if (/^(gobilda|servocity|andymark|rev|pitsco):[A-Z0-9]+$/.test(id)) keys.push(`vendor:${id}`); }
        catch { /* A malformed index is a cache miss, not a failed scan. */ }
      }
    }
    const uniqueKeys = [...new Set(keys)];
    const candidates: VendorRecord[] = [];
    for (let offset = 0; offset < uniqueKeys.length; offset += 20) {
      const raw = await Promise.all(uniqueKeys.slice(offset, offset + 20).map(key => read(kv, key, cache)));
      for (const value of raw) if (value) { try { candidates.push(JSON.parse(value) as VendorRecord); } catch { /* Ignore malformed catalog records. */ } }
    }
    const match = findBestMatch(line, candidates);
    line.vendor = match.vendor;
    line.matchConfidence = match.confidence;
    line.matchStatus = match.status;
    line.matchReasons = match.reasons;
    if (match.status === 'exact') { line.classification = 'commercial'; line.classificationReasons = ['exact vendor SKU forces Commercial']; }
    if (match.status === 'possible' && decisions[line.bomLineKey] === 'confirmed') line.matchStatus = 'confirmed';
  });
  // KV is not a network scrape, but keep in-flight gets bounded at 20 per batch and results deterministic.
  await Promise.all(jobs);
  return recalculatePurchasing(result);
}
