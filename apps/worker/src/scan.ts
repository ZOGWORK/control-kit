import { aggregateAssembly, type AssemblyContext, type AssemblyDefinition, type BomLine, type MatchDecision, type ScanResult } from '@control-kit/shared';
import { enrichScan } from './catalog';
import type { Kv } from './index';

export type ScanEvent =
  | { type: 'progress'; stage: string; current: number; total: number; instances: number }
  | { type: 'rate-limit'; retryInMs: number }
  | { type: 'result'; result: ScanResult }
  | { type: 'session-expired' }
  | { type: 'error'; message: string };

export class SessionExpiredError extends Error { constructor() { super('Onshape session expired'); } }

type FetchOnshape = (path: string, signal: AbortSignal) => Promise<Response>;
const pause = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  const timer = setTimeout(resolve, ms);
  signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
});

/** Onshape Assembly/getAssemblyDefinition, documented at https://onshape-public.github.io/docs/api-adv/assemblies/ */
export function assemblyPath(context: AssemblyContext, version: string) {
  const { documentId, workspaceOrVersion, workspaceOrVersionId, elementId } = context;
  const path = [documentId, workspaceOrVersion, workspaceOrVersionId, elementId].map(encodeURIComponent);
  return `/api/${version}/assemblies/d/${path[0]}/${path[1]}/${path[2]}/e/${path[3]}?includeMateFeatures=false&includeMateConnectors=false&includeNonSolids=false&excludeSuppressed=false`;
}

/** Onshape PartStudio/getPartStudioMassProperties, documented at https://onshape-public.github.io/docs/api-adv/partstudios/ */
export function massPath(line: BomLine, version: string) {
  if (!line.sourceType || !line.sourceId) return null;
  const source = `${line.sourceType}/${encodeURIComponent(line.sourceId)}`;
  const query = line.configuration ? `?configuration=${encodeURIComponent(line.configuration)}` : '';
  return `/api/${version}/partstudios/d/${encodeURIComponent(line.documentId)}/${source}/e/${encodeURIComponent(line.elementId)}/massproperties${query}`;
}

export function scanAssembly(request: Request, context: AssemblyContext, version: string, fetchOnshape: FetchOnshape, catalog: Kv, getDecision: (key: string, signal?: AbortSignal) => Promise<MatchDecision | null>, staleHours = 24): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (event: ScanEvent) => { if (!request.signal.aborted) controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`)); };
      const get = async (path: string) => {
        for (let attempt = 0; attempt <= 4; attempt++) {
          if (request.signal.aborted) throw request.signal.reason;
          const response = await fetchOnshape(path, request.signal);
          if (response.status !== 429 || attempt === 4) return response;
          const retryAfter = Number(response.headers.get('retry-after'));
          const delay = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 8000) : Math.round((2 ** attempt) * 1000 * (0.8 + Math.random() * 0.4));
          emit({ type: 'rate-limit', retryInMs: delay });
          await pause(delay, request.signal);
        }
        throw new Error('Rate limit exhausted');
      };
      try {
        emit({ type: 'progress', stage: 'Fetching assembly…', current: 0, total: 1, instances: 0 });
        const response = await get(assemblyPath(context, version));
        if (!response.ok) {
          const message = response.status === 403 || response.status === 404
            ? "This document couldn't be read by the API. On a free plan it may need to be public, or you may not have access."
            : response.status === 429 ? 'Onshape is rate-limiting this scan. Try again in a moment.' : 'Could not read this assembly. Check access and retry.';
          emit({ type: 'error', message }); return;
        }
        const definition = await response.json() as AssemblyDefinition;
        if (!definition.rootAssembly || !Array.isArray(definition.rootAssembly.instances)) { emit({ type: 'error', message: 'Onshape returned an incomplete assembly. Try again.' }); return; }
        const result = aggregateAssembly(definition, context, definition.rootAssembly.name ?? 'Assembly');
        const unique = new Map<string, BomLine[]>();
        for (const line of [...result.lines, ...result.suppressed]) {
          if (line.unresolvedSubassembly) { line.missingMetadataReason = 'Subassembly has no resolvable children'; continue; }
          const key = `${line.documentId}:${line.elementId}:${line.sourceType}:${line.sourceId}:${line.configuration ?? ''}`;
          unique.set(key, [...(unique.get(key) ?? []), line]);
        }
        const entries = [...unique.values()];
        let completed = 0;
        const count = result.stats.totalInstances;
        emit({ type: 'progress', stage: 'Resolving parts…', current: 0, total: entries.length, instances: count });
        for (let offset = 0; offset < entries.length; offset += 6) {
          await Promise.all(entries.slice(offset, offset + 6).map(async lines => {
            try {
              const path = massPath(lines[0], version);
              if (!path) { for (const line of lines) line.missingMetadataReason = 'Source revision unavailable for linked document'; return; }
              const response = await get(path);
              if (!response.ok) throw new Error(`metadata HTTP ${response.status}`);
              const value = await response.json() as { bodies?: Record<string, { mass?: number[]; material?: string }> };
              for (const line of lines) {
                const body = line.partId ? value.bodies?.[line.partId] : undefined;
                line.massKg = typeof body?.mass?.[0] === 'number' ? body.mass[0] : null;
                line.material = body?.material ?? null;
                if (!body) line.missingMetadataReason = 'Mass properties unavailable for this part';
              }
            } catch (error) {
              if (error instanceof SessionExpiredError) throw error;
              if (request.signal.aborted) throw error;
              for (const line of lines) line.missingMetadataReason = 'Part metadata could not be read';
            } finally {
              completed++;
              emit({ type: 'progress', stage: 'Resolving parts…', current: completed, total: entries.length, instances: count });
            }
          }));
        }
        result.missingMetadata = [...result.lines, ...result.suppressed].filter(line => line.missingMetadataReason !== null);
        emit({ type: 'progress', stage: 'Matching vendors…', current: 0, total: result.lines.length, instances: count });
        await enrichScan(result, catalog, getDecision, request.signal, staleHours);
        emit({ type: 'progress', stage: 'Matching vendors…', current: result.lines.length, total: result.lines.length, instances: count });
        emit({ type: 'result', result });
      } catch (error) {
        if (!request.signal.aborted) {
          if (error instanceof SessionExpiredError) emit({ type: 'session-expired' });
          else { console.error('Scan failed', error); emit({ type: 'error', message: 'The scan stopped unexpectedly. Try again.' }); }
        }
      } finally { controller.close(); }
    },
  });
  return new Response(stream, { headers: { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' } });
}
