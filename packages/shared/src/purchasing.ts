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
 *     connector, and screw all carry REV-31-1462) when they are different pieces (different names apart from numbers)
 *     placed together (the same places, the same number of times): that group counts once per placement. Copies of one
 *     body (screws modelled in place, "Screw 1" to "Screw 4") and bodies placed separately add up.
 * Packs are rounded up once on the total. The first line carries the order (`order`, packs, total); the others point
 * at it (`orderedWith`) and carry no total, so nothing is counted twice.
 */
/** Where a body is placed: the parent path of every instance, sorted, so bodies placed together compare equal. */
const placements = (line: BomLine) => line.instancePaths.map(path => path.split(' > ').slice(0, -1).join(' > ')).sort().join('\n');
/** A body's name without a copy number ("Screw 2", "Screw (3)", "Screw <4>"), so copies of one body compare equal. */
const baseName = (name: string) => name.toLowerCase().trim().replace(/\s*(?:\(\d+\)|<\d+>|\s\d+)$/, '');
/** Pieces in one Part Studio that carry one SKU: one product placed together, or separate pieces that add up. */
function studioQuantity(bodies: BomLine[]) {
  if (bodies.length === 1) return bodies[0].qty;
  const together = bodies.every(body => placements(body) === placements(bodies[0]));
  const differentPieces = new Set(bodies.map(body => baseName(body.name))).size === bodies.length;
  return together && differentPieces ? Math.max(...bodies.map(body => body.qty)) : bodies.reduce((sum, body) => sum + body.qty, 0);
}

export function recalculatePurchasing(result: ScanResult): ScanResult {
  for (const line of result.lines) { line.packsToOrder = null; line.lineTotalUsd = null; line.order = null; line.orderedWith = null; }
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
    const qty = [...studios.values()].reduce((sum, bodies) => sum + studioQuantity(bodies), 0);
    // The line whose own name or part number shows the SKU leads, so the order reads as the product.
    const sku = lines[0].vendor!.sku.toLowerCase();
    const lead = lines.find(line => `${line.name} ${line.partNumber ?? ''}`.toLowerCase().includes(sku)) ?? lines[0];
    const record = lead.vendor!;
    lead.packsToOrder = Math.ceil(qty / record.packSize!);
    lead.lineTotalUsd = Math.round(lead.packsToOrder * record.priceUsd! * 100) / 100;
    lead.order = { qty, lines: lines.length };
    for (const line of lines) if (line !== lead) line.orderedWith = lead.bomLineKey;
  }
  const priced = result.lines.map(line => line.lineTotalUsd).filter((price): price is number => price !== null);
  result.stats.totalCostUsd = priced.length ? Math.round(priced.reduce((total, price) => total + price, 0) * 100) / 100 : null;
  result.stats.outOfStockLines = result.lines.filter(line => line.vendor?.stock === 'out' && !['possible', 'rejected'].includes(line.matchStatus)).length;
  return result;
}
