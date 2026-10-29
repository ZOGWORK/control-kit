import { describe, expect, it } from 'vitest';
import { aggregateAssembly, checkStep, classifyScan, drawFlatPart, withDrawnDxf, type AssemblyInstance } from '@control-kit/shared';
import { mockPlateBody, mockPlateEdges, mockStep } from './mock-onshape';
import { advanceExport, budgeted, BudgetExhaustedError, createExportJob, dxfKey, jobSummary, type RequestBudget } from './step-export';
import type { Kv } from './index';

const kv = (): Kv => { const values = new Map<string, string>(); return { get: async key => values.get(key) ?? null, put: async (key, value) => { values.set(key, value); }, delete: async key => { values.delete(key); } }; };
/** A scan with `count` printed parts in the assembly's own document, so every part has an export source. */
function job(count: number, name = (n: number) => `Bracket ${n} [3DP]`) {
  const instances: AssemblyInstance[] = Array.from({ length: count }, (_, n) => ({ id: `i${n}`, name: name(n), type: 'Part', documentId: 'doc', elementId: 'studio', partId: `p${n}` }));
  const result = aggregateAssembly({ rootAssembly: { instances } }, { documentId: 'doc', workspaceOrVersion: 'w', workspaceOrVersionId: 'work', elementId: 'asm' }, 'Robot');
  classifyScan(result, { teamNumber: null }, {});
  result.scanId = '00000000-0000-4000-8000-000000000000';
  return createExportJob(result, '11111111-1111-4111-8111-111111111111');
}
/** Onshape stand-in: translations stay ACTIVE until `finish` lists them, then DONE with a valid STEP file. */
function onshape(finish: Set<string> = new Set()) {
  const calls: string[] = [];
  const fetcher = async (path: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? 'GET'} ${path}`);
    if (init?.method === 'POST') return Response.json({ id: `tr-${(JSON.parse(String(init.body)) as { partIds: string }).partIds}`, requestState: 'ACTIVE' });
    const translation = path.match(/translations\/tr-(\w+)$/);
    if (translation) return Response.json(finish.has(translation[1]) ? { requestState: 'DONE', resultExternalDataIds: [`x-${translation[1]}`] } : { requestState: 'ACTIVE' });
    return new Response(mockStep(`Bracket ${path.match(/x-p(\d+)$/)![1]} [3DP]`));
  };
  return { fetcher, calls };
}

describe('STEP export job scheduling', () => {
  it('starts every queued part before re-polling, and rotates polls so no part waits behind the same ones', async () => {
    const work = job(40);
    const { fetcher, calls } = onshape();
    let budget: RequestBudget = { remaining: 30 };
    await advanceExport(work, 'u', kv(), budgeted(fetcher, budget), 'v9', budget);
    expect(work.parts.filter(part => part.state === 'translating')).toHaveLength(30);
    budget = { remaining: 30 };
    calls.length = 0;
    await advanceExport(work, 'u', kv(), budgeted(fetcher, budget), 'v9', budget);
    // The 10 still queued start first; the remaining 20 requests poll running parts.
    expect(calls.slice(0, 10).every(call => call.startsWith('POST'))).toBe(true);
    expect(work.parts.every(part => part.state === 'translating')).toBe(true);
    const firstPolls = calls.slice(10).map(call => call.split('tr-')[1]);
    budget = { remaining: 30 };
    calls.length = 0;
    await advanceExport(work, 'u', kv(), budgeted(fetcher, budget), 'v9', budget);
    const secondPolls = calls.map(call => call.split('tr-')[1]);
    // The next poll begins where the previous one stopped.
    expect(secondPolls[0]).not.toBe(firstPolls[0]);
    expect(new Set([...firstPolls, ...secondPolls]).size).toBe(40);
  });
  it('spends the budget on every request sent, retries included, and leaves unfinished parts for the next poll', async () => {
    const work = job(5);
    let sent = 0;
    const budget: RequestBudget = { remaining: 3 };
    // A fetcher that retries 429 internally, as the Worker's does: each attempt spends the shared budget.
    const send = budgeted(async () => { sent++; return new Response(null, { status: 429 }); }, budget);
    const retrying = async (path: string, init?: RequestInit) => { let response = await send(path, init); while (response.status === 429) response = await send(path, init); return response; };
    await advanceExport(work, 'u', kv(), retrying, 'v9', budget);
    expect(sent).toBe(3);
    expect(work.parts.every(part => part.state === 'pending')).toBe(true);
    await expect(budgeted(async () => new Response(), { remaining: 0 })('/x')).rejects.toThrow(BudgetExhaustedError);
  });
  it('keeps parts pending when Onshape keeps rate-limiting, and ends the poll early', async () => {
    const work = job(3);
    let sent = 0;
    const budget: RequestBudget = { remaining: 12 };
    await advanceExport(work, 'u', kv(), budgeted(async () => { sent++; return new Response(null, { status: 429 }); }, budget), 'v9', budget);
    expect(sent).toBe(1);
    expect(work.parts.every(part => part.state === 'pending' && part.error === null)).toBe(true);
  });
  it('downloads a finished translation after the deadline when a rate limit delayed its download', async () => {
    const work = job(1);
    let clock = 0;
    let limited = true;
    const fetcher = async (path: string, init?: RequestInit) => {
      if (init?.method === 'POST') return Response.json({ id: 'tr-p0', requestState: 'ACTIVE' });
      if (path.includes('/translations/')) return Response.json({ requestState: 'DONE', resultExternalDataIds: ['x-p0'] });
      return limited ? new Response(null, { status: 429 }) : new Response(mockStep('Bracket 0 [3DP]'));
    };
    const poll = async () => { const budget = { remaining: 12 }; await advanceExport(work, 'u', kv(), budgeted(fetcher, budget), 'v9', budget, () => clock); };
    await poll();
    await poll();
    expect(work.parts[0]).toMatchObject({ state: 'translating', externalDataId: 'x-p0' });
    expect(work.rateLimitedAt).toBe(0);
    clock = 10 * 60000;
    limited = false;
    await poll();
    expect(work.parts[0].state).toBe('ready');
  });
  it('finishes a part once its translation is done and checks the file', async () => {
    const work = job(2);
    const { fetcher } = onshape(new Set(['p0']));
    const store = kv();
    for (let poll = 0; poll < 2; poll++) { const budget = { remaining: 30 }; await advanceExport(work, 'u', store, budgeted(fetcher, budget), 'v9', budget); }
    expect(work.parts.map(part => part.state)).toEqual(['ready', 'translating']);
    expect(work.parts[0]).toMatchObject({ units: 'mm', nameMatches: true });
  });
});

/** Onshape stand-in for 2D-cut parts: STEP finishes on its first poll; body details describe the mock plate. */
function cutting(options: { curved?: boolean; refuse?: boolean } = {}) {
  const calls: string[] = [];
  const fetcher = async (path: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? 'GET'} ${path}`);
    if (init?.method === 'POST') return Response.json({ id: `tr-${(JSON.parse(String(init.body)) as { partIds: string }).partIds}`, requestState: 'ACTIVE' });
    if (path.includes('/bodydetails')) return options.refuse ? new Response(null, { status: 404 }) : Response.json(mockPlateBody(path.match(/partid\/(\w+)/)![1], options.curved));
    if (path.includes('/tessellatededges')) return Response.json(mockPlateEdges(['e4']));
    const translation = path.match(/translations\/tr-(\w+)$/);
    if (translation) return Response.json({ requestState: 'DONE', resultExternalDataIds: [`x-${translation[1]}`] });
    return new Response(mockStep(`Side Plate ${path.match(/x-p(\d+)$/)![1]}`));
  };
  return { fetcher, calls };
}
const plates = (count: number) => job(count, n => `Side Plate ${n}`);

