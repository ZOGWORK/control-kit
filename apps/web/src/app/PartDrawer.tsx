import { ExternalLink } from 'lucide-react';
import { dispositions, dispositionLabel, type BomLine } from '@control-kit/shared';
import { Alert } from '../components/arc/alert/alert';
import { Button } from './bits';
import { Drawer, DrawerContent, useDrawerItem } from '../components/arc/drawer/drawer';
import type { ControlKit } from './useControlKit';
import { money, vendorLabel } from './model';

const sourceLabel: Record<BomLine['dispositionSource'], string> = { manual: 'Set by you', 'exact-sku': 'Exact vendor SKU', 'explicit-metadata': 'From Onshape data', provenance: 'From where the part comes from', suggestion: 'Suggested', none: 'Not decided' };
const matchLabel: Record<BomLine['matchStatus'], string> = { exact: 'Exact SKU match', confirmed: 'Confirmed by you', possible: 'Possible match', rejected: 'Rejected by you', unmatched: 'No match' };

/** Configuration values a person set, without Onshape's encoded parameter ids or values left at Default. */
function configurationText(configuration: string | null) {
  if (!configuration || configuration === 'default') return null;
  const values = configuration.split(';').map(pair => pair.split('=')).filter(([, value]) => value && !/^default$/i.test(value))
    .map(([key, value]) => (/^List_[A-Za-z0-9]+$/.test(key) ? value : `${key.replace(/_/g, ' ')} ${value}`).replace(/_/g, ' '));
  return values.length ? values.join(', ') : null;
}
/** Where the part is used, summarized by top-level subassembly: "Right Pod ×22". */
function usedIn(line: BomLine): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const path of line.instancePaths) {
    const parts = path.split(' > ');
    const where = (parts.length > 2 ? parts[1] : 'Top level of the assembly').replace(/\s*<\d+>$/, '');
    counts.set(where, (counts.get(where) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

/** Everything about one part: how it is obtained and why, its vendor product, and its Onshape source. */
export function PartDrawer({ kit, line, onClose }: { kit: ControlKit; line: BomLine | null; onClose: () => void }) {
  // Keeps the last part on screen while the drawer closes.
  const shown = useDrawerItem(line);
  return <Drawer open={Boolean(line)} onOpenChange={open => { if (!open) onClose(); }}>
    {shown && <DrawerContent title={shown.name} description={`${shown.qty} needed${shown.suppressed ? ', suppressed' : ''}`}>
      <PartDetails kit={kit} line={shown} />
    </DrawerContent>}
  </Drawer>;
}

function PartDetails({ kit, line }: { kit: ControlKit; line: BomLine }) {
  const locked = Boolean(kit.pending) || !kit.result?.scanId || line.suppressed;
  const vendor = line.vendor;
  return <div className="stack">
    {line.metadataIssue && <Alert tone="warning" title={line.missingMetadataReason ?? 'Missing data'} />}

    <section className="stack" aria-labelledby="how">
      <div><h3 id="how">How the team gets it</h3><p className="muted small">{dispositionLabel[line.disposition]}. {sourceLabel[line.dispositionSource]}.</p></div>
      {line.reviewReason && <p className="small">{line.reviewReason}</p>}
      {line.dispositionEvidence.length > 0 && <ul className="evidence">{line.dispositionEvidence.map(item => <li key={item}>{item}</li>)}</ul>}
      {line.suppressed ? <p className="muted small">Suppressed parts are not bought or made. Unsuppress it in Onshape and rescan to include it.</p> : <>
        <div className="inline-actions" role="group" aria-label="Choose how this part is obtained">
          {dispositions.map(value => <Button key={value} size="sm" variant={line.disposition === value && line.manualClassification ? 'primary' : 'secondary'}
            aria-pressed={line.manualClassification === value} disabled={locked} onClick={() => void kit.setDisposition(line, value)}>{dispositionLabel[value].replace(' (laser/waterjet/router)', '')}</Button>)}
        </div>
        {line.manualClassification && <Button size="sm" variant="ghost" disabled={locked} onClick={() => void kit.setDisposition(line, null)}>Use the automatic choice</Button>}
        <p className="muted small">Choices are shared with everyone who scans this document and kept across rescans.</p>
      </>}
    </section>

    <section className="stack" aria-labelledby="vendor">
      <h3 id="vendor">Vendor</h3>
      {vendor ? <>
        <dl className="facts">
          <dt>Product</dt><dd><a className="link" href={vendor.url} target="_blank" rel="noopener noreferrer">{vendorLabel[vendor.vendorId]} {vendor.sku} <ExternalLink aria-hidden size={11} /></a><br /><span className="muted small">{vendor.name}</span></dd>
          <dt>Match</dt><dd>{matchLabel[line.matchStatus]}{line.matchReasons.length ? <span className="muted small"><br />{line.matchReasons.join('; ')}</span> : null}</dd>
          <dt>Pack</dt><dd>{vendor.packSizeVerified && vendor.packSize ? `${vendor.packSize} per pack (${vendor.packEvidence ?? 'from the product page'})` : 'Unknown, so no total'}</dd>
          <dt>Price</dt><dd>{vendor.priceUsd === null ? 'Unknown' : `${money(vendor.priceUsd)} per pack`}{line.packsToOrder !== null && line.lineTotalUsd !== null ? `; ${line.packsToOrder} pack${line.packsToOrder === 1 ? '' : 's'} = ${money(line.lineTotalUsd)}` : ''}</dd>
          <dt>Stock</dt><dd>{vendor.stock === 'unknown' ? 'Unknown' : vendor.stock === 'in' ? 'In stock' : vendor.stock === 'low' ? 'Low stock' : 'Out of stock'}<span className="muted small"> as of {new Date(vendor.updatedAt).toLocaleDateString()}</span></dd>
        </dl>
        {line.matchStatus === 'possible' && <div className="inline-actions">
          <Button size="sm" disabled={locked} onClick={() => void kit.decide(line, 'confirmed')}>Confirm this product</Button>
          <Button size="sm" variant="ghost" disabled={locked} onClick={() => void kit.decide(line, 'rejected')}>Not this product</Button>
        </div>}
      </> : <p className="muted small">{line.matchStatus === 'rejected' ? 'You rejected the suggested product.' : 'No vendor product matched. A part number holding the vendor SKU gives an exact match after the next rescan.'}</p>}
    </section>

    <section className="stack" aria-labelledby="onshape">
      <h3 id="onshape">In Onshape</h3>
      <dl className="facts">
        <dt>Part number</dt><dd className="num">{line.partNumber ?? 'None'}</dd>
        {line.description && <><dt>Description</dt><dd>{line.description}</dd></>}
        {line.bomProperties?.vendor && <><dt>Vendor field</dt><dd>{line.bomProperties.vendor}</dd></>}
        {line.material && <><dt>Material</dt><dd>{line.material}</dd></>}
        {configurationText(line.configuration) && <><dt>Configuration</dt><dd className="small">{configurationText(line.configuration)}</dd></>}
        <dt>Used in</dt><dd className="small">{usedIn(line).map(([where, count]) => <div key={where}>{where}{count > 1 && <span className="muted"> ×{count}</span>}</div>)}</dd>
      </dl>
      <a className="link small" href={line.partStudioUrl} target="_blank" rel="noopener noreferrer">Open in Onshape <ExternalLink aria-hidden size={11} /></a>
    </section>
  </div>;
}
