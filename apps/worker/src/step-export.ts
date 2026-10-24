import { checkStep, stepFileName, wantsStep, type ExportPart, type ScanResult } from '@control-kit/shared';
import type { Kv } from './index';
import { SessionExpiredError } from './scan';

/**
 * STEP export as a job. Onshape translates asynchronously, and one Worker request may make only a bounded number of
 * outbound calls, so each call to `advanceExport` does a slice of the work: start pending translations, poll running
 * ones, and download and check finished files. The browser polls until every part is ready or failed.
 * Per part: 1 translation start + its status polls + 1 download, all counted in the request ledger.
 */
export type JobPart = ExportPart & { documentId: string; elementId: string; exportSource: { type: 'w' | 'v'; id: string } | null; translationId: string | null; resultDocumentId: string | null; startedAt: number | null };
export type ExportJob = { jobId: string; documentId: string; scanId: string; assemblyName: string; documentName?: string; revision: { type: 'v' | 'm'; id: string } | null; scannedAt: string; createdAt: string; parts: JobPart[];
  /** Where the next poll resumes among running translations. */
  cursor?: number };
type FetchOnshape = (path: string, init?: RequestInit) => Promise<Response>;
/** Public view of a job: no Onshape IDs beyond what the user's own scan already showed. */
export const jobSummary = (job: ExportJob) => ({ jobId: job.jobId, assemblyName: job.assemblyName, documentName: job.documentName, revision: job.revision, scannedAt: job.scannedAt, createdAt: job.createdAt,
  done: job.parts.every(part => part.state === 'ready' || part.state === 'failed'),
  parts: job.parts.map(({ lineKey, name, qty, disposition, partId, configuration, sourceUrl, fileName, state, error, units, nameMatches, bytes }) => ({ lineKey, name, qty, disposition, partId, configuration, sourceUrl, fileName, state, error, units, nameMatches, bytes })) });

export const jobKey = (userId: string, jobId: string) => `export:${userId}:${jobId}`;
export const fileKey = (userId: string, jobId: string, index: number) => `export-file:${userId}:${jobId}:${index}`;
/** A translation that has not finished after this long is reported as failed instead of polled forever. */
const translationTimeoutMs = 5 * 60000;
const maxFileBytes = 20 * 1024 * 1024;

export function createExportJob(result: ScanResult, jobId: string, now = new Date()): ExportJob {
  const used = new Set<string>();
  const parts: JobPart[] = result.lines.filter(wantsStep).map(line => {
    const missing = !line.partId ? 'Part ID unavailable' : !line.exportSource ? 'No workspace or version to export from (linked part without a version)' : null;
    return { lineKey: line.bomLineKey, name: line.name, qty: line.qty, disposition: line.disposition, partId: line.partId, configuration: line.configuration, sourceUrl: line.partStudioUrl, fileName: stepFileName(line, used),
      state: missing ? 'failed' : 'pending', error: missing, units: null, nameMatches: null, bytes: null,
      documentId: line.documentId, elementId: line.elementId, exportSource: line.exportSource ?? null, translationId: null, resultDocumentId: null, startedAt: null };
  });
  return { jobId, documentId: result.documentId, scanId: result.scanId!, assemblyName: result.assemblyName, documentName: result.documentName, revision: result.diagnostics?.revision ?? null,
    scannedAt: result.scannedAt, createdAt: now.toISOString(), parts };
}

const failure = (status: number) => status === 402 ? "Onshape's annual API allowance is used up" : status === 403 || status === 404 ? 'No access to this part in Onshape' : `Onshape returned HTTP ${status}`;

/** Thrown by a budgeted fetcher once the request budget is spent; the work it would have done waits for the next poll. */
export class BudgetExhaustedError extends Error {}
/** Outbound Onshape requests one poll may still send. Shared with the fetcher, so its 429 retries count too. */
export type RequestBudget = { remaining: number };
/** Wraps a fetcher so every request it sends, including retries made through it, spends the shared budget. */
export const budgeted = (fetchOnshape: FetchOnshape, budget: RequestBudget): FetchOnshape => async (path, init) => {
  if (budget.remaining <= 0) throw new BudgetExhaustedError();
  budget.remaining--;
  return fetchOnshape(path, init);
};

/**
 * Advances a job until the request budget is spent. `fetchOnshape` must spend `budget` for every request it sends
 * (see `budgeted`, or the Worker's `onshapeFetcher`). Pending parts start first, since Onshape translates them in
 * parallel; running parts are then polled from a cursor that rotates between calls, so no part waits behind the
 * same thirty every time. Returns the job, mutated in place; the caller persists it.
 */
