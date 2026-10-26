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
const dollars = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
export const money = (value: number) => dollars.format(value);

/** A line can be paid for only with a confirmed or exact match, a verified pack size, and a price. */
export const priced = (line: BomLine) => line.lineTotalUsd !== null;
/** Priced, or ordered under another line that carries the price for the same SKU. */
export const covered = (line: BomLine) => priced(line) || Boolean(line.orderedWith);

export type Summary = {
  uniqueLines: number; instances: number; suppressedInstances: number;
  buy: number; make: Record<'print' | 'cnc' | 'cut-2d' | 'fabricate', number> & { total: number }; review: number;
  /** Stock fasteners and parts a person set aside; with buy, make, and review they add up to `uniqueLines`. */
  hardware: number; ignored: number;
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
    buy: buy.length, make, review: count('review'), hardware: count('hardware'), ignored: count('ignore'),
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

/**
 * Where an assembly stands, for the Overview. Order readiness counts Buy lines that carry a price (or ride on another
 * line's order); build readiness counts Make lines against the parts still waiting for a decision, any of which may
 * turn out to be made. Every figure keeps its denominator so the screen never leaves a subtraction to the reader.
 */
export type Readiness = {
  order: { ready: number; total: number; unmatched: number; unpriced: number; outOfStock: number; lowStock: number };
  build: { decided: number; total: number };
};
export function readiness(result: ScanResult, summary: Summary = summarize(result)): Readiness {
  const { vendors, needsSku } = buyList(result);
  const matched = vendors.flatMap(group => group.lines);
  return {
    order: { ready: summary.pricedLines, total: summary.buyLines, unmatched: needsSku.length, unpriced: matched.filter(line => !covered(line)).length,
      outOfStock: matched.filter(line => line.vendor!.stock === 'out').length, lowStock: matched.filter(line => line.vendor!.stock === 'low').length },
    build: { decided: summary.make.total, total: summary.make.total + summary.review },
  };
}
export const percent = (part: number, whole: number) => whole ? Math.round((part / whole) * 100) : 0;

/** The one thing to do next. Only one action is ever primary; it follows the first open problem in the order a team works. */
export type PrimaryAction = { kind: 'review' | 'unmatched' | 'unpriced' | 'stock' | 'build-pack'; label: string; count: number };
export function primaryAction(summary: Summary, ready: Readiness): PrimaryAction {
  const n = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
  if (summary.review) return { kind: 'review', label: `Review ${n(summary.review, 'part', 'parts')}`, count: summary.review };
  if (ready.order.unmatched) return { kind: 'unmatched', label: `Fix ${n(ready.order.unmatched, 'unmatched part', 'unmatched parts')}`, count: ready.order.unmatched };
  if (ready.order.unpriced) return { kind: 'unpriced', label: `Check ${n(ready.order.unpriced, 'unpriced part', 'unpriced parts')}`, count: ready.order.unpriced };
  if (ready.order.outOfStock) return { kind: 'stock', label: `Replace ${n(ready.order.outOfStock, 'out-of-stock part', 'out-of-stock parts')}`, count: ready.order.outOfStock };
  return { kind: 'build-pack', label: 'Download build pack', count: 0 };
}

/** The priced lines that make up most of the subtotal, so a wrong price shows at a glance. */
export const topCosts = (result: ScanResult, count = 5) => result.lines.filter(line => line.disposition === 'buy' && priced(line))
  .sort((a, b) => b.lineTotalUsd! - a.lineTotalUsd! || a.name.localeCompare(b.name)).slice(0, count);

/** The parts holding up the order: Buy lines with no vendor product, most-used first. */
export const unmatchedParts = (result: ScanResult, count = 3) => [...buyList(result).needsSku].sort((a, b) => b.qty - a.qty || a.name.localeCompare(b.name)).slice(0, count);

/** How every unique part is sorted, in the order the colour bar draws them. Empty groups are left out. */
export type Share = { key: 'buy' | 'make' | 'hardware' | 'review' | 'ignored'; label: string; count: number };
export function composition(summary: Summary): Share[] {
  const shares: Share[] = [
    { key: 'buy', label: 'Buy', count: summary.buy }, { key: 'make', label: 'Make', count: summary.make.total },
    { key: 'hardware', label: 'Fasteners', count: summary.hardware }, { key: 'review', label: 'Needs review', count: summary.review },
    { key: 'ignored', label: 'Not needed', count: summary.ignored },
  ];
  return shares.filter(share => share.count);
}

/**
 * What a rescan changed. Lines are compared by the part itself (document, Part Studio, part, configuration), not by
 * the line key, whose revision changes on every edit.
 */
export type ScanChanges = { added: BomLine[]; removed: BomLine[]; quantity: number; decided: number; retyped: number; newlyPriced: number; stock: number; subtotalDelta: number | null };
const partOf = (line: BomLine) => `${line.documentId}:${line.elementId}:${line.partId ?? line.name}:${line.configuration ?? ''}`;
/** A part as a whole: an assembly can hold one part at several revisions, each its own line, so they are added up. */
type Part = { line: BomLine; qty: number; dispositions: string; priced: boolean; stock: string };
function parts(result: ScanResult) {
  const map = new Map<string, Part>();
  for (const line of result.lines) {
    const part = map.get(partOf(line));
    // One revision carries the order's total and the others are `orderedWith` it, so a part is priced when all are covered.
    if (!part) { map.set(partOf(line), { line, qty: line.qty, dispositions: line.disposition, priced: covered(line), stock: line.vendor?.stock ?? '' }); continue; }
    part.qty += line.qty;
    part.dispositions = [...new Set([...part.dispositions.split(','), line.disposition])].sort().join(',');
    part.priced &&= covered(line);
    part.stock = [...new Set([...part.stock.split(','), line.vendor?.stock ?? ''])].sort().join(',');
  }
  return map;
}
export function scanChanges(before: ScanResult, after: ScanResult): ScanChanges {
  const [old, now] = [parts(before), parts(after)];
  const kept = [...now].filter(([key]) => old.has(key)).map(([key, part]) => [part, old.get(key)!] as const);
  const total = (result: ScanResult) => summarize(result).subtotal;
  const [was, is] = [total(before), total(after)];
  return {
    added: [...now].filter(([key]) => !old.has(key)).map(([, part]) => part.line),
    removed: [...old].filter(([key]) => !now.has(key)).map(([, part]) => part.line),
    quantity: kept.filter(([part, earlier]) => part.qty !== earlier.qty).length,
    decided: kept.filter(([part, earlier]) => earlier.dispositions === 'review' && part.dispositions !== 'review').length,
    // How a decided part is obtained changed (CNC to 3D print, Buy to Fastener), which may change nothing else.
    retyped: kept.filter(([part, earlier]) => earlier.dispositions !== 'review' && part.dispositions !== earlier.dispositions).length,
    newlyPriced: kept.filter(([part, earlier]) => part.priced && !earlier.priced).length,
    // In stock to out of stock (or back) changes what to order even when nothing else does.
    stock: kept.filter(([part, earlier]) => part.stock !== earlier.stock && part.line.vendor && earlier.line.vendor).length,
    subtotalDelta: was === null && is === null ? null : Math.round(((is ?? 0) - (was ?? 0)) * 100) / 100,
  };
}
export const hasChanges = (changes: ScanChanges) => Boolean(changes.added.length || changes.removed.length || changes.quantity || changes.decided || changes.retyped || changes.newlyPriced || changes.stock || changes.subtotalDelta);

/** Overview search: parts whose name, part number, or SKU contain the text, best (name starts with it) first. */
export function findParts(result: ScanResult, query: string, count = 6) {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  return filterParts(result, 'all', needle, 'name').sort((a, b) => Number(!a.name.toLowerCase().startsWith(needle)) - Number(!b.name.toLowerCase().startsWith(needle))).slice(0, count);
}

/**
 * A linked Control Point workspace's colour as the brand accent, the way Control Point paints its own canvas. It
 * replaces only `--ck-volt` and its derivatives; status colours never move. A colour too dark to see on the graphite
 * background, or one no text colour can sit on readably, is refused and the app stays volt.
 */
export type Accent = { accent: string; hover: string; soft: string; ink: string };
const channels = (hex: string) => [1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16));
const luminance = (rgb: number[]) => {
  const [r, g, b] = rgb.map(value => { const c = value / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
export const contrast = (a: string, b: string) => { const [x, y] = [luminance(channels(a)), luminance(channels(b))].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };
export function workspaceAccent(color: string | null | undefined, background = '#0a0a0b'): Accent | null {
  if (!color || !/^#[0-9a-f]{6}$/i.test(color.trim())) return null;
  const accent = color.trim().toLowerCase();
  // Dark text on a light accent, white on a dark one: whichever reads better, and it must pass for button text.
  const ink = contrast(accent, '#0a0a0b') >= contrast(accent, '#ffffff') ? '#0a0a0b' : '#ffffff';
  if (contrast(accent, background) < 3 || contrast(accent, ink) < 4.5) return null;
  const [r, g, b] = channels(accent);
  const mix = (toward: number, amount: number) => `#${[r, g, b].map(value => Math.round(value + (toward - value) * amount).toString(16).padStart(2, '0')).join('')}`;
  return { accent, hover: mix(255, 0.2), soft: `rgb(${r} ${g} ${b} / 0.12)`, ink };
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
