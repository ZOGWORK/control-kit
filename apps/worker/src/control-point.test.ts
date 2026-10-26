import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import worker, { type Env, type Kv } from './index';
import { createMockOnshape } from './mock-onshape';
import { createMockControlPoint } from './mock-control-point';
import { HttpControlPointAdapter } from './control-point';
import { seal } from './secrets';
import { buildControlPointPayload, type ScanResult } from '@control-kit/shared';

class MemoryKv implements Kv {
  values = new Map<string, string>();
  async get(k: string) { return this.values.get(k) ?? null; }
  async put(k: string, v: string) { this.values.set(k, v); }
  async delete(k: string) { this.values.delete(k); }
}
const cpOrigin = 'http://localhost:8790';
const onshape = createMockOnshape();
let cp = createMockControlPoint();
const env = { APP_STATE: new MemoryKv(), VENDOR_CATALOG: new MemoryKv(), ONSHAPE_OAUTH_CLIENT_ID: 'test-id', ONSHAPE_OAUTH_CLIENT_SECRET: 'test-secret', ONSHAPE_OAUTH_REDIRECT_URI: 'http://localhost:8787/oauth/redirect',
  ONSHAPE_API_BASE: 'http://localhost:8788', ONSHAPE_API_VERSION: 'v9', ONSHAPE_OAUTH_BASE: 'http://localhost:8788', SESSION_ENCRYPTION_KEY: btoa('12345678901234567890123456789012'), WEB_ORIGIN: 'http://localhost:5173',
  CONTROL_POINT_ORIGIN: cpOrigin, CONTROL_KIT_CLIENT_SECRET: 'cp-secret' } as Env & { APP_STATE: MemoryKv };
const cookieOf = (response: Response, name: string) => response.headers.getSetCookie().find(value => value.startsWith(`${name}=`))!.split(';')[0];
const call = (path: string, init: { cookie?: string; method?: string; body?: string; headers?: Record<string, string>; config?: Env } = {}) =>
  worker.fetch(new Request(`http://localhost:8787${path}`, { method: init.method ?? 'GET', body: init.body, headers: { origin: env.WEB_ORIGIN, ...(init.cookie ? { cookie: init.cookie } : {}), ...init.headers } }), init.config ?? env);
/** A Control Kit session through mock Onshape's OAuth, as the panel gets one. */
async function session() {
  const start = await call('/oauth/start?documentId=simple&workspaceOrVersion=w&workspaceOrVersionId=work1&elementId=elem1');
  const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
  return cookieOf(await call(`/oauth/redirect?code=mock-code&state=${state}`, { cookie: cookieOf(start, 'controlkit_oauth') }), 'controlkit_session');
}
async function scan(cookie: string): Promise<ScanResult> {
  const response = await call('/api/scan?documentId=simple&workspaceOrVersion=w&workspaceOrVersionId=work1&elementId=elem1', { cookie });
  return (await response.text()).trim().split('\n').map(row => JSON.parse(row)).find(event => event.type === 'result').result;
}
/** The popup: Worker start → Control Point's consent page (allows at once) → Worker callback. */
async function link(cookie: string) {
  const start = await call('/control-point/start', { cookie });
  expect(start.status).toBe(302);
  const consent = await cp.handle(new Request(start.headers.get('location')!));
  return call(new URL(consent.headers.get('location')!).pathname + new URL(consent.headers.get('location')!).search, { cookie: `${cookie}; ${cookieOf(start, 'controlkit_cp')}` });
}
const send = (cookie: string, scanId: string, body: string, length = new TextEncoder().encode(body).byteLength) =>
  call(`/api/control-point/send?scanId=${scanId}`, { cookie, method: 'POST', body, headers: { 'content-type': 'application/json', 'content-length': String(length) } });
const post = (cookie: string, path: string, body: unknown) => call(path, { cookie, method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  cp = createMockControlPoint();
  for (const key of [...env.APP_STATE.values.keys()]) if (key.startsWith('cp-')) env.APP_STATE.values.delete(key);
  vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    return request.url.startsWith(cpOrigin) ? cp.handle(request) : onshape.handle(request);
  });
});
afterAll(() => vi.unstubAllGlobals());

