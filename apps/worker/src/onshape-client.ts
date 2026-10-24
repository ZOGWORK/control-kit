import type { OnshapeRequestSummary } from '@control-kit/shared';
import type { Kv } from './index';

/** Endpoint families counted against the owner's annual Onshape API allowance. */
export type OnshapeRequestKind = 'session-info' | 'assembly-definition' | 'assembly-bom' | 'metadata' | 'element-info' | 'mass-properties'
  | 'part-stl' | 'translation-start' | 'translation-status' | 'external-data' | 'other';
export type RequestPurpose = 'oauth-profile' | 'scan' | 'export';
/** Outcome of one outbound request; `error` means the fetch threw before a status arrived. */
export type LedgerEntry = { kind: OnshapeRequestKind; status: number | 'error'; retry: boolean };
export type LedgerSummary = OnshapeRequestSummary;

export function requestKind(path: string, method = 'GET'): OnshapeRequestKind {
  const pathname = new URL(path, 'https://cad.onshape.com').pathname;
  if (pathname === '/api/users/sessioninfo') return 'session-info';
  if (/\/assemblies\/d\/[^/]+\/[wvm]\/[^/]+\/e\/[^/]+\/bom$/.test(pathname)) return 'assembly-bom';
  if (/\/assemblies\/d\/[^/]+\/[wvm]\/[^/]+\/e\/[^/]+$/.test(pathname)) return 'assembly-definition';
  if (pathname.includes('/metadata/')) return 'metadata';
  if (/\/documents\/d\/[^/]+\/[wvm]\/[^/]+\/elements$/.test(pathname)) return 'element-info';
  if (pathname.endsWith('/massproperties')) return 'mass-properties';
  if (/\/partid\/[^/]+\/stl$/.test(pathname) || pathname.includes('/stl-download/')) return 'part-stl';
  if (pathname.endsWith('/translations') && method === 'POST') return 'translation-start';
  if (/\/translations\/[^/]+$/.test(pathname)) return 'translation-status';
  if (pathname.includes('/externaldata/')) return 'external-data';
  return 'other';
}

/** Error names only: messages can echo URLs, and URLs carry document IDs. */
const errorLabel = (error: unknown) => error instanceof Error ? (/subrequest/i.test(error.message) ? 'subrequest-limit' : error.name || 'Error') : 'unknown';

export class RequestLedger {
  readonly entries: LedgerEntry[] = [];
  readonly errors: Record<string, number> = {};
  constructor(readonly purpose: RequestPurpose) {}
  record(entry: LedgerEntry, error?: unknown) {
    this.entries.push(entry);
    if (entry.status === 'error') { const label = errorLabel(error); this.errors[label] = (this.errors[label] ?? 0) + 1; }
  }
  summary(): LedgerSummary {
    const byKind: Record<string, number> = {};
    const byStatus: Record<string, number> = {};
    for (const entry of this.entries) {
      byKind[entry.kind] = (byKind[entry.kind] ?? 0) + 1;
      byStatus[String(entry.status)] = (byStatus[String(entry.status)] ?? 0) + 1;
    }
    return { total: this.entries.length, retries: this.entries.filter(entry => entry.retry).length, byKind, byStatus, errors: { ...this.errors } };
  }
}

/** Sends one counted request. Every attempt, including retries and redirects, is a ledger entry. */
export async function countedFetch(ledger: RequestLedger, target: string | URL, init: RequestInit = {}, retry = false): Promise<Response> {
  const url = target.toString();
  const kind = requestKind(url, init.method ?? 'GET');
  try {
    const response = await fetch(url, init);
    ledger.record({ kind, status: response.status, retry });
    return response;
  } catch (error) {
    ledger.record({ kind, status: 'error', retry }, error);
    throw error;
  }
}

type DailyLedger = { date: string; total: number; byPurpose: Partial<Record<RequestPurpose, number>>; byKind: Record<string, number>; byStatus: Record<string, number>; errors: Record<string, number>; operations: number };
const add = <K extends string>(target: Partial<Record<K, number>>, source: Partial<Record<K, number>>) => {
  for (const [key, value] of Object.entries(source) as Array<[K, number]>) target[key] = (target[key] ?? 0) + value;
};

/**
 * Folds one operation's requests into a per-day aggregate (`onshape-ledger:YYYY-MM-DD`, kept 400 days).
 * One read-modify-write per operation keeps KV writes low; concurrent operations can under-count by one
 * operation's worth, so the Onshape Developer counter stays the authoritative annual total.
 */
export async function persistLedger(kv: Kv, ledger: RequestLedger, now = new Date()) {
  const summary = ledger.summary();
  if (!summary.total) return summary;
  const date = now.toISOString().slice(0, 10);
  const key = `onshape-ledger:${date}`;
  let day: DailyLedger = { date, total: 0, byPurpose: {}, byKind: {}, byStatus: {}, errors: {}, operations: 0 };
  try { const raw = await kv.get(key); if (raw) day = { ...day, ...JSON.parse(raw) as DailyLedger }; } catch { /* A malformed aggregate restarts the day rather than failing the user's request. */ }
  day.total += summary.total;
  day.operations++;
  add(day.byPurpose, { [ledger.purpose]: summary.total } as Partial<Record<RequestPurpose, number>>);
  add(day.byKind, summary.byKind);
  add(day.byStatus, summary.byStatus);
  add(day.errors, summary.errors);
  await kv.put(key, JSON.stringify(day), { expirationTtl: 400 * 86400 });
  return summary;
}
