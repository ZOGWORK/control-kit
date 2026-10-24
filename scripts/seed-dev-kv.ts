import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { URL } from 'node:url';

// Fixture-only seed data in the crawler's pointer/index/batch layout. Never upload this file to production KV.
const records = JSON.parse(readFileSync(new URL('../fixtures/vendors/seed.json', import.meta.url), 'utf8')) as Array<{ vendorId: string; normalizedSku: string; normalizedName: string }>;
const entries: Array<{ key: string; value: string }> = [];
const now = new Date().toISOString();
for (const vendor of new Set(records.map(record => record.vendorId))) {
  const own = records.filter(record => record.vendorId === vendor);
  entries.push({ key: `cat:${vendor}:pointer`, value: JSON.stringify({ gen: 'seed', complete: true, records: own.length, publishedAt: now, completedAt: now, previous: null }) });
  entries.push({ key: `cat:${vendor}:gen:seed:batch:0`, value: JSON.stringify(own) });
  entries.push({ key: `cat:${vendor}:gen:seed:index`, value: JSON.stringify(own.map(record => [record.normalizedSku, record.normalizedName, 0])) });
  entries.push({ key: `vendor:${vendor}:__snapshot__`, value: JSON.stringify({ status: 'ok', updatedAt: now, lastRunAt: now, recordCount: own.length, source: 'sitemap', version: 'seed', complete: true }) });
}
mkdirSync(new URL('../.wrangler/', import.meta.url), { recursive: true });
writeFileSync(new URL('../.wrangler/seed-kv.json', import.meta.url), JSON.stringify(entries, null, 2));
process.stdout.write(`Wrote ${entries.length} fixture KV entries to .wrangler/seed-kv.json (local use only)\n`);
