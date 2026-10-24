import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import worker, { type Env, type Kv } from './index';
import { createMockOnshape } from './mock-onshape';
import { aggregateAssembly, classificationIdentity, type VendorId } from '@control-kit/shared';
import { clearCatalogMemoryCache } from './catalog';
import { batchKey, indexKey, pointerKey } from './vendor-ingest';
import { readFileSync } from 'node:fs';

class MemoryKv implements Kv {
  values = new Map<string, string>();
  async get(k: string) { return this.values.get(k) ?? null; }
  async put(k: string, v: string) { this.values.set(k, v); }
  async delete(k: string) { this.values.delete(k); }
}
const mock = createMockOnshape();
const env = { APP_STATE: new MemoryKv(), VENDOR_CATALOG: new MemoryKv(), ONSHAPE_OAUTH_CLIENT_ID: 'test-id', ONSHAPE_OAUTH_CLIENT_SECRET: 'test-secret', ONSHAPE_OAUTH_REDIRECT_URI: 'http://localhost:8787/oauth/redirect', ONSHAPE_API_BASE: 'http://localhost:8788', ONSHAPE_API_VERSION: 'v9', ONSHAPE_OAUTH_BASE: 'http://localhost:8788', SESSION_ENCRYPTION_KEY: btoa('12345678901234567890123456789012'), WEB_ORIGIN: 'http://localhost:5173' } as Env & { APP_STATE: MemoryKv; VENDOR_CATALOG: MemoryKv };
const call = (path: string, cookie?: string) => worker.fetch(new Request(`http://localhost:8787${path}`, { headers: { origin: env.WEB_ORIGIN, ...(cookie ? { cookie } : {}) } }), env);
beforeEach(() => vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => mock.handle(new Request(input, init))));
afterAll(() => vi.unstubAllGlobals());

