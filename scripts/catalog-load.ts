// Loads a complete vendor catalog into production through the staged publish path (apps/worker/src/catalog-publish.ts).
//
//   npx tsx scripts/catalog-load.ts stage    --vendor gobilda --feed goBILDA.csv [--map sku="Product Code" --map packQty="Qty/Pack"]
//   npx tsx scripts/catalog-load.ts stage    --vendor gobilda --crawl work/backfill/gobilda.json
//   npx tsx scripts/catalog-load.ts stage    --vendor rev [--feed products.json]
//   npx tsx scripts/catalog-load.ts validate --vendor gobilda --gen <gen> [--expect 1121-0010-0264,1309-0016-4008] [--spot 20]
//   npx tsx scripts/catalog-load.ts publish  --vendor gobilda --gen <gen> [--expect ...] [--spot 20]
//   npx tsx scripts/catalog-load.ts retire   --vendor gobilda [--limit 200]
//
// `stage` writes a new generation that no reader sees. `publish` re-runs validation and refuses unless it passes; the
// live generation is kept as `previous` for a day of rollback. A published official feed stops the hourly crawl for
// that vendor until the feed is older than VENDOR_STALE_HOURS. `retire` deletes replaced generations whose day of
// rollback is over, which the crawl normally does, so they do not pile up while crawls are paused. It fetches nothing
// from vendor sites. Uses wrangler's credentials; never prints records.
//
// REV is loaded only from its official feed (apps/worker/src/rev-feed.ts): `stage --vendor rev` makes one GET of the
// feed (or reads a saved copy with --feed), and REV refuses crawl dumps and --spot, which would fetch its product pages.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeSku, type VendorId, type VendorRecord } from '../packages/shared/src/index';
import { propagationMs, publishStaged, spotCheck, stageCatalog, validateStaged } from '../apps/worker/src/catalog-publish';
import { normalizeFeedRows, parseCsv, parseJsonFeed, type FeedField } from '../apps/worker/src/feed-import';
import { checkRevFeed, fetchRevFeed, parseRevFeed, revMinRecords } from '../apps/worker/src/rev-feed';
import { applyPackEvidence, batchKey, pointerKey, retireReplaced, type CatalogPointer } from '../apps/worker/src/vendor-ingest';
import type { Kv } from '../apps/worker/src/index';

const [mode, ...rest] = process.argv.slice(2);
const flag = (name: string) => { const at = rest.indexOf(`--${name}`); return at >= 0 ? rest[at + 1] : undefined; };
const flags = (name: string) => rest.flatMap((value, at) => rest[at - 1] === `--${name}` ? [value] : []);
const vendor = flag('vendor') as VendorId;
if (!['gobilda', 'servocity', 'andymark', 'rev', 'pitsco'].includes(vendor)) throw new Error('--vendor gobilda|servocity|andymark|rev|pitsco');

