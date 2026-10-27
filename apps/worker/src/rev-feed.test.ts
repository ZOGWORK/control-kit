import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { aggregateAssembly, classifyScan, type AssemblyDefinition, type VendorRecord } from '@control-kit/shared';
import { clearCatalogMemoryCache, enrichScan } from './catalog';
import worker, { type Env, type Kv } from './index';
import { propagationMs } from './catalog-publish';
import { parseRevFeed, revFeedStateKey, revFeedUrl, runRevFeed } from './rev-feed';
import { batchKey, indexKey, pointerKey, runVendor, snapshotKey, type CatalogPointer, type VendorSnapshot } from './vendor-ingest';

class MemoryKv implements Kv {
  values = new Map<string, string>();
  async get(key: string) { return this.values.get(key) ?? null; }
  async put(key: string, value: string) { this.values.set(key, value); }
  async delete(key: string) { this.values.delete(key); }
}
/** Seven rows copied from REV's feed on 2026-10-26 (Control Hub, Expansion Hub, packs, collars, out of stock, a bundle). */
const sample = readFileSync(new URL('../../../fixtures/vendors/feeds/rev-products.json', import.meta.url), 'utf8');
const sampleRows = JSON.parse(sample) as Array<Record<string, unknown>>;
/** A whole feed: the sample plus enough generated rows to pass the truncation check. */
const fullFeed = (extra = 600) => JSON.stringify([...sampleRows, ...Array.from({ length: extra }, (_, n) => ({ sku: `REV-99-${String(n).padStart(4, '0')}`, name: `Test Part ${n}`, availability_status: 'Available', price: 1, url: `https://www.revrobotics.com/rev-99-${n}/`, image_url: '' }))]);
const lastModified = 'Mon, 26 Oct 2026 05:00:29 GMT';
const feedTime = '2026-10-26T05:00:29.000Z';
const json = <T>(kv: MemoryKv, key: string) => JSON.parse(kv.values.get(key) ?? 'null') as T;
const quiet = () => { vi.spyOn(console, 'log').mockImplementation(() => {}); vi.spyOn(console, 'error').mockImplementation(() => {}); };
/** REV's feed endpoint and nothing else: any other URL fails the test. */
function feedServer(body: () => string, headers: Record<string, string> = { etag: '"v1"', 'last-modified': lastModified }) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    if (url !== revFeedUrl) throw new Error(`Unexpected request to ${url}`);
    if (new Headers(init?.headers).get('if-none-match') === headers.etag) return new Response(null, { status: 304 });
    return new Response(body(), { headers: { 'content-type': 'application/json', ...headers } });
  });
}
/** The catalog the one-time crawl of 2026-10-24 published, including the discontinued Control Hub SKU. */
function crawledCatalog(kv: MemoryKv) {
  const old: VendorRecord = { vendorId: 'rev', sku: 'REV-31-1152', normalizedSku: '311152', name: 'Control Hub', normalizedName: 'control hub', url: 'https://www.revrobotics.com/rev-31-1152/', priceUsd: 325,
    packSize: 1, packSizeVerified: true, stock: 'in', stockQty: null, category: 'uncategorized', updatedAt: '2026-10-24T00:00:00.000Z', source: 'sitemap', parser: 'jsonld' };
  kv.values.set(pointerKey('rev'), JSON.stringify({ gen: 'crawl1', complete: true, records: 1, batches: 1, publishedAt: '2026-10-24T00:00:00.000Z', completedAt: '2026-10-24T00:00:00.000Z', previous: null } satisfies CatalogPointer));
  kv.values.set(batchKey('rev', 'crawl1', 0), JSON.stringify([old]));
  kv.values.set(indexKey('rev', 'crawl1'), JSON.stringify([['311152', 'control hub', 0]]));
}
async function liveRecords(kv: MemoryKv) {
  const pointer = json<CatalogPointer>(kv, pointerKey('rev'));
  return Array.from({ length: pointer.batches ?? 0 }, (_, batch) => json<VendorRecord[]>(kv, batchKey('rev', pointer.gen, batch))).flat();
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('REV official feed mapping', () => {
  const records = parseRevFeed(sample, feedTime).records;
  const bySku = (sku: string) => records.find(record => record.sku === sku)!;
  it('maps only the fields the feed has: SKU, name, price, availability, and REV product page', () => {
    expect(bySku('REV-31-1595')).toEqual({ vendorId: 'rev', sku: 'REV-31-1595', normalizedSku: '311595', name: 'Control Hub', normalizedName: 'control hub', url: 'https://www.revrobotics.com/rev-31-1595/',
      priceUsd: 375, packSize: 1, packSizeVerified: true, packEvidence: 'sold individually: REV gives every multi-unit product a -PKn SKU in its feed', stock: 'in', stockQty: null,
      category: 'uncategorized', updatedAt: feedTime, source: 'feed', parser: 'official-feed' });
    expect(bySku('REV-49-1455')).toMatchObject({ stock: 'out', priceUsd: 9.75 });
    // No photo is taken from the feed.
    expect(records.every(record => !('image' in record))).toBe(true);
  });
  it('takes pack size from REV\'s -PKn SKU, never from words in the name', () => {
    expect(bySku('REV-41-1322-PK8')).toMatchObject({ packSize: 8, packSizeVerified: true, packEvidence: 'REV feed SKU suffix "PK8"' });
    // "1 Piece Shaft Collar ... 4 Pack": the SKU says 4; reading the name could have said 1.
    expect(bySku('REV-21-1911-PK4')).toMatchObject({ packSize: 4, packSizeVerified: true });
    // "2 Piece" is one collar made of two pieces.
    expect(bySku('REV-21-2581')).toMatchObject({ packSize: 1 });
    expect(bySku('REV-45-1885')).toMatchObject({ packSize: null, packSizeVerified: false });
  });
  it('rejects rows without a SKU, a name, or a REV product page instead of inventing them', () => {
    const parsed = parseRevFeed(JSON.stringify([
      { name: 'Control Hub REV-31-1152', availability_status: 'Available', price: 325, url: 'https://www.revrobotics.com/rev-31-1152/' },
      { sku: 'REV-31-1595', name: '', price: 375, url: 'https://www.revrobotics.com/rev-31-1595/' },
      { sku: 'REV-31-1595', name: 'Control Hub', price: 375, url: 'https://example.com/rev-31-1595/' },
      { sku: 'REV-31-1595', name: 'Control Hub', price: 375, url: 'https://www.revrobotics.com/' },
      { sku: 'REV-41-1600', name: 'Servo', availability_status: 'Discontinued', url: 'https://www.revrobotics.com/rev-41-1600/' },
    ]), feedTime);
    expect(parsed.rejected.map(item => item.reason)).toEqual(['no usable SKU', 'no name', 'no product page on www.revrobotics.com', 'no product page on www.revrobotics.com']);
    expect(parsed.records).toEqual([expect.objectContaining({ sku: 'REV-41-1600', priceUsd: null, stock: 'out' })]);
    expect(() => parseRevFeed('{"error":"maintenance"}', feedTime)).toThrow('not a list of products');
  });
});

describe('REV catalog from the official feed', () => {
  it('never crawls REV: runVendor refuses it before making any request', async () => {
    const fetcher = vi.fn(async () => new Response(''));
    await expect(runVendor('rev', new MemoryKv(), fetcher)).rejects.toThrow('never crawled');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('makes REV\'s cron read only the feed URL', async () => {
    quiet();
    const fetcher = feedServer(() => fullFeed());
    vi.stubGlobal('fetch', fetcher);
    const kv = new MemoryKv();
    const pending: Promise<unknown>[] = [];
    worker.scheduled({ cron: '36 * * * *' }, { VENDOR_CATALOG: kv } as unknown as Env, { waitUntil: promise => pending.push(promise) });
    await Promise.all(pending);
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([revFeedUrl]);
    expect(new URL(revFeedUrl).hostname).toBe('dashboard.revrobotics.com');
  });
  it('stages the feed, publishes it a run later, and drops SKUs the feed does not list', async () => {
    quiet();
    const kv = new MemoryKv();
    crawledCatalog(kv);
    const fetcher = feedServer(() => fullFeed());
    let clock = Date.parse('2026-10-26T12:00:00Z');
    const now = () => new Date(clock);
    expect(await runRevFeed(kv, fetcher, { now })).toMatchObject({ action: 'staged', records: 607 });
    // Staged, not live: scans still read the crawled catalog until KV has propagated the new one.
    expect(json<CatalogPointer>(kv, pointerKey('rev')).gen).toBe('crawl1');
    expect(await runRevFeed(kv, fetcher, { now })).toMatchObject({ action: 'waiting' });
    clock += propagationMs;
    expect(await runRevFeed(kv, fetcher, { now })).toMatchObject({ action: 'published', records: 607 });
    expect(json<CatalogPointer>(kv, pointerKey('rev'))).toMatchObject({ source: 'official-feed', complete: true, records: 607, previous: { gen: 'crawl1' } });
    expect(json<VendorSnapshot>(kv, snapshotKey('rev'))).toMatchObject({ status: 'ok', source: 'official-feed', recordCount: 607 });
    const live = await liveRecords(kv);
    expect(live.find(record => record.sku === 'REV-31-1595')).toMatchObject({ priceUsd: 375, updatedAt: feedTime });
    // The discontinued Control Hub SKU was only in the crawl; the feed does not list it, so it is gone.
    expect(live.some(record => record.normalizedSku === '311152')).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(1);

    // Within six hours nothing is requested; after that an unchanged feed answers 304 and nothing is staged.
    expect(await runRevFeed(kv, fetcher, { now })).toMatchObject({ action: 'skipped' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    clock += 6 * 3600000;
    expect(await runRevFeed(kv, fetcher, { now })).toMatchObject({ action: 'unchanged' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(json<{ staged: unknown }>(kv, revFeedStateKey).staged).toBeNull();
  });
  it('keeps the live catalog when the feed is truncated, malformed, or unreachable', async () => {
    quiet();
    const now = () => new Date('2026-10-26T12:00:00Z');
    for (const fetcher of [feedServer(() => fullFeed(10)), feedServer(() => '<html>Maintenance</html>'), vi.fn(async () => new Response('down', { status: 503 }))]) {
      const kv = new MemoryKv();
      crawledCatalog(kv);
      await expect(runRevFeed(kv, fetcher, { now })).rejects.toThrow(/REV feed/);
      expect(json<CatalogPointer>(kv, pointerKey('rev')).gen).toBe('crawl1');
      expect(kv.values.get(revFeedStateKey)).toBeUndefined();
      expect(json<VendorSnapshot>(kv, snapshotKey('rev'))).toMatchObject({ status: 'failed', version: 'crawl1' });
    }
  });
  it('drops a staged feed when a newer catalog was published by hand meanwhile', async () => {
    quiet();
    const kv = new MemoryKv();
    crawledCatalog(kv);
    let clock = Date.parse('2026-10-26T12:00:00Z');
    const now = () => new Date(clock);
    await runRevFeed(kv, feedServer(() => fullFeed()), { now });
    const { staged } = json<{ staged: { gen: string } }>(kv, revFeedStateKey);
    // An operator publishes another generation (catalog-load) before the cron's next run.
    kv.values.set(pointerKey('rev'), JSON.stringify({ ...json<CatalogPointer>(kv, pointerKey('rev')), gen: 'manual' }));
    clock += propagationMs;
    expect(await runRevFeed(kv, feedServer(() => fullFeed()), { now })).toMatchObject({ action: 'abandoned' });
    expect(json<CatalogPointer>(kv, pointerKey('rev')).gen).toBe('manual');
    expect([...kv.values.keys()].some(key => key.includes(staged.gen))).toBe(false);
  });
  it('deletes the replaced catalog once its day of rollback is over', async () => {
    quiet();
    const kv = new MemoryKv();
    crawledCatalog(kv);
    let clock = Date.parse('2026-10-26T12:00:00Z');
    const now = () => new Date(clock);
    const fetcher = feedServer(() => fullFeed());
    await runRevFeed(kv, fetcher, { now });
    clock += propagationMs;
    await runRevFeed(kv, fetcher, { now });
    const pointer = json<CatalogPointer>(kv, pointerKey('rev'));
    kv.values.set(pointerKey('rev'), JSON.stringify({ ...pointer, previous: { ...pointer.previous!, deleteAfter: 0 } }));
    await runRevFeed(kv, fetcher, { now });
    expect(json<CatalogPointer>(kv, pointerKey('rev')).previous).toBeNull();
    expect([...kv.values.keys()].some(key => key.startsWith('cat:rev:gen:crawl1:'))).toBe(false);
  });
  it('discards a staged feed that no longer validates instead of publishing it', async () => {
    quiet();
    const kv = new MemoryKv();
    crawledCatalog(kv);
    let clock = Date.parse('2026-10-26T12:00:00Z');
    const now = () => new Date(clock);
    await runRevFeed(kv, feedServer(() => fullFeed()), { now });
    const { staged } = json<{ staged: { gen: string } }>(kv, revFeedStateKey);
    kv.values.delete(batchKey('rev', staged.gen, 0));
    clock += propagationMs;
    expect(await runRevFeed(kv, feedServer(() => fullFeed()), { now })).toMatchObject({ action: 'rejected' });
    expect(json<CatalogPointer>(kv, pointerKey('rev')).gen).toBe('crawl1');
    expect([...kv.values.keys()].some(key => key.includes(staged.gen))).toBe(false);
  });
});

describe('a REV buy line from the feed', () => {
  it('prices an exact SKU from the feed with REV\'s product link and the feed\'s update time', async () => {
    quiet();
    clearCatalogMemoryCache();
    const kv = new MemoryKv();
    crawledCatalog(kv);
    let clock = Date.parse('2026-10-26T12:00:00Z');
    const fetcher = feedServer(() => fullFeed());
    await runRevFeed(kv, fetcher, { now: () => new Date(clock) });
    clock += propagationMs;
    await runRevFeed(kv, fetcher, { now: () => new Date(clock) });
    const fixture = JSON.parse(readFileSync(new URL('../../../fixtures/assembly-simple.json', import.meta.url), 'utf8')) as AssemblyDefinition;
    const context = { documentId: 'doc1', workspaceOrVersion: 'w' as const, workspaceOrVersionId: 'work1', elementId: 'elem1' };
    const result = aggregateAssembly(fixture, context, 'Robot');
    const base = result.lines[0];
    result.lines = [{ ...base, name: 'Control Hub', partNumber: 'REV-31-1595', bomLineKey: 'hub', qty: 2 }, { ...base, name: 'Old Control Hub', partNumber: 'REV-31-1152', bomLineKey: 'old-hub', partId: 'old-hub', qty: 1 }];
    classifyScan(await enrichScan(result, kv), { teamNumber: null }, {});
    const hub = result.lines.find(line => line.bomLineKey === 'hub')!;
    expect(hub).toMatchObject({ disposition: 'buy', matchStatus: 'exact', packsToOrder: 2, lineTotalUsd: 750 });
    expect(hub.vendor).toMatchObject({ sku: 'REV-31-1595', priceUsd: 375, url: 'https://www.revrobotics.com/rev-31-1595/', updatedAt: feedTime, parser: 'official-feed' });
    // A part numbered with the discontinued SKU finds nothing: it was not in the feed, so no product or price is made up.
    const old = result.lines.find(line => line.bomLineKey === 'old-hub')!;
    expect(old.vendor?.sku).not.toBe('REV-31-1152');
    expect(old.lineTotalUsd).toBeNull();
  });
});
