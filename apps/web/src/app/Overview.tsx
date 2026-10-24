import type { ReactNode } from 'react';
import { AlertTriangle, CheckCircle2, FileSpreadsheet, ListChecks, Store, Tag, Wrench } from 'lucide-react';
import { metadataIssueText } from '@control-kit/shared';
import { Alert } from '../components/arc/alert/alert';
import { Button } from './bits';
import type { ControlKit } from './useControlKit';
import { ago, buyList, catalogsReady, catalogState, catalogStateLabel, money, vendorLabel, type Summary, type View } from './model';

type Step = { key: string; icon: ReactNode; tone: 'attention' | 'warning' | 'done' | ''; title: string; detail: string; action?: ReactNode };

export function Overview({ kit, summary, go, now }: { kit: ControlKit; summary: Summary; go: (view: View) => void; now: number | null }) {
  const result = kit.result!;
  const needsSku = buyList(result).needsSku.length;
  const health = result.catalogHealth;
  const notReady = health?.vendors.filter(vendor => catalogState(vendor) !== 'published') ?? [];
  const topIssue = Object.entries(result.missingMetadata.filter(line => !line.suppressed && line.metadataIssue)
    .reduce<Record<string, number>>((counts, line) => ({ ...counts, [line.metadataIssue!.code]: (counts[line.metadataIssue!.code] ?? 0) + 1 }), {}))
    .sort((a, b) => b[1] - a[1])[0];
  const makeParts = (['print', 'cnc', 'cut-2d', 'fabricate'] as const).filter(key => summary.make[key]).map(key => `${{ print: '3D print', cnc: 'CNC', 'cut-2d': '2D cut', fabricate: 'fabricate' }[key]} ${summary.make[key]}`);

  const steps: Step[] = [];
  if (summary.review) steps.push({ key: 'review', icon: <ListChecks aria-hidden />, tone: 'attention', title: `${summary.review} parts need a decision`,
    detail: summary.possibleMatches ? `${summary.possibleMatches} have a possible vendor match to confirm. The rest need you to choose how they're made.` : "Choose whether each part is bought, printed, or fabricated. Control Kit suggests one where it can.",
    action: <Button size="sm" onClick={() => go('review')}>Review parts</Button> });
  if (notReady.length) steps.push({ key: 'catalog', icon: <Store aria-hidden />, tone: 'warning', title: notReady.length === health!.vendors.length ? 'Vendor catalogs are still loading' : 'Some vendor catalogs are still loading',
    detail: `${notReady.map(vendor => `${vendorLabel[vendor.vendorId]} (${catalogStateLabel[catalogState(vendor)].toLowerCase()})`).join(', ')}. Parts from these vendors can't be matched or priced yet; rescan later to pick them up.` });
  if (needsSku) steps.push({ key: 'sku', icon: <Tag aria-hidden />, tone: 'warning', title: `${needsSku} parts to buy have no vendor match`,
    detail: 'Add the vendor SKU to the part number in Onshape, or confirm a match once catalogs finish loading.', action: <Button variant="secondary" size="sm" onClick={() => go('buy')}>Open buy list</Button> });
  if (summary.dataIssues && topIssue) steps.push({ key: 'issues', icon: <AlertTriangle aria-hidden />, tone: 'warning', title: `${summary.dataIssues} parts are missing data`,
    detail: `Most often: ${metadataIssueText[topIssue[0] as keyof typeof metadataIssueText].toLowerCase()} (${topIssue[1]}).`, action: <Button variant="secondary" size="sm" onClick={() => go('parts')}>See parts</Button> });
  if (summary.make.total) steps.push({ key: 'make', icon: <Wrench aria-hidden />, tone: '', title: `${summary.make.total} parts to make`,
    detail: `${makeParts.join(', ')}. Download STEP files for printing and CAM.`, action: <Button variant="secondary" size="sm" onClick={() => go('make')}>Open make list</Button> });
  if (!steps.length) steps.push({ key: 'done', icon: <CheckCircle2 aria-hidden />, tone: 'done', title: 'Nothing needs attention', detail: 'Every part has a decision and every vendor catalog is ready.' });

  const subtotalComplete = summary.buyLines > 0 && summary.pricedLines === summary.buyLines;
  return <>
    <div className="tiles">
      <Tile label="Parts" value={summary.uniqueLines} context={`${summary.instances} in the assembly${summary.suppressedInstances ? `, ${summary.suppressedInstances} suppressed` : ''}`} onClick={() => go('parts')} />
      <Tile label="Buy" value={summary.buy} context="from vendors" onClick={() => go('buy')} />
      <Tile label="Make" value={summary.make.total} context={makeParts.join(', ') || 'nothing yet'} onClick={() => go('make')} />
      <Tile label="Needs review" value={summary.review} context={summary.review ? 'decisions to make' : 'all decided'} attention={summary.review > 0} onClick={() => go('review')} />
      <Tile label={subtotalComplete ? 'Purchasing total' : 'Known subtotal'} value={summary.subtotal === null ? 'None yet' : money(summary.subtotal)} incomplete={!subtotalComplete}
        context={summary.buyLines ? `${summary.pricedLines} of ${summary.buyLines} parts to buy are priced` : 'no parts to buy yet'} onClick={() => go('buy')} />
    </div>

    <section className="panel" aria-labelledby="next-steps">
      <div className="panel-head"><div><h2 id="next-steps">Next steps</h2><p>What still stands between this assembly and a complete order and build list.</p></div></div>
      <div className="rows">{steps.map(step => <div key={step.key} className="step">
        <span className={`step-icon ${step.tone}`}>{step.icon}</span>
        <div className="row-main"><span className="row-title"><span>{step.title}</span></span><span className="muted small">{step.detail}</span></div>
        {step.action ?? <span />}
      </div>)}</div>
    </section>

    <section className="panel" aria-labelledby="downloads">
      <div className="panel-head"><div><h2 id="downloads">Downloads</h2><p>The Excel BOM has a purchasing sheet with live totals. Unpriced lines stay blank so the total never looks complete when it isn't.</p></div></div>
      <div className="panel-body inline-actions">
        <Button variant="secondary" loading={kit.excel === 'working'} onClick={() => void kit.downloadExcel()}><FileSpreadsheet aria-hidden size={15} /> Excel BOM</Button>
        <Button variant="ghost" onClick={() => void kit.downloadCsv()}>CSV</Button>
        {summary.make.total > 0 && <Button variant="ghost" onClick={() => go('make')}>STEP files</Button>}
      </div>
      {kit.excel === 'failed' && <div className="panel-body"><Alert tone="warning" title="The Excel file could not be built">Download the CSV instead; it has the same rows without formatting.</Alert></div>}
    </section>

    {health && <section className="panel" aria-labelledby="catalogs">
      <div className="panel-head"><div><h2 id="catalogs">Vendor catalogs</h2><p>{catalogsReady(health) ? 'All five catalogs are ready, so an empty vendor means the part was not found.' : 'Until a catalog is ready, a part with no vendor may still be sold there.'}</p></div></div>
      <div className="panel-body vendors">{health.vendors.map(vendor => {
        const state = catalogState(vendor);
        return <span key={vendor.vendorId} className={`vendor ${state}`} title={vendor.error ?? undefined}>
          <span className="dot" aria-hidden />{vendorLabel[vendor.vendorId]}<span className="muted">{catalogStateLabel[state]}{vendor.recordCount ? `, ${vendor.recordCount} products` : ''}{now && vendor.updatedAt ? `, ${ago(vendor.updatedAt, now)}` : ''}</span>
        </span>;
      })}</div>
    </section>}
  </>;
}

function Tile({ label, value, context, attention, incomplete, onClick }: { label: string; value: number | string; context: string; attention?: boolean; incomplete?: boolean; onClick: () => void }) {
  return <button type="button" className={`tile ${attention ? 'attention' : ''} ${incomplete ? 'incomplete' : ''}`} onClick={onClick}>
    <span className="tile-label">{label}</span><span className="tile-value">{value}</span><span className="tile-context">{context}</span>
  </button>;
}
