import { normalizeName, normalizeSku, type VendorId, type VendorRecord } from '@control-kit/shared';
import type { Kv } from './index';

export const vendorSources: Record<VendorId, { origin: string; sitemap: string }> = {
  gobilda: { origin: 'https://www.gobilda.com', sitemap: 'https://www.gobilda.com/xmlsitemap.php' },
  servocity: { origin: 'https://www.servocity.com', sitemap: 'https://www.servocity.com/xmlsitemap.php' },
  andymark: { origin: 'https://andymark.com', sitemap: 'https://andymark.com/sitemap.xml' },
  rev: { origin: 'https://www.revrobotics.com', sitemap: 'https://www.revrobotics.com/xmlsitemap.php' },
  pitsco: { origin: 'https://www.pitsco.com', sitemap: 'https://www.pitsco.com/sitemap.xml' },
};
export type VendorSnapshot = { status: 'ok' | 'failed'; updatedAt: string | null; lastRunAt: string; recordCount: number; source: 'sitemap'; version: string | null; inProgress?: boolean; error?: string };
type Cursor = { sitemaps: string[]; sitemapIndex: number; urls: string[]; urlIndex: number; records: Record<string, VendorRecord>; phase: 'fetch' | 'records' | 'indexes' | 'ready'; version?: string; publishIndex?: number; indexIndex?: number; readyAt?: number };
type Retired = { version: string; keys: string[]; index: number; after: number }[];
export type VendorRun = { vendor: VendorId; source: 'sitemap'; fetched: number; upserted: number; skipped: number; durationMs: number; complete: boolean };
type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;
const userAgent = 'Control Kit vendor catalog (+https://github.com/ZOGWORK/control-kit)';
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const decodeXml = (value: string) => value.replaceAll('&amp;', '&').replaceAll('&quot;', '"').replaceAll('&apos;', "'").replaceAll('&lt;', '<').replaceAll('&gt;', '>');
export function sitemapLocations(xml: string) { return [...xml.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)].map(match => decodeXml(match[1])); }
function productNodes(html: string): Record<string, unknown>[] {
  const nodes: Record<string, unknown>[] = [];
  const walk = (item: unknown) => {
    if (Array.isArray(item)) { item.forEach(walk); return; }
    if (!item || typeof item !== 'object') return;
    const value = item as Record<string, unknown>;
    if (value['@type'] === 'Product' || (Array.isArray(value['@type']) && value['@type'].includes('Product'))) nodes.push(value);
    if (value['@graph']) walk(value['@graph']);
  };
  for (const match of html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try { walk(JSON.parse(match[1])); } catch { /* Other page scripts may contain invalid JSON. */ }
  }
  return nodes;
}
function stock(availability: unknown, quantity: number | null): VendorRecord['stock'] {
  if (typeof availability === 'string' && /outofstock|soldout|discontinued/i.test(availability)) return 'out';
  if (quantity === 0) return 'out';
  if (quantity !== null && quantity >= 1 && quantity <= 4) return 'low';
  if (quantity !== null && quantity >= 5) return 'in';
  if (typeof availability === 'string' && /instock|limitedavailability/i.test(availability)) return 'in';
  return 'unknown';
}
function verifiedPack(name: string): number | null {
  const match = name.match(/(?:pack\s+of\s+(\d+)|(\d+)\s*[- ]?pack)\b/i);
  const quantity = Number(match?.[1] ?? match?.[2]);
  return Number.isInteger(quantity) && quantity > 0 ? quantity : null;
}
export function parseProductPage(vendor: VendorId, pageUrl: string, html: string, updatedAt: string): VendorRecord[] {
  const records: VendorRecord[] = [];
  for (const product of productNodes(html)) {
    const name = typeof product.name === 'string' ? product.name.trim() : '';
    if (!name) continue;
    const sku = typeof product.sku === 'string' && product.sku.trim() ? product.sku.trim() : normalizeName(name).replaceAll(' ', '-');
    if (!sku) continue;
    const offer = (Array.isArray(product.offers) ? product.offers[0] : product.offers) as Record<string, unknown> | undefined;
    const priceValue = Number(offer?.price);
    const priceUsd = offer?.priceCurrency === 'USD' && Number.isFinite(priceValue) && priceValue > 0 ? priceValue : null;
    const inventory = offer?.inventoryLevel as Record<string, unknown> | undefined;
    const quantityValue = Number(inventory?.value);
    const stockQty = inventory?.value !== undefined && Number.isFinite(quantityValue) && quantityValue >= 0 ? quantityValue : null;
    const packSize = verifiedPack(name);
    records.push({ vendorId: vendor, name, normalizedName: normalizeName(name), sku, normalizedSku: normalizeSku(sku, vendor), url: pageUrl,
      priceUsd, stock: stock(offer?.availability, stockQty), stockQty, packSize, packSizeVerified: packSize !== null,
      category: typeof product.category === 'string' && product.category.trim() ? product.category.toLowerCase().trim() : 'uncategorized', updatedAt, source: 'sitemap' });
  }
  return [...new Map(records.map(record => [record.normalizedSku, record])).values()];
}
function allowedUrl(vendor: VendorId, url: string) {
  try { const parsed = new URL(url); return parsed.protocol === 'https:' && parsed.hostname === new URL(vendorSources[vendor].origin).hostname && !parsed.username && !parsed.password; }
  catch { return false; }
}
function robotsAllows(robots: string, path: string) {
  let applies = false;
  for (const raw of robots.split(/\r?\n/)) {
    const line = raw.split('#')[0].trim();
    const [field, ...rest] = line.split(':');
    const value = rest.join(':').trim();
    if (/^user-agent$/i.test(field)) applies = value === '*' || /control kit/i.test(value);
    if (applies && /^disallow$/i.test(field) && value && path.startsWith(value)) return false;
  }
  return true;
}
const digest = async (text: string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))), byte => byte.toString(16).padStart(2, '0')).join('');
const snapshotKey = (vendor: VendorId) => `vendor:${vendor}:__snapshot__`;
const pointerKey = (vendor: VendorId) => `vendor:${vendor}:__lastgood__`;
const cursorKey = (vendor: VendorId) => `vendor:${vendor}:__cursor__`;
const retiredKey = (vendor: VendorId) => `vendor:${vendor}:__retired__`;
const manifestKey = (vendor: VendorId, version: string) => `vendor:${vendor}:__manifest__:${version}`;
const indexEntries = (vendor: VendorId, records: VendorRecord[]) => {
  const indexes = new Map<string, string[]>();
  for (const record of records) for (const token of new Set(record.normalizedName.split(' ').filter(token => token.length > 2))) {
    let ids = indexes.get(token);
    if (!ids) { ids = []; indexes.set(token, ids); }
    ids.push(`${vendor}:${record.normalizedSku}`);
  }
  return [...indexes.entries()].sort(([a], [b]) => a.localeCompare(b));
};
async function cleanRetired(vendor: VendorId, kv: Kv, maxDeletes: number, rebuildingVersion?: string) {
  const pending = JSON.parse(await kv.get(retiredKey(vendor)) ?? '[]') as Retired;
  const active = await kv.get(pointerKey(vendor));
  let left = maxDeletes;
  for (const item of pending) {
    if (item.after > Date.now() || item.version === active || item.version === rebuildingVersion) continue;
    while (item.index < item.keys.length && left > 0) {
      await kv.delete(item.keys[item.index]);
      item.index++;
      left--;
    }
    if (item.index === item.keys.length) await kv.delete(manifestKey(vendor, item.version));
  }
  const remaining = pending.filter(item => item.index < item.keys.length || item.version === active || item.version === rebuildingVersion || item.after > Date.now());
  if (remaining.length) await kv.put(retiredKey(vendor), JSON.stringify(remaining));
  else if (pending.length) await kv.delete(retiredKey(vendor));
}
async function unretire(vendor: VendorId, kv: Kv, version: string) {
  const pending = JSON.parse(await kv.get(retiredKey(vendor)) ?? '[]') as Retired;
  if (!pending.some(item => item.version === version)) return;
  const remaining = pending.filter(item => item.version !== version);
  if (remaining.length) await kv.put(retiredKey(vendor), JSON.stringify(remaining));
  else await kv.delete(retiredKey(vendor));
}

