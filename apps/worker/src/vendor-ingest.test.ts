import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { VendorId, VendorRecord } from '@control-kit/shared';
import type { Kv } from './index';
import { batchKey, feedUrl, indexKey, packFromText, parseProductPage, parseShopifyFeed, pointerKey, runVendor, snapshotKey, vendorSources, type CatalogPointer, type IndexEntry, type VendorSnapshot } from './vendor-ingest';

class MemoryKv implements Kv {
  values = new Map<string, string>();
  puts = 0;
  async get(key: string) { return this.values.get(key) ?? null; }
  async put(key: string, value: string) { this.puts++; this.values.set(key, value); }
  async delete(key: string) { this.values.delete(key); }
}
type Fixture = { capturedFrom: { root: string; sitemapUrl: string; productUrl: string }; rootXml: string; productXml: string; productHtml: string };
const vendors: VendorId[] = ['gobilda', 'servocity', 'andymark', 'rev', 'pitsco'];
const captured = (vendor: VendorId): Fixture => JSON.parse(readFileSync(new URL(`../../../fixtures/vendors/captured/${vendor}.json`, import.meta.url), 'utf8')) as Fixture;
const page = (name: string) => readFileSync(new URL(`../../../fixtures/vendors/pages/${name}.html`, import.meta.url), 'utf8');
const json = <T>(kv: MemoryKv, key: string) => JSON.parse(kv.values.get(key) ?? 'null') as T;
const quiet = () => { vi.spyOn(console, 'log').mockImplementation(() => {}); vi.spyOn(console, 'error').mockImplementation(() => {}); };
const run = (vendor: VendorId, kv: Kv, fetcher: (url: string) => Promise<Response>, options: Parameters<typeof runVendor>[3] = {}) => runVendor(vendor, kv, fetcher, { minRequestMs: 0, ...options });

/** A vendor site with one product sitemap; `pages` maps product URL → HTML or a Response to return. */
function site(vendor: VendorId, pages: Record<string, string | (() => Response)>, robots = 'User-agent: *\nAllow: /') {
  const origin = vendorSources[vendor].origin;
  const sitemap = vendor === 'andymark' || vendor === 'pitsco' ? `${origin}/sitemap_products_1.xml` : `${origin}/xmlsitemap.php?type=products&page=1`;
  const fetcher = vi.fn(async (url: string) => {
    if (url === `${origin}/robots.txt`) return new Response(robots);
    if (url === vendorSources[vendor].sitemap) return new Response(`<sitemapindex><sitemap><loc>${sitemap.replace('&', '&amp;')}</loc></sitemap></sitemapindex>`);
    if (url === sitemap) return new Response(`<urlset>${Object.keys(pages).map(loc => `<url><loc>${loc}</loc></url>`).join('')}</urlset>`);
    const body = pages[url];
    return typeof body === 'function' ? body() : body === undefined ? new Response('missing', { status: 404 }) : new Response(body);
  });
  return fetcher;
}
const product = (name: string, sku: string | null, price = '5.00') => `<script type="application/ld+json">${JSON.stringify({ '@type': 'Product', name, ...(sku ? { sku } : {}), offers: { price, priceCurrency: 'USD', availability: 'https://schema.org/InStock' } })}</script>`;
async function records(kv: MemoryKv, vendor: VendorId) {
  const pointer = json<CatalogPointer>(kv, pointerKey(vendor));
  const index = json<IndexEntry[]>(kv, indexKey(vendor, pointer.gen));
  const found: VendorRecord[] = [];
  // Same rule as the scan reader: an unpublished batch falls back to the entry's previous batch, if any.
  const published = pointer.batches ?? Infinity;
  const visible = index.flatMap(([sku, name, batch, previous]): IndexEntry[] => batch < published ? [[sku, name, batch]] : previous !== undefined && previous < published ? [[sku, name, previous]] : []);
  for (const [sku, , batch] of visible) found.push(json<VendorRecord[]>(kv, batchKey(vendor, pointer.gen, batch)).find(record => record.normalizedSku === sku)!);
  return found;
}

