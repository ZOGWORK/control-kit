import type { BomLine, ScanResult } from './index';

export type ClassificationOverride = 'commercial' | 'printed';
export type UserSettings = { teamNumber: string | null };
export type ClassificationOverrides = Record<string, ClassificationOverride>;
/** Manual type follows the part/configuration across source revision changes. */
export const classificationIdentity = (line: Pick<BomLine, 'documentId' | 'elementId' | 'partId' | 'configuration'>) =>
  `${line.documentId}:${line.elementId}:${line.partId ?? ''}:${line.configuration ?? ''}`;

const strong = /\b(?:printed|3[ -]?d print|stl|fdm|pla|petg)\b/i;
const weak = ['custom', 'bracket', 'mount', 'plate', 'panel', 'spacer', 'adapter', 'holder', 'guide', 'cover'];
const fileSuffix = /(?:_v\d+|_final|\brev\d+)\b/i;
export const classificationForScore = (score: number): BomLine['classification'] => score >= 60 ? 'printed' : score >= 35 ? 'unknown' : 'commercial';

export function classifyLine(line: BomLine, teamNumber: string | null, override: ClassificationOverride | null = null): BomLine {
  const text = `${line.name} ${line.description ?? ''}`;
  const reasons: string[] = [];
  let score = 0;
  if (strong.test(text)) { score += 50; reasons.push('strong print keyword (+50)'); }
  const weakMatches = weak.filter(keyword => new RegExp(`(?<![a-z0-9])${keyword}(?![a-z0-9])`, 'i').test(text)).slice(0, 2);
  if (/\bprint\b/i.test(text) || (fileSuffix.test(text) && weakMatches.length)) { score += 30; reasons.push('print token or file suffix (+30)'); }
  for (const keyword of weakMatches) { score += 20; reasons.push(`keyword: ${keyword} (+20)`); }
  if (!line.vendor && !/\d{3,}/.test(line.name)) { score += 25; reasons.push('no vendor or SKU-like number (+25)'); }
  if (teamNumber && new RegExp(`(?<!\\d)${teamNumber}(?!\\d)`).test(line.name)) { score += 15; reasons.push(`team number: ${teamNumber} (+15)`); }
  if (line.matchStatus === 'exact') { score -= 60; reasons.push('exact vendor SKU (-60)'); }
  else if (line.vendor && line.matchConfidence >= 0.85) { score -= 20; reasons.push('strong vendor match (-20)'); }
  line.classificationScore = Math.min(100, Math.max(0, score));
  line.classification = classificationForScore(line.classificationScore);
  if (line.matchStatus === 'exact') line.classification = 'commercial';
  line.manualClassification = override;
  if (override) { line.classification = override; reasons.push(`manual override: ${override}`); }
  line.classificationReasons = reasons;
  return line;
}

export function classifyScan(result: ScanResult, settings: UserSettings, overrides: ClassificationOverrides): ScanResult {
  for (const line of result.lines) classifyLine(line, settings.teamNumber, overrides[line.bomLineKey] ?? null);
  result.stats.printedLines = result.lines.filter(line => line.classification === 'printed').length;
  result.missingMetadata = result.missingMetadata.map(item => item.suppressed
    ? result.suppressed.find(line => line.bomLineKey === item.bomLineKey) ?? item
    : result.lines.find(line => line.bomLineKey === item.bomLineKey) ?? item);
  return result;
}

export function applyClassificationChoice(result: ScanResult, identity: string, choice: ClassificationOverride | null, settings: UserSettings): ScanResult {
  const lines = result.lines.map(line => ({ ...line, manualClassification: classificationIdentity(line) === identity ? choice : line.manualClassification }));
  return classifyScan({ ...result, lines, stats: { ...result.stats } }, settings,
    Object.fromEntries(lines.filter(line => line.manualClassification).map(line => [line.bomLineKey, line.manualClassification!])));
}
