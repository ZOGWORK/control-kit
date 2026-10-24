import { describe, expect, it } from 'vitest';
import { aggregateAssembly, applyClassificationChoice, classificationIdentity, classifyLine, classifyScan, parseOverride, type AssemblyInstance, type BomLine, type VendorRecord } from './index';

const context = { documentId: 'doc', workspaceOrVersion: 'w' as const, workspaceOrVersionId: 'work', elementId: 'element' };
function line(name: string, extra: Partial<AssemblyInstance> = {}): BomLine {
  return aggregateAssembly({ rootAssembly: { instances: [{ id: 'i', name, type: 'Part', documentId: 'doc', elementId: 'element', partId: 'part', ...extra }] } }, context, 'Assembly').lines[0];
}
const vendor = (sku: string): VendorRecord => ({ vendorId: 'gobilda', sku, normalizedSku: sku.replace(/\D/g, ''), name: 'Plate', normalizedName: 'plate', url: 'https://www.gobilda.com/x/', priceUsd: 5, packSize: 1, packSizeVerified: true, stock: 'in', stockQty: null, category: 'plate', updatedAt: '2026-10-24T00:00:00Z', source: 'sitemap' });
const classify = (value: BomLine, override: Parameters<typeof classifyLine>[2] = null, team: string | null = null) => classifyLine(value, team, override, 'doc');