describe('vendor product page parsing', () => {
  const at = '2026-10-24T12:00:00.000Z';
  it('reads every goBILDA variant row with its own SKU, price, and pack evidence', () => {
    const url = 'https://www.gobilda.com/2801-series-zinc-plated-steel-washer-4mm-id-x-8mm-od/';
    const parsed = parseProductPage('gobilda', url, page('gobilda-variant-family'), at);
    expect(parsed.skip).toBeNull();
    expect(parsed.records.map(record => [record.sku, record.normalizedSku, record.priceUsd, record.packSize, record.packSizeVerified, record.packEvidence, record.parser])).toEqual([
      ['2801-0004-0008', '280100040008', 1.99, 25, true, 'variant label "25 Pack"', 'bigcommerce-variant'],
      ['2801-0004-0008-250pk', '280100040008250PK', 9.99, 250, true, 'variant label "250 Pack"', 'bigcommerce-variant'],
    ]);
    expect(parsed.records[0]).toMatchObject({ url, vendorId: 'gobilda', stock: 'unknown' });
  });
  it('reads single products from Product JSON-LD; goBILDA and REV name every pack, so no wording means one unit', () => {
    const motor = parseProductPage('gobilda', 'https://www.gobilda.com/motor/', page('gobilda-single-product'), at).records;
    expect(motor).toHaveLength(1);
    expect(motor[0]).toMatchObject({ sku: '5203-2402-0019', normalizedSku: '520324020019', priceUsd: 54.99, stock: 'out', packSize: 1, packSizeVerified: true, packEvidence: 'sold individually: no pack wording, and this vendor names every multi-unit product' });
    const rev = parseProductPage('rev', 'https://www.revrobotics.com/rev-41-1600/', page('rev-single-product'), at).records;
    expect(rev[0]).toMatchObject({ sku: 'REV-41-1600', normalizedSku: '411600', priceUsd: 50, stock: 'in', parser: 'jsonld' });
  });
  it('takes pack size from a "Pack Info" product field or a -PKn SKU, and never assumes one unit for ServoCity', () => {
    const jsonld = (name: string, sku: string) => `<script type="application/ld+json">${JSON.stringify({ '@type': 'Product', name, sku, offers: { price: '3.99', priceCurrency: 'USD' } })}</script>`;
    // As ServoCity embeds it: JSON inside a string (escaped quotes), the page's own product first, then related products.
    const own = (id: number, pack: string | null) => JSON.stringify({ add_to_wishlist_url: `https://www.servocity.com/wishlist.php?action=add&product_id=${id}`,
      custom_fields: [{ id: '1', name: 'spec_Material', value: 'Steel' }, ...(pack ? [{ id: '2', name: 'Pack Info', value: pack }] : [])] });
    const related = JSON.stringify({ sku: '2806-0005-0004', custom_fields: [{ id: '9', name: 'Pack Info', value: '25 Pack' }] });
    const embedded = (...objects: string[]) => `<script>window.stencil = ${JSON.stringify(objects.join(','))};</script>`;
    const screw = parseProductPage('servocity', 'https://www.servocity.com/screw/', jsonld('6-32 x 0.750" Zinc-Plated Socket Head Machine Screw', '632120') + embedded(own(3803, '25 Pack')), at).records[0];
    expect(screw).toMatchObject({ packSize: 25, packSizeVerified: true, packEvidence: 'product field "Pack Info: 25 Pack"' });
    // A related product's Pack Info (the set screw listed with a pinion) never counts for the page's own product.
    const pinion = parseProductPage('servocity', 'https://www.servocity.com/pinion/', jsonld('2303 Series Steel Pinion Gear (30 Tooth)', '2303-4008-0030') + embedded(own(3803, null), related), at).records[0];
    expect(pinion.packEvidence ?? '').not.toContain('Pack Info');
    // Spacing and key order in the embedded JSON do not matter.
    const spaced = '<script>var data = { "add_to_wishlist_url": "/wishlist.php?action=add&product_id=77", "custom_fields": [ { "value": "12 Pack", "id": "1", "name": "Pack Info" } ] };</script>';
    expect(parseProductPage('servocity', 'https://www.servocity.com/nut/', jsonld('6-32 Hex Nut', '632000') + spaced, at).records[0]).toMatchObject({ packSize: 12, packSizeVerified: true });
    const plain = parseProductPage('servocity', 'https://www.servocity.com/spacer/', jsonld('1504 Series 32mm OD Pattern Spacer (4mm Length)', '1504-0032-0040'), at).records[0];
    expect(plain).toMatchObject({ packSize: null, packSizeVerified: false });
    const cables = parseProductPage('rev', 'https://www.revrobotics.com/rev-31-1413/', jsonld('JST VH 2-pin Motor Cables', 'REV-31-1413-PK4'), at).records[0];
    expect(cables).toMatchObject({ packSize: 4, packSizeVerified: true, packEvidence: 'SKU suffix "PK4"' });
    // Pack wording on the product itself still wins over the convention.
    const washers = parseProductPage('gobilda', 'https://www.gobilda.com/washer/', page('gobilda-variant-family'), at).records;
    expect(washers.map(record => record.packSize)).toEqual([25, 250]);
  });
  it('reads every Shopify variant SKU with a variant-specific product link', () => {
    const url = 'https://andymark.com/products/neverest-orbital-gearmotors';
    const parsed = parseProductPage('andymark', url, page('andymark-variant-family'), at).records;
    expect(parsed).toHaveLength(8);
    expect(parsed[0]).toMatchObject({ sku: 'am-5185a', normalizedSku: '5185A', priceUsd: 22, parser: 'shopify-variant', sourceUrl: url });
    expect(parsed[0].url).toMatch(/^https:\/\/andymark\.com\/products\/neverest-orbital-gearmotors\?variant=\d+$/);
    expect(new Set(parsed.map(record => record.url)).size).toBe(8);
    expect(parsed[0].name).toContain('Anderson Powerpole');
  });
  it('keeps numeric-only Pitsco SKUs', () => {
    const parsed = parseProductPage('pitsco', 'https://www.pitsco.com/products/tetrix-max-torquenado-motor-with-encoder', page('pitsco-numeric-sku'), at).records;
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({ sku: '44260', normalizedSku: '44260', priceUsd: 30.75, stock: 'in' });
    expect(parsed[0].url).not.toContain('variant=');
  });
  it('skips redirect stubs and pages without a vendor SKU instead of inventing one', () => {
    expect(parseProductPage('servocity', 'https://www.servocity.com/moved/', page('servocity-moved-stub'), at)).toEqual({ records: [], skip: 'redirect-stub' });
    expect(parseProductPage('rev', 'https://www.revrobotics.com/x/', product('Mystery Bracket', null), at)).toEqual({ records: [], skip: 'no-sku' });
    expect(parseProductPage('rev', 'https://www.revrobotics.com/x/', '<html><body>About us</body></html>', at)).toEqual({ records: [], skip: 'no-product-data' });
  });
  it('falls back to the Shopify product title for pack evidence when the variant has no label', () => {
    const meta = { product: { variants: [{ id: 1, sku: '40001', price: 899, name: 'Socket Screws (Pack of 10)', public_title: null }] } };
    const html = `${product('Socket Screws (Pack of 10)', '40001', '8.99')}<script>\n  window.ShopifyAnalytics.meta.currency = 'USD';\n  var meta = ${JSON.stringify(meta)};\n  for (var attr in meta) {}\n</script>`;
    const [record] = parseProductPage('pitsco', 'https://www.pitsco.com/products/screws', html, at).records;
    expect(record).toMatchObject({ packSize: 10, packSizeVerified: true, packEvidence: 'product name "Pack of 10"' });
  });
  it('accepts only explicit pack wording as pack evidence', () => {
    expect(packFromText('M3 Screws (Pack of 10)')).toEqual({ size: 10, phrase: 'Pack of 10' });
    expect(packFromText('25 Pack')).toEqual({ size: 25, phrase: '25 Pack' });
    expect(packFromText('Hex Shaft 4-pk')).toEqual({ size: 4, phrase: '4-pk' });
    expect(packFromText('Set of 2')).toEqual({ size: 2, phrase: 'Set of 2' });
    expect(packFromText('5203 Series Motor (19.2:1 Ratio, 312 RPM)')).toBeNull();
    expect(packFromText('96mm Wheel')).toBeNull();
  });
});

