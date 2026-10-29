import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { aggregateAssembly, classifyScan, drawFlatPart, mergeBom, withDrawnDxf, type AssemblyDefinition } from '../packages/shared/src/index';
import { buildStepZip } from '../packages/excel/src/step-zip';
import { createMockOnshape, mockBom } from '../apps/worker/src/mock-onshape';
import { advanceExport, budgeted, createExportJob, dxfKey, fileKey } from '../apps/worker/src/step-export';

// Runs the real export job against mock Onshape: the intake guide succeeds, the motor fails deliberately, and the
// wheel, set to 2D cut here, gets its STEP and a DXF of the mock plate's flat face.
const root = process.cwd();
const fixture = JSON.parse(await readFile(resolve(root, 'fixtures/assembly-ftc-robot.json'), 'utf8')) as AssemblyDefinition;
const result = aggregateAssembly(fixture, { documentId: 'robot', workspaceOrVersion: 'w', workspaceOrVersionId: 'work1', elementId: 'assembly' }, 'FTC Competition Robot');
mergeBom(result, mockBom(fixture as Parameters<typeof mockBom>[0]));
result.scannedAt = '2026-10-23T12:00:00.000Z';
result.scanId = '00000000-0000-4000-8000-000000000000';
result.diagnostics = { onshapeRequests: null, metadataIssues: [], revision: { type: 'm', id: 'fixture-microversion' } };
const motor = result.lines.find(line => line.partId === 'motor-5203')!;
const wheel = result.lines.find(line => line.partId === 'wheel-96')!;
classifyScan(result, { teamNumber: null }, { [motor.bomLineKey]: 'print', [wheel.bomLineKey]: 'cut-2d' });
const mock = createMockOnshape();
const store = new Map<string, string>();
const kv = { get: async (key: string) => store.get(key) ?? null, put: async (key: string, value: string) => { store.set(key, value); }, delete: async (key: string) => { store.delete(key); } };
const job = createExportJob(result, '11111111-1111-4111-8111-111111111111', new Date('2026-10-23T12:00:00Z'));
for (let round = 0; round < 10 && !job.parts.every(part => (part.state === 'ready' || part.state === 'failed') && part.dxf?.state !== 'pending'); round++) {
  const budget = { remaining: 30 };
  await advanceExport(job, 'sample', kv, budgeted((path, init) => mock.handle(new Request(`http://localhost:8788${path}`, init)), budget), 'v9', budget);
}
const files = Object.fromEntries(job.parts.flatMap((part, index) => part.state === 'ready' ? [[index, store.get(fileKey('sample', job.jobId, index))!]] : []));
// The browser's step: draw each 2D-cut part's DXF from the geometry the job stored.
const dxfFiles: Record<number, string> = {};
job.parts.forEach((part, index) => {
  if (part.dxf?.state !== 'ready') return;
  const edges = store.get(dxfKey('sample', job.jobId, index, 'edges'));
  const drawn = drawFlatPart(JSON.parse(store.get(dxfKey('sample', job.jobId, index, 'body'))!), edges ? JSON.parse(edges) : null, part.partId);
  job.parts[index] = withDrawnDxf(part, drawn);
  if (drawn.ok) dxfFiles[index] = drawn.text;
});
const zip = buildStepZip({ ...job, parts: job.parts, files, dxfFiles, now: new Date('2026-10-23T12:00:00Z') });
const destination = resolve(root, 'samples', zip.filename);
await writeFile(destination, zip.bytes);
console.log(`${destination} (${zip.ready} STEP files, ${zip.dxf} DXF, ${zip.failed} failure)`);
