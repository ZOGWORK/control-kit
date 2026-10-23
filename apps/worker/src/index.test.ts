import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import worker, { type Env, type Kv } from './index';
import { createMockOnshape } from './mock-onshape';

class MemoryKv implements Kv {
  values = new Map<string, string>();
  async get(k: string) { return this.values.get(k) ?? null; }
  async put(k: string, v: string) { this.values.set(k, v); }
  async delete(k: string) { this.values.delete(k); }
}
const mock = createMockOnshape();
const env = { APP_STATE: new MemoryKv(), ONSHAPE_OAUTH_CLIENT_ID: 'test-id', ONSHAPE_OAUTH_CLIENT_SECRET: 'test-secret', ONSHAPE_OAUTH_REDIRECT_URI: 'http://localhost:8787/oauth/redirect', ONSHAPE_API_BASE: 'http://localhost:8788', ONSHAPE_OAUTH_BASE: 'http://localhost:8788', SESSION_ENCRYPTION_KEY: btoa('12345678901234567890123456789012'), WEB_ORIGIN: 'http://localhost:5173' } as Env & { APP_STATE: MemoryKv };
const call = (path: string, cookie?: string) => worker.fetch(new Request(`http://localhost:8787${path}`, cookie ? { headers: { cookie } } : undefined), env);
beforeAll(() => vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => mock.handle(new Request(input, init))));
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
