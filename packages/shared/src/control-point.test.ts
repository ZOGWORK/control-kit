import { describe, expect, it } from 'vitest';
import { aggregateAssembly, recalculatePurchasing, type VendorRecord } from './index';
import { buildControlPointPayload, INLINE_FILE_LIMIT_BYTES, MockControlPointAdapter } from './control-point';

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
    result.lines[0].vendor = record; result.lines[0].matchStatus = 'exact'; result.lines[0].disposition = 'buy';
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

describe('Control Point attach bundle', () => {
  const context = { documentId: 'doc', elementId: 'assembly', workspaceOrVersion: 'w' as const, workspaceOrVersionId: 'work' };
  function scan() {
    const result = aggregateAssembly({ rootAssembly: { instances: [
      { id: 'a', name: 'Drivetrain', type: 'Assembly', documentId: 'doc', elementId: 'dt' },
      { id: 'b', name: 'Spare plate', type: 'Part', documentId: 'doc', elementId: 'parts', partId: 'spare', suppressed: true },
    ] }, subAssemblies: [{ documentId: 'doc', elementId: 'dt', instances: [
      { id: 'c', name: 'Motor mount', type: 'Part', documentId: 'doc', elementId: 'parts', partId: 'mount' },
      { id: 'd', name: 'Linked bracket', type: 'Part', documentId: 'lib', elementId: 'x', partId: 'br' },
    ] }] }, context, 'Robot');
    result.missingMetadata = [{ ...result.lines.find(line => line.name === 'Linked bracket')!, missingMetadataReason: 'Source revision unavailable for linked document' }];
    result.diagnostics = { onshapeRequests: null, metadataIssues: [], revision: { type: 'm', id: 'micro1' } };
    const mount = result.lines.find(line => line.name === 'Motor mount')!;
    mount.manualClassification = 'print'; mount.disposition = 'print';
    return result;
  }
  it('carries every line, the suppressed and missing-metadata lines, links that open, and Control Point CAD parts', async () => {
    const bundle = await buildControlPointPayload(scan(), { context });
    expect(bundle.lines.map(line => line.name).sort()).toEqual(['Linked bracket', 'Motor mount']);
    expect(bundle.suppressedLines.map(line => line.name)).toEqual(['Spare plate']);
    expect(bundle.missingMetadataLines[0].metadataIssue).toBe('Source revision unavailable for linked document');
    expect(bundle.assembly.assemblyUrl).toBe('https://cad.onshape.com/documents/doc/w/work/e/assembly');
    expect(bundle.revision).toEqual({ type: 'm', id: 'micro1' });
    expect(bundle.controlPointCadUrl).toBe('https://tryctrlpoint.org/cad-parts');
    const mount = bundle.cadParts.find(part => part.name === 'Motor mount')!;
    expect(mount).toMatchObject({ section: 'Drivetrain', quantity: 1, source: 'printed', unit_cost: 0, status: 'to_order' });
    expect(mount.extra).toMatchObject({ disposition: 'print', manualOverride: 'print', partStudioUrl: 'https://cad.onshape.com/documents/doc/w/work/e/parts' });
    // A microversion context cannot be opened from outside Onshape, so the assembly link falls back to the document.
    expect((await buildControlPointPayload(scan(), { context: { ...context, workspaceOrVersion: 'm', workspaceOrVersionId: 'micro1' } })).assembly.assemblyUrl).toBe('https://cad.onshape.com/documents/doc');
  });
  it('attaches files inline or by reference, never drops one, and keeps the key independent of file bytes', async () => {
    const small = new Uint8Array([1, 2, 3]);
    const large = new Uint8Array(INLINE_FILE_LIMIT_BYTES + 1);
    const bundle = await buildControlPointPayload(scan(), { context, files: [
      { name: 'Robot BOM.xlsx', mediaType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', bytes: small },
      { name: 'Robot STEP.zip', mediaType: 'application/zip', bytes: large },
    ], filesNotIncluded: [] });
    expect(bundle.files[0]).toMatchObject({ delivery: 'inline', contentBase64: 'AQID', sizeBytes: 3 });
    expect(bundle.files[1]).toMatchObject({ delivery: 'reference', sizeBytes: INLINE_FILE_LIMIT_BYTES + 1 });
    expect(bundle.files[1].sha256).toMatch(/^[0-9a-f]{64}$/);
    const without = await buildControlPointPayload(scan(), { context, filesNotIncluded: [{ name: 'Robot STEP.zip', reason: 'No STEP export has run for this scan.' }] });
    expect(without.idempotencyKey).toBe(bundle.idempotencyKey);
    expect(without.filesNotIncluded.map(item => item.name)).toEqual(['Robot STEP.zip', 'BOM workbook (.xlsx)']);
    expect((await buildControlPointPayload(scan())).filesNotIncluded).toHaveLength(2);
    expect(bundle.filesNotIncluded).toEqual([]);
    const otherRevision = scan();
    otherRevision.diagnostics = { onshapeRequests: null, metadataIssues: [], revision: { type: 'm', id: 'micro2' } };
    expect((await buildControlPointPayload(otherRevision, { context })).idempotencyKey).not.toBe(bundle.idempotencyKey);
  });
});
