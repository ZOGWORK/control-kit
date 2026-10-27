import { isBundle, normalizeName, normalizeSku, type VendorRecord } from '@control-kit/shared';
import type { Kv } from './index';
import { manifestKey, propagationMs, publishStaged, stageCatalog, validateStaged } from './catalog-publish';
import { allowedUrl, batchKey, indexKey, pointerKey, retireReplaced, snapshotKey, vendorSources, type CatalogPointer, type VendorSnapshot } from './vendor-ingest';

/*
 * REV Robotics' official product feed, used with REV's permission since 2026-10-26; REV is never crawled. The feed is
 * one JSON array, refreshed daily at midnight Central Time. Each row has exactly `sku`, `name`, `availability_status`
 * ("Available" or "Out of Stock"), `price` (USD number), `url` (the product page on www.revrobotics.com), and
 * `image_url`. It has no pack quantity, stock count, category, or timestamp field; the response's Last-Modified header
 * is when REV last rebuilt it. REV's conditions: every REV listing links to REV's own product page (`url`), and
 * displayed REV prices and stock show when the feed was last updated (`VendorRecord.updatedAt`).
 *
 * Only what the feed states is mapped. A product absent from the feed does not exist in the catalog: nothing is carried
 * over from the crawled catalog, so a discontinued SKU (REV-31-1152, replaced by REV-31-1595) cannot come back unless
 * REV lists it. `image_url` is not used: REV's permission covers listings, prices, and stock, not its photos.
 */
export const revFeedUrl = vendorSources.rev.officialFeed!;
/**
 * Cron state: the last response's validators, when it was checked, and a staged generation waiting to be published with
 * the live generation it was staged against (`over`), so a catalog published meanwhile by hand is never replaced by it.
 */
export const revFeedStateKey = 'cat:rev:feed';
/** The feed listed 976 products on 2026-10-26; one with under half of that is truncated, not a smaller catalog. */
export const revMinRecords = 500;
/** More rejected rows than this means the feed's format changed; staging what is left would drop most of the catalog. */
const maxRejectedShare = 0.1;
const userAgent = 'Control Kit vendor catalog (+https://github.com/ZOGWORK/control-kit)';

export type RevFeedRejection = { row: number; sku: string | null; reason: string };
type FeedState = { etag: string | null; lastModified: string | null; checkedAt: string; staged: { gen: string; stagedAt: string; updatedAt: string; records: number; over: string | null } | null };
export type RevFeedRun = { vendor: 'rev'; source: 'official-feed'; action: 'skipped' | 'unchanged' | 'staged' | 'waiting' | 'published' | 'rejected' | 'abandoned'; records: number; problems: string[] };

/**
 * Pack size from REV's own SKU: REV sells every multi-unit product under a "-PKn" SKU (387 of the 976 feed rows). A
 * product name is never read for a count; feed names say "1 Piece Shaft Collar ... 4 Pack" (REV-21-1911-PK4) and
 * "2 Piece" for one two-part collar (REV-21-2581). Checked across the whole feed on 2026-10-26, every product without the
 * suffix is one unit. A bundle holds different pieces, so it gets no pack size at all.
 */
function revPack(sku: string, name: string): Pick<VendorRecord, 'packSize' | 'packSizeVerified' | 'packEvidence'> {
  if (isBundle(name)) return { packSize: null, packSizeVerified: false, packEvidence: 'a bundle of different pieces, so no pack size for one part' };
  const suffix = sku.match(/-PK(\d{1,4})$/i);
  if (suffix && Number(suffix[1]) > 0) return { packSize: Number(suffix[1]), packSizeVerified: true, packEvidence: `REV feed SKU suffix "${suffix[0].slice(1)}"` };
  return { packSize: 1, packSizeVerified: true, packEvidence: 'sold individually: REV gives every multi-unit product a -PKn SKU in its feed' };
}
function revStock(status: unknown): VendorRecord['stock'] {
  const text = typeof status === 'string' ? status.trim().toLowerCase() : '';
  if (text === 'available' || text === 'in stock') return 'in';
  if (/out of stock|sold out|unavailable|discontinued|backorder/.test(text)) return 'out';
  return 'unknown';
}

