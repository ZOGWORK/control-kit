export interface Kv { get(k: string): Promise<string | null>; put(k: string, v: string, o?: { expirationTtl: number }): Promise<void>; delete(k: string): Promise<void> }
import { loadClassificationOverrides, scanAssembly, SessionExpiredError } from './scan';
import { applyMatchDecision, catalogReadKey, decisionRecord, classificationIdentity, classifyScan, parseOverride, type AssemblyContext, type BomLine, type ClassificationOverride, type MatchDecision, type ScanResult, type UserSettings, type VendorId } from '@control-kit/shared';
import { runRevFeed } from './rev-feed';
import { runVendor } from './vendor-ingest';
import { catalogHealth } from './catalog';
import { aiReviewEnabled, cachedAiReview, releaseAiReview, reserveAiReview, reviewThroughControlPoint, reviewWithAi, trustedAiRequest, validAiRequest, type AiEnv } from './ai-review';
export { AiAllowance } from './ai-allowance';
import { advanceExport, BudgetExhaustedError, createExportJob, dxfKey, fileKey, jobKey, jobSummary, pollBudget, type ExportJob, type RequestBudget } from './step-export';
import { countedFetch, persistLedger, RequestLedger } from './onshape-client';
import { assemblyNowKey, assemblyPreview, assemblyPreviewCacheKey, assemblyView, linePreview, previewCacheKey, PreviewUnavailableError, readAssemblyNow, redrawAssembly, reserveRedraw, type AssemblySource } from './preview';
import { clearCookie, readSignedEnvelope, seal, signedCookie, unseal, type SignedCookie } from './secrets';
import { controlPointAvailable, controlPointRoute, defaultAdapter, linkedWorkspace, type ControlPointEnv, type DecisionStore } from './control-point';

export interface Env extends ControlPointEnv { APP_STATE: Kv; VENDOR_CATALOG: Kv; ONSHAPE_OAUTH_CLIENT_ID: string; ONSHAPE_OAUTH_CLIENT_SECRET: string; ONSHAPE_OAUTH_REDIRECT_URI: string; ONSHAPE_API_BASE: string; ONSHAPE_API_VERSION: string; ONSHAPE_OAUTH_BASE: string; SESSION_ENCRYPTION_KEY: string; WEB_ORIGIN: string; VENDOR_STALE_HOURS?: string;
  /** Optional AI review keys (Worker secrets). Without either, the review is off and nothing else changes. */
  GEMINI_API_KEY?: string; ANTHROPIC_API_KEY?: string; GEMINI_MODEL?: string; ANTHROPIC_MODEL?: string; AI_ALLOWANCE?: AiEnv['AI_ALLOWANCE'] }
type Tokens = { access_token: string; refresh_token: string };
/** `savedAt` (ms) lets a session refresh its KV TTL at most once a day instead of on every request. */
type Session = { tokens: Tokens; user: { id: string; name: string }; savedAt?: number };
type OAuthState = { context?: Record<string, string>; redirectOnshapeUri?: string };
const cookieName = 'controlkit_session';
// SameSite=None is required because Onshape embeds Control Kit in a cross-site iframe.
const cookieFlags = 'HttpOnly; Secure; SameSite=None; Path=/';
/**
 * A session lasts 30 days from its last use, in KV and in the browser alike. Without Max-Age the cookie was a browser
 * session cookie, dropped whenever the browser closed, so people had to connect Onshape again though the session was
 * still stored.
 */
const sessionTtl = 30 * 86400;
const sessionCookie = (id: string) => `${cookieName}=${id}; ${cookieFlags}; Max-Age=${sessionTtl}`;
const encode = new TextEncoder();
const random = () => crypto.randomUUID();
async function lineKeyDigest(lineKey: string) {
  const digest = await crypto.subtle.digest('SHA-256', encode.encode(lineKey));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}
async function matchDecisionKey(userId: string, documentId: string, lineKey: string) { return `match-decision:${userId}:${documentId}:${await lineKeyDigest(lineKey)}`; }
/**
 * A line key ends with its source revision (`:m:<microversion>` for parts of the scanned workspace), which changes on
 * every edit. Decisions are saved under the part itself (document, element, part, configuration) so they survive edits;
 * reads fall back to the older revision-keyed decision.
 */
