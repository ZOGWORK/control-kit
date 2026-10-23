import { describe, expect, it } from 'vitest';
import { aggregateAssembly, recalculatePurchasing, type VendorRecord } from './index';
import { buildControlPointPayload, MockControlPointAdapter } from './control-point';

describe('Control Point contract scaffold', () => {
  it('round-trips a payload through the in-memory adapter with a stable idempotency key', async () => {
    const result = aggregateAssembly({ rootAssembly: { instances: [
      { id: 'a', name: 'Screw', type: 'Part', documentId: 'doc', elementId: 'parts', partId: 'screw' },
    ] } }, { documentId: 'doc', elementId: 'assembly', workspaceOrVersion: 'w', workspaceOrVersionId: 'work' }, 'Robot');
    const adapter = new MockControlPointAdapter();
    expect(await adapter.isLinked('student')).toBe(false);
    await expect(adapter.syncBom('student', await buildControlPointPayload(result))).rejects.toThrow('not linked');
    await adapter.linkAccount('student', 'local-test-code');
    const first = await buildControlPointPayload(result);
    const second = await buildControlPointPayload({ ...result, scannedAt: '2027-01-01T00:00:00Z', scanId: 'new-scan' });
    expect(second.idempotencyKey).toBe(first.idempotencyKey);
    expect((await adapter.syncBom('student', first)).workspaceRecordId).toBe('mock-1');
    expect((await adapter.syncBom('student', second)).workspaceRecordId).toBe('mock-1');
    expect(adapter.payloads).toHaveLength(2);
    expect(adapter.payloads[0].lines[0]).toMatchObject({ name: 'Screw', qty: 1, vendor: null });
    result.lines[0].qty = 2;
    expect((await buildControlPointPayload(result)).idempotencyKey).not.toBe(first.idempotencyKey);
    await adapter.unlinkAccount('student');
    expect(await adapter.isLinked('student')).toBe(false);
    await expect(adapter.syncBom('student', first)).rejects.toThrow('not linked');
  });
  it('keeps CAD units separate from pack charges in the proposed payload', async () => {
    const instances = Array.from({ length: 12 }, (_, index) => ({ id: `${index}`, name: `M3 Screw <${index + 1}>`, type: 'Part', documentId: 'doc', elementId: 'parts', partId: 'screw' }));
    const result = aggregateAssembly({ rootAssembly: { instances } }, { documentId: 'doc', elementId: 'assembly', workspaceOrVersion: 'w', workspaceOrVersionId: 'work' }, 'Robot');
    const record: VendorRecord = { vendorId: 'andymark', sku: 'AM-1000', normalizedSku: '1000', name: 'M3 Screw', normalizedName: 'm3 screw',
      url: 'https://www.andymark.com/products/m3-screw', priceUsd: 8.99, packSize: 10, packSizeVerified: true,
      stock: 'in', stockQty: null, category: 'hardware', updatedAt: '2026-10-23T00:00:00Z', source: 'feed' };
    result.lines[0].vendor = record; result.lines[0].matchStatus = 'exact';
    recalculatePurchasing(result);
    expect((await buildControlPointPayload(result)).lines[0]).toMatchObject({ qty: 12, packsToOrder: 2, packPriceUsd: 8.99, lineTotalUsd: 17.98 });
    result.lines[0].vendor = { ...record, packSizeVerified: false };
    recalculatePurchasing(result);
    expect((await buildControlPointPayload(result)).lines[0]).toMatchObject({ qty: 12, packsToOrder: null, lineTotalUsd: null });
  });
  it('keeps the key stable when Onshape returns the same parts in a different order', async () => {
    const result = aggregateAssembly({ rootAssembly: { instances: [
      { id: 'a', name: 'Bracket', type: 'Part', documentId: 'doc', elementId: 'parts', partId: 'a' },
      { id: 'b', name: 'Bracket', type: 'Part', documentId: 'doc', elementId: 'parts', partId: 'b' },
    ] } }, { documentId: 'doc', elementId: 'assembly', workspaceOrVersion: 'w', workspaceOrVersionId: 'work' }, 'Robot');
    const forward = await buildControlPointPayload(result);
    const reversed = await buildControlPointPayload({ ...result, lines: [...result.lines].reverse() });
    expect(reversed.idempotencyKey).toBe(forward.idempotencyKey);
  });
  it('uses a new key when assembly name or suppressed quantity changes', async () => {
    const result = aggregateAssembly({ rootAssembly: { instances: [
      { id: 'a', name: 'Screw', type: 'Part', documentId: 'doc', elementId: 'parts', partId: 'screw' },
    ] } }, { documentId: 'doc', elementId: 'assembly', workspaceOrVersion: 'w', workspaceOrVersionId: 'work' }, 'Robot');
    const original = await buildControlPointPayload(result);
    const renamed = await buildControlPointPayload({ ...result, assemblyName: 'Robot Mk II' });
    const suppressed = await buildControlPointPayload({ ...result, suppressed: [{ ...result.lines[0], suppressed: true }] });
    expect(renamed.idempotencyKey).not.toBe(original.idempotencyKey);
    expect(suppressed.idempotencyKey).not.toBe(original.idempotencyKey);
  });
});
