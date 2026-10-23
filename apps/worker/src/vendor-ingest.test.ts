import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { VendorId, VendorRecord } from '@control-kit/shared';
import type { Kv } from './index';
import { parseProductPage, runVendor, vendorSources, type VendorSnapshot } from './vendor-ingest';
const quickRun: typeof runVendor = (vendor, kv, fetcher, options) => runVendor(vendor, kv, fetcher, { ...options, publicationDelayMs: 0 });

class MemoryKv implements Kv {
  values = new Map<string, string>();
  async get(key: string) { return this.values.get(key) ?? null; }
  async put(key: string, value: string) { this.values.set(key, value); }
  async delete(key: string) { this.values.delete(key); }
}
type Fixture = { capturedFrom: { root: string; sitemapUrl: string; productUrl: string }; rootXml: string; productXml: string; productHtml: string };
const vendors: VendorId[] = ['gobilda', 'servocity', 'andymark', 'rev', 'pitsco'];
function fixture(vendor: VendorId): Fixture { return JSON.parse(readFileSync(new URL(`../../../fixtures/vendors/captured/${vendor}.json`, import.meta.url), 'utf8')) as Fixture; }
function mockFeed(vendor: VendorId, data: Fixture, override?: (url: string) => Response | null) {
  return async (input: string) => {
    const changed = override?.(input);
    if (changed) return changed;
    const body = input === `${vendorSources[vendor].origin}/robots.txt` ? 'User-agent: *\nAllow: /'
      : input === data.capturedFrom.root ? data.rootXml
      : input === data.capturedFrom.sitemapUrl ? data.productXml
      : input === data.capturedFrom.productUrl ? data.productHtml : null;
    return body === null ? new Response('missing fixture', { status: 404 }) : new Response(body);
  };
}

