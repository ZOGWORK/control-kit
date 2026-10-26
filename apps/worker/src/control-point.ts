import { ControlPointError, type ControlPointAccount, type ControlPointAdapter, type ControlPointImport, type ControlPointImportSummary, type ControlPointWorkspace, type ScanResult } from '@control-kit/shared';
import type { Kv } from './index';
import { clearCookie, readSignedCookie, seal, signedCookie, unseal, type SignedCookie } from './secrets';

/**
 * Control Point linking and sending, contract §1 and §3 (docs/control-point-link.md). The Worker alone holds the
 * account's bearer token, sealed in `cp-link:{userId}`; the browser only ever sees the account, workspaces, and results.
 */
export type ControlPointEnv = { APP_STATE: Kv; WEB_ORIGIN: string; SESSION_ENCRYPTION_KEY: string; CONTROL_POINT_ORIGIN?: string; CONTROL_KIT_CLIENT_SECRET?: string };
type User = { id: string; name: string };
/**
 * `workspaces` and `workspacesAt` (ms) cache Control Point's list for ten minutes. `refreshTriedAt` (ms) is the last
 * refresh that failed, so a Control Point outage still gets the 30-second pause.
 */
type Link = { token: string; account: ControlPointAccount; workspaceId: number | null; linkedAt: string; workspaces?: ControlPointWorkspace[]; workspacesAt?: number; refreshTriedAt?: number };
export type SentRecord = { importId: number; workspaceId: number; sentAt: string; idempotencyKey: string; url: string };

export const sendLimitBytes = 12 * 1024 * 1024;
/** How much of a send's body is read before streaming the rest: the payload's key and assembly ids are at its start. */
const prefixBytes = 64 * 1024;
const workspacesFreshMs = 10 * 60_000;
/** "Check again" (`?refresh=1`) asks Control Point at most this often per person; sooner, the cached list is served. */
const refreshGapMs = 30_000;
const defaultOrigin = 'https://tryctrlpoint.org';
const stateCookie: SignedCookie = { name: 'controlkit_cp', path: '/control-point', label: 'control-kit control-point-state v1:' };
const linkKey = (userId: string) => `cp-link:${userId}`;
const sentKey = (userId: string, documentId: string, elementId: string) => `cp-sent:${userId}:${documentId}:${elementId}`;
const reply = (value: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers } });
const failure = (status: number, code: string, error: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) => reply({ error, code, ...extra }, status, headers);
export const controlPointOrigin = (env: ControlPointEnv) => (env.CONTROL_POINT_ORIGIN?.trim() || defaultOrigin).replace(/\/+$/, '');
export const controlPointAvailable = (env: ControlPointEnv) => Boolean(env.CONTROL_KIT_CLIENT_SECRET?.trim());

const text = (value: unknown, max: number) => typeof value === 'string' && value.length ? value.slice(0, max) : null;
const count = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
const badResponse = () => new ControlPointError(502, 'bad_response');
function readAccount(value: unknown): ControlPointAccount {
  const item = value as Record<string, unknown> | null;
  const email = text(item?.email, 320);
  if (!email) throw badResponse();
  return { email, name: text(item?.name, 200) ?? '' };
}
/** Only an id, a name, and fields of the documented shape pass; a link outside Control Point becomes its CAD page. */
function readWorkspace(value: unknown, origin: string): ControlPointWorkspace | null {
  const item = value as Record<string, unknown> | null;
  const id = item?.id;
  const name = text(item?.name, 200);
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0 || !name) return null;
  const accent = text(item?.accentColor, 7);
  const cadUrl = text(item?.cadUrl, 2048);
  return { id, name, ftcNumber: text(item?.ftcNumber, 10), accentColor: accent && /^#[0-9a-f]{6}$/i.test(accent) ? accent : null, canEditCad: item?.canEditCad === true,
    cadUrl: cadUrl?.startsWith(`${origin}/`) ? cadUrl : `${origin}/cad-parts` };
}
const ownUrl = (value: unknown, origin: string) => { const url = text(value, 2048); return url?.startsWith(`${origin}/`) ? url : `${origin}/cad-parts`; };
async function refusal(response: Response) {
  const body = await response.text().then(value => { try { return JSON.parse(value.slice(0, 4000)) as { error?: unknown; detail?: unknown }; } catch { return null; } }).catch(() => null);
  const code = typeof body?.error === 'string' && /^[a-z_]{1,40}$/.test(body.error) ? body.error : `http_${response.status}`;
  const retryAfter = Number(response.headers.get('retry-after'));
  return new ControlPointError(response.status, code, text(body?.detail, 300), Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 3600) : null);
}

