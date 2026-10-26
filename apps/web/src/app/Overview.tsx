import { useEffect, useState, type ReactNode } from 'react';
import { AlertTriangle, ArrowRight, Check, ChevronDown, FileSpreadsheet, History, ListChecks, PackageX, Search, Store, Tag, Wrench } from 'lucide-react';
import { metadataIssueText, type BomLine } from '@control-kit/shared';
import { Alert } from '../components/arc/alert/alert';
import { Button, DispositionChip } from './bits';
import type { ControlKit } from './useControlKit';
import { ago, buyList, catalogsComplete, catalogState, catalogStateText, composition, findParts, hasChanges, money, percent, primaryAction, readiness, scanChanges, staleCatalogs, topCosts, unmatchedParts, vendorLabel,
  type PrimaryAction, type Readiness, type Summary, type View } from './model';

/** "1 part", "3 parts". */
const parts = (count: number) => `${count} ${count === 1 ? 'part' : 'parts'}`;
/** Lowercases only the first letter, so names like Onshape and BOM keep their case mid-sentence. */
const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);
const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

/** A problem still standing between this scan and a complete order and build list. */
type Move = { key: string; icon: ReactNode; tone: 'attention' | 'blocked'; title: string; detail: string; action?: ReactNode; lines?: BomLine[] };

