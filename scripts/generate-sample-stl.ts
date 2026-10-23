import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { aggregateAssembly, type AssemblyDefinition } from '../packages/shared/src/index';
import { buildStlZip } from '../apps/worker/src/stl-zip';

const root = process.cwd();
const fixture = JSON.parse(await readFile(resolve(root, 'fixtures/assembly-ftc-robot.json'), 'utf8')) as AssemblyDefinition;
const result = aggregateAssembly(fixture, { documentId: 'robot', workspaceOrVersion: 'w', workspaceOrVersionId: 'fixture', elementId: 'assembly' }, 'FTC Competition Robot');
result.scannedAt = '2026-10-23T12:00:00.000Z';
const guide = result.lines.find(line => /Intake Guide/i.test(line.name));
const motor = result.lines.find(line => /5203 Motor/i.test(line.name));
if (!guide || !motor) throw new Error('Fixture is missing the expected printed sample parts.');
guide.classification = 'printed'; motor.classification = 'printed';
const mockStl = new TextEncoder().encode('solid control_kit_fixture\nendsolid control_kit_fixture\n');
const fetcher = async (path: string) => path.includes(encodeURIComponent(guide.partId!)) && path.includes('/stl?')
  ? new Response(mockStl, { headers: { 'content-type': 'model/stl' } })
  : new Response('fixture translation failure', { status: 404 });
const zip = await buildStlZip(result, 'v9', fetcher, new AbortController().signal, { pollMs: 0, now: new Date('2026-10-23T12:00:00Z') });
const destination = resolve(root, 'samples', zip.filename);
await writeFile(destination, zip.bytes);
console.log(destination);
