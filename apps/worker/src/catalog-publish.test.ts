import { describe, expect, it, vi } from 'vitest';
import { aggregateAssembly, type LibraryMapping, type VendorRecord } from '@control-kit/shared';
import type { Kv } from './index';
import { enrichScan, clearCatalogMemoryCache } from './catalog';
import { manifestKey, publishStaged, spotCheck, stageCatalog, validateStaged } from './catalog-publish';
const later = (iso: string, seconds = 70) => new Date(Date.parse(iso) + seconds * 1000);
import { normalizeFeedRows, parseCsv, parseJsonFeed } from './feed-import';
import { crawlKey, pointerKey, runVendor, snapshotKey, type CatalogPointer } from './vendor-ingest';

class MemoryKv implements Kv {
  values = new Map<string, string>();
  async get(key: string) { return this.values.get(key) ?? null; }
  async put(key: string, value: string) { this.values.set(key, value); }
  async delete(key: string) { this.values.delete(key); }
}
const at = '2026-10-24T12:00:00Z';
const csv = `SKU,Product Name,Price,Qty per Pack,Stock Status,Product URL
1121-0010-0264,"1121 Series Low-Side U-Channel (10 Hole, 264mm Length)",$12.99,1,In Stock,https://www.gobilda.com/1121-series-low-side-u-channel/
2802-0004-0012,"2802 Series Button Head Screw (M4 x 12mm) - 25 Pack",3.99,25,Out of Stock,https://www.gobilda.com/2802-series-screw/
,No SKU row,1.00,,In Stock,https://www.gobilda.com/x/
9999-0000-0001,"Off-site link",1.00,,In Stock,https://example.com/product
`;

describe('official vendor feeds', () => {
  it('reads CSV and JSON feeds into the same records a crawl produces, with pack size only when the feed states it', () => {
    const rows = parseCsv(csv);
    expect(rows[0]['Product Name']).toBe('1121 Series Low-Side U-Channel (10 Hole, 264mm Length)');
    const { records, rejected, columns } = normalizeFeedRows('gobilda', rows, at);
    expect(columns).toMatchObject({ sku: 'SKU', name: 'Product Name', price: 'Price', packQty: 'Qty per Pack', stock: 'Stock Status', url: 'Product URL' });
    expect(records.map(record => [record.sku, record.normalizedSku, record.priceUsd, record.packSize, record.packSizeVerified, record.stock, record.source, record.parser])).toEqual([
      ['1121-0010-0264', '112100100264', 12.99, 1, true, 'in', 'feed', 'official-feed'],
      ['2802-0004-0012', '280200040012', 3.99, 25, true, 'out', 'feed', 'official-feed'],
    ]);
    expect(records[1].packEvidence).toBe('vendor feed pack quantity 25');
    expect(rejected).toEqual([{ row: 4, reason: 'no usable SKU' }, { row: 5, reason: 'product URL is not on the vendor site' }]);
    const json = parseJsonFeed(JSON.stringify({ products: [{ part_no: 'REV-41-1291', title: 'HD Hex Motor', cost: 32.5, link: 'https://www.revrobotics.com/rev-41-1291/' }] }));
    expect(normalizeFeedRows('rev', json, at, { sku: 'part_no', name: 'title', price: 'cost', url: 'link' }).records[0]).toMatchObject({ sku: 'REV-41-1291', priceUsd: 32.5, packSizeVerified: false, stock: 'unknown' });
    expect(() => normalizeFeedRows('rev', json, at)).toThrow('no column for sku');
  });
});

