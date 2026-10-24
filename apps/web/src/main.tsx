import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { applyClassificationChoice, applyMatchDecision, classificationIdentity, classifyScan, type BomLine, type CatalogHealth, type ClassificationOverride, type ScanResult, type UserSettings, type VendorHealth } from '@control-kit/shared';
import { buildBomCsv, buildExcelWorkbook } from '@control-kit/excel';
import './style.css';

type Session = { connected: boolean; setupPending?: boolean; user?: { id: string; name: string } };
type Tab = 'bom' | 'suppressed' | 'missing';
type Progress = { stage: string; current: number; total: number; instances: number; retry?: string };
const context = new URLSearchParams(location.search);
const required = ['documentId', 'workspaceOrVersion', 'workspaceOrVersionId', 'elementId'];
const workerUrl = import.meta.env.VITE_WORKER_URL ?? '';

function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [error, setError] = useState('');
  const [result, setResult] = useState<ScanResult | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [activeTab, setActiveTab] = useState<Tab>('bom');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<'name' | 'qty'>('name');
  const abort = useRef<AbortController | null>(null);
  const scanGeneration = useRef(0);
  const [pendingDecision, setPendingDecision] = useState(false);
  const [settings, setSettings] = useState<UserSettings>({ teamNumber: null });
  const [teamInput, setTeamInput] = useState('');
  const [pendingSettings, setPendingSettings] = useState(false);
  const [pendingOverride, setPendingOverride] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [printFailures, setPrintFailures] = useState<{ name: string; reason: string; url: string }[]>([]);
  const [excelFailed, setExcelFailed] = useState(false);
  const [exportingExcel, setExportingExcel] = useState(false);
  const excelLock = useRef(false);
  const sessionCheck = useRef(0);
  const [checkingSession, setCheckingSession] = useState(false);
  async function refreshSession() {
    const generation = ++sessionCheck.current;
    setCheckingSession(true);
    try {
      const response = await fetch(`${workerUrl}/api/session`, { credentials: 'include' });
      const next = response.ok ? await response.json() as Session : { connected: false };
      if (generation !== sessionCheck.current) return;
      setSession(next);
      if (next.connected) setError('');
    } catch {
      if (generation !== sessionCheck.current) return;
      setError('Could not check the Onshape connection. Try again.');
      setSession({ connected: false });
    } finally {
      if (generation === sessionCheck.current) setCheckingSession(false);
    }
  }
  useEffect(() => {
    void refreshSession();
    return () => abort.current?.abort();
  }, []);
  useEffect(() => {
    if (!session?.connected) return;
    fetch(`${workerUrl}/api/settings`, { credentials: 'include' }).then(async response => {
      if (!response.ok) throw Error();
      return await response.json() as UserSettings;
    }).then(value => { setSettings(value); setTeamInput(value.teamNumber ?? ''); }).catch(() => setError('Could not load team settings.'));
  }, [session?.connected]);

  async function scan() {
    if (abort.current) return;
    scanGeneration.current++;
    const controller = new AbortController();
    abort.current = controller;
    setError(''); setExcelFailed(false); setResult(null); setProgress({ stage: 'Fetching assembly…', current: 0, total: 1, instances: 0 });
    try {
      const query = new URLSearchParams(required.map(key => [key, context.get(key)!]));
      const response = await fetch(`${workerUrl}/api/scan?${query}`, { credentials: 'include', signal: controller.signal });
      if (response.status === 401) { setSession({ connected: false }); throw new Error('Your Onshape connection expired. Reconnect and retry.'); }
      if (!response.ok || !response.body) throw new Error('The scan could not start. Try again.');
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let pending = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        pending += decoder.decode(value, { stream: true });
        const lines = pending.split('\n'); pending = lines.pop() ?? '';
        for (const line of lines) {
          if (!line) continue;
          const event = JSON.parse(line) as
            | { type: 'progress'; stage: string; current: number; total: number; instances: number }
            | { type: 'rate-limit'; retryInMs: number }
            | { type: 'result'; result: ScanResult }
            | { type: 'session-expired' }
            | { type: 'error'; message: string };
          if (event.type === 'progress') setProgress({ ...event });
          if (event.type === 'rate-limit') setProgress(previous => previous && { ...previous, retry: `Onshape rate limit — retrying in ${Math.ceil(event.retryInMs / 1000)}s…` });
          if (event.type === 'result') { setResult(event.result); setPrintFailures([]); setActiveTab('bom'); }
          if (event.type === 'session-expired') { setSession({ connected: false }); throw new Error('Your Onshape connection expired. Reconnect and retry.'); }
          if (event.type === 'error') throw new Error(event.message);
        }
      }
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'The scan failed. Try again.');
    } finally { abort.current = null; setProgress(null); }
  }

  async function decide(line: BomLine, decision: 'confirmed' | 'rejected') {
    if (!result || !line.vendor || pendingDecision) return;
    setPendingDecision(true);
    const generation = scanGeneration.current;
    const before = result;
    const decided = applyMatchDecision(result, line.bomLineKey, decision);
    setResult(classifyScan(decided, settings, Object.fromEntries(decided.lines.filter(item => item.manualClassification).map(item => [item.bomLineKey, item.manualClassification!]))));
    try {
      const response = await fetch(`${workerUrl}/api/matches/decision`, { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ documentId: result.documentId, lineKey: line.bomLineKey, decision, vendorId: line.vendor.vendorId, normalizedSku: line.vendor.normalizedSku }) });
      if (!response.ok) throw new Error();
    } catch {
      if (scanGeneration.current === generation) setResult(before);
      setError('Could not save the match choice. Try again.');
    } finally { setPendingDecision(false); }
  }
  async function saveSettings() {
    if (pendingSettings || (teamInput && !/^\d{1,6}$/.test(teamInput))) { setError('Team number must be 1–6 digits.'); return; }
    setPendingSettings(true);
    try {
      const value = { teamNumber: teamInput || null };
      const response = await fetch(`${workerUrl}/api/settings`, { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });
      if (!response.ok) throw Error();
      setSettings(value);
      setResult(previous => previous && classifyScan({ ...previous, lines: previous.lines.map(line => ({ ...line })), stats: { ...previous.stats } }, value,
        Object.fromEntries(previous.lines.filter(line => line.manualClassification).map(line => [line.bomLineKey, line.manualClassification!]))));
    } catch { setError('Could not save team settings. Try again.'); }
    finally { setPendingSettings(false); }
  }
  async function override(line: BomLine, classification: ClassificationOverride | null) {
    if (!result || pendingOverride) return;
    const before = result;
    const generation = scanGeneration.current;
    const identity = classificationIdentity(line);
    const previousChoice = before.lines.find(item => classificationIdentity(item) === identity)?.manualClassification ?? null;
    setPendingOverride(true);
    setResult(previous => previous && applyClassificationChoice(previous, identity, classification, settings));
    try {
      const response = await fetch(`${workerUrl}/api/classification/override`, { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ documentId: result.documentId, identity, classification }) });
      if (!response.ok) throw Error();
    } catch {
      if (scanGeneration.current === generation) setResult(current => {
        if (!current || current.scanId !== before.scanId) return current;
        const active = current.lines.find(item => item.bomLineKey === line.bomLineKey);
        if (!active || active.manualClassification !== classification) return current;
        return applyClassificationChoice(current, identity, previousChoice, settings);
      });
      setError('Could not save the type override. Try again.');
    }
    finally { setPendingOverride(false); }
  }
  async function downloadPrints() {
    if (!result?.scanId || downloading) return;
    setDownloading(true); setPrintFailures([]);
    try {
      const response = await fetch(`${workerUrl}/api/prints/zip?documentId=${encodeURIComponent(result.documentId)}&scanId=${encodeURIComponent(result.scanId)}`, { credentials: 'include' });
      if (!response.ok) throw Error(response.status === 409 ? 'Scan this assembly again before exporting STLs.' : 'STL export failed. Try again.');
      const failures = JSON.parse(decodeURIComponent(response.headers.get('x-control-kit-failures') ?? '%5B%5D')) as { name: string; reason: string; url: string }[];
      setPrintFailures(failures);
      const url = URL.createObjectURL(await response.blob());
      const anchor = document.createElement('a');
      anchor.href = url; anchor.download = `${result.assemblyName.replace(/[^a-zA-Z0-9-_ ]/g, '').trim().replace(/ +/g, '_') || 'Assembly'}_prints.zip`;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'STL export failed. Try again.'); }
    finally { setDownloading(false); }
  }

  function saveFile(bytes: Uint8Array, filename: string, mime: string) {
    const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: mime }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
  async function downloadExcel() {
    if (!result || excelLock.current) return;
    excelLock.current = true;
    setExportingExcel(true);
    setExcelFailed(false);
    try {
      const logo = await fetch('/control-kit-logo.png', { signal: AbortSignal.timeout(3000) })
        .then(async response => response.ok ? new Uint8Array(await response.arrayBuffer()) : undefined)
        .catch(() => undefined);
      const workbook = buildExcelWorkbook(result, new Date(), logo);
      saveFile(workbook.bytes, workbook.filename, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    } catch { setExcelFailed(true); }
    finally { setTimeout(() => { excelLock.current = false; setExportingExcel(false); }, 250); }
  }
  function downloadCsv() {
    if (!result) return;
    try { const csv = buildBomCsv(result); saveFile(csv.bytes, csv.filename, 'text/csv;charset=utf-8'); }
    catch { setError('CSV export failed. Try again.'); }
  }

  if (required.some(key => !context.get(key))) return <main><header><div className="brand"><img className="brand-mark" src="/control-kit-logo.png" alt=""/><h1>Control Kit</h1></div></header><p>Open an Assembly tab in Onshape, then launch Control Kit from its right panel.</p></main>;
  const connect = `${workerUrl}/oauth/start?${new URLSearchParams(required.map(key => [key, context.get(key)!]))}`;
  const rows = (activeTab === 'bom' ? result?.lines : activeTab === 'suppressed' ? result?.suppressed : result?.missingMetadata) ?? [];
  const visible = rows.filter(line => line.name.toLowerCase().includes(search.toLowerCase())).sort((a, b) => sort === 'qty' ? b.qty - a.qty : a.name.localeCompare(b.name));
  return <main>
    <header><div className="brand"><img className="brand-mark" src="/control-kit-logo.png" alt=""/><h1>Control Kit</h1></div><span className="eyebrow">FTC assembly BOM</span></header>
    {error && <div className="alert" role="alert">{error}</div>}
    {!session && <p>Checking Onshape connection…</p>}
    {session?.setupPending && <p>Onshape connection setup is in progress. Return after the OAuth application is linked.</p>}
    {session && !session.connected && !session.setupPending && <section className="card"><p>Connect Onshape to prepare an assembly bill of materials.</p><a className="button" href={connect} target="_blank" rel="noopener noreferrer">Connect Onshape</a><p className="muted">Authorization opens in a new tab. After granting access, return here and check the connection.</p><button className="secondary" disabled={checkingSession} onClick={() => void refreshSession()}>{checkingSession ? 'Checking connection…' : 'Check connection'}</button></section>}
    {session?.connected && <>
      <section className="card"><div className="row"><div><h2>Settings</h2><p className="muted">Team number helps identify custom printed parts.</p></div><label>Team number <input aria-label="Team number" inputMode="numeric" value={teamInput} onChange={event => setTeamInput(event.target.value)} placeholder="Optional" /></label><button disabled={pendingSettings} onClick={saveSettings}>Save</button></div></section>
      <section className="card"><div className="row"><div><h2>{result?.assemblyName ?? `Assembly ${context.get('elementId')}`}</h2><p className="muted">Connected as {session.user?.name}</p></div><button onClick={scan} disabled={Boolean(progress)}>{result ? 'Scan Again' : 'Scan Assembly'}</button></div>
        <p className="muted">On free Onshape plans, documents must be public for some API operations and rate limits are lower — scans may take longer.</p></section>
      {progress && <section className="card" aria-live="polite"><div className="row"><strong>{progress.stage}</strong><button className="secondary" onClick={() => abort.current?.abort()}>Cancel</button></div>
        <progress value={progress.current} max={Math.max(progress.total, 1)} /><p>{progress.instances} instances found</p>{progress.retry && <p>{progress.retry}</p>}</section>}
      {result && !progress && <><section className="stats"><div><strong>{result.stats.uniqueLines}</strong><span>Unique lines</span></div><div><strong>{result.stats.totalInstances}</strong><span>Active instances</span></div><div><strong>{result.stats.totalCostUsd === null ? '—' : `$${result.stats.totalCostUsd.toFixed(2)}`}</strong><span>Known purchasing total</span></div><div><strong>{result.stats.printedLines}</strong><span>Printed lines</span></div><div><strong>{result.suppressed.reduce((n, line) => n + line.qty, 0)}</strong><span>Suppressed</span></div><div><strong>{result.missingMetadata.length}</strong><span>Missing metadata</span></div></section>
        <div className="row"><button onClick={downloadExcel} disabled={exportingExcel}>{exportingExcel ? 'Preparing Excel…' : 'Download Excel BOM'}</button><button onClick={downloadPrints} disabled={downloading || !result.scanId || result.stats.printedLines === 0}>{downloading ? 'Preparing STL zip…' : 'Download printed parts STL zip'}</button><span className="muted">STL zip includes printed lines and a README with source links and failures.</span></div>
        {excelFailed && <div className="alert" role="status">Excel export failed. <button onClick={downloadCsv}>Download CSV instead</button></div>}
        {printFailures.length > 0 && <div className="alert" role="status"><strong>STL export failed for some parts</strong><ul>{printFailures.map(item => <li key={`${item.name}:${item.reason}`}>{item.name}: {item.reason} <a href={item.url} target="_blank" rel="noreferrer">Open in Onshape</a></li>)}</ul><p>See README.txt in the zip for the full list.</p></div>}
        {result.vendorDataUpdatedAt && <p className="muted">Vendor data checked {new Date(result.vendorDataUpdatedAt).toLocaleString()}</p>}
        {result.catalogHealth && <CatalogWarning health={result.catalogHealth} />}
        {result.stats.staleVendorData && <div className="alert" role="status">Some used vendor data is stale or its latest refresh failed. Check prices and stock before ordering.</div>}
        {result.stats.totalInstances === 0 && <p>This assembly has no parts yet.</p>}
        <nav aria-label="Results sections"><button className={activeTab === 'bom' ? 'selected' : 'secondary'} onClick={() => setActiveTab('bom')}>BOM</button><button className={activeTab === 'suppressed' ? 'selected' : 'secondary'} onClick={() => setActiveTab('suppressed')}>Suppressed</button><button className={activeTab === 'missing' ? 'selected' : 'secondary'} onClick={() => setActiveTab('missing')}>Missing metadata</button></nav>
        {activeTab === 'suppressed' && <p className="muted">Excluded from active quantities and purchasing totals.</p>}
        <div className="row filters"><input aria-label="Search parts" placeholder="Search parts" value={search} onChange={event => setSearch(event.target.value)} /><label>Sort <select value={sort} onChange={event => setSort(event.target.value as 'name' | 'qty')}><option value="name">Name</option><option value="qty">Quantity</option></select></label></div>
        <div className="table-wrap"><table><thead><tr><th>Part</th><th>Qty Needed</th><th>Packs to Order</th><th>Vendor / SKU</th><th>Pack Price</th><th>Line Total</th><th>Stock</th><th>Type</th><th>Match</th></tr></thead><tbody>{visible.map((line: BomLine) => <tr key={`${activeTab}-${line.bomLineKey}`} className={line.suppressed ? 'dimmed' : ''} title={line.missingMetadataReason ?? line.instancePaths.join('; ')}><td><a href={line.partStudioUrl} target="_blank" rel="noreferrer">{line.name}</a></td><td>{line.qty}</td><td>{line.packsToOrder ?? '—'}</td><td>{line.vendor ? <a href={line.vendor.url} target="_blank" rel="noreferrer">{line.vendor.vendorId} · {line.vendor.sku}</a> : '—'}</td><td>{line.vendor?.priceUsd === null || !line.vendor ? '—' : `$${line.vendor.priceUsd.toFixed(2)}`}</td><td>{line.lineTotalUsd === null ? '—' : `$${line.lineTotalUsd.toFixed(2)}`}</td><td>{line.vendor?.stock ?? 'Unknown'}</td><td><div className="type-choice" title={line.classificationReasons.join('; ')}><span>{line.classification === 'printed' ? 'Printed' : line.classification === 'unknown' ? 'Possibly printed' : 'Commercial'} · {line.classificationScore}{line.manualClassification ? ' · Manual' : ''}</span><select aria-label={`Type for ${line.name}`} value={line.manualClassification ?? 'auto'} disabled={pendingOverride || line.suppressed} onChange={event => override(line, event.target.value === 'auto' ? null : event.target.value as ClassificationOverride)}><option value="auto">Auto</option><option value="commercial">Commercial</option><option value="printed">Printed</option></select></div></td><td>{line.matchStatus === 'possible' ? <div className="actions" title={line.matchReasons.join('; ')}><span>Possible match</span><button disabled={pendingDecision} aria-label={`Confirm match for ${line.name}`} onClick={() => decide(line, 'confirmed')}>Confirm</button><button disabled={pendingDecision} className="secondary" aria-label={`Reject match for ${line.name}`} onClick={() => decide(line, 'rejected')}>Reject</button></div> : line.matchStatus === 'exact' ? <span title={line.matchReasons.join('; ')}>Exact SKU</span> : line.matchStatus === 'confirmed' ? 'Confirmed by you' : line.matchStatus === 'rejected' ? 'Rejected' : 'Unmatched'}</td></tr>)}</tbody></table>{visible.length === 0 && <p className="empty">No parts in this section.</p>}</div>
      </>}
    </>}
  </main>;
}