describe('Onshape OAuth and session against mock Onshape', () => {
  it('removes accidental whitespace from configured OAuth credentials', async () => {
    const config = { ...env, ONSHAPE_OAUTH_CLIENT_ID: ' test-id ', ONSHAPE_OAUTH_CLIENT_SECRET: ' test-secret ' };
    const credentialMock = createMockOnshape();
    const tokenCredentials: URLSearchParams[] = [];
    const tokenContentTypes: Array<string | null> = [];
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      if (new URL(request.url).pathname === '/oauth/token') {
        tokenCredentials.push(new URLSearchParams(await request.clone().text()));
        tokenContentTypes.push(request.headers.get('content-type'));
      }
      return credentialMock.handle(request);
    });
    const start = await worker.fetch(new Request('http://localhost:8787/oauth/start?documentId=doc1&workspaceOrVersion=w&workspaceOrVersionId=work1&elementId=elem1'), config);
    const authorize = new URL(start.headers.get('location')!);
    expect(authorize.searchParams.get('client_id')).toBe('test-id');
    const state = authorize.searchParams.get('state');
    const callback = await worker.fetch(new Request(`http://localhost:8787/oauth/redirect?code=mock-code&state=${state}`), config);
    expect(callback.status).toBe(302);
    expect(tokenCredentials[0]?.get('client_id')).toBe('test-id');
    expect(tokenCredentials[0]?.get('client_secret')).toBe('test-secret');
    expect(tokenContentTypes[0]).toBe('application/x-www-form-urlencoded');
  });
  it('logs only a safe OAuth error code when the token endpoint rejects the client', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      for (const [body, expected] of [
        [JSON.stringify({ error: 'invalid_client', error_description: 'sensitive diagnostic details' }), 'OAuth exchange failed 401 invalid_client'],
        [JSON.stringify({ error: 'bad token value', error_description: 'sensitive diagnostic details' }), 'OAuth exchange failed 401'],
        ['not json sensitive diagnostic details', 'OAuth exchange failed 401']
      ]) {
        log.mockClear();
        const start = await call('/oauth/start');
        const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
        vi.stubGlobal('fetch', () => new Response(body, { status: 401 }));
        const callback = await call(`/oauth/redirect?code=mock-code&state=${state}`);
        expect(callback.status).toBe(502);
        expect(await callback.json()).toEqual({ error: 'Control Kit could not complete this request. Try again.' });
        const message = log.mock.calls.map(args => args.map(String).join(' ')).join(' ');
        expect(message).toContain(expected);
        expect(message).not.toContain('sensitive diagnostic details');
        expect(message).not.toContain('mock-code');
        expect(message).not.toContain('bad token value');
      }
    } finally {
      log.mockRestore();
    }
  });
  it('connects, preserves context, encrypts tokens, and survives reload', async () => {
    const start = await call('/oauth/start?documentId=doc1&workspaceOrVersion=w&workspaceOrVersionId=work1&elementId=elem1');
    expect(start.status).toBe(302);
    const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
    const callback = await call(`/oauth/redirect?code=mock-code&state=${state}`);
    expect(callback.status).toBe(302);
    expect(callback.headers.get('location')).toContain('elementId=elem1');
    expect(callback.headers.get('location')).toContain('workspaceOrVersionId=work1');
    const setCookie = callback.headers.get('set-cookie')!;
    expect(setCookie).toContain('SameSite=None');
    expect(setCookie).toContain('HttpOnly');
    const stored = [...env.APP_STATE.values.values()][0];
    expect(stored).not.toContain('mock-access');
    const cookie = setCookie.split(';')[0];
    expect((await call('/api/session', cookie)).status).toBe(200);
    expect((await call(`/oauth/redirect?code=mock-code&state=${state}`)).status).toBe(400);
    // The generic Onshape passthrough was removed: it let any session spend the annual API allowance.
    expect((await call('/api/onshape/test', cookie)).status).toBe(404);
    expect(mock.apiRequests).toBe(1);
    const day = JSON.parse(env.APP_STATE.values.get(`onshape-ledger:${new Date().toISOString().slice(0, 10)}`)!);
    expect(day.byPurpose['oauth-profile']).toBeGreaterThanOrEqual(1);
    expect(day.byKind['session-info']).toBe(day.byPurpose['oauth-profile']);
  });
  it('supports the Applications-page OAuth URL without Assembly context', async () => {
    const target = 'https://cad.onshape.com/user/applications?grant=1';
    const start = await call(`/oauth/start?redirectOnshapeUri=${encodeURIComponent(target)}`);
    expect(start.status).toBe(302);
    const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
    const callback = await call(`/oauth/redirect?code=mock-code&state=${state}`);
    expect(callback.headers.get('location')).toBe(target);
  });
  it('rejects malformed context and unsafe return URLs', async () => {
    expect((await call('/oauth/start?documentId=doc1')).status).toBe(400);
    expect((await call('/oauth/start?redirectOnshapeUri=https%3A%2F%2Fcad.onshape.com.evil.test')).status).toBe(400);
    expect((await call('/oauth/start?redirectOnshapeUri=javascript%3Aalert(1)')).status).toBe(400);
  });
  it('shows setup pending without OAuth credentials', async () => {
    const config = { ...env, ONSHAPE_OAUTH_CLIENT_ID: '', ONSHAPE_OAUTH_CLIENT_SECRET: '' };
    const status = await worker.fetch(new Request('http://localhost:8787/api/session'), config);
    expect(await status.json()).toEqual({ connected: false, setupPending: true });
    const start = await worker.fetch(new Request('http://localhost:8787/oauth/start?documentId=doc1&workspaceOrVersion=w&workspaceOrVersionId=work1&elementId=elem1'), config);
    expect(start.status).toBe(503);
  });
  it('permits only the configured web origin for CORS, including preflight and unauthorized replies', async () => {
    const origin = env.WEB_ORIGIN;
    const preflight = await worker.fetch(new Request('http://localhost:8787/api/session', { method: 'OPTIONS', headers: { origin, 'access-control-request-method': 'GET' } }), env);
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe(origin);
    expect(preflight.headers.get('access-control-allow-credentials')).toBe('true');
    const session = await worker.fetch(new Request('http://localhost:8787/api/session', { headers: { origin } }), env);
    expect(session.status).toBe(401);
    expect(session.headers.get('access-control-allow-origin')).toBe(origin);
    expect(session.headers.get('access-control-allow-credentials')).toBe('true');
    const foreign = await worker.fetch(new Request('http://localhost:8787/api/session', { headers: { origin: 'https://foreign.example' } }), env);
    expect(foreign.headers.get('access-control-allow-origin')).toBeNull();
    const foreignPreflight = await worker.fetch(new Request('http://localhost:8787/api/session', { method: 'OPTIONS', headers: { origin: 'https://foreign.example' } }), env);
    expect(foreignPreflight.headers.get('access-control-allow-origin')).toBeNull();
  });
  it('clears a session after a failed refresh', async () => {
    const start = await call('/oauth/start?documentId=doc2&workspaceOrVersion=v&workspaceOrVersionId=version2&elementId=elem2');
    const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
    const callback = await call(`/oauth/redirect?code=mock-code&state=${state}`);
    const cookie = callback.headers.get('set-cookie')!.split(';')[0];
    vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      if (new URL(request.url).pathname === '/oauth/token' && request.method === 'POST') return Response.json({ error: 'invalid_grant' }, { status: 400 });
      if (new URL(request.url).pathname.startsWith('/api/v9/assemblies/')) return Response.json({ error: 'expired' }, { status: 401 });
      return mock.handle(request);
    });
    const response = await call('/api/scan?documentId=simple&workspaceOrVersion=w&workspaceOrVersionId=work1&elementId=elem1', cookie);
    const events = (await response.text()).trim().split('\n').map(line => JSON.parse(line));
    expect(events.at(-1)).toEqual({ type: 'session-expired' });
    expect((await call('/api/session', cookie)).status).toBe(401);
  });
});

