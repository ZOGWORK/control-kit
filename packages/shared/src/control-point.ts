import type { ScanResult } from './index';

export type ControlPointBomPayload = {
  idempotencyKey: string;
  source: 'control-kit';
  assembly: { name: string; documentId: string; elementId: string; onshapeUrl: string };
  generatedAt: string;
  lines: Array<{ name: string; qty: number; packsToOrder: number | null; vendor: string | null; sku: string | null;
    packPriceUsd: number | null; lineTotalUsd: number | null; matchStatus: ScanResult['lines'][number]['matchStatus'];
    stock: string; type: 'commercial' | 'printed' | 'unknown'; vendorUrl: string | null; partStudioUrl: string }>;
  suppressedCount: number;
  totals: { uniqueLines: number; totalInstances: number; totalCostUsd: number | null; outOfStockLines: number };
};

export interface ControlPointAdapter {
  isLinked(userId: string): Promise<boolean>;
  linkAccount(userId: string, code: string): Promise<void>;
  unlinkAccount(userId: string): Promise<void>;
  syncBom(userId: string, payload: ControlPointBomPayload): Promise<{ workspaceRecordId: string }>;
}

/** Stable for identical BOM data across rescans; changes to a source revision or line produce a new key. */
export async function buildControlPointPayload(result: ScanResult): Promise<ControlPointBomPayload> {
  const lines = [...result.lines].sort((a, b) => a.bomLineKey.localeCompare(b.bomLineKey)).map(line => ({
    name: line.name, qty: line.qty, packsToOrder: line.packsToOrder, vendor: line.vendor?.vendorId ?? null, sku: line.vendor?.sku ?? null,
    packPriceUsd: line.vendor?.priceUsd ?? null, lineTotalUsd: line.lineTotalUsd, matchStatus: line.matchStatus,
    stock: line.vendor?.stock ?? 'unknown', type: line.classification,
    vendorUrl: line.vendor?.url ?? null, partStudioUrl: line.partStudioUrl,
  }));
  const identity = JSON.stringify({ documentId: result.documentId, elementId: result.elementId,
    revisions: result.lines.map(line => [line.bomLineKey, line.sourceType, line.sourceId]).sort(([a], [b]) => String(a).localeCompare(String(b))),
    lines });
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(identity));
  const idempotencyKey = [...new Uint8Array(hash)].map(value => value.toString(16).padStart(2, '0')).join('');
  return { idempotencyKey, source: 'control-kit',
    assembly: { name: result.assemblyName, documentId: result.documentId, elementId: result.elementId,
      onshapeUrl: `https://cad.onshape.com/documents/${encodeURIComponent(result.documentId)}` },
    generatedAt: result.scannedAt, lines, suppressedCount: result.suppressed.reduce((total, line) => total + line.qty, 0),
    totals: { uniqueLines: result.stats.uniqueLines, totalInstances: result.stats.totalInstances, totalCostUsd: result.stats.totalCostUsd, outOfStockLines: result.stats.outOfStockLines } };
}

/** In-memory contract test adapter only. It never performs I/O or contacts Control Point. */
export class MockControlPointAdapter implements ControlPointAdapter {
  readonly payloads: ControlPointBomPayload[] = [];
  private readonly linked = new Set<string>();
  private readonly records = new Map<string, string>();
  async isLinked(userId: string) { return this.linked.has(userId); }
  async linkAccount(userId: string, code: string) {
    if (!userId || !code) throw new Error('A user and mock code are required.');
    this.linked.add(userId);
  }
  async unlinkAccount(userId: string) { this.linked.delete(userId); }
  async syncBom(userId: string, payload: ControlPointBomPayload) {
    if (!this.linked.has(userId)) throw new Error('Mock account is not linked.');
    this.payloads.push(structuredClone(payload));
    const key = `${userId}:${payload.idempotencyKey}`;
    let workspaceRecordId = this.records.get(key);
    if (!workspaceRecordId) { workspaceRecordId = `mock-${this.records.size + 1}`; this.records.set(key, workspaceRecordId); }
    return { workspaceRecordId };
  }
}
