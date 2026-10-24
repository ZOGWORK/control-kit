import { describe, expect, it, vi } from 'vitest';
import { countedFetch, persistLedger, requestKind, RequestLedger } from './onshape-client';
import type { Kv } from './index';

class MemoryKv implements Kv {
  values = new Map<string, string>();
  async get(k: string) { return this.values.get(k) ?? null; }
  async put(k: string, v: string) { this.values.set(k, v); }
  async delete(k: string) { this.values.delete(k); }
}

describe('Onshape request ledger', () => {
  it('classifies every endpoint family the Worker calls', () => {
    expect(requestKind('/api/users/sessioninfo')).toBe('session-info');
    expect(requestKind('/api/v9/assemblies/d/d1/w/w1/e/e1?includeMateFeatures=false')).toBe('assembly-definition');
    expect(requestKind('/api/v9/assemblies/d/d1/v/v1/e/e1/bom?indented=false')).toBe('assembly-bom');
    expect(requestKind('/api/v9/metadata/d/d1/m/m1/e/e1/p')).toBe('metadata');
    expect(requestKind('/api/v9/documents/d/d1/w/w1/elements')).toBe('element-info');
    expect(requestKind('/api/v9/partstudios/d/d1/m/m1/e/e1/massproperties?configuration=x')).toBe('mass-properties');
    expect(requestKind('/api/v9/parts/d/d1/m/m1/e/e1/partid/JHD/stl?mode=binary')).toBe('part-stl');
    expect(requestKind('/api/v9/partstudios/d/d1/m/m1/e/e1/translations', 'POST')).toBe('translation-start');
    expect(requestKind('/api/v9/translations/abc')).toBe('translation-status');
    expect(requestKind('/api/v9/documents/d/d1/externaldata/x1')).toBe('external-data');
    expect(requestKind('https://cad.onshape.com/api/v9/unknown')).toBe('other');
  });
  it('counts statuses, retries, and thrown requests without storing URLs', async () => {
    const ledger = new RequestLedger('scan');
    const responses = [new Response(null, { status: 429 }), new Response('{}', { status: 200 })];
    vi.stubGlobal('fetch', async () => responses.shift() ?? Promise.reject(new Error('Too many subrequests by single Worker invocation: https://cad.onshape.com/api/v9/secret-doc')));
    try {
      await countedFetch(ledger, 'https://cad.onshape.com/api/v9/assemblies/d/d1/w/w1/e/e1');
      await countedFetch(ledger, 'https://cad.onshape.com/api/v9/assemblies/d/d1/w/w1/e/e1', {}, true);
      await expect(countedFetch(ledger, 'https://cad.onshape.com/api/v9/partstudios/d/d1/w/w1/e/e2/massproperties')).rejects.toThrow();
    } finally { vi.unstubAllGlobals(); }
    const summary = ledger.summary();
    expect(summary).toEqual({ total: 3, retries: 1, byKind: { 'assembly-definition': 2, 'mass-properties': 1 }, byStatus: { 200: 1, 429: 1, error: 1 }, errors: { 'subrequest-limit': 1 } });
    expect(JSON.stringify(summary)).not.toContain('secret-doc');
  });
  it('folds operations into one daily aggregate and skips empty operations', async () => {
    const kv = new MemoryKv();
    const now = new Date('2026-10-24T12:00:00Z');
    const scan = new RequestLedger('scan');
    scan.record({ kind: 'assembly-definition', status: 200, retry: false });
    scan.record({ kind: 'mass-properties', status: 404, retry: false });
    const profile = new RequestLedger('oauth-profile');
    profile.record({ kind: 'session-info', status: 200, retry: false });
    await persistLedger(kv, scan, now);
    await persistLedger(kv, profile, now);
    await persistLedger(kv, new RequestLedger('export'), now);
    expect(JSON.parse(kv.values.get('onshape-ledger:2026-10-24')!)).toEqual({ date: '2026-10-24', total: 3, operations: 2, byPurpose: { scan: 2, 'oauth-profile': 1 },
      byKind: { 'assembly-definition': 1, 'mass-properties': 1, 'session-info': 1 }, byStatus: { 200: 2, 404: 1 }, errors: {} });
  });
});
