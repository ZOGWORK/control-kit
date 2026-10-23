import { describe, expect, it } from 'vitest';
import { aggregateAssembly, classificationForScore, classifyLine, classifyScan, type BomLine } from './index';

function line(name: string): BomLine {
  const result = aggregateAssembly({ rootAssembly: { instances: [{ id: 'i', name, type: 'Part', documentId: 'doc', elementId: 'element', partId: 'part' }] } },
    { documentId: 'doc', workspaceOrVersion: 'w', workspaceOrVersionId: 'work', elementId: 'element' }, 'Assembly');
  return result.lines[0];
}

describe('deterministic print classification', () => {
  it.each(['Printed wheel', '3D print cover', '3-d print cover', 'STL cover', 'FDM cover', 'PLA cover', 'PETG cover'])('scores strong keyword %s', name => {
    const value = classifyLine(line(name), null);
    expect(value.classificationReasons).toContain('strong print keyword (+50)');
    expect(value.classificationScore).toBeGreaterThanOrEqual(50);
  });
  it('scores standalone print or a file suffix with a weak keyword', () => {
    expect(classifyLine(line('print'), null).classificationReasons).toContain('print token or file suffix (+30)');
    expect(classifyLine(line('custom_bracket_v2'), null).classificationReasons).toContain('print token or file suffix (+30)');
    expect(classifyLine(line('motor_v2'), null).classificationReasons).not.toContain('print token or file suffix (+30)');
  });
  it('caps weak keywords at forty points and detects an unmatched non-SKU name', () => {
    const value = classifyLine(line('Custom bracket mount plate'), null);
    expect(value.classificationScore).toBe(65);
    expect(value.classification).toBe('printed');
    expect(value.classificationReasons.filter(reason => reason.endsWith('(+20)'))).toHaveLength(2);
    expect(classifyLine(line('Custom bracket 1234'), null).classificationScore).toBe(40);
  });
  it('uses the configured team number and clamps scores', () => {
    expect(classifyLine(line('Team 1234 custom bracket'), '1234').classificationScore).toBe(55);
    expect(classifyLine(line('Team 12345 custom bracket'), '1234').classificationScore).toBe(40);
    expect(classifyLine(line('Printed print custom bracket 1234'), '1234').classificationScore).toBe(100);
  });
  it('applies match penalties and threshold boundaries', () => {
    expect([34, 35, 59, 60].map(classificationForScore)).toEqual(['commercial', 'unknown', 'unknown', 'printed']);
    const value = line('Custom bracket 1234');
    value.vendor = { vendorId: 'rev', name: 'Part', normalizedName: 'part', sku: '1234', normalizedSku: '1234', url: 'https://example.com', priceUsd: null, stock: 'unknown', stockQty: null, packSize: null, packSizeVerified: false, category: 'part', updatedAt: '', source: 'feed' };
    value.matchConfidence = 0.85;
    expect(classifyLine(value, null).classificationScore).toBe(20);
    value.name = 'Printed custom bracket';
    value.matchStatus = 'exact';
    expect(classifyLine(value, null).classification).toBe('commercial');
    expect(classifyLine(value, null, 'printed').classification).toBe('printed');
    expect(value.manualClassification).toBe('printed');
    expect(classifyLine(line('Custom bracket 1234'), null).classification).toBe('unknown');
    expect(classifyLine(line('Custom bracket'), null).classification).toBe('printed');
    expect(classifyLine(line('Bracket 1234'), null).classification).toBe('commercial');
  });
  it('reapplies document overrides and counts printed lines', () => {
    const result = aggregateAssembly({ rootAssembly: { instances: [{ id: 'i', name: 'Motor 1234', type: 'Part', documentId: 'doc', elementId: 'element', partId: 'part' }] } },
      { documentId: 'doc', workspaceOrVersion: 'w', workspaceOrVersionId: 'work', elementId: 'element' }, 'Assembly');
    classifyScan(result, { teamNumber: null }, { [result.lines[0].bomLineKey]: 'printed' });
    expect(result.lines[0].manualClassification).toBe('printed');
    expect(result.stats.printedLines).toBe(1);
    result.missingMetadata = [result.lines[0]];
    const changed = { ...result, lines: result.lines.map(item => ({ ...item })), missingMetadata: [...result.missingMetadata], stats: { ...result.stats } };
    classifyScan(changed, { teamNumber: null }, { [result.lines[0].bomLineKey]: 'commercial' });
    expect(changed.missingMetadata[0]).toBe(changed.lines[0]);
    expect(changed.missingMetadata[0].classification).toBe('commercial');
  });
});
