import { describe, expect, it } from 'vitest';
import { strFromU8, unzipSync } from 'fflate';
import { checkStep, stepFileName, type ExportPart } from '../../shared/src/index';
import { buildStepZip, NoStepFilesError } from './step-zip';

const step = (name: string, unit = 'SI_UNIT(.MILLI.,.METRE.)') => `ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\n#1=PRODUCT('${name}','${name}','',(#2));\n#4=(LENGTH_UNIT()NAMED_UNIT(*)${unit});\nENDSEC;\nEND-ISO-10303-21;\n`;
const part = (name: string, state: ExportPart['state'], extra: Partial<ExportPart> = {}): ExportPart => ({ lineKey: name, name, qty: 2, disposition: 'print', partId: 'p', configuration: null, sourceUrl: `https://cad.onshape.com/documents/d/w/w/e/${name}`, fileName: `${name}.step`,
  state, error: state === 'failed' ? 'Deliberate failure' : null, units: state === 'ready' ? 'mm' : null, nameMatches: state === 'ready' ? true : null, bytes: null, ...extra });

describe('STEP checks and naming', () => {
  it('accepts a complete ISO-10303-21 file and reads its units and product name', () => {
    expect(checkStep(step('Intake Guide'), 'Intake Guide')).toEqual({ ok: true, units: 'mm', productNames: ['Intake Guide'], nameMatches: true });
    expect(checkStep(step('Part 7', 'SI_UNIT($,.METRE.)'), 'Bracket')).toMatchObject({ ok: true, units: 'm', nameMatches: false });
    // STEP escapes a quote inside a string by doubling it.
    expect(checkStep(step("Arm''s End", "CONVERSION_BASED_UNIT('INCH',#9)"), "Arm's End")).toMatchObject({ units: 'in', productNames: ["Arm's End"] });
  });
  it('rejects HTML, empty, and truncated responses', () => {
    expect(checkStep('<html><body>Error</body></html>', 'x')).toEqual({ ok: false, error: 'Onshape returned something other than a STEP file' });
    expect(checkStep('   ', 'x')).toEqual({ ok: false, error: 'Onshape returned an empty file' });
    expect(checkStep('ISO-10303-21;\nHEADER;', 'x')).toEqual({ ok: false, error: 'STEP file is truncated' });
  });
  it('makes unique, safe file names that keep the part ID and configuration apart', () => {
    const used = new Set<string>();
    expect(stepFileName({ name: 'Intake Guide / v2', partId: 'JHD', configuration: null }, used)).toBe('Intake_Guide_v2__JHD.step');
    expect(stepFileName({ name: 'Intake Guide / v2', partId: 'JHD', configuration: null }, used)).toBe('Intake_Guide_v2__JHD_2.step');
    const a = stepFileName({ name: 'Spacer', partId: 'JKD', configuration: 'len=10' }, used);
    const b = stepFileName({ name: 'Spacer', partId: 'JKD', configuration: 'len=20' }, used);
    expect(a).not.toBe(b);
    expect(stepFileName({ name: '日本語', partId: null, configuration: 'default' }, used)).toBe('part__part.step');
  });
});

describe('STEP ZIP', () => {
  it('holds only successful files, grouped by process, plus a manifest that lists every failure', () => {
    const parts = [part('Guide', 'ready'), part('Plate', 'ready', { disposition: 'cut-2d' }), part('Motor', 'failed')];
    const zip = buildStepZip({ assemblyName: 'MR. HORS', documentName: 'HORS 25-26', revision: { type: 'm', id: 'abc' }, scannedAt: '2026-10-24T00:00:00Z', parts, files: { 0: step('Guide'), 1: step('Plate') }, now: new Date('2026-10-24T01:00:00Z') });
    const files = unzipSync(zip.bytes);
    expect(Object.keys(files).sort()).toEqual(['MR_HORS_STEP/2D_cut/Plate.step', 'MR_HORS_STEP/3D_print/Guide.step', 'MR_HORS_STEP/MANIFEST.txt']);
    const manifest = strFromU8(files['MR_HORS_STEP/MANIFEST.txt']);
    expect(manifest).toContain('Assembly: MR. HORS (document: HORS 25-26)');
    expect(manifest).toContain('Revision read: microversion abc');
    expect(manifest).toContain('Files: 2 of 3 parts exported, 1 failed');
    expect(manifest).toContain('Plate.step | Plate | 2 | 2D cut (laser/waterjet/router) | mm |');
    expect(manifest).toContain('Motor (qty 2): Deliberate failure | https://cad.onshape.com/documents/d/w/w/e/Motor');
    expect(manifest).toContain('still needs a cut file (DXF)');
    expect(zip).toMatchObject({ filename: 'MR_HORS_STEP.zip', ready: 2, failed: 1 });
  });
  it('refuses to build a ZIP when every part failed or no file arrived', () => {
    expect(() => buildStepZip({ assemblyName: 'Robot', scannedAt: '', parts: [part('Motor', 'failed')], files: {} })).toThrow(NoStepFilesError);
    expect(() => buildStepZip({ assemblyName: 'Robot', scannedAt: '', parts: [part('Guide', 'ready')], files: {} })).toThrow('No STEP file could be exported (1 part failed).');
  });
});
