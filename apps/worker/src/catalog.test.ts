import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { aggregateAssembly, applyMatchDecision, normalizeName, normalizeSku, type AssemblyDefinition, type BomLine, type VendorId, type VendorRecord, classifyScan } from '@control-kit/shared';
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
    classifyScan(await enrichScan(result, catalog()), { teamNumber: null }, {});
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
    classifyScan(await enrichScan(result, catalog(), async () => ({ status: 'confirmed', vendorId: 'andymark', normalizedSku: '1000' })), { teamNumber: null }, {});
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
    classifyScan(await enrichScan(result, catalog()), { teamNumber: null }, {});
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

describe('known products and SKU choices', () => {
  const record = (vendorId: VendorId, sku: string, name: string, priceUsd = 10): VendorRecord => ({ vendorId, sku, normalizedSku: normalizeSku(sku, vendorId), name, normalizedName: normalizeName(name), url: 'https://www.gobilda.com/x/', priceUsd, packSize: 1, packSizeVerified: true, packEvidence: 'sold individually: no pack wording, and this vendor names every multi-unit product', stock: 'in', stockQty: null, category: 'electronics', updatedAt: new Date().toISOString(), source: 'sitemap' });
  const shelf = [
    record('gobilda', '3110-0002-0001', 'Pinpoint Odometry Computer (IMU Sensor Fusion for 2 Dead Wheels)', 79.99),
    record('gobilda', '3110-0002-0002', 'Pinpoint V2 Odometry Computer', 79.99),
    record('rev', 'REV-31-1595', 'Control Hub', 375),
    record('gobilda', '5000-0002-0001', 'Modern Robotics Motor', 30),
    record('gobilda', '5000-0002-4008', 'Gearmotor 4008', 40),
    record('gobilda', '3625-0202-0104', 'GripForce Mecanum Wheel Set (104mm, 40A Durometer Rollers)', 189.99),
  ];
  const lines = (...specs: Array<Partial<BomLine> & { name: string }>) => {
    const result = aggregateAssembly(fixture('empty'), context, 'Robot');
    const base = aggregateAssembly(fixture('simple'), context, 'Robot').lines[0];
    result.lines = specs.map((spec, n) => ({ ...base, partNumber: null, bomLineKey: `line-${n}`, qty: 1, ...spec }));
    return result;
  };
  it('matches a part named exactly like a known product, and asks which one when it is sold as several', async () => {
    clearCatalogMemoryCache();
    const result = lines({ name: 'Control Hub' }, { name: 'Pinpoint' }, { name: 'Pinpoint case' });
    classifyScan(await enrichScan(result, catalog(shelf)), { teamNumber: null }, {});
    const [hub, pinpoint, pinpointCase] = result.lines;
    expect(hub).toMatchObject({ matchStatus: 'exact', disposition: 'buy', lineTotalUsd: 375 });
    expect(hub.vendor?.sku).toBe('REV-31-1595');
    expect(pinpoint.matchStatus).toBe('possible');
    expect(pinpoint.choices?.map(choice => choice.sku)).toEqual(['3110-0002-0001', '3110-0002-0002']);
    expect(pinpoint.lineTotalUsd).toBeNull();
    expect(pinpointCase.matchStatus).not.toBe('exact');
  });
  it('keeps a name sold as several SKUs a question when only one of them is in the catalog', async () => {
    clearCatalogMemoryCache();
    const result = lines({ name: 'Pinpoint' });
    await enrichScan(result, catalog(shelf.filter(item => item.sku !== '3110-0002-0001')));
    expect(result.lines[0].matchStatus).toBe('possible');
    expect(result.lines[0].choices?.map(choice => choice.sku)).toEqual(['3110-0002-0002']);
  });
  it('asks which SKU when one part names two numbers sold by the same vendor', async () => {
    clearCatalogMemoryCache();
    const result = lines({ name: '5000-0002-0001 5000-0002-4008 Motor' });
    await enrichScan(result, catalog(shelf));
    expect(result.lines[0].matchStatus).toBe('possible');
    expect(result.lines[0].choices?.map(choice => choice.sku).sort()).toEqual(['5000-0002-0001', '5000-0002-4008']);
  });
  it('applies a saved decision that picks a choice other than the one shown', async () => {
    clearCatalogMemoryCache();
    const result = lines({ name: 'Pinpoint' });
    classifyScan(await enrichScan(result, catalog(shelf), async () => ({ status: 'confirmed', vendorId: 'gobilda', normalizedSku: normalizeSku('3110-0002-0002', 'gobilda') })), { teamNumber: null }, {});
    expect(result.lines[0]).toMatchObject({ matchStatus: 'confirmed', lineTotalUsd: 79.99 });
    expect(result.lines[0].vendor?.sku).toBe('3110-0002-0002');
    // Picking another choice later replaces the first pick.
    const changed = applyMatchDecision(result, 'line-0', 'confirmed', { vendorId: 'gobilda', normalizedSku: normalizeSku('3110-0002-0001', 'gobilda') });
    expect(changed.lines[0].vendor?.sku).toBe('3110-0002-0001');
  });
  it('asks which product a kit is when its own bodies name a different SKU of the same family', async () => {
    clearCatalogMemoryCache();
    const result = lines({ name: '5000-0002-0001 Motor', purchasedAssembly: { parts: 3, reason: 'its name has a goBILDA/ServoCity part number', inside: ['5000-0002-4008 Gearbox', '2800-0004-0010 Screw', 'Shaft'] } });
    await enrichScan(result, catalog(shelf));
    expect(result.lines[0].matchStatus).toBe('possible');
    expect(result.lines[0].choices?.map(choice => choice.sku)).toEqual(['5000-0002-0001', '5000-0002-4008']);
  });
  it('orders one mecanum wheel set for four modeled wheels', async () => {
    clearCatalogMemoryCache();
    const result = lines({ name: '3625-0202-0104 Mecanum Wheel', qty: 4 });
    classifyScan(await enrichScan(result, catalog(shelf)), { teamNumber: null }, {});
    expect(result.lines[0]).toMatchObject({ matchStatus: 'exact', packsToOrder: 1, lineTotalUsd: 189.99 });
    expect(result.lines[0].vendor?.packEvidence).toMatch(/4 wheels/);
  });
});

