import { dispositionLabel, type BomLine, type CatalogHealth, type Disposition, type ScanResult, type VendorHealth, type VendorId } from '@control-kit/shared';

/** The app's sections, in the order a team works through them. */
export type View = 'overview' | 'review' | 'parts' | 'buy' | 'make';
export const makeDispositions: Disposition[] = ['print', 'cnc', 'cut-2d', 'fabricate'];
export const isMake = (line: BomLine) => makeDispositions.includes(line.disposition);
export const vendorLabel: Record<VendorId, string> = { gobilda: 'goBILDA', servocity: 'ServoCity', andymark: 'AndyMark', rev: 'REV', pitsco: 'Pitsco' };
export const chipClass = (line: BomLine) => line.suppressed || line.disposition === 'ignore' ? 'suppressed' : line.disposition === 'buy' ? 'buy' : line.disposition === 'review' ? 'review' : 'make';
export const chipLabel = (line: BomLine) => line.suppressed ? 'Suppressed' : dispositionLabel[line.disposition];
/** Short label for narrow chips: "2D cut" instead of the full "2D cut (laser/waterjet/router)". */
export const shortLabel: Record<Disposition, string> = { buy: 'Buy', print: '3D print', cnc: 'CNC', 'cut-2d': '2D cut', fabricate: 'Fabricate', hardware: 'Fastener', ignore: 'Not needed', review: 'Needs review' };
export const money = (value: number) => `$${value.toFixed(2)}`;

/** A line can be paid for only with a confirmed or exact match, a verified pack size, and a price. */
export const priced = (line: BomLine) => line.lineTotalUsd !== null;
/** Priced, or ordered under another line that carries the price for the same SKU. */
export const covered = (line: BomLine) => priced(line) || Boolean(line.orderedWith);

export type Summary = {
  uniqueLines: number; instances: number; suppressedInstances: number;
  buy: number; make: Record<'print' | 'cnc' | 'cut-2d' | 'fabricate', number> & { total: number }; review: number;
  /** Known subtotal over priced Buy lines only; `pricedLines` of `buyLines` carry a price. */
  subtotal: number | null; pricedLines: number; buyLines: number;
  dataIssues: number; possibleMatches: number;
};
export function summarize(result: ScanResult): Summary {
  const lines = result.lines;
  const buy = lines.filter(line => line.disposition === 'buy');
  const pricedBuy = buy.filter(priced);
  const coveredBuy = buy.filter(covered);
  const count = (disposition: Disposition) => lines.filter(line => line.disposition === disposition).length;
  const make = { print: count('print'), cnc: count('cnc'), 'cut-2d': count('cut-2d'), fabricate: count('fabricate'), total: 0 };
  make.total = make.print + make.cnc + make['cut-2d'] + make.fabricate;
  return {
    uniqueLines: lines.length, instances: result.stats.totalInstances, suppressedInstances: result.suppressed.reduce((sum, line) => sum + line.qty, 0),
    buy: buy.length, make, review: count('review'),
    subtotal: pricedBuy.length ? Math.round(pricedBuy.reduce((sum, line) => sum + line.lineTotalUsd!, 0) * 100) / 100 : null,
    pricedLines: coveredBuy.length, buyLines: buy.length,
    dataIssues: result.missingMetadata.filter(line => !line.suppressed).length,
    // Only matches still waiting in Review: a bought part whose product is still to confirm is on the Buy list.
    possibleMatches: lines.filter(line => line.matchStatus === 'possible' && line.disposition === 'review').length,
  };
}

/** Why a line is in the review queue, which decides the actions it offers. */
export type QueueKind = 'match' | 'suggested' | 'undecided';
export type QueueItem = { line: BomLine; kind: QueueKind };
/** Possible vendor matches first (one click settles both identity and Buy), then suggestions, then open questions. */
export function reviewQueue(result: ScanResult): QueueItem[] {
  const items = result.lines.filter(line => line.disposition === 'review').map((line): QueueItem => ({
    line, kind: line.matchStatus === 'possible' && line.vendor ? 'match' : line.suggestedDisposition ? 'suggested' : 'undecided',
  }));
  const order: Record<QueueKind, number> = { match: 0, suggested: 1, undecided: 2 };
  return items.sort((a, b) => order[a.kind] - order[b.kind] || b.line.qty - a.line.qty || a.line.name.localeCompare(b.line.name));
}

export type VendorGroup = { vendorId: VendorId; label: string; lines: BomLine[]; subtotal: number | null; unpriced: number };
/**
 * The Buy list: lines a team can order, grouped by vendor. Only exact or confirmed matches appear under a vendor;
 * Buy lines without one are listed separately, since they need a SKU before they can be ordered.
 */
/** Fasteners taken from stock: listed with their CAD counts, never priced unless an exact SKU makes them Buy. */
export const fasteners = (result: ScanResult) => result.lines.filter(line => line.disposition === 'hardware').sort((a, b) => a.name.localeCompare(b.name));