describe('M3 match decisions against local catalog KV', () => {
  it('persists a possible-match confirmation across a rescan and rejects cross-origin writes', async () => {
    clearCatalogMemoryCache();
    const seed = JSON.parse(readFileSync(new URL('../../../fixtures/vendors/seed.json', import.meta.url), 'utf8')) as Array<{ vendorId: string; normalizedSku: string; normalizedName: string }>;
    const bearing = seed.find(record => record.vendorId === 'servocity')!;
    const vendor = bearing.vendorId as VendorId;
    env.VENDOR_CATALOG.values.set(pointerKey(vendor), JSON.stringify({ gen: 'g1', complete: true, records: 1, publishedAt: new Date().toISOString(), completedAt: new Date().toISOString(), previous: null }));
    env.VENDOR_CATALOG.values.set(batchKey(vendor, 'g1', 0), JSON.stringify([bearing]));
    env.VENDOR_CATALOG.values.set(indexKey(vendor, 'g1'), JSON.stringify([[bearing.normalizedSku, bearing.normalizedName, 0]]));
    const start = await call('/oauth/start?documentId=simple&workspaceOrVersion=w&workspaceOrVersionId=work1&elementId=elem1');
    const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
    const cookie = (await call(`/oauth/redirect?code=mock-code&state=${state}`)).headers.get('set-cookie')!.split(';')[0];
    const path = '/api/scan?documentId=simple&workspaceOrVersion=w&workspaceOrVersionId=work1&elementId=elem1';
    const first = (await (await call(path, cookie)).text()).trim().split('\n').map(line => JSON.parse(line)).find(event => event.type === 'result').result;
    const line = first.lines.find((item: { partId: string }) => item.partId === 'bearing-8');
    expect(line.matchStatus).toBe('possible');
    expect(line.lineTotalUsd).toBeNull();
    const body = JSON.stringify({ documentId: 'simple', lineKey: line.bomLineKey, decision: 'confirmed', vendorId: line.vendor.vendorId, normalizedSku: line.vendor.normalizedSku });
    const foreign = await worker.fetch(new Request('http://localhost:8787/api/matches/decision', { method: 'POST', headers: { cookie, origin: 'https://foreign.example', 'content-type': 'application/json' }, body }), env);
    expect(foreign.status).toBe(403);
    const saved = await worker.fetch(new Request('http://localhost:8787/api/matches/decision', { method: 'POST', headers: { cookie, origin: env.WEB_ORIGIN, 'content-type': 'application/json' }, body }), env);
    expect(saved.status).toBe(200);
    const secondBody = JSON.stringify({ documentId: 'simple', lineKey: 'second-line', decision: 'rejected', vendorId: line.vendor.vendorId, normalizedSku: line.vendor.normalizedSku });
    const concurrent = await Promise.all([body, secondBody].map(value => worker.fetch(new Request('http://localhost:8787/api/matches/decision', { method: 'POST', headers: { cookie, origin: env.WEB_ORIGIN, 'content-type': 'application/json' }, body: value }), env)));
    expect(concurrent.map(response => response.status)).toEqual([200, 200]);
    expect([...env.APP_STATE.values.keys()].filter(key => key.startsWith('match-decision:'))).toHaveLength(2);
    expect([...env.APP_STATE.values.keys()].filter(key => key.startsWith('match-decision:')).every(key => key.length < 512)).toBe(true);
    const longBody = JSON.stringify({ documentId: 'simple', lineKey: `configured:${'size=10mm;'.repeat(100)}`, decision: 'confirmed', vendorId: line.vendor.vendorId, normalizedSku: line.vendor.normalizedSku });
    const longSave = await worker.fetch(new Request('http://localhost:8787/api/matches/decision', { method: 'POST', headers: { cookie, origin: env.WEB_ORIGIN, 'content-type': 'application/json' }, body: longBody }), env);
    expect(longSave.status).toBe(200);
    expect([...env.APP_STATE.values.keys()].filter(key => key.startsWith('match-decision:')).every(key => key.length < 512)).toBe(true);
    const second = (await (await call(path, cookie)).text()).trim().split('\n').map(line => JSON.parse(line)).find(event => event.type === 'result').result;
    expect(second.lines.find((item: { partId: string }) => item.partId === 'bearing-8').matchStatus).toBe('confirmed');
    env.VENDOR_CATALOG.values.clear(); clearCatalogMemoryCache();
  });
});

