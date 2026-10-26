import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Boxes, Check, LayoutDashboard, ListChecks, LogOut, RefreshCw, Settings, ShoppingCart, Wrench } from 'lucide-react';
import { Alert } from '../components/arc/alert/alert';
import { Button } from './bits';
import { Progress } from '../components/arc/progress/progress';
import { contextKeys, useControlKit, type ControlKit, type ScanCounts, type ScanStep } from './useControlKit';
import { ago, summarize, type View } from './model';
import { Overview } from './Overview';
import { Review } from './Review';
import { Parts } from './Parts';
import { BuyList } from './BuyList';
import { Make } from './Make';
import { PartDrawer } from './PartDrawer';
import { SettingsDrawer } from './SettingsDrawer';
import { Landing } from './Landing';
import { useControlPoint } from './useControlPoint';
import { WorkspaceMark } from './ControlPoint';
import { CONTROL_POINT_CAD_URL } from '@control-kit/shared';

const views: View[] = ['overview', 'review', 'parts', 'buy', 'make'];
const viewLabel: Record<View, string> = { overview: 'Overview', review: 'Review', parts: 'Parts', buy: 'Buy list', make: 'Make' };
const viewIcon: Record<View, ReactNode> = { overview: <LayoutDashboard aria-hidden />, review: <ListChecks aria-hidden />, parts: <Boxes aria-hidden />, buy: <ShoppingCart aria-hidden />, make: <Wrench aria-hidden /> };
/** Inside Onshape the app is framed; opened on its own, it is a visitor reading about Control Kit. */
const framed = () => { try { return window.self !== window.top; } catch { return true; } };
const Logo = () => <img className="brand-mark" src="/control-kit-logo.png" alt="" />;

export function App() {
  const context = useMemo(() => new URLSearchParams(location.search), []);
  const kit = useControlKit(context);
  if (contextKeys.some(key => !context.get(key))) return framed() ? <Centered title="Open Control Kit from an assembly">Open an Assembly tab in Onshape, then choose Control Kit in its right panel.</Centered> : <Landing />;
  if (!kit.session) return <Centered title="Control Kit"><span className="muted">Checking your Onshape connection…</span></Centered>;
  if (kit.session.setupPending) return <Centered title="Control Kit is being set up">Onshape sign-in is not configured yet. Try again after the app is linked.</Centered>;
  if (!kit.session.connected) return <Connect kit={kit} />;
  if (!kit.result) return <FirstScan kit={kit} />;
  return <Workspace kit={kit} />;
}

function Centered({ title, children }: { title: string; children: ReactNode }) {
  return <main className="center-page"><section className="panel center-card"><div className="brand"><Logo /><span>Control Kit</span></div><h1>{title}</h1><p className="muted">{children}</p></section></main>;
}

function Connect({ kit }: { kit: ControlKit }) {
  return <main className="center-page"><section className="panel center-card">
    <div className="brand"><Logo /><span>Control Kit</span></div>
    <div className="stack"><h1>Connect Onshape</h1><p className="muted">Control Kit turns this assembly into a bill of materials: what to buy, what to make, and what still needs a decision. It only reads your documents.</p></div>
    {kit.error && <Alert tone="danger" title={kit.error} />}
    <div className="inline-actions">
      <Button onClick={() => window.open(kit.connectUrl, '_blank', 'noopener,noreferrer')}>Connect Onshape</Button>
      <Button variant="secondary" loading={kit.checkingSession} onClick={() => void kit.refreshSession()}>I've connected</Button>
    </div>
    <p className="muted small">Sign-in opens in a new tab. When it finishes, come back here and choose "I've connected".</p>
  </section></main>;
}

function FirstScan({ kit }: { kit: ControlKit }) {
  return <main className="center-page"><section className="panel center-card">
    <div className="brand"><Logo /><span>Control Kit</span></div>
    {kit.progress ? <ScanProgress kit={kit} /> : <>
      <div className="stack"><h1>Scan this assembly</h1><p className="muted">Control Kit reads the assembly and Onshape's bill of materials at their current revision, then sorts every part into buy, make, or review. A scan uses about three Onshape requests.</p></div>
      {kit.error && <Alert tone="danger" title={kit.error} />}
      <div className="inline-actions"><Button onClick={() => void kit.scan()}>Scan assembly</Button><span className="muted small">Connected as {kit.session?.user?.name}</span></div>
    </>}
  </section></main>;
}