describe('staged catalog publish', () => {
  const records = (count: number, vendor: VendorRecord['vendorId'] = 'gobilda') => normalizeFeedRows(vendor, Array.from({ length: count }, (_, n) => ({ sku: `1000-0000-${String(n).padStart(4, '0')}`, name: `Part ${n}`, price: '1.00', url: 'https://www.gobilda.com/p/' })), at).records;
  it('stages without touching the live catalog, validates, then publishes with the old generation kept for rollback', async () => {
    const kv = new MemoryKv();
    const live: CatalogPointer = { gen: 'old', complete: false, records: 70, batches: 2, publishedAt: at, completedAt: null, previous: null };
    await kv.put(pointerKey('gobilda'), JSON.stringify(live));
    await kv.put(crawlKey('gobilda'), '{"gen":"old"}');
    const manifest = await stageCatalog('gobilda', records(120), kv, { source: 'official-feed', gen: 'feed1', batchSize: 50, now: new Date(at) });
    expect(manifest).toMatchObject({ records: 120, batches: 3, source: 'official-feed' });
    expect(JSON.parse(kv.values.get(pointerKey('gobilda'))!).gen).toBe('old');
    const check = await validateStaged('gobilda', kv, 'feed1', { expectSkus: ['100000000005', '999999999999'] });
    expect(check).toMatchObject({ ok: false, records: 120, missingSkus: ['999999999999'] });
    expect((await validateStaged('gobilda', kv, 'feed1', { expectSkus: ['100000000005'] })).ok).toBe(true);
    // Too soon after staging, other KV locations may not have the batches yet.
    await expect(publishStaged('gobilda', kv, 'feed1', { now: later(at, 10) })).rejects.toThrow('publish after 65s');
    const pointer = await publishStaged('gobilda', kv, 'feed1', { now: later(at) });
    expect(pointer).toMatchObject({ gen: 'feed1', complete: true, records: 120, batches: 3, source: 'official-feed', previous: { gen: 'old', batches: 2, deleted: 0 } });
    expect(kv.values.has(crawlKey('gobilda'))).toBe(false);
    expect(JSON.parse(kv.values.get(snapshotKey('gobilda'))!)).toMatchObject({ status: 'ok', complete: true, recordCount: 120, source: 'official-feed', version: 'feed1' });
  });
  it('refuses a feed much smaller than the complete live catalog, and a missing or damaged generation', async () => {
    const kv = new MemoryKv();
    await kv.put(pointerKey('gobilda'), JSON.stringify({ gen: 'live', complete: true, records: 2000, batches: 2, publishedAt: at, completedAt: at, previous: null }));
    await stageCatalog('gobilda', records(300), kv, { source: 'official-feed', gen: 'short' });
    expect((await validateStaged('gobilda', kv, 'short')).problems[0]).toMatch(/more than 20% below the live catalog's 2000/);
    expect((await validateStaged('gobilda', kv, 'nothing')).ok).toBe(false);
    await kv.delete('cat:gobilda:gen:short:batch:0');
    expect((await validateStaged('gobilda', kv, 'short')).problems).toContain('Batch 0 is missing');
    await expect(publishStaged('gobilda', kv, 'nothing')).rejects.toThrow('not staged');
    expect(kv.values.has(manifestKey('gobilda', 'short'))).toBe(true);
  });
  it('accepts a price written with a thousands separator', async () => {
    const [record] = normalizeFeedRows('rev', [{ sku: 'REV-25-3388', name: 'Kit', price: '2000', url: 'https://www.revrobotics.com/rev-25-3388/' }], at).records;
    const [check] = await spotCheck([record], async () => new Response('REV-25-3388 <span>$2,000.00</span>'), 1, 0);
    expect(check).toMatchObject({ skuOnPage: true, priceOnPage: true });
  });
  it('spot-checks a sample against the vendor page', async () => {
    const sample = records(3);
    const checks = await spotCheck(sample, async url => new Response(url.includes('/p/') ? 'SKU 1000-0000-0001 $1.00' : ''), 3, 0, () => 0.5);
    expect(checks.filter(check => check.skuOnPage && check.priceOnPage).map(check => check.sku)).toEqual(['1000-0000-0001']);
  });
  it('leaves a vendor on a fresh official feed alone, and resumes crawling once the feed is stale', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const kv = new MemoryKv();
    const fetcher = vi.fn(async () => new Response('User-agent: *\nAllow: /'));
    await kv.put(pointerKey('gobilda'), JSON.stringify({ gen: 'feed1', complete: true, records: 120, batches: 1, publishedAt: new Date().toISOString(), completedAt: new Date().toISOString(), source: 'official-feed', previous: null }));
    expect(await runVendor('gobilda', kv, fetcher, { minRequestMs: 0 })).toMatchObject({ fetched: 0, complete: true });
    expect(fetcher).not.toHaveBeenCalled();
    expect(JSON.parse(kv.values.get(snapshotKey('gobilda'))!)).toMatchObject({ source: 'official-feed', recordCount: 120 });
    const old = new Date(Date.now() - 400 * 3600000).toISOString();
    await kv.put(pointerKey('gobilda'), JSON.stringify({ gen: 'feed1', complete: true, records: 120, batches: 1, publishedAt: old, completedAt: old, source: 'official-feed', previous: null }));
    await runVendor('gobilda', kv, fetcher, { minRequestMs: 0 }).catch(() => undefined);
    expect(fetcher).toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});

describe('generation bookkeeping', () => {
  const records = (count: number) => normalizeFeedRows('gobilda', Array.from({ length: count }, (_, n) => ({ sku: `1000-0000-${String(n).padStart(4, '0')}`, name: `Part ${n}`, price: '1.00', url: 'https://www.gobilda.com/p/' })), at).records;
  it('keeps every replaced generation queued for deletion when publishing twice in a day, including an unfinished crawl', async () => {
    const kv = new MemoryKv();
    await kv.put(pointerKey('gobilda'), JSON.stringify({ gen: 'crawl0', complete: true, records: 5, batches: 1, publishedAt: at, completedAt: at, previous: { gen: 'older', batches: 3, deleteAfter: Date.parse(at) + 3600000, deleted: 0 } }));
    await kv.put(crawlKey('gobilda'), JSON.stringify({ gen: 'refresh', batches: 4 }));
    await stageCatalog('gobilda', records(10), kv, { source: 'official-feed', gen: 'f1', now: new Date(at) });
    const first = await publishStaged('gobilda', kv, 'f1', { now: later(at) });
    expect(first.previous?.gen).toBe('crawl0');
    expect(first.retiring?.map(entry => entry.gen)).toEqual(['older', 'refresh']);
    await stageCatalog('gobilda', records(10), kv, { source: 'official-feed', gen: 'f2', now: new Date(at) });
    const second = await publishStaged('gobilda', kv, 'f2', { now: later(at, 140) });
    expect(second.previous?.gen).toBe('f1');
    expect(second.retiring?.map(entry => entry.gen)).toEqual(['older', 'refresh', 'crawl0']);
  });
  it('keeps the rollback generation when the crawl that built it is abandoned', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const kv = new MemoryKv();
    // A first crawl is live and partial, and its own crawl is still running when a feed is published.
    await kv.put(pointerKey('gobilda'), JSON.stringify({ gen: 'crawl0', complete: false, records: 1, batches: 1, publishedAt: at, completedAt: null, previous: null }));
    await kv.put('cat:gobilda:gen:crawl0:batch:0', '[]');
    await kv.put('cat:gobilda:gen:crawl0:index', '[]');
    await kv.put(crawlKey('gobilda'), JSON.stringify({ gen: 'crawl0', batches: 1 }));
    await stageCatalog('gobilda', records(10), kv, { source: 'official-feed', gen: 'feed1', now: new Date(at) });
    const pointer = await publishStaged('gobilda', kv, 'feed1', { now: later(at) });
    expect(pointer.previous?.gen).toBe('crawl0');
    expect(pointer.retiring).toBeUndefined();
    // The next cron run (an hour later, inside the 24-hour rollback window; the clock is pinned so the test does not
    // depend on today's date) sees the fresh feed, drops the crawl, and must leave the rollback copy in place.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(later(at, 3600));
    try { await runVendor('gobilda', kv, async () => new Response(''), { minRequestMs: 0, feedFreshHours: 1000000 }); }
    finally { vi.useRealTimers(); }
    const after = JSON.parse(kv.values.get(pointerKey('gobilda'))!) as CatalogPointer;
    expect(after.previous?.gen).toBe('crawl0');
    expect(after.retiring).toBeUndefined();
    expect(kv.values.has('cat:gobilda:gen:crawl0:batch:0')).toBe(true);
    vi.restoreAllMocks();
  });
  it('stops a crawl that was running when a feed went live, so it can never replace the feed', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const kv = new MemoryKv();
    await kv.put(pointerKey('gobilda'), JSON.stringify({ gen: 'crawl0', complete: false, records: 0, batches: 0, publishedAt: at, completedAt: null, previous: null }));
    await stageCatalog('gobilda', records(10), kv, { source: 'official-feed', gen: 'feed1', now: new Date(at) });
    // The feed is published while this crawl run is fetching its pages.
    let published = false;
    const fetcher = async (url: string) => {
      if (url.endsWith('/robots.txt')) return new Response('User-agent: *\nAllow: /');
      if (url.endsWith('/xmlsitemap.php')) return new Response('<sitemapindex><sitemap><loc>https://www.gobilda.com/xmlsitemap.php?type=products&amp;page=1</loc></sitemap></sitemapindex>');
      if (url.includes('type=products')) return new Response('<urlset><url><loc>https://www.gobilda.com/a/</loc></url></urlset>');
      if (!published) { published = true; await publishStaged('gobilda', kv, 'feed1', { now: later(at) }); }
      return new Response(`<script type="application/ld+json">${JSON.stringify({ '@type': 'Product', name: 'A', sku: '1000-0000-9999', offers: { price: '1', priceCurrency: 'USD' } })}</script>`);
    };
    await runVendor('gobilda', kv, fetcher, { minRequestMs: 0 });
    const pointer = JSON.parse(kv.values.get(pointerKey('gobilda'))!) as CatalogPointer;
    expect(pointer.gen).toBe('feed1');
    expect(kv.values.has(crawlKey('gobilda'))).toBe(false);
    expect(pointer.retiring?.length).toBe(1);
    vi.restoreAllMocks();
  });
});