describe('Control Point linking', () => {
  it('is off without the client secret, and the popup says so', async () => {
    const config = { ...env, CONTROL_KIT_CLIENT_SECRET: '' };
    expect(await (await call('/api/control-point/link', { config })).json()).toEqual({ linked: false, available: false });
    const start = await call('/control-point/start', { cookie: await session(), config });
    expect(start.status).toBe(503);
    expect(await start.text()).toContain('control-point-link-failed');
  });
  it('links through the popup, keeps the token sealed on the server, and lists workspaces', async () => {
    const cookie = await session();
    expect(await (await call('/api/control-point/link', { cookie })).json()).toEqual({ linked: false, available: true });
    const start = await call('/control-point/start', { cookie });
    const destination = new URL(start.headers.get('location')!);
    expect(destination.origin + destination.pathname).toBe(`${cpOrigin}/connect/control-kit`);
    expect(destination.searchParams.get('redirect_uri')).toBe('http://localhost:8787/control-point/callback');
    expect(start.headers.get('set-cookie')).toMatch(/^controlkit_cp=.+; HttpOnly; Secure; SameSite=None; Path=\/control-point; Max-Age=600$/);
    const done = await link(cookie);
    expect(done.status).toBe(200);
    const page = await done.text();
    expect(page).toContain('"type":"control-point-linked"');
    expect(page).toContain('"origin":"http://localhost:5173"');
    expect(done.headers.get('set-cookie')).toContain('controlkit_cp=;');
    const stored = env.APP_STATE.values.get('cp-link:mock-user')!;
    expect(stored).not.toContain('ckp_');
    const view = await (await call('/api/control-point/link', { cookie })).json();
    expect(view).toEqual({ linked: true, available: true, account: { email: 'student@example.org', name: 'Sam' }, workspace: null, linkedAt: expect.any(String), workspaces: [
      { id: 12, name: 'HORS', ftcNumber: '6980', accentColor: '#2f6bff', canEditCad: true, cadUrl: `${cpOrigin}/cad-parts` },
      { id: 13, name: 'Scrimmage', ftcNumber: null, accentColor: null, canEditCad: false, cadUrl: `${cpOrigin}/cad-parts` },
    ] });
    expect(JSON.stringify(view)).not.toContain('ckp_');
    // The list is cached for ten minutes: a second read asks Control Point nothing.
    const asked = cp.requests.length;
    await call('/api/control-point/link', { cookie });
    expect(cp.requests.length).toBe(asked);
  });
  it('finishes only in the browser and session that started, and reports a cancel', async () => {
    const cookie = await session();
    const start = await call('/control-point/start', { cookie });
    const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
    const stateCookie = cookieOf(start, 'controlkit_cp');
    // No state cookie (another browser), a different state, or a forged code: nothing is linked.
    expect((await call(`/control-point/callback?code=x&state=${state}`, { cookie })).status).toBe(400);
    expect((await call(`/control-point/callback?code=x&state=other`, { cookie: `${cookie}; ${stateCookie}` })).status).toBe(400);
    const forged = await call(`/control-point/callback?code=made-up&state=${state}`, { cookie: `${cookie}; ${stateCookie}` });
    expect(await forged.text()).toContain('"reason":"expired"');
    // Another Control Kit person cannot finish this person's link, even with a real code and its state cookie.
    await env.APP_STATE.put('session:other-session', await seal(env, { tokens: { access_token: 'a', refresh_token: 'r' }, user: { id: 'other-user', name: 'Other' }, savedAt: Date.now() }));
    const consent = await cp.handle(new Request(start.headers.get('location')!));
    const hijack = await call(new URL(consent.headers.get('location')!).pathname + new URL(consent.headers.get('location')!).search, { cookie: `controlkit_session=other-session; ${stateCookie}` });
    expect(await hijack.text()).toContain('"reason":"expired"');
    expect(env.APP_STATE.values.has('cp-link:other-user')).toBe(false);
    cp.setDeny(true);
    const cancelled = await link(cookie);
    expect(await cancelled.text()).toContain('"reason":"cancelled"');
    expect(env.APP_STATE.values.has('cp-link:mock-user')).toBe(false);
  });
  it('picks only a listed workspace that can edit CAD', async () => {
    const cookie = await session();
    await link(cookie);
    expect((await post(cookie, '/api/control-point/workspace', { workspaceId: 99 })).status).toBe(409);
    expect(await (await post(cookie, '/api/control-point/workspace', { workspaceId: 13 })).json()).toMatchObject({ code: 'no_cad_edit' });
    const picked = await post(cookie, '/api/control-point/workspace', { workspaceId: 12 });
    expect(await picked.json()).toMatchObject({ linked: true, workspace: { id: 12, name: 'HORS', ftcNumber: '6980', accentColor: '#2f6bff', canEditCad: true } });
    expect((await call('/api/control-point/workspace', { cookie, method: 'POST', body: '{"workspaceId":12}', headers: { origin: 'https://evil.example' } })).status).toBe(403);
  });
  it('unlinks when Control Point revokes the token', async () => {
    const cookie = await session();
    await link(cookie);
    cp.revokeAll();
    // Past the ten-minute cache, the next read finds the token revoked and ends the link.
    const sealed = env.APP_STATE.values.get('cp-link:mock-user')!;
    vi.useFakeTimers({ now: Date.now() + 11 * 60_000, toFake: ['Date'] });
    try { expect(await (await call('/api/control-point/link', { cookie })).json()).toEqual({ linked: false, available: true, revoked: true }); }
    finally { vi.useRealTimers(); }
    expect(env.APP_STATE.values.has('cp-link:mock-user')).toBe(false);
    // Sending with a revoked token unlinks too.
    env.APP_STATE.values.set('cp-link:mock-user', sealed);
    const result = await scan(cookie);
    expect(await (await post(cookie, '/api/control-point/workspace', { workspaceId: 12 })).json()).toMatchObject({ code: 'revoked', linked: false });
    env.APP_STATE.values.set('cp-link:mock-user', sealed);
    const body = JSON.stringify(await buildControlPointPayload(result, { workspaceId: 12 }));
    expect((await send(cookie, result.scanId!, body)).status).toBe(409);
  });
  it('unlinks on request, revoking at Control Point, and keeps sent records', async () => {
    const cookie = await session();
    await link(cookie);
    expect((await call('/api/control-point/unlink', { cookie, method: 'POST', headers: { origin: 'https://evil.example' } })).status).toBe(403);
    const response = await call('/api/control-point/unlink', { cookie, method: 'POST' });
    expect(await response.json()).toEqual({ linked: false, available: true });
    expect(cp.requests).toContain('POST /api/integrations/control-kit/revoke');
    expect(env.APP_STATE.values.has('cp-link:mock-user')).toBe(false);
  });
});

