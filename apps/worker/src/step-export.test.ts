import { describe, expect, it } from 'vitest';
import { aggregateAssembly, checkStep, classifyScan, type AssemblyInstance } from '@control-kit/shared';
import { mockStep } from './mock-onshape';
import { advanceExport, budgeted, BudgetExhaustedError, createExportJob, type RequestBudget } from './step-export';
import type { Kv } from './index';

const kv = (): Kv => { const values = new Map<string, string>(); return { get: async key => values.get(key) ?? null, put: async (key, value) => { values.set(key, value); }, delete: async key => { values.delete(key); } }; };
/** A scan with `count` printed parts in the assembly's own document, so every part has an export source. */
function job(count: number) {
  const instances: AssemblyInstance[] = Array.from({ length: count }, (_, n) => ({ id: `i${n}`, name: `Bracket ${n} [3DP]`, type: 'Part', documentId: 'doc', elementId: 'studio', partId: `p${n}` }));
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
  it('finishes a part once its translation is done and checks the file', async () => {
    const work = job(2);
    const { fetcher } = onshape(new Set(['p0']));
    const store = kv();
    for (let poll = 0; poll < 2; poll++) { const budget = { remaining: 30 }; await advanceExport(work, 'u', store, budgeted(fetcher, budget), 'v9', budget); }
    expect(work.parts.map(part => part.state)).toEqual(['ready', 'translating']);
    expect(work.parts[0]).toMatchObject({ units: 'mm', nameMatches: true });
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