describe('library part mappings', () => {
  it('turns a library mapping into an exact SKU match with credit, and shows only licensed images', async () => {
    clearCatalogMemoryCache();
    const kv = new MemoryKv();
    const feed = normalizeFeedRows('gobilda', parseCsv(csv), at).records;
    await stageCatalog('gobilda', feed, kv, { source: 'official-feed', gen: 'g1', now: new Date(at) });
    await publishStaged('gobilda', kv, 'g1', { now: later(at) });
    // The same number at another vendor must not win over the product the library named.
    await stageCatalog('servocity', normalizeFeedRows('servocity', [{ sku: '1121-0010-0264', name: 'Different product', price: '1', url: 'https://www.servocity.com/x/' }], at).records, kv, { source: 'official-feed', gen: 's1', now: new Date(at) });
    await publishStaged('servocity', kv, 's1', { now: later(at) });
    const attribution = { source: 'FTC Parts Library', license: 'used with permission', credit: 'FTC Parts Library' };
    const mapping: LibraryMapping = { library: 'FTC Parts Library', documentId: 'lib-doc', partId: 'JHD', vendorId: 'gobilda', sku: '1121-0010-0264', attribution, image: { url: 'https://library.example/1121.png', attribution } };
    // An element-wide default must not beat the part's own mapping.
    const broad: LibraryMapping = { library: 'FTC Parts Library', documentId: 'lib-doc', elementId: 'channels', vendorId: 'gobilda', sku: '2802-0004-0012', attribution };
    await kv.put('library-map:lib-doc', JSON.stringify([broad, mapping]));
    const result = aggregateAssembly({ rootAssembly: { instances: [
      { id: 'a', name: 'Channel', type: 'Part', documentId: 'lib-doc', elementId: 'channels', partId: 'JHD', documentVersion: 'v1' },
      { id: 'b', name: 'Other part', type: 'Part', documentId: 'lib-doc', elementId: 'channels', partId: 'XYZ', documentVersion: 'v1' },
    ] } }, { documentId: 'robot', workspaceOrVersion: 'w', workspaceOrVersionId: 'w1', elementId: 'asm' }, 'Robot');
    await enrichScan(result, kv);
    const channel = result.lines.find(line => line.partId === 'JHD')!;
    expect(channel).toMatchObject({ matchStatus: 'exact', libraryMatch: { library: 'FTC Parts Library' }, thumbnail: { url: 'https://library.example/1121.png' } });
    expect(channel.vendor?.sku).toBe('1121-0010-0264');
    expect(channel.matchReasons).toEqual(['SKU 1121-0010-0264 from FTC Parts Library part mapping']);
    const other = result.lines.find(line => line.partId === 'XYZ')!;
    // The other part in that element falls back to the element-wide mapping, without an image.
    expect(other).toMatchObject({ matchStatus: 'exact', thumbnail: null });
    expect(other.vendor?.sku).toBe('2802-0004-0012');
  });
});