export function Overview({ kit, summary, go, open, now }: { kit: ControlKit; summary: Summary; go: (view: View) => void; open: (key: string) => void; now: number | null }) {
  const result = kit.result!;
  const ready = readiness(result, summary);
  const primary = primaryAction(summary, ready);
  const health = result.catalogHealth;
  const notReady = health?.vendors.filter(vendor => !['published', 'stale'].includes(catalogState(vendor))) ?? [];
  const stale = staleCatalogs(health);
  const topIssue = Object.entries(result.missingMetadata.filter(line => !line.suppressed && line.metadataIssue)
    .reduce<Record<string, number>>((counts, line) => ({ ...counts, [line.metadataIssue!.code]: (counts[line.metadataIssue!.code] ?? 0) + 1 }), {}))
    .sort((a, b) => b[1] - a[1])[0];

  const moves: Move[] = [];
  const done: string[] = [];
  if (summary.review) moves.push({ key: 'review', icon: <ListChecks aria-hidden />, tone: 'attention', title: `${parts(summary.review)} ${summary.review === 1 ? 'needs' : 'need'} a decision`,
    detail: summary.possibleMatches ? `${summary.possibleMatches} have a possible vendor match to confirm. The rest need you to choose how they're made.` : 'Choose whether each part is bought, printed, or fabricated.',
    action: <Button variant="secondary" size="sm" onClick={() => go('review')}>Review</Button> });
  else done.push('Every part has a decision');
  // Loading catalogs explain unmatched parts, so they come before them.
  if (notReady.length) moves.push({ key: 'catalog', icon: <Store aria-hidden />, tone: 'attention', title: notReady.length === health!.vendors.length ? 'Vendor catalogs are still loading' : 'Some vendor catalogs are still loading',
    detail: `${notReady.map(vendor => `${vendorLabel[vendor.vendorId]} (${catalogStateText(vendor).toLowerCase()})`).join(', ')}. Parts from these vendors can't be matched or priced yet; rescan later to pick them up.` });
  else if (health) done.push('All vendor catalogs loaded');
  if (ready.order.unmatched) moves.push({ key: 'sku', icon: <Tag aria-hidden />, tone: 'attention', title: `${parts(ready.order.unmatched)} to buy ${ready.order.unmatched === 1 ? 'has' : 'have'} no vendor match`,
    detail: notReady.length ? 'Add the vendor SKU to the part number in Onshape, or confirm a match once catalogs finish loading.' : 'Add the vendor SKU to the part number in Onshape, then rescan.',
    action: <Button variant="secondary" size="sm" onClick={() => go('buy')}>Open buy list</Button>, lines: unmatchedParts(result) });
  else if (summary.buyLines) done.push('Every part to buy is matched');
  if (ready.order.unpriced) moves.push({ key: 'unpriced', icon: <Tag aria-hidden />, tone: 'attention', title: `${parts(ready.order.unpriced)} matched but not priced`,
    detail: 'Their pack size or price is unknown, so they stay out of the total. Check them on the vendor\'s site.', action: <Button variant="secondary" size="sm" onClick={() => go('buy')}>Open buy list</Button> });
  else if (summary.buyLines && !ready.order.unmatched) done.push('Every matched part is priced');
  if (ready.order.outOfStock) moves.push({ key: 'stock', icon: <PackageX aria-hidden />, tone: 'blocked', title: `${parts(ready.order.outOfStock)} out of stock`,
    detail: 'The vendor lists these as out of stock. The buy list shows in-stock alternatives where there are any.', action: <Button variant="secondary" size="sm" onClick={() => go('buy')}>Open buy list</Button> });
  // "In stock" only when every matched part says so; a catalog may not know a product's stock.
  else if (ready.order.total - ready.order.unmatched > 0) done.push(buyList(result).vendors.every(group => group.lines.every(line => line.vendor!.stock === 'in' || line.vendor!.stock === 'low')) ? 'Everything matched is in stock' : 'No matched part is reported out of stock');
  if (summary.dataIssues && topIssue) moves.push({ key: 'issues', icon: <AlertTriangle aria-hidden />, tone: 'blocked', title: `${parts(summary.dataIssues)} ${summary.dataIssues === 1 ? 'is' : 'are'} missing data`,
    detail: `${summary.dataIssues === 1 ? 'Reason' : 'Most often'}: ${lowerFirst(metadataIssueText[topIssue[0] as keyof typeof metadataIssueText])}${summary.dataIssues === 1 ? '' : ` (${topIssue[1]})`}.`,
    action: <Button variant="secondary" size="sm" onClick={() => go('parts')}>See parts</Button> });

  return <div className="overview">
    <FindPart kit={kit} open={open} />
    <StatusCard result={result} summary={summary} ready={ready} />
    {kit.previous && <Changes kit={kit} />}
    <PrimaryBar kit={kit} primary={primary} summary={summary} go={go} />
    {stale.length > 0 && <div className="stale-note"><Alert tone="warning" title="Some vendor prices may be out of date">
      {stale.map(vendor => `${vendorLabel[vendor.vendorId]} (${catalogStateText(vendor).toLowerCase()})`).join(', ')}. Prices are as of {result.vendorDataUpdatedAt ? day(result.vendorDataUpdatedAt) : 'an earlier date'}; check prices and stock on the vendor's site before ordering.
    </Alert></div>}
    <Moves kit={kit} moves={moves} done={done} />
    <div className="overview-side">
      <MoneyCard kit={kit} summary={summary} ready={ready} go={go} />
      <BuyByVendor kit={kit} go={go} />
      {summary.make.total > 0 && <MakeByMethod summary={summary} go={go} />}
      <Downloads kit={kit} summary={summary} go={go} />
      {health && <CatalogStrip kit={kit} now={now} />}
    </div>
  </div>;
}

/** Jump straight to a part by name, part number, or SKU, without opening the Parts list. */
function FindPart({ kit, open }: { kit: ControlKit; open: (key: string) => void }) {
  const [query, setQuery] = useState('');
  const found = findParts(kit.result!, query);
  return <div className="find-part" role="search">
    <label className="find-field"><Search aria-hidden size={15} /><span className="sr-only">Find a part</span>
      <input type="search" value={query} placeholder="Find a part by name, part number, or SKU" onChange={event => setQuery(event.target.value)}
        onKeyDown={event => { if (event.key === 'Enter' && found[0]) { open(found[0].bomLineKey); setQuery(''); } if (event.key === 'Escape') setQuery(''); }} /></label>
    {query.trim() && <ul className="find-results panel">{found.length ? found.map(line => <li key={line.bomLineKey}>
      <button type="button" onClick={() => { open(line.bomLineKey); setQuery(''); }}><span className="find-name">{line.name}</span><span className="num muted small">×{line.qty}</span><DispositionChip line={line} /></button>
    </li>) : <li className="muted small find-empty">No part matches “{query.trim()}”.</li>}</ul>}
  </div>;
}

