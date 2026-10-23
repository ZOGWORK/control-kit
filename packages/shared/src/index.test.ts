import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { aggregateAssembly, type AssemblyDefinition } from './index';

const context = { documentId: 'doc1', workspaceOrVersion: 'w' as const, workspaceOrVersionId: 'work1', elementId: 'elem1' };
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`../../../fixtures/assembly-${name}.json`, import.meta.url), 'utf8')) as AssemblyDefinition;

describe('assembly traversal and aggregation', () => {
  it('recurses through two module occurrences and excludes suppressed parts from active totals', () => {
    const result = aggregateAssembly(fixture('simple'), context, 'Simple FTC Assembly');
    expect(result.stats.totalInstances).toBe(11);
    expect(result.stats.uniqueLines).toBe(5);
    expect(result.lines.find(line => line.partId === 'screw-m3')?.qty).toBe(4);
    expect(result.lines.find(line => line.partId === 'motor-5203')?.qty).toBe(2);
    expect(result.suppressed).toHaveLength(1);
    expect(result.suppressed[0].qty).toBe(1);
    expect(result.lines.find(line => line.partId === 'motor-5203')?.instancePaths).toEqual([
      'Simple FTC Assembly > Left Module <1> > Motor <1>',
      'Simple FTC Assembly > Right Module <1> > Motor <1>',
    ]);
  });
  it('sums 260 active leaves in the large FTC fixture without counting four suppressed leaves', () => {
    const result = aggregateAssembly(fixture('ftc-robot'), context, 'FTC Competition Robot');
    expect(result.stats.totalInstances).toBe(260);
    expect(result.stats.uniqueLines).toBe(5);
    expect(result.lines.find(line => line.partId === 'screw-m3')?.qty).toBe(200);
    expect(result.lines.find(line => line.partId === 'wheel-96')?.qty).toBe(16);
    expect(result.lines.find(line => line.partId === 'bearing-8')?.qty).toBe(14);
    expect(result.suppressed[0].qty).toBe(4);
  });
  it('handles an empty assembly and an unresolved child assembly', () => {
    expect(aggregateAssembly(fixture('empty'), context, '').stats.totalInstances).toBe(0);
    const unresolved: AssemblyDefinition = { rootAssembly: { instances: [{ id: 'x', name: 'Missing Module', type: 'Assembly', documentId: 'doc1', elementId: 'missing' }] } };
    const result = aggregateAssembly(unresolved, context, 'Robot');
    expect(result.lines[0].unresolvedSubassembly).toBe(true);
    expect(result.lines[0].qty).toBe(1);
  });
});