const namespace = 'f04685dda4a64f8093960649885513d6';
const wranglerBin = fileURLToPath(new URL('../apps/worker/node_modules/wrangler/bin/wrangler.js', import.meta.url));
const wrangler = (args: string[]) => execFileSync(process.execPath, [wranglerBin, 'kv', ...args, '--namespace-id', namespace, '--remote'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
/** Production VENDOR_CATALOG through wrangler. Writes are buffered and sent as one bulk upload by `flush`. */
const pending: Array<{ key: string; value: string }> = [];
const kv: Kv & { flush(): void } = {
  async get(key) {
    try { return wrangler(['key', 'get', key, '--text']) || null; }
    catch (error) { if (/404/.test(String((error as { stderr?: unknown }).stderr ?? ''))) return null; throw error; }
  },
  async put(key, value) { pending.push({ key, value }); },
  // Only a key that is already gone counts as deleted; any other failure stops the command before progress is saved.
  async delete(key) {
    try { wrangler(['key', 'delete', key]); }
    catch (error) { if (!/404|not found/i.test(String((error as { stderr?: unknown }).stderr ?? ''))) throw error; }
  },
  flush() {
    if (!pending.length) return;
    const file = join(mkdtempSync(join(tmpdir(), 'catalog-')), 'bulk.json');
    writeFileSync(file, JSON.stringify(pending));
    wrangler(['bulk', 'put', file]);
    pending.length = 0;
  },
};

async function liveRecords(gen: string) {
  const manifest = JSON.parse(await kv.get(`cat:${vendor}:gen:${gen}:manifest`) ?? 'null') as { batches: number } | null;
  const records: VendorRecord[] = [];
  for (let batch = 0; batch < (manifest?.batches ?? 0); batch++) records.push(...JSON.parse(await kv.get(batchKey(vendor, gen, batch)) ?? '[]') as VendorRecord[]);
  return records;
}
async function validate(gen: string) {
  const expect = (flag('expect') ?? '').split(',').map(sku => sku.trim()).filter(Boolean).map(sku => normalizeSku(sku, vendor));
  const result = await validateStaged(vendor, kv, gen, { expectSkus: expect, minRecords: Number(flag('min') ?? (vendor === 'rev' ? revMinRecords : 1)) });
  console.log(`${vendor} ${gen}: ${result.records} records, ${result.priced} priced, ${result.verifiedPacks} verified packs; live ${result.liveRecords ?? 'none'}`);
  for (const problem of result.problems) console.log(`  PROBLEM ${problem}`);
  const spot = Number(flag('spot') ?? 0);
  if (spot && vendor === 'rev') throw new Error('REV product pages are never fetched; its feed is checked by validate without --spot');
  let spotOk = true;
  if (spot) {
    const checks = await spotCheck(await liveRecords(gen), url => fetch(url, { headers: { 'user-agent': 'Control Kit vendor catalog (+https://github.com/ZOGWORK/control-kit)' } }), spot);
    const good = checks.filter(check => check.skuOnPage && check.priceOnPage).length;
    for (const check of checks.filter(item => !item.skuOnPage || !item.priceOnPage)) console.log(`  DIFF ${check.sku} $${check.price} ${check.skuOnPage ? '' : '[sku not on page]'} ${check.priceOnPage ? '' : '[price not on page]'} ${check.url}`);
    console.log(`  spot checks: ${good}/${checks.length} match the vendor's page`);
    // More than one mismatch in twenty is a parsing or mapping problem, not a price change between fetches; none at all never passes.
    spotOk = good > 0 && checks.length - good <= Math.floor(checks.length / 20);
  }
  return result.ok && spotOk;
}

if (mode === 'stage') {
  let records: VendorRecord[];
  let rejected = 0;
  let source: 'crawl' | 'official-feed';
  let skipped = {};
  if (vendor === 'rev') {
    if (flag('crawl')) throw new Error('REV is never crawled; stage it from its official feed');
    let body: string; let updatedAt: string;
    if (flag('feed')) { body = readFileSync(flag('feed')!, 'utf8'); updatedAt = statSync(flag('feed')!).mtime.toISOString(); }
    else {
      const response = await fetchRevFeed();
      if (response.status !== 'ok') throw new Error('REV feed answered 304 without a validator');
      body = response.body; updatedAt = response.updatedAt;
    }
    const feed = parseRevFeed(body, updatedAt);
    console.log(`rev: ${feed.rows} feed rows updated ${updatedAt}; ${feed.records.length} usable, ${feed.rejected.length} rejected`);
    for (const reason of [...new Set(feed.rejected.map(item => item.reason))]) console.log(`  rejected (${feed.rejected.filter(item => item.reason === reason).length}): ${reason}, e.g. row ${feed.rejected.find(item => item.reason === reason)!.row}`);
    const problems = checkRevFeed(feed);
    if (problems.length) throw new Error(`Not staged: ${problems.join('; ')}`);
    records = feed.records; rejected = feed.rejected.length; source = 'official-feed';
  } else if (flag('feed')) {
    const text = readFileSync(flag('feed')!, 'utf8');
    const rows = flag('feed')!.toLowerCase().endsWith('.json') ? parseJsonFeed(text) : parseCsv(text);
    const mapping = Object.fromEntries(flags('map').map(pair => pair.split('=').map(part => part.trim().replace(/^"|"$/g, '')))) as Partial<Record<FeedField, string>>;
    const feed = normalizeFeedRows(vendor, rows, new Date().toISOString(), mapping);
    console.log(`${vendor}: ${rows.length} rows, columns ${JSON.stringify(feed.columns)}; ${feed.records.length} usable, ${feed.rejected.length} rejected`);
    for (const reason of [...new Set(feed.rejected.map(item => item.reason))]) console.log(`  rejected (${feed.rejected.filter(item => item.reason === reason).length}): ${reason}, e.g. row ${feed.rejected.find(item => item.reason === reason)!.row}`);
    records = feed.records; rejected = feed.rejected.length; source = 'official-feed';
  } else if (flag('crawl')) {
    // A local crawl dump (the in-memory KV of runVendor) with a complete pointer.
    const dump = JSON.parse(readFileSync(flag('crawl')!, 'utf8')) as Record<string, string>;
    const pointer = JSON.parse(dump[pointerKey(vendor)] ?? 'null') as CatalogPointer | null;
    if (!pointer?.complete) throw new Error('The crawl dump has no complete catalog');
    // Records crawled before pack evidence rules existed get the same SKU-suffix and single-unit evidence as a fresh crawl.
    records = Array.from({ length: pointer.batches ?? 0 }, (_, batch) => JSON.parse(dump[batchKey(vendor, pointer.gen, batch)] ?? '[]') as VendorRecord[]).flat().map(record => applyPackEvidence(record));
    source = 'crawl'; skipped = pointer.skipped ?? {};
  } else throw new Error('stage needs --feed <file> or --crawl <dump>');
  const manifest = await stageCatalog(vendor, records, kv, { source, rejected, skipped, note: flag('note') });
  kv.flush();
  console.log(`${vendor}: staged ${manifest.records} records as gen ${manifest.gen} (${manifest.source}); the live catalog is unchanged. Next: validate --gen ${manifest.gen}`);
} else if (mode === 'validate') {
  process.exitCode = await validate(flag('gen')!) ? 0 : 1;
} else if (mode === 'publish') {
  if (!await validate(flag('gen')!)) { console.log('Not published: validation failed. The live catalog is unchanged.'); process.exitCode = 1; }
  else {
    const manifest = JSON.parse(await kv.get(`cat:${vendor}:gen:${flag('gen')}:manifest`) ?? 'null') as { stagedAt: string } | null;
    const wait = manifest ? propagationMs - (Date.now() - Date.parse(manifest.stagedAt)) : 0;
    if (wait > 0) { console.log(`Waiting ${Math.ceil(wait / 1000)}s for the staged keys to reach every KV location…`); await new Promise(resolve => setTimeout(resolve, wait)); }
    const pointer = await publishStaged(vendor, kv, flag('gen')!);
    kv.flush();
    console.log(`${vendor}: gen ${pointer.gen} is live (${pointer.records} records, ${pointer.source ?? 'crawl'}); previous ${pointer.previous?.gen ?? 'none'} kept until ${pointer.previous ? new Date(pointer.previous.deleteAfter).toISOString() : '-'}`);
  }
} else if (mode === 'retire') {
  const { deleted, waiting } = await retireReplaced(vendor, kv, Number(flag('limit') ?? 200));
  kv.flush();
  console.log(`${vendor}: deleted ${deleted} keys of replaced catalogs; still waiting: ${waiting.join(', ') || 'none'}`);
} else throw new Error('mode: stage | validate | publish | retire');
