import { normalizeName, normalizeSku, type VendorId, type VendorRecord } from '@control-kit/shared';
import type { Kv } from './index';

/**
 * `feed` vendors are Shopify stores whose public `/products.json` lists 250 products with every variant's SKU, price, and
 * availability per request, so a whole catalog takes a handful of requests instead of one page fetch per product.
 */
export const vendorSources: Record<VendorId, { origin: string; sitemap: string; feed?: boolean }> = {
  gobilda: { origin: 'https://www.gobilda.com', sitemap: 'https://www.gobilda.com/xmlsitemap.php' },
  servocity: { origin: 'https://www.servocity.com', sitemap: 'https://www.servocity.com/xmlsitemap.php' },
  andymark: { origin: 'https://andymark.com', sitemap: 'https://andymark.com/sitemap.xml', feed: true },
  rev: { origin: 'https://www.revrobotics.com', sitemap: 'https://www.revrobotics.com/xmlsitemap.php' },
  pitsco: { origin: 'https://www.pitsco.com', sitemap: 'https://www.pitsco.com/sitemap.xml', feed: true },
};
export const feedUrl = (vendor: VendorId, page: number) => `${vendorSources[vendor].origin}/products.json?limit=250&page=${page}`;

/*
 * Catalog storage, per vendor, in VENDOR_CATALOG. Every run costs a handful of KV writes, whatever the catalog size:
 *   cat:{vendor}:pointer               Live generation readers use: { gen, complete, records, publishedAt, previous }.
 *   cat:{vendor}:crawl                 Crawl position only (never records): sitemap list, page index, counters.
 *   cat:{vendor}:gen:{gen}:urls:{i}    Product URLs of sitemap i, written once when that sitemap is read.
 *   cat:{vendor}:gen:{gen}:batch:{n}   Records parsed in run n of this generation. Append-only.
 *   cat:{vendor}:gen:{gen}:index       [normalizedSku, normalizedName, batch] for every record; the scan's lookup table.
 *   vendor:{vendor}:__snapshot__       Status written on every run, success or failure (health reads only this).
 * The first crawl publishes as it goes: its generation is live from the first batch and labeled incomplete.
 * Later crawls build a new generation while the last complete one stays live, then switch on completion.
 * The replaced generation is kept for a day for rollback, then deleted in bounded steps.
 */
export const pointerKey = (vendor: VendorId) => `cat:${vendor}:pointer`;
const crawlKey = (vendor: VendorId) => `cat:${vendor}:crawl`;
const urlsKey = (vendor: VendorId, gen: string, sitemap: number) => `cat:${vendor}:gen:${gen}:urls:${sitemap}`;
export const batchKey = (vendor: VendorId, gen: string, batch: number) => `cat:${vendor}:gen:${gen}:batch:${batch}`;
export const indexKey = (vendor: VendorId, gen: string) => `cat:${vendor}:gen:${gen}:index`;
export const snapshotKey = (vendor: VendorId) => `vendor:${vendor}:__snapshot__`;
const legacyKeys = (vendor: VendorId) => [`vendor:${vendor}:__cursor__`, `vendor:${vendor}:__lastgood__`, `vendor:${vendor}:__retired__`];

