import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';

const fixtures = Object.fromEntries(['simple', 'robot', 'empty'].map((key, index) => [key, JSON.parse(readFileSync(new URL(`../../../fixtures/assembly-${['simple', 'ftc-robot', 'empty'][index]}.json`, import.meta.url), 'utf8'))]));

/** BOM properties the fixtures' parts carry in Onshape. Synthetic, shaped like BTBillOfMaterialsInfo. */
const bomProperties: Record<string, { description?: string; vendor?: string; material?: { displayName: string } }> = {
  'motor-5203': { description: 'Yellow Jacket planetary gear motor', vendor: 'goBILDA' },
  'sensor-mount': { material: { displayName: 'PLA' } },
  'intake-guide': { material: { displayName: 'PETG' } },
};
type MockInstance = { name: string; type: string; documentId: string; elementId: string; partId?: string; partNumber?: string; suppressed?: boolean };
type MockDefinition = { rootAssembly: { name?: string; instances: MockInstance[] }; subAssemblies?: Array<{ elementId: string; instances: MockInstance[] }> };
/** Builds the flattened BOM Onshape would return for a fixture definition: active parts only, counted per part. */
export function mockBom(definition: MockDefinition) {
  const rows = new Map<string, { name: string; quantity: number; instance: MockInstance }>();
  const walk = (instances: MockInstance[]) => {
    for (const instance of instances) {
      if (instance.suppressed) continue;
      if (instance.type.toLowerCase() === 'assembly') { walk(definition.subAssemblies?.find(sub => sub.elementId === instance.elementId)?.instances ?? []); continue; }
      const key = `${instance.documentId}:${instance.elementId}:${instance.partId}`;
      const row = rows.get(key) ?? { name: instance.name.replace(/\s*<\d+>$/, ''), quantity: 0, instance };
      row.quantity++;
      rows.set(key, row);
    }
  };
  walk(definition.rootAssembly.instances);
  const headers = [['h-name', 'name', 'Name'], ['h-qty', 'quantity', 'Quantity'], ['h-pn', 'partNumber', 'Part number'], ['h-desc', 'description', 'Description'], ['h-vendor', 'vendor', 'Vendor'], ['h-mat', 'material', 'Material']]
    .map(([id, propertyName, name]) => ({ id, propertyName, name, visible: true }));
  return { name: 'Bill of materials', headers, bomSource: { document: { name: `${definition.rootAssembly.name ?? 'Robot'} document` }, element: { name: definition.rootAssembly.name ?? 'Assembly' } },
    rows: [...rows.values()].map(({ name, quantity, instance }) => ({ headerIdToValue: { 'h-name': name, 'h-qty': quantity, 'h-pn': instance.partNumber ?? '', 'h-desc': bomProperties[instance.partId ?? '']?.description ?? '', 'h-vendor': bomProperties[instance.partId ?? '']?.vendor ?? '', 'h-mat': bomProperties[instance.partId ?? '']?.material ?? null },
      itemSource: { documentId: instance.documentId, elementId: instance.elementId, partId: instance.partId, wvmType: 'w', wvmId: 'work1', fullConfiguration: 'default', configuration: 'default', isStandardContent: false } })) };
}

