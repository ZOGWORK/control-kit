import type { BomLine, ScanResult } from './index';
import { recalculatePurchasing } from './purchasing';
import { cutsFromSheet, formatMm, maxCutThicknessMm, statedThicknessMm, tooThickText } from './thickness';

/**
 * How the team will get the physical part. `review` means nothing reliable decided it yet.
 * Suppression is an assembly state, not a disposition, and lives on `BomLine.suppressed`.
 * `hardware` is a fastener (screw, nut, washer, clip) that teams take from their hardware stock: it needs no decision,
 * and its CAD count is every placement, including pattern and Replicate copies (the assembly definition lists them as
 * instances); fasteners that were never modelled are not counted.
 * `ignore` ("Not needed") is set only by a person, for a body that is not a real part to buy or make (a shaft that is
 * part of an imported motor, a reference body); it leaves Review, Buy, and Make but stays listed.
 */
export type Disposition = 'buy' | 'print' | 'cnc' | 'cut-2d' | 'fabricate' | 'hardware' | 'ignore' | 'review';
/** Where the CAD model came from, as far as the evidence shows. */
export type Provenance = 'vendor-catalog' | 'standard-content' | 'linked-library' | 'team-design' | 'unknown';
/** What decided the disposition, in precedence order. */
export type DispositionSource = 'manual' | 'exact-sku' | 'explicit-metadata' | 'provenance' | 'suggestion' | 'none';
export type Confidence = 'certain' | 'high' | 'medium' | 'low';
/** A saved manual choice. Older saves used 'commercial' / 'printed'; they are read as 'buy' / 'print'. */
export type ClassificationOverride = Disposition;
export type UserSettings = { teamNumber: string | null };
export type ClassificationOverrides = Record<string, ClassificationOverride>;
export const dispositions: Disposition[] = ['buy', 'print', 'cnc', 'cut-2d', 'fabricate', 'hardware', 'ignore', 'review'];
export const dispositionLabel: Record<Disposition, string> = { buy: 'Buy', print: '3D print', cnc: 'CNC machine', 'cut-2d': '2D cut (laser/waterjet/router)', fabricate: 'Other fabrication', hardware: 'Fastener', ignore: 'Not needed', review: 'Needs review' };
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
const processWords: Record<Exclude<Disposition, 'review' | 'hardware' | 'ignore'>, string> = {
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
/**
 * Vendor part numbers and product naming in a part's name: goBILDA/ServoCity 1234-5678-9012 and "1234 Series",
 * REV-12-3456, AndyMark am-1234, and McMaster-Carr 91290A110. Strong hints that the part is bought, but only a
 * catalog match verifies it, so they suggest rather than decide.
 */
const vendorNumbers: Array<[RegExp, string]> = [
  [/\b\d{4}-\d{4}-\d{4}\b/, 'goBILDA/ServoCity part number'], [/\bREV-\d{2}-\d{4}\b/i, 'REV part number'], [/\bam-\d{3,5}[a-z]?\b/i, 'AndyMark part number'],
  [/\b\d{4,5}A\d{2,4}\b/, 'McMaster-Carr part number'], [/\b\d{4} Series\b/i, 'goBILDA/ServoCity product name'],
];
/** Off-the-shelf hardware: fasteners, bearings, belts, retaining rings, and metric thread sizes like "M4 x 0.7". */
const hardwareWords = /\b(?:screws?|bolts?|(?:lock)?nuts?|washers?|e-?clips?|snap\s*rings?|retaining\s*rings?|bearings?|bushings?|belts?|rivets?|shaft\s*collars?|set\s*screws?|shcs|bhcs|fhcs|standoffs?|motors?|servos?|gearbox(?:es)?)\b|\bM\d(?:\.\d)?\s*x\s*\d/i;
/** Fasteners a team takes from stock rather than ordering per part. Standoffs, bearings, and belts are not here: those are counted parts. */
const fastenerWords = /\b(?:screws?|bolts?|(?:lock|hex|nylock)?\s?nuts?|washers?|e-?clips?|snap\s*rings?|retaining\s*rings?|rivets?|set\s*screws?|shcs|bhcs|fhcs|shoulder\s*screws?|(?:button|socket|flat|pan|cap)\s*head)\b|^M\d(?:\.\d)?\s*x\s*\d/i;
/** Products that mention a fastener as a feature ("Set Screw Pinion Pulley", "Set-Screw Collar") are not fasteners. */
const fastenedProductWords = /\b(?:pulleys?|collars?|hubs?|gears?|sprockets?|pinions?|bearings?|couplers?|mounts?|brackets?|wheels?|clamps?|plates?|strips?|shafts?|jacks?|panels?|grooves?|lead\s*screws?|ball\s*screws?)\b/i;
const customWords = /\b(?:custom|bracket|mount|spacer|adapter|holder|guide|cover)\b/i;
/** Products a team buys whole even when the vendor's CAD models them as an assembly. */
const productWords = /\b(?:bearings?|motors?|servos?|gearbox(?:es)?|wheels?|encoders?|sensors?|batter(?:y|ies)|cameras?|hubs?|actuators?)\b|\b(?:axon(?: (?:max|mini|micro))?|yellow ?jacket|neverest|torquenado|ultra ?planetary|core hex|hd hex|spark ?mini|control hub|expansion hub|servo hub|limelight|pinpoint|octo ?quad|sparkfun otos|rev (?:color|distance|touch|2m)|smart robot servo|gobilda (?:motor|servo))\b/i;
/** Names a team gives its own groupings; such a subassembly is never treated as one product by wording alone. */
const groupingWords = /\b(?:stack|assembly|asm|sub-?assembly|pod|module|mechanism|system|side|left|right|front|back|case|plate|bracket|mount|holder|adapter|spacer|guide|cover|custom|printed|3dp|shroud|housing|cradle|clip|arm|linkage|box|block|claw|intake|outtake|turret|drive|drivetrain|lift|slide|elevator|shooter|launcher|wrist|gripper|chassis|frame)\b/i;
/** A plural product word names several products a team grouped ("Intake Wheels", "Drive Motors"), not one product. */
const pluralProductWords = /\b(?:bearings|motors|servos|gearboxes|wheels|encoders|sensors|batteries|cameras|hubs|actuators)\b/i;

/**
 * Why a subassembly should be one bought line instead of its internal parts, or null to list its parts. Vendor CAD
 * often models a motor, bearing, or wheel kit as an assembly of its insides (gearbox, races, rollers), which a team
 * never orders separately. A vendor part number in the name or part number is enough; otherwise the subassembly must
 * be linked from another document and named like a product, so a team's own subassemblies always expand.
 */
export function purchasedAssemblyReason(name: string, partNumber: string | null | undefined, linked: boolean): string | null {
  const text = `${name} ${partNumber ?? ''}`;
  for (const [pattern, label] of vendorNumbers) if (pattern.test(text) && !/Series/.test(label)) return `its name has a ${label}`;
  if (linked && productWords.test(name) && !groupingWords.test(name) && !pluralProductWords.test(name)) return 'it is linked from another document and named like a product';
  return null;
}

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
 * match) → wording and provenance → Needs review.
 *
 * At the owner's request (2026-10-25) a scan should need little to no review, so wording and provenance now decide
 * Buy, Fastener, or 2D cut on their own (source `suggestion`, labeled as automatic, one click to change). Prices are
 * unaffected: a line is priced only from an exact or confirmed match with a verified pack. What still waits for a
 * person is how a team-designed part is made (3D print or otherwise), which the owner keeps as it is.
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
  // "Nut Holder" or "Screw Mount" is a part to make, so custom-part wording keeps a name with fastener words in Review.
  if (fastenerWords.test(line.name) && !printWords.test(text) && !customWords.test(line.name) && !fastenedProductWords.test(line.name)) return { ...base, disposition: 'hardware', source: 'suggestion', confidence: 'medium', evidence: [...base.evidence, 'fastener wording in name'] };
  if (provenance === 'standard-content') return { ...base, disposition: 'buy', source: 'provenance', confidence: 'high' };
  if (provenance === 'linked-library' && line.partNumber) return { ...base, disposition: 'buy', source: 'provenance', confidence: 'medium', evidence: [...base.evidence, 'library parts with a part number are usually purchased; no catalog match yet'] };
  // Everything below is a suggestion for a person to confirm.
  const team = teamNumber && new RegExp(`(?<!\\d)${teamNumber}(?!\\d)`).test(line.name) ? `team number ${teamNumber} in name` : null;
  const auto = (disposition: Disposition, confidence: Confidence, why: string): Decision => ({ ...base, disposition, source: 'suggestion', confidence, evidence: [...base.evidence, why, 'decided automatically; change it if wrong'] });
  // A possible match on a part from another document is a bought part whose product is still to confirm (it is not
  // priced until then). On a team's own part, a name resemblance proves nothing, so the other rules decide.
  // Print wording wins: a printed part with a loose catalog resemblance is still printed.
  if (line.matchStatus === 'possible' && provenance !== 'team-design' && !printWords.test(text)) return auto('buy', 'medium', `possible vendor match ${line.vendor?.sku ?? ''}; confirm the product to price it`.replace('  ', ' '));
  if (printWords.test(text)) return { ...base, disposition: 'review', source: 'suggestion', confidence: 'medium', suggestion: 'print', evidence: [...base.evidence, 'print wording in name', ...(team ? [team] : [])], reviewReason: 'Name says it is printed; confirm 3D print' };
  for (const [pattern, label] of vendorNumbers) {
    const found = text.match(pattern);
    if (found) return auto('buy', 'medium', `${label} "${found[0]}" in name`);
  }
  // "Screw Mount Bracket" or "Nut Holder" is a part the team makes: custom-part words keep hardware wording from buying it.
  if (hardwareWords.test(text) && !customWords.test(text)) return auto('buy', 'medium', 'standard hardware wording in name');
  // A plate the name says is machined ("CNC milled side plate") is CNC. Any other plate is 2D cut when it is 3 mm
  // thick or less, or its thickness is not stated; a stated thickness over 3 mm makes it a 3D print (owner's rule).
  if (flatWords.test(text) && provenance !== 'linked-library') {
    const machined = /\b(?:cnc|mill(?:ed|ing)?|machined|lathe)\b/i.test(text);
    const stated = machined ? null : statedThicknessMm(line);
    const disposition = machined ? 'cnc' : stated && !cutsFromSheet(stated.mm) ? 'print' : 'cut-2d';
    const why = machined ? 'flat part with machining wording in name' : disposition === 'print' ? tooThickText(stated!.mm)
      : stated ? `flat, ${formatMm(stated.mm)} mm thick: ${maxCutThicknessMm} mm or less, so cut from sheet` : 'flat-part wording in name';
    return { ...auto(disposition, 'low', why), evidence: [...base.evidence, why, ...(team ? [team] : []), 'decided automatically; change it if wrong'] };
  }
  if (provenance === 'team-design' && (customWords.test(text) || team)) return { ...base, disposition: 'review', source: 'suggestion', confidence: 'low', suggestion: 'print', evidence: [...base.evidence, ...(team ? [team] : ['custom-part wording in name'])], reviewReason: 'Team-designed part: choose how it is made' };
  // Parts linked from another document (vendor and parts-library CAD) are almost always bought.
  if (provenance === 'linked-library') return auto('buy', 'low', 'linked from another document: parts libraries hold bought parts');
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
  // Only parts to buy are priced, and orders depend on which lines are bought, so pricing follows classification.
  recalculatePurchasing(result);
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
