import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { aggregateAssembly, applyMatchDecision, type AssemblyDefinition, type VendorRecord } from '@control-kit/shared';
import { clearCatalogMemoryCache, enrichScan } from './catalog';
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
function catalog() {
  const kv = new MemoryKv();
  const index = new Map<string, string[]>();
  for (const record of records) {
    const id = `${record.vendorId}:${record.normalizedSku}`;
    kv.values.set(`vendor:${id}`, JSON.stringify(record));
    for (const token of record.normalizedName.split(' ')) index.set(token, [...(index.get(token) ?? []), id]);
  }
  for (const [token, ids] of index) kv.values.set(`vendor-index:${token}`, JSON.stringify(ids));
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
    const screw = result.lines.find(line => line.partId === 'screw-m3')!;
    expect(screw.qty).toBe(200);
    expect(screw.packsToOrder).toBe(20);
    expect(screw.lineTotalUsd).toBe(179.8);
    const wheel = result.lines.find(line => line.partId === 'wheel-96')!;
    expect(wheel.packsToOrder).toBe(8);
    expect(wheel.lineTotalUsd).toBe(100);
    expect(result.stats.totalCostUsd).toBe(979.6);
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
});
