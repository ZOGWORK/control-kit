import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { URL } from 'node:url';

// Fixture-only seed data. Never upload this file to production KV.
const records = JSON.parse(readFileSync(new URL('../fixtures/vendors/seed.json', import.meta.url), 'utf8')) as Array<{ vendorId: string; normalizedSku: string; normalizedName: string }>;
const entries: Array<{ key: string; value: string }> = [];
const index = new Map<string, Set<string>>();
for (const record of records) {
  const id = `${record.vendorId}:${record.normalizedSku}`;
  entries.push({ key: `vendor:${id}`, value: JSON.stringify(record) });
  for (const token of new Set(record.normalizedName.split(' ').filter(Boolean))) {
    if (!index.has(token)) index.set(token, new Set());
    index.get(token)!.add(id);
  }
}
for (const [token, ids] of index) entries.push({ key: `vendor-index:${token}`, value: JSON.stringify([...ids]) });
mkdirSync(new URL('../.wrangler/', import.meta.url), { recursive: true });
writeFileSync(new URL('../.wrangler/seed-kv.json', import.meta.url), JSON.stringify(entries, null, 2));
process.stdout.write(`Wrote ${entries.length} fixture KV entries to .wrangler/seed-kv.json (local use only)\n`);
