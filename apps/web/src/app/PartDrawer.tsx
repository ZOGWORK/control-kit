import { useEffect, useState } from 'react';
import { ExternalLink } from 'lucide-react';
import { dispositions, dispositionLabel, type BomLine } from '@control-kit/shared';
import { Alert } from '../components/arc/alert/alert';
import { Button, Thumbnail } from './bits';
import { Drawer, DrawerContent, useDrawerItem } from '../components/arc/drawer/drawer';
import type { ControlKit } from './useControlKit';
import { money, vendorLabel, vendorLookup } from './model';

const sourceLabel: Record<BomLine['dispositionSource'], string> = { manual: 'Chosen by your team', 'exact-sku': 'Exact vendor SKU', 'explicit-metadata': 'From Onshape data', provenance: 'From where the part comes from', suggestion: 'Suggested', none: 'Not decided' };
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

/** Onshape's rendering of the part, so a name like "encoder cap" has a face. Costs one Onshape request the first time. */
function PartPicture({ kit, line }: { kit: ControlKit; line: BomLine }) {
  const [state, setState] = useState<{ url: string | null; error: string | null }>({ url: null, error: null });
  useEffect(() => {
    const controller = new AbortController();
    let url: string | null = null;
    setState({ url: null, error: null });
    kit.partPicture(line, controller.signal).then(value => { url = value; setState({ url: value, error: null }); })
      .catch(error => { if (!controller.signal.aborted) setState({ url: null, error: error instanceof Error ? error.message : 'No picture' }); });
    return () => { controller.abort(); if (url) URL.revokeObjectURL(url); };
    // A rescan can keep the same line key, so the picture follows the scan shown, not just the part.
  }, [line.bomLineKey, kit.result?.scanId]);
  return <figure className="part-picture" aria-busy={!state.url && !state.error}>
    {state.url ? <img src={state.url} alt={`${line.name}, as modelled in Onshape`} /> : <span className="muted small">{state.error ?? 'Drawing the part…'}</span>}
  </figure>;
}

/** Everything about one part: how it is obtained and why, its vendor product, and its Onshape source. */
export function PartDrawer({ kit, line, onClose }: { kit: ControlKit; line: BomLine | null; onClose: () => void }) {
  // Keeps the last part on screen while the drawer closes.
  const shown = useDrawerItem(line);
  return <Drawer open={Boolean(line)} onOpenChange={open => { if (!open) onClose(); }}>
    {shown && <DrawerContent title={shown.name} description={`${shown.qty} needed${shown.suppressed ? ', suppressed' : ''}`}>
      {/* The page's own error banner is behind the drawer, so a failed save is shown here too. */}
      {kit.error && <Alert tone="danger" title={kit.error} onDismiss={kit.clearError} />}
      <PartDetails kit={kit} line={shown} />
    </DrawerContent>}
  </Drawer>;
}

