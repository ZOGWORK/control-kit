import type { BomLine, ScanResult } from './index';

/**
 * How the team will get the physical part. `review` means nothing reliable decided it yet.
 * Suppression is an assembly state, not a disposition, and lives on `BomLine.suppressed`.
 */
export type Disposition = 'buy' | 'print' | 'cnc' | 'cut-2d' | 'fabricate' | 'review';
/** Where the CAD model came from, as far as the evidence shows. */
export type Provenance = 'vendor-catalog' | 'standard-content' | 'linked-library' | 'team-design' | 'unknown';
/** What decided the disposition, in precedence order. */
export type DispositionSource = 'manual' | 'exact-sku' | 'explicit-metadata' | 'provenance' | 'suggestion' | 'none';
export type Confidence = 'certain' | 'high' | 'medium' | 'low';
/** A saved manual choice. Older saves used 'commercial' / 'printed'; they are read as 'buy' / 'print'. */
export type ClassificationOverride = Disposition;
export type UserSettings = { teamNumber: string | null };
export type ClassificationOverrides = Record<string, ClassificationOverride>;
export const dispositions: Disposition[] = ['buy', 'print', 'cnc', 'cut-2d', 'fabricate', 'review'];
export const dispositionLabel: Record<Disposition, string> = { buy: 'Buy', print: '3D print', cnc: 'CNC machine', 'cut-2d': '2D cut (laser/waterjet/router)', fabricate: 'Other fabrication', review: 'Needs review' };
export function parseOverride(value: unknown): ClassificationOverride | null {
  if (value === 'commercial') return 'buy';
  if (value === 'printed') return 'print';
  return typeof value === 'string' && (dispositions as string[]).includes(value) ? value as Disposition : null;
}

/** Manual type follows the part/configuration across source revision changes. */
export const classificationIdentity = (line: Pick<BomLine, 'documentId' | 'elementId' | 'partId' | 'configuration'>) =>
  `${line.documentId}:${line.elementId}:${line.partId ?? ''}:${line.configuration ?? ''}`;
export function printCategory(name: string) {
  if (/wheel|drive|swerve/i.test(name)) return 'drivetrain';
  if (/intake|roller/i.test(name)) return 'intake';
  if (/lift|slide|elevator/i.test(name)) return 'lift';
  if (/shooter|launch/i.test(name)) return 'shooter';
  if (/turret/i.test(name)) return 'turret';
  if (/frame|channel|rail/i.test(name)) return 'chassis';
  if (/electronic|sensor|circuit|wire/i.test(name)) return 'electronics';
  return 'misc';
}

/** Process vocabulary, matched as whole words only. */
const processWords: Record<Exclude<Disposition, 'review'>, string> = {
  print: '3dp|3d[ -]?print(?:ed|ing|s)?|print(?:ed|ing|s)?|fdm|sla|sls|additive(?:[ -]manufactur(?:ed|ing))?',
  cnc: 'cnc(?:[ -](?:machin(?:ed|ing)|mill(?:ed|ing)?))?|mill(?:ed|ing|s)?|machin(?:ed|ing)|lathe[sd]?|turn(?:ed|ing)',
  'cut-2d': 'laser(?:[ -]?cut(?:s|ting)?|ed|ing)?|water[ -]?jet(?:s|ted|ting)?|rout(?:er|ed|ing)|2d[ -]?cut(?:s|ting)?|plasma(?:[ -]?cut(?:s|ting)?)?|dxf',
  buy: 'buy|bought|purchas(?:e|ed|ing)|cots|off[ -]the[ -]shelf',
  fabricate: 'weld(?:ed|ing|s)?|bent|bend(?:ing|s)?|sheet[ -]?metal|fabricat(?:e|ed|es|ing|ion)|hand[ -]?made',
};
/** Team-written process markers in a name: a complete bracketed tag ("[3DP]", "(CNC)", "{laser}") or "#word". */
const tagged = (Object.entries(processWords) as Array<[Disposition, string]>).map(([disposition, words]) =>
  [new RegExp(`[[({]\\s*(?:${words})\\s*[\\])}]|#(?:${words})(?![a-z0-9])`, 'i'), disposition] as const);
const processValue = (Object.entries(processWords) as Array<[Disposition, string]>).map(([disposition, words]) =>
  [new RegExp(`(?<![a-z0-9])(?:${words})(?![a-z0-9])`, 'i'), disposition] as const);