const vendorLabel: Record<VendorHealth['vendorId'], string> = { gobilda: 'goBILDA', servocity: 'ServoCity', andymark: 'AndyMark', rev: 'REV', pitsco: 'Pitsco' };
/** Shown even when no line matched: an empty Vendor column must not read as "no supplier sells this". */
function CatalogWarning({ health }: { health: CatalogHealth }) {
  const missing = health.vendors.filter(vendor => vendor.state !== 'published');
  const partial = health.vendors.filter(vendor => vendor.state === 'published' && !vendor.complete);
  const stale = health.vendors.filter(vendor => vendor.state === 'published' && (vendor.stale || vendor.lastRunFailed));
  if (!missing.length && !partial.length && !stale.length) return null;
  return <div className="alert" role="status">
    {missing.length > 0 && <p><strong>Vendor data {missing.length === health.vendors.length ? 'unavailable' : 'incomplete'}.</strong> No catalog is published yet for {missing.map(vendor => vendorLabel[vendor.vendorId]).join(', ')}, so their parts can't be matched, priced, or linked. A blank Vendor column does not mean the part isn't sold.</p>}
    {partial.length > 0 && <p><strong>Partial catalogs.</strong> {partial.map(vendor => `${vendorLabel[vendor.vendorId]} (${vendor.recordCount} products so far)`).join(', ')} {partial.length === 1 ? 'is' : 'are'} still being collected, so some of their parts may not match yet.</p>}
    {stale.length > 0 && <p>Catalog data for {stale.map(vendor => vendorLabel[vendor.vendorId]).join(', ')} is out of date or its last refresh failed. Check prices and stock before ordering.</p>}
  </div>;
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
