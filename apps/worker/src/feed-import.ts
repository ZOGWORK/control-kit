import { normalizeName, normalizeSku, type VendorId, type VendorRecord } from '@control-kit/shared';
import { allowedUrl } from './vendor-ingest';

/**
 * Official vendor feeds (CSV or JSON) become the same normalized `VendorRecord`s a crawl produces, so a feed can
 * replace the crawl for a vendor through the same staged publish and validation. Column names vary by vendor; each
 * field accepts common header spellings, and `mapping` overrides them (`{ sku: 'Product Code' }`).
 */
export type FeedField = 'sku' | 'name' | 'price' | 'stock' | 'stockQty' | 'packQty' | 'url' | 'category';
const aliases: Record<FeedField, string[]> = {
  sku: ['sku', 'product code', 'part number', 'part #', 'mpn', 'item number'],
  name: ['name', 'product name', 'title', 'description'],
  price: ['price', 'price usd', 'unit price', 'pack price', 'retail price'],
  stock: ['stock', 'availability', 'stock status', 'inventory status', 'in stock'],
  stockQty: ['stock qty', 'stock quantity', 'quantity available', 'qty available', 'inventory'],
  packQty: ['pack qty', 'pack quantity', 'pack size', 'qty per pack', 'units per pack', 'quantity per pack'],
  url: ['url', 'product url', 'link', 'product link'],
  category: ['category', 'product type', 'type'],
};
export type FeedRejection = { row: number; reason: string };

/** RFC 4180 CSV: quoted fields, doubled quotes, commas and newlines inside quotes. Returns one object per data row. */
export function parseCsv(text: string): Array<Record<string, string>> {
  const rows: string[][] = [];
  let field = ''; let row: string[] = []; let quoted = false;
  const source = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (quoted) {
      if (char === '"' && source[i + 1] === '"') { field += '"'; i++; }
      else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') { row.push(field); field = ''; }
    else if (char === '\n' || char === '\r') { if (char === '\r' && source[i + 1] === '\n') i++; row.push(field); rows.push(row); row = []; field = ''; }
    else field += char;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const [header, ...data] = rows.filter(values => values.some(value => value.trim()));
  if (!header) return [];
  return data.map(values => Object.fromEntries(header.map((name, column) => [name.trim(), (values[column] ?? '').trim()])));
}

/** A JSON feed is an array of objects, or an object holding one (`{ "products": [...] }`). */
export function parseJsonFeed(text: string): Array<Record<string, unknown>> {
  const value = JSON.parse(text) as unknown;
  const list = Array.isArray(value) ? value : value && typeof value === 'object' ? Object.values(value).find(Array.isArray) : null;
  if (!list) throw new Error('JSON feed has no list of products');
  return list.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object');
}

const money = (value: unknown) => {
  const amount = typeof value === 'number' ? value : Number(String(value ?? '').replace(/[$,\s]|USD/gi, ''));
  return Number.isFinite(amount) && amount > 0 ? Math.round(amount * 100) / 100 : null;
};
const count = (value: unknown) => { const text = typeof value === 'number' ? String(value) : String(value ?? '').replace(/,/g, '').trim(); if (!text) return null; const number = Number(text); return Number.isInteger(number) && number >= 0 ? number : null; };
function stockOf(status: unknown, quantity: number | null): VendorRecord['stock'] {
  const text = String(status ?? '').toLowerCase();
  if (/out|sold|unavailable|discontinued|backorder/.test(text) || quantity === 0) return 'out';
  if (quantity !== null && quantity <= 4) return 'low';
  if (quantity !== null || /^(in|yes|true|available|in stock|instock)$/.test(text) || /in stock/.test(text)) return 'in';
  return 'unknown';
}

/**
 * Rows → records. A row needs a SKU, a name, and a product URL on the vendor's own site. Pack size counts as verified
 * only when the feed states it (the vendor's own data is the evidence); price and stock are as of `updatedAt`.
 */
export function normalizeFeedRows(vendor: VendorId, rows: Array<Record<string, unknown>>, updatedAt: string, mapping: Partial<Record<FeedField, string>> = {}) {
  const headers = new Set(rows.flatMap(row => Object.keys(row)));
  const column = (field: FeedField) => mapping[field] ?? [...headers].find(header => aliases[field].includes(header.toLowerCase().trim())) ?? null;
  const columns = Object.fromEntries((Object.keys(aliases) as FeedField[]).map(field => [field, column(field)])) as Record<FeedField, string | null>;
  const missing = (['sku', 'name', 'price', 'url'] as const).filter(field => !columns[field]);
  if (missing.length) throw new Error(`Feed has no column for ${missing.join(', ')}; pass a mapping such as --map ${missing[0]}="Column Name"`);
  const value = (row: Record<string, unknown>, field: FeedField) => columns[field] ? row[columns[field]!] : undefined;
  const records: VendorRecord[] = [];
  const rejected: FeedRejection[] = [];
  rows.forEach((row, position) => {
    const sku = String(value(row, 'sku') ?? '').trim();
    const name = String(value(row, 'name') ?? '').trim();
    const url = String(value(row, 'url') ?? '').trim();
    const normalizedSku = normalizeSku(sku, vendor);
    if (!sku || !/^[A-Z0-9]+$/.test(normalizedSku)) return rejected.push({ row: position + 2, reason: 'no usable SKU' });
    if (!name) return rejected.push({ row: position + 2, reason: 'no name' });
    if (!allowedUrl(vendor, url)) return rejected.push({ row: position + 2, reason: 'product URL is not on the vendor site' });
    const stockQty = count(value(row, 'stockQty'));
    const pack = count(value(row, 'packQty'));
    records.push({ vendorId: vendor, sku, normalizedSku, name, normalizedName: normalizeName(name), url, priceUsd: money(value(row, 'price')),
      packSize: pack && pack > 0 ? pack : null, packSizeVerified: Boolean(pack && pack > 0), packEvidence: pack && pack > 0 ? `vendor feed pack quantity ${pack}` : null,
      stock: stockOf(value(row, 'stock'), stockQty), stockQty, category: String(value(row, 'category') ?? '').trim().toLowerCase() || 'uncategorized', updatedAt, source: 'feed', parser: 'official-feed' });
  });
  return { records, rejected, columns };
}
