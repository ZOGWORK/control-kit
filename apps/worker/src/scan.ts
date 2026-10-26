import { aggregateAssembly, classifyScan, flagMissingSources, mergeBom, metadataIssueText, summarizeMetadataIssues, type AssemblyContext, type AssemblyDefinition, type BillOfMaterials, type BomLine, type BomReconciliation, type ClassificationOverride, type ClassificationOverrides, type MatchDecision, type OnshapeRequestSummary, type ScanResult, type UserSettings } from '@control-kit/shared';
import { catalogHealth } from './catalog';
import type { Kv } from './index';

export type ScanEvent =
  | { type: 'progress'; stage: string; current: number; total: number; instances: number }
  | { type: 'rate-limit'; retryInMs: number }
  | { type: 'result'; result: ScanResult }
  | { type: 'session-expired' }
  | { type: 'error'; message: string };

export class SessionExpiredError extends Error { constructor() { super('Onshape session expired'); } }

/** `retry` is true for repeat attempts after a 429 so the request ledger can count them separately. */
type FetchOnshape = (path: string, signal: AbortSignal, retry?: boolean) => Promise<Response>;
/** A per-user cache of the definition and BOM read at one immutable revision. */
export type SourceCache = { get(key: string): Promise<string | null>; put(key: string, value: string): Promise<void> };
type Revision = { type: 'v' | 'm'; id: string };
type Source = { definition: AssemblyDefinition; bom: BillOfMaterials | null; bomStatus: number | null };
const pause = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  const timer = setTimeout(resolve, ms);
  signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
});
const segments = (...values: string[]) => values.map(encodeURIComponent);
/** KV values are limited to 25 MiB; a source larger than this is simply not cached. */
const maxCachedBytes = 20 * 1024 * 1024;

/** Onshape Document/getCurrentMicroversion: pins a workspace scan to one immutable revision. */
export const microversionPath = (context: AssemblyContext, version: string) => {
  const [did, wid] = segments(context.documentId, context.workspaceOrVersionId);
  return `/api/${version}/documents/d/${did}/w/${wid}/currentmicroversion`;
};
/** Onshape Assembly/getAssemblyDefinition, read at a version or microversion: https://onshape-public.github.io/docs/api-adv/assemblies/ */
export function assemblyPath(context: AssemblyContext, revision: Revision, version: string) {
  const [did, id, eid] = segments(context.documentId, revision.id, context.elementId);
  return `/api/${version}/assemblies/d/${did}/${revision.type}/${id}/e/${eid}?includeMateFeatures=false&includeMateConnectors=false&includeNonSolids=false&excludeSuppressed=false`;
}
/** Onshape Assembly/getBillOfMaterials, flattened with every column, at the same revision as the definition. */
export function bomPath(context: AssemblyContext, revision: Revision, version: string) {
  const [did, id, eid] = segments(context.documentId, revision.id, context.elementId);
  return `/api/${version}/assemblies/d/${did}/${revision.type}/${id}/e/${eid}/bom?indented=false&generateIfAbsent=true&onlyVisibleColumns=false&includeItemMicroversions=true`;
}

export async function loadClassificationOverrides(lines: BomLine[], getOverride: (line: BomLine, signal?: AbortSignal) => Promise<ClassificationOverride | null>, signal?: AbortSignal): Promise<ClassificationOverrides> {
  const overrides: ClassificationOverrides = {};
  for (let offset = 0; offset < lines.length; offset += 20) {
    const choices = await Promise.all(lines.slice(offset, offset + 20).map(line => getOverride(line, signal)));
    choices.forEach((choice, index) => { if (choice) overrides[lines[offset + index].bomLineKey] = choice; });
  }
  return overrides;
}

const accessMessage = (status: number) => status === 402 ? "This Onshape account has used its annual API allowance, so Control Kit can't read the assembly until Onshape resets or raises it."
  : status === 403 || status === 404 ? "This document couldn't be read by the API. On a free plan it may need to be public, or you may not have access."
  : status === 429 ? 'Onshape is rate-limiting this scan. Try again in a moment.' : 'Could not read this assembly. Check access and retry.';