export function createMockOnshape() {
  let bomFailure: number | null = null;
  let once = false;
  let apiRequests = 0;
  let rateLimitRemaining = 0;
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
      const params = new URLSearchParams(await request.text());
      const grant = params.get('grant_type');
      if (grant === 'authorization_code') return json(200, { access_token: 'mock-access', refresh_token: 'mock-refresh', expires_in: 3600 });
      if (grant === 'refresh_token' && params.get('refresh_token') === 'reject-refresh') return json(400, { error: 'invalid_grant' });
      if (grant === 'refresh_token') return json(200, { access_token: 'mock-refreshed', refresh_token: 'mock-refresh-2', expires_in: 3600 });
      return json(400, { error: 'invalid_grant' });
    }
    if (url.pathname === '/api/users/sessioninfo') { apiRequests++; return json(200, { id: 'mock-user', name: 'FTC Mentor' }); }
    if (/^\/api\/v\d+\/documents\/d\/(simple|robot|empty)\/w\/[^/]+\/currentmicroversion$/.test(url.pathname)) { apiRequests++; return json(200, { microversion: 'mv-1' }); }
    const bom = url.pathname.match(/^\/api\/v\d+\/assemblies\/d\/(simple|robot|empty)\/[wvm]\/[^/]+\/e\/[^/]+\/bom$/);
    if (bom) {
      apiRequests++;
      if (bomFailure) return json(bomFailure, { error: 'fixture_bom_failure' });
      if (url.searchParams.get('indented') !== 'false') return json(400, { error: 'expected a flattened BOM' });
      return json(200, mockBom(fixtures[bom[1]]));
    }
    const assembly = url.pathname.match(/^\/api\/v\d+\/assemblies\/d\/(simple|robot|empty)\/[wvm]\/[^/]+\/e\/[^/]+$/);
    if (assembly) {
      apiRequests++;
      if (rateLimitRemaining-- > 0) return json(429, { error: 'rate_limited' });
      if (url.searchParams.get('excludeSuppressed') !== 'false') return json(400, { error: 'excludeSuppressed must be false' });
      return json(200, fixtures[assembly[1]]);
    }
    const mass = url.pathname.match(/^\/api\/v\d+\/partstudios\/d\/[^/]+\/[wvm]\/[^/]+\/e\/([^/]+)\/massproperties$/);
    if (mass) {
      apiRequests++;
      if (mass[1] === 'gears') return json(503, { error: 'fixture_metadata_failure' });
      const ids: Record<string, string> = { screws: 'screw-m3', motors: 'motor-5203', wheels: 'wheel-96', bearings: 'bearing-8' };
      if (mass[1] === 'prints') return json(200, { bodies: { 'sensor-mount': { mass: [0.012], material: 'PLA' }, 'intake-guide': { mass: [0.018], material: 'PETG' } } });
      const id = ids[mass[1]];
      return id ? json(200, { bodies: { [id]: { mass: [0.012], material: 'Steel' } } }) : json(404, { error: 'not_found' });
    }
    if (/^\/api\/v\d+\/parts\/d\/[^/]+\/[wvm]\/[^/]+\/e\/[^/]+\/partid\/[^/]+\/stl$/.test(url.pathname)) {
      apiRequests++;
      return url.pathname.includes('/partid/intake-guide/') ? Response.redirect('http://localhost:8788/api/v9/stl-download/intake-guide', 307) : json(404, { error: 'no_direct_stl' });
    }
    if (url.pathname === '/api/v9/stl-download/intake-guide') { apiRequests++; return new Response('solid intake-guide\nendsolid intake-guide\n', { headers: { 'content-type': 'application/sla' } }); }
    if (/^\/api\/v\d+\/partstudios\/d\/[^/]+\/[wvm]\/[^/]+\/e\/[^/]+\/translations$/.test(url.pathname) && request.method === 'POST') {
      apiRequests++;
      return json(200, { id: 'mock-translation' });
    }
    if (/^\/api\/v\d+\/translations\/mock-translation$/.test(url.pathname)) {
      apiRequests++;
      return json(200, { requestState: 'FAILED', failureReason: 'Deliberate fixture STL failure' });
    }
    if (url.pathname.startsWith('/api/')) {
      apiRequests++;
      if (url.searchParams.has('always401')) return json(401, { error: 'expired' });
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
  return { server, handle, setRateLimit(count: number) { rateLimitRemaining = count; }, setBomFailure(status: number | null) { bomFailure = status; }, get apiRequests() { return apiRequests; } };
}

if (process.argv[1]?.endsWith('mock-onshape.ts')) {
  createMockOnshape().server.listen(8788, '127.0.0.1', () => process.stdout.write('Mock Onshape listening on 127.0.0.1:8788\n'));
}