describe('five captured vendor sitemap pipelines', () => {
  it.each(vendors)('%s ingests its captured sitemap and Product JSON-LD, then makes no changes on repeat', async vendor => {
    const data = fixture(vendor);
    const kv = new MemoryKv();
    const feed = mockFeed(vendor, data);
    const first = await quickRun(vendor, kv, feed, { maxProducts: 10, minRequestMs: 0 });
    expect(first).toMatchObject({ vendor, source: 'sitemap', fetched: 1, upserted: 1, complete: true });
    const version = await kv.get(`vendor:${vendor}:__lastgood__`);
    expect(version).toMatch(/^[a-f0-9]{64}$/);
    const snapshot = JSON.parse((await kv.get(`vendor:${vendor}:__snapshot__`))!) as VendorSnapshot;
    expect(snapshot).toMatchObject({ status: 'ok', version, recordCount: 1 });
    const records = [...kv.values.entries()].filter(([key]) => key.startsWith(`vendor-version:${vendor}:${version}:`));
    expect(records).toHaveLength(1);
    const product = JSON.parse(records[0][1]) as VendorRecord;
    expect(product.url).toBe(data.capturedFrom.productUrl);
    expect(product.priceUsd).toBeGreaterThan(0);
    expect(product.packSizeVerified).toBe(false);
    const second = await quickRun(vendor, kv, feed, { maxProducts: 10, minRequestMs: 0 });
    expect(second.upserted).toBe(0);
    expect(await kv.get(`vendor:${vendor}:__lastgood__`)).toBe(version);
  });
  it('keeps the last good catalog pointer on a forced failure and flags the snapshot', async () => {
    const vendor = 'rev';
    const data = fixture(vendor);
    const kv = new MemoryKv();
    await quickRun(vendor, kv, mockFeed(vendor, data), { minRequestMs: 0 });
    const version = await kv.get(`vendor:${vendor}:__lastgood__`);
    const failing = mockFeed(vendor, data, url => url === data.capturedFrom.productUrl ? new Response('rate limited', { status: 429, headers: { 'retry-after': '0' } }) : null);
    await expect(quickRun(vendor, kv, failing, { minRequestMs: 0 })).rejects.toThrow('429');
    expect(await kv.get(`vendor:${vendor}:__lastgood__`)).toBe(version);
    expect((JSON.parse((await kv.get(`vendor:${vendor}:__snapshot__`))!) as VendorSnapshot).status).toBe('failed');
  });
  it('retries a failed sitemap instead of publishing a partial catalog', async () => {
    const vendor = 'rev';
    const data = fixture(vendor);
    const kv = new MemoryKv();
    let failOnce = true;
    const feed = mockFeed(vendor, data, url => {
      if (url === data.capturedFrom.sitemapUrl && failOnce) { failOnce = false; return new Response('temporary failure', { status: 503 }); }
      return null;
    });
    await expect(quickRun(vendor, kv, feed, { minRequestMs: 0 })).rejects.toThrow('503');
    expect(await kv.get(`vendor:${vendor}:__lastgood__`)).toBeNull();
    expect(JSON.parse((await kv.get(`vendor:${vendor}:__cursor__`))!).sitemapIndex).toBe(0);
    expect((await quickRun(vendor, kv, feed, { minRequestMs: 0 })).complete).toBe(true);
  });
  it('retries an unreadable product page without dropping the last good product', async () => {
    const vendor = 'rev';
    const data = fixture(vendor);
    const kv = new MemoryKv();
    await quickRun(vendor, kv, mockFeed(vendor, data), { minRequestMs: 0 });
    const oldVersion = await kv.get(`vendor:${vendor}:__lastgood__`);
    let challenge = true;
    const feed = mockFeed(vendor, data, url => url === data.capturedFrom.productUrl && challenge ? new Response('<html>challenge</html>') : null);
    await expect(quickRun(vendor, kv, feed, { minRequestMs: 0 })).rejects.toThrow('no usable Product');
    expect(await kv.get(`vendor:${vendor}:__lastgood__`)).toBe(oldVersion);
    expect(JSON.parse((await kv.get(`vendor:${vendor}:__cursor__`))!).urlIndex).toBe(0);
    challenge = false;
    expect((await quickRun(vendor, kv, feed, { minRequestMs: 0 })).complete).toBe(true);
  });
  it('resumes a partial page batch before publishing a snapshot', async () => {
    const vendor = 'rev';
    const data = fixture(vendor);
    const nextUrl = `${vendorSources.rev.origin}/another-product/`;
    data.productXml = `<urlset><url><loc>${data.capturedFrom.productUrl}</loc></url><url><loc>${nextUrl}</loc></url></urlset>`;
    const kv = new MemoryKv();
    const feed = mockFeed(vendor, data, url => url === nextUrl ? new Response(data.productHtml.replace('REV-21-2807', 'REV-21-2808')) : null);
    const partial = await quickRun(vendor, kv, feed, { maxProducts: 1, minRequestMs: 0 });
    expect(partial.complete).toBe(false);
    expect(await kv.get(`vendor:${vendor}:__lastgood__`)).toBeNull();
    let complete = await quickRun(vendor, kv, feed, { maxProducts: 1, minRequestMs: 0 });
    let upserted = complete.upserted;
    expect(complete.complete).toBe(false);
    expect(await kv.get(`vendor:${vendor}:__lastgood__`)).toBeNull();
    for (let i = 0; i < 10 && !complete.complete; i++) {
      complete = await quickRun(vendor, kv, feed, { maxProducts: 1, minRequestMs: 0 });
      upserted += complete.upserted;
    }
    expect(complete.complete).toBe(true);
    expect(upserted).toBe(2);
    expect((JSON.parse((await kv.get(`vendor:${vendor}:__snapshot__`))!) as VendorSnapshot).recordCount).toBe(2);
  });
  it('keeps the previous pointer when staging an index fails, then resumes publishing', async () => {
    const vendor = 'rev';
    const data = fixture(vendor);
    const kv = new MemoryKv();
    const feed = mockFeed(vendor, data);
    await quickRun(vendor, kv, feed, { minRequestMs: 0 });
    const oldVersion = await kv.get(`vendor:${vendor}:__lastgood__`);
    data.productHtml = data.productHtml.replace('"price":"11"', '"price":"12"');
    const originalPut = kv.put.bind(kv);
    let failOnce = true;
    kv.put = async (key, value) => {
      if (failOnce && key.startsWith('vendor-index-version:')) { failOnce = false; throw Error('simulated KV write failure'); }
      await originalPut(key, value);
    };
    await expect(quickRun(vendor, kv, feed, { minRequestMs: 0 })).rejects.toThrow('simulated KV write failure');
    expect(await kv.get(`vendor:${vendor}:__lastgood__`)).toBe(oldVersion);
    expect((JSON.parse((await kv.get(`vendor:${vendor}:__snapshot__`))!) as VendorSnapshot).status).toBe('failed');
    const resumed = await quickRun(vendor, kv, feed, { minRequestMs: 0 });
    expect(resumed.complete).toBe(true);
    expect(await kv.get(`vendor:${vendor}:__lastgood__`)).not.toBe(oldVersion);
  });
  it('maps stock and verifies pack size only when a pack quantity is explicit', () => {
    const url = 'https://www.revrobotics.com/pack/';
    const html = '<script type="application/ld+json">{"@type":"Product","name":"M3 Screws (Pack of 10)","sku":"REV-1000","offers":{"price":"5.00","priceCurrency":"USD","availability":"https://schema.org/InStock","inventoryLevel":{"value":3}}}</script>';
    expect(parseProductPage('rev', url, html, new Date().toISOString())[0]).toMatchObject({ packSize: 10, packSizeVerified: true, stock: 'low', stockQty: 3, priceUsd: 5 });
    expect(parseProductPage('rev', url, html.replace('"value":3', '"value":0'), new Date().toISOString())[0].stock).toBe('out');
  });
  it('retires previous version keys after the reader grace period', async () => {
    const vendor = 'rev';
    const data = fixture(vendor);
    const kv = new MemoryKv();
    const feed = mockFeed(vendor, data);
    await quickRun(vendor, kv, feed, { minRequestMs: 0 });
    const oldVersion = await kv.get(`vendor:${vendor}:__lastgood__`);
    data.productHtml = data.productHtml.replace('"price":"11"', '"price":"12"');
    await quickRun(vendor, kv, feed, { minRequestMs: 0 });
    expect(await kv.get(`vendor:${vendor}:__lastgood__`)).not.toBe(oldVersion);
    const retiredKey = `vendor:${vendor}:__retired__`;
    const retired = JSON.parse((await kv.get(retiredKey))!);
    expect(retired[0].version).toBe(oldVersion);
    expect([...kv.values.keys()].some(key => key.startsWith(`vendor-version:${vendor}:${oldVersion}:`))).toBe(true);
    retired[0].after = 0;
    await kv.put(retiredKey, JSON.stringify(retired));
    await quickRun(vendor, kv, feed, { minRequestMs: 0 });
    expect([...kv.values.keys()].some(key => key.startsWith(`vendor-version:${vendor}:${oldVersion}:`))).toBe(false);
    expect(await kv.get(retiredKey)).toBeNull();
  });
});