/** Feed body → records, with each unusable row and why. Throws when the body is not a list of products. */
export function parseRevFeed(body: string, updatedAt: string): { records: VendorRecord[]; rejected: RevFeedRejection[]; rows: number } {
  let rows: unknown;
  try { rows = JSON.parse(body); } catch { throw new Error('REV feed was not JSON'); }
  if (!Array.isArray(rows)) throw new Error('REV feed was not a list of products');
  const records: VendorRecord[] = [];
  const rejected: RevFeedRejection[] = [];
  rows.forEach((raw: unknown, row) => {
    const item = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
    const sku = typeof item.sku === 'string' ? item.sku.trim() : '';
    const name = typeof item.name === 'string' ? item.name.trim() : '';
    const url = typeof item.url === 'string' ? item.url.trim() : '';
    const normalizedSku = normalizeSku(sku, 'rev');
    if (!sku || !/^[A-Z0-9]+$/.test(normalizedSku)) return rejected.push({ row, sku: sku || null, reason: 'no usable SKU' });
    if (!name) return rejected.push({ row, sku, reason: 'no name' });
    // REV's first condition: the link is REV's own product page, so a row without one is not listed at all.
    if (!allowedUrl('rev', url) || new URL(url).pathname === '/') return rejected.push({ row, sku, reason: 'no product page on www.revrobotics.com' });
    const price = typeof item.price === 'number' ? item.price : typeof item.price === 'string' && /^\d+(?:\.\d+)?$/.test(item.price.trim()) ? Number(item.price) : NaN;
    records.push({ vendorId: 'rev', sku, normalizedSku, name, normalizedName: normalizeName(name), url, priceUsd: Number.isFinite(price) && price > 0 ? Math.round(price * 100) / 100 : null,
      ...revPack(sku, name), stock: revStock(item.availability_status), stockQty: null, category: 'uncategorized', updatedAt, source: 'feed', parser: 'official-feed' });
  });
  return { records, rejected, rows: rows.length };
}

/** Records the cron or the load script may stage, or why the feed must not replace the live catalog. */
export function checkRevFeed(parsed: ReturnType<typeof parseRevFeed>): string[] {
  const problems: string[] = [];
  if (parsed.records.length < revMinRecords) problems.push(`Only ${parsed.records.length} usable products; expected at least ${revMinRecords}`);
  if (parsed.rows && parsed.rejected.length / parsed.rows > maxRejectedShare) {
    const first = parsed.rejected[0];
    problems.push(`${parsed.rejected.length} of ${parsed.rows} rows rejected (row ${first.row}${first.sku ? ` ${first.sku}` : ''}: ${first.reason})`);
  }
  return problems;
}

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;
export type RevFeedResponse = { status: 'unchanged' } | { status: 'ok'; body: string; etag: string | null; lastModified: string | null; updatedAt: string };
/**
 * One GET of the feed: the only request Control Kit makes to REV for its catalog. With `etag`, an unchanged feed answers
 * 304 and nothing is downloaded. `updatedAt` is the Last-Modified time REV sent, or the fetch time without a usable one.
 */
export async function fetchRevFeed(fetcher: Fetcher = fetch, options: { etag?: string | null; now?: Date } = {}): Promise<RevFeedResponse> {
  const headers: Record<string, string> = { 'user-agent': userAgent, accept: 'application/json' };
  if (options.etag) headers['if-none-match'] = options.etag;
  let response: Response;
  try { response = await fetcher(revFeedUrl, { headers, signal: AbortSignal.timeout(30000) }); }
  catch (cause) { throw new Error(`REV feed request failed (${cause instanceof Error ? cause.name : 'error'})`); }
  if (response.status === 304) return { status: 'unchanged' };
  if (!response.ok) throw new Error(`REV feed returned HTTP ${response.status}`);
  const now = options.now ?? new Date();
  const lastModified = response.headers.get('last-modified');
  const modified = lastModified ? Date.parse(lastModified) : NaN;
  const updatedAt = Number.isFinite(modified) && modified <= now.getTime() ? new Date(modified).toISOString() : now.toISOString();
  return { status: 'ok', body: await response.text(), etag: response.headers.get('etag'), lastModified, updatedAt };
}

const json = async <T>(kv: Kv, key: string): Promise<T | null> => { const raw = await kv.get(key); if (!raw) return null; try { return JSON.parse(raw) as T; } catch { return null; } };
/** A staged generation no reader was ever pointed at, so its keys can go at once. One the pointer names is never touched. */
async function discardStaged(kv: Kv, gen: string) {
  const live = await json<CatalogPointer>(kv, pointerKey('rev'));
  if (live && [live.gen, live.previous?.gen, ...(live.retiring ?? []).map(entry => entry.gen)].includes(gen)) return;
  const manifest = await json<{ batches: number }>(kv, manifestKey('rev', gen));
  for (let batch = 0; batch < (manifest?.batches ?? 0); batch++) await kv.delete(batchKey('rev', gen, batch));
  await kv.delete(indexKey('rev', gen));
  await kv.delete(manifestKey('rev', gen));
}

/**
 * One scheduled step of the REV catalog, through the same staged publish as `scripts/catalog-load.ts`, so a bad feed never
 * replaces a good catalog. A run does one thing: publish a staged generation once KV has propagated it (after
 * validating it again), or, at most every `checkEveryHours`, fetch the feed and stage it if it changed. A feed that is
 * unreachable, malformed, truncated, or mostly unusable fails the run and leaves the live catalog as it was. Every run
 * first deletes replaced generations whose day of rollback is over (at most 20 keys), as a crawl run would.
 */
