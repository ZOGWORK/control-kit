import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { applyMatchDecision, type BomLine, type ScanResult } from '@control-kit/shared';
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
  useEffect(() => {
    fetch(`${workerUrl}/api/session`, { credentials: 'include' })
      .then(async response => response.ok ? await response.json() as Session : { connected: false })
      .then(setSession)
      .catch(() => { setError('Could not check the Onshape connection. Reload this panel.'); setSession({ connected: false }); });
    return () => abort.current?.abort();
  }, []);

  async function scan() {
    if (abort.current) return;
    scanGeneration.current++;
    const controller = new AbortController();
    abort.current = controller;
    setError(''); setResult(null); setProgress({ stage: 'Fetching assembly…', current: 0, total: 1, instances: 0 });
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
          if (event.type === 'result') { setResult(event.result); setActiveTab('bom'); }
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
    setResult(applyMatchDecision(result, line.bomLineKey, decision));
    try {
      const response = await fetch(`${workerUrl}/api/matches/decision`, { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ documentId: result.documentId, lineKey: line.bomLineKey, decision, vendorId: line.vendor.vendorId, normalizedSku: line.vendor.normalizedSku }) });
      if (!response.ok) throw new Error();
    } catch {
      if (scanGeneration.current === generation) setResult(before);
      setError('Could not save the match choice. Try again.');
    } finally { setPendingDecision(false); }
  }

  if (required.some(key => !context.get(key))) return <main><h1>Control Kit</h1><p>Open an Assembly tab in Onshape, then launch Control Kit from its right panel.</p></main>;
  const connect = `${workerUrl}/oauth/start?${new URLSearchParams(required.map(key => [key, context.get(key)!]))}`;
  const rows = (activeTab === 'bom' ? result?.lines : activeTab === 'suppressed' ? result?.suppressed : result?.missingMetadata) ?? [];
  const visible = rows.filter(line => line.name.toLowerCase().includes(search.toLowerCase())).sort((a, b) => sort === 'qty' ? b.qty - a.qty : a.name.localeCompare(b.name));
  return <main>
    <header><h1>Control Kit</h1><span className="eyebrow">FTC assembly BOM</span></header>
    {error && <div className="alert" role="alert">{error}</div>}
    {!session && <p>Checking Onshape connection…</p>}
    {session?.setupPending && <p>Onshape connection setup is in progress. Return after the OAuth application is linked.</p>}
    {session && !session.connected && !session.setupPending && <section className="card"><p>Connect Onshape to prepare an assembly bill of materials.</p><a className="button" href={connect}>Connect Onshape</a></section>}
    {session?.connected && <>
      <section className="card"><div className="row"><div><h2>{result?.assemblyName ?? `Assembly ${context.get('elementId')}`}</h2><p className="muted">Connected as {session.user?.name}</p></div><button onClick={scan} disabled={Boolean(progress)}>{result ? 'Scan Again' : 'Scan Assembly'}</button></div>
        <p className="muted">On free Onshape plans, documents may need to be public for some API operations and scans may take longer.</p></section>
      {progress && <section className="card" aria-live="polite"><div className="row"><strong>{progress.stage}</strong><button className="secondary" onClick={() => abort.current?.abort()}>Cancel</button></div>
        <progress value={progress.current} max={Math.max(progress.total, 1)} /><p>{progress.instances} instances found</p>{progress.retry && <p>{progress.retry}</p>}</section>}
      {result && !progress && <><section className="stats"><div><strong>{result.stats.uniqueLines}</strong><span>Unique lines</span></div><div><strong>{result.stats.totalInstances}</strong><span>Active instances</span></div><div><strong>{result.stats.totalCostUsd === null ? '—' : `$${result.stats.totalCostUsd.toFixed(2)}`}</strong><span>Known purchasing total</span></div><div><strong>{result.suppressed.reduce((n, line) => n + line.qty, 0)}</strong><span>Suppressed</span></div><div><strong>{result.missingMetadata.length}</strong><span>Missing metadata</span></div></section>
        {result.vendorDataUpdatedAt && <p className="muted">Vendor data checked {new Date(result.vendorDataUpdatedAt).toLocaleString()}</p>}
        {result.stats.staleVendorData && <div className="alert" role="status">Some used vendor data is stale or its latest refresh failed. Check prices and stock before ordering.</div>}
        {result.stats.totalInstances === 0 && <p>This assembly has no parts yet.</p>}
        <nav aria-label="Results sections"><button className={activeTab === 'bom' ? 'selected' : 'secondary'} onClick={() => setActiveTab('bom')}>BOM</button><button className={activeTab === 'suppressed' ? 'selected' : 'secondary'} onClick={() => setActiveTab('suppressed')}>Suppressed</button><button className={activeTab === 'missing' ? 'selected' : 'secondary'} onClick={() => setActiveTab('missing')}>Missing metadata</button></nav>
        {activeTab === 'suppressed' && <p className="muted">Excluded from active quantities and purchasing totals.</p>}
        <div className="row filters"><input aria-label="Search parts" placeholder="Search parts" value={search} onChange={event => setSearch(event.target.value)} /><label>Sort <select value={sort} onChange={event => setSort(event.target.value as 'name' | 'qty')}><option value="name">Name</option><option value="qty">Quantity</option></select></label></div>
        <div className="table-wrap"><table><thead><tr><th>Part</th><th>Qty Needed</th><th>Packs to Order</th><th>Vendor / SKU</th><th>Pack Price</th><th>Line Total</th><th>Stock</th><th>Type</th><th>Match</th></tr></thead><tbody>{visible.map((line: BomLine) => <tr key={`${activeTab}-${line.bomLineKey}`} className={line.suppressed ? 'dimmed' : ''} title={line.missingMetadataReason ?? line.instancePaths.join('; ')}><td><a href={line.partStudioUrl} target="_blank" rel="noreferrer">{line.name}</a></td><td>{line.qty}</td><td>{line.packsToOrder ?? '—'}</td><td>{line.vendor ? <a href={line.vendor.url} target="_blank" rel="noreferrer">{line.vendor.vendorId} · {line.vendor.sku}</a> : '—'}</td><td>{line.vendor?.priceUsd === null || !line.vendor ? '—' : `$${line.vendor.priceUsd.toFixed(2)}`}</td><td>{line.lineTotalUsd === null ? '—' : `$${line.lineTotalUsd.toFixed(2)}`}</td><td>{line.vendor?.stock ?? 'Unknown'}</td><td>{line.classification === 'commercial' ? 'Commercial' : 'Unknown'}</td><td>{line.matchStatus === 'possible' ? <div className="actions"><span>Possible match</span><button disabled={pendingDecision} aria-label={`Confirm match for ${line.name}`} onClick={() => decide(line, 'confirmed')}>Confirm</button><button disabled={pendingDecision} className="secondary" aria-label={`Reject match for ${line.name}`} onClick={() => decide(line, 'rejected')}>Reject</button></div> : line.matchStatus === 'exact' ? 'Exact SKU' : line.matchStatus === 'confirmed' ? 'Matched' : line.matchStatus === 'rejected' ? 'Rejected' : 'Unmatched'}</td></tr>)}</tbody></table>{visible.length === 0 && <p className="empty">No parts in this section.</p>}</div>
      </>}
    </>}
  </main>;
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