describe('sending a BOM to Control Point', () => {
  async function ready() {
    const cookie = await session();
    await link(cookie);
    await post(cookie, '/api/control-point/workspace', { workspaceId: 12 });
    return { cookie, result: await scan(cookie) };
  }
  it('streams the bundle to the saved workspace, records it, and answers a repeat as a duplicate', async () => {
    const { cookie, result } = await ready();
    const payload = await buildControlPointPayload(result, { workspaceId: 12 });
    const body = JSON.stringify(payload);
    const first = await send(cookie, result.scanId!, body);
    expect(first.status).toBe(200);
    const answer = await first.json();
    expect(answer).toEqual({ importId: 41, duplicate: false, workspace: { id: 12, name: 'HORS', ftcNumber: '6980' }, created: payload.cadParts.length, updated: 0, markedRemoved: 0, filesStored: 0,
      url: `${cpOrigin}/cad-parts?import=41`, sentAt: expect.any(String) });
    // Control Point received the browser's bytes unchanged.
    expect(cp.received[0]).toEqual({ workspaceId: 12, payload });
    expect(cp.received[0].payload.cadParts[0].extra.identity).toBe(`${payload.cadParts[0].extra.documentId}:${payload.cadParts[0].extra.elementId}:${payload.cadParts[0].extra.partId ?? ''}:${payload.cadParts[0].extra.configuration ?? ''}`);
    const sent = await (await call(`/api/control-point/sent?documentId=${result.documentId}&elementId=${result.elementId}`, { cookie })).json();
    expect(sent).toEqual({ importId: 41, workspaceId: 12, sentAt: answer.sentAt, idempotencyKey: payload.idempotencyKey, url: `${cpOrigin}/cad-parts?import=41` });
    expect(await (await send(cookie, result.scanId!, body)).json()).toMatchObject({ importId: 41, duplicate: true });
    expect(cp.received).toHaveLength(1);
    expect(await (await call('/api/control-point/sent?documentId=other&elementId=elem1', { cookie })).json()).toBeNull();
  });
  it('refuses an oversize or undeclared body before contacting Control Point', async () => {
    const { cookie, result } = await ready();
    const asked = cp.requests.length;
    const huge = await send(cookie, result.scanId!, '{}', 12 * 1024 * 1024 + 1);
    expect(huge.status).toBe(413);
    expect(await huge.json()).toMatchObject({ code: 'too_large' });
    const body = JSON.stringify(await buildControlPointPayload(result, { workspaceId: 12 }));
    // A body longer than it declared is refused, not truncated.
    expect(await (await send(cookie, result.scanId!, body, 100)).json()).toMatchObject({ code: 'bad_payload' });
    expect(await (await send(cookie, result.scanId!, '{"not":"a bundle"}')).json()).toMatchObject({ code: 'bad_payload' });
    expect(cp.requests.length).toBe(asked);
  });
  it("refuses another person's scan, or a bundle from a different assembly", async () => {
    const { cookie, result } = await ready();
    const body = JSON.stringify(await buildControlPointPayload(result, { workspaceId: 12 }));
    env.APP_STATE.values.set('scan:other-user:11111111-1111-4111-8111-111111111111', JSON.stringify(result));
    expect(await (await send(cookie, '11111111-1111-4111-8111-111111111111', body)).json()).toMatchObject({ code: 'scan_missing' });
    const other = JSON.stringify(await buildControlPointPayload({ ...result, documentId: 'robot' }, { workspaceId: 12 }));
    expect(await (await send(cookie, result.scanId!, other)).json()).toMatchObject({ code: 'scan_mismatch' });
    expect(cp.received).toHaveLength(0);
  });
  it('passes on a workspace the account is no longer in, and a missing workspace choice', async () => {
    const { cookie, result } = await ready();
    const body = JSON.stringify(await buildControlPointPayload(result, { workspaceId: 12 }));
    cp.setWorkspaces([]);
    const refused = await send(cookie, result.scanId!, body);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ code: 'not_member', error: expect.stringContaining('no longer a member') });
    const fresh = await session();
    await link(fresh);
    expect(await (await send(fresh, result.scanId!, body)).json()).toMatchObject({ code: 'no_workspace' });
  });
  it('talks to Control Point with bounded calls the adapter checks', async () => {
    const adapter = new HttpControlPointAdapter(cpOrigin, 'wrong-secret');
    await expect(adapter.exchangeCode('code', 'http://localhost:8787/control-point/callback')).rejects.toMatchObject({ status: 401, code: 'invalid_client' });
    const { cookie, result } = await ready();
    await send(cookie, result.scanId!, JSON.stringify(await buildControlPointPayload(result, { workspaceId: 12 })));
    const consent = await cp.handle(new Request(`${cpOrigin}/connect/control-kit?state=s&redirect_uri=${encodeURIComponent('http://localhost:8787/control-point/callback')}`));
    const good = new HttpControlPointAdapter(cpOrigin, 'cp-secret');
    const { accessToken } = await good.exchangeCode(new URL(consent.headers.get('location')!).searchParams.get('code')!, 'http://localhost:8787/control-point/callback');
    expect(await good.imports(accessToken, 12, result.documentId, result.elementId)).toEqual([expect.objectContaining({ importId: 41, sentBy: 'student@example.org' })]);
  });
});