const scanSteps: Array<{ step: ScanStep; label: string }> = [
  { step: 'revision', label: 'Assembly revision' }, { step: 'assembly', label: 'Assembly' }, { step: 'bom', label: "Onshape's bill of materials" },
  { step: 'choices', label: "Your team's saved choices" }, { step: 'catalogs', label: 'Vendor catalogs' }, { step: 'matching', label: 'Matching parts to products' },
];
const number = (value: number) => value.toLocaleString();
/** What each step has read so far, from the counts the Worker and the matcher report. */
function stepDetail(step: ScanStep, counts: ScanCounts): string | null {
  if (step === 'assembly' && counts.parts !== undefined) return counts.subassemblies === undefined ? `${number(counts.parts)} parts` : `${number(counts.parts)} parts in ${number(counts.subassemblies)} subassemblies`;
  if (step === 'assembly' && counts.subassemblies !== undefined) return `${number(counts.subassemblies)} subassemblies`;
  if (step === 'bom' && counts.bomRows !== undefined) return counts.cached ? `${number(counts.bomRows)} rows, saved copy` : `${number(counts.bomRows)} rows`;
  if (step === 'choices' && counts.lines !== undefined) return `${number(counts.lines)} unique parts`;
  if (step === 'catalogs' && counts.catalogs !== undefined) return `${counts.catalogs} of ${counts.catalogsTotal} catalogs, ${number(counts.products ?? 0)} products`;
  if (step === 'matching' && counts.matched !== undefined) return `${number(counts.matched)} of ${number(counts.lines ?? 0)} parts`;
  return null;
}

/** Every stage of a scan with what it has read: done in green, the current one in volt, the rest waiting. */
function ScanProgress({ kit }: { kit: ControlKit }) {
  const progress = kit.progress!;
  const counts = progress.counts ?? {};
  const active = Math.max(0, scanSteps.findIndex(item => item.step === (progress.step ?? 'revision')));
  // The matching step fills as parts are matched; the earlier steps count whole.
  const within = progress.step === 'matching' && counts.lines ? (counts.matched ?? 0) / counts.lines : progress.step === 'catalogs' && counts.catalogsTotal ? (counts.catalogs ?? 0) / counts.catalogsTotal : 0;
  const percent = Math.round(((active + within) / scanSteps.length) * 100);
  return <div className="stack scan-progress" aria-live="polite">
    <div className="section-head"><div><h2>{progress.stage}</h2><p className="muted small num">{percent}% done</p></div><Button variant="ghost" size="sm" onClick={kit.cancelScan}>Cancel</Button></div>
    <Progress value={percent} max={100} label="Scan progress" />
    <ol className="scan-steps">
      {scanSteps.map((item, index) => {
        const state = index < active ? 'done' : index === active ? 'active' : 'waiting';
        const detail = stepDetail(item.step, counts);
        return <li key={item.step} className={`scan-step ${state}`}>
          <span className="scan-step-icon" aria-hidden>{state === 'done' ? <Check size={12} strokeWidth={3} /> : null}</span>
          <span className="scan-step-label">{item.label}<span className="sr-only">{state === 'done' ? ', done' : state === 'active' ? ', in progress' : ', waiting'}</span></span>
          {detail && <span className="scan-step-detail num">{detail}</span>}
        </li>;
      })}
    </ol>
    {progress.retry && <p className="muted small">{progress.retry}</p>}
  </div>;
}

