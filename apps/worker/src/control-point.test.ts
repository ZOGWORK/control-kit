import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AiAllowance, type GateRequest } from './ai-allowance';
import worker, { type Env, type Kv } from './index';
import { createMockOnshape } from './mock-onshape';
import { createMockControlPoint } from './mock-control-point';
import { HttpControlPointAdapter } from './control-point';
import { seal, unseal } from './secrets';
import { aiReviewInstructions, buildControlPointPayload, controlPointPictureKey, pictureTargets, type ScanResult } from '@control-kit/shared';

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
const send = (cookie: string, scanId: string, body: string, length = new TextEncoder().encode(body).byteLength, workspaceId: number | null = 12) =>
  call(`/api/control-point/send?scanId=${scanId}${workspaceId === null ? '' : `&workspaceId=${workspaceId}`}`, { cookie, method: 'POST', body, headers: { 'content-type': 'application/json', 'content-length': String(length) } });
/** Holds the first Control Point call whose path matches until `release`, so a test can act while it is in flight. */
function holdOnce(pattern: RegExp) {
  let release!: () => void;
  let reached!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const arrived = new Promise<void>(resolve => { reached = resolve; });
  let held = false;
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    if (!request.url.startsWith(cpOrigin)) return onshape.handle(request);
    if (!held && pattern.test(new URL(request.url).pathname)) { held = true; reached(); await gate; }
    return cp.handle(request);
  });
  return { arrived, release };
}
const storedLink = async () => {
  const raw = env.APP_STATE.values.get('cp-link:mock-user');
  return raw ? unseal<{ token: string; workspaceId: number | null }>(env, raw) : null;
};
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
    expect(view).toEqual({ linked: true, available: true, account: { email: 'student@example.org', name: 'Sam' }, workspace: null, linkedAt: expect.any(String), refreshAfter: expect.any(String), workspaces: [
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
  it('checks Control Point again on request, at most every 30 seconds', async () => {
    const cookie = await session();
    await link(cookie);
    const first = await (await call('/api/control-point/link', { cookie })).json() as { refreshAfter: string };
    const joined = { id: 15, name: 'New team', ftcNumber: null, accentColor: null, canEditCad: true, cadUrl: `${cpOrigin}/cad-parts` };
    cp.setWorkspaces([joined]);
    // Within 30 seconds of the last read, "Check again" serves the cached list and says when it may ask again.
    const early = await (await call('/api/control-point/link?refresh=1', { cookie })).json() as { workspaces: Array<{ id: number }>; refreshAfter: string };
    expect(early.workspaces.map(item => item.id)).toEqual([12, 13]);
    expect(early.refreshAfter).toBe(first.refreshAfter);
    expect(Date.parse(early.refreshAfter)).toBeGreaterThan(Date.now());
    vi.useFakeTimers({ now: Date.parse(early.refreshAfter) + 1, toFake: ['Date'] });
    try {
      // Without refresh=1 the ten-minute cache still holds.
      expect((await (await call('/api/control-point/link', { cookie })).json() as { workspaces: Array<{ id: number }> }).workspaces.map(item => item.id)).toEqual([12, 13]);
      const late = await (await call('/api/control-point/link?refresh=1', { cookie })).json() as { workspaces: Array<{ id: number }>; refreshAfter: string };
      expect(late.workspaces).toEqual([joined]);
      expect(Date.parse(late.refreshAfter)).toBe(Date.now() + 30_000);
      // A refresh Control Point fails also starts the pause: the next "Check again" within 30 seconds asks nothing.
      vi.setSystemTime(Date.now() + 31_000);
      cp.setFailure(503);
      const asked = cp.requests.length;
      const failed = await (await call('/api/control-point/link?refresh=1', { cookie })).json() as { stale?: boolean; refreshAfter: string };
      expect(failed).toMatchObject({ stale: true, refreshAfter: new Date(Date.now() + 30_000).toISOString() });
      expect(cp.requests.length).toBe(asked + 1);
      await call('/api/control-point/link?refresh=1', { cookie });
      expect(cp.requests.length).toBe(asked + 1);
    } finally { vi.useRealTimers(); }
  });
  it('pauses 30 seconds after a failed refresh, with no cached list or an expired one', async () => {
    const cookie = await session();
    await link(cookie);
    cp.setFailure(503);
    // No cached list yet: the first read asks once, then neither a plain read nor "Check again" asks within 30 seconds.
    let asked = cp.requests.length;
    expect(await (await call('/api/control-point/link', { cookie })).json()).toMatchObject({ linked: true, workspaces: [], stale: true });
    expect(cp.requests.length).toBe(asked + 1);
    await call('/api/control-point/link?refresh=1', { cookie });
    await call('/api/control-point/link', { cookie });
    expect(cp.requests.length).toBe(asked + 1);
    vi.useFakeTimers({ now: Date.now() + 31_000, toFake: ['Date'] });
    try {
      cp.setFailure(null);
      expect((await (await call('/api/control-point/link', { cookie })).json() as { workspaces: unknown[] }).workspaces).toHaveLength(2);
      // An expired list: one failed read, then the cached list (marked stale) with no call for 30 seconds.
      vi.setSystemTime(Date.now() + 11 * 60_000);
      cp.setFailure(503);
      asked = cp.requests.length;
      expect(await (await call('/api/control-point/link?refresh=1', { cookie })).json()).toMatchObject({ stale: true, workspaces: [{ id: 12 }, { id: 13 }] });
      expect(await (await call('/api/control-point/link', { cookie })).json()).toMatchObject({ stale: true, workspaces: [{ id: 12 }, { id: 13 }] });
      await call('/api/control-point/link?refresh=1', { cookie });
      expect(cp.requests.length).toBe(asked + 1);
    } finally { vi.useRealTimers(); }
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
  it('keeps a workspace picked or a link made while an older refresh was waiting on Control Point', async () => {
    const cookie = await session();
    await link(cookie);
    vi.useFakeTimers({ now: Date.now() + 11 * 60_000, toFake: ['Date'] });
    try {
      // A slow refresh started before the workspace was picked must not put back the old choice.
      let held = holdOnce(/\/workspaces$/);
      const slow = call('/api/control-point/link', { cookie });
      await held.arrived;
      expect(await (await post(cookie, '/api/control-point/workspace', { workspaceId: 12 })).json()).toMatchObject({ workspace: { id: 12 } });
      held.release();
      expect(await (await slow).json()).toMatchObject({ linked: true, workspace: { id: 12 } });
      expect((await storedLink())?.workspaceId).toBe(12);
      // Linking again (which revokes the old token) while a refresh with the old token waits: its late 401 leaves the new link.
      vi.setSystemTime(Date.now() + 11 * 60_000);
      const before = (await storedLink())!.token;
      held = holdOnce(/\/workspaces$/);
      const late = call('/api/control-point/link', { cookie });
      await held.arrived;
      await link(cookie);
      const after = (await storedLink())!.token;
      expect(after).not.toBe(before);
      held.release();
      expect(await (await late).json()).toMatchObject({ linked: true, workspace: null });
      expect((await storedLink())?.token).toBe(after);
    } finally { vi.useRealTimers(); }
  });
  it('keeps a link finished in another window while an unlink waited on revoke', async () => {
    const cookie = await session();
    await link(cookie);
    const before = (await storedLink())!.token;
    const held = holdOnce(/\/revoke$/);
    const unlinking = call('/api/control-point/unlink', { cookie, method: 'POST' });
    await held.arrived;
    await link(cookie);
    const after = (await storedLink())!.token;
    expect(after).not.toBe(before);
    held.release();
    expect(await (await unlinking).json()).toMatchObject({ linked: true });
    expect((await storedLink())?.token).toBe(after);
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
  it('sends only to the workspace the button named', async () => {
    const { cookie, result } = await ready();
    const body = JSON.stringify(await buildControlPointPayload(result, { workspaceId: 12 }));
    expect(await (await send(cookie, result.scanId!, body, undefined, null)).json()).toMatchObject({ code: 'bad_request' });
    const changed = await send(cookie, result.scanId!, body, undefined, 13);
    expect(changed.status).toBe(409);
    expect(await changed.json()).toMatchObject({ code: 'workspace_changed', error: expect.stringContaining('workspace changed') });
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
  it('keeps a link made while a send with the replaced token was in flight', async () => {
    const { cookie, result } = await ready();
    const body = JSON.stringify(await buildControlPointPayload(result, { workspaceId: 12 }));
    const before = (await storedLink())!.token;
    const held = holdOnce(/\/bom$/);
    const sending = send(cookie, result.scanId!, body);
    await held.arrived;
    await link(cookie);
    held.release();
    expect(await (await sending).json()).toMatchObject({ code: 'revoked' });
    const now = await storedLink();
    expect(now?.token).toBeTruthy();
    expect(now?.token).not.toBe(before);
    expect(await (await call('/api/control-point/link', { cookie })).json()).toMatchObject({ linked: true });
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

describe('choices made in Control Point', () => {
  async function ready() {
    const cookie = await session();
    await link(cookie);
    await post(cookie, '/api/control-point/workspace', { workspaceId: 12 });
    return { cookie, result: await scan(cookie) };
  }
  const identity = (line: ScanResult['lines'][number]) => `${line.documentId}:${line.elementId}:${line.partId ?? ''}:${line.configuration ?? ''}`;
  const choices = async (cookie: string, result: ScanResult) => (await (await post(cookie, '/api/choices', { documentId: result.documentId, scanId: result.scanId })).json()).choices;

  it("saves a newer type and product as Control Kit's own, once, and skips parts outside the scan", async () => {
    const { cookie, result } = await ready();
    const [first, second] = result.lines;
    cp.setDecisions(12, result.documentId, [
      { identity: identity(first), elementId: first.elementId, type: { value: 'print', by: 'Lee', at: '2026-10-26T18:00:00.000Z' }, product: null },
      { identity: identity(second), elementId: second.elementId, type: null, product: { vendor: 'gobilda', normalizedSku: '1611001408', by: 'Lee', at: '2026-10-26T18:01:00.000Z' } },
      { identity: 'other:doc:part:', elementId: 'x', type: { value: 'cnc', by: 'Lee', at: '2026-10-26T18:02:00.000Z' }, product: null },
    ]);
    const pull = () => post(cookie, '/api/control-point/decisions', { documentId: result.documentId, scanId: result.scanId });
    const answer = await pull();
    expect(answer.status).toBe(200);
    expect(await answer.json()).toEqual({ types: 1, products: 1 });
    const saved = await choices(cookie, result);
    expect(saved[first.bomLineKey]).toMatchObject({ disposition: 'print', dispositionBy: 'Lee in Control Point', dispositionAt: '2026-10-26T18:00:00.000Z' });
    expect(saved[second.bomLineKey].decision).toEqual({ status: 'confirmed', vendorId: 'gobilda', normalizedSku: '1611001408', at: '2026-10-26T18:01:00.000Z' });
    // History keeps the change, like a person's save.
    expect([...env.APP_STATE.values.keys()].some(key => key.startsWith(`disposition-change:${result.documentId}:`))).toBe(true);
    // Unchanged: nothing written again.
    const writes = env.APP_STATE.values.size;
    expect(await (await pull()).json()).toEqual({ types: 0, products: 0 });
    expect(env.APP_STATE.values.size).toBe(writes);
  });

  it('keeps a later choice made in Control Kit', async () => {
    const { cookie, result } = await ready();
    const line = result.lines[0];
    const later = await post(cookie, '/api/classification/override', { documentId: result.documentId, scanId: result.scanId, identity: identity(line), classification: 'cnc' });
    expect(later.status).toBe(200);
    cp.setDecisions(12, result.documentId, [{ identity: identity(line), elementId: line.elementId, type: { value: 'print', by: 'Lee', at: '2020-01-01T00:00:00.000Z' }, product: null }]);
    expect(await (await post(cookie, '/api/control-point/decisions', { documentId: result.documentId, scanId: result.scanId })).json()).toEqual({ types: 0, products: 0 });
    expect((await choices(cookie, result))[line.bomLineKey].disposition).toBe('cnc');
  });

  it('clears an older per-person type when Control Point resets the part', async () => {
    const { cookie, result } = await ready();
    const line = result.lines[1];
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(identity(line)))), byte => byte.toString(16).padStart(2, '0')).join('');
    env.APP_STATE.values.set(`override:mock-user:${result.documentId}:${digest}`, 'printed');
    expect((await choices(cookie, result))[line.bomLineKey].disposition).toBe('print');
    cp.setDecisions(12, result.documentId, [{ identity: identity(line), elementId: line.elementId, type: { value: null, by: 'Lee', at: '2026-10-26T19:00:00.000Z' }, product: null }]);
    expect(await (await post(cookie, '/api/control-point/decisions', { documentId: result.documentId, scanId: result.scanId })).json()).toEqual({ types: 1, products: 0 });
    expect((await choices(cookie, result))[line.bomLineKey]).toMatchObject({ disposition: null, dispositionBy: 'Lee in Control Point' });
    expect(env.APP_STATE.values.has(`override:mock-user:${result.documentId}:${digest}`)).toBe(false);
  });

  it("needs the person's own scan and a chosen workspace, and ends the link when Control Point revokes it", async () => {
    const cookie = await session();
    const result = await scan(cookie);
    expect((await post(cookie, '/api/control-point/decisions', { documentId: result.documentId, scanId: result.scanId })).status).toBe(409);
    await link(cookie);
    expect(await (await post(cookie, '/api/control-point/decisions', { documentId: result.documentId, scanId: result.scanId })).json()).toMatchObject({ code: 'no_workspace' });
    await post(cookie, '/api/control-point/workspace', { workspaceId: 12 });
    expect((await post(cookie, '/api/control-point/decisions', { documentId: 'elsewhere', scanId: result.scanId })).status).toBe(409);
    cp.revokeAll();
    expect(await (await post(cookie, '/api/control-point/decisions', { documentId: result.documentId, scanId: result.scanId })).json()).toMatchObject({ code: 'revoked', linked: false });
    expect(await storedLink()).toBeNull();
  });

  it('drops decisions that are not what the contract allows', async () => {
    const { readDecision } = await import('./control-point');
    expect(readDecision({ identity: 'a:b:c:', elementId: 'b', type: { value: 'review', by: 'x', at: '2026-10-26T00:00:00Z' } })).toBeNull();
    expect(readDecision({ identity: 'a:b:c:', elementId: 'b', product: { vendor: 'mcmaster', normalizedSku: 'X1', at: '2026-10-26T00:00:00Z' } })).toBeNull();
    expect(readDecision({ identity: 'a:b:c:', elementId: 'b', type: { value: null, by: 'Lee', at: '2026-10-26T00:00:00Z' } })).toMatchObject({ type: { value: null } });
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
  it('draws each view once per revision, and treats an unknown view as isometric', async () => {
    const cookie = await session();
    const result = await scan(cookie);
    const before = onshape.apiRequests;
    const top = await call(`/api/preview/assembly?scanId=${result.scanId}&view=top`, { cookie });
    expect(new TextDecoder().decode(await top.arrayBuffer())).toBe('PNG assemblies m/mv-1 top');
    expect(top.headers.get('x-picture-drawn')).toBeNull();
    expect(env.APP_STATE.values.has('mock-user:preview-assembly:simple:elem1:m:mv-1:top')).toBe(true);
    await call(`/api/preview/assembly?scanId=${result.scanId}&view=top`, { cookie });
    expect(onshape.apiRequests - before).toBe(1);
    expect(new TextDecoder().decode(await (await call(`/api/preview/assembly?scanId=${result.scanId}&view=sideways`, { cookie })).arrayBuffer())).toBe('PNG assemblies m/mv-1');
  });
  it('redraws the assembly as it is now, at most once a minute, until a newer scan', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const cookie = await session();
      const result = await scan(cookie);
      const redraw = (view = 'isometric', wvm = 'w', wvmId = 'work1') => call(`/api/preview/assembly/redraw?scanId=${result.scanId}&view=${view}&wvm=${wvm}&wvmId=${wvmId}`, { cookie, method: 'POST' });
      vi.setSystemTime(Date.now() + 1000);
      const before = onshape.apiRequests;
      const first = await redraw();
      expect(new TextDecoder().decode(await first.arrayBuffer())).toBe('PNG assemblies w/work1');
      expect(first.headers.get('x-picture-drawn')).toBeTruthy();
      // In this panel's workspace the scan's picture is now the redrawn one, served without another request.
      const shown = await call(`/api/preview/assembly?scanId=${result.scanId}&wvm=w&wvmId=work1`, { cookie });
      expect(new TextDecoder().decode(await shown.arrayBuffer())).toBe('PNG assemblies w/work1');
      expect(shown.headers.get('x-picture-drawn')).toBe(first.headers.get('x-picture-drawn'));
      // Another branch, or a panel that names none, still sees the scanned picture.
      expect(new TextDecoder().decode(await (await call(`/api/preview/assembly?scanId=${result.scanId}&wvm=w&wvmId=branch2`, { cookie })).arrayBuffer())).toBe('PNG assemblies m/mv-1');
      expect((await call(`/api/preview/assembly?scanId=${result.scanId}`, { cookie })).headers.get('x-picture-drawn')).toBeNull();
      const again = await redraw();
      expect(again.status).toBe(429);
      expect((await again.json() as { retryAfter: number }).retryAfter).toBeGreaterThan(0);
      // Each view has its own minute, and a version context draws that version.
      expect(new TextDecoder().decode(await (await redraw('front', 'v', 'ver1')).arrayBuffer())).toBe('PNG assemblies v/ver1 front');
      vi.setSystemTime(Date.now() + 61_000);
      expect((await redraw()).status).toBe(200);
      expect(onshape.apiRequests - before).toBe(3);
      // A later scan reads a newer revision, so its own picture wins again.
      vi.setSystemTime(Date.now() + 1000);
      const newer = await scan(cookie);
      expect(new TextDecoder().decode(await (await call(`/api/preview/assembly?scanId=${newer.scanId}&wvm=w&wvmId=work1`, { cookie })).arrayBuffer())).toBe('PNG assemblies m/mv-1');
      expect((await redraw('isometric', 'x')).status).toBe(400);
      expect((await call(`/api/preview/assembly/redraw?scanId=${result.scanId}&wvm=w&wvmId=work1`, { cookie, method: 'POST', headers: { origin: 'https://evil.example' } })).status).toBe(403);
    } finally { vi.useRealTimers(); }
  });
  it('lets only one of two simultaneous redraws reach Onshape', async () => {
    const instance = new AiAllowance(memoryStorage());
    const gates = { idFromName: (name: string) => name, get: () => ({ fetch: (request: Request) => instance.fetch(request) }) };
    const config = { ...env, AI_ALLOWANCE: gates } as Env;
    const cookie = await session();
    const result = await scan(cookie);
    const before = onshape.apiRequests;
    const both = await Promise.all([1, 2].map(() => call(`/api/preview/assembly/redraw?scanId=${result.scanId}&view=right&wvm=w&wvmId=work1`, { cookie, method: 'POST', config })));
    expect(both.map(response => response.status).sort()).toEqual([200, 429]);
    expect(onshape.apiRequests - before).toBe(1);
  });
});

describe('files and pictures after a send (contract v1.2 §6)', () => {
  async function sent() {
    const cookie = await session();
    await link(cookie);
    await post(cookie, '/api/control-point/workspace', { workspaceId: 12 });
    const result = await scan(cookie);
    const zip = new TextEncoder().encode('PK step files for every part');
    const payload = await buildControlPointPayload(result, { workspaceId: 12, files: [{ name: 'Robot STEP.zip', mediaType: 'application/zip', bytes: zip }] });
    const answer = await (await send(cookie, result.scanId!, JSON.stringify(payload))).json() as { importId: number };
    return { cookie, result, zip, payload, importId: answer.importId };
  }
  const hex = async (bytes: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes)))].map(value => value.toString(16).padStart(2, '0')).join('');
  const upload = async (cookie: string, result: ScanResult, importId: number, bytes: Uint8Array, opts: { name?: string; length?: number; workspaceId?: number; hash?: string } = {}) =>
    call(`/api/control-point/file?${new URLSearchParams({ documentId: result.documentId, elementId: result.elementId, importId: String(importId), workspaceId: String(opts.workspaceId ?? 12), name: opts.name ?? 'Robot STEP.zip' })}`,
      { cookie, method: 'POST', body: new TextDecoder().decode(bytes), headers: { 'content-type': 'application/zip', 'content-length': String(opts.length ?? bytes.byteLength), 'x-content-sha256': opts.hash ?? await hex(bytes) } });

  it('never puts the STEP zip inside the bundle: it is a reference uploaded after, so its key does not change', async () => {
    const { payload, result } = await sent();
    expect(payload.files).toEqual([expect.objectContaining({ name: 'Robot STEP.zip', delivery: 'reference', reason: 'Uploaded right after this bundle.' })]);
    expect(payload.idempotencyKey).toBe((await buildControlPointPayload(result, { workspaceId: 12 })).idempotencyKey);
  });
  it('streams the zip to that import, records it on the send, and recognises the same bytes again', async () => {
    const { cookie, result, zip, importId } = await sent();
    const first = await upload(cookie, result, importId, zip);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ name: 'Robot STEP.zip', url: `${cpOrigin}/api/files/1`, sizeBytes: zip.byteLength, sha256: await hex(zip), duplicate: false });
    expect(cp.uploads).toEqual([expect.objectContaining({ importId, name: 'Robot STEP.zip', mediaType: 'application/zip', bytes: zip })]);
    const record = await (await call(`/api/control-point/sent?documentId=${result.documentId}&elementId=${result.elementId}`, { cookie })).json();
    expect(record).toMatchObject({ importId, files: ['Robot STEP.zip'] });
    expect(await (await upload(cookie, result, importId, zip)).json()).toMatchObject({ duplicate: true });
    expect(cp.uploads).toHaveLength(1);
  });
  it('refuses another import, another workspace, a wrong hash, an oversize or overlong body, and a revoked grant', async () => {
    const { cookie, result, zip, importId } = await sent();
    const asked = cp.requests.length;
    expect(await (await upload(cookie, result, importId + 1, zip)).json()).toMatchObject({ code: 'not_sent' });
    expect(await (await upload(cookie, result, importId, zip, { workspaceId: 13 })).json()).toMatchObject({ code: 'workspace_changed' });
    expect((await upload(cookie, result, importId, zip, { length: 64 * 1024 * 1024 + 1 })).status).toBe(413);
    expect(cp.requests.length).toBe(asked);
    expect(await (await upload(cookie, result, importId, zip, { hash: '0'.repeat(64) })).json()).toMatchObject({ code: 'checksum_mismatch' });
    // More bytes than declared are cut off with an error, never sent short.
    expect((await upload(cookie, result, importId, zip, { length: 4 })).status).not.toBe(200);
    expect(cp.uploads).toHaveLength(0);
    cp.revokeAll();
    expect(await (await upload(cookie, result, importId, zip)).json()).toMatchObject({ code: 'revoked' });
    expect(await storedLink()).toBeNull();
  });
  it('lists and uploads part pictures for that import, through the Worker without reading them', async () => {
    const { cookie, result, importId } = await sent();
    const where = new URLSearchParams({ documentId: result.documentId, elementId: result.elementId, importId: String(importId), workspaceId: '12' });
    expect(await (await call(`/api/control-point/pictures?${where}`, { cookie })).json()).toEqual({ pictures: [] });
    const [target] = pictureTargets(result);
    const key = await controlPointPictureKey(result, target.line);
    expect(key).toMatch(/^m:mv-1:[0-9a-f]{16}$/);
    const body = JSON.stringify({ pictures: [{ identity: target.identity, key, contentBase64: btoa('PNG part') }] });
    const stored = await call(`/api/control-point/pictures?${where}`, { cookie, method: 'POST', body, headers: { 'content-type': 'application/json', 'content-length': String(body.length) } });
    expect(await stored.json()).toEqual({ stored: 1, unchanged: 0, unknown: 0, rejected: 0 });
    expect(await (await call(`/api/control-point/pictures?${where}`, { cookie })).json()).toEqual({ pictures: [{ identity: target.identity, key }] });
    const big = await call(`/api/control-point/pictures?${where}`, { cookie, method: 'POST', body, headers: { 'content-type': 'application/json', 'content-length': String(8 * 1024 * 1024 + 1) } });
    expect(big.status).toBe(413);
  });
  it('serves a part picture already drawn with cached=1, and never asks Onshape for one that is not', async () => {
    const cookie = await session();
    const result = await scan(cookie);
    const line = pictureTargets(result)[0].line;
    const path = `/api/preview?${new URLSearchParams({ scanId: result.scanId!, line: line.bomLineKey })}`;
    const before = onshape.apiRequests;
    const missing = await call(`${path}&cached=1`, { cookie });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ code: 'not_cached' });
    expect(onshape.apiRequests).toBe(before);
    expect((await call(path, { cookie })).status).toBe(200);
    expect(onshape.apiRequests).toBe(before + 1);
    const cached = await call(`${path}&cached=1`, { cookie });
    expect(cached.headers.get('content-type')).toBe('image/png');
    expect(onshape.apiRequests).toBe(before + 1);
  });
});

describe('AI review through Control Point (contract v1.2 §7)', () => {
  const allowance = () => { const instance = new AiAllowance(memoryStorage()); return { idFromName: () => 'global', get: () => ({ fetch: (request: Request) => instance.fetch(request) }) }; };
  const aiEnv = () => ({ ...env, AI_ALLOWANCE: allowance() }) as Env;
  async function ready(config: Env) {
    const cookie = await session();
    await link(cookie);
    await post(cookie, '/api/control-point/workspace', { workspaceId: 12 });
    const result = await scan(cookie);
    const line = result.lines[0];
    const request = { version: 1, assembly: result.assemblyName, leftOut: 0, lines: [{ id: 'L1', name: line.name, description: null, material: null, partNumber: null, configuration: [], usedIn: [], quantity: 1,
      source: 'this document', current: { disposition: 'review', suggestion: null, match: 'unmatched', reason: null, packUnknown: false }, candidates: [] }] };
    const review = () => call('/api/ai/review', { cookie, config, method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ documentId: result.documentId, scanId: result.scanId, request, keys: { L1: line.bomLineKey } }) });
    return { cookie, result, review };
  }
  // Saved answers would otherwise carry from one test to the next.
  beforeEach(() => { for (const key of [...env.APP_STATE.values.keys()]) if (key.startsWith('ai-')) env.APP_STATE.values.delete(key); });

  it('is enabled for a person linked with a workspace when this Worker has no key, and says so', async () => {
    const config = aiEnv();
    const cookie = await session();
    expect(await (await call('/api/ai/status', { cookie, config })).json()).toEqual({ enabled: false, linkToEnable: true });
    await link(cookie);
    expect(await (await call('/api/ai/status', { cookie, config })).json()).toMatchObject({ enabled: false });
    await post(cookie, '/api/control-point/workspace', { workspaceId: 12 });
    expect(await (await call('/api/ai/status', { cookie, config })).json()).toEqual({ enabled: true, via: 'control-point' });
    // This Worker's own key wins.
    expect(await (await call('/api/ai/status', { cookie, config: { ...config, GEMINI_API_KEY: 'own' } as Env })).json()).toEqual({ enabled: true, via: 'control-kit' });
    expect(await (await call('/api/ai/status', { cookie, config: { ...config, AI_ALLOWANCE: undefined } as Env })).json()).toEqual({ enabled: false });
  });
  it('forwards the rebuilt request with the bearer token, keeps only valid items, and caches the answer here', async () => {
    const config = aiEnv();
    const { review, result } = await ready(config);
    cp.setAiAnswer({ status: 200, body: { items: [
      { id: 'L1', disposition: 'print', candidateId: null, confidence: 0.8, reason: 'Team-designed bracket' },
      { id: 'L9', disposition: 'buy', candidateId: null, confidence: 0.9, reason: 'Not asked' },
      { id: 'L1', disposition: 'buy', candidateId: 'rev:REV311152', confidence: 0.9, reason: 'Invented SKU' },
    ], provider: 'gemini', usage: { inputTokens: 100, outputTokens: 20 } } });
    const first = await review();
    expect(first.status).toBe(200);
    const body = await first.json();
    expect(body).toEqual({ items: [{ id: 'L1', disposition: 'print', candidateId: null, confidence: 0.8, reason: 'Team-designed bracket' }], provider: 'gemini', cached: false, usage: { inputTokens: 100, outputTokens: 20 }, via: 'control-point' });
    expect(JSON.stringify(body)).not.toContain('ckp_');
    expect(cp.aiAsks).toHaveLength(1);
    const ask = cp.aiAsks[0];
    expect(ask.workspaceId).toBe(12);
    expect(ask.ask).toMatchObject({ instructions: aiReviewInstructions, schema: expect.any(Object), geminiSchema: expect.any(Object), request: { version: 1, assembly: result.assemblyName, lines: [expect.objectContaining({ id: 'L1', name: result.lines[0].name })] } });
    expect(cp.requests).toContain('POST /api/integrations/control-kit/workspaces/12/ai/review');
    // The same request again is the saved answer: no second call to Control Point.
    expect(await (await review()).json()).toMatchObject({ cached: true, via: 'control-point' });
    expect(cp.aiAsks).toHaveLength(1);
  });
  it('passes on Control Point refusals in plain words, and ends the link on a revoked token', async () => {
    const config = aiEnv();
    const { review } = await ready(config);
    cp.setAiAnswer(null);
    const off = await review();
    expect(off.status).toBe(501);
    expect(await off.json()).toMatchObject({ code: 'ai_unavailable' });
    cp.setAiAnswer({ status: 429, body: { error: 'rate_limited' } });
    expect((await review()).status).toBe(429);
    cp.setAiAnswer({ status: 502, body: { error: 'ai_failed' } });
    expect((await review()).status).toBe(502);
    expect(cp.aiAsks).toHaveLength(3);
    cp.revokeAll();
    const gone = await review();
    expect(gone.status).toBe(409);
    expect(await gone.json()).toMatchObject({ code: 'revoked', linked: false });
    expect(await storedLink()).toBeNull();
    // Unlinked and without a key of its own, the review is off again.
    expect((await review()).status).toBe(501);
  });
});