export async function runRevFeed(kv: Kv, fetcher: Fetcher = fetch, options: { now?: () => Date; checkEveryHours?: number } = {}): Promise<RevFeedRun> {
  const now = options.now ?? (() => new Date());
  const state = await json<FeedState>(kv, revFeedStateKey);
  await retireReplaced('rev', kv, 20);
  const pointer = await json<CatalogPointer>(kv, pointerKey('rev'));
  const summary = (action: RevFeedRun['action'], records = 0, problems: string[] = []): RevFeedRun => {
    const run: RevFeedRun = { vendor: 'rev', source: 'official-feed', action, records, problems };
    console.log(JSON.stringify(run));
    return run;
  };
  const failed = async (error: string) => {
    const snapshot: VendorSnapshot = { status: 'failed', updatedAt: pointer?.completedAt ?? pointer?.publishedAt ?? null, lastRunAt: now().toISOString(), recordCount: pointer?.records ?? 0, source: 'official-feed',
      version: pointer?.gen ?? null, complete: pointer?.complete ?? false, skipped: pointer?.skipped ?? {}, error: error.slice(0, 200) };
    await kv.put(snapshotKey('rev'), JSON.stringify(snapshot));
  };
  try {
    if (state?.staged) {
      // Already live: an earlier run published it but stopped before clearing the state. Only the state is finished.
      if (pointer?.gen === state.staged.gen) {
        // The snapshot may be the one from before that publication, so it is rebuilt from the live pointer as publishStaged writes it.
        const at = pointer.completedAt ?? pointer.publishedAt;
        await kv.put(snapshotKey('rev'), JSON.stringify({ status: 'ok', updatedAt: at, lastRunAt: now().toISOString(), recordCount: pointer.records, source: 'official-feed', version: pointer.gen,
          complete: true, skipped: pointer.skipped ?? {} } satisfies VendorSnapshot));
        await kv.put(revFeedStateKey, JSON.stringify({ ...state, staged: null } satisfies FeedState));
        return summary('published', pointer.records);
      }
      // A catalog published since this one was staged (a manual load of a newer feed) wins: the staged one is dropped.
      if ((pointer?.gen ?? null) !== state.staged.over) {
        await discardStaged(kv, state.staged.gen);
        await kv.put(revFeedStateKey, JSON.stringify({ ...state, etag: null, lastModified: null, staged: null } satisfies FeedState));
        return summary('abandoned', state.staged.records);
      }
      if (now().getTime() - Date.parse(state.staged.stagedAt) < propagationMs) return summary('waiting', state.staged.records);
      const validation = await validateStaged('rev', kv, state.staged.gen, { minRecords: revMinRecords });
      if (!validation.ok) {
        await discardStaged(kv, state.staged.gen);
        // The validators are dropped so the next check downloads the feed again instead of trusting a 304 for it.
        await kv.put(revFeedStateKey, JSON.stringify({ ...state, etag: null, lastModified: null, staged: null } satisfies FeedState));
        await failed(`REV feed not published: ${validation.problems.join('; ')}`);
        return summary('rejected', validation.records, validation.problems);
      }
      const published = await publishStaged('rev', kv, state.staged.gen, { now: now() });
      await kv.put(revFeedStateKey, JSON.stringify({ ...state, staged: null } satisfies FeedState));
      return summary('published', published.records);
    }
    if (state && now().getTime() - Date.parse(state.checkedAt) < (options.checkEveryHours ?? 6) * 3600000) return summary('skipped');
    // Validators only count while the live catalog came from this feed; otherwise the feed is read in full.
    const fromFeed = pointer?.source === 'official-feed';
    const response = await fetchRevFeed(fetcher, { etag: fromFeed ? state?.etag : null, now: now() });
    if (response.status === 'unchanged' || (fromFeed && response.lastModified && response.lastModified === state?.lastModified)) {
      await kv.put(revFeedStateKey, JSON.stringify({ etag: state?.etag ?? null, lastModified: state?.lastModified ?? null, checkedAt: now().toISOString(), staged: null } satisfies FeedState));
      // A run that failed earlier (REV unreachable) left a failed status; the live catalog is this feed, so it is fine again.
      const snapshot = await json<VendorSnapshot>(kv, snapshotKey('rev'));
      if (snapshot?.status === 'failed' && pointer) await kv.put(snapshotKey('rev'), JSON.stringify({ ...snapshot, status: 'ok', lastRunAt: now().toISOString(), error: undefined } satisfies VendorSnapshot));
      return summary('unchanged', pointer?.records ?? 0);
    }
    const parsed = parseRevFeed(response.body, response.updatedAt);
    const problems = checkRevFeed(parsed);
    if (problems.length) throw new Error(`REV feed not staged: ${problems.join('; ')}`);
    const manifest = await stageCatalog('rev', parsed.records, kv, { source: 'official-feed', rejected: parsed.rejected.length, note: `REV official feed, updated ${response.updatedAt}`, now: now() });
    await kv.put(revFeedStateKey, JSON.stringify({ etag: response.etag, lastModified: response.lastModified, checkedAt: now().toISOString(),
      staged: { gen: manifest.gen, stagedAt: manifest.stagedAt, updatedAt: response.updatedAt, records: manifest.records, over: pointer?.gen ?? null } } satisfies FeedState));
    return summary('staged', manifest.records);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : 'REV feed import failed';
    await failed(message);
    console.error(JSON.stringify({ vendor: 'rev', source: 'official-feed', error: message.slice(0, 200) }));
    throw cause;
  }
}
