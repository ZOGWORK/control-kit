import { describe, expect, it } from 'vitest';
import { aggregateAssembly, applyClassificationChoice, classificationIdentity, classifyLine, classifyScan, parseOverride, type AssemblyInstance, type BomLine, type VendorRecord, purchasedAssemblyReason } from './index';

const context = { documentId: 'doc', workspaceOrVersion: 'w' as const, workspaceOrVersionId: 'work', elementId: 'element' };
function line(name: string, extra: Partial<AssemblyInstance> = {}): BomLine {
  return aggregateAssembly({ rootAssembly: { instances: [{ id: 'i', name, type: 'Part', documentId: 'doc', elementId: 'element', partId: 'part', ...extra }] } }, context, 'Assembly').lines[0];
}
const vendor = (sku: string): VendorRecord => ({ vendorId: 'gobilda', sku, normalizedSku: sku.replace(/\D/g, ''), name: 'Plate', normalizedName: 'plate', url: 'https://www.gobilda.com/x/', priceUsd: 5, packSize: 1, packSizeVerified: true, stock: 'in', stockQty: null, category: 'plate', updatedAt: '2026-10-24T00:00:00Z', source: 'sitemap' });
const classify = (value: BomLine, override: Parameters<typeof classifyLine>[2] = null, team: string | null = null) => classifyLine(value, team, override, 'doc');

