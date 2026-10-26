import { useEffect, useRef, useState } from 'react';
import { aiCandidateRecord, applyAiReview, applyClassificationChoice, applyMatchDecision, buildAiReviewRequest, classificationIdentity, classifyScan, decisionRecord, matchCatalog, type AiProvider, type AiReviewItem, type BomLine, type ClassificationOverride, type ExportPart, type MatchProgress, type ScanResult, type UserSettings, type VendorRecord } from '@control-kit/shared';
/** Spreadsheet and ZIP builders load on first download, keeping them out of the initial bundle. */
const exporters = () => import('@control-kit/excel');

export type Session = { connected: boolean; setupPending?: boolean; user?: { id: string; name: string } };
/** The scan's stages, in order; the progress screen shows each with its counts. */
export type ScanStep = 'revision' | 'assembly' | 'bom' | 'choices' | 'catalogs' | 'matching';
export type ScanCounts = { parts?: number; subassemblies?: number; bomRows?: number; cached?: boolean; lines?: number; catalogs?: number; catalogsTotal?: number; products?: number; matched?: number };
export type ScanProgress = { stage: string; current: number; total: number; instances: number; retry?: string; step?: ScanStep; counts?: ScanCounts };
export type ExportState = { running: boolean; ready: number; failed: number; total: number; failures: { name: string; reason: string; url: string }[]; zipMade: boolean | null };
type ScanEvent =
  | { type: 'progress'; stage: string; step?: ScanStep; current: number; total: number; instances: number; counts?: ScanCounts }
  | { type: 'rate-limit'; retryInMs: number }
  | { type: 'result'; result: ScanResult }
  | { type: 'session-expired' }
  | { type: 'error'; message: string };

