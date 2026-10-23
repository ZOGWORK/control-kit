import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { strFromU8, unzipSync } from 'fflate';
import { aggregateAssembly, type AssemblyDefinition } from '@control-kit/shared';
import { buildStlZip } from './stl-zip';

const fixture = JSON.parse(readFileSync(new URL('../../../fixtures/assembly-ftc-robot.json', import.meta.url), 'utf8')) as AssemblyDefinition;
const context = { documentId: 'robot', workspaceOrVersion: 'w' as const, workspaceOrVersionId: 'work1', elementId: 'assembly' };
const stl = new TextEncoder().encode('solid mock\nendsolid mock\n');

describe('STL zip from fixture B', () => {
  it('puts successful parts in category folders and failed parts in README without failing the zip', async () => {
    const result = aggregateAssembly(fixture, context, 'FTC Competition Robot');
    const guide = result.lines.find(line => /Intake Guide/i.test(line.name))!;
    const motor = result.lines.find(line => /5203 Motor/i.test(line.name))!;
    expect(guide).toBeDefined(); expect(motor).toBeDefined();
    guide.classification = 'printed'; motor.classification = 'printed';
    const calls: string[] = [];
    const fetcher = async (path: string) => {
      calls.push(path);
      if (path.includes(encodeURIComponent(guide.partId!)) && path.includes('/stl?')) return new Response(stl);
      return new Response('unavailable', { status: 404 });
    };
    const zip = await buildStlZip(result, 'v9', fetcher, new AbortController().signal, { pollMs: 0 });
    const files = unzipSync(zip.bytes);
    const names = Object.keys(files);
    expect(names.some(name => name.startsWith('FTC_Competition_Robot_prints/intake/custom_printed_intake_guide__') && name.endsWith('.stl'))).toBe(true);
    expect(names).toContain('FTC_Competition_Robot_prints/README.txt');
    const readme = strFromU8(files['FTC_Competition_Robot_prints/README.txt']);
    expect(readme).toContain(guide.partStudioUrl);
    expect(readme).toContain('5203 Motor: STL translation request failed (HTTP 404)');
    expect(zip.failures).toHaveLength(1);
    expect(calls.some(path => path.includes('/partstudios/') && path.includes('/translations'))).toBe(true);
  });
  it('falls back to translation and downloads its external STL data', async () => {
    const result = aggregateAssembly(fixture, context, 'FTC Competition Robot');
    const guide = result.lines.find(line => /Intake Guide/i.test(line.name))!;
    guide.classification = 'printed';
    const fetcher = async (path: string) => {
      if (path.includes('/stl?')) return new Response('unsupported', { status: 404 });
      if (path.endsWith('/translations') && path.includes('/partstudios/')) return Response.json({ id: 'translation-1' });
      if (path.endsWith('/translations/translation-1')) return Response.json({ requestState: 'DONE', resultExternalDataIds: ['file-1'] });
      if (path.endsWith('/externaldata/file-1')) return new Response(stl);
      return new Response('unexpected', { status: 500 });
    };
    const zip = await buildStlZip(result, 'v9', fetcher, new AbortController().signal, { pollMs: 0 });
    expect(zip.failures).toHaveLength(0);
    expect(Object.keys(unzipSync(zip.bytes))).toHaveLength(2);
  });
  it('limits active STL exports to three and times out a stalled part without aborting the zip', async () => {
    const result = aggregateAssembly(fixture, context, 'FTC Competition Robot');
    for (const line of result.lines) line.classification = 'printed';
    let active = 0; let peak = 0;
    const fetcher = async (path: string, init: RequestInit) => {
      active++; peak = Math.max(peak, active);
      try {
        if (path.includes('/partid/motor-5203/')) await new Promise<void>((_, reject) => init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true }));
        else await new Promise(resolve => setTimeout(resolve, 2));
        return new Response(stl);
      } finally { active--; }
    };
    const zip = await buildStlZip(result, 'v9', fetcher, new AbortController().signal, { timeoutMs: 20 });
    expect(peak).toBeLessThanOrEqual(3);
    expect(zip.failures).toEqual(expect.arrayContaining([expect.objectContaining({ name: expect.stringContaining('5203 Motor'), reason: 'STL export timed out' })]));
    expect(Object.keys(unzipSync(zip.bytes)).length).toBeGreaterThan(1);
  });
});
