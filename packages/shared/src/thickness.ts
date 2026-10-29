import type { BomLine } from './index';

/**
 * The owner's rule (2026-10-28): a flat part is cut from sheet, with a DXF, only when it is 3 mm thick or less;
 * anything thicker is 3D printed from its STEP. The tolerance absorbs float noise such as 3.0001 mm, but not 1/8 in
 * (3.175 mm), which prints.
 */
export const maxCutThicknessMm = 3;
const toleranceMm = 0.005;
export const cutsFromSheet = (thicknessMm: number) => thicknessMm <= maxCutThicknessMm + toleranceMm;
/** "3", "3.18", never "3.000". */
export const formatMm = (value: number) => String(Math.round(value * 100) / 100);
/** Evidence and export note for a flat part too thick to cut. */
export const tooThickText = (thicknessMm: number) => `flat, ${formatMm(thicknessMm)} mm thick: over ${maxCutThicknessMm} mm, so 3D printed`;

const units: Record<string, number> = { mm: 1, millimeter: 1, millimetre: 1, millimeters: 1, millimetres: 1, cm: 10, in: 25.4, inch: 25.4, inches: 25.4, '"': 25.4 };
const number = String.raw`(\d+\s+\d+\/\d+|\d+\/\d+|\d*\.\d+|\d+)`;
const unit = String.raw`(millimet(?:er|re)s?|mm|cm|inch(?:es)?|in\b|")`;
const value = (text: string) => {
  const mixed = text.trim().match(/^(\d+)\s+(\d+)\/(\d+)$/);
  if (mixed) return Number(mixed[1]) + Number(mixed[2]) / Number(mixed[3]);
  const fraction = text.match(/^(\d+)\/(\d+)$/);
  return fraction ? Number(fraction[1]) / Number(fraction[2]) : Number(text);
};
const toMm = (amount: string, name: string) => value(amount) * (units[name.toLowerCase()] ?? NaN);
/** Every length with a unit in the text, in mm. */
const lengths = (text: string) => [...text.matchAll(new RegExp(`${number}\\s*${unit}`, 'gi'))].map(match => toMm(match[1], match[2])).filter(mm => Number.isFinite(mm) && mm > 0);

/** Onshape configuration pairs, `+` and percent-escapes undone ("Thickness=3+mm" is 3 mm). */
function configurationPairs(configuration: string | null) {
  if (!configuration || configuration === 'default') return [];
  return configuration.split(';').map(pair => {
    const [key, raw = ''] = pair.split('=');
    let text = raw.replace(/\+/g, ' ');
    try { text = decodeURIComponent(text); } catch { /* keep it as written */ }
    return { key: key.replace(/_/g, ' '), value: text };
  });
}

/**
 * A part's thickness when its name, description, or configuration states it: a thickness configuration value, a
 * phrase like "6mm thick" or "thickness 1/8 in", the last of "300x200x3mm", or else the one length of an inch or
 * less in the text ("3mm plate", "1/8 in Side Plate"). Longer lengths are sizes, not thickness, and two different
 * short lengths are ambiguous, so neither gives a thickness.
 */
export function statedThicknessMm(line: Pick<BomLine, 'name' | 'description' | 'configuration'>): { mm: number; from: 'name' | 'configuration' } | null {
  const pairs = configurationPairs(line.configuration);
  for (const pair of pairs) {
    if (!/thick|\bthk\b|^\s*t\s*$|gauge|sheet/i.test(pair.key)) continue;
    const found = lengths(pair.value);
    if (found.length === 1) return { mm: found[0], from: 'configuration' };
  }
  const text = `${line.name} ${line.description ?? ''}`;
  const explicit = text.match(new RegExp(`${number}\\s*${unit}\\s*thick`, 'i')) ?? text.match(new RegExp(`thick(?:ness)?\\s*[:=]?\\s*${number}\\s*${unit}`, 'i'))
    ?? text.match(new RegExp(`\\bt\\s*=\\s*${number}\\s*${unit}`, 'i'));
  if (explicit) { const mm = toMm(explicit[1], explicit[2]); if (Number.isFinite(mm) && mm > 0) return { mm, from: 'name' }; }
  const triple = text.match(new RegExp(String.raw`(\d*\.?\d+)\s*[x×]\s*(\d*\.?\d+)\s*[x×]\s*(\d*\.?\d+)\s*${unit}`, 'i'));
  if (triple) { const mm = Math.min(...[triple[1], triple[2], triple[3]].map(item => toMm(item, triple[4]))); if (Number.isFinite(mm) && mm > 0) return { mm, from: 'name' }; }
  // Sizes written as "100x60mm" are not thickness: drop them before looking for a lone short length.
  const loose = text.replace(new RegExp(String.raw`(\d*\.?\d+)\s*[x×]\s*(\d*\.?\d+)\s*${unit}`, 'gi'), ' ');
  const configured = pairs.map(pair => pair.value).join(' ');
  const short = [...new Set([...lengths(loose), ...lengths(configured)].filter(mm => mm <= 25.4 + toleranceMm).map(mm => Math.round(mm * 1000) / 1000))];
  if (short.length === 1) return { mm: short[0], from: lengths(loose).some(mm => Math.abs(mm - short[0]) < 0.001) ? 'name' : 'configuration' };
  return null;
}

/**
 * How an exported part is made after the thickness rule: a 2D-cut part (not chosen by a person) whose stated
 * thickness is over 3 mm is printed instead, with the reason as its note.
 */
export function thicknessRule(line: Pick<BomLine, 'name' | 'description' | 'configuration' | 'disposition' | 'dispositionSource'>): { disposition: BomLine['disposition']; note: string | null } {
  if (line.disposition !== 'cut-2d' || line.dispositionSource === 'manual') return { disposition: line.disposition, note: null };
  const stated = statedThicknessMm(line);
  return stated && !cutsFromSheet(stated.mm) ? { disposition: 'print', note: tooThickText(stated.mm) } : { disposition: line.disposition, note: null };
}
