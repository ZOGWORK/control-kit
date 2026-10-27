import { describe, expect, it } from 'vitest';
import { strFromU8, unzipSync } from 'fflate';
import { readFileSync } from 'node:fs';
import { aggregateAssembly, classifyScan, recalculatePurchasing, type ScanResult, type VendorRecord } from '../../shared/src/index';
import { buildBomCsv, buildExcelWorkbook, CSV_HEADERS } from './workbook';

const vendor: VendorRecord = { vendorId: 'gobilda', sku: '2802-0004-0010', normalizedSku: '2802000400010', name: 'M4 Screw (10 pack)', normalizedName: 'm4 screw',
  url: 'https://www.gobilda.com/2802-series-m4-screw/', priceUsd: 8.99, packSize: 10, packSizeVerified: true, stock: 'in', stockQty: 20,
  category: 'hardware', updatedAt: '2026-10-23T00:00:00Z', source: 'sitemap' };

/** 12 screws in a verified 10-pack, a bearing with no verified pack, a possible motor match, a print, a review part, and a suppressed spare. */
function robot(): ScanResult {
  const part = (name: string, partId: string, count = 1, suppressed = false) => Array.from({ length: count }, (_, index) => ({ id: `${partId}${index}`, name, type: 'Part', documentId: 'doc', elementId: partId, partId, suppressed }));
  const result = aggregateAssembly({ rootAssembly: { instances: [
    ...part('M4 Screw', 'screw', 12), ...part('Bearing', 'bearing', 2), ...part('Drive Motor', 'motor'), ...part('Intake Guide [3DP]', 'guide'),
    ...part('Mystery Bracket', 'bracket'), ...part('Spare Plate', 'spare', 1, true),
  ] } }, { documentId: 'doc', workspaceOrVersion: 'w', workspaceOrVersionId: 'w1', elementId: 'assembly' }, 'FTC Robot');
  const find = (partId: string) => result.lines.find(line => line.partId === partId)!;
  Object.assign(find('screw'), { vendor, matchStatus: 'exact' });
  Object.assign(find('bearing'), { vendor: { ...vendor, sku: '1611-0019-0006', name: 'Bearing', url: 'https://www.gobilda.com/bearing/', packSize: null, packSizeVerified: false, stock: 'out' }, matchStatus: 'exact' });
  Object.assign(find('motor'), { vendor: { ...vendor, vendorId: 'rev', sku: 'REV-41-1291', name: 'HD Hex Motor', url: 'https://www.revrobotics.com/rev-41-1291/', packSize: 1 }, matchStatus: 'possible' });
  const classified = classifyScan(result, { teamNumber: null }, { [find('motor').bomLineKey]: 'buy' });
  classified.scannedAt = '2026-10-24T08:00:00Z';
  classified.catalogHealth = { checkedAt: '2026-10-24T08:00:00Z', vendors: (['gobilda', 'servocity', 'andymark', 'rev', 'pitsco'] as const).map(vendorId => ({ vendorId, state: 'published', complete: true,
    recordCount: 100, updatedAt: '2026-10-23T00:00:00Z', lastRunAt: null, stale: vendorId === 'pitsco', lastRunFailed: false, error: null, skipped: {}, progress: null })) };
  return recalculatePurchasing(classified);
}
const sheetNames = (zip: Record<string, Uint8Array>) => [...strFromU8(zip['xl/workbook.xml']).matchAll(/<sheet name="([^"]+)"/g)].map(match => match[1]);
const text = (zip: Record<string, Uint8Array>, index: number) => strFromU8(zip[`xl/worksheets/sheet${index}.xml`]);
const links = (zip: Record<string, Uint8Array>, index: number) => strFromU8(zip[`xl/worksheets/_rels/sheet${index}.xml.rels`] ?? new Uint8Array());
/** The text of the row whose column B (or C on Exceptions) holds `name`. */
const row = (xml: string, name: string) => xml.match(new RegExp(`<row r="\\d+">(?:(?!</row>).)*${name}(?:(?!</row>).)*</row>`))?.[0] ?? '';