export const contextKeys = ['documentId', 'workspaceOrVersion', 'workspaceOrVersionId', 'elementId'] as const;
export const workerUrl = import.meta.env.VITE_WORKER_URL ?? '';
export const api = (path: string, init: RequestInit = {}) => fetch(`${workerUrl}${path}`, { credentials: 'include', ...init });
export const postJson = (path: string, body: unknown) => api(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
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
  /** The scan this one replaced, for "since your last scan". Only kept for the same assembly, and only in memory. */
  const [previous, setPrevious] = useState<ScanResult | null>(null);
  const resultRef = useRef(result);
  resultRef.current = result;
  const [progress, setProgress] = useState<ScanProgress | null>(null);
  const [settings, setSettings] = useState<UserSettings>({ teamNumber: null });
  /** The latest settings, for updaters that run after a later render (a reopened scan's choices arriving late). */
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const [savingSettings, setSavingSettings] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  /** Lines whose choice is being saved. Saves run side by side, so deciding the next part never waits for the last one. */
  const [saving, setSaving] = useState<ReadonlySet<string>>(new Set());
  const markSaving = (key: string, on: boolean) => setSaving(current => { const next = new Set(current); if (on) next.add(key); else next.delete(key); return next; });
  const [bulk, setBulk] = useState<{ done: number; total: number } | null>(null);
  const [excel, setExcel] = useState<'idle' | 'working' | 'failed'>('idle');
  const [step, setStep] = useState<ExportState | null>(null);
  /** The optional AI review: whether the server has a key, a request in flight, and the last outcome to show. */
  const [ai, setAi] = useState<{ enabled: boolean; running: boolean; note: string }>({ enabled: false, running: false, note: '' });
  const abort = useRef<AbortController | null>(null);
  const scanGeneration = useRef(0);
  /** Changes only at sign-out, so replies that belong to the previous session can be told apart. */
  const sessionEpoch = useRef(0);
  /** The STEP export in progress, if any. Sign-out ends it; a rescan leaves it to finish for the scan it started from. */
  const stepRun = useRef<number | null>(null);
  const stepRuns = useRef(0);
  /** The last STEP ZIP this session built, so a Control Point send can attach it without exporting again. */
  const lastStepZip = useRef<{ scanId: string; name: string; bytes: Uint8Array } | null>(null);
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
  // Onshape accepts panel messages only after this handshake from inside its right panel.
  const inOnshape = window.parent !== window;
  const onshapeMessage = (messageName: string, extra: Record<string, string> = {}) => {
    if (!inOnshape || context.get('workspaceOrVersion') !== 'w') return false;
    window.parent.postMessage({ documentId: context.get('documentId'), workspaceId: context.get('workspaceOrVersionId'), elementId: context.get('elementId'), messageName, ...extra }, 'https://cad.onshape.com');
    return true;
  };
  useEffect(() => { onshapeMessage('applicationInit'); }, []);

  // The last scan of this assembly reopens with the panel, so leaving and coming back does not need a rescan. It is
  // kept per person and per assembly tab in this browser for a week, the same as the Worker's copy it relies on.
  const savedKey = `control-kit:scan:${contextKeys.map(key => context.get(key) ?? '').join(':')}`;
  const savedFor = session?.connected ? session.user?.id ?? null : null;
  // The Worker's copy of a scan expires a week after the scan, so a saved scan is reopened only within that week
  // (with an hour's margin), counted from the scan itself, however often it was saved since.
  const reopenable = (scanned: ScanResult) => Date.now() - Date.parse(scanned.scannedAt) < 7 * 86400000 - 3600000;
  useEffect(() => {
    if (!savedFor || result || abort.current) return;
    pruneSavedScans();
    type Saved = { userId: string; result: ScanResult };
    let saved: Saved | null;
    try { saved = JSON.parse(localStorage.getItem(savedKey) ?? 'null') as Saved | null; } catch { saved = null; }
    if (!saved || saved.userId !== savedFor || saved.result.vendorMatching === 'pending' || !reopenable(saved.result)) return;
    const reopened = saved.result;
    setResult(reopened);
    void refreshChoices(reopened);
  }, [savedFor]);
  /** Drops saved scans that can no longer reopen, so old assemblies do not fill the browser's storage. */
  function pruneSavedScans(keep?: string) {
    try {
      for (const key of Object.keys(localStorage).filter(item => item.startsWith('control-kit:scan:') && item !== keep)) {
        try { const saved = JSON.parse(localStorage.getItem(key) ?? 'null') as { result?: ScanResult } | null; if (!saved?.result || !reopenable(saved.result)) localStorage.removeItem(key); }
        catch { localStorage.removeItem(key); }
      }
    } catch { /* Storage unavailable. */ }
  }
  /** Applies the document's current shared choices and the person's match decisions to a reopened scan. */
  async function refreshChoices(reopened: ScanResult) {
    if (!reopened.scanId) return;
    // Choices wait for the refresh, so nothing saved meanwhile can be overwritten by the older answer.
    setPending('refresh');
    try {
      const response = await postJson('/api/choices', { documentId: reopened.documentId, scanId: reopened.scanId });
      if (!response.ok) throw Error();
      const { choices } = await response.json() as { choices: Record<string, { disposition: ClassificationOverride | null; decision: { status: 'confirmed' | 'rejected'; vendorId: string; normalizedSku: string } | null }> };
      setResult(current => {
        if (!current || current.scanId !== reopened.scanId) return current;
        const lines = current.lines.map(line => {
          const choice = choices[line.bomLineKey];
          if (!choice) return line;
          const next = { ...line, manualClassification: choice.disposition };
          const decision = choice.decision;
          const picked = decision && ['possible', 'confirmed', 'rejected'].includes(line.matchStatus) ? decisionRecord(line, decision as Parameters<typeof decisionRecord>[1]) : null;
          if (decision && picked) {
            next.vendor = picked;
            next.matchStatus = decision.status;
            if (decision.status === 'rejected') next.vendor = null;
          }
          return next;
        });
        const updated = { ...current, lines, stats: { ...current.stats } };
        return classifyScan(updated, settingsRef.current, overridesOf(updated));
      });
    } catch { setError('Could not load the latest shared choices for this scan. Rescan to be sure it is current.'); }
    finally { setPending(null); }
  }
  useEffect(() => {
    if (!savedFor || !result || result.vendorMatching === 'pending') return;
    const value = JSON.stringify({ userId: savedFor, result });
    try { localStorage.setItem(savedKey, value); }
    catch {
      // Storage full: other assemblies' saved scans make room for this one. Blocked storage: the scan just will not reopen.
      try { for (const key of Object.keys(localStorage).filter(item => item.startsWith('control-kit:scan:') && item !== savedKey)) localStorage.removeItem(key); localStorage.setItem(savedKey, value); }
      catch { /* The scan still works; it will not reopen. */ }
    }
  }, [result, savedFor]);
  // Team settings can arrive after a reopened scan; its suggestions (team number in names) follow them.
  useEffect(() => {
    setResult(current => current && current.vendorMatching !== 'pending' ? classifyScan({ ...current, lines: current.lines.map(line => ({ ...line })), stats: { ...current.stats } }, settings, overridesOf(current)) : current);
  }, [settings]);
  useEffect(() => {
    if (!session?.connected) return;
    // A reply that arrives after sign-out (or another sign-in) belongs to the old session and is dropped.
    const epoch = sessionEpoch.current;
    api('/api/settings').then(async response => { if (!response.ok) throw Error(); return await response.json() as UserSettings; })
      .then(value => { if (sessionEpoch.current === epoch) setSettings(value); })
      .catch(() => { if (sessionEpoch.current === epoch) setError('Could not load team settings.'); });
  }, [session?.connected]);

  async function scan() {
    if (abort.current) return;
    const generation = ++scanGeneration.current;
    const controller = new AbortController();
    abort.current = controller;
    setError(''); setExcel('idle');
    // A running STEP export keeps its own progress; only a finished one's results are cleared.
    setStep(current => current?.running ? current : null);
    setProgress({ stage: 'Starting scan…', current: 0, total: 3, instances: 0 });
    try {
      const response = await api(`/api/scan?${query}`, { signal: controller.signal });
      if (response.status === 401) { setSession({ connected: false }); throw new Error('Your Onshape connection expired. Reconnect and scan again.'); }
      if (!response.ok || !response.body) throw new Error('The scan could not start. Try again.');
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffered = '';
      let finished = false;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffered += decoder.decode(value, { stream: true });
        const lines = buffered.split('\n'); buffered = lines.pop() ?? '';
        for (const line of lines) {
          if (!line) continue;
          let event: ScanEvent;
          try { event = JSON.parse(line) as ScanEvent; } catch { throw new Error('The scan sent a reply Control Kit could not read. Try again.'); }
          if (event.type === 'progress' && generation === scanGeneration.current) setProgress(previous => ({ ...event, counts: { ...previous?.counts, ...event.counts } }));
          if (event.type === 'rate-limit') setProgress(previous => previous && { ...previous, retry: `Onshape is rate-limiting; retrying in ${Math.ceil(event.retryInMs / 1000)}s` });
          // A result that arrives after sign-out or a newer scan is dropped.
          if (event.type === 'result') finished = true;
          if (event.type === 'result' && generation === scanGeneration.current) {
            let scanned = event.result;
            if (scanned.vendorMatching === 'pending') {
              setProgress(previous => previous && { ...previous, stage: 'Reading vendor catalogs…', step: 'catalogs' });
              // A catalog read can finish after this scan was replaced; only the current scan's progress is shown.
              scanned = await matchInBrowser(scanned, controller.signal, progress => generation === scanGeneration.current && setProgress(previous => previous && {
                ...previous, stage: progress.catalogs < progress.catalogsTotal ? 'Reading vendor catalogs…' : 'Matching parts to vendor products…',
                step: progress.catalogs < progress.catalogsTotal ? 'catalogs' : 'matching', counts: { ...previous.counts, ...progress },
              }));
            }
            if (generation === scanGeneration.current) {
              const before = resultRef.current;
              setPrevious(before && before.scanId !== scanned.scanId && before.documentId === scanned.documentId && before.elementId === scanned.elementId ? before : null);
              setResult(scanned);
            }
          }
          if (event.type === 'session-expired') { setSession({ connected: false }); throw new Error('Your Onshape connection expired. Reconnect and scan again.'); }
          if (event.type === 'error') throw new Error(event.message);
        }
      }
      // A stream that closes without a result (a dropped connection, or the server stopping the scan) is a failure too.
      if (!finished && !controller.signal.aborted) throw new Error('The scan ended before it finished. Try again.');
    } catch (cause) {
      if (!controller.signal.aborted && generation === scanGeneration.current) setError(cause instanceof Error ? cause.message : 'The scan failed. Try again.');
    } finally { if (abort.current === controller) { abort.current = null; setProgress(null); } }
  }
  const cancelScan = () => abort.current?.abort();

  /**
   * Matches a Worker scan against the vendor catalogs here in the browser, then classifies and prices it, exactly as
   * the Worker used to. Catalog data comes from `/api/catalog/raw`; generation keys are cached by the browser. If the
   * catalogs cannot be read, the scan is still shown, unmatched, with the catalog warning.
   */
  async function matchInBrowser(scanned: ScanResult, signal: AbortSignal, onProgress?: (progress: MatchProgress) => void): Promise<ScanResult> {
    const reader = { get: async (key: string) => {
      const response = await api(`/api/catalog/raw?key=${encodeURIComponent(key)}`, { signal });
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`Catalog read failed (${response.status})`);
      return response.text();
    } };
    const decisions = new Map(scanned.lines.map(line => [line.bomLineKey, line.matchDecision ?? null]));
    // Matching works on a copy, so a read that fails partway never shows a half-matched result.
    const copy = structuredClone(scanned);
    try {
      await matchCatalog(copy, reader, async key => decisions.get(key) ?? null, signal, undefined, onProgress);
      copy.vendorMatching = 'done';
      return classifyScan(copy, settings, overridesOf(copy));
    } catch (cause) {
      if (signal.aborted) throw cause;
      setError('Vendor catalogs could not be read, so parts are not matched or priced. Rescan to try again.');
      return scanned;
    }
  }

  /** Confirm or reject a possible vendor match; the line updates at once and rolls back if saving fails. */
  /** Confirms or rejects the line's match; `pick` confirms one of its choices instead. */
  async function decide(line: BomLine, decision: 'confirmed' | 'rejected', pick?: VendorRecord, options: { keepAi?: boolean } = {}): Promise<boolean> {
    if (!result || !(pick ?? line.vendor) || pending || saving.has(line.bomLineKey)) return false;
    markSaving(line.bomLineKey, true);
    const generation = scanGeneration.current;
    const vendor = (pick ?? line.vendor)!;
    const previous = { matchStatus: line.matchStatus, vendor: line.vendor, alternatives: line.alternatives };
    const suggestions = aiSuggestionsOf(result, line);
    setResult(current => { if (!current) return current; const decided = withoutAi(applyMatchDecision(current, line.bomLineKey, decision, pick), line, options.keepAi); return classifyScan(decided, settings, overridesOf(decided)); });
    try {
      const response = await postJson('/api/matches/decision', { documentId: result.documentId, lineKey: line.bomLineKey, decision, vendorId: vendor.vendorId, normalizedSku: vendor.normalizedSku });
      if (!response.ok) throw new Error();
      return true;
    } catch {
      // Only this line goes back; choices made on other lines meanwhile stay.
      if (scanGeneration.current === generation) setResult(current => {
        if (!current) return current;
        // The decided row goes back first, so the check below compares it with its state from before the save.
        const lines = restoreAi({ ...current, lines: current.lines.map(item => item.bomLineKey === line.bomLineKey ? { ...item, ...previous } : item) }, suggestions).lines;
        const restored = { ...current, lines, stats: { ...current.stats } };
        return classifyScan(restored, settings, overridesOf(restored));
      });
      setError('Could not save the match choice. Try again.');
      return false;
    } finally { markSaving(line.bomLineKey, false); }
  }

  useEffect(() => {
    api('/api/ai/status').then(response => response.ok ? response.json() as Promise<{ enabled?: boolean }> : { enabled: false })
      .then(status => setAi(current => ({ ...current, enabled: Boolean(status.enabled) }))).catch(() => { /* The review stays hidden. */ });
  }, []);

  /** One batched request for every uncertain line. Suggestions only: nothing is saved until a person accepts one. */
  async function runAiReview() {
    if (!result?.scanId || ai.running || result.vendorMatching === 'pending') return;
    const { request, keys } = buildAiReviewRequest(result);
    if (!request.lines.length) { setAi(current => ({ ...current, note: 'Nothing uncertain to recheck.' })); return; }
    const scanId = result.scanId;
    const epoch = sessionEpoch.current;
    // After sign-out the reply is dropped, so it cannot bring back the old session's note.
    const current = () => sessionEpoch.current === epoch;
    setAi(state => ({ ...state, running: true, note: '' }));
    try {
      const response = await postJson('/api/ai/review', { documentId: result.documentId, scanId, request, keys });
      const body = await response.json().catch(() => ({})) as { items?: AiReviewItem[]; provider?: AiProvider; cached?: boolean; error?: string };
      if (!current()) return;
      if (!response.ok || !body.items || !body.provider) { setAi(state => ({ ...state, note: body.error ?? 'The AI review failed. Your parts are unchanged.' })); return; }
      setResult(state => state && state.scanId === scanId ? applyAiReview(state, keys, body.items!, body.provider!) : state);
      const who = body.provider === 'gemini' ? 'Gemini' : 'Claude';
      setAi(state => ({ ...state, note: `${who} suggested ${body.items!.length} of ${request.lines.length} uncertain parts${body.cached ? ' (a saved answer, no new AI call)' : ''}${request.leftOut ? `; ${request.leftOut} more were not sent` : ''}. Nothing changes until you accept a suggestion.` }));
    } catch { if (current()) setAi(state => ({ ...state, note: 'Could not reach the AI review. Your parts are unchanged.' })); }
    finally { if (current()) setAi(state => ({ ...state, running: false })); }
  }
  /** Accepting saves the suggestion exactly like a person's own choice: the product as a confirmed match, the type as a shared choice. */
  async function acceptAi(line: BomLine) {
    const suggestion = line.aiSuggestion;
    if (!suggestion) return;
    const record = aiCandidateRecord(line, suggestion.candidateId);
    const sameMatch = record && line.vendor && record.vendorId === line.vendor.vendorId && record.normalizedSku === line.vendor.normalizedSku;
    // Each save must succeed before the next; on a failure the suggestion stays so it can be accepted again.
    if (record && line.matchStatus !== 'exact' && !(sameMatch && line.matchStatus === 'confirmed') && !await decide(line, 'confirmed', record, { keepAi: true })) return;
    if (suggestion.disposition !== 'review' && !await setDisposition(line, suggestion.disposition, { keepAi: true })) return;
    dismissAi(line);
  }
  function dismissAi(line: BomLine) {
    setResult(current => current && { ...current, lines: current.lines.map(item => item.bomLineKey === line.bomLineKey ? { ...item, aiSuggestion: null } : item) });
  }

  /** Applies one choice at once and saves it; on failure the line returns to its previous choice. */
  /** A person's own decision on a line ends its AI suggestion; accepting the suggestion keeps it until both saves succeed. */
  // A choice applies to every row of the same part (two revisions of one part are two rows), so all of them lose it.
  function withoutAi(current: ScanResult, line: BomLine, keep = false): ScanResult {
    const identity = classificationIdentity(line);
    return keep ? current : { ...current, lines: current.lines.map(item => classificationIdentity(item) === identity && item.aiSuggestion ? { ...item, aiSuggestion: null } : item) };
  }
  /** The AI suggestions of every row of this part, to put back if a save fails. */
  type AiSnapshot = { suggestion: BomLine['aiSuggestion']; manual: BomLine['manualClassification']; match: BomLine['matchStatus'] };
  const aiSuggestionsOf = (current: ScanResult | null, line: BomLine) => new Map<string, AiSnapshot>((current?.lines ?? []).filter(item => classificationIdentity(item) === classificationIdentity(line))
    .map(item => [item.bomLineKey, { suggestion: item.aiSuggestion ?? null, manual: item.manualClassification, match: item.matchStatus }]));
  /**
   * Puts suggestions back after a failed save, but only on rows still as they were when the save began: a row that
   * got a newer decision meanwhile keeps it, and no old suggestion can come back to overwrite that.
   */
  const restoreAi = (current: ScanResult, saved: Map<string, AiSnapshot>) => ({ ...current, lines: current.lines.map(item => {
    const before = saved.get(item.bomLineKey);
    return before && !item.aiSuggestion && item.manualClassification === before.manual && item.matchStatus === before.match ? { ...item, aiSuggestion: before.suggestion } : item;
  }) });
  async function saveChoice(line: BomLine, choice: ClassificationOverride | null, keepAi = false) {
    if (!result) return false;
    const scanId = result.scanId;
    const generation = scanGeneration.current;
    const identity = classificationIdentity(line);
    const previous = line.manualClassification ?? null;
    const suggestions = aiSuggestionsOf(result, line);
    setResult(current => current && applyClassificationChoice(withoutAi(current, line, keepAi), identity, choice, settings));
    try {
      const response = await postJson('/api/classification/override', { documentId: result.documentId, scanId, identity, classification: choice });
      if (!response.ok) throw Error();
      return true;
    } catch {
      if (scanGeneration.current === generation) setResult(current => {
        if (!current || current.scanId !== scanId) return current;
        const active = current.lines.find(item => item.bomLineKey === line.bomLineKey);
        if (!active || active.manualClassification !== choice) return current;
        // The choice did not save, so the AI suggestion it replaced comes back too.
        // The choice is reverted first, so the check in restoreAi compares rows with their state from before the save.
        return restoreAi(applyClassificationChoice(current, identity, previous, settings), suggestions);
      });
      return false;
    }
  }

  /** Set how a part is obtained (or `null` for automatic). Shared with everyone who scans the document. */
  async function setDisposition(line: BomLine, choice: ClassificationOverride | null, options: { keepAi?: boolean } = {}): Promise<boolean> {
    if (!result || pending || saving.has(line.bomLineKey)) return false;
    markSaving(line.bomLineKey, true);
    try {
      const saved = await saveChoice(line, choice, options.keepAi);
      if (!saved) setError(`Could not save the choice for ${line.name}. Try again.`);
      return saved;
    } finally { markSaving(line.bomLineKey, false); }
  }

  /**
   * Accepts the suggestion on each line, one save at a time so progress shows and a failure affects only its part.
   * A rescan or sign-out stops the batch: the lines it holds belong to the previous scan.
   */
  async function acceptSuggestions(lines: BomLine[]) {
    if (!result || pending) return;
    const generation = scanGeneration.current;
    const todo = lines.filter(line => line.suggestedDisposition);
    setPending('bulk');
    let failed = 0;
    try {
      for (const [index, line] of todo.entries()) {
        if (generation !== scanGeneration.current) return;
        setBulk({ done: index, total: todo.length });
        if (!await saveChoice(line, line.suggestedDisposition)) failed++;
      }
      if (failed && generation === scanGeneration.current) setError(`${failed} of ${todo.length} choices could not be saved. Try those parts again.`);
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

  /** Ends the Onshape session on the server first; the app keeps its state if that fails, so the person can retry. */
  async function signOut() {
    try {
      const response = await api('/api/logout', { method: 'POST' });
      if (!response.ok) throw Error();
    } catch { setError('Could not sign out. Try again.'); return; }
    // Stop work that belongs to this session and drop any results it would still deliver.
    scanGeneration.current++;
    sessionEpoch.current++;
    abort.current?.abort(); abort.current = null; setProgress(null);
    stepRun.current = null;
    // Every saved scan of this person's goes, not just this assembly's.
    try {
      const userId = session?.user?.id;
      for (const key of Object.keys(localStorage).filter(item => item.startsWith('control-kit:scan:'))) {
        try { if ((JSON.parse(localStorage.getItem(key) ?? 'null') as { userId?: string } | null)?.userId === userId) localStorage.removeItem(key); }
        catch { localStorage.removeItem(key); }
      }
    } catch { /* Storage unavailable. */ }
    setStep(null); setResult(null); setPrevious(null); setError('');
    setAi(current => ({ ...current, running: false, note: '' })); setExcel('idle'); setBulk(null); setSettings({ teamNumber: null });
    setSession({ connected: false });
  }

  /** The Excel workbook for the current scan, with the logo when it loads within three seconds. */
  async function buildWorkbook() {
    if (!result) throw new Error('Scan first.');
    const logo = await fetch('/control-kit-logo.png', { signal: AbortSignal.timeout(3000) })
      .then(async response => response.ok ? new Uint8Array(await response.arrayBuffer()) : undefined).catch(() => undefined);
    const { buildExcelWorkbook } = await exporters();
    return buildExcelWorkbook(result, new Date(), logo);
  }
  async function downloadExcel() {
    if (!result || excel === 'working') return;
    setExcel('working');
    try {
      const workbook = await buildWorkbook();
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
    if (!result?.scanId || stepRun.current !== null) return;
    const run = ++stepRuns.current;
    stepRun.current = run;
    // False once sign-out has ended this export; it then stops without touching state.
    const active = () => stepRun.current === run;
    setStep({ running: true, ready: 0, failed: 0, total: 0, failures: [], zipMade: null });
    try {
      type Job = { jobId: string; done: boolean; rateLimited?: boolean; error?: string; assemblyName: string; documentName?: string; revision?: { type: string; id: string } | null; scannedAt: string; parts: ExportPart[] };
      const read = async (response: Response) => {
        // Only this export's own session may be ended: a reply from an export the person already left is ignored.
        if (response.status === 401) { if (active()) setSession({ connected: false }); throw Error('Your Onshape connection expired. Reconnect and export again.'); }
        const body = await response.json().catch(() => ({})) as Job;
        if (!response.ok || !body.jobId) throw Error(body.error ?? 'STEP export failed. Try again.');
        return body;
      };
      let job = await read(await postJson('/api/exports', { documentId: result.documentId, scanId: result.scanId }));
      if (!active()) return;
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
        if (!active()) return;
        job = await read(await api(`/api/exports/${job.jobId}`));
        if (!active()) return;
      }
      // A stalled export still delivers the files that finished; the rest are reported as unfinished.
      if (stalled) job = { ...job, parts: job.parts.map(part => part.state === 'ready' || part.state === 'failed' ? part : { ...part, state: 'failed', error: 'Export stopped before this part finished. Export again to retry it.' }) };
      // One failed download fails only that part; the others are still zipped.
      const files: Record<number, string> = {};
      for (const [index, part] of job.parts.entries()) {
        if (part.state !== 'ready') continue;
        try { const response = await api(`/api/exports/${job.jobId}/files/${index}`); if (response.ok) files[index] = await response.text(); }
        catch { /* Reported below as "File was not downloaded". */ }
        if (!active()) return;
      }
      const failures = job.parts.filter((part, index) => part.state === 'failed' || (part.state === 'ready' && files[index] === undefined))
        .map(part => ({ name: part.name, reason: part.error ?? 'File was not downloaded', url: part.sourceUrl }));
      const ready = job.parts.length - failures.length;
      // Failures are recorded before the ZIP is built, so an export where every part failed still lists each one.
      // The export counts as running, and the ZIP as not yet made, until the browser has been handed the file.
      setStep({ running: true, ready, failed: failures.length, total: job.parts.length, failures, zipMade: null });
      const { buildStepZip } = await exporters();
      if (!active()) return;
      const zip = buildStepZip({ ...job, files });
      saveFile(zip.bytes, zip.filename, 'application/zip');
      lastStepZip.current = { scanId: result.scanId, name: zip.filename, bytes: zip.bytes };
      setStep(current => current && { ...current, running: false, zipMade: ready > 0 });
    } catch (cause) {
      if (!active()) return;
      setStep(current => current && { ...current, running: false, zipMade: false });
      setError(cause instanceof Error ? cause.message : 'STEP export failed. Try again.');
    } finally { if (active()) stepRun.current = null; }
  }

  /** Shows a part where it lives: its tab in this document switches in place; a part from another document opens in a new tab. */
  function showInOnshape(line: BomLine) {
    if (line.documentId === context.get('documentId') && onshapeMessage('openAnotherElementInCurrentWorkspace', { anotherElementId: line.elementId })) return;
    window.open(line.partStudioUrl, '_blank', 'noopener,noreferrer');
  }

  /** A picture of the part drawn by Onshape at the scanned revision; the Worker caches it, so a second look is free. */
  async function partPicture(line: BomLine, signal: AbortSignal): Promise<string> {
    if (!result?.scanId) throw new Error('Scan this assembly to see part pictures.');
    const response = await api(`/api/preview?${new URLSearchParams({ scanId: result.scanId, line: line.bomLineKey })}`, { signal });
    if (!response.ok) throw new Error((await response.json().catch(() => null) as { error?: string } | null)?.error ?? 'Onshape could not draw this part.');
    return URL.createObjectURL(await response.blob());
  }

  /** The whole assembly drawn by Onshape at the scanned revision; cached by the Worker, so only a new revision costs a request. */
  async function assemblyPicture(signal: AbortSignal): Promise<string> {
    if (!result?.scanId) throw new Error('Scan this assembly first.');
    const response = await api(`/api/preview/assembly?${new URLSearchParams({ scanId: result.scanId })}`, { signal });
    if (!response.ok) throw new Error('No picture');
    return URL.createObjectURL(await response.blob());
  }

  return { assemblyPicture, context, buildWorkbook, lastStepZip, previous, ai, runAiReview, acceptAi, dismissAi, saving, showInOnshape, partPicture, session, checkingSession, refreshSession, connectUrl, error, clearError: () => setError(''), result, progress, scan, cancelScan, decide, setDisposition,
    acceptSuggestions, bulk, pending, settings, savingSettings, saveSettings, signOut, excel, downloadExcel, downloadCsv, step, downloadStep };
}
export type ControlKit = ReturnType<typeof useControlKit>;