/** What the last rescan changed, so a team iterating on the robot does not compare two BOMs by eye. */
function Changes({ kit }: { kit: ControlKit }) {
  const changes = scanChanges(kit.previous!, kit.result!);
  if (!hasChanges(changes)) return <p className="changes muted small"><History aria-hidden size={14} />No changes since your last scan.</p>;
  const items = [
    changes.added.length && `${parts(changes.added.length)} added`, changes.removed.length && `${parts(changes.removed.length)} removed`,
    changes.quantity && `${changes.quantity} quantity ${changes.quantity === 1 ? 'change' : 'changes'}`, changes.decided && `${parts(changes.decided)} decided`, changes.retyped && `${parts(changes.retyped)} now made or bought differently`,
    changes.newlyPriced && `${parts(changes.newlyPriced)} newly priced`, changes.stock && `${changes.stock} stock ${changes.stock === 1 ? 'change' : 'changes'}`,
    changes.subtotalDelta && `subtotal ${changes.subtotalDelta > 0 ? '+' : '−'}${money(Math.abs(changes.subtotalDelta))}`,
  ].filter(Boolean);
  const names = [...changes.added.slice(0, 3).map(line => `+ ${line.name}`), ...changes.removed.slice(0, 3).map(line => `− ${line.name}`)];
  return <section className="panel changes-card" aria-label="Since your last scan">
    <p className="changes"><History aria-hidden size={14} /><strong>Since your last scan:</strong> {items.join(' · ')}</p>
    {names.length > 0 && <p className="muted small changes-names">{names.join('   ')}</p>}
  </section>;
}

/** What the scan found, as one bar that adds up, then how ready the team is to order and to build. */
function StatusCard({ result, summary, ready }: { result: NonNullable<ControlKit['result']>; summary: Summary; ready: Readiness }) {
  const shares = composition(summary);
  return <section className="panel status" aria-labelledby="status-title">
    <div className="status-head">
      <h2 id="status-title"><span className="num">{summary.uniqueLines}</span> unique parts</h2>
      <p className="muted small"><span className="num">{summary.instances}</span> placed in the assembly{summary.suppressedInstances ? <>, <span className="num">{summary.suppressedInstances}</span> suppressed</> : null}</p>
    </div>
    <div className="share-bar" role="img" aria-label={shares.map(share => `${share.label} ${share.count}`).join(', ')}>
      {shares.map(share => <span key={share.key} className={`share ${share.key}`} style={{ flexGrow: share.count }} />)}
    </div>
    <ul className="share-legend">{shares.map(share => <li key={share.key} className={share.key}><span className="dot" aria-hidden />{share.label} <span className="num">{share.count}</span></li>)}</ul>
    <div className="meters">
      <Meter tone="buy" label="Ready to order" ready={ready.order.ready} total={ready.order.total}
        detail={!ready.order.total ? 'Nothing to buy yet' : ready.order.ready === ready.order.total ? 'Every part to buy is priced' : [ready.order.unmatched && `${ready.order.unmatched} unmatched`, ready.order.unpriced && `${ready.order.unpriced} unpriced`].filter(Boolean).join(' · ')} />
      <Meter tone="make" label="Decided for build" ready={ready.build.decided} total={ready.build.total}
        detail={!ready.build.total ? 'Nothing to make' : ready.build.decided === ready.build.total ? 'Every part to make is decided' : `${ready.build.total - ready.build.decided} still in review`} />
    </div>
    {result.stats.staleVendorData && !result.catalogHealth && <p className="muted small">Some vendor prices may be out of date.</p>}
  </section>;
}

