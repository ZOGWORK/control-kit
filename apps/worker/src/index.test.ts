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
    const start = await call('/oauth/start?documentId=doc1&workspaceId=work1&elementId=elem1');
    expect(start.status).toBe(302);
    const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
    const callback = await call(`/oauth/redirect?code=mock-code&state=${state}`);
    expect(callback.status).toBe(302);
    expect(callback.headers.get('location')).toContain('elementId=elem1');
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
  it('rejects missing context and unauthenticated proxy requests', async () => {
    expect((await call('/oauth/start')).status).toBe(400);
    expect((await call('/api/onshape/test')).status).toBe(401);
  });
});
