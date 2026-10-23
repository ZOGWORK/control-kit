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
  if (line.name.includes('Screw')) line.partNumber = 'AM-1000';
}
classifyScan(result, { teamNumber: '12345' }, {});
recalculatePurchasing(result);
result.vendorDataUpdatedAt = '2026-10-23T00:00:00Z';
const workbook = buildExcelWorkbook(result, new Date('2026-10-23T12:00:00Z'));
const destination = resolve(root, 'fixtures', workbook.filename);
await writeFile(destination, workbook.bytes);
console.log(destination);