describe('vendor catalog crawl and publication', () => {
  it.each(vendors.filter(vendor => !vendorSources[vendor].feed))('%s publishes its captured product on the run after it was fetched', async vendor => {
    quiet();
    const data = captured(vendor);
    const kv = new MemoryKv();
    const fetcher = async (url: string) => {
      if (url === `${vendorSources[vendor].origin}/robots.txt`) return new Response('User-agent: *\nAllow: /');
      const body = url === data.capturedFrom.root ? data.rootXml : url === data.capturedFrom.sitemapUrl ? data.productXml : url === data.capturedFrom.productUrl ? data.productHtml : null;
      return body === null ? new Response('missing', { status: 404 }) : new Response(body);
    };
    const first = await run(vendor, kv, fetcher);
    expect(first).toMatchObject({ vendor, fetched: 1, upserted: 1, complete: false });
    // Publication barrier: nothing a run writes is visible to scans until a later run publishes it.
    expect(kv.values.has(pointerKey(vendor))).toBe(false);
    const second = await run(vendor, kv, fetcher);
    expect(second).toMatchObject({ fetched: 0, complete: true });
    expect(json<CatalogPointer>(kv, pointerKey(vendor))).toMatchObject({ complete: true, records: 1, batches: 1 });
    const [record] = await records(kv, vendor);
    expect(record.url).toBe(data.capturedFrom.productUrl);
    expect(record.priceUsd).toBeGreaterThan(0);
    expect(json<VendorSnapshot>(kv, snapshotKey(vendor))).toMatchObject({ status: 'ok', complete: true, recordCount: 1 });
    vi.restoreAllMocks();
  });
  it('skips the ServoCity page that froze production, keeps crawling, and reports the skip after completion', async () => {
    quiet();
    const kv = new MemoryKv();
    const fetcher = site('servocity', {
      'https://www.servocity.com/16awg-premium-silicone-jacket-wire-black-3m-length/': page('servocity-moved-stub'),
      'https://www.servocity.com/aluminum-channel/': product('1120 Series U-Channel (5 Hole, 120mm Length)', '1120-0005-0120', '7.99'),
    });
    expect(await run('servocity', kv, fetcher)).toMatchObject({ fetched: 2, upserted: 1, skipped: 1 });
    await run('servocity', kv, fetcher);
    expect(json<VendorSnapshot>(kv, snapshotKey('servocity'))).toMatchObject({ status: 'ok', recordCount: 1, complete: true, skipped: { 'redirect-stub': 1 } });
    vi.restoreAllMocks();
  });
  it('publishes the first crawl in parts, one run behind, and labels it incomplete until done', async () => {
    quiet();
    const kv = new MemoryKv();
    const pages = Object.fromEntries(Array.from({ length: 5 }, (_, n) => [`https://www.revrobotics.com/p${n}/`, product(`Part ${n}`, `REV-41-100${n}`)]));
    const fetcher = site('rev', pages);
    await run('rev', kv, fetcher, { maxProducts: 2 });
    expect(kv.values.has(pointerKey('rev'))).toBe(false);
    expect(json<VendorSnapshot>(kv, snapshotKey('rev'))).toMatchObject({ status: 'ok', version: null, inProgress: true, progress: { pagesDoneInSitemap: 2, pagesInSitemap: 5, recordsCollected: 2 } });
    await run('rev', kv, fetcher, { maxProducts: 2 });
    // The second run published the first run's batch; its own batch waits for the third run.
    expect(json<CatalogPointer>(kv, pointerKey('rev'))).toMatchObject({ complete: false, records: 2, batches: 1, completedAt: null });
    expect(await records(kv, 'rev')).toHaveLength(2);
    await run('rev', kv, fetcher, { maxProducts: 2 });
    expect(json<CatalogPointer>(kv, pointerKey('rev'))).toMatchObject({ complete: false, records: 4, batches: 2 });
    expect(await run('rev', kv, fetcher, { maxProducts: 2 })).toMatchObject({ complete: true });
    expect(json<CatalogPointer>(kv, pointerKey('rev'))).toMatchObject({ complete: true, records: 5, batches: 3 });
    expect((await records(kv, 'rev')).map(record => record.normalizedSku).sort()).toEqual(['411000', '411001', '411002', '411003', '411004']);
    expect(kv.values.has('cat:rev:crawl')).toBe(false);
    vi.restoreAllMocks();
  });
  it('keeps a steady-state run within a few KV writes regardless of catalog size', async () => {
    quiet();
    const kv = new MemoryKv();
    const pages = Object.fromEntries(Array.from({ length: 120 }, (_, n) => [`https://www.gobilda.com/p${n}/`, product(`Part ${n}`, `1000-0000-${String(n).padStart(4, '0')}`)]));
    const fetcher = site('gobilda', pages);
    await run('gobilda', kv, fetcher, { maxProducts: 40 });
    await run('gobilda', kv, fetcher, { maxProducts: 40 });
    kv.puts = 0;
    await run('gobilda', kv, fetcher, { maxProducts: 40 });
    // pointer + batch + index + crawl + snapshot
    expect(kv.puts).toBeLessThanOrEqual(5);
    vi.restoreAllMocks();
  });
  it('keeps a published product visible while a later page re-lists its SKU', async () => {
    quiet();
    const kv = new MemoryKv();
    const fetcher = site('servocity', {
      'https://www.servocity.com/a/': product('Hub', '1001', '5.00'),
      'https://www.servocity.com/b/': product('Spacer', '1002', '1.00'),
      'https://www.servocity.com/c/': product('Hub (bundle page)', '1001', '6.00'),
    });
    await run('servocity', kv, fetcher, { maxProducts: 2 });
    await run('servocity', kv, fetcher, { maxProducts: 2 });
    // Run 2 published run 1's batch and wrote the re-listed hub to batch 1, which is not yet published.
    expect((await records(kv, 'servocity')).find(record => record.normalizedSku === '1001')?.priceUsd).toBe(5);
    await run('servocity', kv, fetcher, { maxProducts: 2 });
    expect((await records(kv, 'servocity')).find(record => record.normalizedSku === '1001')?.priceUsd).toBe(6);
    vi.restoreAllMocks();
  });
  it('keeps records fetched before a failing page and resumes after it', async () => {
    quiet();
    const kv = new MemoryKv();
    let broken = true;
    const fetcher = site('rev', {
      'https://www.revrobotics.com/a/': product('Shaft A', 'REV-21-0001'),
      'https://www.revrobotics.com/b/': () => broken ? new Response('unavailable', { status: 503 }) : new Response(product('Shaft B', 'REV-21-0002')),
      'https://www.revrobotics.com/c/': product('Shaft C', 'REV-21-0003'),
    });
    await expect(run('rev', kv, fetcher)).rejects.toThrow('HTTP 503');
    broken = false;
    await run('rev', kv, fetcher);
    await run('rev', kv, fetcher);
    expect((await records(kv, 'rev')).map(record => record.normalizedSku).sort()).toEqual(['210001', '210002', '210003']);
    vi.restoreAllMocks();
  });
  it('holds position on a failing page, then skips it after three consecutive failed runs', async () => {
    quiet();
    const kv = new MemoryKv();
    const fetcher = site('gobilda', {
      'https://www.gobilda.com/broken/': () => new Response('unavailable', { status: 503 }),
      'https://www.gobilda.com/motor/': product('Yellow Jacket Motor', '5203-2402-0019', '44.99'),
    });
    for (let attempt = 1; attempt <= 2; attempt++) {
      await expect(run('gobilda', kv, fetcher)).rejects.toThrow('HTTP 503');
      expect(json<VendorSnapshot>(kv, snapshotKey('gobilda'))).toMatchObject({ status: 'failed', error: 'Vendor returned HTTP 503', version: null });
    }
    expect(await run('gobilda', kv, fetcher)).toMatchObject({ upserted: 1, skipped: 1 });
    await run('gobilda', kv, fetcher);
    expect(json<VendorSnapshot>(kv, snapshotKey('gobilda'))).toMatchObject({ status: 'ok', recordCount: 1, complete: true, skipped: { 'fetch-failed': 1 } });
    vi.restoreAllMocks();
  });
  it('restarts a crawl that ended with no usable records instead of failing forever', async () => {
    quiet();
    const kv = new MemoryKv();
    let challenge = true;
    const fetcher = site('rev', { 'https://www.revrobotics.com/a/': () => new Response(challenge ? '<html><body>Checking your browser</body></html>' : product('Shaft A', 'REV-21-0001')) });
    await expect(run('rev', kv, fetcher)).rejects.toThrow('no usable records');
    expect(kv.values.has('cat:rev:crawl')).toBe(false);
    challenge = false;
    await run('rev', kv, fetcher);
    await run('rev', kv, fetcher);
    expect(json<CatalogPointer>(kv, pointerKey('rev'))).toMatchObject({ complete: true, records: 1 });
    vi.restoreAllMocks();
  });
  it('honors robots.txt per product page', async () => {
    quiet();
    const kv = new MemoryKv();
    const fetcher = site('rev', { 'https://www.revrobotics.com/private/x/': product('Hidden', 'REV-1'), 'https://www.revrobotics.com/ok/': product('Shown', 'REV-2') }, 'User-agent: *\nDisallow: /private/');
    expect(await run('rev', kv, fetcher)).toMatchObject({ upserted: 1, skipped: 1 });
    expect(fetcher).not.toHaveBeenCalledWith('https://www.revrobotics.com/private/x/', expect.anything());
    vi.restoreAllMocks();
  });
  it('builds a refresh beside the live catalog, switches when complete, and retires the old one later', async () => {
    quiet();
    const kv = new MemoryKv();
    let price = '5.00';
    const pages = Object.fromEntries(Array.from({ length: 3 }, (_, n) => [`https://www.revrobotics.com/p${n}/`, () => new Response(product(`Part ${n}`, `REV-41-200${n}`, price))]));
    const fetcher = site('rev', pages);
    await run('rev', kv, fetcher, { maxProducts: 10 });
    await run('rev', kv, fetcher, { maxProducts: 10 });
    const first = json<CatalogPointer>(kv, pointerKey('rev'));
    expect(first.complete).toBe(true);
    price = '6.00';
    await run('rev', kv, fetcher, { maxProducts: 2, retireAfterMs: 0 });
    await run('rev', kv, fetcher, { maxProducts: 2, retireAfterMs: 0 });
    expect(json<CatalogPointer>(kv, pointerKey('rev')).gen).toBe(first.gen);
    expect((await records(kv, 'rev')).every(record => record.priceUsd === 5)).toBe(true);
    await run('rev', kv, fetcher, { maxProducts: 2, retireAfterMs: 0 });
    const second = json<CatalogPointer>(kv, pointerKey('rev'));
    expect(second).toMatchObject({ complete: true, records: 3, previous: { gen: first.gen } });
    expect((await records(kv, 'rev')).every(record => record.priceUsd === 6)).toBe(true);
    expect(kv.values.has(indexKey('rev', first.gen))).toBe(true);
    await run('rev', kv, fetcher, { maxProducts: 1, retireAfterMs: 0 });
    expect(kv.values.has(indexKey('rev', first.gen))).toBe(false);
    expect([...kv.values.keys()].some(key => key.startsWith(`cat:rev:gen:${first.gen}:`))).toBe(false);
    vi.restoreAllMocks();
  });
  it('never deletes the live generation after a manual rollback to the previous one', async () => {
    quiet();
    const kv = new MemoryKv();
    kv.values.set(pointerKey('rev'), JSON.stringify({ gen: 'old', complete: true, records: 1, batches: 1, publishedAt: '2026-10-24T00:00:00Z', completedAt: '2026-10-24T00:00:00Z', previous: { gen: 'old', batches: 1, deleteAfter: 0, deleted: 0 } }));
    kv.values.set(batchKey('rev', 'old', 0), JSON.stringify([]));
    kv.values.set(indexKey('rev', 'old'), JSON.stringify([]));
    await run('rev', kv, site('rev', { 'https://www.revrobotics.com/a/': product('A', 'REV-21-0001') }));
    expect(kv.values.has(indexKey('rev', 'old'))).toBe(true);
    expect(kv.values.has(batchKey('rev', 'old', 0))).toBe(true);
    expect(json<CatalogPointer>(kv, pointerKey('rev')).previous).toBeNull();
    vi.restoreAllMocks();
  });
  it('removes the old crawl keys that froze production when the new pipeline first runs', async () => {
    quiet();
    const kv = new MemoryKv();
    kv.values.set('vendor:gobilda:__cursor__', JSON.stringify({ urls: ['x'], records: {} }));
    await run('gobilda', kv, site('gobilda', { 'https://www.gobilda.com/a/': product('A', '1000-0000-0001') }));
    expect(kv.values.has('vendor:gobilda:__cursor__')).toBe(false);
    vi.restoreAllMocks();
  });
  it('drops records whose links point off the vendor site', () => {
    const found = parseProductPage('andymark', 'https://andymark.com/products/neverest-orbital-gearmotors', page('andymark-variant-family'), '2026-10-24T00:00:00Z').records;
    expect(found.length).toBe(8);
    expect(found.every(record => new URL(record.url).hostname === 'andymark.com')).toBe(true);
  });
});