/** A completed version is published by one pointer write after all records and indexes exist. */
export async function runVendor(vendor: VendorId, kv: Kv, fetcher: Fetcher = fetch, options: { maxProducts?: number; minRequestMs?: number; publicationDelayMs?: number } = {}): Promise<VendorRun> {
  const started = Date.now();
  const maxProducts = Math.max(1, Math.min(options.maxProducts ?? 40, 500));
  const minRequestMs = options.minRequestMs ?? 500;
  const previous = JSON.parse(await kv.get(snapshotKey(vendor)) ?? 'null') as VendorSnapshot | null;
  let fetched = 0; const skipped = 0; let upserted = 0; let lastRequest = 0;
  let cursor: Cursor | null = null;
  const fetchText = async (url: string, robots?: string) => {
    if (!allowedUrl(vendor, url)) throw Error('Sitemap linked outside the vendor host');
    if (robots && !robotsAllows(robots, new URL(url).pathname)) throw Error('Vendor robots.txt disallows this URL');
    const wait = minRequestMs - (Date.now() - lastRequest);
    if (wait > 0) await sleep(wait);
    lastRequest = Date.now();
    const response = await fetcher(url, { headers: { 'user-agent': userAgent, accept: 'text/html,application/xml,text/xml;q=0.9' }, signal: AbortSignal.timeout(15000) });
    if (response.status === 429) { await sleep(Math.min(Number(response.headers.get('retry-after')) * 1000 || 1000, 5000)); throw Error('Vendor returned HTTP 429'); }
    if (!response.ok) throw Error(`Vendor returned HTTP ${response.status}`);
    return response.text();
  };
  try {
    cursor = JSON.parse(await kv.get(cursorKey(vendor)) ?? 'null') as Cursor | null;
    await cleanRetired(vendor, kv, 40, cursor?.version);
    if (cursor?.version) await unretire(vendor, kv, cursor.version);
    const robots = await fetchText(`${vendorSources[vendor].origin}/robots.txt`);
    if (!cursor) {
      const root = await fetchText(vendorSources[vendor].sitemap, robots);
      const sitemaps = sitemapLocations(root).filter(url => /(?:type=products|sitemap_products)/i.test(url) && allowedUrl(vendor, url));
      if (!sitemaps.length) throw Error('No public product sitemap found');
      cursor = { sitemaps, sitemapIndex: 0, urls: [], urlIndex: 0, records: {}, phase: 'fetch' };
    }
    while (cursor.phase === 'fetch' && fetched < maxProducts) {
      if (cursor.urlIndex >= cursor.urls.length) {
        if (cursor.sitemapIndex >= cursor.sitemaps.length) break;
        const xml = await fetchText(cursor.sitemaps[cursor.sitemapIndex], robots);
        const urls = sitemapLocations(xml).filter(url => allowedUrl(vendor, url) && (!['andymark', 'pitsco'].includes(vendor) || new URL(url).pathname.startsWith('/products/')));
        if (!urls.length) throw Error('Product sitemap contained no product URLs');
        cursor.urls = urls;
        cursor.sitemapIndex++;
        cursor.urlIndex = 0;
        continue;
      }
      const url = cursor.urls[cursor.urlIndex];
      const html = await fetchText(url, robots);
      const records = parseProductPage(vendor, url, html, new Date().toISOString());
      if (!records.length) throw Error('Product page contained no usable Product JSON-LD');
      cursor.urlIndex++;
      fetched++;
      for (const record of records) cursor.records[record.normalizedSku] = record;
    }
    const records = Object.values(cursor.records).sort((a, b) => a.normalizedSku.localeCompare(b.normalizedSku));
    if (cursor.phase === 'fetch' && cursor.sitemapIndex >= cursor.sitemaps.length && cursor.urlIndex >= cursor.urls.length) {
      if (!records.length) throw Error('Product sitemap contained no usable records');
      cursor.version = await digest(JSON.stringify(records.map(record => ({ ...record, updatedAt: undefined }))));
      await unretire(vendor, kv, cursor.version);
      cursor.phase = 'records';
    }
    let complete = false;
    if (cursor.phase === 'records' && cursor.version === await kv.get(pointerKey(vendor))) complete = true;
    if (cursor.phase === 'records' && !complete) {
      const end = Math.min(records.length, (cursor.publishIndex ?? 0) + maxProducts);
      for (let index = cursor.publishIndex ?? 0; index < end; index++) {
        const record = records[index];
        await kv.put(`vendor-version:${vendor}:${cursor.version}:${record.normalizedSku}`, JSON.stringify(record));
        cursor.publishIndex = index + 1;
        upserted++;
      }
      if (cursor.publishIndex === records.length) cursor.phase = 'indexes';
    }
    if (cursor.phase === 'indexes') {
      const entries = indexEntries(vendor, records);
      const end = Math.min(entries.length, (cursor.indexIndex ?? 0) + maxProducts);
      for (let index = cursor.indexIndex ?? 0; index < end; index++) {
        const [token, ids] = entries[index];
        await kv.put(`vendor-index-version:${vendor}:${cursor.version}:${token}`, JSON.stringify(ids));
        cursor.indexIndex = index + 1;
      }
      if (cursor.indexIndex === entries.length || entries.length === 0) {
        const version = cursor.version!;
        await kv.put(manifestKey(vendor, version), JSON.stringify([
          ...records.map(record => `vendor-version:${vendor}:${version}:${record.normalizedSku}`),
          ...entries.map(([token]) => `vendor-index-version:${vendor}:${version}:${token}`),
        ]));
        cursor.phase = 'ready';
        cursor.readyAt = Date.now() + (options.publicationDelayMs ?? 65000);
        await kv.put(cursorKey(vendor), JSON.stringify(cursor));
      }
    }
    if (cursor.phase === 'ready') {
      await sleep(Math.max(0, (cursor.readyAt ?? 0) - Date.now()));
      const oldVersion = await kv.get(pointerKey(vendor));
      if (oldVersion && oldVersion !== cursor.version) {
        const keys = JSON.parse(await kv.get(manifestKey(vendor, oldVersion)) ?? '[]') as string[];
        if (keys.length) {
          const pending = JSON.parse(await kv.get(retiredKey(vendor)) ?? '[]') as Retired;
          if (!pending.some(item => item.version === oldVersion)) {
            pending.push({ version: oldVersion, keys, index: 0, after: Date.now() + 24 * 3600000 });
            await kv.put(retiredKey(vendor), JSON.stringify(pending));
          }
        }
      }
      await kv.put(pointerKey(vendor), cursor.version!);
      complete = true;
    }
    if (complete) await kv.delete(cursorKey(vendor));
    else await kv.put(cursorKey(vendor), JSON.stringify(cursor));
    const snapshot: VendorSnapshot = { status: 'ok', updatedAt: complete ? new Date().toISOString() : previous?.updatedAt ?? null,
      lastRunAt: new Date().toISOString(), recordCount: complete ? Object.keys(cursor.records).length : previous?.recordCount ?? 0,
      source: 'sitemap', version: await kv.get(pointerKey(vendor)), ...(complete ? {} : { inProgress: true }) };
    await kv.put(snapshotKey(vendor), JSON.stringify(snapshot));
    const summary = { vendor, source: 'sitemap' as const, fetched, upserted, skipped, durationMs: Date.now() - started, complete };
    console.log(JSON.stringify(summary));
    return summary;
  } catch (cause) {
    if (cursor) await kv.put(cursorKey(vendor), JSON.stringify(cursor));
    const snapshot: VendorSnapshot = { status: 'failed', updatedAt: previous?.updatedAt ?? null, lastRunAt: new Date().toISOString(), recordCount: previous?.recordCount ?? 0,
      source: 'sitemap', version: await kv.get(pointerKey(vendor)), error: cause instanceof Error ? cause.message.slice(0, 200) : 'Unknown ingestion error' };
    await kv.put(snapshotKey(vendor), JSON.stringify(snapshot));
    console.error(JSON.stringify({ vendor, fetched, upserted, skipped, durationMs: Date.now() - started, error: snapshot.error }));
    throw cause;
  }
}
