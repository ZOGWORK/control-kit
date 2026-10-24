// Read-only production report: vendor catalog health and the Worker's Onshape request ledger.
// Reads snapshot/pointer keys and `onshape-ledger:*` aggregates through wrangler; never prints cursors,
// records, sessions, or tokens. Usage: node --experimental-strip-types scripts/ops-report.ts [--days 30]
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const vendors = ['gobilda', 'servocity', 'andymark', 'rev', 'pitsco'];
const catalog = 'f04685dda4a64f8093960649885513d6';
const appState = 'c3ef1ad4a11a47f1899c2b63e7a0c3b6';
const days = Number(process.argv[process.argv.indexOf('--days') + 1]) || 30;
// Runs wrangler's own entry point with Node, so no shell parses the arguments on any platform.
const wranglerBin = fileURLToPath(new URL('../apps/worker/node_modules/wrangler/bin/wrangler.js', import.meta.url));
const wrangler = (args: string[]) => execFileSync(process.execPath, [wranglerBin, ...args, '--remote'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
const get = (namespace: string, key: string): string | null => { try { return wrangler(['kv', 'key', 'get', key, '--namespace-id', namespace]).trim() || null; } catch { return null; } };

console.log('Vendor catalogs');
for (const vendor of vendors) {
  const pointer = get(catalog, `vendor:${vendor}:__lastgood__`);
  let snapshot: { lastRunAt?: string; status?: string; recordCount?: number; error?: string; progress?: { pagesDoneInSitemap: number; pagesInSitemap: number; sitemapsDone: number; sitemapsTotal: number; recordsCollected: number } } | null = null;
  try { snapshot = JSON.parse(get(catalog, `vendor:${vendor}:__snapshot__`) ?? 'null'); } catch { /* reported as missing */ }
  const progress = snapshot?.progress ? ` pages ${snapshot.progress.pagesDoneInSitemap}/${snapshot.progress.pagesInSitemap} in sitemap ${snapshot.progress.sitemapsDone + 1}/${snapshot.progress.sitemapsTotal}, ${snapshot.progress.recordsCollected} records collected` : '';
  console.log(`  ${vendor.padEnd(10)} ${pointer ? 'published' : 'unpublished'} | last run ${snapshot?.lastRunAt ?? 'never'} ${snapshot?.status ?? ''} | records ${snapshot?.recordCount ?? 0}${progress}${snapshot?.error ? ` | error: ${snapshot.error}` : ''}`);
}

console.log(`\nOnshape requests recorded by the Worker (last ${days} days)`);
let total = 0;
for (let offset = days - 1; offset >= 0; offset--) {
  const date = new Date(Date.now() - offset * 86400000).toISOString().slice(0, 10);
  const raw = get(appState, `onshape-ledger:${date}`);
  if (!raw) continue;
  const day = JSON.parse(raw);
  total += day.total;
  console.log(`  ${date} ${String(day.total).padStart(5)} requests in ${day.operations} operations | ${JSON.stringify(day.byPurpose)} | ${JSON.stringify(day.byKind)} | status ${JSON.stringify(day.byStatus)}${Object.keys(day.errors).length ? ` | errors ${JSON.stringify(day.errors)}` : ''}`);
}
console.log(`  Total: ${total}. The Onshape Developer page counter remains the authoritative annual figure.`);