function Meter({ tone, label, ready, total, detail }: { tone: 'buy' | 'make'; label: string; ready: number; total: number; detail: string }) {
  const value = percent(ready, total);
  const complete = total > 0 && ready === total;
  return <div className={`meter ${tone} ${complete ? 'complete' : ''}`}>
    <div className="meter-head"><span className="meter-label">{label}</span><span className="meter-figure num">{total ? `${ready} of ${total}` : '–'}</span></div>
    <div className="meter-track" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={total} aria-valuenow={ready} aria-valuetext={`${ready} of ${total}`}>
      <span className="meter-fill" style={{ width: `${value}%` }} />
    </div>
    <span className="meter-detail small">{complete && <Check aria-hidden size={12} strokeWidth={3} />}{detail}</span>
  </div>;
}

/** The single primary action, sticky at the bottom of the Onshape panel so it stays in reach while scrolling. */
function PrimaryBar({ kit, primary, summary, go }: { kit: ControlKit; primary: PrimaryAction; summary: Summary; go: (view: View) => void }) {
  const run = () => {
    if (primary.kind === 'review') return go('review');
    if (primary.kind !== 'build-pack') return go('buy');
    void kit.downloadExcel();
    if (summary.make.total) { go('make'); void kit.downloadStep(); }
  };
  const hint = primary.kind === 'build-pack'
    ? summary.make.total ? 'Excel BOM plus STEP files for every part to make.' : 'Excel BOM with live purchasing totals.'
    : primary.kind === 'review' ? 'Decide these first; they change what is bought and made.' : 'These keep the order from being complete.';
  return <div className="primary-bar">
    <Button className={primary.kind === 'review' ? 'btn-attention' : undefined} loading={primary.kind === 'build-pack' && (kit.excel === 'working' || Boolean(kit.step?.running))} onClick={run}>
      {primary.kind === 'build-pack' ? <FileSpreadsheet aria-hidden size={16} /> : null}{primary.label}{primary.kind !== 'build-pack' && <ArrowRight aria-hidden size={16} />}
    </Button>
    <span className="primary-hint muted small">{hint}</span>
  </div>;
}

/** Open problems, numbered in the order to tackle them; finished checks collapse into one green line. */
function Moves({ kit, moves, done }: { kit: ControlKit; moves: Move[]; done: string[] }) {
  const [all, setAll] = useState(false);
  const shown = all ? moves : moves.slice(0, 3);
  return <section className="panel" aria-labelledby="moves">
    <div className="panel-head"><div><h2 id="moves">{moves.length ? `Your next ${moves.length === 1 ? 'move' : `${Math.min(moves.length, 3)} moves`}` : 'Ready to order and build'}</h2>
      <p>{moves.length ? 'What still stands between this assembly and a complete order and build list.' : 'Every part is decided, matched, priced, and in stock. Download the build pack.'}</p></div></div>
    {moves.length > 0 && <ol className="moves">{shown.map((move, index) => <li key={move.key} className={`move ${move.tone} ${index === 0 ? 'lead' : ''}`}>
      <span className="move-index num" aria-hidden>{index + 1}</span>
      <div className="row-main">
        <span className="move-title"><span className="move-icon" aria-hidden>{move.icon}</span>{move.title}</span>
        <span className="muted small">{move.detail}</span>
        {index === 0 && move.lines && move.lines.length > 0 && <ul className="move-parts">{move.lines.map(line => <li key={line.bomLineKey}><PartThumb kit={kit} line={line} /><span className="move-part-name">{line.name}</span><span className="num muted small">×{line.qty}</span></li>)}</ul>}
      </div>
      {move.action ?? <span />}
    </li>)}</ol>}
    {moves.length > 3 && <div className="panel-body"><Button variant="ghost" size="sm" onClick={() => setAll(!all)}>{all ? 'Show fewer' : `Show ${moves.length - 3} more`}<ChevronDown aria-hidden size={14} className={all ? 'flip' : undefined} /></Button></div>}
    {done.length > 0 && <ul className="done-strip" aria-label="Done">{done.map(item => <li key={item}><Check aria-hidden size={13} strokeWidth={3} />{item}</li>)}</ul>}
  </section>;
}

