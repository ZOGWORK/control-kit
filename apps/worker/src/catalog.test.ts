import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { aggregateAssembly, applyMatchDecision, normalizeName, type AssemblyDefinition, type VendorRecord } from '@control-kit/shared';
import { clearCatalogMemoryCache, enrichScan } from './catalog';
import { batchKey, indexKey, pointerKey } from './vendor-ingest';
import type { Kv } from './index';

class MemoryKv implements Kv {
  values = new Map<string, string>();
  async get(k: string) { return this.values.get(k) ?? null; }
  async put(k: string, v: string) { this.values.set(k, v); }
  async delete(k: string) { this.values.delete(k); }
}
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`../../../fixtures/assembly-${name}.json`, import.meta.url), 'utf8')) as AssemblyDefinition;
const records = JSON.parse(readFileSync(new URL('../../../fixtures/vendors/seed.json', import.meta.url), 'utf8')) as VendorRecord[];
const context = { documentId: 'doc1', workspaceOrVersion: 'w' as const, workspaceOrVersionId: 'work1', elementId: 'elem1' };
/** Publishes records in the same pointer/index/batch layout the crawler writes. */
function catalog(list: VendorRecord[] = records) {
  const kv = new MemoryKv();
  for (const vendor of new Set(list.map(record => record.vendorId))) {
    const own = list.filter(record => record.vendorId === vendor);
    kv.values.set(pointerKey(vendor), JSON.stringify({ gen: 'g1', complete: true, records: own.length, publishedAt: new Date().toISOString(), completedAt: new Date().toISOString(), previous: null }));
    kv.values.set(batchKey(vendor, 'g1', 0), JSON.stringify(own));
    kv.values.set(indexKey(vendor, 'g1'), JSON.stringify(own.map(record => [record.normalizedSku, record.normalizedName, 0])));
  }
  return kv;
}