export const decisionIdentity = (lineKey: string) => lineKey.split(':').slice(0, -2).join(':');
async function readMatchDecision(env: Env, userId: string, documentId: string, lineKey: string): Promise<MatchDecision | null> {
  for (const key of [await matchDecisionKey(userId, documentId, decisionIdentity(lineKey)), await matchDecisionKey(userId, documentId, lineKey)]) {
    const raw = await env.APP_STATE.get(key);
    if (!raw) continue;
    try { return JSON.parse(raw) as MatchDecision; } catch { return null; }
  }
  return null;
}
/** Pre-rework per-user manual types ('commercial' | 'printed'); read as a fallback, removed when the part is set again. */
async function legacyClassificationKey(userId: string, documentId: string, identity: string) { return `override:${userId}:${documentId}:${await lineKeyDigest(identity)}`; }
/** Manual dispositions are shared by everyone who scans the document, with who set them and a short history. */
async function dispositionKey(documentId: string, identity: string) { return `disposition:${documentId}:${await lineKeyDigest(identity)}`; }
/** The current choice (last write wins). Every change is also kept under its own key, so concurrent saves never erase history. */
type SavedDisposition = { disposition: ClassificationOverride | null; by: string; byId: string; at: string };
async function dispositionChangeKey(documentId: string, identity: string, at: string) { return `disposition-change:${documentId}:${await lineKeyDigest(identity)}:${at}:${random()}`; }
async function readDispositionRecord(env: Env, documentId: string, identity: string): Promise<SavedDisposition | null> {
  const raw = await env.APP_STATE.get(await dispositionKey(documentId, identity));
  if (!raw) return null;
  try { return JSON.parse(raw) as SavedDisposition; } catch { return null; }
}
/** Writes a shared type the way a person's save does: the current record, plus a never-overwritten history key. */
async function saveDisposition(env: Env, userId: string, documentId: string, identity: string, saved: SavedDisposition) {
  await env.APP_STATE.put(await dispositionChangeKey(documentId, identity, saved.at), JSON.stringify(saved), { expirationTtl: 365 * 86400 });
  await env.APP_STATE.put(await dispositionKey(documentId, identity), JSON.stringify(saved));
  await env.APP_STATE.delete(await legacyClassificationKey(userId, documentId, identity));
}
const newer = (at: string, than: string | undefined) => !than || Date.parse(at) > Date.parse(than);
/**
 * Control Point's choices for a scan's parts saved as Control Kit's own (contract §5). Only parts in the person's scan,
 * only choices newer than what Control Kit holds, and only real changes are written, so an unchanged pull writes nothing.
 * Each record is read right before its write. KV has no compare-and-swap, so a person's save landing between that read
 * and the write can still be overwritten by an older Control Point choice, the same limit as two people saving a shared
 * type at once (CLAUDE.md PR 4). Its never-overwritten history key survives, and the person's next save wins again.
 */
export function kvDecisionStore(env: Env): DecisionStore {
  return {
    async apply(userId, scan, decisions) {
      const lines = new Map([...scan.lines, ...scan.suppressed].map(line => [classificationIdentity(line), line]));
      let types = 0, products = 0;
      for (const decision of decisions) {
        const line = lines.get(decision.identity);
        if (!line) continue;
        if (decision.type) {
          const current = await readDispositionRecord(env, scan.documentId, decision.identity);
          const value = decision.type.value === null ? null : parseOverride(decision.type.value);
          // The type in force: the shared record, or without one an older per-person override (which a reset must clear).
          const effective = current ? current.disposition : await readDisposition(env, userId, scan.documentId, decision.identity);
          if (newer(decision.type.at, current?.at) && (effective ?? null) !== value) {
            await saveDisposition(env, userId, scan.documentId, decision.identity, { disposition: value, by: `${decision.type.by} in Control Point`, byId: 'control-point', at: decision.type.at });
            types++;
          }
        }
        if (decision.product) {
          const current = await readMatchDecision(env, userId, scan.documentId, line.bomLineKey);
          const same = current?.status === 'confirmed' && current.vendorId === decision.product.vendor && current.normalizedSku === decision.product.normalizedSku;
          if (!same && newer(decision.product.at, current?.at)) {
            const value: MatchDecision = { status: 'confirmed', vendorId: decision.product.vendor, normalizedSku: decision.product.normalizedSku, at: decision.product.at };
            await env.APP_STATE.put(await matchDecisionKey(userId, scan.documentId, decisionIdentity(line.bomLineKey)), JSON.stringify(value));
            products++;
          }
        }
      }
      return { types, products };
    },
  };
}
async function readDisposition(env: Env, userId: string, documentId: string, identity: string): Promise<ClassificationOverride | null> {
  const raw = await env.APP_STATE.get(await dispositionKey(documentId, identity));
  if (raw) { try { return parseOverride((JSON.parse(raw) as SavedDisposition).disposition); } catch { return null; } }
  return parseOverride(await env.APP_STATE.get(await legacyClassificationKey(userId, documentId, identity)));
}
const reply = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
function sessionId(request: Request) { return request.headers.get('cookie')?.match(/(?:^|;\s*)controlkit_session=([^;]+)/)?.[1] ?? null; }
async function getSession(request: Request, env: Env) {
  const id = sessionId(request);
  const value = id && await env.APP_STATE.get(`session:${id}`);
  if (!id || !value) return null;
  try { return { id, data: await unseal<Session>(env, value) }; } catch { return null; }
}
async function save(env: Env, id: string, data: Session) { data.savedAt = Date.now(); await env.APP_STATE.put(`session:${id}`, await seal(env, data), { expirationTtl: sessionTtl }); }
/**
 * OAuth state lives in a signed, HttpOnly cookie on the browser that started sign-in, not in KV: starting sign-in
 * writes nothing (so nobody can spend the daily KV writes by opening /oauth/start), and a redirect only completes in
 * the browser that started it (no login CSRF).
 */
