export interface Kv { get(k: string): Promise<string | null>; put(k: string, v: string, o?: { expirationTtl: number }): Promise<void>; delete(k: string): Promise<void> }
import { loadClassificationOverrides, scanAssembly, SessionExpiredError } from './scan';
import { applyMatchDecision, classificationIdentity, classifyScan, type AssemblyContext, type BomLine, type ClassificationOverride, type MatchDecision, type ScanResult, type UserSettings } from '@control-kit/shared';
import { runVendor } from './vendor-ingest';
import { buildStlZip } from './stl-zip';

export interface Env { APP_STATE: Kv; VENDOR_CATALOG: Kv; ONSHAPE_OAUTH_CLIENT_ID: string; ONSHAPE_OAUTH_CLIENT_SECRET: string; ONSHAPE_OAUTH_REDIRECT_URI: string; ONSHAPE_API_BASE: string; ONSHAPE_API_VERSION: string; ONSHAPE_OAUTH_BASE: string; SESSION_ENCRYPTION_KEY: string; WEB_ORIGIN: string; VENDOR_STALE_HOURS?: string }
type Tokens = { access_token: string; refresh_token: string };
type Session = { tokens: Tokens; user: { id: string; name: string } };
type OAuthState = { context?: Record<string, string>; redirectOnshapeUri?: string };
const cookieName = 'controlkit_session';
// SameSite=None is required because Onshape embeds Control Kit in a cross-site iframe.
const cookieFlags = 'HttpOnly; Secure; SameSite=None; Path=/';
const encode = new TextEncoder();
const decode = new TextDecoder();
const random = () => crypto.randomUUID();
async function lineKeyDigest(lineKey: string) {
  const digest = await crypto.subtle.digest('SHA-256', encode.encode(lineKey));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}