describe('manufacturing disposition', () => {
  it('treats linked FTC products by name, like an Axon Max servo, as one product', () => {
    // From HORS: "Axon Max" is a linked servo assembly; its gear DDJ-STDCAR-GEAR5 was being listed as a part.
    for (const name of ['Axon Max', 'Axon Mini', 'NeveRest Orbital 20', 'Control Hub', 'goBILDA Pinpoint Odometry Computer', 'Spark Mini Motor Controller'])
      expect(purchasedAssemblyReason(name, null, true)).toBe('it is linked from another document and named like a product');
    // The team's own grouping is never collapsed by name alone, and a same-document one needs a SKU.
    for (const name of ['Axon Servo Mount Assembly', 'Axon Mount', 'Axon Bracket', 'Pinpoint case', 'Pinpoint plate holder'])
      expect(purchasedAssemblyReason(name, null, true)).toBeNull();
    expect(purchasedAssemblyReason('Axon Max', null, false)).toBeNull();
    // Linked team subsystems named after what they hold are groupings, so their parts stay listed.
    for (const name of ['Intake Wheels', 'Servo Arm', 'Drive Motors', 'Battery Box', 'Odometry Wheels', 'Bearing Block', 'Claw Servo', 'Turret Encoder Gear', 'Outtake Servo Linkage'])
      expect(purchasedAssemblyReason(name, null, true)).toBeNull();
  });
  it('does not take made parts with fastener words for stock fasteners', () => {
    for (const name of ['Captive Nut Plate', 'Washer Plate', 'Nut Strip', 'Lead Screw 8mm', 'Ball Screw', 'Screw Jack', 'Snap Ring Groove Shaft'])
      expect(classify(line(name)).disposition).not.toBe('hardware');
    expect(classify(line('M4 x 12mm Socket Head Screw')).disposition).toBe('hardware');
  });
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
  it('decides a flat custom plate is 2D cut automatically, never straight to print', () => {
    const plate = classify(line('Drivetrain side plate'));
    expect(plate).toMatchObject({ disposition: 'cut-2d', dispositionSource: 'suggestion', dispositionConfidence: 'low', reviewReason: null });
    expect(plate.dispositionEvidence).toContain('decided automatically; change it if wrong');
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
    expect(['Printing', '3D Printing', 'Prints', 'Additive manufacturing'].map(value => process(value).disposition)).toEqual(['print', 'print', 'print', 'print']);
    expect(['Machining', 'CNC milling', 'Lathed', 'Turning'].map(value => process(value).disposition)).toEqual(['cnc', 'cnc', 'cnc', 'cnc']);
    expect(['Laser cutting', 'Waterjetted', 'Routed', 'Plasma cutting'].map(value => process(value).disposition)).toEqual(['cut-2d', 'cut-2d', 'cut-2d', 'cut-2d']);
    expect(['Bending', 'Welding', 'Fabrication', 'Purchased', 'Bought'].map(value => process(value).disposition)).toEqual(['fabricate', 'fabricate', 'fabricate', 'buy', 'buy']);
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
    expect(classify(line('Dowel pin 3mm', { isStandardContent: true }))).toMatchObject({ disposition: 'buy', provenance: 'standard-content', dispositionSource: 'provenance' });
    // Fasteners come from stock, standard content or not.
    expect(classify(line('Socket head cap screw M3x8', { isStandardContent: true }))).toMatchObject({ disposition: 'hardware' });
    expect(classify(line('Hub', { documentId: 'ftc-library', partNumber: '1309-0016-0006' }))).toMatchObject({ disposition: 'buy', provenance: 'linked-library', dispositionConfidence: 'medium' });
    // Without a part number a linked library part is still a bought part, decided automatically with low confidence.
    expect(classify(line('Mystery bracket', { documentId: 'ftc-library' }))).toMatchObject({ disposition: 'buy', provenance: 'linked-library', dispositionSource: 'suggestion', dispositionConfidence: 'low' });
  });
  it('decides Buy for vendor part numbers and standard hardware in names, from the live HORS scan', () => {
    const suggested = (name: string, extra: Partial<AssemblyInstance> = {}) => classify(line(name, extra));
    expect(suggested('2302 Series Aluminum, MOD 0.8, Hub Mount Gear (14mm Bore, 48 Tooth)')).toMatchObject({ disposition: 'buy', dispositionSource: 'suggestion', reviewReason: null });
    expect(suggested('2106-4008-0560', { documentId: 'library' })).toMatchObject({ disposition: 'buy', reviewReason: null });
    expect(suggested('2106-4008-0560', { documentId: 'library' }).dispositionEvidence).toContain('goBILDA/ServoCity part number "2106-4008-0560" in name');
    // Fasteners need no decision: they are listed as stock hardware, not suggested for Buy one by one.
    for (const name of ['5103 Gearbox Base Mounting Screw M3 x 5mm length SHCS)_91290A110', 'M4 x 0.7mm Locknut', 'Roller E-Clip', 'Button Head Screw M4 x 12'])
      expect(suggested(name, { documentId: 'library' })).toMatchObject({ disposition: 'hardware', reviewReason: null });
    for (const name of ['Nut Holder', 'Screw Mount Bracket']) expect(suggested(name).disposition).toBe('review');
    // From the live HORS scan: products that mention a set screw stay products; head styles are screws.
    for (const name of ['3414 Series 5mm HTD Pitch Set Screw Pinion Timing Belt Pulley (8mm REX Bore, 24 Tooth) 3414-4008-0024', '2920 Series Steel Set-Screw Collar (8mm REX Bore)'])
      expect(suggested(name, { documentId: 'library' }).disposition).not.toBe('hardware');
    expect(suggested('[LS] Button Head M4x5').disposition).toBe('hardware');
    expect(suggested('8mm REX Ball Bearing', { documentId: 'library' })).toMatchObject({ disposition: 'buy', reviewReason: null });
    expect(suggested('80 Tooth x 9mm HTD5 Belt').disposition).toBe('buy');
    // Print wording still wins over hardware wording (a print stays a question for a person), and a plain plate is 2D cut.
    expect(suggested('Printed bearing holder')).toMatchObject({ disposition: 'review', suggestedDisposition: 'print' });
    expect(suggested('Inner Plate').disposition).toBe('cut-2d');
    // Automatic Buy never prices anything: only an exact or confirmed match with a verified pack does.
    expect(suggested('80 Tooth x 9mm HTD5 Belt').lineTotalUsd).toBeNull();
  });
  it('buys a linked part with a possible vendor match but never prices it, and ignores a name resemblance on a team part', () => {
    const value = line('96mm wheel', { documentId: 'library' });
    value.matchStatus = 'possible'; value.vendor = vendor('3606-0014-0096');
    expect(classify(value)).toMatchObject({ disposition: 'buy', dispositionSource: 'suggestion' });
    expect(classify(value).lineTotalUsd).toBeNull();
    // From the HORS panel: a team's own cart base resembled AndyMark am-5230_base; that is no reason to buy it.
    const teamPart = line('Robot Parts Cart Diamond Plate Base');
    teamPart.matchStatus = 'possible'; teamPart.vendor = vendor('am-5230_base');
    expect(classify(teamPart).disposition).not.toBe('buy');
    // Print wording wins over a loose match on a linked part.
    const printed = line('Printed wheel hub', { documentId: 'library' });
    printed.matchStatus = 'possible'; printed.vendor = vendor('1309-0016-4008');
    expect(classify(printed)).toMatchObject({ disposition: 'review', suggestedDisposition: 'print' });
    // Custom wording in the description keeps a hardware name from being bought.
    const block = line('Bearing block');
    block.description = 'Custom holder for intake';
    expect(classify(block).disposition).not.toBe('buy');
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
