export interface Kv { get(k: string): Promise<string | null>; put(k: string, v: string, o?: { expirationTtl: number }): Promise<void>; delete(k: string): Promise<void> }
import { loadClassificationOverrides, scanAssembly, SessionExpiredError } from './scan';
import { applyMatchDecision, classificationIdentity, classifyScan, parseOverride, type AssemblyContext, type BomLine, type ClassificationOverride, type MatchDecision, type ScanResult, type UserSettings, type VendorId } from '@control-kit/shared';
import { runVendor } from './vendor-ingest';
import { catalogHealth } from './catalog';
import { advanceExport, BudgetExhaustedError, createExportJob, fileKey, jobKey, jobSummary, pollBudget, type ExportJob, type RequestBudget } from './step-export';
import { countedFetch, persistLedger, RequestLedger } from './onshape-client';
import { linePreview, previewCacheKey, PreviewUnavailableError } from './preview';

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
/** Pre-rework per-user manual types ('commercial' | 'printed'); read as a fallback, removed when the part is set again. */
async function legacyClassificationKey(userId: string, documentId: string, identity: string) { return `override:${userId}:${documentId}:${await lineKeyDigest(identity)}`; }
/** Manual dispositions are shared by everyone who scans the document, with who set them and a short history. */
async function dispositionKey(documentId: string, identity: string) { return `disposition:${documentId}:${await lineKeyDigest(identity)}`; }
/** The current choice (last write wins). Every change is also kept under its own key, so concurrent saves never erase history. */
type SavedDisposition = { disposition: ClassificationOverride | null; by: string; byId: string; at: string };
async function dispositionChangeKey(documentId: string, identity: string, at: string) { return `disposition-change:${documentId}:${await lineKeyDigest(identity)}:${at}:${random()}`; }
async function readDisposition(env: Env, userId: string, documentId: string, identity: string): Promise<ClassificationOverride | null> {
  const raw = await env.APP_STATE.get(await dispositionKey(documentId, identity));
  if (raw) { try { return parseOverride((JSON.parse(raw) as SavedDisposition).disposition); } catch { return null; } }
  return parseOverride(await env.APP_STATE.get(await legacyClassificationKey(userId, documentId, identity)));
}
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
/**
 * Counted Onshape fetch for one session: refreshes the token once on 401 (shared across concurrent calls) and
 * retries 429 up to four times with bounded backoff. With a budget, every request sent, retries included, spends it.
 */
