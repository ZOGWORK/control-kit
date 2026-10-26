import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { aggregateAssembly, type AssemblyDefinition } from './index';

const context = { documentId: 'doc1', workspaceOrVersion: 'w' as const, workspaceOrVersionId: 'work1', elementId: 'elem1' };
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`../../../fixtures/assembly-${name}.json`, import.meta.url), 'utf8')) as AssemblyDefinition;

describe('assembly traversal and aggregation', () => {
  it('lists an instance Onshape cannot resolve (only an id and a name) instead of failing the scan', () => {
    // From the owner's scan of 2026-10-26: two linked REV hubs came back with no type and no document.
    const result = aggregateAssembly({ rootAssembly: { instances: [
      { id: 'h1', name: 'Control Hub (REV) <1>' } as never,
      { id: 'p1', name: 'Plate', type: 'Part', documentId: 'doc1', elementId: 'e1', partId: 'p' },
    ] } }, context, 'Robot');
    const hub = result.lines.find(line => line.name === 'Control Hub (REV)')!;
    expect(hub).toMatchObject({ qty: 1, metadataIssue: { code: 'unresolved-reference' }, partStudioUrl: '' });
    expect(result.lines).toHaveLength(2);
  });
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
  it('lists a vendor product modelled as an assembly as one line, and expands the team\'s own subassemblies', () => {
    const part = (id: string, name: string, documentId = 'doc1', elementId = 'ps') => ({ id, name, type: 'Part', documentId, elementId, partId: id });
    const sub = (id: string, name: string, documentId: string, elementId: string) => ({ id, name, type: 'Assembly', documentId, elementId, documentVersion: documentId === 'doc1' ? undefined : 'v1' });
    const result = aggregateAssembly({
      rootAssembly: { instances: [
        sub('pod', 'Right Pod <1>', 'doc1', 'pod'),
        sub('drive', 'Drive Pod <1>', 'teamlib', 'drive'),
      ] },
      subAssemblies: [
        { documentId: 'doc1', elementId: 'pod', instances: [
          sub('m1', '5204 Series Yellow Jacket Planetary Gear Motor (13.7:1 Ratio) 5204-8002-0014 <1>', 'gobilda', 'motor'),
          sub('m2', '5204 Series Yellow Jacket Planetary Gear Motor (13.7:1 Ratio) 5204-8002-0014 <2>', 'gobilda', 'motor'),
          sub('b1', '4mm ID Non-Flanged Ball Bearing (10mm OD, 4mm Thickness) <1>', 'vendorcad', 'bearing'),
          sub('stack', 'Bearing stack <1>', 'teamlib', 'stack'),
          part('plate', 'Pod Plate'),
        ] },
        { documentId: 'gobilda', elementId: 'motor', instances: [part('gearbox', '5203 gearbox', 'gobilda', 'mps'), part('shaft', '5203 Shaft', 'gobilda', 'mps'), part('can', 'Motor Part', 'gobilda', 'mps')] },
        { documentId: 'vendorcad', elementId: 'bearing', instances: [part('inner', 'Inner Race', 'vendorcad', 'bps'), part('outer', 'Outer Race', 'vendorcad', 'bps')] },
        { documentId: 'teamlib', elementId: 'stack', instances: [part('washer', 'Thrust washer', 'teamlib', 'sps')] },
        { documentId: 'teamlib', elementId: 'drive', instances: [part('side', 'Drive side plate', 'teamlib', 'dps')] },
      ],
    }, context, 'Robot');
    const names = result.lines.map(line => [line.name, line.qty, line.purchasedAssembly?.parts ?? null]).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
    expect(names).toEqual([
      ['4mm ID Non-Flanged Ball Bearing (10mm OD, 4mm Thickness)', 1, 2],
      ['5204 Series Yellow Jacket Planetary Gear Motor (13.7:1 Ratio) 5204-8002-0014', 2, 3],
      ['Drive side plate', 1, null],
      ['Pod Plate', 1, null],
      ['Thrust washer', 1, null],
    ]);
    const motor = result.lines.find(line => line.name.includes('Yellow Jacket'))!;
    expect(motor.purchasedAssembly?.reason).toBe('its name has a goBILDA/ServoCity part number');
    expect(motor).toMatchObject({ unresolvedSubassembly: false, metadataIssue: null });
  });
  it('folds a body from an imported product\'s Part Studio, placed beside that product, into the product', () => {
    // From HORS: "Motor Smol" holds the imported goBILDA motor as a subassembly ("5000-0002-0001 Motor", built from the
    // Part Studio "Import 1") and, beside it, the output shaft "2107-4008-0001" taken straight from that same import.
    const body = (id: string, name: string, elementId = 'import1') => ({ id, name, type: 'Part', documentId: 'doc1', elementId, partId: id });
    const sub = (id: string, name: string, elementId: string) => ({ id, name, type: 'Assembly', documentId: 'doc1', elementId });
    const definition = (shaftElement: string, besideMotor: boolean): AssemblyDefinition => ({
      rootAssembly: { instances: [sub('w1', 'Motor Smol <1>', 'wrapper'), sub('w2', 'Motor Smol <2>', 'wrapper'), ...(besideMotor ? [] : [body('shaft', '2107-4008-0001 <1>', shaftElement)])] },
      subAssemblies: [
        { documentId: 'doc1', elementId: 'wrapper', instances: [sub('m', '5000-0002-0001 Motor <1>', 'motor'), ...(besideMotor ? [body('shaft', '2107-4008-0001 <1>', shaftElement)] : []), body('mount', 'Team motor mount', 'teamparts')] },
        { documentId: 'doc1', elementId: 'motor', instances: [body('base', 'base'), body('endcap', 'endcap'), body('pin', 'Pin (1)'), { ...body('spare', '5000-0002-4008 spare'), suppressed: true }] },
      ],
    });
    const folded = aggregateAssembly(definition('import1', true), context, 'Robot');
    expect(folded.lines.map(line => [line.name, line.qty]).sort()).toEqual([['5000-0002-0001 Motor', 2], ['Team motor mount', 2]]);
    expect(folded.lines.find(line => line.purchasedAssembly)!.purchasedAssembly).toMatchObject({ parts: 4, includes: ['2107-4008-0001'], inside: ['base', 'endcap', 'Pin (1)'] });
    // Standard content beside a kit is never folded into it, even when the kit's insides use the same screw.
    const withScrews = definition('import1', true);
    withScrews.subAssemblies![1].instances!.push({ ...body('kitscrew', 'Socket head cap screw', 'std'), isStandardContent: true });
    withScrews.subAssemblies![0].instances!.push(...Array.from({ length: 8 }, (_, n) => ({ ...body(`s${n}`, 'Socket head cap screw', 'std'), id: `s${n}`, partId: 'kitscrew', isStandardContent: true })));
    expect(aggregateAssembly(withScrews, context, 'Robot').lines.find(line => line.name === 'Socket head cap screw')?.qty).toBe(16);
    // A body from the same Part Studio but another configuration is another product.
    const configured = definition('import1', true);
    configured.subAssemblies![0].instances = configured.subAssemblies![0].instances!.map(instance => instance.id === 'shaft' ? { ...instance, configuration: 'type=wheel' } : instance);
    expect(aggregateAssembly(configured, context, 'Robot').lines.map(line => line.name)).toContain('2107-4008-0001');
    // A body from a different Part Studio, or placed anywhere else, is a part of its own.
    expect(aggregateAssembly(definition('teamparts', true), context, 'Robot').lines.map(line => line.name)).toContain('2107-4008-0001');
    expect(aggregateAssembly(definition('import1', false), context, 'Robot').lines.map(line => line.name)).toContain('2107-4008-0001');
  });
  it('does not count a resolved but empty child assembly as a part', () => {
    const definition: AssemblyDefinition = { rootAssembly: { instances: [{ id: 'empty', name: 'Empty Module', type: 'Assembly', documentId: 'doc1', elementId: 'module' }] }, subAssemblies: [{ documentId: 'doc1', elementId: 'module', instances: [] }] };
    expect(aggregateAssembly(definition, context, 'Robot').stats.totalInstances).toBe(0);
  });
  it('keeps two revisions of a subassembly and linked part metadata sources separate', () => {
    const module = (id: string, revision: string) => ({ id, name: `Module ${id}`, type: 'Assembly', documentId: 'linked', elementId: 'module', documentMicroversion: revision });
    const leaf = (id: string, revision: string) => ({ id, name: `Part ${id}`, type: 'Part', documentId: 'linked', elementId: 'studio', partId: id, documentMicroversion: revision });
    const definition: AssemblyDefinition = {
      rootAssembly: { instances: [module('a', 'rev-a'), module('b', 'rev-b')] },
      subAssemblies: [
        { documentId: 'linked', elementId: 'module', documentMicroversion: 'rev-a', instances: [leaf('part-a', 'rev-a')] },
        { documentId: 'linked', elementId: 'module', documentMicroversion: 'rev-b', instances: [leaf('part-b', 'rev-b')] },
      ],
    };
    const result = aggregateAssembly(definition, context, 'Robot');
    expect(result.lines.map(line => line.partId)).toEqual(['part-a', 'part-b']);
    expect(result.lines.map(line => line.sourceId)).toEqual(['rev-a', 'rev-b']);
  });
});