export async function advanceExport(job: ExportJob, userId: string, kv: Kv, fetchOnshape: FetchOnshape, apiVersion: string, budget: RequestBudget = { remaining: 30 }, now = () => Date.now()) {
  const encode = encodeURIComponent;
  const pending = job.parts.flatMap((part, index) => part.state === 'pending' ? [index] : []);
  const running = job.parts.flatMap((part, index) => part.state === 'translating' ? [index] : []);
  const start = running.length ? (job.cursor ?? 0) % running.length : 0;
  let polled = 0;
  for (const index of [...pending, ...running.slice(start), ...running.slice(0, start)]) {
    if (budget.remaining <= 0) break;
    const part = job.parts[index];
    try {
      if (part.state === 'pending') {
        const { type, id } = part.exportSource!;
        // Onshape PartStudio/createPartStudioTranslation (OAuth2Read): STEP, one part, its configuration, not stored in the document.
        const response = await fetchOnshape(`/api/${apiVersion}/partstudios/d/${encode(part.documentId)}/${type}/${encode(id)}/e/${encode(part.elementId)}/translations`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ formatName: 'STEP', partIds: part.partId, ...(part.configuration && part.configuration !== 'default' ? { configuration: part.configuration } : {}), storeInDocument: false, notifyUser: false, flattenAssemblies: false }) });
        if (!response.ok) { Object.assign(part, { state: 'failed', error: failure(response.status) }); continue; }
        const started = await response.json() as { id?: string; requestState?: string; failureReason?: string };
        if (!started.id || started.requestState === 'FAILED') { Object.assign(part, { state: 'failed', error: started.failureReason ?? 'Onshape did not start the STEP translation' }); continue; }
        Object.assign(part, { state: 'translating', translationId: started.id, startedAt: now() });
        continue;
      }
      polled++;
      if (now() - (part.startedAt ?? 0) > translationTimeoutMs) { Object.assign(part, { state: 'failed', error: 'STEP translation did not finish within 5 minutes' }); continue; }
      const status = await fetchOnshape(`/api/${apiVersion}/translations/${encode(part.translationId!)}`);
      if (!status.ok) { Object.assign(part, { state: 'failed', error: failure(status.status) }); continue; }
      const value = await status.json() as { requestState?: string; failureReason?: string; resultExternalDataIds?: string[]; resultDocumentId?: string; documentId?: string };
      if (value.requestState === 'FAILED') { Object.assign(part, { state: 'failed', error: value.failureReason?.slice(0, 200) ?? 'Onshape could not translate this part' }); continue; }
      if (value.requestState !== 'DONE') continue;
      const externalId = value.resultExternalDataIds?.[0];
      if (!externalId) { Object.assign(part, { state: 'failed', error: 'Onshape finished without a STEP file' }); continue; }
      const file = await fetchOnshape(`/api/${apiVersion}/documents/d/${encode(value.resultDocumentId ?? value.documentId ?? part.documentId)}/externaldata/${encode(externalId)}`);
      if (!file.ok) { Object.assign(part, { state: 'failed', error: `STEP download failed: ${failure(file.status)}` }); continue; }
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (bytes.byteLength > maxFileBytes) { Object.assign(part, { state: 'failed', error: 'STEP file is larger than 20 MB; export it from Onshape directly' }); continue; }
      const check = checkStep(new TextDecoder().decode(bytes), part.name);
      if (!check.ok) { Object.assign(part, { state: 'failed', error: check.error }); continue; }
      await kv.put(fileKey(userId, job.jobId, index), new TextDecoder().decode(bytes), { expirationTtl: 3600 });
      Object.assign(part, { state: 'ready', error: null, units: check.units, nameMatches: check.nameMatches, bytes: bytes.byteLength });
    } catch (error) {
      // An exhausted budget leaves this part as it was for the next poll.
      if (error instanceof BudgetExhaustedError) break;
      // Session expiry and cancellation belong to the whole request; anything else fails only this part.
      if (error instanceof SessionExpiredError || (error instanceof Error && error.name === 'AbortError')) throw error;
      Object.assign(part, { state: 'failed', error: 'Could not reach Onshape for this part' });
    }
  }
  job.cursor = running.length ? (start + polled) % running.length : 0;
  return job;
}