describe('bundles', () => {
  it('never prices a bundle of different pieces as one CAD part (REV C Channel Bundle, $918 for two channels)', async () => {
    clearCatalogMemoryCache();
    const bundle: VendorRecord = { vendorId: 'rev', sku: 'REV-45-1896', normalizedSku: normalizeSku('REV-45-1896', 'rev'), name: 'C Channel Bundle', normalizedName: normalizeName('C Channel Bundle'), url: 'https://www.revrobotics.com/rev-45-1896/', priceUsd: 229.5, packSize: 1, packSizeVerified: true, packEvidence: 'sold individually: no pack wording, and this vendor names every multi-unit product', stock: 'in', stockQty: null, category: 'structure', updatedAt: new Date().toISOString(), source: 'sitemap' };
    const result = aggregateAssembly(fixture('empty'), context, 'Robot');
    result.lines = [{ ...aggregateAssembly(fixture('simple'), context, 'Robot').lines[0], name: 'C Channel 408mm', partNumber: 'REV-45-1896', bomLineKey: 'channel', qty: 2 }];
    classifyScan(await enrichScan(result, catalog([bundle])), { teamNumber: null }, {});
    expect(result.lines[0]).toMatchObject({ matchStatus: 'exact', lineTotalUsd: null });
    expect(result.lines[0].vendor?.packSizeVerified).toBe(false);
    expect(result.stats.totalCostUsd).toBeNull();
  });
});