const stateCookie: SignedCookie = { name: 'controlkit_oauth', path: '/oauth', label: 'control-kit oauth-state v1:' };
async function readStateCookie(request: Request, env: Env, state: string): Promise<OAuthState | null> {
  const envelope = await readSignedEnvelope<OAuthState & { state?: string }>(request, env, stateCookie);
  // Cookies signed before the move to secrets.ts kept `state` beside `data`; they stay valid for their ten minutes.
  const signed = envelope?.data.state ?? (typeof envelope?.state === 'string' ? envelope.state : null);
  return envelope && signed === state ? envelope.data : null;
}
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
/** The panel's workspace or version from `wvm`/`wvmId`, or null when it names neither. */
function assemblySource(url: URL): AssemblySource | null {
  const type = url.searchParams.get('wvm'), id = url.searchParams.get('wvmId') ?? '';
  return (type === 'w' || type === 'v') && /^[A-Za-z0-9]{1,64}$/.test(id) ? { type, id } : null;
}

/** An assembly picture; `x-picture-drawn` holds when it was redrawn on request, absent for the scanned revision's picture. */
function assemblyPicture(png: Uint8Array, drawnAt: string | null) {
  const headers: Record<string, string> = { 'content-type': 'image/png', 'cache-control': 'private, no-cache' };
  if (drawnAt) headers['x-picture-drawn'] = drawnAt;
  return new Response(new Uint8Array(png), { headers });
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
    const destination = new URL('/oauth/authorize', env.ONSHAPE_OAUTH_BASE);
    destination.search = new URLSearchParams({ response_type: 'code', client_id: env.ONSHAPE_OAUTH_CLIENT_ID.trim(), redirect_uri: env.ONSHAPE_OAUTH_REDIRECT_URI, state }).toString();
    return new Response(null, { status: 302, headers: { location: destination.toString(), 'set-cookie': await signedCookie(env, stateCookie, { state, ...stateData }) } });
  }
  if (url.pathname === '/oauth/redirect') {
    const state = url.searchParams.get('state');
    const code = url.searchParams.get('code');
    if (!state || !code) return reply({ error: 'Authorization was cancelled or incomplete.' }, 400);
    const stateData = await readStateCookie(request, env, state);
    if (!stateData) return reply({ error: 'Authorization expired. Reconnect Onshape.' }, 400);
    // One use: a replayed redirect (same state) is refused. Written only after Onshape sent the person back.
    if (await env.APP_STATE.get(`oauth-used:${state}`)) return reply({ error: 'Authorization expired. Reconnect Onshape.' }, 400);
    const tokens = await exchange(env, { grant_type: 'authorization_code', code, redirect_uri: env.ONSHAPE_OAUTH_REDIRECT_URI });
    // Written only once Onshape accepted the code, so made-up callbacks write nothing.
    await env.APP_STATE.put(`oauth-used:${state}`, '1', { expirationTtl: 600 });
    const ledger = new RequestLedger('oauth-profile');
    const profile = await countedFetch(ledger, `${env.ONSHAPE_API_BASE}/api/users/sessioninfo`, { headers: { authorization: `Bearer ${tokens.access_token}` }, signal: AbortSignal.timeout(10000) })
      .finally(() => persistLedger(env.APP_STATE, ledger).catch(() => undefined));
    if (!profile.ok) return reply({ error: 'Could not read Onshape profile.' }, 502);
    // Only the id and name are kept: sessioninfo also carries email and company, which Control Kit never needs.
    const info = await profile.json() as Partial<Session['user']>;
    if (!info.id) return reply({ error: 'Onshape profile has no ID.' }, 502);
    const user = { id: String(info.id), name: String(info.name ?? '') };
    const id = random();
    await save(env, id, { tokens, user });
    const destination = stateData.redirectOnshapeUri ? new URL(stateData.redirectOnshapeUri) : new URL('/', env.WEB_ORIGIN);
    for (const [k, v] of Object.entries(stateData.context ?? {})) destination.searchParams.set(k, v);
    const headers = new Headers({ location: destination.toString() });
    headers.append('set-cookie', sessionCookie(id));
    headers.append('set-cookie', clearCookie(stateCookie));
    return new Response(null, { status: 302, headers });
  }
  if (url.pathname === '/api/session') {
    if (!env.ONSHAPE_OAUTH_CLIENT_ID || !env.ONSHAPE_OAUTH_CLIENT_SECRET) return reply({ connected: false, setupPending: true });
    const current = await getSession(request, env);
    if (!current) return reply({ connected: false }, 401);
    // Keep an active session alive, but write it at most once a day rather than on every panel load.
    if (!current.data.savedAt || Date.now() - current.data.savedAt > 86_400_000) await save(env, current.id, current.data);
    // The cookie's 30 days restart on every panel load (a header, not a KV write), so a team that opens Control Kit at
    // least once a month never connects again; it also gives a cookie set before Max-Age existed its lifetime.
    const answer = reply({ connected: true, user: { id: current.data.user.id, name: current.data.user.name } });
    answer.headers.append('set-cookie', sessionCookie(current.id));
    return answer;
  }
  if (url.pathname === '/api/logout' && request.method === 'POST') {
    if (request.headers.get('origin') !== env.WEB_ORIGIN) return reply({ error: 'Invalid request origin.' }, 403);
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
    const key = await matchDecisionKey(current.data.user.id, body.documentId, decisionIdentity(body.lineKey));
    const value: MatchDecision = { status: body.decision as MatchDecision['status'], vendorId: body.vendorId as MatchDecision['vendorId'], normalizedSku: body.normalizedSku, at: new Date().toISOString() };
    await env.APP_STATE.put(key, JSON.stringify(value));
    return reply({ saved: true });
  }
  if (url.pathname === '/api/catalog/health' && request.method === 'GET') {
    // Public vendor crawl state only: counts, timestamps, and our own error text. No user data or credentials.
    return reply(await catalogHealth(env.VENDOR_CATALOG, Number(env.VENDOR_STALE_HOURS ?? 336)));
  }
  if (url.pathname === '/api/catalog/raw' && request.method === 'GET') {
    // Published vendor catalog data, exactly as stored, for the browser's matcher. Public vendor information only:
    // pointers and generation indexes and batches; never crawl state, sessions, or user data. Generation keys never
    // change, so they are cached for a year; pointers move, so for a minute.
    const key = url.searchParams.get('key') ?? '';
    if (!catalogReadKey.test(key)) return reply({ error: 'Not a catalog key.' }, 400);
    // Library mappings may hold licensed data, so only a connected person reads them.
    if (key.startsWith('library-map:') && !await getSession(request, env)) return reply({ error: 'Reconnect Onshape.' }, 401);
    const value = await env.VENDOR_CATALOG.get(key);
    if (value === null) return new Response('', { status: 404, headers: { 'cache-control': 'public, max-age=60' } });
    // A batch is written once and never changes. An index is rewritten while a first crawl publishes in parts, and
    // pointers and mappings move, so those are cached for a minute only.
    const cache = /:batch:\d+$/.test(key) ? 'public, max-age=31536000, immutable' : key.startsWith('library-map:') ? 'private, max-age=60' : 'public, max-age=60';
    return new Response(value, { headers: { 'content-type': 'application/json', 'cache-control': cache } });
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
  if (url.pathname === '/api/choices' && request.method === 'POST') {
    // Current shared dispositions and the person's match decisions for the lines of a scan they made: lets a reopened
    // scan pick up teammates' changes without another Onshape request.
    if (request.headers.get('origin') !== env.WEB_ORIGIN) return reply({ error: 'Invalid request origin.' }, 403);
    const current = await getSession(request, env);
    if (!current) return reply({ error: 'Reconnect Onshape.' }, 401);
    const body = await request.json() as { documentId?: string; scanId?: string };
    if (!body.documentId || !/^[\w-]{1,128}$/.test(body.documentId) || !body.scanId || !/^[a-f0-9-]{36}$/.test(body.scanId)) return reply({ error: 'Invalid scan identity.' }, 400);
    const raw = await env.APP_STATE.get(`scan:${current.data.user.id}:${body.scanId}`);
    if (!raw) return reply({ error: 'Scan this assembly again.' }, 409);
    const scanned = JSON.parse(raw) as ScanResult;
    if (scanned.documentId !== body.documentId) return reply({ error: 'Scan does not match this document.' }, 409);
    // `dispositionAt`/`dispositionBy` and the decision's `at` travel to Control Point, which shows whichever choice is newer.
    const choices: Record<string, { disposition: ClassificationOverride | null; decision: MatchDecision | null; dispositionAt: string | null; dispositionBy: string | null }> = {};
    for (let start = 0; start < scanned.lines.length; start += 20) {
      await Promise.all(scanned.lines.slice(start, start + 20).map(async line => {
        const decision = await readMatchDecision(env, current.data.user.id, body.documentId!, line.bomLineKey);
        const record = await readDispositionRecord(env, body.documentId!, classificationIdentity(line));
        choices[line.bomLineKey] = { disposition: await readDisposition(env, current.data.user.id, body.documentId!, classificationIdentity(line)), decision,
          dispositionAt: record?.at ?? null, dispositionBy: record?.by ?? null };
      }));
    }
    return reply({ choices });
  }
  if (url.pathname === '/api/ai/status' && request.method === 'GET') {
    // This Worker's own keys come first; without them, a person linked with a Control Point workspace reviews through it.
    if (aiReviewEnabled(env)) return reply({ enabled: true, via: 'control-kit' });
    if (!env.AI_ALLOWANCE || !controlPointAvailable(env)) return reply({ enabled: false });
    const current = await getSession(request, env);
    const linked = current ? await linkedWorkspace(env, current.data.user.id) : null;
    return reply(linked ? { enabled: true, via: 'control-point' } : { enabled: false, linkToEnable: true });
  }
  if (url.pathname === '/api/ai/review' && request.method === 'POST') {
    if (request.headers.get('origin') !== env.WEB_ORIGIN) return reply({ error: 'Invalid request origin.' }, 403);
    const own = aiReviewEnabled(env);
    if (!own && !(env.AI_ALLOWANCE && controlPointAvailable(env))) return reply({ error: 'AI review is not set up on this server. Everything else works as before.' }, 501);
    const current = await getSession(request, env);
    if (!current) return reply({ error: 'Reconnect Onshape.' }, 401);
    // Through Control Point only when this Worker has no key of its own; the allowance and the answer cache stay here.
    const linked = own ? null : await linkedWorkspace(env, current.data.user.id);
    if (!own && !linked) return reply({ error: 'Link Control Point with a workspace to use AI review.', code: 'not_linked' }, 501);
    const text = await request.text();
    if (text.length > 150_000) return reply({ error: 'Too many parts for one AI review.' }, 413);
    let body: { documentId?: string; scanId?: string; request?: unknown; keys?: unknown };
    try { body = JSON.parse(text); } catch { return reply({ error: 'Invalid AI review request.' }, 400); }
    if (!body.documentId || !/^[\w-]{1,128}$/.test(body.documentId) || !body.scanId || !/^[a-f0-9-]{36}$/.test(body.scanId) || !validAiRequest(body.request)) return reply({ error: 'Invalid AI review request.' }, 400);
    // Only someone who scanned this document (and so can read it in Onshape) may send its parts for review.
    const raw = await env.APP_STATE.get(`scan:${current.data.user.id}:${body.scanId}`);
    const scanned = raw ? JSON.parse(raw) as ScanResult : null;
    if (!scanned || scanned.documentId !== body.documentId) return reply({ error: 'Scan this assembly again.' }, 409);
    // The review is rebuilt from that scan, so the key cannot be used to send arbitrary text to a model.
    const trusted = trustedAiRequest(body.request, body.keys, scanned);
    if (!trusted) return reply({ error: 'These parts are not in your scan. Rescan and try again.' }, 409);
    // A saved answer is free; anything else takes one of the person's daily reviews, reserved before the call.
    let outcome = await cachedAiReview(env, trusted, linked ? 'control-point' : 'control-kit');
    if (!outcome) {
      const refused = await reserveAiReview(env, current.data.user.id);
      if (refused) return reply({ error: refused }, 429);
      try {
        outcome = linked
          ? await reviewThroughControlPoint(env, trusted, async ask => {
            try { return await defaultAdapter(env).aiReview(linked.token, linked.workspaceId, ask); }
            catch (error) { if ((error as { status?: number }).status === 401) await linked.forget(); throw error; }
          })
          : await reviewWithAi(env, trusted);
      }
      finally { await releaseAiReview(env, current.data.user.id); }
    }
    const via = linked ? 'control-point' : 'control-kit';
    return outcome.ok ? reply({ items: outcome.items, provider: outcome.provider, cached: outcome.cached, usage: outcome.usage, via })
      : reply({ error: outcome.error, ...(outcome.code ? { code: outcome.code } : {}), ...(outcome.code === 'revoked' ? { linked: false } : {}) }, outcome.status);
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
    const scan = scanned ? JSON.parse(scanned) as ScanResult : null;
    if (!scan || scan.documentId !== body.documentId) return reply({ error: 'Scan this assembly before changing a part type.' }, 409);
    // Only a part that is in that scan can be set.
    if (![...scan.lines, ...scan.suppressed].some(line => classificationIdentity(line) === body.identity)) return reply({ error: 'This part is not in your scan. Rescan and try again.' }, 409);
    const now = new Date().toISOString();
    const saved: SavedDisposition = { disposition: choice, by: current.data.user.name, byId: current.data.user.id, at: now };
    // KV has no atomic read-modify-write, so history is append-only: one never-overwritten key per change (kept a year).
    // Clearing keeps a current record (disposition null) so "who reset it" survives.
    await saveDisposition(env, current.data.user.id, body.documentId, body.identity, saved);
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
      const decision = await readMatchDecision(env, current.data.user.id, context.documentId, lineKey);
      if (signal?.aborted) throw signal.reason;
      return decision;
    };
    const settingsRaw = await env.APP_STATE.get(`settings:${current.data.user.id}`);
    const settings = settingsRaw ? JSON.parse(settingsRaw) as UserSettings : { teamNumber: null };
    const getOverride = async (line: BomLine, signal?: AbortSignal): Promise<ClassificationOverride | null> => {
      if (signal?.aborted) throw signal.reason;
      return readDisposition(env, current.data.user.id, context.documentId, classificationIdentity(line));
    };
    const scanId = random();
    return scanAssembly(request, context, env.ONSHAPE_API_VERSION, get, env.VENDOR_CATALOG, getDecision, Number(env.VENDOR_STALE_HOURS ?? 336), settings, getOverride,
      // Kept a week: the app reopens the last scan of an assembly, and choices, exports, and pictures need its server copy.
      async result => { result.scanId = scanId; await env.APP_STATE.put(`scan:${current.data.user.id}:${scanId}`, JSON.stringify(result), { expirationTtl: 7 * 86400 }); },
      { summary: () => ledger.summary(), finish: () => persistLedger(env.APP_STATE, ledger) },
      // Scoped to the user: a cached BOM is only served to someone whose own Onshape access already read it.
      { get: key => env.APP_STATE.get(`${current.data.user.id}:${key}`), put: (key, value) => env.APP_STATE.put(`${current.data.user.id}:${key}`, value, { expirationTtl: 30 * 86400 }) });
  }
  if (url.pathname.startsWith('/control-point/') || url.pathname.startsWith('/api/control-point/')) {
    const current = await getSession(request, env);
    return controlPointRoute(request, url, env, current ? current.data.user : null, undefined, kvDecisionStore(env));
  }
  if (url.pathname === '/api/preview/assembly' && request.method === 'GET') {
    // The assembly's own picture for the scan's header, at the revision the scan read, or a newer one drawn on request.
    if (request.headers.get('origin') !== env.WEB_ORIGIN) return reply({ error: 'Invalid request origin.' }, 403);
    const current = await getSession(request, env);
    if (!current) return reply({ error: 'Reconnect Onshape.' }, 401);
    const scanId = url.searchParams.get('scanId');
    if (!scanId || !/^[a-f0-9-]{36}$/.test(scanId)) return reply({ error: 'Invalid scan.' }, 400);
    const raw = await env.APP_STATE.get(`scan:${current.data.user.id}:${scanId}`);
    if (!raw) return reply({ error: 'Scan this assembly again to see its picture.' }, 409);
    const result = JSON.parse(raw) as ScanResult;
    const view = assemblyView(url.searchParams.get('view'));
    // A picture redrawn from this panel's own workspace or version, when the panel names it.
    const source = assemblySource(url);
    const drawn = source && await readAssemblyNow(env.APP_STATE, assemblyNowKey(current.data.user.id, result, source, view), result);
    if (drawn) return assemblyPicture(Uint8Array.from(atob(drawn.image), char => char.charCodeAt(0)), drawn.at);
    const ledger = new RequestLedger('preview');
    try {
      const png = await assemblyPreview(result, assemblyPreviewCacheKey(current.data.user.id, result, view), env.APP_STATE, onshapeFetcher(env, current, ledger, { remaining: 3 }), env.ONSHAPE_API_VERSION, view);
      return assemblyPicture(png, null);
    } catch (error) {
      if (error instanceof SessionExpiredError) return reply({ error: 'Reconnect Onshape.' }, 401);
      if (error instanceof PreviewUnavailableError || error instanceof BudgetExhaustedError) return reply({ error: error instanceof PreviewUnavailableError ? error.message : 'Onshape is busy. Try again shortly.' }, 404);
      throw error;
    } finally { await persistLedger(env.APP_STATE, ledger).catch(() => undefined); }
  }
  if (url.pathname === '/api/preview/assembly/redraw' && request.method === 'POST') {
    // Draws the assembly as it is now (the panel's workspace or version), at most once a minute per assembly and view.
    if (request.headers.get('origin') !== env.WEB_ORIGIN) return reply({ error: 'Invalid request origin.' }, 403);
    const current = await getSession(request, env);
    if (!current) return reply({ error: 'Reconnect Onshape.' }, 401);
    const scanId = url.searchParams.get('scanId');
    if (!scanId || !/^[a-f0-9-]{36}$/.test(scanId)) return reply({ error: 'Invalid scan.' }, 400);
    const source = assemblySource(url);
    if (!source) return reply({ error: 'Open Control Kit from an assembly tab to redraw its picture.' }, 400);
    const raw = await env.APP_STATE.get(`scan:${current.data.user.id}:${scanId}`);
    if (!raw) return reply({ error: 'Scan this assembly again to see its picture.' }, 409);
    const result = JSON.parse(raw) as ScanResult;
    const view = assemblyView(url.searchParams.get('view'));
    const key = assemblyNowKey(current.data.user.id, result, source, view);
    const reserved = await reserveRedraw(env.AI_ALLOWANCE, env.APP_STATE, key);
    if (!reserved.ok) return reply({ error: 'This picture was just redrawn. Try again in a minute.', retryAfter: reserved.retryAfter }, 429);
    const ledger = new RequestLedger('preview');
    try {
      const { png, at } = await redrawAssembly(result, source, key, env.APP_STATE, onshapeFetcher(env, current, ledger, { remaining: 3 }), env.ONSHAPE_API_VERSION, view);
      return assemblyPicture(png, at);
    } catch (error) {
      await reserved.release();
      if (error instanceof SessionExpiredError) return reply({ error: 'Reconnect Onshape.' }, 401);
      if (error instanceof PreviewUnavailableError || error instanceof BudgetExhaustedError) return reply({ error: error instanceof PreviewUnavailableError ? error.message : 'Onshape is busy. Try again shortly.' }, 404);
      throw error;
    } finally { await persistLedger(env.APP_STATE, ledger).catch(() => undefined); }
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
    const cacheKey = previewCacheKey(current.data.user.id, result, line, await lineKeyDigest(`${line.bomLineKey}|${line.purchasedAssembly ? 'assembly' : 'part'}`));
    // `cached=1` (pictures for Control Point, contract v1.2 §6): only a picture already drawn, never an Onshape request.
    if (url.searchParams.get('cached') === '1') {
      const saved = await env.APP_STATE.get(cacheKey);
      return saved ? new Response(Uint8Array.from(atob(saved), char => char.charCodeAt(0)), { headers: { 'content-type': 'image/png', 'cache-control': 'private, max-age=3600' } })
        : reply({ error: 'Not drawn yet.', code: 'not_cached' }, 404);
    }
    const ledger = new RequestLedger('preview');
    try {
      const png = await linePreview(line, cacheKey, env.APP_STATE, onshapeFetcher(env, current, ledger, { remaining: 3 }), env.ONSHAPE_API_VERSION, result.diagnostics?.revision);
      return new Response(new Uint8Array(png), { headers: { 'content-type': 'image/png', 'cache-control': 'private, max-age=3600' } });
    } catch (error) {
      if (error instanceof SessionExpiredError) return reply({ error: 'Reconnect Onshape.' }, 401);
      if (error instanceof PreviewUnavailableError || error instanceof BudgetExhaustedError) return reply({ error: error instanceof PreviewUnavailableError ? error.message : 'Onshape is busy. Try again shortly.' }, 404);
      throw error;
    } finally { await persistLedger(env.APP_STATE, ledger).catch(() => undefined); }
  }
  const exportsMatch = url.pathname.match(/^\/api\/exports(?:\/([a-f0-9-]{36}))?(?:\/files\/(\d{1,4})(?:\.(body|edges))?)?$/);
  if (exportsMatch) {
    if (request.headers.get('origin') !== env.WEB_ORIGIN) return reply({ error: 'Invalid request origin.' }, 403);
    const current = await getSession(request, env);
    if (!current) return reply({ error: 'Reconnect Onshape.' }, 401);
    const userId = current.data.user.id;
    const [, jobId, fileIndex] = exportsMatch;
    const geometry = exportsMatch[3] as 'body' | 'edges' | undefined;
    // A finished file is served from KV: downloading it again costs no Onshape request. `.body` and `.edges` are the
    // Onshape geometry a 2D-cut part's DXF is drawn from in the browser.
    if (jobId && fileIndex !== undefined && request.method === 'GET') {
      const raw = await env.APP_STATE.get(jobKey(userId, jobId));
      const part = raw ? (JSON.parse(raw) as ExportJob).parts[Number(fileIndex)] : undefined;
      const ready = geometry ? part?.dxf?.state === 'ready' : part?.state === 'ready';
      const file = ready ? await env.APP_STATE.get(geometry ? dxfKey(userId, jobId, Number(fileIndex), geometry) : fileKey(userId, jobId, Number(fileIndex))) : null;
      if (!part || !file) return reply({ error: 'This file is not ready or has expired. Export again.' }, 404);
      if (geometry) return new Response(file, { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
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
        const choice = await readMatchDecision(env, userId, result.documentId, line.bomLineKey);
        // A decision may pick one of the line's choices rather than the match it was shown.
        if (choice && decisionRecord(line, choice)) result = applyMatchDecision(result, line.bomLineKey, choice.status, choice);
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
    const before = request.method === 'GET' ? JSON.stringify(job) : '';
    // Creating a job does no Onshape work, so the app shows progress from its first poll instead of waiting on a long start.
    const budget: RequestBudget = { remaining: request.method === 'POST' ? 0 : pollBudget };
    try { await advanceExport(job, userId, env.APP_STATE, onshapeFetcher(env, current, ledger, budget), env.ONSHAPE_API_VERSION, budget); }
    catch (error) {
      if (error instanceof SessionExpiredError) return reply({ error: 'Reconnect Onshape.' }, 401);
      throw error;
    } finally { await persistLedger(env.APP_STATE, ledger).catch(() => undefined); }
    // A poll that changed nothing writes nothing: with translations still running and every one of them checked, the
    // polling position wraps back to where it was. It moves only when more parts run than one poll covers, and then
    // saving it is what lets the next poll reach the others.
    const after = JSON.stringify(job);
    if (after !== before) await env.APP_STATE.put(jobKey(userId, job.jobId), after, { expirationTtl: 3600 });
    return reply(jobSummary(job));
  }
  return reply({ error: 'Not found' }, 404);
}
/**
 * Each vendor crawls hourly, 12 minutes apart, when its cron is scheduled in wrangler.toml. The crawls are paused at the
 * owner's request; only REV's cron is scheduled. It never crawls: every ten minutes it takes one small step of reading
 * REV's official feed (a download at most every six hours, then a few runs to stage and publish it), and a run with
 * nothing to do writes nothing. Every cron that is scheduled must be one of these (a test checks).
 */
export const cronVendors: Record<string, VendorId> = { '0 * * * *': 'gobilda', '12 * * * *': 'servocity', '24 * * * *': 'andymark', '*/10 * * * *': 'rev', '48 * * * *': 'pitsco' };

export default {
  async fetch(request: Request, env: Env) {
    const origin = request.headers.get('origin');
    if (request.method === 'OPTIONS' && origin === env.WEB_ORIGIN) return new Response(null, { status: 204, headers: { 'access-control-allow-origin': origin, 'access-control-allow-credentials': 'true', 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-allow-headers': 'content-type, x-content-sha256' } });
    let result: Response;
    try { result = await route(request, env); }
    catch (error) { console.error('Control Kit request failed', error); result = reply({ error: 'Control Kit could not complete this request. Try again.' }, 502); }
    if (origin === env.WEB_ORIGIN) {
      const headers = new Headers(result.headers);
      headers.set('access-control-allow-origin', origin);
      headers.set('access-control-allow-credentials', 'true');
      headers.set('vary', 'Origin');
      headers.set('access-control-expose-headers', 'x-picture-drawn');
      result = new Response(result.body, { status: result.status, statusText: result.statusText, headers });
    }
    return result;
  },
  scheduled(event: { cron: string }, env: Env, context: { waitUntil(promise: Promise<unknown>): void }) {
    const vendor = cronVendors[event.cron];
    // REV is never crawled: its cron reads REV's official feed (at most every six hours) and stages and publishes it in steps.
    if (vendor === 'rev') context.waitUntil(runRevFeed(env.VENDOR_CATALOG, fetch));
    else if (vendor) context.waitUntil(runVendor(vendor, env.VENDOR_CATALOG, fetch, { feedFreshHours: Number(env.VENDOR_STALE_HOURS ?? 336) }));
  },
};
