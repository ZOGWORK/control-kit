import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { VendorId, VendorRecord } from '@control-kit/shared';
import type { Kv } from './index';
import { batchKey, indexKey, packFromText, parseProductPage, pointerKey, runVendor, snapshotKey, vendorSources, type CatalogPointer, type IndexEntry, type VendorSnapshot } from './vendor-ingest';

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
  for (const [sku, , batch] of index) found.push(json<VendorRecord[]>(kv, batchKey(vendor, pointer.gen, batch)).find(record => record.normalizedSku === sku)!);
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
  it('reads single products from Product JSON-LD and leaves their pack size unverified', () => {
    const motor = parseProductPage('gobilda', 'https://www.gobilda.com/motor/', page('gobilda-single-product'), at).records;
    expect(motor).toHaveLength(1);
    expect(motor[0]).toMatchObject({ sku: '5203-2402-0019', normalizedSku: '520324020019', priceUsd: 54.99, stock: 'out', packSize: null, packSizeVerified: false, packEvidence: null });
    const rev = parseProductPage('rev', 'https://www.revrobotics.com/rev-41-1600/', page('rev-single-product'), at).records;
    expect(rev[0]).toMatchObject({ sku: 'REV-41-1600', normalizedSku: '411600', priceUsd: 50, stock: 'in', parser: 'jsonld' });
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
  it.each(vendors)('%s publishes its captured product on the first run', async vendor => {
    quiet();
    const data = captured(vendor);
    const kv = new MemoryKv();
    const fetcher = async (url: string) => {
      if (url === `${vendorSources[vendor].origin}/robots.txt`) return new Response('User-agent: *\nAllow: /');
      const body = url === data.capturedFrom.root ? data.rootXml : url === data.capturedFrom.sitemapUrl ? data.productXml : url === data.capturedFrom.productUrl ? data.productHtml : null;
      return body === null ? new Response('missing', { status: 404 }) : new Response(body);
    };
    const first = await run(vendor, kv, fetcher);
    expect(first).toMatchObject({ vendor, fetched: 1, upserted: 1, complete: true });
    expect(json<CatalogPointer>(kv, pointerKey(vendor))).toMatchObject({ complete: true, records: 1 });
    const [record] = await records(kv, vendor);
    expect(record.url).toBe(data.capturedFrom.productUrl);
    expect(record.priceUsd).toBeGreaterThan(0);
    expect(json<VendorSnapshot>(kv, snapshotKey(vendor))).toMatchObject({ status: 'ok', complete: true, recordCount: 1 });
    vi.restoreAllMocks();
  });
  it('skips the goBILDA and ServoCity pages that froze production and keeps crawling', async () => {
    quiet();
    const kv = new MemoryKv();
    const fetcher = site('servocity', {
      'https://www.servocity.com/16awg-premium-silicone-jacket-wire-black-3m-length/': page('servocity-moved-stub'),
      'https://www.servocity.com/aluminum-channel/': product('1120 Series U-Channel (5 Hole, 120mm Length)', '1120-0005-0120', '7.99'),
    });
    const result = await run('servocity', kv, fetcher);
    expect(result).toMatchObject({ fetched: 2, upserted: 1, skipped: 1, complete: true });
    expect(json<VendorSnapshot>(kv, snapshotKey('servocity'))).toMatchObject({ status: 'ok', recordCount: 1, complete: true });
    vi.restoreAllMocks();
  });
  it('makes the first crawl searchable after its first run and labels it incomplete until done', async () => {
    quiet();
    const kv = new MemoryKv();
    const pages = Object.fromEntries(Array.from({ length: 5 }, (_, n) => [`https://www.revrobotics.com/p${n}/`, product(`Part ${n}`, `REV-41-100${n}`)]));
    const fetcher = site('rev', pages);
    await run('rev', kv, fetcher, { maxProducts: 2 });
    expect(json<CatalogPointer>(kv, pointerKey('rev'))).toMatchObject({ complete: false, records: 2, completedAt: null });
    expect(json<VendorSnapshot>(kv, snapshotKey('rev'))).toMatchObject({ status: 'ok', complete: false, recordCount: 2, inProgress: true, progress: { pagesDoneInSitemap: 2, pagesInSitemap: 5 } });
    await run('rev', kv, fetcher, { maxProducts: 2 });
    expect(json<CatalogPointer>(kv, pointerKey('rev'))).toMatchObject({ complete: false, records: 4 });
    const last = await run('rev', kv, fetcher, { maxProducts: 2 });
    expect(last.complete).toBe(true);
    expect(json<CatalogPointer>(kv, pointerKey('rev'))).toMatchObject({ complete: true, records: 5 });
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
    kv.puts = 0;
    await run('gobilda', kv, fetcher, { maxProducts: 40 });
    // batch + index + pointer + crawl + snapshot
    expect(kv.puts).toBeLessThanOrEqual(5);
    vi.restoreAllMocks();
  });
  it('holds position on a failing page, then skips it after three consecutive failed runs', async () => {
    quiet();
    const kv = new MemoryKv();
    const fetcher = site('pitsco', {
      'https://www.pitsco.com/products/broken': () => new Response('unavailable', { status: 503 }),
      'https://www.pitsco.com/products/motor': product('TETRIX MAX Motor', '44260', '30.75'),
    });
    for (let attempt = 1; attempt <= 2; attempt++) {
      await expect(run('pitsco', kv, fetcher)).rejects.toThrow('HTTP 503');
      expect(json<VendorSnapshot>(kv, snapshotKey('pitsco'))).toMatchObject({ status: 'failed', error: 'Vendor returned HTTP 503', version: null });
    }
    const third = await run('pitsco', kv, fetcher);
    expect(third).toMatchObject({ upserted: 1, skipped: 1, complete: true });
    expect(json<VendorSnapshot>(kv, snapshotKey('pitsco'))).toMatchObject({ status: 'ok', recordCount: 1 });
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
    const first = json<CatalogPointer>(kv, pointerKey('rev'));
    expect(first.complete).toBe(true);
    price = '6.00';
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
  it('removes the old crawl keys that froze production when the new pipeline first runs', async () => {
    quiet();
    const kv = new MemoryKv();
    kv.values.set('vendor:gobilda:__cursor__', JSON.stringify({ urls: ['x'], records: {} }));
    await run('gobilda', kv, site('gobilda', { 'https://www.gobilda.com/a/': product('A', '1000-0000-0001') }));
    expect(kv.values.has('vendor:gobilda:__cursor__')).toBe(false);
    vi.restoreAllMocks();
  });
  it('drops records whose links point off the vendor site', async () => {
    quiet();
    const kv = new MemoryKv();
    const offsite = page('andymark-variant-family');
    const fetcher = site('andymark', { 'https://andymark.com/products/neverest-orbital-gearmotors': offsite });
    await run('andymark', kv, fetcher);
    expect((await records(kv, 'andymark')).every(record => new URL(record.url).hostname === 'andymark.com')).toBe(true);
    vi.restoreAllMocks();
  });
});