function Workspace({ kit }: { kit: ControlKit }) {
  const result = kit.result!;
  const cp = useControlPoint(kit);
  const [view, setView] = useState<View>(() => (views as string[]).includes(location.hash.slice(1)) ? location.hash.slice(1) as View : 'overview');
  const [selected, setSelected] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Relative times need a clock, which the first render does not have.
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => { setNow(Date.now()); const timer = setInterval(() => setNow(Date.now()), 60000); return () => clearInterval(timer); }, []);
  useEffect(() => {
    history.replaceState(null, '', `${location.pathname}${location.search}#${view}`);
    window.scrollTo({ top: 0 });
    // In the narrow panel the tab row scrolls; keep the current section's tab in view.
    document.querySelector('.tab[aria-current="page"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [view]);
  const summary = summarize(result);
  const counts: Record<View, number | null> = { overview: null, review: summary.review, parts: summary.uniqueLines, buy: summary.buy, make: summary.make.total };
  // Each section's colour job: review is orange while parts wait and green once none do; buy is sky; make is gold.
  const tone: Record<View, string | null> = { overview: null, review: summary.review ? 'attention' : 'done', parts: null, buy: 'buy', make: 'make' };
  const dot = (item: View) => tone[item] && <span className={`dot ${tone[item]}`} aria-hidden />;
  const line = selected ? result.lines.find(item => item.bomLineKey === selected) ?? result.suppressed.find(item => item.bomLineKey === selected) ?? null : null;
  const open = (key: string) => setSelected(key);
  const subtitle = [result.documentName, now ? `scanned ${ago(result.scannedAt, now)}` : null].filter(Boolean).join(' · ');

  return <div className="shell">
    <aside className="sidebar" aria-label="Control Kit">
      <div className="sidebar-brand"><Logo /><span>Control Kit</span></div>
      <nav aria-label="Sections">
        {views.map(item => <button key={item} type="button" className="nav-item" aria-current={view === item ? 'page' : undefined} onClick={() => setView(item)}>
          {viewIcon[item]}<span>{viewLabel[item]}</span>{counts[item] !== null && <span className={`count ${item === 'review' && counts[item]! > 0 ? 'attention' : ''}`}>{dot(item)}{counts[item]}</span>}
        </button>)}
      </nav>
      <div className="sidebar-foot">
        {cp.workspace ? <a className="nav-item" href={cp.workspace.cadUrl ?? CONTROL_POINT_CAD_URL} target="_blank" rel="noopener noreferrer"><WorkspaceMark workspace={cp.workspace} size={18} /><span>{cp.workspace.name}</span><span className="count">Control Point</span></a>
          : cp.link && <button type="button" className="nav-item" onClick={() => setSettingsOpen(true)}><img src="/control-point-icon.png" alt="" className="nav-logo" /><span>Control Point</span><span className="count">{cp.link.linked ? 'pick workspace' : 'not linked'}</span></button>}
        <button type="button" className="nav-item" onClick={() => setSettingsOpen(true)}><Settings aria-hidden /><span>Settings</span></button>
        <button type="button" className="nav-item" onClick={() => void kit.signOut()}><LogOut aria-hidden /><span>Sign out</span><span className="count">{kit.session?.user?.name}</span></button>
      </div>
    </aside>
    <div className="main">
      <header className="topbar">
        <Logo />
        <div className="topbar-title"><h1>{result.assemblyName}</h1>{subtitle && <p>{subtitle}</p>}</div>
        {cp.workspace && <a className="workspace-chip" href={cp.workspace.cadUrl ?? CONTROL_POINT_CAD_URL} target="_blank" rel="noopener noreferrer" title={`Control Point workspace ${cp.workspace.name}`}>
          <WorkspaceMark workspace={cp.workspace} size={20} /><span>{cp.workspace.name}</span></a>}
        <div className="topbar-actions">
          <Button variant="secondary" size="sm" loading={Boolean(kit.progress)} onClick={() => void kit.scan()}><RefreshCw aria-hidden size={14} /> Rescan</Button>
          <Button variant="ghost" size="sm" aria-label="Settings" className="settings-narrow" onClick={() => setSettingsOpen(true)}><Settings aria-hidden size={16} /></Button>
        </div>
      </header>
      <nav className="tabs" aria-label="Sections">
        {views.map(item => <button key={item} type="button" className="tab" aria-current={view === item ? 'page' : undefined} onClick={() => setView(item)}>
          {dot(item)}{viewLabel[item]}{counts[item] !== null && <span className="count">{counts[item]}</span>}
        </button>)}
      </nav>
      <main className="content">
        {kit.error && <Alert tone="danger" title={kit.error} onDismiss={kit.clearError} />}
        {kit.progress && <section className="panel"><div className="panel-body" style={{ paddingTop: 16 }}><ScanProgress kit={kit} /></div></section>}
        {view === 'overview' && <Overview kit={kit} cp={cp} summary={summary} go={setView} open={open} now={now} />}
        {view === 'review' && <Review kit={kit} open={open} />}
        {view === 'parts' && <Parts kit={kit} open={open} />}
        {view === 'buy' && <BuyList kit={kit} open={open} go={setView} />}
        {view === 'make' && <Make kit={kit} open={open} go={setView} />}
      </main>
    </div>
    <PartDrawer kit={kit} line={line} onClose={() => setSelected(null)} />
    <SettingsDrawer kit={kit} cp={cp} open={settingsOpen} onOpenChange={setSettingsOpen} />
  </div>;
}