describe('assembly picture', () => {
  it('draws the scanned revision once per user and revision, counted as a preview', async () => {
    const cookie = await session();
    const result = await scan(cookie);
    const before = onshape.apiRequests;
    const first = await call(`/api/preview/assembly?scanId=${result.scanId}`, { cookie });
    expect(first.headers.get('content-type')).toBe('image/png');
    expect(new TextDecoder().decode(await first.arrayBuffer())).toBe('PNG assemblies m/mv-1');
    expect(onshape.apiRequests - before).toBe(1);
    expect(env.APP_STATE.values.has('mock-user:preview-assembly:simple:elem1:m:mv-1')).toBe(true);
    expect((await call(`/api/preview/assembly?scanId=${result.scanId}`, { cookie })).status).toBe(200);
    expect(onshape.apiRequests - before).toBe(1);
    const day = JSON.parse(env.APP_STATE.values.get(`onshape-ledger:${new Date().toISOString().slice(0, 10)}`)!);
    expect(day.byKind['shaded-view']).toBeGreaterThanOrEqual(1);
    expect(day.byPurpose.preview).toBeGreaterThanOrEqual(1);
    expect((await call('/api/preview/assembly?scanId=11111111-1111-4111-8111-111111111111', { cookie })).status).toBe(409);
  });
});