/** A Shopify store's feed: `pages[n]` is the products on page n + 1; later pages are empty. */
function shopify(vendor: VendorId, pages: unknown[][], robots = 'User-agent: *\nAllow: /') {
  return vi.fn(async (url: string) => {
    if (url === `${vendorSources[vendor].origin}/robots.txt`) return new Response(robots);
    const page = Number(new URL(url).searchParams.get('page'));
    if (url !== feedUrl(vendor, page)) return new Response('missing', { status: 404 });
    return new Response(JSON.stringify({ products: pages[page - 1] ?? [] }));
  });
}
const feedProduct = (title: string, handle: string, variants: Array<{ id: number; title: string; sku: string | null; price: string; available: boolean }>, type = 'Hardware') => ({ title, handle, product_type: type, variants });

describe('Shopify product feed (AndyMark, Pitsco)', () => {
  it('reads every variant with its own SKU, price, availability, and pack evidence', () => {
    const { records: found, skippedProducts } = parseShopifyFeed('andymark', JSON.stringify({ products: [
      feedProduct('Hex Shaft Collar', 'hex-collar', [{ id: 1, title: '1/2in Hex', sku: 'am-1001', price: '4.00', available: true }, { id: 2, title: '10 Pack', sku: 'am-1001_10', price: '35.00', available: false }]),
      feedProduct('Gift Card', 'gift-card', [{ id: 3, title: 'Default Title', sku: '', price: '25.00', available: true }]),
      feedProduct('Climber Hook &amp; Plate', 'hook', [{ id: 4, title: 'Default Title', sku: 'am-2000', price: '12.5', available: true }]),
    ] }), '2026-10-24T00:00:00Z');
    expect(skippedProducts).toBe(1);
    expect(found.map(record => [record.sku, record.name, record.priceUsd, record.stock, record.packSize, record.packSizeVerified, record.url])).toEqual([
      ['am-1001', 'Hex Shaft Collar (1/2in Hex)', 4, 'in', null, false, 'https://andymark.com/products/hex-collar?variant=1'],
      ['am-1001_10', 'Hex Shaft Collar (10 Pack)', 35, 'out', 10, true, 'https://andymark.com/products/hex-collar?variant=2'],
      ['am-2000', 'Climber Hook & Plate', 12.5, 'in', null, false, 'https://andymark.com/products/hook'],
    ]);
    expect(found[0]).toMatchObject({ vendorId: 'andymark', source: 'feed', parser: 'shopify-feed', category: 'hardware', packEvidence: null });
    expect(found[1].packEvidence).toBe('variant label "10 Pack"');
  });
  it('crawls feed pages until an empty page, then publishes on the next run', async () => {
    quiet();
    const kv = new MemoryKv();
    const products = (from: number, count: number) => Array.from({ length: count }, (_, n) => feedProduct(`Part ${from + n}`, `part-${from + n}`, [{ id: from + n, title: 'Default Title', sku: `${40000 + from + n}`, price: '1.00', available: true }]));
    const fetcher = shopify('pitsco', [products(0, 3), products(3, 3), products(6, 2)]);
    expect(await run('pitsco', kv, fetcher, { maxFeedPages: 2 })).toMatchObject({ fetched: 2, upserted: 6, complete: false });
    expect(kv.values.has(pointerKey('pitsco'))).toBe(false);
    // Page 3 has products, page 4 is empty: the crawl ends there.
    expect(await run('pitsco', kv, fetcher, { maxFeedPages: 2 })).toMatchObject({ fetched: 2, upserted: 2 });
    expect(json<CatalogPointer>(kv, pointerKey('pitsco'))).toMatchObject({ complete: false, batches: 1 });
    expect(await run('pitsco', kv, fetcher, { maxFeedPages: 2 })).toMatchObject({ fetched: 0, complete: true });
    expect(json<CatalogPointer>(kv, pointerKey('pitsco'))).toMatchObject({ complete: true, records: 8, batches: 2 });
    expect((await records(kv, 'pitsco')).length).toBe(8);
    expect(fetcher.mock.calls.map(([url]) => url).filter(url => url.includes('products.json'))).toEqual([1, 2, 3, 4].map(page => feedUrl('pitsco', page)));
    vi.restoreAllMocks();
  });
  it('retries a rate-limited request after Retry-After before failing the run', async () => {
    quiet();
    const kv = new MemoryKv();
    const feed = shopify('andymark', [[feedProduct('Hub', 'hub', [{ id: 1, title: 'Default Title', sku: 'am-1001', price: '5.00', available: true }])]]);
    let limited = 2;
    const fetcher = async (url: string) => url.includes('products.json') && limited-- > 0 ? new Response('slow down', { status: 429, headers: { 'retry-after': '0' } }) : feed(url);
    expect(await run('andymark', kv, fetcher)).toMatchObject({ upserted: 1 });
    limited = 3;
    await expect(run('andymark', new MemoryKv(), fetcher)).rejects.toThrow('HTTP 429');
    vi.restoreAllMocks();
  });
  it('rejects a feed response without a product list instead of ending the crawl', () => {
    expect(() => parseShopifyFeed('pitsco', '{}', '2026-10-24T00:00:00Z')).toThrow('no product list');
    expect(() => parseShopifyFeed('pitsco', '{"errors":"Not Found"}', '2026-10-24T00:00:00Z')).toThrow('no product list');
    expect(parseShopifyFeed('pitsco', '{"products":[]}', '2026-10-24T00:00:00Z').empty).toBe(true);
  });
  it('restarts a Shopify crawl begun from the sitemap as a feed crawl', async () => {
    quiet();
    const kv = new MemoryKv();
    await kv.put('cat:andymark:crawl', JSON.stringify({ gen: 'oldgen', startedAt: '2026-10-24T00:00:00Z', sitemaps: ['https://andymark.com/sitemap_products_1.xml'], sitemapIndex: 1, urlCount: 500, urlIndex: 40, batches: 0, records: 0, skipped: {}, skipSamples: [], failing: null, done: false }));
    const fetcher = shopify('andymark', [[feedProduct('Hub', 'hub', [{ id: 1, title: 'Default Title', sku: 'am-1001', price: '5.00', available: true }])]]);
    expect(await run('andymark', kv, fetcher)).toMatchObject({ upserted: 1 });
    expect(json<{ gen: string; sitemaps: string[] }>(kv, 'cat:andymark:crawl')).toMatchObject({ sitemaps: [feedUrl('andymark', 1)] });
    expect(json<{ gen: string }>(kv, 'cat:andymark:crawl').gen).not.toBe('oldgen');
    vi.restoreAllMocks();
  });
  it('waits for the replaced generation to be deleted before starting another refresh', async () => {
    quiet();
    const kv = new MemoryKv();
    const fetcher = shopify('pitsco', [[feedProduct('Motor', 'motor', [{ id: 1, title: 'Default Title', sku: '44260', price: '30.75', available: true }])]]);
    const feedCalls = () => fetcher.mock.calls.filter(([url]) => url.includes('products.json')).length;
    // First crawl: fetch, publish, finish. Refresh: fetch, then switch generations, keeping the old one for a day.
    for (let n = 0; n < 4; n++) await run('pitsco', kv, fetcher, { retireAfterMs: 3600000 });
    expect(json<CatalogPointer>(kv, pointerKey('pitsco')).previous).not.toBeNull();
    const before = feedCalls();
    expect(await run('pitsco', kv, fetcher, { retireAfterMs: 3600000 })).toMatchObject({ fetched: 0 });
    expect(feedCalls()).toBe(before);
    vi.restoreAllMocks();
  });
  it('counts retries against the request limit and saves progress when it runs out', async () => {
    quiet();
    const kv = new MemoryKv();
    const pages = Object.fromEntries(Array.from({ length: 10 }, (_, n) => [`https://www.revrobotics.com/p${n}/`, product(`Part ${n}`, `REV-21-000${n}`)]));
    const base = site('rev', pages);
    const limited = new Set<string>();
    // Each product page answers 429 once, then succeeds.
    const fetcher = vi.fn(async (url: string) => url.includes('/p') && !limited.has(url) ? (limited.add(url), new Response('slow', { status: 429, headers: { 'retry-after': '0' } })) : base(url));
    await run('rev', kv, fetcher, { maxRequests: 9 }).catch(() => undefined);
    expect(fetcher.mock.calls.length).toBeLessThanOrEqual(9);
    // Pages fetched before the limit were kept and the crawl resumes from there.
    const crawl = json<{ urlIndex: number; batches: number }>(kv, 'cat:rev:crawl');
    expect(crawl.urlIndex).toBeGreaterThan(0);
    expect(crawl.batches).toBe(1);
    vi.restoreAllMocks();
  });
  it('respects a robots.txt rule against the feed', async () => {
    quiet();
    await expect(run('andymark', new MemoryKv(), shopify('andymark', [], 'User-agent: *\nDisallow: /products.json'))).rejects.toThrow('robots.txt disallows the product feed');
    vi.restoreAllMocks();
  });
});