describe('M5 settings and classification overrides against mock Onshape', () => {
  it('persists a manual type across a rescan and lets the user return to automatic scoring', async () => {
    const start = await call('/oauth/start?documentId=simple&workspaceOrVersion=w&workspaceOrVersionId=work1&elementId=elem1');
    const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
    const cookie = (await call(`/oauth/redirect?code=mock-code&state=${state}`)).headers.get('set-cookie')!.split(';')[0];
    const post = (path: string, body: unknown) => worker.fetch(new Request(`http://localhost:8787${path}`, { method: 'POST', headers: { cookie, origin: env.WEB_ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify(body) }), env);
    expect((await post('/api/settings', { teamNumber: '1234' })).status).toBe(200);
    expect(await (await call('/api/settings', cookie)).json()).toEqual({ teamNumber: '1234' });
    const path = '/api/scan?documentId=simple&workspaceOrVersion=w&workspaceOrVersionId=work1&elementId=elem1';
    const scan = async () => (await (await call(path, cookie)).text()).trim().split('\n').map(row => JSON.parse(row)).find(event => event.type === 'result').result;
    const first = await scan();
    const selected = first.lines[0];
    const set = (classification: string | null, scanId = first.scanId, identity = classificationIdentity(selected), documentId = 'simple') => post('/api/classification/override', { documentId, scanId, identity, classification });
    // Shared choices need the writer's own scan of that document.
    expect((await post('/api/classification/override', { documentId: 'simple', identity: classificationIdentity(selected), classification: 'print' })).status).toBe(409);
    expect((await set('print', first.scanId, classificationIdentity(selected), 'robot')).status).toBe(409);
    expect((await set('not-a-disposition')).status).toBe(400);
    expect((await set('print')).status).toBe(200);
    const second = await scan();
    expect(second.scanId).not.toBe(first.scanId);
    expect(env.APP_STATE.values.has(`scan:mock-user:${first.scanId}`)).toBe(true);
    expect(second.lines[0]).toMatchObject({ disposition: 'print', manualClassification: 'print', classification: 'printed', dispositionSource: 'manual' });
    expect(second.stats.printedLines).toBeGreaterThanOrEqual(1);
    expect((await set(null, second.scanId)).status).toBe(200);
    const third = await scan();
    expect(third.lines[0].manualClassification).toBeNull();
    const [key] = [...env.APP_STATE.values.keys()].filter(item => item.startsWith('disposition:simple:'));
    expect(JSON.parse(env.APP_STATE.values.get(key)!)).toMatchObject({ disposition: null, by: 'FTC Mentor' });
    const changes = () => [...env.APP_STATE.values.entries()].filter(([item]) => item.startsWith(`disposition-change:simple:${key.split(':')[2]}:`)).map(([, value]) => JSON.parse(value).disposition);
    expect(changes().sort()).toEqual(['print', null].sort());
    // Two saves of the same part at once both stay in the history.
    await Promise.all([set('cnc', second.scanId), set('cut-2d', second.scanId)]);
    expect(changes()).toHaveLength(4);
    expect(changes()).toEqual(expect.arrayContaining(['cnc', 'cut-2d']));
    await set(null, second.scanId);
    const [a, b] = third.lines.slice(0, 2);
    await Promise.all([set('cnc', third.scanId, classificationIdentity(a)), set('buy', third.scanId, classificationIdentity(b))]);
    const fourth = await scan();
    expect(fourth.lines[0].manualClassification).toBe('cnc');
    expect(fourth.lines[1].manualClassification).toBe('buy');
    const foreign = await worker.fetch(new Request('http://localhost:8787/api/classification/override', { method: 'POST', headers: { cookie, origin: 'https://foreign.example', 'content-type': 'application/json' }, body: JSON.stringify({ documentId: 'simple', scanId: first.scanId, identity: classificationIdentity(selected), classification: 'print' }) }), env);
    expect(foreign.status).toBe(403);
  });
  it('reads a manual type saved per user before the rework as a fallback', async () => {
    const start = await call('/oauth/start?documentId=simple&workspaceOrVersion=w&workspaceOrVersionId=work1&elementId=elem1');
    const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
    const cookie = (await call(`/oauth/redirect?code=mock-code&state=${state}`)).headers.get('set-cookie')!.split(';')[0];
    const path = '/api/scan?documentId=simple&workspaceOrVersion=w&workspaceOrVersionId=work1&elementId=elem1';
    const scan = async () => (await (await call(path, cookie)).text()).trim().split('\n').map(row => JSON.parse(row)).find(event => event.type === 'result').result;
    const first = await scan();
    const line = first.lines.find((item: { manualClassification: string | null }) => !item.manualClassification);
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(classificationIdentity(line)))), byte => byte.toString(16).padStart(2, '0')).join('');
    for (const key of [...env.APP_STATE.values.keys()]) if (key.startsWith('disposition:simple:') && key.endsWith(digest)) env.APP_STATE.values.delete(key);
    env.APP_STATE.values.set(`override:mock-user:simple:${digest}`, 'printed');
    const second = await scan();
    expect(second.lines.find((item: { bomLineKey: string }) => item.bomLineKey === line.bomLineKey)).toMatchObject({ manualClassification: 'print', disposition: 'print' });
  });
  const exportJob = async (cookie: string, documentId: string, scanId: string) => {
    const post = (path: string, body: unknown) => worker.fetch(new Request(`http://localhost:8787${path}`, { method: 'POST', headers: { cookie, origin: env.WEB_ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify(body) }), env);
    const started = await post('/api/exports', { documentId, scanId });
    let job = await started.json() as { jobId: string; done: boolean; error?: string; parts: Array<{ name: string; state: string; error: string | null; fileName: string; units: string | null; nameMatches: boolean | null }> };
    if (!started.ok) return { status: started.status, job };
    for (let round = 0; round < 10 && !job.done; round++) job = await (await call(`/api/exports/${job.jobId}`, cookie)).json() as typeof job;
    return { status: 200, job };
  };
  it('exports confirmed prints as checked STEP files and reports each failure with its reason', async () => {
    const start = await call('/oauth/start?documentId=robot&workspaceOrVersion=w&workspaceOrVersionId=work1&elementId=elem1');
    const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
    const cookie = (await call(`/oauth/redirect?code=mock-code&state=${state}`)).headers.get('set-cookie')!.split(';')[0];
    const scan = await call('/api/scan?documentId=robot&workspaceOrVersion=w&workspaceOrVersionId=work1&elementId=elem1', cookie);
    const result = (await scan.text()).trim().split('\n').map(row => JSON.parse(row)).find(event => event.type === 'result').result;
    const motor = result.lines.find((line: { partId: string }) => line.partId === 'motor-5203');
    const override = await worker.fetch(new Request('http://localhost:8787/api/classification/override', { method: 'POST', headers: { cookie, origin: env.WEB_ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ documentId: 'robot', scanId: result.scanId, identity: classificationIdentity(motor), classification: 'print' }) }), env);
    expect(override.status).toBe(200);
    const before = mock.apiRequests;
    const { status, job } = await exportJob(cookie, 'robot', result.scanId);
    expect(status).toBe(200);
    expect(job.done).toBe(true);
    // The guide is a print by its PETG material; the motor only by the manual choice, and Onshape fails it on purpose.
    const guide = job.parts.find(part => part.name === 'Custom Printed Intake Guide')!;
    expect(guide).toMatchObject({ state: 'ready', units: 'mm', nameMatches: true, fileName: 'Custom_Printed_Intake_Guide__intakeguid.step' });
    expect(job.parts.find(part => part.name === '5203 Motor')).toMatchObject({ state: 'failed', error: 'Deliberate fixture STEP failure' });
    // Guide: start, two polls, download. Motor: start, one poll.
    expect(mock.apiRequests - before).toBe(6);
    const index = job.parts.indexOf(job.parts.find(part => part.name === 'Custom Printed Intake Guide')!);
    const file = await call(`/api/exports/${job.jobId}/files/${index}`, cookie);
    expect(file.status).toBe(200);
    expect(file.headers.get('content-disposition')).toContain('Custom_Printed_Intake_Guide__intakeguid.step');
    expect((await file.text()).startsWith('ISO-10303-21;')).toBe(true);
    expect(mock.apiRequests - before).toBe(6);
    const failedFile = await call(`/api/exports/${job.jobId}/files/${job.parts.findIndex(part => part.state === 'failed')}`, cookie);
    expect(failedFile.status).toBe(404);
    const foreign = await worker.fetch(new Request(`http://localhost:8787/api/exports/${job.jobId}`, { headers: { cookie, origin: 'https://foreign.example' } }), env);
    expect(foreign.status).toBe(403);
    const day = JSON.parse(env.APP_STATE.values.get(`onshape-ledger:${new Date().toISOString().slice(0, 10)}`)!);
    expect(day.byKind['translation-start']).toBeGreaterThanOrEqual(2);
  });
  it('rejects a non-STEP download instead of zipping it, and refuses an export with nothing to make', async () => {
    const start = await call('/oauth/start?documentId=simple&workspaceOrVersion=w&workspaceOrVersionId=work1&elementId=elem1');
    const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
    const cookie = (await call(`/oauth/redirect?code=mock-code&state=${state}`)).headers.get('set-cookie')!.split(';')[0];
    const scan = await call('/api/scan?documentId=simple&workspaceOrVersion=w&workspaceOrVersionId=work1&elementId=elem1', cookie);
    const result = (await scan.text()).trim().split('\n').map(row => JSON.parse(row)).find(event => event.type === 'result').result;
    // A scan holding only a standard-content screw (Buy) has nothing to make, so no export starts.
    const original = result.lines;
    result.lines = [{ ...original[0], bomLineKey: 'screw-only', name: 'Socket head screw', partId: 'screw-only', isStandardContent: true, material: null }];
    await env.APP_STATE.put(`scan:mock-user:${result.scanId}`, JSON.stringify(result));
    const empty = await exportJob(cookie, 'simple', result.scanId);
    expect(empty.status).toBe(409);
    expect(empty.job.error).toContain('No part is set to 3D print');
    const line = { ...result.lines[0], bomLineKey: 'bad-file-line', name: '日本語 Printed Mount', partId: 'bad-file', material: 'PLA' };
    result.lines = [line];
    await env.APP_STATE.put(`scan:mock-user:${result.scanId}`, JSON.stringify(result));
    const { job } = await exportJob(cookie, 'simple', result.scanId);
    expect(job.parts).toEqual([expect.objectContaining({ name: '日本語 Printed Mount', state: 'failed', error: 'Onshape returned something other than a STEP file' })]);
  });
  it('reapplies a saved match rejection and current dispositions before choosing parts to export', async () => {
    const start = await call('/oauth/start?documentId=simple&workspaceOrVersion=w&workspaceOrVersionId=work1&elementId=elem1');
    const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
    const cookie = (await call(`/oauth/redirect?code=mock-code&state=${state}`)).headers.get('set-cookie')!.split(';')[0];
    const scan = await call('/api/scan?documentId=simple&workspaceOrVersion=w&workspaceOrVersionId=work1&elementId=elem1', cookie);
    const result = (await scan.text()).trim().split('\n').map(row => JSON.parse(row)).find(event => event.type === 'result').result;
    const line = result.lines[0];
    line.bomLineKey = 'custom-bracket-export'; line.name = 'Custom bracket'; line.partId = 'sensor-mount'; line.matchStatus = 'possible'; line.matchConfidence = 0.75;
    line.vendor = { vendorId: 'rev', name: 'Bracket', normalizedName: 'bracket', sku: 'REV-1', normalizedSku: '1', url: 'https://www.revrobotics.com/bracket/', priceUsd: null,
      stock: 'unknown', stockQty: null, packSize: null, packSizeVerified: false, category: 'bracket', updatedAt: '', source: 'feed' };
    result.lines = [line];
    await env.APP_STATE.put(`scan:mock-user:${result.scanId}`, JSON.stringify(result));
    const save = await worker.fetch(new Request('http://localhost:8787/api/matches/decision', { method: 'POST', headers: { cookie, origin: env.WEB_ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ documentId: 'simple', lineKey: line.bomLineKey, decision: 'rejected', vendorId: 'rev', normalizedSku: '1' }) }), env);
    expect(save.status).toBe(200);
    const print = await worker.fetch(new Request('http://localhost:8787/api/classification/override', { method: 'POST', headers: { cookie, origin: env.WEB_ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ documentId: 'simple', scanId: result.scanId, identity: classificationIdentity(line), classification: 'print' }) }), env);
    expect(print.status).toBe(200);
    const { job } = await exportJob(cookie, 'simple', result.scanId);
    expect(job.parts).toEqual([expect.objectContaining({ name: 'Custom bracket', state: 'ready' })]);
  });
});