/** `batches` is how many batches readers may use; index entries for later batches are not yet published. */
export type CatalogPointer = { gen: string; complete: boolean; records: number; batches?: number; publishedAt: string; completedAt: string | null; skipped?: Partial<Record<SkipReason, number>>; previous: { gen: string; batches: number; deleteAfter: number; deleted: number } | null };
/** `previousBatch` keeps a re-listed SKU readable from its older batch until the newer batch is published. */
export type IndexEntry = [normalizedSku: string, normalizedName: string, batch: number, previousBatch?: number];
export type SkipReason = 'redirect-stub' | 'no-product-data' | 'no-sku' | 'robots-disallowed' | 'off-vendor-url' | 'fetch-failed';
type Crawl = { gen: string; startedAt: string; sitemaps: string[]; sitemapIndex: number; urlCount: number; urlIndex: number; batches: number; records: number; skipped: Partial<Record<SkipReason, number>>; skipSamples: Array<{ reason: SkipReason; url: string }>; failing: { url: string; runs: number } | null; done?: boolean };
/** Crawl position, copied into the snapshot so health checks never read crawl or index keys. */
export type CrawlProgress = { phase: 'fetch'; sitemapsDone: number; sitemapsTotal: number; pagesDoneInSitemap: number; pagesInSitemap: number; recordsCollected: number };
export type VendorSnapshot = { status: 'ok' | 'failed'; updatedAt: string | null; lastRunAt: string; recordCount: number; source: 'sitemap'; version: string | null; complete?: boolean; inProgress?: boolean; error?: string;
  progress?: CrawlProgress | null; skipped?: Partial<Record<SkipReason, number>> };
export type VendorRun = { vendor: VendorId; source: 'sitemap'; fetched: number; upserted: number; skipped: number; durationMs: number; complete: boolean };
type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