describe('catalog KV read path and purchasing', () => {
  it('uses exact SKU and verified pack quantities for purchasing totals', async () => {
    clearCatalogMemoryCache();
    const result = aggregateAssembly(fixture('ftc-robot'), context, 'Robot');
    await enrichScan(result, catalog());
    const motor = result.lines.find(line => line.partId === 'motor-5203')!;
    expect(motor.matchStatus).toBe('exact');
    expect(motor.classification).toBe('commercial');
    expect(motor.packsToOrder).toBe(20);
    expect(motor.lineTotalUsd).toBe(699.8);
    // The CAD screw has no part number; its identical name only nominates the M3 screw, so it stays unpriced.
    const screw = result.lines.find(line => line.partId === 'screw-m3')!;
    expect(screw.qty).toBe(200);
    expect(screw.matchStatus).toBe('possible');
    expect(screw.packsToOrder).toBeNull();
    expect(screw.lineTotalUsd).toBeNull();
    const wheel = result.lines.find(line => line.partId === 'wheel-96')!;
    expect(wheel.matchStatus).toBe('possible');
    expect(wheel.lineTotalUsd).toBeNull();
    expect(result.stats.totalCostUsd).toBe(699.8);
  });
  it('keeps the right size on the name shortlist when many other sizes share its words', async () => {
    clearCatalogMemoryCache();
    const record = (sku: string, name: string): VendorRecord => ({ vendorId: 'gobilda', sku, normalizedSku: sku, name, normalizedName: normalizeName(name), url: 'https://www.gobilda.com/x/', priceUsd: 1, packSize: null, packSizeVerified: false, stock: 'in', stockQty: null, category: 'hardware', updatedAt: new Date().toISOString(), source: 'sitemap' });
    const decoys = ['M4', 'M5', 'M6', 'M8', 'M2', 'M2.5', 'M10', 'M12', 'M1.6', 'M14', 'M16', 'M20'].map((size, n) => record(`D${n}`, `${size} Socket Head Screw`));
    const result = aggregateAssembly(fixture('empty'), context, 'Robot');
    result.lines = [{ ...aggregateAssembly(fixture('simple'), context, 'Robot').lines[0], name: 'M3 Socket Head Screw', partNumber: null, bomLineKey: 'm3' }];
    await enrichScan(result, catalog([...decoys, record('RIGHT', 'M3 Socket Head Cap Screw')]));
    expect(result.lines[0].vendor?.sku).toBe('RIGHT');
  });
  it('keeps a re-listed SKU readable from its published batch until the newer batch is published', async () => {
    clearCatalogMemoryCache();
    const old = { ...records.find(item => item.vendorId === 'rev')!, updatedAt: new Date().toISOString() };
    const kv = catalog([old]);
    kv.values.set(batchKey('rev', 'g1', 1), JSON.stringify([{ ...old, priceUsd: 99 }]));
    kv.values.set(indexKey('rev', 'g1'), JSON.stringify([[old.normalizedSku, old.normalizedName, 1, 0]]));
    kv.values.set(pointerKey('rev'), JSON.stringify({ ...JSON.parse(kv.values.get(pointerKey('rev'))!), batches: 1 }));
    const scan = async () => {
      clearCatalogMemoryCache();
      const result = aggregateAssembly(fixture('empty'), context, 'Robot');
      result.lines = [{ ...aggregateAssembly(fixture('simple'), context, 'Robot').lines[0], partNumber: old.sku, bomLineKey: 'relisted' }];
      await enrichScan(result, kv);
      return result.lines[0];
    };
    expect(await scan()).toMatchObject({ matchStatus: 'exact', vendor: { priceUsd: old.priceUsd } });
    kv.values.set(pointerKey('rev'), JSON.stringify({ ...JSON.parse(kv.values.get(pointerKey('rev'))!), batches: 2 }));
    expect(await scan()).toMatchObject({ matchStatus: 'exact', vendor: { priceUsd: 99 } });
  });
  it('ignores index entries for batches the pointer has not published yet', async () => {
    clearCatalogMemoryCache();
    const seen = { ...records.find(item => item.vendorId === 'rev')!, updatedAt: new Date().toISOString() };
    const kv = catalog([seen]);
    kv.values.set(pointerKey('rev'), JSON.stringify({ ...JSON.parse(kv.values.get(pointerKey('rev'))!), batches: 0 }));
    const result = aggregateAssembly(fixture('empty'), context, 'Robot');
    result.lines = [{ ...aggregateAssembly(fixture('simple'), context, 'Robot').lines[0], partNumber: seen.sku, bomLineKey: 'unpublished' }];
    await enrichScan(result, kv);
    expect(result.lines[0].matchStatus).toBe('unmatched');
  });
  it('prices a name candidate only after a person confirms it', async () => {
    clearCatalogMemoryCache();
    const result = aggregateAssembly(fixture('ftc-robot'), context, 'Robot');
    await enrichScan(result, catalog(), async () => ({ status: 'confirmed', vendorId: 'andymark', normalizedSku: '1000' }));
    const screw = result.lines.find(line => line.partId === 'screw-m3')!;
    expect(screw).toMatchObject({ matchStatus: 'confirmed', packsToOrder: 20, lineTotalUsd: 179.8 });
    expect(result.stats.totalCostUsd).toBe(879.6);
  });
  it('keeps totals blank for unverified pack sizes and unconfirmed possible matches', async () => {
    clearCatalogMemoryCache();
    const result = aggregateAssembly(fixture('simple'), context, 'Robot');
    await enrichScan(result, catalog());
    const print = result.lines.find(line => line.partId === 'sensor-mount')!;
    expect(print.vendor?.packSizeVerified).toBe(false);
    expect(print.packsToOrder).toBeNull();
    expect(print.lineTotalUsd).toBeNull();
    const bearing = result.lines.find(line => line.partId === 'bearing-8')!;
    expect(bearing.matchStatus).toBe('possible');
    expect(bearing.lineTotalUsd).toBeNull();
    const confirmed = applyMatchDecision(result, bearing.bomLineKey, 'confirmed');
    expect(confirmed.lines.find(line => line.partId === 'bearing-8')?.matchStatus).toBe('confirmed');
    expect(confirmed.lines.find(line => line.partId === 'bearing-8')?.lineTotalUsd).toBeNull();
  });
  it('forces Commercial for exact SKU even with a strongly print-like name', async () => {
    clearCatalogMemoryCache();
    const result = aggregateAssembly(fixture('empty'), context, 'Robot');
    result.lines.push({ ...aggregateAssembly(fixture('simple'), context, 'Robot').lines[0], bomLineKey: 'exact-print', name: 'Custom 3D Printed Bracket', partNumber: 'REV-31-1234', qty: 12 });
    await enrichScan(result, catalog());
    expect(result.lines[0].matchStatus).toBe('exact');
    expect(result.lines[0].classification).toBe('commercial');
    expect(result.lines[0].packsToOrder).toBe(6);
    expect(result.lines[0].lineTotalUsd).toBe(75);
  });
  it('keeps a saved choice bound to the same catalog product', async () => {
    clearCatalogMemoryCache();
    const result = aggregateAssembly(fixture('simple'), context, 'Robot');
    const store = catalog();
    await enrichScan(result, store);
    const line = result.lines.find(item => item.partId === 'bearing-8')!;
    expect(line.matchStatus).toBe('possible');
    const saved = { status: 'confirmed' as const, vendorId: line.vendor!.vendorId, normalizedSku: line.vendor!.normalizedSku };
    const same = aggregateAssembly(fixture('simple'), context, 'Robot');
    await enrichScan(same, store, async () => saved);
    expect(same.lines.find(item => item.partId === 'bearing-8')?.matchStatus).toBe('confirmed');
    const changed = aggregateAssembly(fixture('simple'), context, 'Robot');
    await enrichScan(changed, store, async () => ({ ...saved, normalizedSku: 'DIFFERENT' }));
    expect(changed.lines.find(item => item.partId === 'bearing-8')?.matchStatus).toBe('possible');
  });
  it('keeps a rejected product rejected when its name becomes an automatic match', async () => {
    clearCatalogMemoryCache();
    const store = catalog();
    const first = aggregateAssembly(fixture('simple'), context, 'Robot');
    await enrichScan(first, store);
    const bearing = first.lines.find(item => item.partId === 'bearing-8')!;
    const identity = { vendorId: bearing.vendor!.vendorId, normalizedSku: bearing.vendor!.normalizedSku };
    const batch = batchKey(identity.vendorId, 'g1', 0);
    const own = (JSON.parse(store.values.get(batch)!) as VendorRecord[]).map(record => record.normalizedSku === identity.normalizedSku ? { ...record, name: bearing.name, normalizedName: 'bearing' } : record);
    store.values.set(batch, JSON.stringify(own));
    store.values.set(indexKey(identity.vendorId, 'g1'), JSON.stringify(own.map(record => [record.normalizedSku, record.normalizedName, 0])));
    clearCatalogMemoryCache();
    const next = aggregateAssembly(fixture('simple'), context, 'Robot');
    await enrichScan(next, store, async () => ({ status: 'rejected', ...identity }));
    expect(next.lines.find(item => item.partId === 'bearing-8')?.matchStatus).toBe('rejected');
    expect(next.lines.find(item => item.partId === 'bearing-8')?.vendor).toBeNull();
  });
  it('ignores an incomplete JSON catalog record without failing the scan', async () => {
    clearCatalogMemoryCache();
    const store = catalog([{ vendorId: 'rev', name: 'Incomplete', normalizedSku: '311234' } as VendorRecord]);
    const result = aggregateAssembly(fixture('empty'), context, 'Robot');
    result.lines.push({ ...aggregateAssembly(fixture('simple'), context, 'Robot').lines[0], bomLineKey: 'bad-record', partNumber: 'REV-31-1234' });
    await expect(enrichScan(result, store)).resolves.toBe(result);
    expect(result.lines[0].matchStatus).toBe('unmatched');
  });
  it('stops catalog reads after cancellation', async () => {
    clearCatalogMemoryCache();
    const controller = new AbortController();
    let reads = 0;
    const store = new MemoryKv();
    store.get = async () => { reads++; controller.abort(); return null; };
    const result = aggregateAssembly(fixture('simple'), context, 'Robot');
    await expect(enrichScan(result, store, async () => null, controller.signal)).rejects.toBeDefined();
    expect(reads).toBe(1);
  });
  it('keeps missing-metadata references aligned with an optimistic choice', async () => {
    clearCatalogMemoryCache();
    const result = aggregateAssembly(fixture('simple'), context, 'Robot');
    await enrichScan(result, catalog());
    const line = result.lines.find(item => item.partId === 'bearing-8')!;
    line.missingMetadataReason = 'Metadata unavailable';
    result.missingMetadata = [line];
    const changed = applyMatchDecision(result, line.bomLineKey, 'confirmed');
    expect(changed.missingMetadata[0]).toBe(changed.lines.find(item => item.bomLineKey === line.bomLineKey));
    expect(changed.missingMetadata[0].matchStatus).toBe('confirmed');
  });
  it('reads only the live generation and flags failed refreshes or old prices', async () => {
    clearCatalogMemoryCache();
    const now = new Date().toISOString();
    const record = { ...records.find(item => item.vendorId === 'rev')!, updatedAt: now };
    const kv = catalog([record]);
    // A refresh being built beside the live generation must not leak into scans.
    kv.values.set(batchKey('rev', 'g2', 0), JSON.stringify([{ ...record, priceUsd: 9999 }]));
    kv.values.set(indexKey('rev', 'g2'), JSON.stringify([[record.normalizedSku, record.normalizedName, 0]]));
    const line = { ...aggregateAssembly(fixture('simple'), context, 'Robot').lines[0], partNumber: record.sku, bomLineKey: 'published' };
    const makeResult = () => { const result = aggregateAssembly(fixture('empty'), context, 'Robot'); result.lines = [{ ...line }]; return result; };
    kv.values.set('vendor:rev:__snapshot__', JSON.stringify({ status: 'ok', updatedAt: now, lastRunAt: now, recordCount: 1, version: 'g1', complete: true }));
    const fresh = makeResult();
    await enrichScan(fresh, kv);
    expect(fresh.lines[0].vendor?.priceUsd).toBe(record.priceUsd);
    expect(fresh.stats.staleVendorData).toBe(false);
    expect(fresh.vendorDataUpdatedAt).toBe(now);
    kv.values.set('vendor:rev:__snapshot__', JSON.stringify({ status: 'failed', updatedAt: now, lastRunAt: now, recordCount: 1, version: 'g1', complete: true, error: 'Vendor returned HTTP 503' }));
    clearCatalogMemoryCache();
    const failed = makeResult();
    await enrichScan(failed, kv);
    expect(failed.stats.staleVendorData).toBe(true);
    kv.values.set('vendor:rev:__snapshot__', JSON.stringify({ status: 'ok', updatedAt: now, lastRunAt: now, recordCount: 1, version: 'g1', complete: true }));
    kv.values.set(batchKey('rev', 'g1', 0), JSON.stringify([{ ...record, updatedAt: '2020-01-01T00:00:00Z' }]));
    clearCatalogMemoryCache();
    const old = makeResult();
    await enrichScan(old, kv);
    expect(old.stats.staleVendorData).toBe(true);
    expect(old.vendorDataUpdatedAt).toBe('2020-01-01T00:00:00Z');
  });
});