/** The single disposition all matching patterns agree on, or what matched when they conflict. */
function explicitMatch(value: string, patterns: ReadonlyArray<readonly [RegExp, Disposition]>) {
  const found = patterns.flatMap(([pattern, disposition]) => { const match = value.match(pattern); return match ? [{ disposition, text: match[0].trim() }] : []; });
  const distinct = [...new Set(found.map(item => item.disposition))];
  return found.length ? { disposition: distinct.length === 1 ? distinct[0] : null, text: found.map(item => item.text).join(', ') } : null;
}
const printMaterial = /\b(?:pla|petg|abs|asa|tpu|nylon|pa12|pa-cf|onyx|resin|cf-?pla|cf-?nylon)\b/i;
const printWords = /\b(?:print(?:ed)?|3[ -]?d[ -]?print(?:ed)?|stl|fdm)\b/i;
const flatWords = /\b(?:plate|panel|sheet|gusset|side\s*plate)\b/i;
const customWords = /\b(?:custom|bracket|mount|spacer|adapter|holder|guide|cover)\b/i;

type Decision = { disposition: Disposition; source: DispositionSource; confidence: Confidence; provenance: Provenance; evidence: string[]; suggestion: Disposition | null; reviewReason: string | null };

function provenanceOf(line: BomLine, assemblyDocumentId: string | null): { provenance: Provenance; evidence: string | null } {
  if (line.matchStatus === 'exact' || line.matchStatus === 'confirmed') return { provenance: 'vendor-catalog', evidence: line.matchStatus === 'exact' ? `exact vendor SKU ${line.vendor?.sku ?? ''}`.trim() : `vendor match confirmed by you (${line.vendor?.sku ?? ''})` };
  if (line.isStandardContent) return { provenance: 'standard-content', evidence: 'Onshape standard content (fastener/hardware library)' };
  if (assemblyDocumentId && line.documentId !== assemblyDocumentId) return { provenance: 'linked-library', evidence: line.partNumber ? `linked from another document with part number ${line.partNumber}` : 'linked from another document, no part number' };
  if (assemblyDocumentId && line.documentId === assemblyDocumentId) return { provenance: 'team-design', evidence: 'modeled in this document' };
  return { provenance: 'unknown', evidence: null };
}

/**
 * Deterministic precedence: manual override → exact verified SKU (Buy) → explicit metadata (process column, team
 * tag, print material) → strong provenance (standard content, linked library part with a part number, confirmed
 * match) → heuristic suggestion → Needs review. A suggestion never decides on its own; it rides along with
 * `review` so a person confirms it with one click.
 */
