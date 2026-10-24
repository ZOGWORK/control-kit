import { describe, expect, it, vi } from 'vitest';
import { aggregateAssembly, type LibraryMapping, type VendorRecord } from '@control-kit/shared';
import type { Kv } from './index';
import { enrichScan, clearCatalogMemoryCache } from './catalog';
import { manifestKey, publishStaged, spotCheck, stageCatalog, validateStaged } from './catalog-publish';
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
    const manifest = await stageCatalog('gobilda', records(120), kv, { source: 'official-feed', gen: 'feed1', batchSize: 50 });
    expect(manifest).toMatchObject({ records: 120, batches: 3, source: 'official-feed' });
    expect(JSON.parse(kv.values.get(pointerKey('gobilda'))!).gen).toBe('old');
    const check = await validateStaged('gobilda', kv, 'feed1', { expectSkus: ['100000000005', '999999999999'] });
    expect(check).toMatchObject({ ok: false, records: 120, missingSkus: ['999999999999'] });
    expect((await validateStaged('gobilda', kv, 'feed1', { expectSkus: ['100000000005'] })).ok).toBe(true);
    const pointer = await publishStaged('gobilda', kv, 'feed1', { now: new Date(at) });
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

describe('library part mappings', () => {
  it('turns a library mapping into an exact SKU match with credit, and shows only licensed images', async () => {
    clearCatalogMemoryCache();
    const kv = new MemoryKv();
    const feed = normalizeFeedRows('gobilda', parseCsv(csv), at).records;
    await stageCatalog('gobilda', feed, kv, { source: 'official-feed', gen: 'g1' });
    await publishStaged('gobilda', kv, 'g1');
    const attribution = { source: 'FTC Parts Library', license: 'used with permission', credit: 'FTC Parts Library' };
    const mapping: LibraryMapping = { library: 'FTC Parts Library', documentId: 'lib-doc', elementId: 'channels', partId: 'JHD', vendorId: 'gobilda', sku: '1121-0010-0264', attribution, image: { url: 'https://library.example/1121.png', attribution } };
    await kv.put('library-map:lib-doc', JSON.stringify([mapping]));
    const result = aggregateAssembly({ rootAssembly: { instances: [
      { id: 'a', name: 'Channel', type: 'Part', documentId: 'lib-doc', elementId: 'channels', partId: 'JHD', documentVersion: 'v1' },
      { id: 'b', name: 'Other part', type: 'Part', documentId: 'lib-doc', elementId: 'channels', partId: 'XYZ', documentVersion: 'v1' },
    ] } }, { documentId: 'robot', workspaceOrVersion: 'w', workspaceOrVersionId: 'w1', elementId: 'asm' }, 'Robot');
    await enrichScan(result, kv);
    const channel = result.lines.find(line => line.partId === 'JHD')!;
    expect(channel).toMatchObject({ matchStatus: 'exact', libraryMatch: { library: 'FTC Parts Library' }, thumbnail: { url: 'https://library.example/1121.png' } });
    expect(channel.vendor?.sku).toBe('1121-0010-0264');
    expect(channel.matchReasons).toContain('SKU from FTC Parts Library part mapping');
    const other = result.lines.find(line => line.partId === 'XYZ')!;
    expect(other).toMatchObject({ matchStatus: 'unmatched', thumbnail: null });
    expect(other.libraryMatch).toBeUndefined();
  });
});