describe('parts library vendor tags', () => {
  const record = (vendorId: VendorId, sku: string, name: string, priceUsd = 10): VendorRecord => ({ vendorId, sku, normalizedSku: normalizeSku(sku, vendorId), name, normalizedName: normalizeName(name), url: 'https://www.gobilda.com/x/', priceUsd, packSize: 1, packSizeVerified: true, stock: 'in', stockQty: null, category: 'motion', updatedAt: new Date().toISOString(), source: 'sitemap' });
  // Real names from the goBILDA and REV catalogs (2026-10-25).
  const shelf = [
    record('rev', 'REV-11-1855', 'Servo Hub', 90),
    record('gobilda', '1908-0025-0032', '1908 Series Servo Hub (25 Tooth Spline, 32mm Diameter)', 8.99),
    record('gobilda', '1908-0024-0032', '1908 Series Servo Hub (24 Tooth Spline, 32mm Diameter)', 8.99),
    record('gobilda', '3109-0004-0002', 'Servo Commander', 39.99),
    record('gobilda', '5203-2402-0001', '5203 Series Yellow Jacket Motor (1:1 Ratio, 24mm Length 8mm REX® Shaft, 6000 RPM, 3.3 - 5V Encoder)', 54.99),
    record('gobilda', '5202-0002-0001', '5202 Series Yellow Jacket Motor (1:1 Ratio, 24mm Length 6mm D-Shaft, 6000 RPM, 3.3 - 5V Encoder)', 44.99),
    record('gobilda', '5203-2402-0139', '5203 Series Yellow Jacket Planetary Gear Motor (139:1 Ratio, 24mm Length 8mm REX® Shaft, 43 RPM, 3.3 - 5V Encoder)', 54.99),
  ];
  const lines = (...specs: Array<Partial<BomLine> & { name: string }>) => {
    const result = aggregateAssembly(fixture('empty'), context, 'Robot');
    const base = aggregateAssembly(fixture('simple'), context, 'Robot').lines[0];
    result.lines = specs.map((spec, n) => ({ ...base, partNumber: null, configuration: null, bomLineKey: `line-${n}`, qty: 1, ...spec }));
    return result;
  };
  it('matches only the tagged vendor and offers its closest products as choices', async () => {
    clearCatalogMemoryCache();
    const result = lines({ name: 'Servo Hub (GB)' }, { name: '6000rpm Motor - Bare REX (GB)', configuration: 'Encoder_Cap_Color=4D4D4D;Flux_Ring_Color=FFC10E;List_a1=Medium;List_b2=_6000rpm_Bare_REX;List_c3=New' }, { name: 'Servo Hub (REV)' });
    await enrichScan(result, catalog(shelf));
    const [hub, motor, revHub] = result.lines;
    expect(hub.matchStatus).toBe('possible');
    expect(hub.choices?.map(choice => choice.sku).sort()).toEqual(['1908-0024-0032', '1908-0025-0032']);
    // The tag, "REX", and 6000rpm leave one product: the bare 6000 RPM motor with a REX shaft, matched exactly.
    expect(motor.matchStatus).toBe('exact');
    expect(motor.vendor?.sku).toBe('5203-2402-0001');
    expect(motor.choices?.map(choice => choice.sku)).not.toContain('5203-2402-0139');
    expect(revHub.vendor?.sku).toBe('REV-11-1855');
  });
  it('keeps exact SKU choices, never falls back to another vendor, and keeps known products at the tagged vendor', async () => {
    clearCatalogMemoryCache();
    const result = lines({ name: '5203-2402-0001 5202-0002-0001 Motor (GB)' }, { name: 'Control Hub (GB)' });
    await enrichScan(result, catalog([...shelf, record('rev', 'REV-31-1595', 'Control Hub', 375)]));
    expect(result.lines[0].choices?.map(choice => choice.sku).sort()).toEqual(['5202-0002-0001', '5203-2402-0001']);
    expect(result.lines[1].vendor?.sku).not.toBe('REV-31-1595');
    clearCatalogMemoryCache();
    const missing = lines({ name: 'Servo Hub (GB)' });
    await enrichScan(missing, catalog(shelf.filter(item => item.vendorId !== 'gobilda')));
    expect(missing.lines[0]).toMatchObject({ matchStatus: 'unmatched', vendor: null });
  });
  it('reads sizes written as one token and the bore, and matches the one product with every size exactly', async () => {
    clearCatalogMemoryCache();
    // goBILDA's bearings with these sizes (2026-10-28): the round and REX bore 1611, and look-alikes one size off.
    const bearings = [
      record('gobilda', '1611-0514-0008', '1611 Series Flanged Ball Bearing (8mm ID x 14mm OD, 5mm Thickness) - 2 Pack', 4.99),
      record('gobilda', '1611-0514-4008', '1611 Series Flanged Ball Bearing (8mm REX® ID x 14mm OD, 5mm Thickness) - 2 Pack', 4.99),
      record('gobilda', '1601-0414-0008', '1601 Series Flanged Ball Bearing (8mm ID x 14mm OD, 4mm Thickness) - 2 Pack', 4.99),
      record('gobilda', '1613-0514-0006', '1613 Series Thrust Ball Bearing (6mm ID x 14mm OD, 5mm Thickness)', 2.99),
    ];
    const result = lines({ name: '8x14x5mm Bearing - Round Bore (GB)', configuration: 'List_a1=8×14×50;List_b2=Mediumm' }, { name: '8 × 14 × 5 mm Bearing - REX Bore (GB)' }, { name: '8x14mm Bearing (GB)' }, { name: '5x14x8mm Bearing - Round Bore (GB)' });
    await enrichScan(result, catalog([...shelf, ...bearings]));
    const [round, rex, unsized, reordered] = result.lines;
    // The same numbers in another order are another bearing (5mm bore, 8mm thick), so it is never matched exactly.
    expect(reordered.matchStatus).not.toBe('exact');
    // A decimal size keeps its place: goBILDA's 8mm x 15.5mm x 5mm thrust bearing.
    clearCatalogMemoryCache();
    const thrust = lines({ name: '8x15.5x5mm Thrust Bearing (GB)' });
    await enrichScan(thrust, catalog([...shelf, ...bearings, record('gobilda', '1613-0515-0008', '1613 Series Thrust Ball Bearing (8mm ID x 15.5mm OD, 5mm Thickness)', 2.99)]));
    expect(thrust.lines[0]).toMatchObject({ matchStatus: 'exact' });
    expect(thrust.lines[0].vendor?.sku).toBe('1613-0515-0008');
    expect(round).toMatchObject({ matchStatus: 'exact' });
    expect(round.vendor?.sku).toBe('1611-0514-0008');
    expect(round.matchReasons[0]).toContain('every size in the name');
    expect(rex.vendor?.sku).toBe('1611-0514-4008');
    expect(rex.matchStatus).toBe('exact');
    // Two sizes fit several bearings, so a person still picks.
    expect(unsized.matchStatus).toBe('possible');
  });
});

