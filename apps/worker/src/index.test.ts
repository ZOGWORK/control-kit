import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import worker, { type Env, type Kv } from './index';
import { createMockOnshape } from './mock-onshape';
import { massPath } from './scan';
import { aggregateAssembly, classificationIdentity } from '@control-kit/shared';
import { clearCatalogMemoryCache } from './catalog';
import { readFileSync } from 'node:fs';
import { strFromU8, unzipSync } from 'fflate';

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
    expect((await call('/api/onshape/test?failOnce=1', cookie)).status).toBe(200);
    expect(mock.apiRequests).toBe(3);
  });
  it('supports the Applications-page OAuth URL without Assembly context', async () => {
    const target = 'https://cad.onshape.com/user/applications?grant=1';
    const start = await call(`/oauth/start?redirectOnshapeUri=${encodeURIComponent(target)}`);
    expect(start.status).toBe(302);
    const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
    const callback = await call(`/oauth/redirect?code=mock-code&state=${state}`);
    expect(callback.headers.get('location')).toBe(target);
  });
  it('rejects malformed context, unsafe return URLs, and unauthenticated proxy requests', async () => {
    expect((await call('/oauth/start?documentId=doc1')).status).toBe(400);
    expect((await call('/oauth/start?redirectOnshapeUri=https%3A%2F%2Fcad.onshape.com.evil.test')).status).toBe(400);
    expect((await call('/oauth/start?redirectOnshapeUri=javascript%3Aalert(1)')).status).toBe(400);
    expect((await call('/api/onshape/test')).status).toBe(401);
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
      return mock.handle(request);
    });
    const response = await call('/api/onshape/test?always401=1', cookie);
    expect(response.status).toBe(401);
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
    expect((await call('/api/session', cookie)).status).toBe(401);
  });
});