export function decideDisposition(line: BomLine, teamNumber: string | null, assemblyDocumentId: string | null = null): Decision {
  const { provenance, evidence: provenanceEvidence } = provenanceOf(line, assemblyDocumentId);
  const base = { provenance, evidence: provenanceEvidence ? [provenanceEvidence] : [] as string[], suggestion: null as Disposition | null, reviewReason: null as string | null };
  if (line.matchStatus === 'exact') return { ...base, disposition: 'buy', source: 'exact-sku', confidence: 'certain' };
  const text = `${line.name} ${line.description ?? ''}`;
  const process = line.bomProperties?.process ?? null;
  // Explicit metadata that names two different processes is a question for a person, not a decision.
  const processMatch = process ? explicitMatch(process, processValue) : null;
  if (processMatch?.disposition) return { ...base, disposition: processMatch.disposition, source: 'explicit-metadata', confidence: 'high', evidence: [...base.evidence, `BOM process column "${process}"`] };
  if (processMatch) return { ...base, disposition: 'review', source: 'none', confidence: 'low', evidence: [...base.evidence, `BOM process column "${process}"`], reviewReason: `BOM process "${process}" names more than one process: choose one` };
  const tagMatch = explicitMatch(text, tagged);
  if (tagMatch?.disposition) return { ...base, disposition: tagMatch.disposition, source: 'explicit-metadata', confidence: 'high', evidence: [...base.evidence, `team tag "${tagMatch.text}" in name`] };
  if (tagMatch) return { ...base, disposition: 'review', source: 'none', confidence: 'low', evidence: [...base.evidence, `team tags ${tagMatch.text} in name`], reviewReason: 'Team tags in the name disagree: choose one process' };
  if (line.material && printMaterial.test(line.material)) return { ...base, disposition: 'print', source: 'explicit-metadata', confidence: 'high', evidence: [...base.evidence, `print material ${line.material}`] };
  if (line.matchStatus === 'confirmed') return { ...base, disposition: 'buy', source: 'provenance', confidence: 'high' };
  if (provenance === 'standard-content') return { ...base, disposition: 'buy', source: 'provenance', confidence: 'high' };
  if (provenance === 'linked-library' && line.partNumber) return { ...base, disposition: 'buy', source: 'provenance', confidence: 'medium', evidence: [...base.evidence, 'library parts with a part number are usually purchased; no catalog match yet'] };
  // Everything below is a suggestion for a person to confirm.
  const team = teamNumber && new RegExp(`(?<!\\d)${teamNumber}(?!\\d)`).test(line.name) ? `team number ${teamNumber} in name` : null;
  if (line.matchStatus === 'possible') return { ...base, disposition: 'review', source: 'suggestion', confidence: 'low', suggestion: 'buy', reviewReason: `Possible vendor match ${line.vendor?.sku ?? ''}: confirm it or choose how this part is made`.replace('  ', ' ') };
  if (printWords.test(text)) return { ...base, disposition: 'review', source: 'suggestion', confidence: 'medium', suggestion: 'print', evidence: [...base.evidence, 'print wording in name', ...(team ? [team] : [])], reviewReason: 'Name says it is printed; confirm 3D print' };
  if (flatWords.test(text) && provenance !== 'linked-library') return { ...base, disposition: 'review', source: 'suggestion', confidence: 'low', suggestion: 'cut-2d', evidence: [...base.evidence, 'flat-part wording in name', ...(team ? [team] : [])], reviewReason: 'Looks like a custom plate: choose 2D cut, CNC, or 3D print' };
  if (provenance === 'team-design' && (customWords.test(text) || team)) return { ...base, disposition: 'review', source: 'suggestion', confidence: 'low', suggestion: 'print', evidence: [...base.evidence, ...(team ? [team] : ['custom-part wording in name'])], reviewReason: 'Team-designed part: choose how it is made' };
  if (provenance === 'linked-library') return { ...base, disposition: 'review', source: 'none', confidence: 'low', reviewReason: 'Library part without a part number: add its vendor SKU or choose a disposition' };
  if (provenance === 'team-design') return { ...base, disposition: 'review', source: 'none', confidence: 'low', reviewReason: 'Team-designed part: choose how it is made' };
  return { ...base, disposition: 'review', source: 'none', confidence: 'low', reviewReason: 'No part number, vendor match, or process information' };
}

/** `classification` is the legacy three-way view still read by exports; it follows the disposition. */
const legacyClassification = (disposition: Disposition): BomLine['classification'] => disposition === 'buy' ? 'commercial' : disposition === 'print' ? 'printed' : 'unknown';

export function classifyLine(line: BomLine, teamNumber: string | null, override: ClassificationOverride | null = null, assemblyDocumentId: string | null = null): BomLine {
  const decision = decideDisposition(line, teamNumber, assemblyDocumentId);
  line.provenance = decision.provenance;
  line.suggestedDisposition = decision.suggestion;
  line.manualClassification = override;
  if (override) {
    line.disposition = override;
    line.dispositionSource = 'manual';
    line.dispositionConfidence = 'certain';
    line.reviewReason = override === 'review' ? 'Marked for review by you' : null;
    // An exact SKU stays on the line; overriding it is allowed but must stay visible.
    line.dispositionEvidence = [`set to ${dispositionLabel[override]} by you`, ...(line.matchStatus === 'exact' && override !== 'buy' ? [`exception: exact vendor SKU ${line.vendor?.sku ?? ''} would make this Buy`] : []), ...decision.evidence];
  } else {
    line.disposition = decision.disposition;
    line.dispositionSource = decision.source;
    line.dispositionConfidence = decision.confidence;
    line.dispositionEvidence = decision.evidence;
    line.reviewReason = decision.reviewReason;
  }
  line.classification = legacyClassification(line.disposition);
  line.classificationReasons = line.dispositionEvidence;
  line.classificationScore = 0;
  return line;
}

export function classifyScan(result: ScanResult, settings: UserSettings, overrides: ClassificationOverrides): ScanResult {
  for (const line of result.lines) classifyLine(line, settings.teamNumber, overrides[line.bomLineKey] ?? null, result.documentId);
  result.stats.printedLines = result.lines.filter(line => line.disposition === 'print').length;
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