class ScanStop extends Error {}

/**
 * Scans an assembly in at most three Onshape requests: the workspace's current microversion, then the assembly
 * definition and the flattened BOM at that immutable revision. A rescan of an unchanged revision reads both from
 * the per-user source cache, so it costs only the microversion request (none for a version).
 */
export function scanAssembly(request: Request, context: AssemblyContext, version: string, fetchOnshape: FetchOnshape, catalog: Kv, getDecision: (key: string, signal?: AbortSignal) => Promise<MatchDecision | null>, staleHours = 336, settings: UserSettings = { teamNumber: null }, getOverride: (line: BomLine, signal?: AbortSignal) => Promise<ClassificationOverride | null> = async () => null, onResult?: (result: ScanResult) => Promise<void>,
  requests?: { summary(): OnshapeRequestSummary; finish(): Promise<unknown> }, sourceCache?: SourceCache): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (event: ScanEvent) => { if (!request.signal.aborted) controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`)); };
      const get = async (path: string) => {
        for (let attempt = 0; attempt <= 4; attempt++) {
          if (request.signal.aborted) throw request.signal.reason;
          const response = await fetchOnshape(path, request.signal, attempt > 0);
          if (response.status !== 429 || attempt === 4) return response;
          const retryAfter = Number(response.headers.get('retry-after'));
          const delay = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 8000) : Math.round((2 ** attempt) * 1000 * (0.8 + Math.random() * 0.4));
          emit({ type: 'rate-limit', retryInMs: delay });
          await pause(delay, request.signal);
        }
        throw new Error('Rate limit exhausted');
      };
      const required = async <T>(path: string): Promise<T> => {
        const response = await get(path);
        if (!response.ok) { emit({ type: 'error', message: accessMessage(response.status) }); throw new ScanStop(); }
        return await response.json() as T;
      };
      try {
        emit({ type: 'progress', stage: 'Checking assembly revision…', current: 0, total: 3, instances: 0 });
        let revision: Revision;
        if (context.workspaceOrVersion === 'w') {
          const { microversion } = await required<{ microversion?: string }>(microversionPath(context, version));
          if (!microversion) { emit({ type: 'error', message: 'Onshape returned no revision for this workspace. Try again.' }); return; }
          revision = { type: 'm', id: microversion };
        } else revision = { type: context.workspaceOrVersion, id: context.workspaceOrVersionId };
        const cacheKey = `onshape-source:${context.documentId}:${context.elementId}:${revision.type}:${revision.id}`;
        let source: Source | null = null;
        let cache: 'hit' | 'miss' | 'off' = sourceCache ? 'miss' : 'off';
        if (sourceCache) {
          try { const raw = await sourceCache.get(cacheKey); if (raw) { source = JSON.parse(raw) as Source; cache = 'hit'; } }
          catch { source = null; /* A failed or malformed cache read costs one fresh read, not the scan. */ }
        }
        if (!source) {
          emit({ type: 'progress', stage: 'Reading assembly…', current: 1, total: 3, instances: 0 });
          const definition = await required<AssemblyDefinition>(assemblyPath(context, revision, version));
          emit({ type: 'progress', stage: "Reading Onshape's bill of materials…", current: 2, total: 3, instances: 0 });
          // The definition alone is a usable inventory, so an ordinary BOM failure degrades the scan instead of ending it.
          // Session expiry, cancellation, and an exhausted allowance still stop it: retrying cannot help with those.
          let bom: BillOfMaterials | null = null;
          let bomStatus: number | null = null;
          try {
            const response = await get(bomPath(context, revision, version));
            if (response.status === 402) { emit({ type: 'error', message: accessMessage(402) }); throw new ScanStop(); }
            if (response.ok) bom = await response.json() as BillOfMaterials; else bomStatus = response.status;
          } catch (error) {
            if (error instanceof ScanStop || error instanceof SessionExpiredError || request.signal.aborted) throw error;
            console.error('BOM read failed', error instanceof Error ? error.name : 'unknown');
          }
          source = { definition, bom, bomStatus };
          // Only a complete read is cached: a missing BOM must be retried on the next scan.
          if (sourceCache && source.bom) {
            const value = JSON.stringify(source);
            if (value.length < maxCachedBytes) await sourceCache.put(cacheKey, value).catch(() => undefined);
          }
        }
        const { definition, bom } = source;
        if (!definition.rootAssembly || !Array.isArray(definition.rootAssembly.instances)) { emit({ type: 'error', message: 'Onshape returned an incomplete assembly. Try again.' }); return; }
        const name = bom?.bomSource?.element?.name ?? definition.rootAssembly.name ?? 'Assembly';
        const result = aggregateAssembly(definition, context, name);
        if (bom?.bomSource?.document?.name) result.documentName = bom.bomSource.document.name;
        let reconciliation: BomReconciliation;
        if (bom) reconciliation = mergeBom(result, bom);
        else {
          for (const line of result.lines) if (!line.metadataIssue) line.metadataIssue = { code: 'bom-unavailable', httpStatus: source.bomStatus };
          reconciliation = { status: 'unavailable', httpStatus: source.bomStatus, rows: 0, matchedLines: 0, linesWithoutRow: 0, rowsWithoutLine: 0, quantityMismatches: 0, columns: [] };
        }
        const all = [...result.lines, ...result.suppressed];
        flagMissingSources(all);
        for (const line of all) line.missingMetadataReason = line.metadataIssue ? metadataIssueText[line.metadataIssue.code] : null;
        result.missingMetadata = all.filter(line => line.metadataIssue);
        const count = result.stats.totalInstances;
        emit({ type: 'progress', stage: 'Reading saved choices…', current: 3, total: 3, instances: count });
        // Vendor matching runs in the browser (`matchCatalog`): against every catalog it costs far more CPU than a Worker
        // request may use. The scan supplies what the browser needs: catalog health and the person's saved match decisions.
        try { result.catalogHealth = await catalogHealth(catalog, staleHours, request.signal); }
        catch (error) { if (request.signal.aborted) throw error; console.error('Catalog health read failed', error instanceof Error ? error.name : 'unknown'); }
        // Saved decisions are read twenty at a time, so the stage waits for a few KV round trips, not one per line.
        for (let start = 0; start < result.lines.length; start += 20) {
          await Promise.all(result.lines.slice(start, start + 20).map(async line => { line.matchDecision = await getDecision(line.bomLineKey, request.signal); }));
        }
        result.vendorMatching = 'pending';
        classifyScan(result, settings, await loadClassificationOverrides(result.lines, getOverride, request.signal));
        result.diagnostics = { onshapeRequests: requests?.summary() ?? null, metadataIssues: summarizeMetadataIssues(all), bom: reconciliation, revision, cache };
        if (onResult) await onResult(result);
        emit({ type: 'result', result });
      } catch (error) {
        if (!request.signal.aborted && !(error instanceof ScanStop)) {
          if (error instanceof SessionExpiredError) emit({ type: 'session-expired' });
          else {
            // The stack's first frames are code locations only (no part data), so a failure can be traced from the log.
            console.error('Scan failed', error instanceof Error ? `${error.name}: ${error.message}\n${error.stack?.split('\n').slice(1, 4).join('\n') ?? ''}` : 'unknown');
            // Only a request to Onshape that failed is "could not reach Onshape"; anything else is Control Kit's own error.
            const unreachable = error instanceof TypeError && Object.keys(requests?.summary().errors ?? {}).length > 0;
            emit({ type: 'error', message: unreachable
              ? 'Could not reach Onshape. Check your connection and retry.'
              : 'Control Kit hit an error reading this assembly. Try again; if it happens again, tell us which assembly.' });
          }
        }
      } finally {
        // Persist the ledger on every outcome: failed and cancelled scans still spent requests.
        await requests?.finish().catch(error => console.error('Request ledger write failed', error instanceof Error ? error.name : 'unknown'));
        controller.close();
      }
    },
  });
  return new Response(stream, { headers: { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' } });
}