function onshapeFetcher(env: Env, current: { id: string; data: Session }, ledger: RequestLedger, budget?: RequestBudget) {
  let refreshing: Promise<void> | undefined;
  return async (path: string, init: RequestInit = {}) => {
    const send = (retry: boolean) => {
      if (budget) { if (budget.remaining <= 0) throw new BudgetExhaustedError(); budget.remaining--; }
      return countedFetch(ledger, `${env.ONSHAPE_API_BASE}${path}`, { ...init, headers: { ...Object.fromEntries(new Headers(init.headers)), authorization: `Bearer ${current.data.tokens.access_token}` }, signal: AbortSignal.timeout(20000) }, retry);
    };
    for (let attempt = 0; attempt <= 4; attempt++) {
      let response = await send(attempt > 0);
      if (response.status === 401) {
        refreshing ??= (async () => {
          current.data.tokens = await exchange(env, { grant_type: 'refresh_token', refresh_token: current.data.tokens.refresh_token });
          await save(env, current.id, current.data);
        })();
        try { await refreshing; } catch { await env.APP_STATE.delete(`session:${current.id}`); throw new SessionExpiredError(); }
        response = await send(true);
        if (response.status === 401) { await env.APP_STATE.delete(`session:${current.id}`); throw new SessionExpiredError(); }
      }
      if (response.status !== 429 || attempt === 4) return response;
      const retryAfter = Number(response.headers.get('retry-after'));
      await new Promise(resolve => setTimeout(resolve, Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 4000) : 500 * 2 ** attempt));
    }
    throw new Error('Onshape rate limit exhausted');
  };
}
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
    const ledger = new RequestLedger('oauth-profile');
    const profile = await countedFetch(ledger, `${env.ONSHAPE_API_BASE}/api/users/sessioninfo`, { headers: { authorization: `Bearer ${tokens.access_token}` }, signal: AbortSignal.timeout(10000) })
      .finally(() => persistLedger(env.APP_STATE, ledger).catch(() => undefined));
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
  if (url.pathname === '/api/catalog/health' && request.method === 'GET') {
    // Public vendor crawl state only: counts, timestamps, and our own error text. No user data or credentials.
    return reply(await catalogHealth(env.VENDOR_CATALOG, Number(env.VENDOR_STALE_HOURS ?? 336)));
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
    const body = await request.json() as { documentId?: string; scanId?: string; identity?: string; classification?: string | null };
    const choice = body.classification === null || body.classification === undefined ? null : parseOverride(body.classification);
    if (!body.documentId || !/^[\w-]{1,128}$/.test(body.documentId) || !body.identity || body.identity.length > 16384 || (body.classification != null && !choice)) return reply({ error: 'Invalid classification override.' }, 400);
    // Shared choices may only be written by someone whose own recent scan read this document from Onshape.
    if (!body.scanId || !/^[a-f0-9-]{36}$/.test(body.scanId)) return reply({ error: 'Scan this assembly before changing a part type.' }, 409);
    const scanned = await env.APP_STATE.get(`scan:${current.data.user.id}:${body.scanId}`);
    if (!scanned || (JSON.parse(scanned) as ScanResult).documentId !== body.documentId) return reply({ error: 'Scan this assembly before changing a part type.' }, 409);
    const now = new Date().toISOString();
    const saved: SavedDisposition = { disposition: choice, by: current.data.user.name, byId: current.data.user.id, at: now };
    // KV has no atomic read-modify-write, so history is append-only: one never-overwritten key per change (kept a year).
    await env.APP_STATE.put(await dispositionChangeKey(body.documentId, body.identity, now), JSON.stringify(saved), { expirationTtl: 365 * 86400 });
    // Clearing keeps a current record (disposition null) so "who reset it" survives.
    await env.APP_STATE.put(await dispositionKey(body.documentId, body.identity), JSON.stringify(saved));
    await env.APP_STATE.delete(await legacyClassificationKey(current.data.user.id, body.documentId, body.identity));
    return reply({ saved: true, disposition: choice, by: saved.by, at: now });
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
    const ledger = new RequestLedger('scan');
    const send = (path: string, signal: AbortSignal, retry: boolean) => countedFetch(ledger, `${env.ONSHAPE_API_BASE}${path}`, { headers: { authorization: `Bearer ${current.data.tokens.access_token}` }, signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]) }, retry);
    const get = async (path: string, signal: AbortSignal, retry = false) => {
      let response = await send(path, signal, retry);
      if (response.status !== 401) return response;
      refreshing ??= (async () => {
        current.data.tokens = await exchange(env, { grant_type: 'refresh_token', refresh_token: current.data.tokens.refresh_token });
        await save(env, current.id, current.data);
      })();
      try { await refreshing; } catch { await env.APP_STATE.delete(`session:${current.id}`); throw new SessionExpiredError(); }
      response = await send(path, signal, true);
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
      return readDisposition(env, current.data.user.id, context.documentId, classificationIdentity(line));
    };
    const scanId = random();
    return scanAssembly(request, context, env.ONSHAPE_API_VERSION, get, env.VENDOR_CATALOG, getDecision, Number(env.VENDOR_STALE_HOURS ?? 336), settings, getOverride,
      async result => { result.scanId = scanId; await env.APP_STATE.put(`scan:${current.data.user.id}:${scanId}`, JSON.stringify(result), { expirationTtl: 3600 }); },
      { summary: () => ledger.summary(), finish: () => persistLedger(env.APP_STATE, ledger) },
      // Scoped to the user: a cached BOM is only served to someone whose own Onshape access already read it.
      { get: key => env.APP_STATE.get(`${current.data.user.id}:${key}`), put: (key, value) => env.APP_STATE.put(`${current.data.user.id}:${key}`, value, { expirationTtl: 30 * 86400 }) });
  }
  if (url.pathname === '/api/preview' && request.method === 'GET') {
    if (request.headers.get('origin') !== env.WEB_ORIGIN) return reply({ error: 'Invalid request origin.' }, 403);
    const current = await getSession(request, env);
    if (!current) return reply({ error: 'Reconnect Onshape.' }, 401);
    const scanId = url.searchParams.get('scanId');
    const lineKey = url.searchParams.get('line');
    if (!scanId || !/^[a-f0-9-]{36}$/.test(scanId) || !lineKey || lineKey.length > 4096) return reply({ error: 'Invalid part.' }, 400);
    // Only a part from the person's own scan, which proves their Onshape access read it.
    const raw = await env.APP_STATE.get(`scan:${current.data.user.id}:${scanId}`);
    if (!raw) return reply({ error: 'Scan this assembly again to see part pictures.' }, 409);
    const result = JSON.parse(raw) as ScanResult;
    const line = [...result.lines, ...result.suppressed].find(item => item.bomLineKey === lineKey);
    if (!line) return reply({ error: 'This part is not in your latest scan.' }, 404);
    const ledger = new RequestLedger('preview');
    try {
      const png = await linePreview(line, previewCacheKey(current.data.user.id, result, line, await lineKeyDigest(`${line.bomLineKey}|${line.purchasedAssembly ? 'assembly' : 'part'}`)), env.APP_STATE, onshapeFetcher(env, current, ledger, { remaining: 3 }), env.ONSHAPE_API_VERSION, result.diagnostics?.revision);
      return new Response(new Uint8Array(png), { headers: { 'content-type': 'image/png', 'cache-control': 'private, max-age=3600' } });
    } catch (error) {
      if (error instanceof SessionExpiredError) return reply({ error: 'Reconnect Onshape.' }, 401);
      if (error instanceof PreviewUnavailableError || error instanceof BudgetExhaustedError) return reply({ error: error instanceof PreviewUnavailableError ? error.message : 'Onshape is busy. Try again shortly.' }, 404);
      throw error;
    } finally { await persistLedger(env.APP_STATE, ledger).catch(() => undefined); }
  }
  const exportsMatch = url.pathname.match(/^\/api\/exports(?:\/([a-f0-9-]{36}))?(?:\/files\/(\d{1,4}))?$/);
  if (exportsMatch) {
    if (request.headers.get('origin') !== env.WEB_ORIGIN) return reply({ error: 'Invalid request origin.' }, 403);
    const current = await getSession(request, env);
    if (!current) return reply({ error: 'Reconnect Onshape.' }, 401);
    const userId = current.data.user.id;
    const [, jobId, fileIndex] = exportsMatch;
    // A finished file is served from KV: downloading it again costs no Onshape request.
    if (jobId && fileIndex !== undefined && request.method === 'GET') {
      const raw = await env.APP_STATE.get(jobKey(userId, jobId));
      const part = raw ? (JSON.parse(raw) as ExportJob).parts[Number(fileIndex)] : undefined;
      const file = part?.state === 'ready' ? await env.APP_STATE.get(fileKey(userId, jobId, Number(fileIndex))) : null;
      if (!part || !file) return reply({ error: 'This file is not ready or has expired. Export again.' }, 404);
      return new Response(file, { headers: { 'content-type': 'application/step', 'content-disposition': `attachment; filename="${part.fileName}"`, 'cache-control': 'no-store' } });
    }
    let job: ExportJob;
    if (!jobId && request.method === 'POST') {
      const body = await request.json() as { documentId?: string; scanId?: string };
      if (!body.documentId || !/^[\w-]{1,128}$/.test(body.documentId) || !body.scanId || !/^[a-f0-9-]{36}$/.test(body.scanId)) return reply({ error: 'Invalid scan identity.' }, 400);
      const raw = await env.APP_STATE.get(`scan:${userId}:${body.scanId}`);
      if (!raw) return reply({ error: 'Scan this assembly before exporting files.' }, 409);
      let result = JSON.parse(raw) as ScanResult;
      if (result.documentId !== body.documentId || result.scanId !== body.scanId) return reply({ error: 'Scan does not match this document.' }, 409);
      // Use the decisions and dispositions as they are now, not as they were when the scan ran.
      for (const line of result.lines.filter(item => item.matchStatus === 'possible' && item.vendor)) {
        const value = await env.APP_STATE.get(await matchDecisionKey(userId, result.documentId, line.bomLineKey));
        let choice: MatchDecision | null = null;
        try { choice = value ? JSON.parse(value) as MatchDecision : null; } catch { choice = null; }
        if (choice && line.vendor && choice.vendorId === line.vendor.vendorId && choice.normalizedSku === line.vendor.normalizedSku) result = applyMatchDecision(result, line.bomLineKey, choice.status);
      }
      const settingsRaw = await env.APP_STATE.get(`settings:${userId}`);
      const overrides = await loadClassificationOverrides(result.lines, line => readDisposition(env, userId, result.documentId, classificationIdentity(line)), request.signal);
      classifyScan(result, settingsRaw ? JSON.parse(settingsRaw) as UserSettings : { teamNumber: null }, overrides);
      job = createExportJob(result, random());
      if (!job.parts.length) return reply({ error: 'No part is set to 3D print, CNC, 2D cut, or other fabrication yet.' }, 409);
    } else if (jobId && request.method === 'GET') {
      const raw = await env.APP_STATE.get(jobKey(userId, jobId));
      if (!raw) return reply({ error: 'This export has expired. Export again.' }, 404);
      job = JSON.parse(raw) as ExportJob;
    } else return reply({ error: 'Not found' }, 404);
    const ledger = new RequestLedger('export');
    // Creating a job does no Onshape work, so the app shows progress from its first poll instead of waiting on a long start.
    const budget: RequestBudget = { remaining: request.method === 'POST' ? 0 : pollBudget };
    try { await advanceExport(job, userId, env.APP_STATE, onshapeFetcher(env, current, ledger, budget), env.ONSHAPE_API_VERSION, budget); }
    catch (error) {
      if (error instanceof SessionExpiredError) return reply({ error: 'Reconnect Onshape.' }, 401);
      throw error;
    } finally { await persistLedger(env.APP_STATE, ledger).catch(() => undefined); }
    await env.APP_STATE.put(jobKey(userId, job.jobId), JSON.stringify(job), { expirationTtl: 3600 });
    return reply(jobSummary(job));
  }
  return reply({ error: 'Not found' }, 404);
}
/** Each vendor crawls hourly, 12 minutes apart. Must match `[triggers] crons` in wrangler.toml (a test checks). */
export const cronVendors: Record<string, VendorId> = { '0 * * * *': 'gobilda', '12 * * * *': 'servocity', '24 * * * *': 'andymark', '36 * * * *': 'rev', '48 * * * *': 'pitsco' };

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
    const vendor = cronVendors[event.cron];
    if (vendor) context.waitUntil(runVendor(vendor, env.VENDOR_CATALOG, fetch, { feedFreshHours: Number(env.VENDOR_STALE_HOURS ?? 336) }));
  },
};
