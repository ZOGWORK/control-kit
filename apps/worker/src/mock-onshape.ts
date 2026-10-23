import { createServer } from 'node:http';

export function createMockOnshape() {
  let once = false;
  let apiRequests = 0;
  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const json = (status: number, value: unknown) => Response.json(value, { status });
    if (url.pathname === '/oauth/authorize') {
      const destination = new URL(url.searchParams.get('redirect_uri') ?? 'http://localhost:8787/oauth/redirect');
      destination.searchParams.set('code', 'mock-code');
      destination.searchParams.set('state', url.searchParams.get('state') ?? '');
      return Response.redirect(destination, 302);
    }
    if (url.pathname === '/oauth/token' && request.method === 'POST') {
      const grant = new URLSearchParams(await request.text()).get('grant_type');
      if (grant === 'authorization_code') return json(200, { access_token: 'mock-access', refresh_token: 'mock-refresh', expires_in: 3600 });
      if (grant === 'refresh_token') return json(200, { access_token: 'mock-refreshed', refresh_token: 'mock-refresh-2', expires_in: 3600 });
      return json(400, { error: 'invalid_grant' });
    }
    if (url.pathname === '/api/users/sessioninfo') { apiRequests++; return json(200, { id: 'mock-user', name: 'FTC Mentor' }); }
    if (url.pathname.startsWith('/api/')) {
      apiRequests++;
      if (url.searchParams.has('failOnce') && !once) { once = true; return json(401, { error: 'expired' }); }
      return json(200, { mock: true, path: url.pathname });
    }
    return json(404, { error: 'not_found' });
  }
  const server = createServer(async (request, response) => {
    const body: Uint8Array[] = [];
    for await (const chunk of request) body.push(chunk);
    const result = await handle(new Request(`http://localhost:8788${request.url}`, { method: request.method, body: request.method === 'POST' ? Buffer.concat(body) : undefined, duplex: 'half' } as RequestInit));
    response.writeHead(result.status, Object.fromEntries(result.headers));
    response.end(Buffer.from(await result.arrayBuffer()));
  });
  return { server, handle, get apiRequests() { return apiRequests; } };
}

if (process.argv[1]?.endsWith('mock-onshape.ts')) {
  createMockOnshape().server.listen(8788, '127.0.0.1', () => process.stdout.write('Mock Onshape listening on 127.0.0.1:8788\n'));
}
