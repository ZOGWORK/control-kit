import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { aggregateAssembly, classifyScan, mergeBom, type AssemblyDefinition } from '../packages/shared/src/index';
import { buildStepZip } from '../packages/excel/src/step-zip';
import { createMockOnshape, mockBom } from '../apps/worker/src/mock-onshape';
import { advanceExport, createExportJob, fileKey } from '../apps/worker/src/step-export';

// Runs the real export job against mock Onshape: the intake guide succeeds, the motor fails deliberately.
const root = process.cwd();
const fixture = JSON.parse(await readFile(resolve(root, 'fixtures/assembly-ftc-robot.json'), 'utf8')) as AssemblyDefinition;
const result = aggregateAssembly(fixture, { documentId: 'robot', workspaceOrVersion: 'w', workspaceOrVersionId: 'work1', elementId: 'assembly' }, 'FTC Competition Robot');
mergeBom(result, mockBom(fixture as Parameters<typeof mockBom>[0]));
result.scannedAt = '2026-10-23T12:00:00.000Z';
result.scanId = '00000000-0000-4000-8000-000000000000';
result.diagnostics = { onshapeRequests: null, metadataIssues: [], revision: { type: 'm', id: 'fixture-microversion' } };
const motor = result.lines.find(line => line.partId === 'motor-5203')!;
classifyScan(result, { teamNumber: null }, { [motor.bomLineKey]: 'print' });
const mock = createMockOnshape();
const store = new Map<string, string>();
const kv = { get: async (key: string) => store.get(key) ?? null, put: async (key: string, value: string) => { store.set(key, value); }, delete: async (key: string) => { store.delete(key); } };
const job = createExportJob(result, '11111111-1111-4111-8111-111111111111', new Date('2026-10-23T12:00:00Z'));
for (let round = 0; round < 10 && !job.parts.every(part => part.state === 'ready' || part.state === 'failed'); round++)
  await advanceExport(job, 'sample', kv, (path, init) => mock.handle(new Request(`http://localhost:8788${path}`, init)), 'v9');
const files = Object.fromEntries(job.parts.flatMap((part, index) => part.state === 'ready' ? [[index, store.get(fileKey('sample', job.jobId, index))!]] : []));
const zip = buildStepZip({ ...job, parts: job.parts, files, now: new Date('2026-10-23T12:00:00Z') });
const destination = resolve(root, 'samples', zip.filename);
await writeFile(destination, zip.bytes);
console.log(`${destination} (${zip.ready} file, ${zip.failed} failure)`);
