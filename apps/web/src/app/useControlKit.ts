import { useEffect, useRef, useState } from 'react';
import { applyClassificationChoice, applyMatchDecision, classificationIdentity, classifyScan, type BomLine, type ClassificationOverride, type ExportPart, type ScanResult, type UserSettings } from '@control-kit/shared';
/** Spreadsheet and ZIP builders load on first download, keeping them out of the initial bundle. */
const exporters = () => import('@control-kit/excel');

export type Session = { connected: boolean; setupPending?: boolean; user?: { id: string; name: string } };
export type ScanProgress = { stage: string; current: number; total: number; instances: number; retry?: string };
export type ExportState = { running: boolean; ready: number; failed: number; total: number; failures: { name: string; reason: string; url: string }[]; zipMade: boolean | null };
type ScanEvent =
  | { type: 'progress'; stage: string; current: number; total: number; instances: number }
  | { type: 'rate-limit'; retryInMs: number }
  | { type: 'result'; result: ScanResult }
  | { type: 'session-expired' }
  | { type: 'error'; message: string };

export const contextKeys = ['documentId', 'workspaceOrVersion', 'workspaceOrVersionId', 'elementId'] as const;
const workerUrl = import.meta.env.VITE_WORKER_URL ?? '';
const api = (path: string, init: RequestInit = {}) => fetch(`${workerUrl}${path}`, { credentials: 'include', ...init });
const postJson = (path: string, body: unknown) => api(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const overridesOf = (result: ScanResult) => Object.fromEntries(result.lines.filter(line => line.manualClassification).map(line => [line.bomLineKey, line.manualClassification!]));
function saveFile(bytes: Uint8Array, filename: string, mime: string) {
  const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: mime }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

/** All of Control Kit's state and server calls; the views only read state and call these actions. */
export function useControlKit(context: URLSearchParams) {
  const [session, setSession] = useState<Session | null>(null);
  const [checkingSession, setCheckingSession] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<ScanResult | null>(null);
  const [progress, setProgress] = useState<ScanProgress | null>(null);
  const [settings, setSettings] = useState<UserSettings>({ teamNumber: null });
  const [savingSettings, setSavingSettings] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [bulk, setBulk] = useState<{ done: number; total: number } | null>(null);
  const [excel, setExcel] = useState<'idle' | 'working' | 'failed'>('idle');
  const [step, setStep] = useState<ExportState | null>(null);
  const abort = useRef<AbortController | null>(null);
  const scanGeneration = useRef(0);
  const sessionCheck = useRef(0);
  const query = new URLSearchParams(contextKeys.map(key => [key, context.get(key) ?? '']));
  const connectUrl = `${workerUrl}/oauth/start?${query}`;

  async function refreshSession() {
    const generation = ++sessionCheck.current;
    setCheckingSession(true);
    try {
      const response = await api('/api/session');
      const next = response.ok ? await response.json() as Session : { connected: false };
      if (generation !== sessionCheck.current) return;
      setSession(next);
      if (next.connected) setError('');
    } catch {
      if (generation !== sessionCheck.current) return;
      setError('Could not check the Onshape connection. Try again.');
      setSession({ connected: false });
    } finally { if (generation === sessionCheck.current) setCheckingSession(false); }
  }
  useEffect(() => { void refreshSession(); return () => abort.current?.abort(); }, []);
  useEffect(() => {
    if (!session?.connected) return;
    api('/api/settings').then(async response => { if (!response.ok) throw Error(); return await response.json() as UserSettings; })
      .then(setSettings).catch(() => setError('Could not load team settings.'));
  }, [session?.connected]);

  async function scan() {
    if (abort.current) return;
    scanGeneration.current++;
    const controller = new AbortController();
    abort.current = controller;
    setError(''); setExcel('idle'); setStep(null);
    setProgress({ stage: 'Starting scan…', current: 0, total: 3, instances: 0 });
    try {
      const response = await api(`/api/scan?${query}`, { signal: controller.signal });
      if (response.status === 401) { setSession({ connected: false }); throw new Error('Your Onshape connection expired. Reconnect and scan again.'); }
      if (!response.ok || !response.body) throw new Error('The scan could not start. Try again.');
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffered = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffered += decoder.decode(value, { stream: true });
        const lines = buffered.split('\n'); buffered = lines.pop() ?? '';
        for (const line of lines) {
          if (!line) continue;
          const event = JSON.parse(line) as ScanEvent;
          if (event.type === 'progress') setProgress({ ...event });
          if (event.type === 'rate-limit') setProgress(previous => previous && { ...previous, retry: `Onshape is rate-limiting; retrying in ${Math.ceil(event.retryInMs / 1000)}s` });
          if (event.type === 'result') setResult(event.result);
          if (event.type === 'session-expired') { setSession({ connected: false }); throw new Error('Your Onshape connection expired. Reconnect and scan again.'); }
          if (event.type === 'error') throw new Error(event.message);
        }
      }
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'The scan failed. Try again.');
    } finally { abort.current = null; setProgress(null); }
  }
  const cancelScan = () => abort.current?.abort();

  /** Confirm or reject a possible vendor match; the line updates at once and rolls back if saving fails. */
  async function decide(line: BomLine, decision: 'confirmed' | 'rejected') {
    if (!result || !line.vendor || pending) return;
    setPending(line.bomLineKey);
    const generation = scanGeneration.current;
    const before = result;
    const decided = applyMatchDecision(result, line.bomLineKey, decision);
    setResult(classifyScan(decided, settings, overridesOf(decided)));
    try {
      const response = await postJson('/api/matches/decision', { documentId: result.documentId, lineKey: line.bomLineKey, decision, vendorId: line.vendor.vendorId, normalizedSku: line.vendor.normalizedSku });
      if (!response.ok) throw new Error();
    } catch {
      if (scanGeneration.current === generation) setResult(before);
      setError('Could not save the match choice. Try again.');
    } finally { setPending(null); }
  }

  /** Applies one choice at once and saves it; on failure the line returns to its previous choice. */
  async function saveChoice(line: BomLine, choice: ClassificationOverride | null) {
    if (!result) return false;
    const scanId = result.scanId;
    const generation = scanGeneration.current;
    const identity = classificationIdentity(line);
    const previous = line.manualClassification ?? null;
    setResult(current => current && applyClassificationChoice(current, identity, choice, settings));
    try {
      const response = await postJson('/api/classification/override', { documentId: result.documentId, scanId, identity, classification: choice });
      if (!response.ok) throw Error();
      return true;
    } catch {
      if (scanGeneration.current === generation) setResult(current => {
        if (!current || current.scanId !== scanId) return current;
        const active = current.lines.find(item => item.bomLineKey === line.bomLineKey);
        return active && active.manualClassification === choice ? applyClassificationChoice(current, identity, previous, settings) : current;
      });
      return false;
    }
  }

  /** Set how a part is obtained (or `null` for automatic). Shared with everyone who scans the document. */
  async function setDisposition(line: BomLine, choice: ClassificationOverride | null) {
    if (!result || pending) return;
    setPending(line.bomLineKey);
    try { if (!await saveChoice(line, choice)) setError('Could not save that choice. Try again.'); }
    finally { setPending(null); }
  }

  /** Accepts the suggestion on each line, one save at a time so progress shows and a failure affects only its part. */
  async function acceptSuggestions(lines: BomLine[]) {
    if (!result || pending) return;
    const todo = lines.filter(line => line.suggestedDisposition);
    setPending('bulk');
    let failed = 0;
    try {
      for (const [index, line] of todo.entries()) {
        setBulk({ done: index, total: todo.length });
        if (!await saveChoice(line, line.suggestedDisposition)) failed++;
      }
      if (failed) setError(`${failed} of ${todo.length} choices could not be saved. Try those parts again.`);
    } finally { setBulk(null); setPending(null); }
  }

  async function saveSettings(teamNumber: string) {
    if (savingSettings) return false;
    if (teamNumber && !/^\d{1,6}$/.test(teamNumber)) { setError('Team number must be 1 to 6 digits.'); return false; }
    setSavingSettings(true);
    try {
      const value = { teamNumber: teamNumber || null };
      const response = await postJson('/api/settings', value);
      if (!response.ok) throw Error();
      setSettings(value);
      setResult(current => current && classifyScan({ ...current, lines: current.lines.map(line => ({ ...line })), stats: { ...current.stats } }, value, overridesOf(current)));
      return true;
    } catch { setError('Could not save team settings. Try again.'); return false; }
    finally { setSavingSettings(false); }
  }

  async function signOut() {
    await api('/api/logout', { method: 'POST' }).catch(() => undefined);
    setResult(null);
    setSession({ connected: false });
  }

  async function downloadExcel() {
    if (!result || excel === 'working') return;
    setExcel('working');
    try {
      const logo = await fetch('/control-kit-logo.png', { signal: AbortSignal.timeout(3000) })
        .then(async response => response.ok ? new Uint8Array(await response.arrayBuffer()) : undefined).catch(() => undefined);
      const { buildExcelWorkbook } = await exporters();
      const workbook = buildExcelWorkbook(result, new Date(), logo);
      saveFile(workbook.bytes, workbook.filename, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      setExcel('idle');
    } catch { setExcel('failed'); }
  }
  async function downloadCsv() {
    if (!result) return;
    try { const { buildBomCsv } = await exporters(); const csv = buildBomCsv(result); saveFile(csv.bytes, csv.filename, 'text/csv;charset=utf-8'); }
    catch { setError('CSV export failed. Try again.'); }
  }

  /**
   * STEP export runs as a job in the Worker: start it, poll until every part is ready or failed, then fetch each
   * finished file and build the ZIP here, so no single request outlives Worker limits.
   */
  async function downloadStep() {
    if (!result?.scanId || step?.running) return;
    setStep({ running: true, ready: 0, failed: 0, total: 0, failures: [], zipMade: null });
    try {
      type Job = { jobId: string; done: boolean; rateLimited?: boolean; error?: string; assemblyName: string; documentName?: string; revision?: { type: string; id: string } | null; scannedAt: string; parts: ExportPart[] };
      const read = async (response: Response) => { const body = await response.json() as Job; if (!response.ok) throw Error(body.error ?? 'STEP export failed. Try again.'); return body; };
      let job = await read(await postJson('/api/exports', { documentId: result.documentId, scanId: result.scanId }));
      // The Worker fails each translation after 5 minutes, so a large export always ends. The app only gives up
      // when nothing has changed for 3 minutes, or after 30 minutes overall.
      const started = Date.now();
      let lastChange = Date.now();
      let previous = '';
      let stalled = false;
      while (!job.done) {
        const signature = job.parts.map(part => part.state).join();
        // Waiting out an Onshape rate limit is progress, not a stuck job.
        if (signature !== previous || job.rateLimited) { previous = signature; lastChange = Date.now(); }
        setStep(current => current && { ...current, ready: job.parts.filter(part => part.state === 'ready').length, failed: job.parts.filter(part => part.state === 'failed').length, total: job.parts.length });
        if (Date.now() - lastChange > 3 * 60000 || Date.now() - started > 30 * 60000) { stalled = true; break; }
        await new Promise(resolve => setTimeout(resolve, 2000));
        job = await read(await api(`/api/exports/${job.jobId}`));
      }
      // A stalled export still delivers the files that finished; the rest are reported as unfinished.
      if (stalled) job = { ...job, parts: job.parts.map(part => part.state === 'ready' || part.state === 'failed' ? part : { ...part, state: 'failed', error: 'Export stopped before this part finished. Export again to retry it.' }) };
      // One failed download fails only that part; the others are still zipped.
      const files: Record<number, string> = {};
      for (const [index, part] of job.parts.entries()) {
        if (part.state !== 'ready') continue;
        try { const response = await api(`/api/exports/${job.jobId}/files/${index}`); if (response.ok) files[index] = await response.text(); }
        catch { /* Reported below as "File was not downloaded". */ }
      }
      const failures = job.parts.filter((part, index) => part.state === 'failed' || (part.state === 'ready' && files[index] === undefined))
        .map(part => ({ name: part.name, reason: part.error ?? 'File was not downloaded', url: part.sourceUrl }));
      const ready = job.parts.length - failures.length;
      // Failures are recorded before the ZIP is built, so an export where every part failed still lists each one.
      setStep({ running: false, ready, failed: failures.length, total: job.parts.length, failures, zipMade: ready > 0 });
      const { buildStepZip } = await exporters();
      const zip = buildStepZip({ ...job, files });
      saveFile(zip.bytes, zip.filename, 'application/zip');
    } catch (cause) {
      setStep(current => current && { ...current, running: false, zipMade: current.zipMade ?? false });
      setError(cause instanceof Error ? cause.message : 'STEP export failed. Try again.');
    }
  }

  return { session, checkingSession, refreshSession, connectUrl, error, clearError: () => setError(''), result, progress, scan, cancelScan, decide, setDisposition,
    acceptSuggestions, bulk, pending, settings, savingSettings, saveSettings, signOut, excel, downloadExcel, downloadCsv, step, downloadStep };
}
export type ControlKit = ReturnType<typeof useControlKit>;