function PartDetails({ kit, line }: { kit: ControlKit; line: BomLine }) {
  const saving = kit.saving.has(line.bomLineKey);
  const locked = Boolean(kit.pending) || saving || !kit.result?.scanId || line.suppressed;
  const vendor = line.vendor;
  return <div className="stack">
    <PartPicture kit={kit} line={line} />
    {line.metadataIssue && <Alert tone="warning" title={line.missingMetadataReason ?? 'Missing data'} />}
    {line.purchasedAssembly && <p className="small">Listed as one product because {line.purchasedAssembly.reason}. Its {line.purchasedAssembly.parts} internal part{line.purchasedAssembly.parts === 1 ? '' : 's'} (gearbox, bearings, screws inside it) are not listed separately.{line.purchasedAssembly.includes?.length ? ` It also includes ${line.purchasedAssembly.includes.join(', ')}, placed beside it from the same imported Part Studio.` : ''}</p>}

    <section className="stack" aria-labelledby="how">
      <div><h3 id="how">How the team gets it</h3><p className="muted small">{dispositionLabel[line.disposition]}. {sourceLabel[line.dispositionSource]}.{saving && ' Saving…'}</p></div>
      {line.reviewReason && <p className="small">{line.reviewReason}</p>}
      {line.dispositionEvidence.length > 0 && <ul className="evidence">{line.dispositionEvidence.map(item => <li key={item}>{item}</li>)}</ul>}
      {line.disposition === 'ignore' && <p className="muted small">Marked not needed: it is listed but not bought, made, or reviewed. Choose another option to bring it back.</p>}
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
        <Thumbnail line={line} size="large" />
        <dl className="facts">
          <dt>Product</dt><dd><a className="link" href={vendor.url} target="_blank" rel="noopener noreferrer">{vendorLabel[vendor.vendorId]} {vendor.sku} <ExternalLink aria-hidden size={11} /></a><br /><span className="muted small">{vendor.name}</span></dd>
          <dt>Match</dt><dd>{matchLabel[line.matchStatus]}{line.libraryMatch && <span className="muted small"> (part mapping from {line.libraryMatch.attribution.credit})</span>}{line.matchReasons.length ? <span className="muted small"><br />{line.matchReasons.join('; ')}</span> : null}</dd>
          <dt>Pack</dt><dd>{vendor.packSizeVerified && vendor.packSize ? `${vendor.packSize} per pack (${vendor.packEvidence ?? 'from the product page'})` : 'Unknown, so no total'}</dd>
          <dt>Price</dt><dd>{vendor.priceUsd === null ? 'Unknown' : `${money(vendor.priceUsd)} per pack (public list price)`}{line.packsToOrder !== null && line.lineTotalUsd !== null ? `; ${line.packsToOrder} pack${line.packsToOrder === 1 ? '' : 's'} = ${money(line.lineTotalUsd)}` : ''}</dd>
          <dt>Stock</dt><dd>{vendor.stock === 'unknown' ? 'Unknown' : vendor.stock === 'in' ? 'In stock' : vendor.stock === 'low' ? 'Low stock' : 'Out of stock'}<span className="muted small"> as of {new Date(vendor.updatedAt).toLocaleDateString()}</span></dd>
        </dl>
        {(line.choices?.length ?? 0) > 1 && ['possible', 'confirmed'].includes(line.matchStatus) && <div className="stack">
          <p className="small">Which product is it?</p>
          {line.choices!.map(choice => {
            const chosen = line.matchStatus === 'confirmed' && choice.vendorId === vendor.vendorId && choice.normalizedSku === vendor.normalizedSku;
            return <div key={`${choice.vendorId}:${choice.normalizedSku}`} className="inline-actions">
              <Button size="sm" variant={chosen ? 'primary' : 'secondary'} aria-pressed={chosen} disabled={locked || chosen} onClick={() => void kit.decide(line, 'confirmed', choice)}>{chosen ? 'Chosen' : 'Use this'}</Button>
              <a className="link small" href={choice.url} target="_blank" rel="noopener noreferrer">{vendorLabel[choice.vendorId]} {choice.sku} <ExternalLink aria-hidden size={11} /></a>
              <span className="muted small">{choice.name}{choice.priceUsd !== null ? `, ${money(choice.priceUsd)}` : ''}</span>
            </div>;
          })}
        </div>}
        {line.matchStatus === 'possible' && <div className="inline-actions">
          <Button size="sm" disabled={locked} onClick={() => void kit.decide(line, 'confirmed')}>Confirm this product</Button>
          <Button size="sm" variant="ghost" disabled={locked} onClick={() => void kit.decide(line, 'rejected')}>Not this product</Button>
        </div>}
      </> : <>
        <p className="muted small">{line.matchStatus === 'rejected' ? 'You rejected the suggested product.' : 'No vendor product matched. A part number holding the vendor SKU gives an exact match after the next rescan.'}</p>
        {vendorLookup(line) && <a className="link small" href={vendorLookup(line)!.url} target="_blank" rel="noopener noreferrer">Look up {vendorLookup(line)!.sku} on {vendorLookup(line)!.vendor} <ExternalLink aria-hidden size={11} /></a>}
      </>}
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
      <div><Button size="sm" variant="secondary" onClick={() => kit.showInOnshape(line)}>{line.documentId === kit.result?.documentId ? 'Show its tab in Onshape' : <>Open its document in Onshape <ExternalLink aria-hidden size={12} /></>}</Button></div>
      <p className="muted small">{line.documentId === kit.result?.documentId ? 'Switches this document to the tab the part is modelled in.' : 'This part is linked from another document, which opens in a new browser tab.'}</p>
    </section>
  </div>;
}
