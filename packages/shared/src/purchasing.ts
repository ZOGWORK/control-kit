import type { BomLine, ScanResult } from './index';

const priceable = (line: BomLine) => {
  const record = line.vendor;
  return Boolean(record && ['exact', 'confirmed'].includes(line.matchStatus) && record.packSizeVerified && Number.isInteger(record.packSize) && record.packSize! >= 1 && record.priceUsd !== null);
};

/**
 * Prices one line on its own: Packs to Order = ceil(qty / pack), Line Total = packs × pack price, blank unless the
 * match is exact or confirmed and pack size and price are verified. `recalculatePurchasing` prices whole orders instead.
 */
export function updatePurchasing(line: BomLine): BomLine {
  if (!priceable(line)) { line.packsToOrder = null; line.lineTotalUsd = null; return line; }
  line.packsToOrder = Math.ceil(line.qty / line.vendor!.packSize!);
  line.lineTotalUsd = Math.round(line.packsToOrder * line.vendor!.priceUsd! * 100) / 100;
  return line;
}

/**
 * Prices what a team orders, not each CAD line. Lines to buy that resolve to the same vendor SKU are one order:
 *   - lines from different Part Studios (or documents) are separate pieces, so their quantities add up;
 *   - several bodies of one Part Studio sharing a SKU are one product modelled in parts (a REV switch's housing,
 *     connector, and screw all carry REV-31-1462) when the Part Studio is linked from another document (see
 *     `studioQuantity`); in the team's own document they are separate parts and add up.
 * Packs are rounded up once on the total. The first line carries the order (`order`, packs, total); the others point
 * at it (`orderedWith`) and carry no total, so nothing is counted twice.
 */
/** The assembly a placement sits in (its path without the part itself). */
const parentOf = (path: string) => path.split(' > ').slice(0, -1).join(' > ');
/** A body's name without a copy number ("Screw 2", "Screw (3)", "Screw <4>"), so copies of one body compare equal. */
const baseName = (name: string) => name.toLowerCase().trim().replace(/\s*(?:\(\d+\)|<\d+>|\s\d+)$/, '');
/**
 * Pieces in one Part Studio that carry one SKU. Where the Part Studio comes from decides what they are:
 *   - in the team's own document they are the team's parts (screws modelled in place, "Left screw" and "Right screw"),
 *     so they add up;
 *   - linked from another document they are a vendor's model of one product in pieces (REV's switch: housing,
 *     connector, screw, all REV-31-1462), so in each assembly the product count is the most of any piece there, and the
 *     assemblies add up (two switches in one place and a spare housing elsewhere are three). Copies of one piece
 *     ("Screw 1", "Screw 2") are still copies and add up.
 */
function studioQuantity(bodies: BomLine[], assemblyDocumentId: string) {
  const sum = () => bodies.reduce((total, body) => total + body.qty, 0);
  if (bodies.length === 1) return sum();
  // Bodies that all have exactly the same name are one imported model in pieces (32 bodies named REV-31-1153 are one
  // Expansion Hub), in the team's document or not; copies a person makes get numbered names ("Screw 2").
  const sameName = bodies.every(body => body.name.trim().toLowerCase() === bodies[0].name.trim().toLowerCase());
  if (!sameName && bodies[0].documentId === assemblyDocumentId) return sum();
  if (!sameName && new Set(bodies.map(body => baseName(body.name))).size !== bodies.length) return sum();
  const perParent = new Map<string, number>();
  for (const body of bodies) {
    const here = new Map<string, number>();
    for (const path of body.instancePaths) here.set(parentOf(path), (here.get(parentOf(path)) ?? 0) + 1);
    for (const [parent, count] of here) perParent.set(parent, Math.max(perParent.get(parent) ?? 0, count));
  }
  return [...perParent.values()].reduce((total, count) => total + count, 0);
}

const SANITY_PRICE_USD = 150;
const SANITY_PACKS = 3;

export function recalculatePurchasing(result: ScanResult): ScanResult {
  for (const line of result.lines) { line.packsToOrder = null; line.lineTotalUsd = null; line.order = null; line.orderedWith = null; line.priceCheck = null; }
  const groups = new Map<string, BomLine[]>();
  for (const line of result.lines) {
    if (line.disposition !== 'buy' || !priceable(line)) continue;
    const key = `${line.vendor!.vendorId}:${line.vendor!.normalizedSku}`;
    groups.set(key, [...(groups.get(key) ?? []), line]);
  }
  for (const lines of groups.values()) {
    const studios = new Map<string, BomLine[]>();
    for (const line of lines) {
      // Configurations are separate parts (two lengths of one product are two products), so they never collapse together.
      const studio = `${line.documentId}:${line.elementId}:${line.configuration ?? ''}:${line.sourceId ?? ''}`;
      studios.set(studio, [...(studios.get(studio) ?? []), line]);
    }
    const qty = [...studios.values()].reduce((sum, bodies) => sum + studioQuantity(bodies, result.documentId), 0);
    // The line whose own name or part number shows the SKU leads, so the order reads as the product.
    const sku = lines[0].vendor!.sku.toLowerCase();
    const lead = lines.find(line => `${line.name} ${line.partNumber ?? ''}`.toLowerCase().includes(sku)) ?? lines[0];
    const record = lead.vendor!;
    lead.packsToOrder = Math.ceil(qty / record.packSize!);
    lead.lineTotalUsd = Math.round(lead.packsToOrder * record.priceUsd! * 100) / 100;
    lead.order = { qty, lines: lines.length };
    // No FTC robot uses three or more of a $150+ product (hubs, cameras, controllers): such a count comes from how the
    // CAD was modelled, so the order is shown but not priced until a person checks it.
    if (record.priceUsd! >= SANITY_PRICE_USD && lead.packsToOrder >= SANITY_PACKS) {
      lead.priceCheck = `${lead.packsToOrder} × ${record.sku} at $${record.priceUsd!.toFixed(2)} is more than an FTC robot uses; check the count in the CAD`;
      lead.lineTotalUsd = null;
    }
    for (const line of lines) if (line !== lead) line.orderedWith = lead.bomLineKey;
  }
  const priced = result.lines.map(line => line.lineTotalUsd).filter((price): price is number => price !== null);
  result.stats.totalCostUsd = priced.length ? Math.round(priced.reduce((total, price) => total + price, 0) * 100) / 100 : null;
  result.stats.outOfStockLines = result.lines.filter(line => line.vendor?.stock === 'out' && !['possible', 'rejected'].includes(line.matchStatus)).length;
  return result;
}