describe('REV prices from the official feed', () => {
  it("shows the feed's update time beside each REV price and stock, in the workbook and the CSV", () => {
    const result = robot();
    const hub: VendorRecord = { vendorId: 'rev', sku: 'REV-31-1595', normalizedSku: '311595', name: 'Control Hub', normalizedName: 'control hub', url: 'https://www.revrobotics.com/rev-31-1595/', priceUsd: 375,
      packSize: 1, packSizeVerified: true, packEvidence: 'sold individually', stock: 'out', stockQty: null, category: 'uncategorized', updatedAt: '2026-10-26T05:00:29.000Z', source: 'feed', parser: 'official-feed' };
    Object.assign(result.lines.find(line => line.partId === 'motor')!, { vendor: hub, matchStatus: 'exact' });
    const priced = recalculatePurchasing(result);
    const buy = strFromU8(unzipSync(buildExcelWorkbook(priced, new Date('2026-10-26T12:00:00Z')).bytes)['xl/worksheets/sheet2.xml']);
    const line = row(buy, 'Drive Motor');
    expect(line).toContain('REV feed updated 2026-10-26 05:00 UTC');
    expect(line).toMatch(/<c r="H\d+" s="\d+"><v>375<\/v><\/c>/);
    expect(row(buy, 'M4 Screw')).toContain('2026-10-23');
    const csv = strFromU8(buildBomCsv(priced, new Date('2026-10-26T12:00:00Z')).bytes).split('\r\n');
    expect(csv.find(text => text.includes('"Drive Motor"'))).toMatch(/,375\.00,375\.00,"Out of stock, 2026-10-26","REV feed updated 2026-10-26 05:00 UTC","Exact SKU","https:\/\/www\.revrobotics\.com\/rev-31-1595\/"/);
  });
});