describe('discontinued SKUs', () => {
  const record = (sku: string, name: string, priceUsd: number): VendorRecord => ({ vendorId: 'rev', sku, normalizedSku: normalizeSku(sku, 'rev'), name, normalizedName: normalizeName(name), url: 'https://www.revrobotics.com/x/', priceUsd, packSize: 1, packSizeVerified: true, stock: 'in', stockQty: null, category: 'uncategorized', updatedAt: new Date().toISOString(), source: 'feed', parser: 'official-feed' });
  // REV's feed of 2026-10-28 lists neither REV-31-1152 nor REV-41-1097, only what replaced them.
  const feed = [
    record('REV-31-1595', 'Control Hub', 375),
    record('REV-41-3334', 'Smart Robot Servos V2 (Smart Robot Servo V2 - Balanced (REV-41-3334))', 32.5),
    record('REV-41-3336', 'Smart Robot Servos V2 (Smart Robot Servo V2 - UltraSpeed (REV-41-3336))', 32.5),
  ];
  const lines = (...specs: Array<Partial<BomLine> & { name: string }>) => {
    const result = aggregateAssembly(fixture('empty'), context, 'Robot');
    const base = aggregateAssembly(fixture('simple'), context, 'Robot').lines[0];
    result.lines = specs.map((spec, n) => ({ ...base, partNumber: null, configuration: null, bomLineKey: `line-${n}`, qty: 1, ...spec }));
    return result;
  };
  it('orders a discontinued SKU as its successor, and asks which one when there are two', async () => {
    clearCatalogMemoryCache();
    const result = lines({ name: 'Control Hub REV-31-1152', partNumber: 'REV-31-1152' }, { name: 'Smart Robot Servo REV-41-1097' });
    classifyScan(await enrichScan(result, catalog(feed)), { teamNumber: null }, {});
    const [hub, servo] = result.lines;
    expect(hub).toMatchObject({ matchStatus: 'exact', lineTotalUsd: 375 });
    expect(hub.vendor?.sku).toBe('REV-31-1595');
    expect(hub.matchReasons[0]).toBe('REV-31-1152 is discontinued; REV Control Hub is sold as REV-31-1595');
    expect(servo.matchStatus).toBe('possible');
    expect(servo.choices?.map(choice => choice.sku)).toEqual(['REV-41-3334', 'REV-41-3336']);
    expect(servo.lineTotalUsd).toBeNull();
  });
  it('keeps every replacement a choice when a part names two discontinued products', async () => {
    clearCatalogMemoryCache();
    const result = lines({ name: 'Smart Robot Servo REV-41-1097', partNumber: 'REV-31-1152' });
    await enrichScan(result, catalog(feed));
    expect(result.lines[0].matchStatus).toBe('possible');
    expect(result.lines[0].choices?.map(choice => choice.sku).sort()).toEqual(['REV-31-1595', 'REV-41-3334', 'REV-41-3336']);
    expect(result.lines[0].matchReasons[0]).toContain('REV-31-1152 is discontinued');
    expect(result.lines[0].matchReasons[0]).toContain('REV-41-1097 is discontinued');
  });
});
