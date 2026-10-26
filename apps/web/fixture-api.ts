import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import type { Plugin } from 'vite';
import { aggregateAssembly, classifyScan, mergeBom, wantsStep, type AssemblyDefinition, type CatalogHealth, type ScanResult } from '../../packages/shared/src/index';
import { mockBom, mockStep } from '../worker/src/mock-onshape';

/** The team's choices a saved scan already carries, so serving it keeps them as the Worker would. */
const savedChoices = (result: ScanResult) => Object.fromEntries(result.lines.flatMap(line => line.manualClassification ? [[line.bomLineKey, line.manualClassification]] : []));

/**
 * `vite --mode fixture`: a local stand-in for the Worker API, so the UI can be run and reviewed with no Onshape
 * account, secrets, or network. It serves `CK_FIXTURE` (a saved ScanResult JSON, kept out of Git) or, by default,
 * the synthetic FTC robot fixture. Choices are accepted but not stored; STEP export returns mock files. With
 * `CK_CATALOG` set to a Worker origin, a saved scan whose vendor matching is pending is matched against that Worker's
 * public catalogs (library mappings need a session, so they read as absent). `CK_PREVIEWS` may name a folder of part
 * pictures saved as `{sha256(bomLineKey)}.png`.
 */
export function fixtureApi(fixturePath?: string, catalogOrigin?: string, previewDir?: string): Plugin {
  const load = (): ScanResult => {
    if (fixturePath) return JSON.parse(readFileSync(fixturePath, 'utf8')) as ScanResult;
    const definition = JSON.parse(readFileSync(new URL('../../fixtures/assembly-ftc-robot.json', import.meta.url), 'utf8')) as AssemblyDefinition;
    const result = aggregateAssembly(definition, { documentId: 'robot', workspaceOrVersion: 'w', workspaceOrVersionId: 'work1', elementId: 'assembly' }, 'FTC Competition Robot');
    mergeBom(result, mockBom(definition as Parameters<typeof mockBom>[0]));
    result.documentName = 'Fixture robot';
    const now = new Date().toISOString();
    const vendor = (vendorId: CatalogHealth['vendors'][number]['vendorId'], state: CatalogHealth['vendors'][number]['state'], complete: boolean, recordCount: number) =>
      ({ vendorId, state, complete, recordCount, updatedAt: state === 'published' ? now : null, lastRunAt: now, stale: false, lastRunFailed: state === 'failing', error: null, skipped: {}, progress: null });
    result.catalogHealth = { checkedAt: now, vendors: [vendor('gobilda', 'published', false, 37), vendor('servocity', 'building', false, 0), vendor('andymark', 'building', false, 0), vendor('rev', 'building', false, 0), vendor('pitsco', 'building', false, 0)] };
    return classifyScan(result, { teamNumber: null }, {});
  };
  let settings = { teamNumber: null as string | null };
  return {
    name: 'control-kit-fixture-api',
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const url = new URL(request.url ?? '/', 'http://localhost');
        if (!url.pathname.startsWith('/api/')) return next();
        const json = (value: unknown, status = 200) => { response.statusCode = status; response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(value)); };
        const body = async () => { let text = ''; for await (const chunk of request) text += chunk; return text ? JSON.parse(text) as Record<string, unknown> : {}; };
        const result = { ...load(), scanId: '00000000-0000-4000-8000-0000000000aa', scannedAt: new Date().toISOString() };
        if (url.pathname === '/api/session') return json({ connected: true, user: { id: 'fixture', name: 'Fixture user' } });
        if (url.pathname === '/api/settings') { if (request.method === 'POST') settings = await body() as typeof settings; return json(settings); }
        if (url.pathname === '/api/logout') { response.statusCode = 204; return response.end(); }
        if (url.pathname === '/api/classification/override' || url.pathname === '/api/matches/decision') { await body(); return json({ saved: true }); }
        if (url.pathname === '/api/catalog/raw' && catalogOrigin) {
          const key = url.searchParams.get('key') ?? '';
          if (key.startsWith('library-map:')) { response.statusCode = 404; return response.end(); }
          const upstream = await fetch(`${catalogOrigin}/api/catalog/raw?key=${encodeURIComponent(key)}`);
          response.statusCode = upstream.status;
          return response.end(await upstream.text());
        }
        if (url.pathname === '/api/preview') {
          const file = previewDir && `${previewDir}/${createHash('sha256').update(url.searchParams.get('line') ?? '').digest('hex')}.png`;
          if (!file || !existsSync(file)) return json({ error: 'No saved picture for this part.' }, 404);
          response.setHeader('content-type', 'image/png');
          return response.end(readFileSync(file));
        }
        if (url.pathname === '/api/scan') {
          response.setHeader('content-type', 'application/x-ndjson');
          // The same steps and counts the Worker sends, so the progress screen can be seen here.
          // A saved scan reports what it really read; its subassembly count is not kept, so it is left out.
          const counts = fixturePath ? {} : { subassemblies: 4 };
          const read = { ...counts, bomRows: result.diagnostics?.bom?.rows ?? result.lines.length, cached: result.diagnostics?.cache === 'hit' };
          for (const [stage, step, current, extra] of [['Checking assembly revision…', 'revision', 0, {}], ['Reading assembly…', 'assembly', 1, {}], ["Reading Onshape's bill of materials…", 'bom', 2, counts],
            ['Reading saved choices…', 'choices', 3, { ...read, parts: result.stats.totalInstances, lines: result.lines.length }]] as const) {
            response.write(`${JSON.stringify({ type: 'progress', stage, step, current, total: 3, instances: 0, counts: extra })}\n`);
            await new Promise(resolve => setTimeout(resolve, Number(process.env.CK_FIXTURE_DELAY ?? 250)));
          }
          // Like the Worker, every scan gets its own id, so a rescan reads as a new scan ("Since your last scan").
          return response.end(`${JSON.stringify({ type: 'result', result: classifyScan({ ...result, scanId: randomUUID() }, settings, savedChoices(result)) })}\n`);
        }
        const job = () => ({ jobId: '00000000-0000-4000-8000-0000000000bb', done: true, assemblyName: result.assemblyName, documentName: result.documentName, revision: null, scannedAt: result.scannedAt,
          parts: result.lines.filter(wantsStep).map((line, index) => ({ lineKey: line.bomLineKey, name: line.name, qty: line.qty, disposition: line.disposition, partId: line.partId, configuration: line.configuration,
            sourceUrl: line.partStudioUrl, fileName: `part_${index}.step`, state: 'ready', error: null, units: 'mm', nameMatches: true, bytes: 400 })) });
        if (url.pathname === '/api/exports') return json(job());
        const file = url.pathname.match(/^\/api\/exports\/[\w-]+\/files\/(\d+)$/);
        if (file) { response.setHeader('content-type', 'application/step'); return response.end(mockStep(job().parts[Number(file[1])]?.name ?? 'part')); }
        if (/^\/api\/exports\/[\w-]+$/.test(url.pathname)) return json(job());
        return json({ error: 'Not in the fixture API' }, 404);
      });
    },
  };
}