describe('M3 match decisions against local catalog KV', () => {
  it('persists a possible-match confirmation across a rescan and rejects cross-origin writes', async () => {
    clearCatalogMemoryCache();
    const seed = JSON.parse(readFileSync(new URL('../../../fixtures/vendors/seed.json', import.meta.url), 'utf8')) as Array<{ vendorId: string; normalizedSku: string; normalizedName: string }>;
    const bearing = seed.find(record => record.vendorId === 'servocity')!;
    env.VENDOR_CATALOG.values.set(`vendor:${bearing.vendorId}:${bearing.normalizedSku}`, JSON.stringify(bearing));
    env.VENDOR_CATALOG.values.set('vendor-index:bearing', JSON.stringify([`${bearing.vendorId}:${bearing.normalizedSku}`]));
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
    expect((await post('/api/classification/override', { documentId: 'simple', identity: classificationIdentity(selected), classification: 'printed' })).status).toBe(200);
    const second = await scan();
    expect(second.scanId).not.toBe(first.scanId);
    expect(env.APP_STATE.values.has(`scan:mock-user:${first.scanId}`)).toBe(true);
    expect(second.lines[0].classification).toBe('printed');
    expect(second.lines[0].manualClassification).toBe('printed');
    expect(second.stats.printedLines).toBeGreaterThanOrEqual(1);
    expect((await post('/api/classification/override', { documentId: 'simple', identity: classificationIdentity(selected), classification: null })).status).toBe(200);
    const third = await scan();
    expect(third.lines[0].manualClassification).toBeNull();
    const [a, b] = third.lines.slice(0, 2);
    await Promise.all([
      post('/api/classification/override', { documentId: 'simple', identity: classificationIdentity(a), classification: 'printed' }),
      post('/api/classification/override', { documentId: 'simple', identity: classificationIdentity(b), classification: 'commercial' }),
    ]);
    const fourth = await scan();
    expect(fourth.lines[0].manualClassification).toBe('printed');
    expect(fourth.lines[1].manualClassification).toBe('commercial');
    const foreign = await worker.fetch(new Request('http://localhost:8787/api/classification/override', { method: 'POST', headers: { cookie, origin: 'https://foreign.example', 'content-type': 'application/json' }, body: JSON.stringify({ documentId: 'simple', identity: classificationIdentity(selected), classification: 'printed' }) }), env);
    expect(foreign.status).toBe(403);
  });
  it('keeps Unicode failed part names in a downloadable zip', async () => {
    const start = await call('/oauth/start?documentId=simple&workspaceOrVersion=w&workspaceOrVersionId=work1&elementId=elem1');
    const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
    const cookie = (await call(`/oauth/redirect?code=mock-code&state=${state}`)).headers.get('set-cookie')!.split(';')[0];
    const scan = await call('/api/scan?documentId=simple&workspaceOrVersion=w&workspaceOrVersionId=work1&elementId=elem1', cookie);
    const result = (await scan.text()).trim().split('\n').map(row => JSON.parse(row)).find(event => event.type === 'result').result;
    result.lines = [{ ...result.lines[0], name: '日本語 Printed Mount', partId: null, vendor: null }];
    await env.APP_STATE.put(`scan:mock-user:${result.scanId}`, JSON.stringify(result));
    const zip = await call(`/api/prints/zip?documentId=simple&scanId=${result.scanId}`, cookie);
    expect(zip.status).toBe(200);
    const failures = JSON.parse(decodeURIComponent(zip.headers.get('x-control-kit-failures')!));
    expect(failures[0].name).toBe('日本語 Printed Mount');
    expect(strFromU8(unzipSync(new Uint8Array(await zip.arrayBuffer()))['Simple_FTC_Assembly_prints/README.txt'])).toContain('日本語 Printed Mount');
  });
  it('reapplies a saved match rejection before selecting printed parts for export', async () => {
    const start = await call('/oauth/start?documentId=simple&workspaceOrVersion=w&workspaceOrVersionId=work1&elementId=elem1');
    const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
    const cookie = (await call(`/oauth/redirect?code=mock-code&state=${state}`)).headers.get('set-cookie')!.split(';')[0];
    const scan = await call('/api/scan?documentId=simple&workspaceOrVersion=w&workspaceOrVersionId=work1&elementId=elem1', cookie);
    const result = (await scan.text()).trim().split('\n').map(row => JSON.parse(row)).find(event => event.type === 'result').result;
    const line = result.lines[0];
    line.bomLineKey = 'custom-bracket-export'; line.name = 'Custom bracket'; line.matchStatus = 'possible'; line.matchConfidence = 0.75;
    line.vendor = { vendorId: 'rev', name: 'Bracket', normalizedName: 'bracket', sku: 'REV-1', normalizedSku: '1', url: 'https://www.revrobotics.com/bracket/', priceUsd: null,
      stock: 'unknown', stockQty: null, packSize: null, packSizeVerified: false, category: 'bracket', updatedAt: '', source: 'feed' };
    result.lines = [line];
    await env.APP_STATE.put(`scan:mock-user:${result.scanId}`, JSON.stringify(result));
    const save = await worker.fetch(new Request('http://localhost:8787/api/matches/decision', { method: 'POST', headers: { cookie, origin: env.WEB_ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ documentId: 'simple', lineKey: line.bomLineKey, decision: 'rejected', vendorId: 'rev', normalizedSku: '1' }) }), env);
    expect(save.status).toBe(200);
    const zip = await call(`/api/prints/zip?documentId=simple&scanId=${result.scanId}`, cookie);
    expect(zip.status).toBe(200);
    expect(strFromU8(unzipSync(new Uint8Array(await zip.arrayBuffer()))['Simple_FTC_Assembly_prints/README.txt'])).toContain('Custom bracket:');
  });
  it('exports fixture B STLs through the authenticated route and lists a failed part', async () => {
    const start = await call('/oauth/start?documentId=robot&workspaceOrVersion=w&workspaceOrVersionId=work1&elementId=elem1');
    const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
    const cookie = (await call(`/oauth/redirect?code=mock-code&state=${state}`)).headers.get('set-cookie')!.split(';')[0];
    const scan = await call('/api/scan?documentId=robot&workspaceOrVersion=w&workspaceOrVersionId=work1&elementId=elem1', cookie);
    const result = (await scan.text()).trim().split('\n').map(row => JSON.parse(row)).find(event => event.type === 'result').result;
    const motor = result.lines.find((line: { partId: string }) => line.partId === 'motor-5203');
    const override = await worker.fetch(new Request('http://localhost:8787/api/classification/override', { method: 'POST', headers: { cookie, origin: env.WEB_ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ documentId: 'robot', identity: classificationIdentity(motor), classification: 'printed' }) }), env);
    expect(override.status).toBe(200);
    const zip = await call(`/api/prints/zip?documentId=robot&scanId=${result.scanId}`, cookie);
    expect(zip.status).toBe(200);
    expect(zip.headers.get('content-type')).toBe('application/zip');
    const files = unzipSync(new Uint8Array(await zip.arrayBuffer()));
    expect(Object.keys(files).some(name => name.includes('/intake/custom_printed_intake_guide__'))).toBe(true);
    expect(strFromU8(files['FTC_Competition_Robot_prints/README.txt'])).toContain('5203 Motor: Deliberate fixture STL failure');
    expect(JSON.parse(decodeURIComponent(zip.headers.get('x-control-kit-failures')!))).toEqual(expect.arrayContaining([expect.objectContaining({ name: '5203 Motor', url: expect.stringContaining('onshape.com') })]));
    const foreign = await worker.fetch(new Request(`http://localhost:8787/api/prints/zip?documentId=robot&scanId=${result.scanId}`, { headers: { cookie, origin: 'https://foreign.example' } }), env);
    expect(foreign.status).toBe(403);
  });
});

