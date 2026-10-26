import { describe, expect, it } from 'vitest';
import { aggregateAssembly, classifyScan, recalculatePurchasing, type BomLine, type VendorRecord } from './index';

const record = (vendorId: VendorRecord['vendorId'], sku: string, packSize: number, priceUsd: number): VendorRecord => ({ vendorId, sku, normalizedSku: sku.replace(/\D/g, ''), name: sku, normalizedName: sku,
  url: 'https://example.test/', priceUsd, packSize, packSizeVerified: true, stock: 'in', stockQty: null, category: 'hardware', updatedAt: '2026-10-24T00:00:00Z', source: 'sitemap' });
/** A part placed `count` times, from its own document and Part Studio unless given. */
const placed = (name: string, count: number, documentId: string, elementId: string, partId = name) =>
  Array.from({ length: count }, (_, n) => ({ id: `${name}${n}`, name, type: 'Part', documentId, elementId, partId, documentVersion: 'v1' }));
function scan(instances: ReturnType<typeof placed>, match: (line: BomLine) => VendorRecord | null) {
  const result = aggregateAssembly({ rootAssembly: { instances } }, { documentId: 'robot', workspaceOrVersion: 'w', workspaceOrVersionId: 'w1', elementId: 'asm' }, 'Robot');
  for (const line of result.lines) { const vendor = match(line); if (vendor) { line.vendor = vendor; line.matchStatus = 'exact'; } }
  return classifyScan(result, { teamNumber: null }, {});
}

describe('owner reports, 2026-10-26', () => {
  const context = { documentId: 'robot', workspaceOrVersion: 'w' as const, workspaceOrVersionId: 'w1', elementId: 'asm' };
  it('lists an Expansion Hub imported as 32 bodies named REV-31-1153 as one hub, not 32 ($8,800)', () => {
    const hub = record('rev', 'REV-31-1153', 1, 275);
    // From FTC 6980: a Part Studio "Expansion Hub" holding one Import feature with 32 parts, all named REV-31-1153,
    // placed in a subassembly in the team's own document.
    const bodies = Array.from({ length: 32 }, (_, n) => ({ id: `b${n}`, name: 'REV-31-1153', type: 'Part', documentId: 'robot', elementId: 'hubstudio', partId: `JH${n}` }));
    const result = aggregateAssembly({ rootAssembly: { instances: [{ id: 'h', name: 'Expansion Hub', type: 'Assembly', documentId: 'robot', elementId: 'hubasm' }] },
      subAssemblies: [{ documentId: 'robot', elementId: 'hubasm', instances: bodies }] }, context, 'Robot');
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0]).toMatchObject({ name: 'REV-31-1153', qty: 1, purchasedAssembly: { parts: 32 } });
    for (const line of result.lines) { line.vendor = hub; line.matchStatus = 'exact'; }
    classifyScan(result, { teamNumber: null }, {});
    expect(result.lines[0]).toMatchObject({ packsToOrder: 1, lineTotalUsd: 275 });
    expect(result.stats.totalCostUsd).toBe(275);
  });
  it('counts same-name bodies placed unevenly as one product per place, in the team document too', () => {
    const hub = record('rev', 'REV-31-1153', 1, 275);
    const bodies = [...placed('REV-31-1153', 1, 'robot', 'hubstudio', 'a'), ...placed('REV-31-1153', 1, 'robot', 'hubstudio', 'b'), ...placed('REV-31-1153', 2, 'robot', 'hubstudio', 'c')];
    expect(scan(bodies, () => hub).lines.find(line => line.order)?.order).toEqual({ qty: 2, lines: 3 });
  });
  it('never prices three or more of a $150+ product, and says why', () => {
    const hub = record('rev', 'REV-31-1153', 1, 275);
    const result = scan(['a', 'b', 'c'].flatMap(element => placed('Expansion Hub', 1, 'robot', element)), () => hub);
    const lead = result.lines.find(line => line.order)!;
    expect(lead.lineTotalUsd).toBeNull();
    expect(lead.priceCheck).toContain('more than an FTC robot uses');
    expect(result.stats.totalCostUsd).toBeNull();
    // Two hubs are normal and priced.
    expect(scan(['a', 'b'].flatMap(element => placed('Expansion Hub', 1, 'robot', element)), () => hub).stats.totalCostUsd).toBe(550);
  });
});