describe('M2 scan stream against mock Onshape', () => {
  async function connectedCookie() {
    const start = await call('/oauth/start?documentId=doc1&workspaceOrVersion=w&workspaceOrVersionId=work1&elementId=elem1');
    const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
    return (await call(`/oauth/redirect?code=mock-code&state=${state}`)).headers.get('set-cookie')!.split(';')[0];
  }
  const scan = async (cookie: string, documentId = 'robot', wv = 'w') => {
    const response = await call(`/api/scan?documentId=${documentId}&workspaceOrVersion=${wv}&workspaceOrVersionId=work1&elementId=elem1`, cookie);
    expect(response.status).toBe(200);
    const events = (await response.text()).trim().split('\n').map(line => JSON.parse(line));
    return { events, result: events.find(event => event.type === 'result')?.result };
  };
  // Each test starts without cached Onshape sources so request counts are exact.
  beforeEach(() => { for (const key of [...env.APP_STATE.values.keys()]) if (key.includes('onshape-source:')) env.APP_STATE.values.delete(key); });
  it('scans the large fixture in three Onshape requests, retries real 429s, and reconciles with the BOM', async () => {
    const cookie = await connectedCookie();
    mock.setRateLimit(2);
    const before = mock.apiRequests;
    const { events, result } = await scan(cookie);
    expect(events.filter(event => event.type === 'rate-limit')).toHaveLength(2);
    expect(result.stats.totalInstances).toBe(260);
    expect(result.suppressed[0].qty).toBe(4);
    // Microversion, definition (plus two 429 retries), and BOM. The old flow made one mass-properties call per part.
    expect(mock.apiRequests - before).toBe(5);
    expect(result.diagnostics.onshapeRequests).toMatchObject({ total: 5, billable: 3, retries: 2, byKind: { microversion: 1, 'assembly-definition': 3, 'assembly-bom': 1 }, byStatus: { 200: 3, 429: 2 } });
    expect(result.diagnostics.revision).toEqual({ type: 'm', id: 'mv-1' });
    expect(result.diagnostics.cache).toBe('miss');
    expect(result.diagnostics.bom).toMatchObject({ status: 'merged', rows: 5, matchedLines: 5, linesWithoutRow: 0, rowsWithoutLine: 0, quantityMismatches: 0 });
    expect(result.diagnostics.bom.columns.map((column: { propertyName: string }) => column.propertyName)).toEqual(['name', 'quantity', 'partNumber', 'description', 'vendor', 'material']);
    expect(result.assemblyName).toBe('FTC Competition Robot');
    expect(result.documentName).toBe('FTC Competition Robot document');
    const motor = result.lines.find((line: { partId: string }) => line.partId === 'motor-5203');
    expect(motor).toMatchObject({ partNumber: 'GB-5203', description: 'Yellow Jacket planetary gear motor', bomProperties: { vendor: 'goBILDA', quantity: 20 } });
    expect(result.lines.find((line: { partId: string }) => line.partId === 'intake-guide').material).toBe('PETG');
    // Suppressed parts are absent from Onshape's BOM by design and are not reported as missing metadata.
    expect(result.missingMetadata).toEqual([]);
    expect(events.some(event => event.type === 'progress' && event.stage === "Reading Onshape's bill of materials…")).toBe(true);
  });
  it('rescans an unchanged revision from the per-user cache with one request', async () => {
    const cookie = await connectedCookie();
    const first = await scan(cookie);
    const before = mock.apiRequests;
    const second = await scan(cookie);
    expect(mock.apiRequests - before).toBe(1);
    expect(second.result.diagnostics).toMatchObject({ cache: 'hit', onshapeRequests: { total: 1, byKind: { microversion: 1 } } });
    expect(second.result.lines.map((line: { bomLineKey: string; qty: number }) => [line.bomLineKey, line.qty])).toEqual(first.result.lines.map((line: { bomLineKey: string; qty: number }) => [line.bomLineKey, line.qty]));
    expect([...env.APP_STATE.values.keys()].filter(key => key.includes('onshape-source:')).every(key => key.startsWith('mock-user:'))).toBe(true);
  });
  it('reads a version directly, without a microversion request', async () => {
    const cookie = await connectedCookie();
    const before = mock.apiRequests;
    const { result } = await scan(cookie, 'robot', 'v');
    expect(mock.apiRequests - before).toBe(2);
    expect(result.diagnostics.revision).toEqual({ type: 'v', id: 'work1' });
  });
  it('keeps the scan when the BOM cannot be read, flags its lines, and does not cache the gap', async () => {
    const cookie = await connectedCookie();
    mock.setBomFailure(503);
    try {
      const { events, result } = await scan(cookie, 'simple');
      expect(events.some(event => event.type === 'error')).toBe(false);
      expect(result.stats.totalInstances).toBe(11);
      expect(result.diagnostics.bom).toMatchObject({ status: 'unavailable', httpStatus: 503 });
      expect(result.lines.every((line: { metadataIssue: unknown }) => JSON.stringify(line.metadataIssue) === JSON.stringify({ code: 'bom-unavailable', httpStatus: 503 }))).toBe(true);
      expect(result.diagnostics.metadataIssues[0]).toMatchObject({ code: 'bom-unavailable', httpStatus: 503 });
    } finally { mock.setBomFailure(null); }
    const before = mock.apiRequests;
    const retried = await scan(cookie, 'simple');
    expect(mock.apiRequests - before).toBe(3);
    expect(retried.result.diagnostics.bom.status).toBe('merged');
  });
  it('completes the scan from the definition when the BOM request fails on the network', async () => {
    const cookie = await connectedCookie();
    vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      if (new URL(request.url).pathname.endsWith('/bom')) throw new TypeError('fetch failed');
      return mock.handle(request);
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { events, result } = await scan(cookie, 'simple');
    expect(events.some(event => event.type === 'error')).toBe(false);
    expect(result.stats.totalInstances).toBe(11);
    expect(result.diagnostics.bom).toMatchObject({ status: 'unavailable', httpStatus: null });
    expect(result.lines[0].metadataIssue).toEqual({ code: 'bom-unavailable', httpStatus: null });
    vi.restoreAllMocks();
  });
  it('stops with the allowance message when the BOM request returns HTTP 402', async () => {
    const cookie = await connectedCookie();
    vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      if (new URL(request.url).pathname.endsWith('/bom')) return Response.json({ error: 'payment_required' }, { status: 402 });
      return mock.handle(request);
    });
    const { events } = await scan(cookie, 'simple');
    expect(events.find(event => event.type === 'error')?.message).toContain('annual API allowance');
    expect(events.some(event => event.type === 'result')).toBe(false);
  });
  it('explains an exhausted annual Onshape allowance (HTTP 402)', async () => {
    const cookie = await connectedCookie();
    vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      if (new URL(request.url).pathname.endsWith('/currentmicroversion')) return Response.json({ error: 'payment_required' }, { status: 402 });
      return mock.handle(request);
    });
    const { events } = await scan(cookie, 'simple');
    expect(events.find(event => event.type === 'error')?.message).toContain('annual API allowance');
    expect(events.some(event => event.type === 'result')).toBe(false);
  });
  it('requires a session and a valid Assembly context', async () => {
    expect((await call('/api/scan?documentId=simple&workspaceOrVersion=w&workspaceOrVersionId=work1&elementId=elem1')).status).toBe(401);
    const cookie = await connectedCookie();
    expect((await call('/api/scan?documentId=simple&workspaceOrVersion=x&workspaceOrVersionId=work1&elementId=elem1', cookie)).status).toBe(400);
  });
  it('returns a valid empty result for the empty fixture', async () => {
    const cookie = await connectedCookie();
    const { result } = await scan(cookie, 'empty');
    expect(result.lines).toEqual([]);
    expect(result.stats.totalInstances).toBe(0);
  });
  it.each([403, 404])('reports assembly HTTP %s as a fatal access error with no partial BOM', async status => {
    const cookie = await connectedCookie();
    vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      if (new URL(request.url).pathname.includes('/assemblies/')) return Response.json({ error: 'unavailable' }, { status });
      return mock.handle(request);
    });
    const { events } = await scan(cookie, 'simple');
    expect(events.find(event => event.type === 'error')?.message).toContain('may need to be public');
    expect(events.some(event => event.type === 'result')).toBe(false);
  });
  it('reports a network failure as a fatal scan error with retry guidance', async () => {
    const cookie = await connectedCookie();
    vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      if (new URL(request.url).pathname.includes('/assemblies/')) throw new TypeError('fetch failed');
      return mock.handle(request);
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { events } = await scan(cookie, 'simple');
    expect(events.find(event => event.type === 'error')?.message).toContain('Check your connection and retry');
    expect(events.some(event => event.type === 'result')).toBe(false);
    vi.restoreAllMocks();
  });
  it('keeps a linked part microversion and configuration in its identity and source link', () => {
    const result = aggregateAssembly({ rootAssembly: { instances: [{ id: 'linked', name: 'Linked Gear', type: 'Part', documentId: 'other-doc', elementId: 'studio', partId: 'gear', documentMicroversion: 'revision-1', configuration: 'size=large' }] } }, { documentId: 'doc1', workspaceOrVersion: 'w', workspaceOrVersionId: 'work1', elementId: 'assembly' }, 'Robot');
    expect(result.lines[0]).toMatchObject({ sourceType: 'm', sourceId: 'revision-1', configuration: 'size=large', partStudioUrl: 'https://cad.onshape.com/documents/other-doc/m/revision-1/e/studio' });
  });
  it('signals reconnect and counts the requests if token refresh fails while reading the BOM', async () => {
    const cookie = await connectedCookie();
    const day = () => JSON.parse(env.APP_STATE.values.get(`onshape-ledger:${new Date().toISOString().slice(0, 10)}`) ?? '{"total":0}').total;
    const before = day();
    const mockBefore = mock.apiRequests;
    let bomCalls = 0;
    vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      if (new URL(request.url).pathname === '/oauth/token') return Response.json({ error: 'invalid_grant' }, { status: 400 });
      if (new URL(request.url).pathname.endsWith('/bom')) { bomCalls++; return Response.json({ error: 'expired' }, { status: 401 }); }
      return mock.handle(request);
    });
    const response = await call('/api/scan?documentId=simple&workspaceOrVersion=w&workspaceOrVersionId=work1&elementId=elem1', cookie);
    const events = (await response.text()).trim().split('\n').map(line => JSON.parse(line));
    expect(events.some(event => event.type === 'session-expired')).toBe(true);
    expect(events.some(event => event.type === 'result')).toBe(false);
    expect((await call('/api/session', cookie)).status).toBe(401);
    expect(day() - before).toBe(mock.apiRequests - mockBefore + bomCalls);
  });
});
