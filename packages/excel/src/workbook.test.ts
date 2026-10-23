import { describe, expect, it } from 'vitest';
import { strFromU8, unzipSync } from 'fflate';
import { aggregateAssembly, recalculatePurchasing, type VendorRecord } from '../../shared/src/index';
import { buildExcelWorkbook } from './workbook';

const vendor: VendorRecord = { vendorId: 'andymark', sku: 'AM-1000', normalizedSku: '1000', name: 'M3 Screw', normalizedName: 'm3 screw',
  url: 'https://www.andymark.com/products/m3-screw', priceUsd: 8.99, packSize: 10, packSizeVerified: true, stock: 'in', stockQty: 20,
  category: 'hardware', updatedAt: '2026-10-23T00:00:00Z', source: 'feed' };

describe('Excel export', () => {
  it('creates four worksheets and charges verified packs, leaving unverified totals blank', () => {
    const instances = Array.from({ length: 12 }, (_, index) => ({ id: `s${index}`, name: `M3 Screw <${index + 1}>`, type: 'Part', documentId: 'doc', elementId: 'screws', partId: 'screw' }));
    instances.push({ id: 'bearing', name: 'Bearing', type: 'Part', documentId: 'doc', elementId: 'bearings', partId: 'bearing' });
    instances.push({ id: 'motor', name: 'Possible Motor', type: 'Part', documentId: 'doc', elementId: 'motors', partId: 'motor' });
    instances.push({ id: 'print', name: 'Custom Printed Intake Guide', type: 'Part', documentId: 'doc', elementId: 'print', partId: 'print' });
    const result = aggregateAssembly({ rootAssembly: { instances } }, { documentId: 'doc', workspaceOrVersion: 'w', workspaceOrVersionId: 'w1', elementId: 'assembly' }, 'FTC Robot');
    const screw = result.lines.find(line => line.name === 'M3 Screw')!;
    screw.vendor = vendor; screw.matchStatus = 'exact'; screw.classification = 'commercial';
    const bearing = result.lines.find(line => line.name === 'Bearing')!;
    bearing.vendor = { ...vendor, sku: 'AM-2000', normalizedSku: '2000', name: 'Bearing', packSize: null, packSizeVerified: false, stock: 'out' };
    bearing.matchStatus = 'confirmed'; bearing.classification = 'commercial';
    bearing.alternatives = [
      { ...vendor, sku: 'AM-2001', normalizedSku: '2001', name: 'Bearing Option A', category: 'hardware', url: 'https://www.andymark.com/products/bearing-a' },
      { ...vendor, sku: 'AM-2002', normalizedSku: '2002', name: 'Bearing Option B', category: 'hardware', url: 'https://www.andymark.com/products/bearing-b' },
    ];
    const possible = result.lines.find(line => line.name === 'Possible Motor')!;
    possible.vendor = { ...vendor, sku: 'AM-3000', normalizedSku: '3000', name: 'Motor', packSize: 1, packSizeVerified: true };
    possible.matchStatus = 'possible'; possible.classification = 'commercial';
    const printed = result.lines.find(line => line.name.includes('Printed'))!;
    printed.classification = 'printed';
    result.stats.printedLines = 1;
    result.vendorDataUpdatedAt = '2026-10-24T00:00:00Z';
    recalculatePurchasing(result);
    const exportResult = buildExcelWorkbook(result, new Date('2026-10-23T12:00:00Z'));
    expect(exportResult.filename).toBe('FTC_Robot_BOM_2026-10-23.xlsx');
    const zip = unzipSync(exportResult.bytes);
    const workbook = strFromU8(zip['xl/workbook.xml']);
    expect([...workbook.matchAll(/<sheet name="([^"]+)"/g)].map(match => match[1])).toEqual(['BOM', '3D Printed Parts', 'Suppressed Parts', 'Missing Metadata']);
    const sheet = strFromU8(zip['xl/worksheets/sheet1.xml']);
    const styles = strFromU8(zip['xl/styles.xml']);
    expect(styles).toContain('FF13294B');
    expect(styles).toContain('FF1F7A3A');
    expect(sheet).toContain('<pane ySplit="6"');
    expect(sheet).toContain('Vendor data as of: 2026-10-24T00:00:00Z');
    expect(sheet).toContain('<autoFilter ref="A6:M9"');
    expect(sheet).toContain('<c r="A6" s="6"');
    expect(sheet).toMatch(/<c r="I\d+" s="9" t="inlineStr"><is><t xml:space="preserve">In Stock<\/t><\/is><\/c>/);
    expect(sheet).toContain('<f>SUM(H7:H');
    expect(sheet).toMatch(/<c r="D\d+"[^>]*><v>2<\/v><\/c>/);
    expect(sheet).toMatch(/<c r="H\d+"[^>]*><f>D\d+\*G\d+<\/f><v>17\.98<\/v><\/c>/);
    expect((sheet.match(/<f>D\d+\*G\d+<\/f>/g) ?? [])).toHaveLength(1);
    expect(sheet).toContain('<c r="G9" s="14"><v>8.99</v></c>');
    expect(sheet).not.toContain('<c r="H9"');
    expect(sheet).toContain('<c r="F4" s="22"><f>SUM(H7:H');
    expect(sheet).toContain('<v>17.98</v></c>');
    expect(sheet).not.toContain('<mergeCell ref="E4:F4"');
    expect(sheet).toContain('— 3D PRINTED PARTS —');
    expect(sheet).toContain('— IN-STOCK ALTERNATIVES —');
    const links = strFromU8(zip['xl/worksheets/_rels/sheet1.xml.rels']);
    expect(links).toContain('https://www.andymark.com/products/bearing-a');
    expect(links).toContain('https://www.andymark.com/products/bearing-b');
    expect(strFromU8(zip['xl/worksheets/sheet2.xml'])).toContain('Custom Printed Intake Guide');
  });
});