describe('DXF for 2D-cut parts', () => {
  it('stores the body details of each flat part beside its STEP from one request, for the browser to draw', async () => {
    const work = plates(1);
    expect(work.parts[0]).toMatchObject({ disposition: 'cut-2d', fileName: 'Side_Plate_0__p0.step', dxf: { fileName: 'Side_Plate_0__p0.dxf', state: 'pending' } });
    const store = kv();
    const { fetcher, calls } = cutting();
    for (let poll = 0; poll < 2; poll++) { const budget = { remaining: 12 }; await advanceExport(work, 'u', store, budgeted(fetcher, budget), 'v9', budget); }
    expect(work.parts[0]).toMatchObject({ state: 'ready', dxf: { state: 'ready', error: null, edges: false } });
    expect(calls.filter(call => call.includes('/bodydetails'))).toEqual(['GET /api/v9/parts/d/doc/w/work/e/studio/partid/p0/bodydetails?includeGeometricData=true']);
    expect(calls.some(call => call.includes('tessellatededges'))).toBe(false);
    expect(await store.get(dxfKey('u', work.jobId, 0, 'edges'))).toBeNull();
    expect(jobSummary(work)).toMatchObject({ done: true, parts: [{ dxf: { state: 'ready' } }] });
    // The browser's step: draw the DXF and fill in its sizes.
    const drawn = drawFlatPart(JSON.parse((await store.get(dxfKey('u', work.jobId, 0, 'body')))!), null, 'p0');
    expect(drawn.ok && drawn.text.startsWith('0\nSECTION')).toBe(true);
    expect(withDrawnDxf(work.parts[0], drawn).dxf).toMatchObject({ state: 'ready', widthMm: 100, heightMm: 60, thicknessMm: 3 });
    expect(withDrawnDxf(work.parts[0], null).dxf).toMatchObject({ state: 'failed', error: 'DXF was not downloaded' });
  });
  it('reads tessellated edges only when the part has a curve that is not an arc, at the part configuration', async () => {
    const work = plates(1);
    work.parts[0].configuration = 'Length=200 mm';
    const store = kv();
    const { fetcher, calls } = cutting({ curved: true });
    const budget = { remaining: 12 };
    await advanceExport(work, 'u', store, budgeted(fetcher, budget), 'v9', budget);
    expect(calls.filter(call => call.startsWith('GET /api/v9/parts/'))).toEqual([
      'GET /api/v9/parts/d/doc/w/work/e/studio/partid/p0/bodydetails?configuration=Length%3D200%20mm&includeGeometricData=true',
      'GET /api/v9/parts/d/doc/w/work/e/studio/partid/p0/tessellatededges?configuration=Length%3D200%20mm']);
    expect(work.parts[0].dxf).toMatchObject({ state: 'ready', edges: true });
    const read = async (kind: 'body' | 'edges') => JSON.parse((await store.get(dxfKey('u', work.jobId, 0, kind)))!);
    expect(drawFlatPart(await read('body'), await read('edges'), 'p0')).toMatchObject({ ok: true, heightMm: 65 });
    expect(drawFlatPart(await read('body'), null, 'p0')).toEqual({ ok: false, error: 'Onshape gave no shape for a curved edge of the flat face' });
  });
  it('fails only the DXF when Onshape refuses it, and the STEP still finishes', async () => {
    const work = plates(1);
    const { fetcher } = cutting({ refuse: true });
    for (let poll = 0; poll < 2; poll++) { const budget = { remaining: 12 }; await advanceExport(work, 'u', kv(), budgeted(fetcher, budget), 'v9', budget); }
    expect(work.parts[0]).toMatchObject({ state: 'ready', error: null, dxf: { state: 'failed', error: 'DXF: No access to this part in Onshape' } });
    expect(jobSummary(work).done).toBe(true);
  });
  it('waits for a poll with room for both DXF requests, and keeps the job open until the DXF is made', async () => {
    const work = plates(1);
    const { fetcher, calls } = cutting();
    let budget = { remaining: 2 };
    await advanceExport(work, 'u', kv(), budgeted(fetcher, budget), 'v9', budget);
    // The STEP start took one request; one left is not enough to begin a DXF.
    expect(calls).toHaveLength(1);
    expect(work.parts[0]).toMatchObject({ state: 'translating', dxf: { state: 'pending' } });
    budget = { remaining: 1 };
    await advanceExport(work, 'u', kv(), budgeted(fetcher, budget), 'v9', budget);
    expect(work.parts[0].dxf!.state).toBe('pending');
    expect(jobSummary(work).done).toBe(false);
  });
  it('files a tagged 2D-cut plate whose name says it is over 3 mm thick as a print, with no DXF, unless a person chose it', () => {
    const work = job(2, n => n ? '6mm Side Plate' : '6mm Side Plate [laser]');
    expect(work.parts[0]).toMatchObject({ disposition: 'print', note: 'flat, 6 mm thick: over 3 mm, so 3D printed' });
    expect(work.parts[0].dxf).toBeUndefined();
    // Without a tag the classifier already decided print.
    expect(work.parts[1]).toMatchObject({ disposition: 'print' });
    expect(jobSummary(work).parts[0]).toMatchObject({ note: 'flat, 6 mm thick: over 3 mm, so 3D printed' });
  });
  it('gives a part with no export source a failed DXF too, and other processes none', () => {
    expect(job(1).parts[0].dxf).toBeUndefined();
    const result = aggregateAssembly({ rootAssembly: { instances: [{ id: 'i', name: 'Side Plate', type: 'Part', documentId: 'doc', elementId: 'studio', partId: 'p0' }] } },
      { documentId: 'doc', workspaceOrVersion: 'w', workspaceOrVersionId: 'work', elementId: 'asm' }, 'Robot');
    classifyScan(result, { teamNumber: null }, {});
    result.lines[0].exportSource = null;
    result.scanId = 's';
    expect(createExportJob(result, 'j').parts[0]).toMatchObject({ state: 'failed', dxf: { state: 'failed', error: 'No workspace or version to export from (linked part without a version)' } });
  });
});

describe('STEP product name check', () => {
  it('compares names in any script and never matches an empty name', () => {
    const file = (name: string) => `ISO-10303-21;\nDATA;\n#1=PRODUCT('${name}','','',(#2));\nENDSEC;\nEND-ISO-10303-21;\n`;
    expect(checkStep(file('日本語 マウント'), '日本語 マウント')).toMatchObject({ ok: true, nameMatches: true });
    expect(checkStep(file('Other part'), '日本語 マウント')).toMatchObject({ ok: true, nameMatches: false });
    expect(checkStep(file('Anything'), '!!!')).toMatchObject({ ok: true, nameMatches: false });
  });
});
