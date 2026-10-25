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
 *     connector, and screw all carry REV-31-1462), so that Part Studio counts once per placement: its largest quantity.
 * Packs are rounded up once on the total. The first line carries the order (`order`, packs, total); the others point
 * at it (`orderedWith`) and carry no total, so nothing is counted twice.
 */
export function recalculatePurchasing(result: ScanResult): ScanResult {
  for (const line of result.lines) { line.packsToOrder = null; line.lineTotalUsd = null; line.order = null; line.orderedWith = null; }
  const groups = new Map<string, BomLine[]>();
  for (const line of result.lines) {
    if (line.disposition !== 'buy' || !priceable(line)) continue;
    const key = `${line.vendor!.vendorId}:${line.vendor!.normalizedSku}`;
    groups.set(key, [...(groups.get(key) ?? []), line]);
  }
  for (const lines of groups.values()) {
    const studios = new Map<string, number>();
    for (const line of lines) {
      // Configurations are separate parts (two lengths of one product are two products), so they never collapse together.
      const studio = `${line.documentId}:${line.elementId}:${line.configuration ?? ''}:${line.sourceId ?? ''}`;
      studios.set(studio, Math.max(studios.get(studio) ?? 0, line.qty));
    }
    const qty = [...studios.values()].reduce((sum, value) => sum + value, 0);
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