describe('catalog health', () => {
  it('reports every vendor, including unpublished catalogs that no scan line matched', async () => {
    clearCatalogMemoryCache();
    const kv = new MemoryKv();
    const now = new Date().toISOString();
    kv.values.set('vendor:rev:__snapshot__', JSON.stringify({ status: 'ok', updatedAt: now, lastRunAt: now, recordCount: 390, source: 'sitemap', version: 'v1', complete: true }));
    kv.values.set('vendor:servocity:__snapshot__', JSON.stringify({ status: 'ok', updatedAt: now, lastRunAt: now, recordCount: 120, source: 'sitemap', version: 'v1', complete: false, inProgress: true, skipped: { 'redirect-stub': 3 } }));
    kv.values.set('vendor:gobilda:__snapshot__', JSON.stringify({ status: 'failed', updatedAt: null, lastRunAt: now, recordCount: 0, source: 'sitemap', version: null, error: 'Product page contained no usable Product JSON-LD',
      progress: { phase: 'fetch', sitemapsDone: 0, sitemapsTotal: 1, pagesDoneInSitemap: 7, pagesInSitemap: 2387, recordsCollected: 7 } }));
    kv.values.set('vendor:andymark:__snapshot__', JSON.stringify({ status: 'ok', updatedAt: null, lastRunAt: now, recordCount: 0, source: 'sitemap', version: null, inProgress: true }));
    const result = await enrichScan(aggregateAssembly(fixture('empty'), context, 'Empty'), kv);
    const byVendor = Object.fromEntries(result.catalogHealth!.vendors.map(vendor => [vendor.vendorId, vendor]));
    expect(Object.keys(byVendor)).toEqual(['gobilda', 'servocity', 'andymark', 'rev', 'pitsco']);
    expect(byVendor.rev).toMatchObject({ state: 'published', complete: true, recordCount: 390, stale: false, lastRunFailed: false });
    expect(byVendor.servocity).toMatchObject({ state: 'published', complete: false, recordCount: 120, skipped: { 'redirect-stub': 3 } });
    expect(byVendor.gobilda).toMatchObject({ state: 'failing', recordCount: 0, error: 'Product page contained no usable Product JSON-LD', progress: { pagesDoneInSitemap: 7, pagesInSitemap: 2387 } });
    expect(byVendor.andymark.state).toBe('building');
    expect(byVendor.pitsco.state).toBe('never-run');
  });
  it('completes the scan without health when a snapshot read fails', async () => {
    clearCatalogMemoryCache();
    const kv = catalog();
    const failing = Object.assign(Object.create(kv) as MemoryKv, { get: async (key: string) => { if (key.endsWith('__snapshot__')) throw new Error('KV unavailable'); return kv.get(key); } });
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const result = await enrichScan(aggregateAssembly(fixture('simple'), context, 'Simple'), failing);
      expect(result.catalogHealth).toBeUndefined();
      expect(result.lines.length).toBeGreaterThan(0);
      expect(log).toHaveBeenCalledWith('Catalog health read failed', 'Error');
    } finally { log.mockRestore(); }
  });
  it('marks an old published catalog stale and keeps it usable after a failed refresh', async () => {
    clearCatalogMemoryCache();
    const kv = new MemoryKv();
    kv.values.set('vendor:pitsco:__snapshot__', JSON.stringify({ status: 'failed', updatedAt: '2026-01-01T00:00:00.000Z', lastRunAt: new Date().toISOString(), recordCount: 12, source: 'sitemap', version: 'v1', error: 'Vendor returned HTTP 503' }));
    const result = await enrichScan(aggregateAssembly(fixture('empty'), context, 'Empty'), kv);
    expect(result.catalogHealth!.vendors.find(vendor => vendor.vendorId === 'pitsco')).toMatchObject({ state: 'published', stale: true, lastRunFailed: true, error: 'Vendor returned HTTP 503', recordCount: 12 });
  });
});