describe('Excel export', () => {
  const result = robot();
  const logo = new Uint8Array(readFileSync('apps/web/public/control-kit-logo.png'));
  const zip = unzipSync(buildExcelWorkbook(result, new Date('2026-10-24T12:00:00Z'), logo).bytes);

  it('has the sheets in the order a team works, with the logo on the overview', () => {
    expect(sheetNames(zip)).toEqual(['Overview', 'Buy list', 'Make', 'Review', 'Links', 'Exceptions']);
    expect(zip['xl/media/control-kit-logo.png']).toEqual(logo);
    expect(text(zip, 1)).toContain('<drawing r:id="rId');
    expect(strFromU8(zip['xl/styles.xml'])).toContain('FFFFC700');
    // The first test also pays for building the workbook (about 4 s on a busy machine), past vitest's 5 s default.
  }, 20_000);

  it('charges 12 screws in a verified 10-pack at $8.99 as 2 packs with a live $17.98 formula', () => {
    const buy = text(zip, 2);
    const screw = row(buy, 'M4 Screw');
    const number = screw.match(/<row r="(\d+)"/)![1];
    expect(screw).toMatch(new RegExp(`<c r="D${number}" s="\\d+"><v>10</v></c>`));
    expect(screw).toMatch(new RegExp(`<c r="E${number}" s="\\d+"><v>2</v></c>`));
    expect(screw).toMatch(new RegExp(`<c r="I${number}" s="\\d+"><f>E${number}\\*H${number}</f><v>17.98</v></c>`));
    expect((buy.match(/<f>E\d+\*H\d+<\/f>/g) ?? [])).toHaveLength(1);
  });

  it('links the part name to its product page and the Onshape column to its Part Studio', () => {
    const screw = row(text(zip, 2), 'M4 Screw');
    expect(screw).toMatch(/<c r="B\d+" s="1[78]" t="inlineStr"><is><t xml:space="preserve">M4 Screw<\/t>/);
    expect(links(zip, 2)).toContain('https://www.gobilda.com/2802-series-m4-screw/');
    expect(screw).toContain('Open Part Studio');
    expect(text(zip, 2)).not.toContain('Product page');
  });

  it('leaves unverified and possible lines financially blank but visible', () => {
    const buy = text(zip, 2);
    const bearing = row(buy, '>Bearing<');
    expect(bearing).not.toMatch(/<c r="[DEI]\d+" s="\d+"><v>/);
    expect(bearing).toContain('Pack size not verified, so no total');
    const motor = row(buy, 'Drive Motor');
    expect(motor).toContain('Possible match REV REV-41-1291');
    expect(motor).not.toContain('<f>');
    expect(motor).not.toContain('8.99');
  });

  it('keeps row 4 labels and values in separate cells, with the subtotal a live formula in its own cell', () => {
    const buy = text(zip, 2);
    expect(buy).toMatch(/<c r="H4" s="20" t="inlineStr"><is><t xml:space="preserve">Known subtotal<\/t>/);
    expect(buy).toMatch(/<c r="I4" s="22"><f>IF\(COUNT\(I7:I\d+\),SUM\(I7:I\d+\),&quot;None priced&quot;\)<\/f><v>17.98<\/v><\/c>/);
    expect(buy).not.toMatch(/<mergeCell ref="[A-Z]+4:/);
    expect(buy).toContain('A blank Line Total is unknown, not zero');
    expect(text(zip, 1)).toMatch(/<c r="J4" s="22"><f>IF\(COUNT\(&apos;Buy list&apos;!I7:I\d+\),SUM\(&apos;Buy list&apos;!I7:I\d+\),&quot;None priced&quot;\)<\/f><v>17.98<\/v><\/c>/);
    expect(buy).toContain('<pane ySplit="6"');
    expect(buy).toMatch(/<autoFilter ref="A6:N\d+"/);
  });

  it('links every part to its vendor product and to Onshape on the Links sheet', () => {
    expect(sheetNames(zip)[4]).toBe('Links');
    const sheet = text(zip, 5);
    for (const name of ['M4 Screw', 'Bearing', 'Drive Motor', 'Intake Guide', 'Mystery Bracket']) expect(row(sheet, name)).toContain('Open Part Studio');
    expect(row(sheet, 'M4 Screw')).toContain('goBILDA 2802-0004-0010');
    expect(row(sheet, 'Drive Motor')).toContain('Possible, not confirmed');
    const targets = links(zip, 5);
    expect(targets).toContain('https://www.gobilda.com/2802-series-m4-screw/');
    expect(targets).toContain('https://www.revrobotics.com/rev-41-1291/');
    expect(targets.match(/https:\/\/cad\.onshape\.com\/documents\/doc\/w\/w1\/e\//g)?.length).toBe(result.lines.length);
  });

  it('names each STEP file as the export does, lists review parts, and reports exceptions', () => {
    expect(row(text(zip, 3), 'Intake Guide')).toMatch(/Intake_Guide_3DP__guide\.step/);
    expect(row(text(zip, 4), 'Mystery Bracket')).toContain('Open Part Studio');
    const exceptions = text(zip, 6);
    expect(row(exceptions, 'Bearing')).toContain('Out of stock');
    expect(row(exceptions, 'Spare Plate')).toContain('Suppressed');
    expect(text(zip, 1)).toContain('Out of date');
  });

  it('shows "None priced" rather than $0.00 when no line has a total', () => {
    const unpriced = robot();
    for (const line of unpriced.lines) Object.assign(line, { vendor: null, matchStatus: 'unmatched', packsToOrder: null, lineTotalUsd: null });
    const buy = text(unzipSync(buildExcelWorkbook(unpriced, new Date('2026-10-24T12:00:00Z')).bytes), 2);
    expect(buy).toMatch(/<c r="I4" s="22"><f>IF\(COUNT[^<]*<\/f><\/c>/);
  });

  it('builds without the logo', () => {
    const plain = unzipSync(buildExcelWorkbook(result, new Date('2026-10-24T12:00:00Z')).bytes);
    expect(plain['xl/media/control-kit-logo.png']).toBeUndefined();
    expect(text(plain, 1)).not.toContain('<drawing');
  });

  it('writes a CSV fallback with the same purchasing rules', () => {
    const csv = buildBomCsv(result, new Date('2026-10-24T12:00:00Z'));
    expect(csv.filename).toBe('FTC_Robot_BOM_2026-10-24.csv');
    const lines = new TextDecoder().decode(csv.bytes).replace(/^\uFEFF/, '').trim().split('\r\n');
    expect(lines[0]).toBe(CSV_HEADERS.map(name => `"${name}"`).join(','));
    expect(lines.find(line => line.includes('"M4 Screw"'))).toMatch(/"Buy",10,2,"goBILDA","2802-0004-0010",8\.99,17\.98,/);
    expect(lines.find(line => line.includes('"Drive Motor"'))).toMatch(/"Buy",,,"","",,,/);
    expect(lines.find(line => line.includes('"Bearing"'))).toMatch(/"Buy",,,"goBILDA","1611-0019-0006",8\.99,,/);
  });

  it('never charges a matched part the team chose to make', () => {
    const changed = robot();
    const screw = changed.lines.find(line => line.partId === 'screw')!;
    Object.assign(screw, { disposition: 'print', manualClassification: 'print' });
    const row = new TextDecoder().decode(buildBomCsv(changed).bytes).split('\r\n').find(line => line.includes('"M4 Screw"'))!;
    expect(row).toMatch(/"3D print",,,"goBILDA","2802-0004-0010",,,/);
    expect(row).not.toContain('17.98');
  });

  it('lists stock fasteners on the Buy list without counting them as purchases', () => {
    const withFasteners = robot();
    const template = withFasteners.lines.find(line => line.partId === 'bracket')!;
    withFasteners.lines.push(...Array.from({ length: 3 }, (_, n) => ({ ...template, bomLineKey: `f${n}`, partId: `f${n}`, name: `M3 Screw ${n}`, disposition: 'hardware' as const })));
    const zipped = unzipSync(buildExcelWorkbook(withFasteners, new Date('2026-10-24T12:00:00Z')).bytes);
    const buy = text(zipped, 2);
    expect(buy).toContain('M3 Screw 0');
    const purchases = withFasteners.lines.filter(line => line.disposition === 'buy').length;
    expect(buy).toContain(`<c r="C4" s="21"><v>${purchases}</v></c>`);
    expect(text(zipped, 1)).toContain(`1 of ${purchases} parts to buy are priced`);
  });

  it('writes Onshape part names as inert CSV text', () => {
    const hostile = aggregateAssembly({ rootAssembly: { instances: [
      { id: 'bad', name: '=HYPERLINK("https://example.com","Open part")', type: 'Part', documentId: 'doc', elementId: 'parts', partId: 'bad' },
    ] } }, { documentId: 'doc', workspaceOrVersion: 'w', workspaceOrVersionId: 'work', elementId: 'assembly' }, 'Robot');
    const csv = new TextDecoder().decode(buildBomCsv(hostile).bytes);
    expect(csv).toContain('"\'=HYPERLINK(""https://example.com"",""Open part"")"');
    expect(csv).not.toContain(',"=HYPERLINK');
  });

  it('handles a HORS-sized scan', () => {
    const big = robot();
    const template = big.lines[0];
    big.lines = Array.from({ length: 400 }, (_, index) => ({ ...template, bomLineKey: `k${index}`, name: `Part ${index}`, partId: `p${index}` }));
    const sheets = unzipSync(buildExcelWorkbook(big, new Date('2026-10-24T12:00:00Z')).bytes);
    expect(text(sheets, 2)).toContain('SUM(I7:I406)');
    expect((text(sheets, 2).match(/<f>E\d+\*H\d+<\/f>/g) ?? [])).toHaveLength(400);
  });
});