const userAgent = 'Control Kit vendor catalog (+https://github.com/ZOGWORK/control-kit)';
/** A page whose fetch fails on this many consecutive runs is skipped so one bad URL cannot stall a vendor. */
const maxFailingRuns = 3;
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const decodeXml = (value: string) => value.replaceAll('&amp;', '&').replaceAll('&quot;', '"').replaceAll('&apos;', "'").replaceAll('&lt;', '<').replaceAll('&gt;', '>');
const decodeHtml = (value: string) => decodeXml(value).replaceAll('&#39;', "'").replaceAll('&#x27;', "'").replaceAll('&nbsp;', ' ').replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)));
const text = (html: string) => decodeHtml(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
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

/** Only explicit quantity wording counts as pack evidence; a product without it has an unverified pack size. */
export function packFromText(value: string): { size: number; phrase: string } | null {
  const match = value.match(/\b(?:pack\s+of\s+(\d+)|(\d+)\s*[- ]?(?:pack|pk|pcs?|pieces?|count|ct)\b|set\s+of\s+(\d+)|qty\.?\s*:?\s*(\d+))/i);
  const size = Number(match?.[1] ?? match?.[2] ?? match?.[3] ?? match?.[4]);
  return match && Number.isInteger(size) && size > 0 && size <= 10000 ? { size, phrase: match[0].trim() } : null;
}
function pack(label: string, source: string): Pick<VendorRecord, 'packSize' | 'packSizeVerified' | 'packEvidence'> {
  const found = packFromText(label);
  return found ? { packSize: found.size, packSizeVerified: true, packEvidence: `${source} "${found.phrase}"` } : { packSize: null, packSizeVerified: false, packEvidence: null };
}
const usd = (value: unknown, currency: unknown) => {
  const amount = Number(value);
  return currency === 'USD' && Number.isFinite(amount) && amount > 0 ? Math.round(amount * 100) / 100 : null;
};
const meta = (html: string, property: string) => {
  const match = html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${property.replace(/[:.]/g, '\\$&')}["'][^>]*content=["']([^"']*)["']`, 'i'));
  return match ? decodeHtml(match[1]).trim() : null;
};

type Draft = Omit<VendorRecord, 'vendorId' | 'normalizedSku' | 'normalizedName' | 'updatedAt' | 'source' | 'category'> & { category?: string };

/** Shopify (AndyMark, Pitsco): `var meta = {"product":{"variants":[…]}}` lists every purchasable SKU with its price in cents. */
function shopifyVariants(html: string, pageUrl: string, title: string, offers: Record<string, unknown>[]): Draft[] {
  const match = html.match(/var meta = (\{"product":[\s\S]*?\});\s*\n/);
  if (!match) return [];
  let product: { variants?: Array<{ id?: number; sku?: string; price?: number; name?: string; public_title?: string | null }> };
  try { product = (JSON.parse(match[1]) as { product: typeof product }).product; } catch { return []; }
  const currency = /ShopifyAnalytics\.meta\.currency = '([A-Z]{3})'/.exec(html)?.[1] ?? 'USD';
  return (product.variants ?? []).flatMap(variant => {
    const sku = typeof variant.sku === 'string' ? variant.sku.trim() : '';
    if (!sku) return [];
    const offer = offers.find(item => item.sku === sku || (typeof item.url === 'string' && variant.id !== undefined && item.url.includes(`variant=${variant.id}`)));
    const label = variant.public_title ? `${title} (${variant.public_title})` : title;
    const url = new URL(pageUrl);
    if (variant.id !== undefined && (product.variants?.length ?? 0) > 1) url.searchParams.set('variant', String(variant.id));
    const inventory = offer?.inventoryLevel as Record<string, unknown> | undefined;
    const quantity = inventory?.value !== undefined && Number.isFinite(Number(inventory.value)) && Number(inventory.value) >= 0 ? Number(inventory.value) : null;
    return [{ name: label, sku, url: url.toString(), sourceUrl: pageUrl, priceUsd: usd(typeof variant.price === 'number' ? variant.price / 100 : null, currency), stock: stock(offer?.availability, quantity), stockQty: quantity,
      ...(packFromText(variant.public_title ?? '') ? pack(variant.public_title ?? '', 'variant label') : pack(title, 'product name')), parser: 'shopify-variant' as const }];
  });
}

/** BigCommerce (goBILDA, ServoCity, REV) family pages list child products as rows: label, `data-sku`, price, stock message. */
function bigCommerceVariants(html: string, pageUrl: string, title: string): Draft[] {
  const blocks = html.split(/<div class="card-body child">/).slice(1);
  return blocks.flatMap(block => {
    const sku = block.match(/data-sku="([^"]+)"/)?.[1]?.trim();
    if (!sku) return [];
    const label = text(block.match(/<h4 class="card-title">([\s\S]*?)<\/h4>/)?.[1] ?? '');
    const price = block.match(/data-product-price-without-tax[^>]*>\s*\$?([\d,]+(?:\.\d+)?)/)?.[1]?.replaceAll(',', '');
    const message = text(block.match(/<span class="childMessage[^"]*">([\s\S]*?)<\/span>/)?.[1] ?? '');
    return [{ name: label ? `${title} (${label})` : title, sku, url: pageUrl, priceUsd: usd(price, 'USD'), stock: /out of stock|sold out|discontinued/i.test(message) ? 'out' as const : 'unknown' as const, stockQty: null,
      ...pack(label, 'variant label'), parser: 'bigcommerce-variant' as const }];
  });
}

export type ParsedPage = { records: VendorRecord[]; skip: SkipReason | null };

type FeedProduct = { title?: string; handle?: string; product_type?: string; variants?: Array<{ id?: number; title?: string; sku?: string | null; price?: string | number; available?: boolean }> };
/**
 * One page of a Shopify `/products.json` feed. Each variant with a SKU becomes a record; its price is the store's USD
 * price for one purchasable unit, and pack size is verified only from explicit wording, as on product pages.
 * `empty` marks the page past the last product, which ends the crawl.
 */
export function parseShopifyFeed(vendor: VendorId, body: string, updatedAt: string): { records: VendorRecord[]; skippedProducts: number; empty: boolean } {
  let parsed: { products?: unknown };
  try { parsed = JSON.parse(body) as { products?: unknown }; } catch { throw new VendorFetchError('Vendor product feed was not JSON'); }
  // Only an explicit empty list ends a crawl; any other body (an error object, `{}`) must not cut a catalog short.
  if (!Array.isArray(parsed.products)) throw new VendorFetchError('Vendor product feed had no product list');
  const products = parsed.products as FeedProduct[];
  const origin = vendorSources[vendor].origin;
  let skippedProducts = 0;
  const records = products.flatMap(product => {
    const title = decodeHtml((product.title ?? '').trim());
    if (!title || !product.handle) { skippedProducts++; return []; }
    const variants = product.variants ?? [];
    const drafts = variants.flatMap((variant): VendorRecord[] => {
      const sku = typeof variant.sku === 'string' ? variant.sku.trim() : '';
      if (!sku) return [];
      const label = variant.title && variant.title !== 'Default Title' ? variant.title : '';
      const url = new URL(`/products/${encodeURIComponent(product.handle!)}`, origin);
      if (variants.length > 1 && variant.id !== undefined) url.searchParams.set('variant', String(variant.id));
      const name = label ? `${title} (${label})` : title;
      const record: VendorRecord = { vendorId: vendor, sku, normalizedSku: normalizeSku(sku, vendor), name, normalizedName: normalizeName(name),
        url: url.toString(), priceUsd: usd(variant.price, 'USD'), stock: variant.available === true ? 'in' : variant.available === false ? 'out' : 'unknown', stockQty: null,
        category: product.product_type?.trim().toLowerCase() || 'uncategorized', updatedAt, source: 'feed', parser: 'shopify-feed',
        ...(packFromText(label) ? pack(label, 'variant label') : pack(title, 'product name')) };
      return /^[A-Z0-9]+$/.test(record.normalizedSku) ? [record] : [];
    });
    if (!drafts.length) skippedProducts++;
    return drafts;
  });
  return { records, skippedProducts, empty: products.length === 0 };
}

/**
 * Turns one vendor product page into records. Variant rows win over the page-level Product node because they carry
 * each SKU's own price and pack label. A record needs a real vendor SKU; none is ever derived from the name.
 */
export function parseProductPage(vendor: VendorId, pageUrl: string, html: string, updatedAt: string): ParsedPage {
  if (html.length < 4000 && /This page has moved|window\.location\.href\s*=/.test(html) && !/application\/ld\+json/.test(html)) return { records: [], skip: 'redirect-stub' };
  const nodes = productNodes(html);
  const offersOf = (node: Record<string, unknown>) => (Array.isArray(node.offers) ? node.offers : node.offers ? [node.offers] : []) as Record<string, unknown>[];
  const title = decodeHtml((typeof nodes[0]?.name === 'string' ? nodes[0].name : meta(html, 'og:title') ?? '').trim());
  const category = typeof nodes[0]?.category === 'string' && nodes[0].category.trim() ? nodes[0].category.toLowerCase().trim() : 'uncategorized';
  let drafts: Draft[] = shopifyVariants(html, pageUrl, title, nodes.flatMap(offersOf));
  if (!drafts.length && title) drafts = bigCommerceVariants(html, pageUrl, title);
  if (!drafts.length) {
    drafts = nodes.flatMap(node => {
      const name = typeof node.name === 'string' ? decodeHtml(node.name.trim()) : '';
      const sku = typeof node.sku === 'string' ? node.sku.trim() : '';
      if (!name || !sku) return [];
      const offer = offersOf(node)[0];
      const inventory = offer?.inventoryLevel as Record<string, unknown> | undefined;
      const quantity = inventory?.value !== undefined && Number.isFinite(Number(inventory.value)) && Number(inventory.value) >= 0 ? Number(inventory.value) : null;
      return [{ name, sku, url: pageUrl, priceUsd: usd(offer?.price, offer?.priceCurrency), stock: stock(offer?.availability, quantity), stockQty: quantity, ...pack(name, 'product name'), parser: 'jsonld' as const }];
    });
  }
  if (!drafts.length) return { records: [], skip: nodes.length || title ? 'no-sku' : 'no-product-data' };
  const records = drafts.map(draft => ({ ...draft, vendorId: vendor, normalizedSku: normalizeSku(draft.sku, vendor), normalizedName: normalizeName(draft.name), category: draft.category ?? category, updatedAt, source: 'sitemap' as const }))
    .filter(record => /^[A-Z0-9]+$/.test(record.normalizedSku));
  return records.length ? { records: [...new Map(records.map(record => [record.normalizedSku, record])).values()], skip: null } : { records: [], skip: 'no-sku' };
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
const json = async <T>(kv: Kv, key: string): Promise<T | null> => {
  const raw = await kv.get(key);
  if (!raw) return null;
  try { return JSON.parse(raw) as T; } catch { return null; }
};
class VendorFetchError extends Error {}

/** Deletes a replaced generation after its grace period, at most `budget` keys per run. Never touches the live one. */
async function retirePrevious(vendor: VendorId, kv: Kv, pointer: CatalogPointer, budget: number) {
  const previous = pointer.previous;
  if (!previous) return 0;
  // A manual rollback that points back at the old generation must not then delete it.
  if (previous.gen === pointer.gen) { pointer.previous = null; return 0; }
  if (previous.deleteAfter > Date.now()) return 0;
  const keys = [indexKey(vendor, previous.gen), ...Array.from({ length: previous.batches }, (_, batch) => batchKey(vendor, previous.gen, batch))];
  let deleted = 0;
  while (previous.deleted < keys.length && deleted < budget) { await kv.delete(keys[previous.deleted]); previous.deleted++; deleted++; }
  // URL lists are small and few; they are removed with the last batch.
  if (previous.deleted >= keys.length) {
    for (let sitemap = 0; sitemap < 32; sitemap++) { const key = urlsKey(vendor, previous.gen, sitemap); if (await kv.get(key) === null) break; await kv.delete(key); }
    pointer.previous = null;
  }
  return deleted;
}

/**
 * One cron run for one vendor. It first publishes what earlier runs wrote, then fetches up to `maxProducts`
 * pages and appends their records as one batch. Publishing a run later (two hours on the cron schedule) is the
 * barrier that lets KV propagate the batch and index to every location before any reader is pointed at them.
 * Parse problems skip the page with a reason; network failures stop the run after saving what was fetched.
 */
export async function runVendor(vendor: VendorId, kv: Kv, fetcher: Fetcher = fetch, options: { maxProducts?: number; maxFeedPages?: number; maxRequests?: number; minRequestMs?: number; retireAfterMs?: number; now?: () => Date } = {}): Promise<VendorRun> {
  const started = Date.now();
  const now = options.now ?? (() => new Date());
  const maxProducts = Math.max(1, Math.min(options.maxProducts ?? 40, 500));
  const minRequestMs = options.minRequestMs ?? 500;
  // Each feed page is a large JSON document (about 1.5 MB for AndyMark); four keep one run's parsing modest.
  const maxFeedPages = Math.max(1, Math.min(options.maxFeedPages ?? 4, 20));
  // Every fetch attempt, retries included, counts against Cloudflare's 50-subrequest limit; a few are kept in reserve.
  const maxRequests = Math.max(2, options.maxRequests ?? 47);
  let requests = 0;
  const previousSnapshot = await json<VendorSnapshot>(kv, snapshotKey(vendor));
  let pointer = await json<CatalogPointer>(kv, pointerKey(vendor));
  let crawl = await json<Crawl>(kv, crawlKey(vendor));
  let fetched = 0; let upserted = 0; let skippedNow = 0; let lastRequest = 0; let published = false;
  const fetchText = async (url: string) => {
    const wait = minRequestMs - (Date.now() - lastRequest);
    if (wait > 0) await sleep(wait);
    lastRequest = Date.now();
    let response: Response;
    // A 429 is retried twice after the vendor's Retry-After (at most 10 s) before the run gives up.
    for (let attempt = 0; ; attempt++) {
      // A retry the run cannot afford ends the run like any 429; its progress is saved and the next run resumes.
      if (requests >= maxRequests) throw new VendorFetchError(attempt ? 'Vendor returned HTTP 429' : 'Request limit for this run reached');
      requests++;
      try { response = await fetcher(url, { headers: { 'user-agent': userAgent, accept: 'text/html,application/json,application/xml,text/xml;q=0.9' }, signal: AbortSignal.timeout(15000) }); }
      catch (cause) { throw new VendorFetchError(`Vendor request failed (${cause instanceof Error ? cause.name : 'error'})`); }
      if (response.status !== 429) break;
      if (attempt >= 2) throw new VendorFetchError('Vendor returned HTTP 429');
      const after = Number(response.headers.get('retry-after') ?? NaN);
      await sleep(Math.min(Number.isFinite(after) && after >= 0 ? after * 1000 : 2000, 10000));
      lastRequest = Date.now();
    }
    if (!response.ok) throw new VendorFetchError(`Vendor returned HTTP ${response.status}`);
    return response.text();
  };
  const skip = (reason: SkipReason, url: string) => {
    crawl!.skipped[reason] = (crawl!.skipped[reason] ?? 0) + 1;
    if (crawl!.skipSamples.length < 10) crawl!.skipSamples.push({ reason, url });
    skippedNow++;
  };
  const writeSnapshot = async (status: VendorSnapshot['status'], error?: string) => {
    const progress: CrawlProgress | null = crawl ? { phase: 'fetch', sitemapsDone: Math.max(0, crawl.sitemapIndex - (crawl.urlIndex < crawl.urlCount ? 1 : 0)), sitemapsTotal: crawl.sitemaps.length,
      pagesDoneInSitemap: crawl.urlIndex, pagesInSitemap: crawl.urlCount, recordsCollected: crawl.records } : null;
    const snapshot: VendorSnapshot = { status, updatedAt: pointer?.completedAt ?? (pointer ? pointer.publishedAt : null), lastRunAt: now().toISOString(), recordCount: pointer?.records ?? 0, source: 'sitemap',
      version: pointer?.gen ?? null, complete: pointer?.complete ?? false, skipped: crawl?.skipped ?? pointer?.skipped ?? {},
      ...(crawl ? { inProgress: true, progress } : {}), ...(error ? { error: error.slice(0, 200) } : {}) };
    await kv.put(snapshotKey(vendor), JSON.stringify(snapshot));
    return snapshot;
  };
  const savePointer = async (next: CatalogPointer) => { pointer = next; await kv.put(pointerKey(vendor), JSON.stringify(next)); };
  // Records fetched this run, appended as one batch. Written before any advanced position is saved, including on failure.
  const collected: VendorRecord[] = [];
  const flush = async () => {
    if (!crawl || !collected.length) return;
    const index = await json<IndexEntry[]>(kv, indexKey(vendor, crawl.gen)) ?? [];
    const batch = crawl.batches;
    const unique = [...new Map(collected.map(record => [record.normalizedSku, { ...record, catalogVersion: crawl!.gen }])).values()];
    await kv.put(batchKey(vendor, crawl.gen, batch), JSON.stringify(unique));
    // Records whose SKU is already in this generation keep the newer copy: the index points at the latest batch.
    const positions = new Map(index.map((entry, position) => [entry[0], position]));
    for (const record of unique) {
      const position = positions.get(record.normalizedSku);
      // Batches publish in order and every earlier batch is published by the next run, so the old batch covers the gap.
      if (position === undefined) { positions.set(record.normalizedSku, index.length); index.push([record.normalizedSku, record.normalizedName, batch]); }
      else index[position] = [record.normalizedSku, record.normalizedName, batch, index[position][2]];
    }
    await kv.put(indexKey(vendor, crawl.gen), JSON.stringify(index));
    crawl.batches++;
    crawl.records = index.length;
    upserted += unique.length;
    collected.length = 0;
  };
  try {
    if (!pointer) for (const key of legacyKeys(vendor)) if (await kv.get(key) !== null) await kv.delete(key);
    if (pointer?.previous) { await retirePrevious(vendor, kv, pointer, 20); await savePointer(pointer); }
    // Publish what earlier runs wrote.
    if (crawl && crawl.batches > 0) {
      const firstCrawl = !pointer || pointer.gen === crawl.gen;
      if (firstCrawl && (crawl.batches > (pointer?.batches ?? 0) || (crawl.done && !pointer?.complete))) {
        // No complete catalog exists yet, so the generation being built is the best available and goes live in parts.
        await savePointer({ gen: crawl.gen, complete: Boolean(crawl.done), records: crawl.records, batches: crawl.batches, publishedAt: now().toISOString(),
          completedAt: crawl.done ? now().toISOString() : null, skipped: crawl.skipped, previous: pointer?.previous ?? null });
        published = true;
      } else if (!firstCrawl && crawl.done) {
        const replaced = pointer!;
        await savePointer({ gen: crawl.gen, complete: true, records: crawl.records, batches: crawl.batches, publishedAt: now().toISOString(), completedAt: now().toISOString(), skipped: crawl.skipped,
          previous: { gen: replaced.gen, batches: replaced.batches ?? await countBatches(vendor, kv, replaced.gen), deleteAfter: Date.now() + (options.retireAfterMs ?? 24 * 3600000), deleted: 0 } });
        published = true;
      }
    }
    if (crawl?.done) {
      // Fully published; the next run starts a refresh.
      crawl = null;
      await kv.delete(crawlKey(vendor));
      await writeSnapshot('ok');
      const summary: VendorRun = { vendor, source: 'sitemap', fetched: 0, upserted: 0, skipped: 0, durationMs: Date.now() - started, complete: true };
      console.log(JSON.stringify({ ...summary, published }));
      return summary;
    }
    // A Shopify vendor's crawl started before the feed (a sitemap position) is dropped and restarted as a feed generation.
    if (vendorSources[vendor].feed && crawl && !crawl.sitemaps[0]?.includes('/products.json')) crawl = null;
    if (!crawl && pointer?.previous) {
      // The replaced generation is still awaiting deletion; a new refresh would overwrite that record and leak its keys.
      await writeSnapshot('ok');
      const summary: VendorRun = { vendor, source: 'sitemap', fetched: 0, upserted: 0, skipped: 0, durationMs: Date.now() - started, complete: true };
      console.log(JSON.stringify({ ...summary, published, waitingForRetirement: true }));
      return summary;
    }
    const robots = await fetchText(`${vendorSources[vendor].origin}/robots.txt`);
    if (vendorSources[vendor].feed) {
      if (!robotsAllows(robots, '/products.json')) throw new Error('robots.txt disallows the product feed');
      // Feed crawl state: urlIndex counts pages read, and sitemapIndex becomes 1 at the first empty page, which ends the crawl.
      crawl ??= { gen: crypto.randomUUID().slice(0, 8), startedAt: now().toISOString(), sitemaps: [feedUrl(vendor, 1)], sitemapIndex: 0, urlCount: 1, urlIndex: 0, batches: 0, records: 0, skipped: {}, skipSamples: [], failing: null, done: false };
      for (let pages = 0; pages < maxFeedPages && crawl.sitemapIndex < 1 && requests < maxRequests; pages++) {
        const page = crawl.urlIndex + 1;
        const feed = parseShopifyFeed(vendor, await fetchText(feedUrl(vendor, page)), now().toISOString());
        fetched++;
        if (feed.empty) { crawl.sitemapIndex = 1; crawl.urlCount = crawl.urlIndex; break; }
        for (let n = 0; n < feed.skippedProducts; n++) skip('no-sku', feedUrl(vendor, page));
        collected.push(...feed.records);
        crawl.urlIndex = page; crawl.urlCount = page + 1;
      }
    } else {
      if (!crawl) {
        const root = await fetchText(vendorSources[vendor].sitemap);
        const sitemaps = sitemapLocations(root).filter(url => /(?:type=products|sitemap_products)/i.test(url) && allowedUrl(vendor, url));
        if (!sitemaps.length) throw new Error('No public product sitemap found');
        crawl = { gen: crypto.randomUUID().slice(0, 8), startedAt: now().toISOString(), sitemaps, sitemapIndex: 0, urlCount: 0, urlIndex: 0, batches: 0, records: 0, skipped: {}, skipSamples: [], failing: null, done: false };
      }
      let urls: string[] = crawl.sitemapIndex > 0 ? await json<string[]>(kv, urlsKey(vendor, crawl.gen, crawl.sitemapIndex - 1)) ?? [] : [];
      while (fetched < maxProducts && requests < maxRequests) {
        if (crawl.urlIndex >= crawl.urlCount) {
          if (crawl.sitemapIndex >= crawl.sitemaps.length) break;
          const xml = await fetchText(crawl.sitemaps[crawl.sitemapIndex]);
          urls = sitemapLocations(xml).filter(url => allowedUrl(vendor, url) && (!['andymark', 'pitsco'].includes(vendor) || new URL(url).pathname.startsWith('/products/')));
          await kv.put(urlsKey(vendor, crawl.gen, crawl.sitemapIndex), JSON.stringify(urls));
          crawl.sitemapIndex++; crawl.urlIndex = 0; crawl.urlCount = urls.length;
          continue;
        }
        const url = urls[crawl.urlIndex];
        if (!url) { crawl.urlIndex = crawl.urlCount; continue; }
        if (!robotsAllows(robots, new URL(url).pathname)) { skip('robots-disallowed', url); crawl.urlIndex++; continue; }
        let html: string;
        try { html = await fetchText(url); }
        catch (cause) {
          if (!(cause instanceof VendorFetchError)) throw cause;
          crawl.failing = crawl.failing?.url === url ? { url, runs: crawl.failing.runs + 1 } : { url, runs: 1 };
          if (crawl.failing.runs < maxFailingRuns) throw cause;
          skip('fetch-failed', url); crawl.failing = null; crawl.urlIndex++; fetched++;
          continue;
        }
        fetched++;
        crawl.urlIndex++;
        if (crawl.failing?.url === url) crawl.failing = null;
        const page = parseProductPage(vendor, url, html, now().toISOString());
        if (page.skip) { skip(page.skip, url); continue; }
        collected.push(...page.records.filter(record => allowedUrl(vendor, record.url)));
      }
    }
    await flush();
    if (crawl.sitemapIndex >= crawl.sitemaps.length && crawl.urlIndex >= crawl.urlCount) {
      if (!crawl.records) {
        // Every page was skipped, for example behind a temporary challenge page. Keep the live catalog and start over next run.
        const reason = `Crawl finished with no usable records (${JSON.stringify(crawl.skipped)})`;
        crawl = null;
        await kv.delete(crawlKey(vendor));
        throw new Error(reason);
      }
      crawl.done = true;
    }
    await kv.put(crawlKey(vendor), JSON.stringify(crawl));
    await writeSnapshot('ok');
    const summary: VendorRun = { vendor, source: 'sitemap', fetched, upserted, skipped: skippedNow, durationMs: Date.now() - started, complete: false };
    console.log(JSON.stringify({ ...summary, published }));
    return summary;
  } catch (cause) {
    if (crawl) {
      // Pages fetched before the failure are kept: their records are written before the advanced position is saved.
      try { await flush(); } catch (flushError) { console.error(JSON.stringify({ vendor, flushFailed: flushError instanceof Error ? flushError.name : 'unknown' })); throw cause; }
      await kv.put(crawlKey(vendor), JSON.stringify(crawl));
    }
    const snapshot = await writeSnapshot('failed', cause instanceof Error ? cause.message : 'Unknown ingestion error');
    console.error(JSON.stringify({ vendor, fetched, upserted, skipped: skippedNow, durationMs: Date.now() - started, error: snapshot.error, previousStatus: previousSnapshot?.status ?? null }));
    throw cause;
  }
}

/** Batch numbers are dense from zero, so the count is the first missing key. Only for pointers written before `batches` existed. */
async function countBatches(vendor: VendorId, kv: Kv, gen: string) {
  let count = 0;
  while (count < 10000 && await kv.get(batchKey(vendor, gen, count)) !== null) count++;
  return count;
}
