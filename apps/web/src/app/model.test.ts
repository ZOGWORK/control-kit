import { describe, expect, it } from 'vitest';
import { aggregateAssembly, classifyScan, recalculatePurchasing, type AssemblyInstance, type BomLine, type ScanResult, type VendorRecord } from '@control-kit/shared';
import { buyList, catalogsReady, filterParts, reviewQueue, summarize } from './model';

const vendor = (sku: string, packSize: number | null, priceUsd: number | null): VendorRecord => ({ vendorId: 'gobilda', sku, normalizedSku: sku.replace(/\D/g, ''), name: 'Screw', normalizedName: 'screw', url: 'https://www.gobilda.com/x/',
  priceUsd, packSize, packSizeVerified: packSize !== null, stock: 'in', stockQty: null, category: 'hardware', updatedAt: '2026-10-24T00:00:00Z', source: 'sitemap' });
function scan(instances: AssemblyInstance[], edit: (lines: BomLine[]) => void = () => undefined): ScanResult {
  const result = aggregateAssembly({ rootAssembly: { instances } }, { documentId: 'doc', workspaceOrVersion: 'w', workspaceOrVersionId: 'work', elementId: 'asm' }, 'Robot');
  edit(result.lines);
  return recalculatePurchasing(classifyScan(result, { teamNumber: null }, {}));
}
const parts = (name: string, count: number, partId = name): AssemblyInstance[] => Array.from({ length: count }, (_, n) => ({ id: `${partId}${n}`, name, type: 'Part', documentId: 'doc', elementId: 'studio', partId }));

describe('Control Kit view model', () => {
  it('prices 12 screws in a verified 10-pack at $8.99 as 2 packs, $17.98, and labels the subtotal incomplete', () => {
    const result = scan([...parts('M4 screw', 12, 'screw'), ...parts('Bearing', 2, 'bearing')], lines => {
      const screw = lines.find(line => line.partId === 'screw')!;
      screw.vendor = vendor('2802-0004-0010', 10, 8.99); screw.matchStatus = 'exact';
      const bearing = lines.find(line => line.partId === 'bearing')!;
      bearing.vendor = vendor('1611-0019-0006', null, 2.5); bearing.matchStatus = 'exact';
    });
    const screw = result.lines.find(line => line.partId === 'screw')!;
    expect(screw).toMatchObject({ qty: 12, packsToOrder: 2, lineTotalUsd: 17.98, disposition: 'buy' });
    // The bearing has no verified pack size, so it is not priced and the subtotal says so.
    expect(summarize(result)).toMatchObject({ subtotal: 17.98, pricedLines: 1, buyLines: 2 });
    const { vendors, needsSku } = buyList(result);
    expect(vendors).toHaveLength(1);
    expect(vendors[0]).toMatchObject({ label: 'goBILDA', subtotal: 17.98, unpriced: 1 });
    expect(needsSku).toEqual([]);
  });
  it('never puts a possible match under a vendor or into a total', () => {
    const result = scan(parts('Wheel', 4, 'wheel'), lines => { lines[0].vendor = vendor('3606-0014-0096', 1, 12); lines[0].matchStatus = 'possible'; });
    expect(result.lines[0].lineTotalUsd).toBeNull();
    expect(summarize(result).subtotal).toBeNull();
    expect(buyList(result).vendors).toEqual([]);
    expect(reviewQueue(result).map(item => item.kind)).toEqual(['match']);
  });
  it('orders the review queue by what one click can settle', () => {
    const result = scan([...parts('Mystery part', 1, 'a'), ...parts('M3 x 8 screw', 5, 'b'), ...parts('Wheel', 1, 'c')], lines => {
      const wheel = lines.find(line => line.partId === 'c')!; wheel.vendor = vendor('3606-0014-0096', 1, 12); wheel.matchStatus = 'possible';
    });
    expect(reviewQueue(result).map(item => [item.line.name, item.kind])).toEqual([['Wheel', 'match'], ['M3 x 8 screw', 'suggested'], ['Mystery part', 'undecided']]);
  });
  it('filters and searches parts by disposition, part number, and SKU', () => {
    const result = scan([...parts('Sensor mount [3DP]', 1, 'm'), ...parts('M3 screw', 2, 's'), { id: 'x', name: 'Spare', type: 'Part', documentId: 'doc', elementId: 'studio', partId: 'x', suppressed: true }], lines => {
      lines.find(line => line.partId === 's')!.partNumber = '2800-0003-0008';
    });
    expect(filterParts(result, 'make', '', 'name').map(line => line.partId)).toEqual(['m']);
    expect(filterParts(result, 'all', '2800-0003', 'name').map(line => line.partId)).toEqual(['s']);
    expect(filterParts(result, 'suppressed', '', 'name').map(line => line.partId)).toEqual(['x']);
    expect(filterParts(result, 'all', '', 'qty')[0].partId).toBe('s');
  });
  it('treats catalogs as ready only when all five are published and complete', () => {
    const vendors = (['gobilda', 'servocity', 'andymark', 'rev', 'pitsco'] as const).map(vendorId => ({ vendorId, state: 'published' as const, complete: true, recordCount: 1, updatedAt: null, lastRunAt: null, stale: false, lastRunFailed: false, error: null, skipped: {}, progress: null }));
    expect(catalogsReady({ checkedAt: '', vendors })).toBe(true);
    expect(catalogsReady({ checkedAt: '', vendors: vendors.map((vendor, index) => index ? vendor : { ...vendor, complete: false }) })).toBe(false);
    expect(catalogsReady(undefined)).toBe(false);
  });
});
