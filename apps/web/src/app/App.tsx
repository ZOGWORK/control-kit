import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Boxes, LayoutDashboard, ListChecks, LogOut, RefreshCw, Settings, ShoppingCart, Wrench } from 'lucide-react';
import { Alert } from '../components/arc/alert/alert';
import { Button } from './bits';
import { Progress } from '../components/arc/progress/progress';
import { contextKeys, useControlKit, type ControlKit } from './useControlKit';
import { ago, summarize, type View } from './model';
import { Overview } from './Overview';
import { Review } from './Review';
import { Parts } from './Parts';
import { BuyList } from './BuyList';
import { Make } from './Make';
import { PartDrawer } from './PartDrawer';
import { SettingsDrawer } from './SettingsDrawer';

const views: View[] = ['overview', 'review', 'parts', 'buy', 'make'];
const viewLabel: Record<View, string> = { overview: 'Overview', review: 'Review', parts: 'Parts', buy: 'Buy list', make: 'Make' };
const viewIcon: Record<View, ReactNode> = { overview: <LayoutDashboard aria-hidden />, review: <ListChecks aria-hidden />, parts: <Boxes aria-hidden />, buy: <ShoppingCart aria-hidden />, make: <Wrench aria-hidden /> };
const Logo = () => <img className="brand-mark" src="/control-kit-logo.png" alt="" />;

export function App() {
  const context = useMemo(() => new URLSearchParams(location.search), []);
  const kit = useControlKit(context);
  if (contextKeys.some(key => !context.get(key))) return <Centered title="Open Control Kit from an assembly">Open an Assembly tab in Onshape, then choose Control Kit in its right panel.</Centered>;
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

function ScanProgress({ kit }: { kit: ControlKit }) {
  const progress = kit.progress!;
  return <div className="stack" aria-live="polite">
    <div className="section-head"><h2>{progress.stage}</h2><Button variant="ghost" size="sm" onClick={kit.cancelScan}>Cancel</Button></div>
    <Progress value={progress.current} max={Math.max(progress.total, 1)} label="Scan progress" />
    {progress.retry && <p className="muted small">{progress.retry}</p>}
  </div>;
}

function Workspace({ kit }: { kit: ControlKit }) {
  const result = kit.result!;
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
  const line = selected ? result.lines.find(item => item.bomLineKey === selected) ?? result.suppressed.find(item => item.bomLineKey === selected) ?? null : null;
  const open = (key: string) => setSelected(key);
  const subtitle = [result.documentName, now ? `scanned ${ago(result.scannedAt, now)}` : null].filter(Boolean).join(' · ');

  return <div className="shell">
    <aside className="sidebar" aria-label="Control Kit">
      <div className="sidebar-brand"><Logo /><span>Control Kit</span></div>
      <nav aria-label="Sections">
        {views.map(item => <button key={item} type="button" className="nav-item" aria-current={view === item ? 'page' : undefined} onClick={() => setView(item)}>
          {viewIcon[item]}<span>{viewLabel[item]}</span>{counts[item] !== null && <span className={`count ${item === 'review' && counts[item]! > 0 ? 'attention' : ''}`}>{counts[item]}</span>}
        </button>)}
      </nav>
      <div className="sidebar-foot">
        <button type="button" className="nav-item" onClick={() => setSettingsOpen(true)}><Settings aria-hidden /><span>Settings</span></button>
        <button type="button" className="nav-item" onClick={() => void kit.signOut()}><LogOut aria-hidden /><span>Sign out</span><span className="count">{kit.session?.user?.name}</span></button>
      </div>
    </aside>
    <div className="main">
      <header className="topbar">
        <Logo />
        <div className="topbar-title"><h1>{result.assemblyName}</h1>{subtitle && <p>{subtitle}</p>}</div>
        <div className="topbar-actions">
          <Button variant="secondary" size="sm" loading={Boolean(kit.progress)} onClick={() => void kit.scan()}><RefreshCw aria-hidden size={14} /> Rescan</Button>
          <Button variant="ghost" size="sm" aria-label="Settings" className="settings-narrow" onClick={() => setSettingsOpen(true)}><Settings aria-hidden size={16} /></Button>
        </div>
      </header>
      <nav className="tabs" aria-label="Sections">
        {views.map(item => <button key={item} type="button" className="tab" aria-current={view === item ? 'page' : undefined} onClick={() => setView(item)}>
          {viewLabel[item]}{counts[item] !== null && <span className="count">{counts[item]}</span>}
        </button>)}
      </nav>
      <main className="content">
        {kit.error && <Alert tone="danger" title={kit.error} onDismiss={kit.clearError} />}
        {kit.progress && <section className="panel"><div className="panel-body" style={{ paddingTop: 16 }}><ScanProgress kit={kit} /></div></section>}
        {view === 'overview' && <Overview kit={kit} summary={summary} go={setView} now={now} />}
        {view === 'review' && <Review kit={kit} open={open} />}
        {view === 'parts' && <Parts kit={kit} open={open} />}
        {view === 'buy' && <BuyList kit={kit} open={open} go={setView} />}
        {view === 'make' && <Make kit={kit} open={open} go={setView} />}
      </main>
    </div>
    <PartDrawer kit={kit} line={line} onClose={() => setSelected(null)} />
    <SettingsDrawer kit={kit} open={settingsOpen} onOpenChange={setSettingsOpen} />
  </div>;
}
