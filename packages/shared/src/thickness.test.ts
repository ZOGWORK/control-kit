import { describe, expect, it } from 'vitest';
import { aggregateAssembly, classifyLine, cutsFromSheet, statedThicknessMm, thicknessRule, wantsDxf, type AssemblyInstance, type BomLine } from './index';

const context = { documentId: 'doc', workspaceOrVersion: 'w' as const, workspaceOrVersionId: 'work', elementId: 'element' };
function line(name: string, extra: Partial<AssemblyInstance> = {}): BomLine {
  return aggregateAssembly({ rootAssembly: { instances: [{ id: 'i', name, type: 'Part', documentId: 'doc', elementId: 'element', partId: 'part', ...extra }] } }, context, 'Assembly').lines[0];
}
const classify = (value: BomLine, override: Parameters<typeof classifyLine>[2] = null) => classifyLine(value, null, override, 'doc');
const stated = (name: string, configuration: string | null = null) => statedThicknessMm({ name, description: null, configuration })?.mm ?? null;

describe('flat parts: 2D cut at 3 mm or less, 3D print above (owner rule, 2026-10-28)', () => {
  it('cuts a plate exactly 3 mm thick, allowing float noise, and prints anything thicker', () => {
    expect(cutsFromSheet(3)).toBe(true);
    expect(cutsFromSheet(3.0001)).toBe(true);
    expect(cutsFromSheet(3.2)).toBe(false);
    expect(cutsFromSheet(3.175)).toBe(false);
    const three = classify(line('3mm Side Plate'));
    expect(three).toMatchObject({ disposition: 'cut-2d', dispositionSource: 'suggestion' });
    expect(three.dispositionEvidence).toContain('flat, 3 mm thick: 3 mm or less, so cut from sheet');
    expect(wantsDxf(three)).toBe(true);
  });
  it('prints a 3.2 mm plate and a 1/8 in plate (3.175 mm), with the thickness as evidence', () => {
    const thick = classify(line('3.2mm Side Plate'));
    expect(thick).toMatchObject({ disposition: 'print', dispositionSource: 'suggestion' });
    expect(thick.dispositionEvidence).toContain('flat, 3.2 mm thick: over 3 mm, so 3D printed');
    const inch = classify(line('1/8 in Side Plate'));
    expect(inch.disposition).toBe('print');
    expect(inch.dispositionEvidence).toContain('flat, 3.18 mm thick: over 3 mm, so 3D printed');
    expect(classify(line('Gusset 0.125"')).disposition).toBe('print');
    expect(classify(line('6mm Side Plate')).dispositionEvidence).toContain('flat, 6 mm thick: over 3 mm, so 3D printed');
  });
  it('reads thickness from a configuration value', () => {
    expect(classify(line('Side Plate', { configuration: 'Thickness=6+mm' })).disposition).toBe('print');
    expect(classify(line('Side Plate', { configuration: 'Thickness=0.0625%20in' })).disposition).toBe('cut-2d');
  });
  it('leaves a plate with no stated thickness as 2D cut, for the export to measure', () => {
    const plain = classify(line('Drivetrain side plate'));
    expect(plain.disposition).toBe('cut-2d');
    expect(plain.dispositionEvidence).toContain('flat-part wording in name');
    expect(stated('Drivetrain side plate')).toBeNull();
  });
  it('keeps a person’s choice: a 6 mm plate set to 2D cut by hand still gets a DXF', () => {
    const manual = classify(line('6mm Side Plate'), 'cut-2d');
    expect(manual).toMatchObject({ disposition: 'cut-2d', dispositionSource: 'manual' });
    expect(thicknessRule(manual)).toEqual({ disposition: 'cut-2d', note: null });
    expect(wantsDxf(manual)).toBe(true);
    // A team tag is not a person's choice in this panel, so the export prints a thick tagged plate.
    const tagged = classify(line('6mm Side Plate [laser]'));
    expect(tagged).toMatchObject({ disposition: 'cut-2d', dispositionSource: 'explicit-metadata' });
    expect(thicknessRule(tagged)).toEqual({ disposition: 'print', note: 'flat, 6 mm thick: over 3 mm, so 3D printed' });
    expect(wantsDxf(tagged)).toBe(false);
  });
  it('tells a thickness from a size', () => {
    expect(stated('300x200x3mm plate')).toBe(3);
    expect(stated('Plate 100x60mm 2mm')).toBe(2);
    expect(stated('Plate, thickness: 1/4 in')).toBe(6.35);
    expect(stated('Side plate t=2.5mm')).toBe(2.5);
    expect(stated('Plate 5mm thick 120mm')).toBe(5);
    // A long length is a size, and two short ones are ambiguous.
    expect(stated('120mm plate')).toBeNull();
    expect(stated('Plate 2mm 4mm')).toBeNull();
    expect(stated('Plate', 'Thickness=1.5+mm')).toBe(1.5);
  });
});
