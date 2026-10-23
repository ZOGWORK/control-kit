import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { aggregateAssembly, classifyScan, recalculatePurchasing, type AssemblyDefinition, type VendorRecord } from '../packages/shared/src/index';
import { buildExcelWorkbook } from '../packages/excel/src/index';

const root = process.cwd();
const fixture = JSON.parse(await readFile(resolve(root, 'fixtures/assembly-ftc-robot.json'), 'utf8')) as AssemblyDefinition;
const vendors = JSON.parse(await readFile(resolve(root, 'fixtures/vendors/seed.json'), 'utf8')) as VendorRecord[];
const result = aggregateAssembly(fixture, { documentId: 'robot', workspaceOrVersion: 'w', workspaceOrVersionId: 'fixture', elementId: 'assembly' }, 'FTC Competition Robot');
for (const line of result.lines) {
  const vendor = vendors.find(record => line.name === record.name || (line.name === 'Bearing' && record.name === '8mm Bearing'));
  if (vendor) { line.vendor = vendor; line.matchStatus = 'confirmed'; }
  if (vendor?.vendorId === 'rev' && /Wheel/i.test(line.name)) {
    line.vendor = { ...vendor, stock: 'out', stockQty: 0 };
    line.alternatives = [
      { ...vendor, sku: 'REV-31-1240', normalizedSku: '311240', name: '96mm Wheel — alternate hub', priceUsd: 13.25, url: 'https://www.revrobotics.com/REV-31-1240', stock: 'in', stockQty: 8 },
      { ...vendor, sku: 'REV-31-1241', normalizedSku: '311241', name: '96mm Wheel — alternate tread', priceUsd: 14.5, url: 'https://www.revrobotics.com/REV-31-1241', stock: 'in', stockQty: 6 },
    ];
  }
  if (line.name.includes('Screw')) line.partNumber = 'AM-1000';
}
classifyScan(result, { teamNumber: '12345' }, {});
recalculatePurchasing(result);
result.vendorDataUpdatedAt = '2026-10-23T00:00:00Z';
const logo = new Uint8Array(await readFile(resolve(root, 'apps/web/public/control-kit-logo.png')));
const workbook = buildExcelWorkbook(result, new Date('2026-10-23T12:00:00Z'), logo);
const destination = resolve(root, 'samples', workbook.filename);
await writeFile(destination, workbook.bytes);
console.log(destination);