export function buyList(result: ScanResult) {
  const buy = result.lines.filter(line => line.disposition === 'buy');
  const matched = buy.filter(line => line.vendor && (line.matchStatus === 'exact' || line.matchStatus === 'confirmed'));
  const groups = new Map<VendorId, BomLine[]>();
  for (const line of matched) groups.set(line.vendor!.vendorId, [...(groups.get(line.vendor!.vendorId) ?? []), line]);
  const vendors: VendorGroup[] = [...groups.entries()].map(([vendorId, lines]) => {
    const withPrice = lines.filter(priced);
    return { vendorId, label: vendorLabel[vendorId], lines: lines.sort((a, b) => a.name.localeCompare(b.name)),
      subtotal: withPrice.length ? Math.round(withPrice.reduce((sum, line) => sum + line.lineTotalUsd!, 0) * 100) / 100 : null, unpriced: lines.filter(line => !covered(line)).length };
  }).sort((a, b) => a.label.localeCompare(b.label));
  return { vendors, needsSku: buy.filter(line => !matched.includes(line)).sort((a, b) => a.name.localeCompare(b.name)) };
}

export function makeGroups(result: ScanResult) {
  return makeDispositions.map(disposition => ({ disposition, label: dispositionLabel[disposition], lines: result.lines.filter(line => line.disposition === disposition).sort((a, b) => a.name.localeCompare(b.name)) }))
    .filter(group => group.lines.length);
}

export type PartFilter = 'all' | 'buy' | 'hardware' | 'make' | 'review' | 'ignore' | 'suppressed';
export type PartSort = 'name' | 'qty';
export function filterParts(result: ScanResult, filter: PartFilter, query: string, sort: PartSort) {
  const pool = filter === 'suppressed' ? result.suppressed
    : result.lines.filter(line => filter === 'all' || (filter === 'make' ? isMake(line) : line.disposition === filter));
  const needle = query.trim().toLowerCase();
  const matches = needle ? pool.filter(line => [line.name, line.partNumber, line.vendor?.sku, line.description].some(value => value?.toLowerCase().includes(needle))) : pool;
  return [...matches].sort((a, b) => sort === 'qty' ? b.qty - a.qty || a.name.localeCompare(b.name) : a.name.localeCompare(b.name));
}

/**
 * `stale` is a complete catalog whose data is old or whose last update failed: it still covers every product,
 * but its prices and stock may have changed since.
 */
export type CatalogState = 'published' | 'stale' | 'partial' | 'building' | 'failing';
export const catalogState = (vendor: VendorHealth): CatalogState => vendor.state === 'published'
  ? (!vendor.complete ? 'partial' : vendor.stale || vendor.lastRunFailed ? 'stale' : 'published')
  : vendor.state === 'failing' ? 'failing' : 'building';
export const catalogStateText = (vendor: VendorHealth) => {
  const state = catalogState(vendor);
  if (state === 'stale') return vendor.lastRunFailed ? 'Last update failed' : 'Out of date';
  return { published: 'Ready', partial: 'Partial', building: 'Loading', failing: 'Failing' }[state];
};
/** True when every vendor catalog is complete, so a blank Vendor column means "not sold there". Old data still counts. */
export const catalogsComplete = (health: CatalogHealth | undefined) => Boolean(health?.vendors.length && health.vendors.every(vendor => ['published', 'stale'].includes(catalogState(vendor))));
/** Complete catalogs whose prices and stock may be out of date. */
export const staleCatalogs = (health: CatalogHealth | undefined) => health?.vendors.filter(vendor => catalogState(vendor) === 'stale') ?? [];

/** Vendor product search for a part number in the name, so a team can see what an imported vendor part is before catalogs match it. */
const vendorSearch: Array<[RegExp, (sku: string) => string, string]> = [
  [/\b\d{4}-\d{4}-\d{4}\b/, sku => `https://www.gobilda.com/search.php?search_query=${sku}`, 'goBILDA'],
  [/\bREV-\d{2}-\d{4}\b/i, sku => `https://www.revrobotics.com/search.php?search_query=${sku}`, 'REV'],
  [/\bam-\d{3,5}[a-z]?\b/i, sku => `https://andymark.com/search?q=${sku}`, 'AndyMark'],
  [/\b\d{4,5}A\d{2,4}\b/, sku => `https://www.mcmaster.com/${sku}/`, 'McMaster-Carr'],
];
export function vendorLookup(line: BomLine): { sku: string; vendor: string; url: string } | null {
  for (const [pattern, url, vendor] of vendorSearch) {
    const sku = `${line.name} ${line.partNumber ?? ''}`.match(pattern)?.[0];
    if (sku) return { sku, vendor, url: url(sku) };
  }
  return null;
}

/** "4 minutes ago", for scan and catalog times. Never used in the first render, which has no clock yet. */
export function ago(iso: string, now: number) {
  const minutes = Math.round((now - Date.parse(iso)) / 60000);
  if (!Number.isFinite(minutes)) return 'unknown';
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  return `${Math.round(hours / 24)} days ago`;
}