describe('manufacturing disposition', () => {
  it('keeps an exact vendor SKU Buy whatever its name says', () => {
    const value = line('Printed custom bracket 16236 [3DP]');
    value.matchStatus = 'exact'; value.vendor = vendor('1121-0016-0048');
    expect(classify(value, null, '16236')).toMatchObject({ disposition: 'buy', dispositionSource: 'exact-sku', dispositionConfidence: 'certain', provenance: 'vendor-catalog', classification: 'commercial' });
  });
  it('lets a person override an exact SKU, keeps the SKU, and shows the exception', () => {
    const value = line('Hub');
    value.matchStatus = 'exact'; value.vendor = vendor('1309-0016-0006');
    classify(value, 'print');
    expect(value).toMatchObject({ disposition: 'print', dispositionSource: 'manual', manualClassification: 'print', matchStatus: 'exact', vendor: { sku: '1309-0016-0006' } });
    expect(value.dispositionEvidence.join(' ')).toContain('exception: exact vendor SKU 1309-0016-0006');
  });
  it('suggests Print for a team-designed bracket but leaves it for review', () => {
    expect(classify(line('Custom intake bracket'))).toMatchObject({ disposition: 'review', suggestedDisposition: 'print', provenance: 'team-design', dispositionSource: 'suggestion', classification: 'unknown' });
    expect(classify(line('Intake guide printed'))).toMatchObject({ disposition: 'review', suggestedDisposition: 'print', dispositionConfidence: 'medium' });
  });
  it('routes a flat custom plate to 2D-cut review, never straight to print', () => {
    const plate = classify(line('Drivetrain side plate'));
    expect(plate).toMatchObject({ disposition: 'review', suggestedDisposition: 'cut-2d' });
    expect(plate.reviewReason).toContain('custom plate');
    const bought = line('Pattern plate');
    bought.matchStatus = 'exact'; bought.vendor = vendor('1121-0016-0048');
    expect(classify(bought).disposition).toBe('buy');
  });
  it.each([
    ['Arm bracket [CNC]', 'cnc'], ['Side plate (laser)', 'cut-2d'], ['Gusset {waterjet}', 'cut-2d'], ['Sensor mount [3DP]', 'print'], ['Bearing #COTS', 'buy'],
  ] as const)('treats the team tag in "%s" as explicit metadata', (name, expected) => {
    expect(classify(line(name))).toMatchObject({ disposition: expected, dispositionSource: 'explicit-metadata', dispositionConfidence: 'high' });
  });
  it('requires complete tags and whole process words, and sends conflicts to review', () => {
    expect(classify(line('Mount (printer bracket)')).dispositionSource).not.toBe('explicit-metadata');
    expect(classify(line('Spacer #printable')).dispositionSource).not.toBe('explicit-metadata');
    expect(classify(line('Arm [3DP] (CNC)'))).toMatchObject({ disposition: 'review', dispositionSource: 'none' });
    const process = (value: string) => { const item = line('Arm'); item.bomProperties = { name: null, partNumber: null, description: null, vendor: null, material: null, quantity: 1, process: value }; return classify(item); };
    expect(process('3D CNC milling').disposition).toBe('cnc');
    expect(process('Waterjet').disposition).toBe('cut-2d');
    expect(process('Printed then machined')).toMatchObject({ disposition: 'review' });
    expect(process('Printed then machined').reviewReason).toContain('more than one process');
    expect(process('Turnkey').dispositionSource).not.toBe('explicit-metadata');
  });
  it('uses a print material or a BOM process column as explicit metadata', () => {
    const pla = line('Sensor mount'); pla.material = 'PLA';
    expect(classify(pla)).toMatchObject({ disposition: 'print', dispositionSource: 'explicit-metadata' });
    const cut = line('Side plate'); cut.bomProperties = { name: null, partNumber: null, description: null, vendor: null, material: 'Aluminum 6061', quantity: 2, process: 'Laser cut' };
    expect(classify(cut).disposition).toBe('cut-2d');
    expect(cut.dispositionEvidence).toContain('BOM process column "Laser cut"');
    const aluminum = line('Arm'); aluminum.material = 'Aluminum 6061';
    expect(classify(aluminum).disposition).toBe('review');
  });
  it('buys standard content and linked library parts with a part number', () => {
    expect(classify(line('Socket head cap screw M3x8', { isStandardContent: true }))).toMatchObject({ disposition: 'buy', provenance: 'standard-content', dispositionSource: 'provenance' });
    expect(classify(line('Hub', { documentId: 'ftc-library', partNumber: '1309-0016-0006' }))).toMatchObject({ disposition: 'buy', provenance: 'linked-library', dispositionConfidence: 'medium' });
    expect(classify(line('Mystery bracket', { documentId: 'ftc-library' }))).toMatchObject({ disposition: 'review', provenance: 'linked-library' });
  });
  it('asks a person about a possible vendor match instead of buying it', () => {
    const value = line('96mm wheel');
    value.matchStatus = 'possible'; value.vendor = vendor('3606-0014-0096');
    expect(classify(value)).toMatchObject({ disposition: 'review', suggestedDisposition: 'buy' });
    value.matchStatus = 'confirmed';
    expect(classify(value)).toMatchObject({ disposition: 'buy', dispositionSource: 'provenance' });
  });
  it('reads saved choices from before the rework', () => {
    expect([parseOverride('commercial'), parseOverride('printed'), parseOverride('cut-2d'), parseOverride('bogus'), parseOverride(null)]).toEqual(['buy', 'print', 'cut-2d', null, null]);
  });
  it('reapplies document overrides and counts printed lines', () => {
    const result = aggregateAssembly({ rootAssembly: { instances: [{ id: 'i', name: 'Motor 1234', type: 'Part', documentId: 'doc', elementId: 'element', partId: 'part' }] } }, context, 'Assembly');
    classifyScan(result, { teamNumber: null }, { [result.lines[0].bomLineKey]: 'print' });
    expect(result.lines[0].manualClassification).toBe('print');
    expect(result.stats.printedLines).toBe(1);
    result.missingMetadata = [result.lines[0]];
    const changed = { ...result, lines: result.lines.map(item => ({ ...item })), missingMetadata: [...result.missingMetadata], stats: { ...result.stats } };
    classifyScan(changed, { teamNumber: null }, { [result.lines[0].bomLineKey]: 'buy' });
    expect(changed.missingMetadata[0]).toBe(changed.lines[0]);
    expect(changed.missingMetadata[0].disposition).toBe('buy');
  });
  it('keeps manual type identity stable across source revisions', () => {
    const original = line('Custom bracket');
    original.sourceType = 'm'; original.sourceId = 'microversion-one';
    const edited = { ...original, sourceId: 'microversion-two', bomLineKey: `${original.bomLineKey}:new-revision` };
    expect(edited.bomLineKey).not.toBe(original.bomLineKey);
    expect(classificationIdentity(edited)).toBe(classificationIdentity(original));
  });
  it('updates and rolls back every revision row sharing a saved type identity', () => {
    const result = aggregateAssembly({ rootAssembly: { instances: [
      { id: 'rev1', name: 'Custom bracket', type: 'Part', documentId: 'doc', elementId: 'studio', partId: 'part', documentMicroversion: 'revision-one' },
      { id: 'rev2', name: 'Custom bracket', type: 'Part', documentId: 'doc', elementId: 'studio', partId: 'part', documentMicroversion: 'revision-two' },
      { id: 'other', name: 'Printed guide', type: 'Part', documentId: 'doc', elementId: 'other', partId: 'guide' },
    ] } }, { ...context, elementId: 'assembly' }, 'Assembly');
    const identity = classificationIdentity(result.lines[0]);
    expect(result.lines[0].bomLineKey).not.toBe(result.lines[1].bomLineKey);
    const selected = applyClassificationChoice(result, identity, 'cnc', { teamNumber: null });
    expect(selected.lines.slice(0, 2).map(item => [item.manualClassification, item.disposition])).toEqual([['cnc', 'cnc'], ['cnc', 'cnc']]);
    expect(selected.lines[2].manualClassification).toBeNull();
    const rolledBack = applyClassificationChoice(selected, identity, null, { teamNumber: null });
    expect(rolledBack.lines.slice(0, 2).map(item => item.manualClassification)).toEqual([null, null]);
    expect(rolledBack.lines[0].disposition).toBe('review');
    expect(rolledBack.lines[2].disposition).toBe(selected.lines[2].disposition);
  });
  it('keeps suppressed metadata rows distinct from active copies', () => {
    const result = aggregateAssembly({ rootAssembly: { instances: [
      { id: 'active', name: 'Custom bracket', type: 'Part', documentId: 'doc', elementId: 'element', partId: 'part' },
      { id: 'suppressed', name: 'Custom bracket', type: 'Part', documentId: 'doc', elementId: 'element', partId: 'part', suppressed: true },
    ] } }, context, 'Assembly');
    result.missingMetadata = [result.lines[0], result.suppressed[0]];
    const next = { ...result, lines: result.lines.map(item => ({ ...item })), stats: { ...result.stats } };
    classifyScan(next, { teamNumber: null }, {});
    expect(next.missingMetadata[0]).toBe(next.lines[0]);
    expect(next.missingMetadata[1]).toBe(next.suppressed[0]);
    expect(next.missingMetadata[1].suppressed).toBe(true);
  });
});