describe('purchase orders', () => {
  it('orders one SKU used on several CAD lines once: 5 + 13 + 25 screws are 2 packs of 25, not 3', () => {
    const screw = record('gobilda', '2802-0004-0012', 25, 3.59);
    // From HORS: the same screw from three different documents.
    const result = scan([...placed('Screw A', 5, 'docA', 'e1'), ...placed('Screw B', 13, 'docB', 'e2'), ...placed('2802-0004-0012', 25, 'docC', 'e3')], () => screw);
    const lead = result.lines.find(line => line.order)!;
    expect(lead).toMatchObject({ name: '2802-0004-0012', order: { qty: 43, lines: 3 }, packsToOrder: 2, lineTotalUsd: 7.18 });
    expect(result.lines.filter(line => line !== lead).every(line => line.orderedWith === lead.bomLineKey && line.lineTotalUsd === null)).toBe(true);
    expect(result.stats.totalCostUsd).toBe(7.18);
  });
  it('counts bodies of one Part Studio that share a SKU as one product per placement', () => {
    // From HORS: a REV magnetic limit switch modelled as four bodies, all carrying part number REV-31-1462.
    const sw = record('rev', 'REV-31-1462', 1, 17.5);
    const bodies = ['Connector', 'Screw', 'REV-40-1465', 'REV-40-1466'].flatMap(name => placed(name, 2, 'revdoc', 'switch', name));
    const result = scan(bodies, () => sw);
    const lead = result.lines.find(line => line.order)!;
    expect(lead.order).toEqual({ qty: 2, lines: 4 });
    expect(lead).toMatchObject({ packsToOrder: 2, lineTotalUsd: 35 });
    expect(result.stats.totalCostUsd).toBe(35);
  });
  it('adds copies of one body: four screws modelled in one Part Studio, each placed 30 times, are 120 screws', () => {
    // From the audit: a hardware Part Studio with "Screw 1" to "Screw 4", all part number 2800-0004-0012.
    const screw = record('gobilda', '2800-0004-0012', 25, 3.59);
    const bodies = ['Screw 1', 'Screw 2', 'Screw 3', 'Screw 4'].flatMap(name => placed(name, 30, 'robot', 'hardware', name));
    expect(scan(bodies, () => screw).lines.find(line => line.order)).toMatchObject({ order: { qty: 120, lines: 4 }, packsToOrder: 5 });
  });
  it('adds different bodies of one Part Studio that are placed in different places', () => {
    const screw = record('gobilda', '2800-0004-0012', 25, 3.59);
    const result = aggregateAssembly({ rootAssembly: { instances: [
      { id: 'a', name: 'Intake', type: 'Assembly', documentId: 'robot', elementId: 'intake' },
      { id: 'b', name: 'Lift', type: 'Assembly', documentId: 'robot', elementId: 'lift' },
    ] }, subAssemblies: [
      { documentId: 'robot', elementId: 'intake', instances: placed('Left screw', 6, 'robot', 'hardware', 'left') },
      { documentId: 'robot', elementId: 'lift', instances: placed('Right screw', 4, 'robot', 'hardware', 'right') },
    ] }, { documentId: 'robot', workspaceOrVersion: 'w', workspaceOrVersionId: 'w1', elementId: 'asm' }, 'Robot');
    for (const line of result.lines) { line.vendor = screw; line.matchStatus = 'exact'; }
    expect(classifyScan(result, { teamNumber: null }, {}).lines.find(line => line.order)?.order).toEqual({ qty: 10, lines: 2 });
  });
  it('adds differently named bodies placed different numbers of times in one assembly', () => {
    const screw = record('gobilda', '2800-0004-0012', 25, 3.59);
    const bodies = [...placed('Left screw', 6, 'robot', 'hardware', 'left'), ...placed('Right screw', 4, 'robot', 'hardware', 'right')];
    expect(scan(bodies, () => screw).lines.find(line => line.order)?.order).toEqual({ qty: 10, lines: 2 });
  });
  it('keeps a linked multi-body product together even when its pieces are placed unevenly', () => {
    const sw = record('rev', 'REV-31-1462', 1, 17.5);
    const bodies = [...placed('Connector', 2, 'revdoc', 'switch', 'Connector'), ...placed('Screw', 2, 'revdoc', 'switch', 'Screw'), ...placed('Housing', 3, 'revdoc', 'switch', 'Housing')];
    expect(scan(bodies, () => sw).lines.find(line => line.order)?.order).toEqual({ qty: 3, lines: 3 });
  });
  it('counts a multi-body product per place: two switches in one assembly and a spare housing elsewhere are three', () => {
    const sw = record('rev', 'REV-31-1462', 1, 17.5);
    const result = aggregateAssembly({ rootAssembly: { instances: [
      { id: 'a', name: 'Lift', type: 'Assembly', documentId: 'robot', elementId: 'lift' },
      { id: 'b', name: 'Spares', type: 'Assembly', documentId: 'robot', elementId: 'spares' },
    ] }, subAssemblies: [
      { documentId: 'robot', elementId: 'lift', instances: ['Connector', 'Screw', 'Housing'].flatMap(name => placed(name, 2, 'revdoc', 'switch', name)) },
      { documentId: 'robot', elementId: 'spares', instances: placed('Housing', 1, 'revdoc', 'switch', 'Housing').map(instance => ({ ...instance, id: 'spare' })) },
    ] }, { documentId: 'robot', workspaceOrVersion: 'w', workspaceOrVersionId: 'w1', elementId: 'asm' }, 'Robot');
    for (const line of result.lines) { line.vendor = sw; line.matchStatus = 'exact'; }
    expect(classifyScan(result, { teamNumber: null }, {}).lines.find(line => line.order)?.order).toEqual({ qty: 3, lines: 3 });
  });
  it('keeps configurations of one Part Studio apart', () => {
    const sw = record('rev', 'REV-31-1462', 1, 17.5);
    const instances = [...placed('Switch', 1, 'revdoc', 'switch', 'body'), ...placed('Switch', 1, 'revdoc', 'switch', 'body')].map((instance, n) => ({ ...instance, id: `s${n}`, configuration: n ? 'mount=left' : 'mount=right' }));
    expect(scan(instances, () => sw).lines.find(line => line.order)?.order).toEqual({ qty: 2, lines: 2 });
  });
  it('adds separate Part Studios: four bearings in four elements need 2 packs of 2', () => {
    const bearing = record('gobilda', '1611-0514-0008', 2, 3.99);
    const result = scan(['a', 'b', 'c', 'd'].flatMap(element => placed(`Bearing ${element}`, 1, 'robot', element)), () => bearing);
    expect(result.lines.find(line => line.order)).toMatchObject({ order: { qty: 4, lines: 4 }, packsToOrder: 2, lineTotalUsd: 7.98 });
  });
  it('prices only parts to buy, so a matched part set to print is never charged or counted', () => {
    const screw = record('gobilda', '2802-0004-0012', 25, 3.59);
    const result = scan([...placed('Screw A', 30, 'docA', 'e1'), ...placed('Screw B', 5, 'docB', 'e2')], () => screw);
    const chosen = classifyScan(result, { teamNumber: null }, { [result.lines.find(line => line.name === 'Screw B')!.bomLineKey]: 'print' });
    expect(chosen.lines.find(line => line.name === 'Screw A')).toMatchObject({ order: { qty: 30, lines: 1 }, packsToOrder: 2 });
    expect(chosen.lines.find(line => line.name === 'Screw B')).toMatchObject({ disposition: 'print', lineTotalUsd: null, orderedWith: null });
    expect(recalculatePurchasing(chosen).stats.totalCostUsd).toBe(7.18);
  });
});
