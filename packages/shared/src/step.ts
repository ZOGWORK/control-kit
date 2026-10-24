import type { BomLine } from './index';
import { dispositionLabel, type Disposition } from './classifier';

/** Dispositions whose parts a team makes from a solid model, so they get a STEP file. */
export const stepDispositions: Disposition[] = ['print', 'cnc', 'cut-2d', 'fabricate'];
export const wantsStep = (line: BomLine) => !line.suppressed && stepDispositions.includes(line.disposition);

/** Readable, unique, filesystem-safe name: part name, then part ID, then a short configuration tag when configured. */
export function stepFileName(line: Pick<BomLine, 'name' | 'partId' | 'configuration'>, used: Set<string>) {
  const clean = line.name.normalize('NFKD').replace(/[^\w\- ]/g, '').trim().replace(/\s+/g, '_').slice(0, 60).replace(/[_-]+$/, '') || 'part';
  const id = (line.partId ?? 'part').replace(/[^a-zA-Z0-9]/g, '').slice(0, 10) || 'part';
  let tag = '';
  if (line.configuration && line.configuration !== 'default') {
    let hash = 0;
    for (const char of line.configuration) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
    tag = `__cfg${hash.toString(36).slice(0, 5)}`;
  }
  let name = `${clean}__${id}${tag}.step`;
  for (let suffix = 2; used.has(name.toLowerCase()); suffix++) name = `${clean}__${id}${tag}_${suffix}.step`;
  used.add(name.toLowerCase());
  return name;
}

export type StepCheck = { ok: true; units: string | null; productNames: string[]; nameMatches: boolean } | { ok: false; error: string };
const unitNames: Record<string, string> = { MILLI: 'mm', CENTI: 'cm', '': 'm' };
/**
 * A STEP file is an ISO-10303-21 exchange file: it starts with that header and ends with its terminator.
 * Anything else (an HTML error page, JSON, an empty body) is rejected rather than zipped as a part.
 */
export function checkStep(text: string, expectedName: string): StepCheck {
  const head = text.slice(0, 200).trimStart();
  if (!head.startsWith('ISO-10303-21;')) return { ok: false, error: text.trim() ? 'Onshape returned something other than a STEP file' : 'Onshape returned an empty file' };
  if (!/END-ISO-10303-21;\s*$/.test(text)) return { ok: false, error: 'STEP file is truncated' };
  // Length unit: SI_UNIT(.MILLI.,.METRE.) is mm and SI_UNIT($,.METRE.) is metres; inches use a conversion-based unit.
  const unit = text.match(/SI_UNIT\s*\(\s*(?:\.(MILLI|CENTI)\.|\$|\*)\s*,\s*\.METRE\.\s*\)/i);
  const inch = /CONVERSION_BASED_UNIT\s*\(\s*'INCH'/i.test(text);
  const productNames = [...text.matchAll(/PRODUCT\s*\(\s*'((?:[^']|'')*)'/g)].map(match => match[1].replace(/''/g, "'"));
  // Keep letters and digits in every script; an empty name can never count as a match.
  const normalize = (value: string) => value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  const expected = normalize(expectedName);
  return { ok: true, units: inch ? 'in' : unit ? unitNames[(unit[1] ?? '').toUpperCase()] ?? null : null, productNames, nameMatches: expected.length > 0 && productNames.some(name => normalize(name).includes(expected)) };
}

export type ExportPart = { lineKey: string; name: string; qty: number; disposition: Disposition; partId: string | null; configuration: string | null; sourceUrl: string; fileName: string;
  state: 'pending' | 'translating' | 'ready' | 'failed'; error: string | null; units: string | null; nameMatches: boolean | null; bytes: number | null };

/** The manifest and failure report that go in every ZIP, in plain text so any team member can read them. */
export function exportManifest(input: { assemblyName: string; documentName?: string; revision?: { type: string; id: string } | null; scannedAt: string; exportedAt: string; parts: ExportPart[] }) {
  const ready = input.parts.filter(part => part.state === 'ready');
  const failed = input.parts.filter(part => part.state === 'failed');
  const lines = [
    `Control Kit STEP export`,
    `Assembly: ${input.assemblyName}${input.documentName ? ` (document: ${input.documentName})` : ''}`,
    `Revision read: ${input.revision ? `${input.revision.type === 'm' ? 'microversion' : 'version'} ${input.revision.id}` : 'unknown'}`,
    `Scanned: ${input.scannedAt}    Exported: ${input.exportedAt}`,
    `Files: ${ready.length} of ${input.parts.length} parts exported${failed.length ? `, ${failed.length} failed (listed below)` : ''}`,
    '',
    'STEP files are solid models for printing, CAM, or reference. A 2D-cut part still needs a cut file (DXF) made from its flat face before cutting.',
    '',
    'File | Part | Qty | Process | Units | Onshape source',
    ...ready.map(part => `${part.fileName} | ${part.name} | ${part.qty} | ${dispositionLabel[part.disposition]} | ${part.units ?? 'unknown'}${part.nameMatches === false ? ' (product name differs; check before use)' : ''} | ${part.sourceUrl}`),
  ];
  if (failed.length) lines.push('', 'Failed parts (no file in this ZIP):', ...failed.map(part => `${part.name} (qty ${part.qty}): ${part.error ?? 'unknown error'} | ${part.sourceUrl}`));
  return `${lines.join('\n')}\n`;
}
