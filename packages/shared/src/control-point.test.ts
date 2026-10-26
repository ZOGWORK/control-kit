import { describe, expect, it } from 'vitest';
import { aggregateAssembly, recalculatePurchasing, type VendorRecord } from './index';
import { buildControlPointPayload, INLINE_FILE_LIMIT_BYTES, MockControlPointAdapter } from './control-point';

describe('Control Point payload and adapter', () => {
  it('round-trips a payload through the in-memory adapter with a stable key per workspace', async () => {
    const result = aggregateAssembly({ rootAssembly: { instances: [
      { id: 'a', name: 'Screw', type: 'Part', documentId: 'doc', elementId: 'parts', partId: 'screw' },
    ] } }, { documentId: 'doc', elementId: 'assembly', workspaceOrVersion: 'w', workspaceOrVersionId: 'work' }, 'Robot');
    const adapter = new MockControlPointAdapter(undefined, [
      { id: 12, name: 'HORS', ftcNumber: '6980', accentColor: '#2f6bff', canEditCad: true, cadUrl: 'https://tryctrlpoint.org/cad-parts' },
      { id: 13, name: 'Scrimmage', ftcNumber: null, accentColor: null, canEditCad: true, cadUrl: 'https://tryctrlpoint.org/cad-parts' },
      { id: 14, name: 'Read only', ftcNumber: null, accentColor: null, canEditCad: false, cadUrl: 'https://tryctrlpoint.org/cad-parts' },
    ]);
    await expect(adapter.workspaces('ckp_wrong')).rejects.toMatchObject({ status: 401, code: 'revoked' });
    const { accessToken } = await adapter.exchangeCode('local-test-code');
    expect((await adapter.workspaces(accessToken)).workspaces.map(item => item.id)).toEqual([12, 13, 14]);
    const first = await buildControlPointPayload(result, { workspaceId: 12 });
    const second = await buildControlPointPayload({ ...result, scannedAt: '2027-01-01T00:00:00Z', scanId: 'new-scan' }, { workspaceId: 12 });
    expect(second.idempotencyKey).toBe(first.idempotencyKey);
    // One scan sent to two workspaces is two imports.
    const other = await buildControlPointPayload(result, { workspaceId: 13 });
    expect(other.idempotencyKey).not.toBe(first.idempotencyKey);
    expect(await adapter.sendBom(accessToken, 12, JSON.stringify(first))).toMatchObject({ importId: 1, duplicate: false, created: 1 });
    expect(await adapter.sendBom(accessToken, 12, JSON.stringify(second))).toMatchObject({ importId: 1, duplicate: true });
    expect(await adapter.sendBom(accessToken, 13, JSON.stringify(other))).toMatchObject({ importId: 2, duplicate: false });
    await expect(adapter.sendBom(accessToken, 14, JSON.stringify(first))).rejects.toMatchObject({ status: 403, code: 'no_cad_edit' });
    await expect(adapter.sendBom(accessToken, 99, JSON.stringify(first))).rejects.toMatchObject({ status: 403, code: 'not_member' });
    expect(adapter.payloads).toHaveLength(2);
    expect(adapter.payloads[0].payload.lines[0]).toMatchObject({ name: 'Screw', qty: 1, vendor: null, identity: 'doc:parts:screw:' });
    expect(adapter.payloads[0].payload.cadParts[0].extra.identity).toBe('doc:parts:screw:');
    expect(await adapter.imports(accessToken, 12, 'doc', 'assembly')).toEqual([expect.objectContaining({ importId: 1, idempotencyKey: first.idempotencyKey })]);
    result.lines[0].qty = 2;
    expect((await buildControlPointPayload(result, { workspaceId: 12 })).idempotencyKey).not.toBe(first.idempotencyKey);
    await adapter.revoke(accessToken);
    await expect(adapter.sendBom(accessToken, 12, JSON.stringify(first))).rejects.toMatchObject({ status: 401, code: 'revoked' });
  });
  it('keeps a part identity stable across source revisions, as Control Point keys its rows', async () => {
    const result = aggregateAssembly({ rootAssembly: { instances: [
      { id: 'a', name: 'Bracket', type: 'Part', documentId: 'doc', elementId: 'parts', partId: 'JHD', configuration: 'size=M4' },
    ] } }, { documentId: 'doc', elementId: 'assembly', workspaceOrVersion: 'w', workspaceOrVersionId: 'work' }, 'Robot');
    const edited = { ...result, lines: result.lines.map(line => ({ ...line, sourceId: 'other-microversion', bomLineKey: `${line.bomLineKey}2` })) };
    const [before, after] = await Promise.all([buildControlPointPayload(result, { workspaceId: 12 }), buildControlPointPayload(edited, { workspaceId: 12 })]);
    expect(before.cadParts[0].extra.identity).toBe('doc:parts:JHD:size=M4');
    expect(after.cadParts[0].extra.identity).toBe(before.cadParts[0].extra.identity);
  });
  it('sends one CAD part per identity when a scan holds one part at two source revisions', async () => {
    const result = aggregateAssembly({ rootAssembly: { instances: [
      { id: 'a', name: 'Bracket', type: 'Part', documentId: 'doc', elementId: 'parts', partId: 'JHD' },
      { id: 'b', name: 'Bracket', type: 'Part', documentId: 'doc', elementId: 'parts', partId: 'JHD' },
      { id: 'c', name: 'Plate', type: 'Part', documentId: 'doc', elementId: 'parts', partId: 'JKD' },
    ] } }, { documentId: 'doc', elementId: 'assembly', workspaceOrVersion: 'w', workspaceOrVersionId: 'work' }, 'Robot');
    const bracket = result.lines.find(line => line.partId === 'JHD')!;
    // The same part linked at an older version as well: a separate line with its own source revision and key.
    result.lines.push({ ...bracket, qty: 3, sourceType: 'v', sourceId: 'old-version', bomLineKey: `${bracket.bomLineKey}:v:old-version` });
    const payload = await buildControlPointPayload(result, { workspaceId: 12 });
    expect(payload.lines).toHaveLength(3);
    expect(payload.cadParts.map(part => [part.extra.identity, part.quantity])).toEqual([['doc:parts:JHD:', 5], ['doc:parts:JKD:', 1]]);
    const merged = payload.cadParts[0];
    expect(new Set(payload.cadParts.map(part => part.extra.identity)).size).toBe(payload.cadParts.length);
    expect([merged.extra, ...merged.extra.sameIdentity].map(line => [line.key, line.qty]).sort()).toEqual([[bracket.bomLineKey, 2], [`${bracket.bomLineKey}:v:old-version`, 3]].sort());
    expect(payload.cadParts[1].extra.sameIdentity).toEqual([]);
  });
  it('keeps CAD units separate from pack charges in the proposed payload', async () => {
    const instances = Array.from({ length: 12 }, (_, index) => ({ id: `${index}`, name: `M3 Screw <${index + 1}>`, type: 'Part', documentId: 'doc', elementId: 'parts', partId: 'screw' }));
    const result = aggregateAssembly({ rootAssembly: { instances } }, { documentId: 'doc', elementId: 'assembly', workspaceOrVersion: 'w', workspaceOrVersionId: 'work' }, 'Robot');
    const record: VendorRecord = { vendorId: 'andymark', sku: 'AM-1000', normalizedSku: '1000', name: 'M3 Screw', normalizedName: 'm3 screw',
      url: 'https://www.andymark.com/products/m3-screw', priceUsd: 8.99, packSize: 10, packSizeVerified: true,
      stock: 'in', stockQty: null, category: 'hardware', updatedAt: '2026-10-23T00:00:00Z', source: 'feed' };
    result.lines[0].vendor = record; result.lines[0].matchStatus = 'exact'; result.lines[0].disposition = 'buy';
    recalculatePurchasing(result);
    expect((await buildControlPointPayload(result, { workspaceId: 12 })).lines[0]).toMatchObject({ qty: 12, packsToOrder: 2, packPriceUsd: 8.99, lineTotalUsd: 17.98 });
    result.lines[0].vendor = { ...record, packSizeVerified: false };
    recalculatePurchasing(result);
    expect((await buildControlPointPayload(result, { workspaceId: 12 })).lines[0]).toMatchObject({ qty: 12, packsToOrder: null, lineTotalUsd: null });
  });
  it('keeps the key stable when Onshape returns the same parts in a different order', async () => {
    const result = aggregateAssembly({ rootAssembly: { instances: [
      { id: 'a', name: 'Bracket', type: 'Part', documentId: 'doc', elementId: 'parts', partId: 'a' },
      { id: 'b', name: 'Bracket', type: 'Part', documentId: 'doc', elementId: 'parts', partId: 'b' },
    ] } }, { documentId: 'doc', elementId: 'assembly', workspaceOrVersion: 'w', workspaceOrVersionId: 'work' }, 'Robot');
    const forward = await buildControlPointPayload(result, { workspaceId: 12 });
    const reversed = await buildControlPointPayload({ ...result, lines: [...result.lines].reverse() }, { workspaceId: 12 });
    expect(reversed.idempotencyKey).toBe(forward.idempotencyKey);
  });
  it('uses a new key when assembly name or suppressed quantity changes', async () => {
    const result = aggregateAssembly({ rootAssembly: { instances: [
      { id: 'a', name: 'Screw', type: 'Part', documentId: 'doc', elementId: 'parts', partId: 'screw' },
    ] } }, { documentId: 'doc', elementId: 'assembly', workspaceOrVersion: 'w', workspaceOrVersionId: 'work' }, 'Robot');
    const original = await buildControlPointPayload(result, { workspaceId: 12 });
    const renamed = await buildControlPointPayload({ ...result, assemblyName: 'Robot Mk II' }, { workspaceId: 12 });
    const suppressed = await buildControlPointPayload({ ...result, suppressed: [{ ...result.lines[0], suppressed: true }] }, { workspaceId: 12 });
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
    const bundle = await buildControlPointPayload(scan(), { workspaceId: 12, context });
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
    expect((await buildControlPointPayload(scan(), { workspaceId: 12, context: { ...context, workspaceOrVersion: 'm', workspaceOrVersionId: 'micro1' } })).assembly.assemblyUrl).toBe('https://cad.onshape.com/documents/doc');
  });
  it('attaches files inline or by reference, never drops one, and keeps the key independent of file bytes', async () => {
    const small = new Uint8Array([1, 2, 3]);
    const large = new Uint8Array(INLINE_FILE_LIMIT_BYTES + 1);
    const bundle = await buildControlPointPayload(scan(), { workspaceId: 12, context, files: [
      { name: 'Robot BOM.xlsx', mediaType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', bytes: small },
      { name: 'Robot STEP.zip', mediaType: 'application/zip', bytes: large },
    ], filesNotIncluded: [] });
    expect(bundle.files[0]).toMatchObject({ delivery: 'inline', contentBase64: 'AQID', sizeBytes: 3 });
    expect(bundle.files[1]).toMatchObject({ delivery: 'reference', sizeBytes: INLINE_FILE_LIMIT_BYTES + 1 });
    expect(bundle.files[1].sha256).toMatch(/^[0-9a-f]{64}$/);
    const without = await buildControlPointPayload(scan(), { workspaceId: 12, context, filesNotIncluded: [{ name: 'Robot STEP.zip', reason: 'No STEP export has run for this scan.' }] });
    expect(without.idempotencyKey).toBe(bundle.idempotencyKey);
    expect(without.filesNotIncluded.map(item => item.name)).toEqual(['Robot STEP.zip', 'BOM workbook (.xlsx)']);
    expect((await buildControlPointPayload(scan(), { workspaceId: 12 })).filesNotIncluded).toHaveLength(2);
    expect(bundle.filesNotIncluded).toEqual([]);
    const otherRevision = scan();
    otherRevision.diagnostics = { onshapeRequests: null, metadataIssues: [], revision: { type: 'm', id: 'micro2' } };
    expect((await buildControlPointPayload(otherRevision, { workspaceId: 12, context })).idempotencyKey).not.toBe(bundle.idempotencyKey);
  });
});
