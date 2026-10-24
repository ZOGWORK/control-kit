import { describe, expect, it } from 'vitest';
import { bomColumns, bomText, mergeBom, type BillOfMaterials } from './bom';
import { aggregateAssembly, type AssemblyInstance } from './index';

const context = { documentId: 'doc', workspaceOrVersion: 'w' as const, workspaceOrVersionId: 'work', elementId: 'asm' };
const part = (id: string, partId: string, extra: Partial<AssemblyInstance> = {}): AssemblyInstance => ({ id, name: `${partId} <1>`, type: 'Part', documentId: 'doc', elementId: 'studio', partId, ...extra });
const headers = [{ id: 'a', propertyName: 'partNumber' }, { id: 'b', name: 'Description' }, { id: 'c', propertyName: 'quantity' }, { id: 'd', propertyName: 'material' }, { id: 'e', propertyName: 'vendor' }];

describe('Onshape BOM merge', () => {
  it('reads string, number, and object cell values', () => {
    expect(bomText('  5203-2402-0019 ')).toBe('5203-2402-0019');
    expect(bomText('')).toBeNull();
    expect(bomText(12)).toBe('12');
    expect(bomText({ displayName: 'Aluminum - 6061' })).toBe('Aluminum - 6061');
    expect(bomText({ value: 'PLA' })).toBe('PLA');
    expect(bomText([{ name: 'goBILDA' }])).toBe('goBILDA');
    expect(bomText(null)).toBeNull();
  });
  it('maps columns by property name, then by display name', () => {
    expect(bomColumns(headers)).toEqual({ partNumber: 'a', description: 'b', quantity: 'c', material: 'd', vendor: 'e' });
    expect(bomColumns([{ id: 'x', name: 'Part Number' }])).toEqual({ partNumber: 'x' });
  });
  it('fills part number, material, and a linked part source revision, and reconciles quantity', () => {
    const result = aggregateAssembly({ rootAssembly: { instances: [part('m1', 'motor'), part('m2', 'motor'), part('lib', 'hub', { documentId: 'library' })] } }, context, 'Robot');
    const bom: BillOfMaterials = { headers, rows: [
      { headerIdToValue: { a: '5203-2402-0019', b: 'Motor', c: 3, d: null, e: 'goBILDA' }, itemSource: { documentId: 'doc', elementId: 'studio', partId: 'motor', fullConfiguration: 'default' } },
      { headerIdToValue: { a: '1310-0016-4008', c: 1, d: { displayName: 'Aluminum' } }, itemSource: { documentId: 'library', elementId: 'studio', partId: 'hub', wvmType: 'v', wvmId: 'ver9' } },
    ] };
    const report = mergeBom(result, bom);
    const motor = result.lines.find(line => line.partId === 'motor')!;
    const hub = result.lines.find(line => line.partId === 'hub')!;
    expect(motor).toMatchObject({ partNumber: '5203-2402-0019', description: 'Motor', bomProperties: { vendor: 'goBILDA', quantity: 3 } });
    expect(hub).toMatchObject({ partNumber: '1310-0016-4008', material: 'Aluminum', sourceType: 'v', sourceId: 'ver9', partStudioUrl: 'https://cad.onshape.com/documents/library/v/ver9/e/studio' });
    expect(report).toMatchObject({ status: 'merged', rows: 2, matchedLines: 2, linesWithoutRow: 0, rowsWithoutLine: 0, quantityMismatches: 1 });
  });
  it('keeps differently configured rows of one part apart and flags a part missing from the BOM', () => {
    const result = aggregateAssembly({ rootAssembly: { instances: [part('s1', 'spacer', { configuration: 'len=10' }), part('s2', 'spacer', { configuration: 'len=20' }), part('x', 'bracket')] } }, context, 'Robot');
    const report = mergeBom(result, { headers, rows: [
      { headerIdToValue: { a: 'SP-10', c: 1 }, itemSource: { documentId: 'doc', elementId: 'studio', partId: 'spacer', configuration: 'len=10' } },
      { headerIdToValue: { a: 'SP-20', c: 1 }, itemSource: { documentId: 'doc', elementId: 'studio', partId: 'spacer', configuration: 'len=20' } },
    ] });
    expect(result.lines.map(line => [line.configuration, line.partNumber])).toEqual([['len=10', 'SP-10'], ['len=20', 'SP-20'], [null, null]]);
    expect(result.lines[2].metadataIssue).toEqual({ code: 'not-in-bom', httpStatus: null });
    expect(report).toMatchObject({ matchedLines: 2, linesWithoutRow: 1 });
  });
  it('reports a sanitized column sample without part data', () => {
    const result = aggregateAssembly({ rootAssembly: { instances: [part('m1', 'motor')] } }, context, 'Robot');
    const report = mergeBom(result, { headers, rows: [{ headerIdToValue: { a: 'SECRET-PN', d: { displayName: 'PLA' } }, itemSource: { documentId: 'doc', elementId: 'studio', partId: 'motor' } }] });
    expect(report.columns).toEqual([
      { id: 'a', propertyName: 'partNumber', name: null, sampleType: 'string' }, { id: 'b', propertyName: null, name: 'Description', sampleType: null },
      { id: 'c', propertyName: 'quantity', name: null, sampleType: null }, { id: 'd', propertyName: 'material', name: null, sampleType: 'object' }, { id: 'e', propertyName: 'vendor', name: null, sampleType: null },
    ]);
    expect(JSON.stringify(report)).not.toContain('SECRET-PN');
  });
  it('flags instances whose linked source Onshape cannot resolve', () => {
    const result = aggregateAssembly({ rootAssembly: { instances: [part('ok', 'a', { status: 'OK' }), part('gone', 'b', { status: 'DELETED' }), part('err', 'c', { errorStatus: 'MISSING_REFERENCE' })] } }, context, 'Robot');
    expect(result.lines.map(line => line.metadataIssue?.code ?? null)).toEqual([null, 'unresolved-reference', 'unresolved-reference']);
  });
});