describe('redraw pauses', () => {
  it('holds a pause atomically, gives a failed one back, and keeps a newer one', async () => {
    const instance = new AiAllowance(memoryStorage());
    let now = 1_000_000;
    instance.now = () => now;
    const gate = (body: GateRequest) => instance.gate(body);
    const first = await gate({ action: 'gate', key: 'a', pauseMs: 60_000 });
    expect(first).toEqual({ ok: true, until: 1_060_000 });
    expect(await gate({ action: 'gate', key: 'a', pauseMs: 60_000 })).toEqual({ ok: false, retryAfterMs: 60_000 });
    expect((await gate({ action: 'gate', key: 'b', pauseMs: 60_000 })).ok).toBe(true);
    // A failed redraw gives its own pause back, so the person can try again at once.
    await gate({ action: 'ungate', key: 'a', until: (first as { until: number }).until });
    const second = await gate({ action: 'gate', key: 'a', pauseMs: 60_000 });
    expect(second.ok).toBe(true);
    // An old caller's give-back never removes a newer pause.
    await gate({ action: 'ungate', key: 'a', until: 1 });
    expect((await gate({ action: 'gate', key: 'a', pauseMs: 60_000 })).ok).toBe(false);
    now += 61_000;
    expect((await gate({ action: 'gate', key: 'a', pauseMs: 60_000 })).ok).toBe(true);
  });
});

function memoryStorage() {
  const store = new Map<string, unknown>();
  return { storage: {
    get: async <T>(key: string) => store.get(key) as T | undefined, put: async (key: string, value: unknown) => { store.set(key, value); },
    delete: async (key: string) => store.delete(key),
    list: async <T>({ prefix }: { prefix: string }) => new Map([...store].filter(([key]) => key.startsWith(prefix))) as Map<string, T>,
  } };
}
