import { describe, expect, it } from 'vitest';
import { aggregateAssembly, classifyScan, recalculatePurchasing, type AssemblyInstance, type BomLine, type ScanResult, type VendorRecord } from '@control-kit/shared';
import { buyList, catalogState, catalogStateText, catalogsComplete, composition, filterParts, findParts, hasChanges, money, primaryAction, readiness, reviewQueue, makeListKey, scanChanges, staleCatalogs, summarize, topCosts, workspaceAccent } from './model';

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
  it('accounts for every unique part and picks one primary action in working order', () => {
    const result = scan([...parts('M4 screw', 12, 'screw'), ...parts('Bearing', 2, 'bearing'), ...parts('Mystery part', 1, 'mystery'), ...parts('M3 socket head screw', 4, 'hw')], lines => {
      const screw = lines.find(line => line.partId === 'screw')!;
      screw.vendor = vendor('2802-0004-0010', 10, 8.99); screw.matchStatus = 'exact';
      const bearing = lines.find(line => line.partId === 'bearing')!;
      bearing.vendor = { ...vendor('1611-0019-0006', 1, 2.5), stock: 'out' }; bearing.matchStatus = 'exact';
    });
    const summary = summarize(result);
    // Buy, make, fasteners, review, and set-aside parts add up to the unique count, so the screen never leaves a gap.
    expect(composition(summary).reduce((sum, share) => sum + share.count, 0)).toBe(summary.uniqueLines);
    const ready = readiness(result, summary);
    expect(ready.order).toMatchObject({ ready: 2, total: 2, unmatched: 0, unpriced: 0, outOfStock: 1 });
    expect(primaryAction(summary, ready)).toMatchObject({ kind: 'review', label: 'Review 1 part' });
    expect(primaryAction({ ...summary, review: 0 }, ready)).toMatchObject({ kind: 'stock', label: 'Replace 1 out-of-stock part' });
    expect(primaryAction({ ...summary, review: 0 }, { ...ready, order: { ...ready.order, unmatched: 3 } }).label).toBe('Fix 3 unmatched parts');
    expect(primaryAction({ ...summary, review: 0 }, { ...ready, order: { ...ready.order, outOfStock: 0 } }).kind).toBe('build-pack');
    expect(topCosts(result).map(line => line.partId)).toEqual(['screw', 'bearing']);
    expect(money(1768.05)).toBe('$1,768.05');
  });
  it('reports what a rescan changed by part, not by revision', () => {
    const before = scan([...parts('M4 screw', 12, 'screw'), ...parts('Old bracket', 1, 'old')]);
    const after = scan([...parts('M4 screw', 16, 'screw'), ...parts('Sensor mount', 1, 'mount')], lines => {
      const screw = lines.find(line => line.partId === 'screw')!;
      screw.bomLineKey += ':new-microversion';
      screw.vendor = vendor('2802-0004-0010', 10, 8.99); screw.matchStatus = 'exact';
    });
    const changes = scanChanges(before, after);
    expect(changes.added.map(line => line.name)).toEqual(['Sensor mount']);
    expect(changes.removed.map(line => line.name)).toEqual(['Old bracket']);
    expect(changes).toMatchObject({ quantity: 1, newlyPriced: 1, subtotalDelta: 17.98 });
    expect(hasChanges(scanChanges(before, before))).toBe(false);
    // One part at two revisions is one part: an unchanged rescan reports nothing, and dropping a revision is a quantity change.
    const single = scan(parts('Spacer', 1, 'spacer'));
    const revisions = { ...single, lines: [{ ...single.lines[0], disposition: 'cnc' as const }, { ...single.lines[0], disposition: 'cnc' as const, bomLineKey: `${single.lines[0].bomLineKey}:rev2`, sourceId: 'rev2', qty: 2 }] };
    expect(hasChanges(scanChanges(revisions, revisions))).toBe(false);
    expect(scanChanges(revisions, { ...revisions, lines: revisions.lines.slice(1) }).quantity).toBe(1);
    // A decided part made a different way is a change even when nothing else moves.
    const retyped = { ...revisions, lines: revisions.lines.map(line => ({ ...line, disposition: 'print' as const })) };
    expect(scanChanges(revisions, retyped).retyped).toBe(1);
    // A part whose second revision rides on the first one's order is priced; a vendor going out of stock is a change.
    const withVendor = (stock: 'in' | 'out') => ({ ...revisions, lines: revisions.lines.map((line, index) => ({ ...line, vendor: { ...vendor('2802-0004-0010', 10, 8.99), stock }, lineTotalUsd: index ? null : 8.99, orderedWith: index ? line.bomLineKey : null })) });
    expect(scanChanges(revisions, withVendor('in')).newlyPriced).toBe(1);
    expect(scanChanges(withVendor('in'), withVendor('out')).stock).toBe(1);
    // A purchased subassembly renamed in Onshape is the same product.
    const kit = { ...single, lines: [{ ...single.lines[0], partId: null, purchasedAssembly: { parts: 6, reason: 'its name has a vendor part number' } }] };
    expect(hasChanges(scanChanges(kit, { ...kit, lines: [{ ...kit.lines[0], name: 'Renamed motor' }] }))).toBe(false);
    expect(findParts(after, 'mount').map(line => line.name)).toEqual(['Sensor mount']);
  });
  it('takes a workspace colour as the brand accent only when it reads on graphite and under button text', () => {
    expect(workspaceAccent('#5b8cff')).toMatchObject({ accent: '#5b8cff', ink: '#0a0a0b' });
    expect(workspaceAccent('#e11d48')).toMatchObject({ ink: '#ffffff' });
    // #2f6bff puts white text at 4.49:1, just under 4.5, so it is refused.
    expect(workspaceAccent('#2f6bff')).toBeNull();
    expect(workspaceAccent('#ffc700')?.ink).toBe('#0a0a0b');
    // Too dark to see on the background, malformed, or missing: the app stays volt.
    expect(workspaceAccent('#1a1a40')).toBeNull();
    expect(workspaceAccent('blue')).toBeNull();
    expect(workspaceAccent(null)).toBeNull();
  });
  it('ties a STEP export to the make list it covered', () => {
    const result = scan([...parts('Sensor mount [3DP]', 1, 'm'), ...parts('Mystery part', 1, 'x')]);
    const exported = makeListKey(result);
    expect(makeListKey(result)).toBe(exported);
    // Marking another part to print changes what a STEP ZIP must contain.
    const changed = { ...result, lines: result.lines.map(line => line.partId === 'x' ? { ...line, disposition: 'print' as const } : line) };
    expect(makeListKey(changed)).not.toBe(exported);
  });
  it('never puts a possible match under a vendor or into a total', () => {
    const result = scan(parts('Wheel', 4, 'wheel'), lines => { lines[0].vendor = vendor('3606-0014-0096', 1, 12); lines[0].matchStatus = 'possible'; });
    expect(result.lines[0].lineTotalUsd).toBeNull();
    expect(summarize(result).subtotal).toBeNull();
    expect(buyList(result).vendors).toEqual([]);
    expect(reviewQueue(result).map(item => item.kind)).toEqual(['match']);
  });
  it('orders the review queue by what one click can settle', () => {
    const result = scan([...parts('Mystery part', 1, 'a'), ...parts('8mm ball bearing', 5, 'b'), ...parts('Wheel', 1, 'c')], lines => {
      const wheel = lines.find(line => line.partId === 'c')!; wheel.vendor = vendor('3606-0014-0096', 1, 12); wheel.matchStatus = 'possible';
    });
    // The bearing is decided automatically (standard hardware), so only the match question and the open one remain.
    expect(reviewQueue(result).map(item => [item.line.name, item.kind])).toEqual([['Wheel', 'match'], ['Mystery part', 'undecided']]);
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
  it('treats catalogs as complete only when all five are published, and flags old or failed ones', () => {
    const vendors = (['gobilda', 'servocity', 'andymark', 'rev', 'pitsco'] as const).map(vendorId => ({ vendorId, state: 'published' as const, complete: true, recordCount: 1, updatedAt: null, lastRunAt: null, stale: false, lastRunFailed: false, error: null, skipped: {}, progress: null }));
    expect(catalogsComplete({ checkedAt: '', vendors })).toBe(true);
    expect(catalogsComplete({ checkedAt: '', vendors: vendors.map((vendor, index) => index ? vendor : { ...vendor, complete: false }) })).toBe(false);
    expect(catalogsComplete(undefined)).toBe(false);
    // Old or failed-to-update catalogs still cover every product, but never read as Ready.
    const aged = vendors.map((vendor, index) => index === 0 ? { ...vendor, stale: true } : index === 1 ? { ...vendor, lastRunFailed: true } : vendor);
    expect(catalogsComplete({ checkedAt: '', vendors: aged })).toBe(true);
    expect(aged.map(catalogState)).toEqual(['stale', 'stale', 'published', 'published', 'published']);
    expect(aged.slice(0, 2).map(catalogStateText)).toEqual(['Out of date', 'Last update failed']);
    expect(staleCatalogs({ checkedAt: '', vendors: aged }).map(vendor => vendor.vendorId)).toEqual(['gobilda', 'servocity']);
  });
});
