import { ExternalLink, FileSpreadsheet, ShoppingCart } from 'lucide-react';
import { Alert } from '../components/arc/alert/alert';
import { EmptyState } from '../components/arc/empty-state/empty-state';
import type { ControlKit } from './useControlKit';
import type { BomLine } from '@control-kit/shared';
import { buyList, catalogsComplete, needsProduct, fasteners, feedDates, money, priceDate, summarize, type View } from './model';
import { Button, LineCost, SectionHead, StockNote } from './bits';
import type { Open, ReviewFilter } from './App';

/**
 * What to order, by vendor. Only exact or confirmed matches sit under a vendor, and only priced lines count toward a
 * total; parts to buy without a match are listed below with what they still need.
 */
export function BuyList({ kit, open, go, goReview }: { kit: ControlKit; open: Open; go: (view: View) => void; goReview: (filter: ReviewFilter) => void }) {
  const result = kit.result!;
  const { vendors, needsSku } = buyList(result);
  const stock = fasteners(result);
  const summary = summarize(result);
  const complete = summary.buyLines > 0 && summary.pricedLines === summary.buyLines;
  const outOfStock = vendors.flatMap(group => group.lines).filter(line => line.vendor?.stock === 'out').length;
  // The drawer steps through the group it was opened from while its parts are still in that group.
  const inGroup = (lines: BomLine[], listed: (line: BomLine) => boolean) => (key: string) => open(key, { keys: lines.map(line => line.bomLineKey), listed });

  return <>
    <SectionHead icon={<ShoppingCart />} tone="buy" title="Buy list" actions={<>
      <Button variant="secondary" size="sm" loading={kit.excel === 'working'} onClick={() => void kit.downloadExcel()}><FileSpreadsheet aria-hidden size={14} /> Excel BOM</Button>
      <Button variant="ghost" size="sm" onClick={() => void kit.downloadCsv()}>CSV</Button>
    </>}>What to order, by vendor. Quantities are pieces needed; packs round up. A part is priced only when its match, pack size, and price are all verified.</SectionHead>
    {kit.excel === 'failed' && <Alert tone="warning" title="The Excel file could not be built">Download the CSV instead; it has the same rows without formatting.</Alert>}
    {summary.buyLines > 0 && <section className="panel buy-summary" aria-label="Order summary">
      <div className="money-figure"><span className={`money-value num ${summary.subtotal === null ? 'none' : ''}`}>{summary.subtotal === null ? 'None priced' : money(summary.subtotal)}</span>
        <span className="small muted">{complete ? 'purchasing total' : 'known subtotal'}, list prices before shipping and tax{feedDates(vendors.flatMap(group => group.lines)).map(note => `; ${note}`).join('')}</span></div>
      <div className="split-bar" role="img" aria-label={`${summary.pricedLines} of ${summary.buyLines} parts priced`}>
        <span className="split priced" style={{ flexGrow: summary.pricedLines }} /><span className="split unpriced" style={{ flexGrow: summary.buyLines - summary.pricedLines }} /></div>
      <ul className="figures-row">
        <li><span className="num">{summary.pricedLines} of {summary.buyLines}</span> priced</li>
        <li><span className="num">{vendors.length}</span> {vendors.length === 1 ? 'vendor' : 'vendors'}</li>
        {needsSku.length > 0 && <li className="attention-text"><span className="num">{needsSku.length}</span> without a match</li>}
        {outOfStock > 0 && <li className="blocked-text"><span className="num">{outOfStock}</span> out of stock</li>}
      </ul>
    </section>}

    {!vendors.length && !needsSku.length && <section className="panel"><EmptyState title="Nothing to buy yet" description="Parts appear here once they are marked Buy, by a vendor SKU, a library part number, or your choice in Review." action={<Button size="sm" onClick={() => go('review')}>Review parts</Button>} /></section>}

    {vendors.map(group => <section key={group.vendorId} className="panel tone-buy" aria-label={group.label}>
      <div className="panel-head"><div><h2><span className="dot buy" aria-hidden /> {group.label}</h2><p>{group.lines.length} part{group.lines.length === 1 ? '' : 's'}{group.unpriced ? `, ${group.unpriced} without a verified price or pack size` : ''}</p></div>
        {group.subtotal !== null && <span className="num group-total">{money(group.subtotal)}</span>}</div>
      <div className="rows">{group.lines.map(line => {
        const vendor = line.vendor!;
        return <div key={line.bomLineKey} className="row">
          <div className="row-main">
            <button type="button" className="row-title link-button" onClick={() => inGroup(group.lines, item => item.disposition === 'buy' && !needsProduct(item))(line.bomLineKey)}><span>{line.name}</span></button>
            <span className="row-meta">
              <a className="link num" href={vendor.url} target="_blank" rel="noopener noreferrer">{vendor.sku} <ExternalLink aria-hidden size={11} /></a>
              <span><span className="num">{line.qty}</span> needed</span>
              {vendor.packSizeVerified && vendor.packSize ? <span>pack of {vendor.packSize}{line.packsToOrder !== null ? `, order ${line.packsToOrder}` : ''}</span> : <span>pack size unknown</span>}
              {line.order && line.order.lines > 1 && <span>covers {line.order.qty} {line.order.qty === 1 ? 'piece' : 'pieces'} on {line.order.lines} CAD lines</span>}
              {line.orderedWith && <span>ordered with {group.lines.find(other => other.bomLineKey === line.orderedWith)?.name ?? 'another line'}</span>}
              {line.priceCheck && <span className="warn">{line.priceCheck}</span>}
              {vendor.priceUsd !== null && <span className="num">{money(vendor.priceUsd)} per pack</span>}
              <StockNote stock={vendor.stock} />
              <span className="muted">{priceDate(vendor)}</span>
            </span>
          </div>
          <div className="row-aside"><LineCost line={line} /></div>
        </div>;
      })}</div>
    </section>)}

    {needsSku.length > 0 && <section className="panel tone-attention" aria-labelledby="needs-sku">
      <div className="panel-head"><div><h2 id="needs-sku"><span className="dot attention" aria-hidden /> No vendor match yet</h2><p>{catalogsComplete(result.catalogHealth) ? 'These parts are marked Buy but no catalog product matched, so they are also in Review. Pick a product there, or add the vendor SKU to the part number in Onshape and rescan.' : 'Some vendor catalogs are still loading. These parts are also in Review; rescan later, or add the vendor SKU to the part number in Onshape.'}</p></div>
        <Button size="sm" variant="secondary" onClick={() => goReview('product')}>Resolve in Review</Button></div>
      <div className="rows">{needsSku.map(line => <button key={line.bomLineKey} type="button" className="row" onClick={() => inGroup(needsSku, needsProduct)(line.bomLineKey)}>
        <span className="row-main"><span className="row-title"><span>{line.name}</span></span>
          <span className="row-meta"><span><span className="num">{line.qty}</span> needed</span>{line.partNumber ? <span className="num">{line.partNumber}</span> : <span>no part number</span>}{line.matchStatus === 'possible' && <span>possible match to confirm</span>}</span></span>
        <span className="row-aside muted small">Details</span>
      </button>)}</div>
    </section>}

    {stock.length > 0 && <section className="panel" aria-labelledby="fasteners">
      <div className="panel-head"><div><h2 id="fasteners">Fasteners</h2><p>Screws, nuts, washers, and clips usually come from your hardware stock, so they need no decision. Counts are every placement in the CAD, including copies placed by patterns and Replicate; fasteners that were never modelled are not counted.</p></div></div>
      <div className="rows">{stock.map(line => <button key={line.bomLineKey} type="button" className="row" onClick={() => inGroup(stock, item => item.disposition === 'hardware')(line.bomLineKey)}>
        <span className="row-main"><span className="row-title"><span>{line.name}</span></span>
          <span className="row-meta"><span><span className="num">{line.qty}</span> in the CAD</span>{line.partNumber && <span className="num">{line.partNumber}</span>}</span></span>
        <span className="row-aside muted small">Details</span>
      </button>)}</div>
    </section>}
  </>;
}
