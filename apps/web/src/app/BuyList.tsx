import { ExternalLink, FileSpreadsheet } from 'lucide-react';
import { Alert } from '../components/arc/alert/alert';
import { EmptyState } from '../components/arc/empty-state/empty-state';
import type { ControlKit } from './useControlKit';
import { buyList, catalogsComplete, fasteners, money, summarize, type View } from './model';
import { Button, LineCost } from './bits';

/**
 * What to order, by vendor. Only exact or confirmed matches sit under a vendor, and only priced lines count toward a
 * total; parts to buy without a match are listed below with what they still need.
 */
export function BuyList({ kit, open, go }: { kit: ControlKit; open: (key: string) => void; go: (view: View) => void }) {
  const result = kit.result!;
  const { vendors, needsSku } = buyList(result);
  const stock = fasteners(result);
  const summary = summarize(result);
  const complete = summary.buyLines > 0 && summary.pricedLines === summary.buyLines;

  return <>
    <div className="section-head">
      <div><h2>Buy list</h2><p>Quantities are pieces needed; packs to order round up to whole packs. A part is priced only when its vendor match, pack size, and price are all verified.</p></div>
      <div className="inline-actions">
        <Button variant="secondary" size="sm" loading={kit.excel === 'working'} onClick={() => void kit.downloadExcel()}><FileSpreadsheet aria-hidden size={14} /> Excel BOM</Button>
        <Button variant="ghost" size="sm" onClick={() => void kit.downloadCsv()}>CSV</Button>
      </div>
    </div>
    {kit.excel === 'failed' && <Alert tone="warning" title="The Excel file could not be built">Download the CSV instead; it has the same rows without formatting.</Alert>}
    <div className="tiles">
      <div className={`tile ${complete ? '' : 'incomplete'}`}><span className="tile-label">{complete ? 'Purchasing total' : 'Known subtotal'}</span>
        <span className="tile-value">{summary.subtotal === null ? 'None yet' : money(summary.subtotal)}</span>
        <span className="tile-context">{summary.pricedLines} of {summary.buyLines} parts priced{complete ? '' : ', so the real total is higher'}</span></div>
      <div className="tile"><span className="tile-label">Vendors</span><span className="tile-value">{vendors.length}</span><span className="tile-context">{vendors.map(vendor => vendor.label).join(', ') || 'none matched yet'}</span></div>
      <div className={`tile ${needsSku.length ? 'attention' : ''}`}><span className="tile-label">No vendor match</span><span className="tile-value">{needsSku.length}</span><span className="tile-context">parts to buy without a SKU match</span></div>
    </div>

    {!vendors.length && !needsSku.length && <section className="panel"><EmptyState title="Nothing to buy yet" description="Parts appear here once they are marked Buy, by a vendor SKU, a library part number, or your choice in Review." action={<Button size="sm" onClick={() => go('review')}>Review parts</Button>} /></section>}

    {vendors.map(group => <section key={group.vendorId} className="panel" aria-label={group.label}>
      <div className="panel-head"><div><h2>{group.label}</h2><p>{group.lines.length} part{group.lines.length === 1 ? '' : 's'}{group.unpriced ? `, ${group.unpriced} without a verified price or pack size` : ''}</p></div>
        {group.subtotal !== null && <span className="num">{money(group.subtotal)}</span>}</div>
      <div className="rows">{group.lines.map(line => {
        const vendor = line.vendor!;
        return <div key={line.bomLineKey} className="row">
          <div className="row-main">
            <button type="button" className="row-title link-button" onClick={() => open(line.bomLineKey)}><span>{line.name}</span></button>
            <span className="row-meta">
              <a className="link num" href={vendor.url} target="_blank" rel="noopener noreferrer">{vendor.sku} <ExternalLink aria-hidden size={11} /></a>
              <span><span className="num">{line.qty}</span> needed</span>
              {vendor.packSizeVerified && vendor.packSize ? <span>pack of {vendor.packSize}{line.packsToOrder !== null ? `, order ${line.packsToOrder}` : ''}</span> : <span>pack size unknown</span>}
              {line.order && line.order.lines > 1 && <span>covers {line.order.qty} {line.order.qty === 1 ? 'piece' : 'pieces'} on {line.order.lines} CAD lines</span>}
              {line.orderedWith && <span>ordered with {group.lines.find(other => other.bomLineKey === line.orderedWith)?.name ?? 'another line'}</span>}
              {vendor.priceUsd !== null && <span className="num">{money(vendor.priceUsd)} per pack</span>}
              {vendor.stock === 'out' && <span style={{ color: 'var(--ck-danger)' }}>out of stock</span>}
            </span>
          </div>
          <div className="row-aside"><LineCost line={line} /></div>
        </div>;
      })}</div>
    </section>)}

    {needsSku.length > 0 && <section className="panel" aria-labelledby="needs-sku">
      <div className="panel-head"><div><h2 id="needs-sku">No vendor match yet</h2><p>{catalogsComplete(result.catalogHealth) ? 'These parts are marked Buy but no catalog product matched. Add the vendor SKU to the part number in Onshape and rescan.' : 'Some vendor catalogs are still loading. Rescan later, or add the vendor SKU to the part number in Onshape.'}</p></div></div>
      <div className="rows">{needsSku.map(line => <button key={line.bomLineKey} type="button" className="row" onClick={() => open(line.bomLineKey)}>
        <span className="row-main"><span className="row-title"><span>{line.name}</span></span>
          <span className="row-meta"><span><span className="num">{line.qty}</span> needed</span>{line.partNumber ? <span className="num">{line.partNumber}</span> : <span>no part number</span>}{line.matchStatus === 'possible' && <span>possible match to confirm</span>}</span></span>
        <span className="row-aside muted small">Details</span>
      </button>)}</div>
    </section>}

    {stock.length > 0 && <section className="panel" aria-labelledby="fasteners">
      <div className="panel-head"><div><h2 id="fasteners">Fasteners</h2><p>Screws, nuts, washers, and clips usually come from your hardware stock, so they need no decision. Counts come from the CAD and can be low when fasteners were placed with Replicate or patterns.</p></div></div>
      <div className="rows">{stock.map(line => <button key={line.bomLineKey} type="button" className="row" onClick={() => open(line.bomLineKey)}>
        <span className="row-main"><span className="row-title"><span>{line.name}</span></span>
          <span className="row-meta"><span>about <span className="num">{line.qty}</span> in the CAD</span>{line.partNumber && <span className="num">{line.partNumber}</span>}</span></span>
        <span className="row-aside muted small">Details</span>
      </button>)}</div>
    </section>}
  </>;
}