/** A small Onshape picture of a part blocking the order. Pictures are cached per revision, so a rescan costs nothing. */
function PartThumb({ kit, line }: { kit: ControlKit; line: BomLine }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    let made: string | null = null;
    kit.partPicture(line, controller.signal).then(value => { made = value; setUrl(value); }).catch(() => undefined);
    return () => { controller.abort(); if (made) URL.revokeObjectURL(made); };
  }, [line.bomLineKey, kit.result?.scanId]);
  return <span className="mini-thumb" aria-hidden>{url && <img src={url} alt="" />}</span>;
}

/** The known subtotal with what it leaves out, and the lines that drive it. */
function MoneyCard({ kit, summary, ready, go }: { kit: ControlKit; summary: Summary; ready: Readiness; go: (view: View) => void }) {
  const result = kit.result!;
  const costs = topCosts(result);
  const complete = summary.buyLines > 0 && summary.pricedLines === summary.buyLines;
  const missing = summary.buyLines - summary.pricedLines;
  return <section className="panel" aria-labelledby="money">
    <div className="panel-head"><div><h2 id="money">{complete ? 'Purchasing total' : 'Known subtotal'}</h2>
      <p>List prices{result.vendorDataUpdatedAt ? ` as of ${day(result.vendorDataUpdatedAt)}` : ''}, before shipping and tax.</p></div>
      <Button variant="ghost" size="sm" onClick={() => go('buy')}>Buy list<ArrowRight aria-hidden size={14} /></Button></div>
    <div className="panel-body money">
      <div className="money-figure"><span className={`money-value num ${summary.subtotal === null ? 'none' : ''}`}>{summary.subtotal === null ? 'None priced' : money(summary.subtotal)}</span>
        {missing > 0 && <span className="money-missing small">+ {parts(missing)} not priced yet</span>}</div>
      {summary.buyLines > 0 && <>
        <div className="split-bar" role="img" aria-label={`${summary.pricedLines} of ${summary.buyLines} parts to buy priced`}>
          <span className="split priced" style={{ flexGrow: summary.pricedLines }} /><span className="split unpriced" style={{ flexGrow: missing }} />
        </div>
        <p className="muted small"><span className="num">{summary.pricedLines}</span> of <span className="num">{summary.buyLines}</span> parts to buy priced{ready.order.unmatched ? `, ${ready.order.unmatched} without a vendor match` : ''}.</p>
      </>}
      {costs.length > 0 && <div className="top-costs"><h3 className="small muted">Largest costs</h3>
        <ol>{costs.map(line => <li key={line.bomLineKey}><span className="top-cost-name">{line.name}</span><span className="muted small">{line.vendor ? vendorLabel[line.vendor.vendorId] : ''}</span><span className="num">{money(line.lineTotalUsd!)}</span></li>)}</ol></div>}
    </div>
  </section>;
}

/** Each vendor's share of the order, with stock problems called out in red. */
function BuyByVendor({ kit, go }: { kit: ControlKit; go: (view: View) => void }) {
  const { vendors, needsSku } = buyList(kit.result!);
  if (!vendors.length && !needsSku.length) return null;
  return <section className="panel" aria-labelledby="by-vendor">
    <div className="panel-head"><div><h2 id="by-vendor">Buy by vendor</h2><p>Matched parts grouped by where they are ordered.</p></div></div>
    <div className="rows">{vendors.map(group => {
      const out = group.lines.filter(line => line.vendor?.stock === 'out').length;
      return <button key={group.vendorId} type="button" className="row vendor-row" onClick={() => go('buy')}>
        <div className="row-main"><span className="row-title"><span className="dot buy" aria-hidden /><span>{group.label}</span></span>
          <span className="row-meta"><span>{parts(group.lines.length)}</span>{group.unpriced > 0 && <span>{group.unpriced} unpriced</span>}{out > 0 && <span className="blocked-text">{out} out of stock</span>}</span></div>
        <span className="num">{group.subtotal === null ? <span className="muted small">not priced</span> : money(group.subtotal)}</span>
      </button>;
    })}
      {needsSku.length > 0 && <button type="button" className="row vendor-row" onClick={() => go('buy')}>
        <div className="row-main"><span className="row-title"><span className="dot attention" aria-hidden /><span>No vendor yet</span></span><span className="row-meta"><span>{parts(needsSku.length)}</span></span></div>
        <span className="muted small">needs a SKU</span>
      </button>}
    </div>
  </section>;
}