/** Control Point over HTTPS with bounded timeouts and no retries: a refusal or a timeout throws `ControlPointError`. */
export class HttpControlPointAdapter implements ControlPointAdapter {
  constructor(private readonly origin: string, private readonly secret: string) {}
  private async call(path: string, init: RequestInit & { duplex?: 'half' }, timeoutMs: number) {
    let response: Response;
    try { response = await fetch(`${this.origin}/api/integrations/control-kit${path}`, { ...init, signal: AbortSignal.timeout(timeoutMs) }); }
    catch { throw new ControlPointError(503, 'unavailable'); }
    if (!response.ok) throw await refusal(response);
    return response;
  }
  private async json(response: Response) { try { return await response.json() as Record<string, unknown>; } catch { throw badResponse(); } }
  private bearer(token: string) { return { authorization: `Bearer ${token}` }; }
  async exchangeCode(code: string, redirectUri: string) {
    const response = await this.call('/token', { method: 'POST', headers: { authorization: `Basic ${btoa(`control-kit:${this.secret}`)}`, 'content-type': 'application/json' },
      body: JSON.stringify({ grant_type: 'authorization_code', code, redirect_uri: redirectUri }) }, 10_000);
    const body = await this.json(response);
    const accessToken = text(body.access_token, 512);
    if (!accessToken || accessToken.length < 8) throw badResponse();
    return { accessToken, account: readAccount(body.account) };
  }
  async workspaces(token: string) {
    const body = await this.json(await this.call('/workspaces', { headers: this.bearer(token) }, 10_000));
    return { account: readAccount(body.account), workspaces: (Array.isArray(body.workspaces) ? body.workspaces : []).map(item => readWorkspace(item, this.origin)).filter(item => item !== null) };
  }
  async sendBom(token: string, workspaceId: number, body: ReadableStream<Uint8Array> | string, length: number): Promise<ControlPointImport> {
    // Workers sends a stream of known length with that Content-Length; elsewhere (tests) it streams as-is.
    const Fixed = (globalThis as { FixedLengthStream?: new (length: number) => TransformStream<Uint8Array, Uint8Array> }).FixedLengthStream;
    let sent: ReadableStream<Uint8Array> | string = body;
    if (Fixed && typeof body !== 'string') { const fixed = new Fixed(length); body.pipeTo(fixed.writable).catch(() => undefined); sent = fixed.readable; }
    const response = await this.call(`/workspaces/${workspaceId}/bom`, { method: 'POST', headers: { ...this.bearer(token), 'content-type': 'application/json' }, body: sent, duplex: 'half' }, 60_000);
    const result = await this.json(response);
    const workspace = result.workspace as Record<string, unknown> | null;
    if (typeof result.importId !== 'number' || !Number.isSafeInteger(result.importId)) throw badResponse();
    return { importId: result.importId, duplicate: result.duplicate === true,
      workspace: { id: typeof workspace?.id === 'number' ? workspace.id : workspaceId, name: text(workspace?.name, 200) ?? '', ftcNumber: text(workspace?.ftcNumber, 10) },
      created: count(result.created), updated: count(result.updated), markedRemoved: count(result.markedRemoved), filesStored: count(result.filesStored),
      url: ownUrl(result.url, this.origin), sentAt: text(result.sentAt, 40) ?? new Date().toISOString() };
  }
  async imports(token: string, workspaceId: number, documentId: string, elementId: string): Promise<ControlPointImportSummary[]> {
    const query = new URLSearchParams({ document: documentId, element: elementId });
    const response = await this.call(`/workspaces/${workspaceId}/imports?${query}`, { headers: this.bearer(token) }, 10_000);
    const list = await response.json().catch(() => null) as unknown;
    return (Array.isArray(list) ? list : []).slice(0, 10).flatMap(value => {
      const item = value as Record<string, unknown>;
      if (typeof item?.importId !== 'number') return [];
      return [{ importId: item.importId, idempotencyKey: text(item.idempotencyKey, 128) ?? '', sentAt: text(item.sentAt, 40) ?? '', sentBy: text(item.sentBy, 320) ?? '',
        created: count(item.created), updated: count(item.updated), markedRemoved: count(item.markedRemoved), url: ownUrl(item.url, this.origin) }];
    });
  }
  async revoke(token: string) { await this.call('/revoke', { method: 'POST', headers: this.bearer(token) }, 5_000); }
}