describe('M2 scan stream against mock Onshape', () => {
  async function connectedCookie() {
    const start = await call('/oauth/start?documentId=doc1&workspaceOrVersion=w&workspaceOrVersionId=work1&elementId=elem1');
    const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
    return (await call(`/oauth/redirect?code=mock-code&state=${state}`)).headers.get('set-cookie')!.split(';')[0];
  }
  it('scans the large fixture, retries real 429 responses twice, and keeps metadata failures local', async () => {
    const cookie = await connectedCookie();
    mock.setRateLimit(2);
    const before = mock.apiRequests;
    const response = await call('/api/scan?documentId=robot&workspaceOrVersion=w&workspaceOrVersionId=work1&elementId=elem1', cookie);
    expect(response.status).toBe(200);
    const events = (await response.text()).trim().split('\n').map(line => JSON.parse(line));
    expect(events.filter(event => event.type === 'rate-limit')).toHaveLength(2);
    const result = events.find(event => event.type === 'result')?.result;
    expect(result.stats.totalInstances).toBe(260);
    expect(result.suppressed[0].qty).toBe(4);
    expect(result.missingMetadata).toHaveLength(1);
    expect(result.missingMetadata[0].suppressed).toBe(true);
    expect(mock.apiRequests - before).toBe(9); // 3 assembly attempts + one metadata call for each of 6 unique elements.
    expect(events.some(event => event.type === 'progress' && event.stage === 'Resolving parts…')).toBe(true);
  });
  it('reports a failed metadata element without aborting the scan', async () => {
    const cookie = await connectedCookie();
    const response = await call('/api/scan?documentId=simple&workspaceOrVersion=w&workspaceOrVersionId=work1&elementId=elem1', cookie);
    const events = (await response.text()).trim().split('\n').map(line => JSON.parse(line));
    const result = events.find(event => event.type === 'result')?.result;
    expect(result.stats.totalInstances).toBe(11);
    expect(result.suppressed[0].missingMetadataReason).toBe('Part metadata could not be read');
    expect(result.missingMetadata).toHaveLength(1);
    expect(events.some(event => event.type === 'error')).toBe(false);
  });
  it('requires a session and a valid Assembly context', async () => {
    expect((await call('/api/scan?documentId=simple&workspaceOrVersion=w&workspaceOrVersionId=work1&elementId=elem1')).status).toBe(401);
    const cookie = await connectedCookie();
    expect((await call('/api/scan?documentId=simple&workspaceOrVersion=x&workspaceOrVersionId=work1&elementId=elem1', cookie)).status).toBe(400);
  });
  it('returns a valid empty result for the empty fixture', async () => {
    const cookie = await connectedCookie();
    const response = await call('/api/scan?documentId=empty&workspaceOrVersion=w&workspaceOrVersionId=work1&elementId=elem1', cookie);
    const events = (await response.text()).trim().split('\n').map(line => JSON.parse(line));
    const result = events.find(event => event.type === 'result')?.result;
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
    const response = await call('/api/scan?documentId=simple&workspaceOrVersion=w&workspaceOrVersionId=work1&elementId=elem1', cookie);
    const events = (await response.text()).trim().split('\n').map(line => JSON.parse(line));
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
    const response = await call('/api/scan?documentId=simple&workspaceOrVersion=w&workspaceOrVersionId=work1&elementId=elem1', cookie);
    const events = (await response.text()).trim().split('\n').map(line => JSON.parse(line));
    expect(events.find(event => event.type === 'error')?.message).toContain('Check your connection and retry');
    expect(events.some(event => event.type === 'result')).toBe(false);
  });
  it('uses a linked part microversion and configuration for metadata', () => {
    const result = aggregateAssembly({ rootAssembly: { instances: [{ id: 'linked', name: 'Linked Gear', type: 'Part', documentId: 'other-doc', elementId: 'studio', partId: 'gear', documentMicroversion: 'revision-1', configuration: 'size=large' }] } }, { documentId: 'doc1', workspaceOrVersion: 'w', workspaceOrVersionId: 'work1', elementId: 'assembly' }, 'Robot');
    expect(massPath(result.lines[0], 'v9')).toBe('/api/v9/partstudios/d/other-doc/m/revision-1/e/studio/massproperties?configuration=size%3Dlarge');
  });
  it('signals reconnect if token refresh fails during metadata', async () => {
    const cookie = await connectedCookie();
    vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      if (new URL(request.url).pathname === '/oauth/token') return Response.json({ error: 'invalid_grant' }, { status: 400 });
      if (new URL(request.url).pathname.endsWith('/massproperties')) return Response.json({ error: 'expired' }, { status: 401 });
      return mock.handle(request);
    });
    const response = await call('/api/scan?documentId=simple&workspaceOrVersion=w&workspaceOrVersionId=work1&elementId=elem1', cookie);
    const events = (await response.text()).trim().split('\n').map(line => JSON.parse(line));
    expect(events.some(event => event.type === 'session-expired')).toBe(true);
    expect(events.some(event => event.type === 'result')).toBe(false);
    expect((await call('/api/session', cookie)).status).toBe(401);
  });
});
