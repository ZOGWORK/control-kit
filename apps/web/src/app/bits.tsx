import type { ComponentProps } from 'react';
import { Button as ArcButton } from '../components/arc/button/button';
import type { BomLine } from '@control-kit/shared';
import { chipClass, chipLabel, money, shortLabel } from './model';

/** Disposition chip with its color dot: blue to buy, volt to make, orange to review. */
export function DispositionChip({ line }: { line: BomLine }) {
  return <span className={`chip ${chipClass(line)}`}>{line.suppressed ? chipLabel(line) : shortLabel[line.disposition]}</span>;
}

/** What a line costs, or why it has no price yet. A missing price never reads as $0. */
export function LineCost({ line }: { line: BomLine }) {
  if (line.lineTotalUsd !== null) return <span className="num">{money(line.lineTotalUsd)}</span>;
  if (!line.vendor || line.matchStatus !== 'exact' && line.matchStatus !== 'confirmed') return null;
  return <span className="muted small">{line.vendor.priceUsd === null ? 'no price' : !line.vendor.packSizeVerified ? 'pack size unknown' : 'not priced'}</span>;
}

/**
 * A licensed product picture (from a parts library or an official vendor feed) with its credit. Renders nothing until a
 * source has granted permission, so rows never show a scraped image or an empty box.
 */
export function Thumbnail({ line, size = 'row' }: { line: BomLine; size?: 'row' | 'large' }) {
  const image = line.thumbnail;
  if (!image) return null;
  return <figure className={`thumb ${size}`} title={`Image: ${image.attribution.credit} (${image.attribution.license})`}>
    <img src={image.url} alt="" loading="lazy" referrerPolicy="no-referrer" />
    {size === 'large' && <figcaption className="muted small">{image.attribution.url ? <a className="link" href={image.attribution.url} target="_blank" rel="noopener noreferrer">{image.attribution.credit}</a> : image.attribution.credit}, {image.attribution.license}</figcaption>}
  </figure>;
}

/** The facts under a part's name: quantity, its identifying number, and material. */
export function PartMeta({ line }: { line: BomLine }) {
  const id = line.vendor && (line.matchStatus === 'exact' || line.matchStatus === 'confirmed') ? line.vendor.sku : line.partNumber;
  return <span className="row-meta">
    <span><span className="num">{line.qty}</span> needed</span>
    {id && <span className="num">{id}</span>}
    {line.material && <span>{line.material}</span>}
  </span>;
}

/**
 * Arc's Button with the Control apps' volt primary. Arc paints primary from --foreground on --background, so the
 * wrapper re-points those two variables on primary buttons only; secondary and ghost keep Arc's neutral look.
 */
export function Button({ variant = 'primary', className, ...props }: ComponentProps<typeof ArcButton>) {
  return <ArcButton variant={variant} className={[variant === 'primary' ? 'btn-volt' : '', className].filter(Boolean).join(' ') || undefined} {...props} />;
}
