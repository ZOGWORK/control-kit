export interface Kv { get(k: string): Promise<string | null>; put(k: string, v: string, o?: { expirationTtl: number }): Promise<void>; delete(k: string): Promise<void> }
import { scanAssembly, SessionExpiredError } from './scan';
import type { AssemblyContext } from '@control-kit/shared';

export interface Env { APP_STATE: Kv; ONSHAPE_OAUTH_CLIENT_ID: string; ONSHAPE_OAUTH_CLIENT_SECRET: string; ONSHAPE_OAUTH_REDIRECT_URI: string; ONSHAPE_API_BASE: string; ONSHAPE_API_VERSION: string; ONSHAPE_OAUTH_BASE: string; SESSION_ENCRYPTION_KEY: string; WEB_ORIGIN: string }
type Tokens = { access_token: string; refresh_token: string };
type Session = { tokens: Tokens; user: { id: string; name: string } };
type OAuthState = { context?: Record<string, string>; redirectOnshapeUri?: string };
const cookieName = 'controlkit_session';
// SameSite=None is required because Onshape embeds Control Kit in a cross-site iframe.
const cookieFlags = 'HttpOnly; Secure; SameSite=None; Path=/';
const encode = new TextEncoder();
const decode = new TextDecoder();
const random = () => crypto.randomUUID();
const reply = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
const b64 = (data: Uint8Array) => btoa(String.fromCharCode(...data));
const bytes = (data: string) => Uint8Array.from(atob(data), x => x.charCodeAt(0));
async function aesKey(env: Env) {
  const raw = bytes(env.SESSION_ENCRYPTION_KEY);
  if (raw.length !== 32) throw new Error('SESSION_ENCRYPTION_KEY must contain 32 base64-encoded bytes');
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
async function encrypt(env: Env, value: Session) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const body = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(env), encode.encode(JSON.stringify(value)));
  return `${b64(iv)}.${b64(new Uint8Array(body))}`;
}
async function decrypt(env: Env, value: string): Promise<Session> {
  const [iv, body] = value.split('.');
  return JSON.parse(decode.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes(iv) }, await aesKey(env), bytes(body)))) as Session;
}
function sessionId(request: Request) { return request.headers.get('cookie')?.match(/(?:^|;\s*)controlkit_session=([^;]+)/)?.[1] ?? null; }
async function getSession(request: Request, env: Env) {
  const id = sessionId(request);
  const value = id && await env.APP_STATE.get(`session:${id}`);
  if (!id || !value) return null;
  try { return { id, data: await decrypt(env, value) }; } catch { return null; }
}
async function save(env: Env, id: string, data: Session) { await env.APP_STATE.put(`session:${id}`, await encrypt(env, data), { expirationTtl: 2592000 }); }
function authParams(env: Env, grant: Record<string, string>) { return new URLSearchParams({ client_id: env.ONSHAPE_OAUTH_CLIENT_ID, client_secret: env.ONSHAPE_OAUTH_CLIENT_SECRET, ...grant }); }
async function exchange(env: Env, grant: Record<string, string>): Promise<Tokens> {
  const response = await fetch(`${env.ONSHAPE_OAUTH_BASE}/oauth/token`, { method: 'POST', body: authParams(env, grant), signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error(`OAuth exchange failed ${response.status}`);
  const tokens = await response.json() as Partial<Tokens>;
  if (!tokens.access_token || (!tokens.refresh_token && !grant.refresh_token)) throw new Error('Incomplete token response');
  return { access_token: tokens.access_token, refresh_token: tokens.refresh_token ?? grant.refresh_token } as Tokens;
}
async function api(env: Env, path: string, accessToken: string) { return fetch(`${env.ONSHAPE_API_BASE}${path}`, { headers: { authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(10000) }); }
async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === '/oauth/start') {
    if (!env.ONSHAPE_OAUTH_CLIENT_ID || !env.ONSHAPE_OAUTH_CLIENT_SECRET) return reply({ error: 'Control Kit OAuth setup is pending.' }, 503);
    const context = Object.fromEntries(['documentId', 'workspaceOrVersion', 'workspaceOrVersionId', 'elementId'].map(k => [k, url.searchParams.get(k)]));
    const hasContext = Object.values(context).some(Boolean);
    if (hasContext && ['documentId', 'workspaceOrVersionId', 'elementId'].some(k => !context[k] || !/^[\w-]{2,128}$/.test(context[k]!))) return reply({ error: 'Open Control Kit from an Assembly tab.' }, 400);
    if (hasContext && !['w', 'v'].includes(context.workspaceOrVersion!)) return reply({ error: 'Invalid Onshape workspace or version context.' }, 400);
    const returnUri = url.searchParams.get('redirectOnshapeUri');
    if (returnUri) {
      let parsed: URL;
      try { parsed = new URL(returnUri); } catch { return reply({ error: 'Invalid Onshape return URL.' }, 400); }
      if (parsed.protocol !== 'https:' || parsed.hostname !== 'cad.onshape.com' || parsed.username || parsed.password) return reply({ error: 'Invalid Onshape return URL.' }, 400);
    }
    const state = random();
    const stateData: OAuthState = { ...(hasContext ? { context: context as Record<string, string> } : {}), ...(returnUri ? { redirectOnshapeUri: returnUri } : {}) };
    await env.APP_STATE.put(`oauth-state:${state}`, JSON.stringify(stateData), { expirationTtl: 600 });
    const destination = new URL('/oauth/authorize', env.ONSHAPE_OAUTH_BASE);
    destination.search = new URLSearchParams({ response_type: 'code', client_id: env.ONSHAPE_OAUTH_CLIENT_ID, redirect_uri: env.ONSHAPE_OAUTH_REDIRECT_URI, state }).toString();
    return Response.redirect(destination, 302);
  }
  if (url.pathname === '/oauth/redirect') {
    const state = url.searchParams.get('state');
    const code = url.searchParams.get('code');
    if (!state || !code) return reply({ error: 'Authorization was cancelled or incomplete.' }, 400);
    const stored = await env.APP_STATE.get(`oauth-state:${state}`);
    if (!stored) return reply({ error: 'Authorization expired. Reconnect Onshape.' }, 400);
    await env.APP_STATE.delete(`oauth-state:${state}`);
    const tokens = await exchange(env, { grant_type: 'authorization_code', code, redirect_uri: env.ONSHAPE_OAUTH_REDIRECT_URI });
    const profile = await api(env, '/api/users/sessioninfo', tokens.access_token);
    if (!profile.ok) return reply({ error: 'Could not read Onshape profile.' }, 502);
    const user = await profile.json() as Session['user'];
    if (!user.id) return reply({ error: 'Onshape profile has no ID.' }, 502);
    const id = random();
    await save(env, id, { tokens, user });
    const stateData = JSON.parse(stored) as OAuthState;
    const destination = stateData.redirectOnshapeUri ? new URL(stateData.redirectOnshapeUri) : new URL('/', env.WEB_ORIGIN);
    for (const [k, v] of Object.entries(stateData.context ?? {})) destination.searchParams.set(k, v);
    return new Response(null, { status: 302, headers: { location: destination.toString(), 'set-cookie': `${cookieName}=${id}; ${cookieFlags}` } });
  }
  if (url.pathname === '/api/session') {
    if (!env.ONSHAPE_OAUTH_CLIENT_ID || !env.ONSHAPE_OAUTH_CLIENT_SECRET) return reply({ connected: false, setupPending: true });
    const current = await getSession(request, env);
    if (!current) return reply({ connected: false }, 401);
    await save(env, current.id, current.data);
    return reply({ connected: true, user: current.data.user });
  }
  if (url.pathname === '/api/logout' && request.method === 'POST') {
    const id = sessionId(request);
    if (id) await env.APP_STATE.delete(`session:${id}`);
    return new Response(null, { status: 204, headers: { 'set-cookie': `${cookieName}=; ${cookieFlags}; Max-Age=0` } });
  }
  if (url.pathname === '/api/scan' && request.method === 'GET') {
    const current = await getSession(request, env);
    if (!current) return reply({ error: 'Reconnect Onshape.' }, 401);
    const values = ['documentId', 'workspaceOrVersion', 'workspaceOrVersionId', 'elementId'].map(key => url.searchParams.get(key));
    if (values.some(value => !value || !/^[\w-]{1,128}$/.test(value))) return reply({ error: 'Open Control Kit from an Assembly tab.' }, 400);
    if (!['w', 'v', 'm'].includes(values[1]!)) return reply({ error: 'Invalid document context.' }, 400);
    const context: AssemblyContext = { documentId: values[0]!, workspaceOrVersion: values[1] as AssemblyContext['workspaceOrVersion'], workspaceOrVersionId: values[2]!, elementId: values[3]! };
    let refreshing: Promise<void> | undefined;
    const get = async (path: string, signal: AbortSignal) => {
      let response = await fetch(`${env.ONSHAPE_API_BASE}${path}`, { headers: { authorization: `Bearer ${current.data.tokens.access_token}` }, signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]) });
      if (response.status !== 401) return response;
      refreshing ??= (async () => {
        current.data.tokens = await exchange(env, { grant_type: 'refresh_token', refresh_token: current.data.tokens.refresh_token });
        await save(env, current.id, current.data);
      })();
      try { await refreshing; } catch { await env.APP_STATE.delete(`session:${current.id}`); throw new SessionExpiredError(); }
      response = await fetch(`${env.ONSHAPE_API_BASE}${path}`, { headers: { authorization: `Bearer ${current.data.tokens.access_token}` }, signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]) });
      if (response.status === 401) { await env.APP_STATE.delete(`session:${current.id}`); throw new SessionExpiredError(); }
      return response;
    };
    return scanAssembly(request, context, env.ONSHAPE_API_VERSION, get);
  }
  if (url.pathname.startsWith('/api/onshape/')) {
    const current = await getSession(request, env);
    if (!current) return reply({ error: 'Reconnect Onshape.' }, 401);
    const path = `/api/${url.pathname.slice('/api/onshape/'.length)}${url.search}`;
    let result = await api(env, path, current.data.tokens.access_token);
    if (result.status === 401) {
      try {
        current.data.tokens = await exchange(env, { grant_type: 'refresh_token', refresh_token: current.data.tokens.refresh_token });
        await save(env, current.id, current.data);
        result = await api(env, path, current.data.tokens.access_token);
      } catch {
        await env.APP_STATE.delete(`session:${current.id}`);
        return new Response(JSON.stringify({ error: 'Reconnect Onshape.' }), { status: 401, headers: { 'content-type': 'application/json', 'set-cookie': `${cookieName}=; ${cookieFlags}; Max-Age=0` } });
      }
    }
    if (result.status === 401) { await env.APP_STATE.delete(`session:${current.id}`); return reply({ error: 'Reconnect Onshape.' }, 401); }
    return new Response(result.body, { status: result.status, headers: { 'content-type': result.headers.get('content-type') ?? 'application/json', 'cache-control': 'no-store' } });
  }
  return reply({ error: 'Not found' }, 404);
}
export default {
  async fetch(request: Request, env: Env) {
    const origin = request.headers.get('origin');
    if (request.method === 'OPTIONS' && origin === env.WEB_ORIGIN) return new Response(null, { status: 204, headers: { 'access-control-allow-origin': origin, 'access-control-allow-credentials': 'true', 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-allow-headers': 'content-type' } });
    let result: Response;
    try { result = await route(request, env); }
    catch (error) { console.error('Control Kit request failed', error); result = reply({ error: 'Control Kit could not complete this request. Try again.' }, 502); }
    if (origin === env.WEB_ORIGIN) { result.headers.set('access-control-allow-origin', origin); result.headers.set('access-control-allow-credentials', 'true'); result.headers.set('vary', 'Origin'); }
    return result;
  },
  scheduled() { /* Vendor ingestion begins in M4. */ },
};
