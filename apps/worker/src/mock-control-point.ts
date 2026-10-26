import { createServer } from 'node:http';
import type { ControlPointBomPayload, ControlPointWorkspace } from '@control-kit/shared';

/**
 * Control Point's integration API as docs/control-point-link.md describes it, in memory. Tests call `handle` directly
 * (this sandbox blocks loopback); `pnpm --filter @control-kit/worker exec node --experimental-strip-types
 * src/mock-control-point.ts` serves it on 127.0.0.1:8790 for local runs. The consent page allows at once unless
 * `deny` is set.
 */
export function createMockControlPoint(options: { origin?: string; secret?: string; redirectUris?: string[] } = {}) {
  const origin = options.origin ?? 'http://localhost:8790';
  const secret = options.secret ?? 'cp-secret';
  const redirectUris = options.redirectUris ?? ['http://localhost:8787/control-point/callback'];
  const account = { email: 'student@example.org', name: 'Sam' };
  let workspaces: ControlPointWorkspace[] = [
    { id: 12, name: 'HORS', ftcNumber: '6980', accentColor: '#2f6bff', canEditCad: true, cadUrl: `${origin}/cad-parts` },
    { id: 13, name: 'Scrimmage', ftcNumber: null, accentColor: null, canEditCad: false, cadUrl: `${origin}/cad-parts` },
  ];
  const codes = new Map<string, { redirectUri: string; expires: number }>();
  const tokens = new Set<string>();
  const imports: Array<{ importId: number; workspaceId: number; idempotencyKey: string; documentId: string; elementId: string; sentAt: string; created: number; files: number }> = [];
  const received: Array<{ workspaceId: number; payload: ControlPointBomPayload }> = [];
  const requests: string[] = [];
  let deny = false;
  let issued = 0;
  const json = (status: number, value: unknown) => Response.json(value, { status });
  const bearer = (request: Request) => {
    const token = request.headers.get('authorization')?.match(/^Bearer (ckp_\w+)$/)?.[1];
    return token && tokens.has(token) ? token : null;
  };
  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    requests.push(`${request.method} ${url.pathname}`);
    if (url.pathname === '/connect/control-kit') {
      const redirect = url.searchParams.get('redirect_uri') ?? '';
      if (!redirectUris.includes(redirect)) return new Response('Unknown redirect_uri', { status: 400 });
      const destination = new URL(redirect);
      destination.searchParams.set('state', url.searchParams.get('state') ?? '');
      if (deny) destination.searchParams.set('error', 'access_denied');
      else {
        const code = `code-${++issued}-${crypto.randomUUID()}`;
        codes.set(code, { redirectUri: redirect, expires: Date.now() + 300_000 });
        destination.searchParams.set('code', code);
      }
      return Response.redirect(destination, 302);
    }
    const base = '/api/integrations/control-kit';
    if (url.pathname === `${base}/token` && request.method === 'POST') {
      if (request.headers.get('authorization') !== `Basic ${btoa(`control-kit:${secret}`)}`) return json(401, { error: 'invalid_client' });
      const body = await request.json() as { grant_type?: string; code?: string; redirect_uri?: string };
      const grant = body.code ? codes.get(body.code) : undefined;
      if (body.code) codes.delete(body.code);
      if (body.grant_type !== 'authorization_code' || !grant || grant.expires < Date.now() || grant.redirectUri !== body.redirect_uri) return json(400, { error: 'invalid_grant' });
      const token = `ckp_${crypto.randomUUID().replace(/-/g, '')}`;
      tokens.add(token);
      return json(200, { access_token: token, token_type: 'Bearer', account });
    }
    if (!url.pathname.startsWith(base)) return json(404, { error: 'not_found' });
    const token = bearer(request);
    if (!token) return json(401, { error: 'revoked' });
    if (url.pathname === `${base}/workspaces` && request.method === 'GET') return json(200, { account, workspaces });
    if (url.pathname === `${base}/revoke` && request.method === 'POST') { tokens.delete(token); return new Response(null, { status: 204 }); }
    const bom = url.pathname.match(new RegExp(`^${base}/workspaces/(\\d+)/bom$`));
    if (bom && request.method === 'POST') {
      const workspace = workspaces.find(item => item.id === Number(bom[1]));
      if (!workspace) return json(403, { error: 'not_member' });
      if (!workspace.canEditCad) return json(403, { error: 'no_cad_edit' });
      const text = await request.text();
      if (text.length > 12 * 1024 * 1024) return json(413, { error: 'too_large' });
      let payload: ControlPointBomPayload;
      try { payload = JSON.parse(text) as ControlPointBomPayload; } catch { return json(400, { error: 'bad_payload', detail: 'not JSON' }); }
      if (payload.source !== 'control-kit' || payload.bundleVersion !== 2 || !Array.isArray(payload.cadParts)) return json(400, { error: 'bad_payload', detail: 'source, bundleVersion, or cadParts' });
      const result = (item: typeof imports[number], duplicate: boolean) => json(200, { importId: item.importId, duplicate, workspace: { id: workspace.id, name: workspace.name, ftcNumber: workspace.ftcNumber },
        created: duplicate ? 0 : item.created, updated: 0, markedRemoved: 0, filesStored: item.files, url: `${origin}/cad-parts?import=${item.importId}`, sentAt: item.sentAt });
      const earlier = imports.find(item => item.workspaceId === workspace.id && item.idempotencyKey === payload.idempotencyKey);
      if (earlier) return result(earlier, true);
      received.push({ workspaceId: workspace.id, payload });
      const item = { importId: 40 + imports.length + 1, workspaceId: workspace.id, idempotencyKey: payload.idempotencyKey, documentId: payload.assembly.documentId, elementId: payload.assembly.elementId,
        sentAt: new Date().toISOString(), created: payload.cadParts.length, files: payload.files.filter(file => file.delivery === 'inline').length };
      imports.push(item);
      return result(item, false);
    }
    const list = url.pathname.match(new RegExp(`^${base}/workspaces/(\\d+)/imports$`));
    if (list && request.method === 'GET') {
      if (!workspaces.some(item => item.id === Number(list[1]))) return json(403, { error: 'not_member' });
      return json(200, imports.filter(item => item.workspaceId === Number(list[1]) && item.documentId === url.searchParams.get('document') && item.elementId === url.searchParams.get('element')).reverse().slice(0, 10)
        .map(item => ({ importId: item.importId, idempotencyKey: item.idempotencyKey, sentAt: item.sentAt, sentBy: account.email, created: item.created, updated: 0, markedRemoved: 0, url: `${origin}/cad-parts?import=${item.importId}` })));
    }
    return json(404, { error: 'not_found' });
  }
  const server = createServer(async (request, response) => {
    const body: Uint8Array[] = [];
    for await (const chunk of request) body.push(chunk);
    const result = await handle(new Request(`http://localhost:8790${request.url}`, { method: request.method, headers: request.headers as Record<string, string>, body: request.method === 'POST' ? Buffer.concat(body) : undefined, duplex: 'half' } as RequestInit));
    response.writeHead(result.status, Object.fromEntries(result.headers));
    response.end(Buffer.from(await result.arrayBuffer()));
  });
  return {
    handle, server, received, requests,
    /** Control Point's Settings → Disconnect: every token of the account stops working. */
    revokeAll() { tokens.clear(); },
    setWorkspaces(list: ControlPointWorkspace[]) { workspaces = list; },
    setDeny(value: boolean) { deny = value; },
  };
}

if (process.argv[1]?.endsWith('mock-control-point.ts')) {
  createMockControlPoint().server.listen(8790, '127.0.0.1', () => process.stdout.write('Mock Control Point listening on 127.0.0.1:8790\n'));
}