function MakeByMethod({ summary, go }: { summary: Summary; go: (view: View) => void }) {
  const methods = (['print', 'cnc', 'cut-2d', 'fabricate'] as const).filter(key => summary.make[key]);
  const label = { print: '3D print', cnc: 'CNC', 'cut-2d': '2D cut', fabricate: 'Fabricate' };
  return <section className="panel" aria-labelledby="by-method">
    <div className="panel-head"><div><h2 id="by-method">Make by method</h2><p>Parts the team builds, with STEP files for printing and CAM.</p></div>
      <Button variant="ghost" size="sm" onClick={() => go('make')}><Wrench aria-hidden size={14} />Make list</Button></div>
    <div className="panel-body methods">{methods.map(key => <button key={key} type="button" className="method" onClick={() => go('make')}>
      <span className="method-count num">{summary.make[key]}</span><span className="method-label">{label[key]}</span></button>)}</div>
  </section>;
}

function Downloads({ kit, summary, go }: { kit: ControlKit; summary: Summary; go: (view: View) => void }) {
  return <section className="panel" aria-labelledby="downloads">
    <div className="panel-head"><div><h2 id="downloads">Downloads</h2><p>The Excel BOM has live purchasing totals. Unpriced lines stay blank, so the total never looks complete when it isn't.</p></div></div>
    <div className="panel-body inline-actions">
      <Button variant="secondary" loading={kit.excel === 'working'} onClick={() => void kit.downloadExcel()}><FileSpreadsheet aria-hidden size={15} /> Excel BOM</Button>
      <Button variant="ghost" onClick={() => void kit.downloadCsv()}>CSV</Button>
      {summary.make.total > 0 && <Button variant="ghost" onClick={() => go('make')}>STEP files</Button>}
    </div>
    {kit.excel === 'failed' && <div className="panel-body"><Alert tone="warning" title="The Excel file could not be built">Download the CSV instead; it has the same rows without formatting.</Alert></div>}
  </section>;
}

/** Catalog health as one line; it opens to each vendor. A loading or failing catalog is also a move above. */
function CatalogStrip({ kit, now }: { kit: ControlKit; now: number | null }) {
  const health = kit.result!.catalogHealth!;
  const states = health.vendors.map(catalogState);
  const tone = states.includes('failing') ? 'blocked' : states.some(state => state !== 'published') ? 'attention' : 'done';
  const summaryText = catalogsComplete(health)
    ? states.every(state => state === 'published') ? `All ${health.vendors.length} vendor catalogs ready` : `All ${health.vendors.length} catalogs complete, some out of date`
    : `${states.filter(state => state === 'published' || state === 'stale').length} of ${health.vendors.length} vendor catalogs ready`;
  return <details className="panel catalog-strip">
    <summary><span className={`dot ${tone}`} aria-hidden />{summaryText}<ChevronDown aria-hidden size={14} className="chevron" /></summary>
    <div className="panel-body vendors">{health.vendors.map(vendor => {
      const state = catalogState(vendor);
      return <span key={vendor.vendorId} className={`vendor ${state}`} title={vendor.error ?? undefined}>
        <span className="dot" aria-hidden />{vendorLabel[vendor.vendorId]}<span className="muted">{catalogStateText(vendor)}{vendor.recordCount ? `, ${vendor.recordCount} products` : ''}{now && vendor.updatedAt ? `, ${ago(vendor.updatedAt, now)}` : ''}</span>
      </span>;
    })}</div>
  </details>;
}