async function matchDecisionKey(userId: string, documentId: string, lineKey: string) { return `match-decision:${userId}:${documentId}:${await lineKeyDigest(lineKey)}`; }
async function classificationKey(userId: string, documentId: string, identity: string) { return `override:${userId}:${documentId}:${await lineKeyDigest(identity)}`; }
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
function authParams(env: Env, grant: Record<string, string>) { return new URLSearchParams({ client_id: env.ONSHAPE_OAUTH_CLIENT_ID.trim(), client_secret: env.ONSHAPE_OAUTH_CLIENT_SECRET.trim(), ...grant }); }
async function exchange(env: Env, grant: Record<string, string>): Promise<Tokens> {
  const response = await fetch(`${env.ONSHAPE_OAUTH_BASE}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: authParams(env, grant), signal: AbortSignal.timeout(10000) });
  if (!response.ok) {
    const failure = await response.json().catch(() => null) as { error?: unknown } | null;
    const code = typeof failure?.error === 'string' && /^[a-z_]{1,40}$/.test(failure.error) ? ` ${failure.error}` : '';
    throw new Error(`OAuth exchange failed ${response.status}${code}`);
  }
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
    destination.search = new URLSearchParams({ response_type: 'code', client_id: env.ONSHAPE_OAUTH_CLIENT_ID.trim(), redirect_uri: env.ONSHAPE_OAUTH_REDIRECT_URI, state }).toString();
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
  if (url.pathname === '/api/matches/decision' && request.method === 'POST') {
    if (request.headers.get('origin') !== env.WEB_ORIGIN) return reply({ error: 'Invalid request origin.' }, 403);
    const current = await getSession(request, env);
    if (!current) return reply({ error: 'Reconnect Onshape.' }, 401);
    const body = await request.json() as { documentId?: string; lineKey?: string; decision?: string; vendorId?: string; normalizedSku?: string };
    if (!body.documentId || !/^[\w-]{1,128}$/.test(body.documentId) || !body.lineKey || body.lineKey.length > 16384 || !['confirmed', 'rejected'].includes(body.decision ?? '') || !['gobilda', 'servocity', 'andymark', 'rev', 'pitsco'].includes(body.vendorId ?? '') || !body.normalizedSku || !/^[A-Z0-9]+$/.test(body.normalizedSku)) return reply({ error: 'Invalid match decision.' }, 400);
    const key = await matchDecisionKey(current.data.user.id, body.documentId, body.lineKey);
    const value: MatchDecision = { status: body.decision as MatchDecision['status'], vendorId: body.vendorId as MatchDecision['vendorId'], normalizedSku: body.normalizedSku };
    await env.APP_STATE.put(key, JSON.stringify(value));
    return reply({ saved: true });
  }
  if (url.pathname === '/api/settings' && request.method === 'GET') {
    const current = await getSession(request, env);
    if (!current) return reply({ error: 'Reconnect Onshape.' }, 401);
    const raw = await env.APP_STATE.get(`settings:${current.data.user.id}`);
    return reply(raw ? JSON.parse(raw) as UserSettings : { teamNumber: null });
  }
  if (url.pathname === '/api/settings' && request.method === 'POST') {
    if (request.headers.get('origin') !== env.WEB_ORIGIN) return reply({ error: 'Invalid request origin.' }, 403);
    const current = await getSession(request, env);
    if (!current) return reply({ error: 'Reconnect Onshape.' }, 401);
    const body = await request.json() as UserSettings;
    if (body.teamNumber !== null && (typeof body.teamNumber !== 'string' || !/^\d{1,6}$/.test(body.teamNumber))) return reply({ error: 'Team number must be 1–6 digits.' }, 400);
    await env.APP_STATE.put(`settings:${current.data.user.id}`, JSON.stringify({ teamNumber: body.teamNumber }));
    return reply({ saved: true });
  }
  if (url.pathname === '/api/classification/override' && request.method === 'POST') {
    if (request.headers.get('origin') !== env.WEB_ORIGIN) return reply({ error: 'Invalid request origin.' }, 403);
    const current = await getSession(request, env);
    if (!current) return reply({ error: 'Reconnect Onshape.' }, 401);
    const body = await request.json() as { documentId?: string; identity?: string; classification?: string | null };
    if (!body.documentId || !/^[\w-]{1,128}$/.test(body.documentId) || !body.identity || body.identity.length > 16384 || ![null, 'commercial', 'printed'].includes(body.classification ?? null)) return reply({ error: 'Invalid classification override.' }, 400);
    const key = await classificationKey(current.data.user.id, body.documentId, body.identity);
    if (body.classification) await env.APP_STATE.put(key, body.classification);
    else await env.APP_STATE.delete(key);
    return reply({ saved: true });
  }
  if (url.pathname === '/api/scan' && request.method === 'GET') {
    if (request.headers.get('origin') !== env.WEB_ORIGIN) return reply({ error: 'Invalid request origin.' }, 403);
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
    const getDecision = async (lineKey: string, signal?: AbortSignal): Promise<MatchDecision | null> => {
      if (signal?.aborted) throw signal.reason;
      const raw = await env.APP_STATE.get(await matchDecisionKey(current.data.user.id, context.documentId, lineKey));
      if (signal?.aborted) throw signal.reason;
      if (!raw) return null;
      try { return JSON.parse(raw) as MatchDecision; } catch { return null; }
    };
    const settingsRaw = await env.APP_STATE.get(`settings:${current.data.user.id}`);
    const settings = settingsRaw ? JSON.parse(settingsRaw) as UserSettings : { teamNumber: null };
    const getOverride = async (line: BomLine, signal?: AbortSignal): Promise<ClassificationOverride | null> => {
      if (signal?.aborted) throw signal.reason;
      const value = await env.APP_STATE.get(await classificationKey(current.data.user.id, context.documentId, classificationIdentity(line)));
      return value === 'commercial' || value === 'printed' ? value : null;
    };
    const scanId = random();
    return scanAssembly(request, context, env.ONSHAPE_API_VERSION, get, env.VENDOR_CATALOG, getDecision, Number(env.VENDOR_STALE_HOURS ?? 24), settings, getOverride,
      async result => { result.scanId = scanId; await env.APP_STATE.put(`scan:${current.data.user.id}:${scanId}`, JSON.stringify(result), { expirationTtl: 3600 }); });
  }
  if (url.pathname === '/api/prints/zip' && request.method === 'GET') {
    if (request.headers.get('origin') !== env.WEB_ORIGIN) return reply({ error: 'Invalid request origin.' }, 403);
    const current = await getSession(request, env);
    if (!current) return reply({ error: 'Reconnect Onshape.' }, 401);
    const documentId = url.searchParams.get('documentId');
    const scanId = url.searchParams.get('scanId');
    if (!documentId || !/^[\w-]{1,128}$/.test(documentId) || !scanId || !/^[a-f0-9-]{36}$/.test(scanId)) return reply({ error: 'Invalid scan identity.' }, 400);
    const raw = await env.APP_STATE.get(`scan:${current.data.user.id}:${scanId}`);
    if (!raw) return reply({ error: 'Scan this assembly before exporting STLs.' }, 409);
    let result = JSON.parse(raw) as ScanResult;
    if (result.documentId !== documentId || result.scanId !== scanId) return reply({ error: 'Scan does not match this document.' }, 409);
    const settingsRaw = await env.APP_STATE.get(`settings:${current.data.user.id}`);
    for (let offset = 0; offset < result.lines.length; offset += 20) {
      const pending = result.lines.slice(offset, offset + 20).filter(line => line.matchStatus === 'possible' && line.vendor);
      const choices = await Promise.all(pending.map(async line => {
        const value = await env.APP_STATE.get(await matchDecisionKey(current.data.user.id, documentId, line.bomLineKey));
        if (!value) return null;
        try { return JSON.parse(value) as MatchDecision; } catch { return null; }
      }));
      choices.forEach((choice, index) => {
        const line = pending[index];
        if (choice && line.vendor && choice.vendorId === line.vendor.vendorId && choice.normalizedSku === line.vendor.normalizedSku) result = applyMatchDecision(result, line.bomLineKey, choice.status);
      });
    }
    const overrides = await loadClassificationOverrides(result.lines, async line => {
      const value = await env.APP_STATE.get(await classificationKey(current.data.user.id, documentId, classificationIdentity(line)));
      return value === 'commercial' || value === 'printed' ? value : null;
    }, request.signal);
    classifyScan(result, settingsRaw ? JSON.parse(settingsRaw) as UserSettings : { teamNumber: null }, overrides);
    let refreshing: Promise<void> | undefined;
    const fetchStl = async (path: string, init: RequestInit) => {
      const send = async () => {
        let target = new URL(path, env.ONSHAPE_API_BASE);
        for (let hops = 0; hops <= 2; hops++) {
          const response = await fetch(target, { ...init, redirect: 'manual', headers: { ...Object.fromEntries(new Headers(init.headers)), authorization: `Bearer ${current.data.tokens.access_token}` } });
          if (init.method === 'POST' || ![307, 308].includes(response.status) || !response.headers.get('location')) return response;
          const next = new URL(response.headers.get('location')!, target);
          if (next.origin !== new URL(env.ONSHAPE_API_BASE).origin) return response;
          target = next;
        }
        throw Error('Onshape STL redirect limit exceeded');
      };
      for (let attempt = 0; attempt <= 4; attempt++) {
        let response = await send();
        if (response.status === 401) {
          refreshing ??= (async () => {
            current.data.tokens = await exchange(env, { grant_type: 'refresh_token', refresh_token: current.data.tokens.refresh_token });
            await save(env, current.id, current.data);
          })();
          try { await refreshing; } catch { await env.APP_STATE.delete(`session:${current.id}`); throw new SessionExpiredError(); }
          response = await send();
          if (response.status === 401) { await env.APP_STATE.delete(`session:${current.id}`); throw new SessionExpiredError(); }
        }
        if (response.status !== 429 || attempt === 4) return response;
        const retryAfter = Number(response.headers.get('retry-after'));
        const delay = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 8000) : Math.round(2 ** attempt * 1000 * (0.8 + Math.random() * 0.4));
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, delay);
          init.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(init.signal?.reason); }, { once: true });
        });
      }
      throw Error('Onshape rate limit exhausted');
    };
    const zip = await buildStlZip(result, env.ONSHAPE_API_VERSION, fetchStl, request.signal);
    return new Response(zip.bytes.buffer.slice(zip.bytes.byteOffset, zip.bytes.byteOffset + zip.bytes.byteLength) as ArrayBuffer,
      { headers: { 'content-type': 'application/zip', 'content-disposition': `attachment; filename="${zip.filename}"`, 'cache-control': 'no-store',
        'x-control-kit-failures': encodeURIComponent(JSON.stringify(zip.failures.slice(0, 10))), 'access-control-expose-headers': 'x-control-kit-failures' } });
  }
  if (url.pathname.startsWith('/api/onshape/')) {
    if (request.headers.get('origin') !== env.WEB_ORIGIN) return reply({ error: 'Invalid request origin.' }, 403);
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
    if (origin === env.WEB_ORIGIN) {
      const headers = new Headers(result.headers);
      headers.set('access-control-allow-origin', origin);
      headers.set('access-control-allow-credentials', 'true');
      headers.set('vary', 'Origin');
      result = new Response(result.body, { status: result.status, statusText: result.statusText, headers });
    }
    return result;
  },
  scheduled(event: { cron: string }, env: Env, context: { waitUntil(promise: Promise<unknown>): void }) {
    const vendor = ({ '0 */6 * * *': 'gobilda', '12 */6 * * *': 'servocity', '24 */6 * * *': 'andymark', '36 */6 * * *': 'rev', '48 */6 * * *': 'pitsco' } as const)[event.cron as '0 */6 * * *'];
    if (vendor) context.waitUntil(runVendor(vendor, env.VENDOR_CATALOG));
  },
};