/** The popup's last page: tells the Control Kit panel how linking ended, then closes itself when it worked. */
function popupPage(env: ControlPointEnv, status: number, message: { type: 'control-point-linked' } | { type: 'control-point-link-failed'; reason: string }, text: string) {
  const data = JSON.stringify({ message, origin: env.WEB_ORIGIN, close: message.type === 'control-point-linked' }).replace(/</g, '\\u003c');
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Control Kit</title></head>
<body style="margin:0;padding:32px 24px;background:#09090b;color:#fafafa;font:16px/1.5 system-ui,sans-serif"><p>${text}</p>
<script>(function(){var d=${data};try{if(window.opener)window.opener.postMessage(d.message,d.origin)}catch(e){}if(d.close)setTimeout(function(){window.close()},300)})()</script></body></html>`;
  return new Response(html, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'", 'set-cookie': clearCookie(stateCookie) } });
}
const linkFailed = (env: ControlPointEnv, status: number, reason: string, text: string) => popupPage(env, status, { type: 'control-point-link-failed', reason }, text);

async function readLink(env: ControlPointEnv, userId: string) {
  const raw = await env.APP_STATE.get(linkKey(userId));
  if (!raw) return null;
  try { return await unseal<Link>(env, raw); } catch { return null; }
}
const saveLink = async (env: ControlPointEnv, userId: string, link: Link) => env.APP_STATE.put(linkKey(userId), await seal(env, link));
/**
 * Applies a change worked out from a link read before a slow Control Point call to the link as it is now, and only
 * while it is still the same grant: an unlink or a relink made meanwhile wins, and the newest workspace choice is
 * kept. Returns the link as stored afterwards (null when there is none). KV cannot compare-and-swap, so this narrows
 * the race to one read and one write rather than closing it.
 */
async function updateLink(env: ControlPointEnv, userId: string, token: string, change: (current: Link) => Link) {
  const current = await readLink(env, userId);
  if (!current || current.token !== token) return current;
  const next = change(current);
  await saveLink(env, userId, next);
  return next;
}
/** Ends the link after Control Point refused `token`, unless a newer grant has replaced it meanwhile. */
async function forgetLink(env: ControlPointEnv, userId: string, token: string) {
  const current = await readLink(env, userId);
  if (current && current.token !== token) return current;
  if (current) await env.APP_STATE.delete(linkKey(userId));
  return null;
}
const pick = ({ id, name, ftcNumber, accentColor, canEditCad }: ControlPointWorkspace) => ({ id, name, ftcNumber, accentColor, canEditCad });
/** The last time Control Point was asked for the list, whether or not it answered. */
const lastRefresh = (link: Link) => Math.max(link.workspacesAt ?? 0, link.refreshTriedAt ?? 0);
function linkView(link: Link, stale = false) {
  const workspaces = link.workspaces ?? [];
  const workspace = workspaces.find(item => item.id === link.workspaceId);
  // When "Check again" may next ask Control Point for a fresh list.
  const refreshAfter = new Date(lastRefresh(link) + refreshGapMs).toISOString();
  return { linked: true, available: true, account: link.account, workspace: workspace ? pick(workspace) : null, workspaces, linkedAt: link.linkedAt, refreshAfter, ...(stale ? { stale: true } : {}) };
}
/**
 * Refreshes the cached workspace list when it is older than ten minutes (or always, with `force`). A revoked token
 * ends the link (null, `revoked`). Any other failure keeps the cached list and reports it as stale. The new list is
 * applied to the link as it is when Control Point answers, so a workspace picked meanwhile is kept and a newer link
 * or an unlink is never undone.
 */
async function refreshedLink(env: ControlPointEnv, adapter: ControlPointAdapter, userId: string, link: Link, force = false): Promise<{ link: Link | null; stale: boolean; revoked?: boolean }> {
  if (!force && link.workspaces && link.workspacesAt && Date.now() - link.workspacesAt < workspacesFreshMs) return { link, stale: false };
  try {
    const fresh = await adapter.workspaces(link.token);
    const next = await updateLink(env, userId, link.token, current => ({ ...current, account: fresh.account, workspaces: fresh.workspaces, workspacesAt: Date.now(),
      workspaceId: fresh.workspaces.some(item => item.id === current.workspaceId) ? current.workspaceId : null }));
    return { link: next, stale: false };
  } catch (error) {
    if (error instanceof ControlPointError && error.status === 401) {
      const current = await forgetLink(env, userId, link.token);
      return current ? { link: current, stale: false } : { link: null, stale: false, revoked: true };
    }
    return { link, stale: true };
  }
}
const revoked = () => failure(409, 'revoked', 'Control Point access was removed. Link Control Point again.', { linked: false });
/** Plain words for Control Point's refusals; the code is passed on so the panel can act on it. */
function sendRefusal(error: ControlPointError) {
  const words: Record<string, string> = {
    not_member: 'You are no longer a member of this Control Point workspace. Pick another one.',
    no_cad_edit: 'Your role in this workspace cannot edit CAD parts. Ask a workspace admin, or pick another workspace.',
    bad_payload: 'Control Point could not read this bundle. Rescan and send again.',
  };
  if (error.status === 413) return failure(413, 'too_large', 'This bundle is over 12 MB. Send it without the STEP files.');
  if (error.status === 429) return failure(429, 'rate_limited', 'Control Point is busy. Try again in a minute.', {}, error.retryAfter ? { 'retry-after': String(error.retryAfter) } : {});
  if (error.status === 400 || error.status === 403) return failure(error.status, error.code, words[error.code] ?? 'Control Point refused this bundle.', error.detail ? { detail: error.detail } : {});
  // A timeout may still have been imported; sending again is safe because Control Point recognises the same key.
  return failure(502, 'unavailable', 'Control Point did not answer. Sending again is safe: a repeat is recognised and changes nothing.');
}
/** The first bytes of `JSON.stringify(buildControlPointPayload(…))`: key, source, version, then the assembly's ids. */
const payloadStart = /^\{"idempotencyKey":"([0-9a-f]{64})","source":"control-kit","bundleVersion":2,"assembly":\{"name":"(?:[^"\\]|\\.)*","documentId":"([^"\\]{1,128})","elementId":"([^"\\]{1,128})"/;
/**
 * Reads only the start of the body (to check whose assembly it is and to learn its key) and streams the rest through
 * untouched, refusing more bytes than the request declared. The 10 ms CPU limit rules out parsing up to 12 MB of JSON.
 */
async function splitBody(body: ReadableStream<Uint8Array>, length: number) {
  const reader = body.getReader();
  const head: Uint8Array[] = [];
  let size = 0;
  let done = false;
  while (size < prefixBytes) {
    const next = await reader.read();
    if (next.done) { done = true; break; }
    head.push(next.value);
    size += next.value.byteLength;
  }
  const joined = new Uint8Array(Math.min(size, prefixBytes));
  let offset = 0;
  for (const chunk of head) { if (offset >= joined.length) break; const part = chunk.subarray(0, joined.length - offset); joined.set(part, offset); offset += part.length; }
  const match = new TextDecoder().decode(joined).match(payloadStart);
  let total = size;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      if (size > length) { controller.error(new Error('Body longer than its Content-Length')); return; }
      for (const chunk of head) controller.enqueue(chunk);
      if (done) controller.close();
    },
    async pull(controller) {
      const next = await reader.read();
      if (next.done) { controller.close(); return; }
      total += next.value.byteLength;
      if (total > length) { controller.error(new Error('Body longer than its Content-Length')); await reader.cancel(); return; }
      controller.enqueue(next.value);
    },
    cancel(reason) { return reader.cancel(reason); },
  });
  return { stream, idempotencyKey: match?.[1] ?? null, documentId: match?.[2] ?? null, elementId: match?.[3] ?? null, oversized: size > length };
}

export async function controlPointRoute(request: Request, url: URL, env: ControlPointEnv, user: User | null, adapter: ControlPointAdapter = new HttpControlPointAdapter(controlPointOrigin(env), env.CONTROL_KIT_CLIENT_SECRET?.trim() ?? '')): Promise<Response> {
  const available = controlPointAvailable(env);
  const callbackUri = `${url.origin}/control-point/callback`;
  if (url.pathname === '/control-point/start' && request.method === 'GET') {
    if (!available) return linkFailed(env, 503, 'unavailable', 'Control Point linking is not set up on this server.');
    if (!user) return linkFailed(env, 401, 'signed-out', 'Open Control Kit in Onshape and connect it first, then link Control Point again.');
    const state = crypto.randomUUID();
    const destination = new URL('/connect/control-kit', controlPointOrigin(env));
    destination.search = new URLSearchParams({ state, redirect_uri: callbackUri }).toString();
    return new Response(null, { status: 302, headers: { location: destination.toString(), 'cache-control': 'no-store', 'set-cookie': await signedCookie(env, stateCookie, { state, userId: user.id }) } });
  }
  if (url.pathname === '/control-point/callback' && request.method === 'GET') {
    if (!available) return linkFailed(env, 503, 'unavailable', 'Control Point linking is not set up on this server.');
    if (!user) return linkFailed(env, 401, 'signed-out', 'Open Control Kit in Onshape and connect it first, then link Control Point again.');
    const state = url.searchParams.get('state');
    const saved = await readSignedCookie<{ state: string; userId: string }>(request, env, stateCookie);
    // Only the browser and person that started linking can finish it.
    if (!state || !saved || saved.state !== state || saved.userId !== user.id) return linkFailed(env, 400, 'expired', 'This link request expired. Close this window and link Control Point again.');
    if (url.searchParams.get('error')) return linkFailed(env, 200, 'cancelled', 'Linking was cancelled. You can close this window.');
    const code = url.searchParams.get('code');
    if (!code || code.length > 512) return linkFailed(env, 400, 'expired', 'This link request expired. Close this window and link Control Point again.');
    let granted: Awaited<ReturnType<ControlPointAdapter['exchangeCode']>>;
    try { granted = await adapter.exchangeCode(code, callbackUri); }
    catch (error) {
      if (error instanceof ControlPointError && error.code === 'invalid_grant') return linkFailed(env, 400, 'expired', 'This link request expired. Close this window and link Control Point again.');
      if (error instanceof ControlPointError && error.code === 'invalid_client') return linkFailed(env, 502, 'refused', 'Control Point did not accept this server. Tell the Control Kit owner.');
      return linkFailed(env, 502, 'unavailable', 'Control Point did not answer. Close this window and try again.');
    }
    // Linking again replaces the earlier grant, which is revoked so it does not linger.
    const earlier = await readLink(env, user.id);
    if (earlier && earlier.token !== granted.accessToken) await adapter.revoke(earlier.token).catch(() => undefined);
    await saveLink(env, user.id, { token: granted.accessToken, account: granted.account, workspaceId: null, linkedAt: new Date().toISOString() });
    return popupPage(env, 200, { type: 'control-point-linked' }, 'Control Point is linked. You can close this window.');
  }
  if (url.pathname === '/api/control-point/link' && request.method === 'GET') {
    if (!available) return reply({ linked: false, available: false });
    if (!user) return reply({ error: 'Reconnect Onshape.' }, 401);
    const link = await readLink(env, user.id);
    if (!link) return reply({ linked: false, available: true });
    // Within 30 seconds of the last call to Control Point, answered or not, nothing asks it again, whether "Check
    // again" forced the refresh or the cached list expired; the cached list is served, marked stale when expired.
    if (Date.now() - lastRefresh(link) < refreshGapMs) {
      const cached = !!link.workspaces && !!link.workspacesAt && Date.now() - link.workspacesAt < workspacesFreshMs;
      return reply(linkView(link, !cached));
    }
    let fresh = await refreshedLink(env, adapter, user.id, link, url.searchParams.get('refresh') === '1');
    // A failed refresh still starts the pause, so repeated reads do not keep calling a struggling Control Point.
    if (fresh.stale) fresh = { ...fresh, link: await updateLink(env, user.id, link.token, current => ({ ...current, refreshTriedAt: Date.now() })) };
    return fresh.link ? reply(linkView(fresh.link, fresh.stale)) : reply({ linked: false, available: true, ...(fresh.revoked ? { revoked: true } : {}) });
  }
  if (url.pathname === '/api/control-point/workspace' && request.method === 'POST') {
    if (request.headers.get('origin') !== env.WEB_ORIGIN) return reply({ error: 'Invalid request origin.' }, 403);
    if (!available) return failure(501, 'unavailable', 'Control Point linking is not set up on this server.');
    if (!user) return reply({ error: 'Reconnect Onshape.' }, 401);
    const body = await request.json().catch(() => null) as { workspaceId?: unknown } | null;
    const workspaceId = body?.workspaceId;
    if (typeof workspaceId !== 'number' || !Number.isSafeInteger(workspaceId) || workspaceId <= 0) return failure(400, 'bad_request', 'Pick a workspace.');
    const link = await readLink(env, user.id);
    if (!link) return failure(409, 'not_linked', 'Link Control Point first.', { linked: false });
    // A workspace missing from the cached list may be new: read the list once more before refusing.
    const fresh = await refreshedLink(env, adapter, user.id, link, !link.workspaces?.some(item => item.id === workspaceId));
    if (!fresh.link) return fresh.revoked ? revoked() : failure(409, 'not_linked', 'Link Control Point first.', { linked: false });
    // Linked again meanwhile, perhaps as another account: its workspaces were never checked, so nothing is chosen.
    if (fresh.link.token !== link.token) return reply(linkView(fresh.link));
    const workspace = fresh.link.workspaces?.find(item => item.id === workspaceId);
    if (!workspace && fresh.stale) return failure(502, 'unavailable', 'Control Point did not answer. Try again.');
    if (!workspace) return failure(409, 'not_member', 'This workspace is not one of your Control Point workspaces.');
    if (!workspace.canEditCad) return failure(403, 'no_cad_edit', 'Your role in this workspace cannot edit CAD parts. Ask a workspace admin, or pick another workspace.');
    const chosen = await updateLink(env, user.id, link.token, current => ({ ...current, workspaceId }));
    if (!chosen) return failure(409, 'not_linked', 'Link Control Point first.', { linked: false });
    return reply(linkView(chosen, fresh.stale));
  }
  if (url.pathname === '/api/control-point/send' && request.method === 'POST') {
    if (request.headers.get('origin') !== env.WEB_ORIGIN) return reply({ error: 'Invalid request origin.' }, 403);
    if (!available) return failure(501, 'unavailable', 'Control Point linking is not set up on this server.');
    if (!user) return reply({ error: 'Reconnect Onshape.' }, 401);
    const scanId = url.searchParams.get('scanId');
    if (!scanId || !/^[a-f0-9-]{36}$/.test(scanId)) return failure(400, 'bad_request', 'Invalid scan.');
    // The workspace the Send button named: a bundle never goes anywhere else.
    const named = url.searchParams.get('workspaceId');
    const workspaceId = named && /^[1-9]\d{0,15}$/.test(named) ? Number(named) : null;
    if (workspaceId === null || !Number.isSafeInteger(workspaceId)) return failure(400, 'bad_request', 'Name the workspace to send to.');
    const declared = request.headers.get('content-length');
    const length = declared && /^\d{1,9}$/.test(declared) ? Number(declared) : null;
    if (length === null) return failure(411, 'length_required', 'Control Kit could not size this bundle. Try again.');
    if (length > sendLimitBytes) return failure(413, 'too_large', 'This bundle is over 12 MB. Send it without the STEP files.');
    if (!request.body || length === 0) return failure(400, 'bad_payload', 'Build the Control Point bundle from this scan.');
    // Only the person's own scan, which proves their Onshape access read this assembly.
    const raw = await env.APP_STATE.get(`scan:${user.id}:${scanId}`);
    if (!raw) return failure(409, 'scan_missing', 'Scan this assembly again before sending it.');
    const scanned = JSON.parse(raw) as ScanResult;
    const link = await readLink(env, user.id);
    if (!link) return failure(409, 'not_linked', 'Link Control Point first.', { linked: false });
    if (link.workspaceId === null) return failure(409, 'no_workspace', 'Pick a Control Point workspace first.');
    if (link.workspaceId !== workspaceId) return failure(409, 'workspace_changed', 'The workspace changed while sending. Check where it goes and send again.');
    const body = await splitBody(request.body, length);
    if (body.oversized) return failure(400, 'bad_payload', 'The bundle is longer than its declared size.');
    if (!body.idempotencyKey) return failure(400, 'bad_payload', 'Build the Control Point bundle from this scan.');
    if (body.documentId !== scanned.documentId || body.elementId !== scanned.elementId) return failure(409, 'scan_mismatch', 'This bundle is not from that scan. Rescan and send again.');
    let result: ControlPointImport;
    try { result = await adapter.sendBom(link.token, link.workspaceId, body.stream, length); }
    catch (error) {
      if (!(error instanceof ControlPointError)) return sendRefusal(new ControlPointError(503, 'unavailable'));
      // Only this grant was refused: a link made while the bundle was sending stays.
      if (error.status === 401) { await forgetLink(env, user.id, link.token); return revoked(); }
      return sendRefusal(error);
    }
    const record: SentRecord = { importId: result.importId, workspaceId: link.workspaceId, sentAt: result.sentAt, idempotencyKey: body.idempotencyKey, url: result.url };
    await env.APP_STATE.put(sentKey(user.id, scanned.documentId, scanned.elementId), JSON.stringify(record), { expirationTtl: 365 * 86400 });
    return reply(result);
  }
  if (url.pathname === '/api/control-point/sent' && request.method === 'GET') {
    if (!user) return reply({ error: 'Reconnect Onshape.' }, 401);
    const documentId = url.searchParams.get('documentId');
    const elementId = url.searchParams.get('elementId');
    if (!documentId || !/^[\w-]{1,128}$/.test(documentId) || !elementId || !/^[\w-]{1,128}$/.test(elementId)) return failure(400, 'bad_request', 'Invalid assembly.');
    const raw = await env.APP_STATE.get(sentKey(user.id, documentId, elementId));
    return reply(raw ? JSON.parse(raw) as SentRecord : null);
  }
  if (url.pathname === '/api/control-point/unlink' && request.method === 'POST') {
    if (request.headers.get('origin') !== env.WEB_ORIGIN) return reply({ error: 'Invalid request origin.' }, 403);
    if (!user) return reply({ error: 'Reconnect Onshape.' }, 401);
    const link = await readLink(env, user.id);
    // Best effort: the link is removed here even when Control Point cannot be reached. Sent records are kept.
    if (!link) return reply({ linked: false, available });
    await adapter.revoke(link.token).catch(() => undefined);
    // Only the grant this unlink read: a link finished in another window while revoke ran stays, and is shown.
    const current = await forgetLink(env, user.id, link.token);
    return reply(current ? linkView(current) : { linked: false, available });
  }
  return reply({ error: 'Not found' }, 404);
}
