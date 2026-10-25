import type { BomLine, ScanResult } from './index';
import type { Disposition } from './classifier';
import { configurationValues, type VendorRecord } from './matching';

/**
 * A second, optional pass over the lines the deterministic layer could not settle. The AI proposes; a person decides.
 * Nothing here calls a model: this module builds the one batched request, validates the answer, and applies it. The
 * Worker sends the request (`apps/worker/src/ai-review.ts`). Price, stock, and links never come from the answer: a
 * suggestion can only point at a catalog record the request already offered, and the line reads everything from it.
 */
export const AI_REVIEW_VERSION = 1;
/** At most this many lines go in one request; the rest stay as they are and are counted as left out. */
export const AI_REVIEW_MAX_LINES = 150;
export const aiDispositions = ['buy', 'print', 'cnc', 'cut-2d', 'fabricate', 'hardware', 'review'] as const;
export type AiDisposition = typeof aiDispositions[number];
export type AiCandidate = { id: string; vendor: VendorRecord['vendorId']; sku: string; name: string };
export type AiReviewLine = {
  id: string; name: string; description: string | null; material: string | null; partNumber: string | null; configuration: string[];
  /** Up to three places the part is used, as assembly paths. */
  usedIn: string[]; quantity: number; source: 'this document' | 'linked document' | 'standard content';
  /** What the deterministic layer concluded and why it is unsure. */
  current: { disposition: Disposition; suggestion: Disposition | null; match: BomLine['matchStatus']; reason: string | null; packUnknown: boolean };
  candidates: AiCandidate[];
};
export type AiReviewRequest = { version: number; assembly: string; lines: AiReviewLine[]; leftOut: number };
export type AiReviewItem = { id: string; disposition: AiDisposition; candidateId: string | null; confidence: number; reason: string };
export type AiProvider = 'gemini' | 'anthropic';
/** Stored on the line; `candidateId` names one of the line's own candidate records. */
export type AiSuggestion = Omit<AiReviewItem, 'id'> & { provider: AiProvider };

const candidateId = (record: VendorRecord) => `${record.vendorId}:${record.normalizedSku}`;
/** Every catalog record the line already carries: its match, its choices, and its near misses. */
export function lineCandidates(line: BomLine): VendorRecord[] {
  const found = new Map<string, VendorRecord>();
  for (const record of [line.vendor, ...(line.choices ?? []), ...(line.nearMatches ?? [])]) if (record) found.set(candidateId(record), record);
  return [...found.values()];
}
export const aiCandidateRecord = (line: BomLine, id: string | null) => id ? lineCandidates(line).find(record => candidateId(record) === id) ?? null : null;

/**
 * The ambiguous bucket: undecided or merely suggested dispositions, possible matches, no match but close candidates,
 * an exact-SKU conflict, or a Buy line whose pack size is unknown. Lines a person decided, and settled lines (an exact
 * or confirmed match with a known pack, or a decided disposition), are never sent.
 */
export function needsAiReview(line: BomLine): boolean {
  if (line.suppressed || line.manualClassification || line.disposition === 'ignore') return false;
  if (line.matchStatus === 'possible') return true;
  if (line.matchStatus === 'unmatched' && (line.nearMatches?.length ?? 0) > 0) return true;
  if (line.disposition === 'review' || line.dispositionConfidence === 'low') return true;
  return line.disposition === 'buy' && Boolean(line.vendor) && !line.vendor!.packSizeVerified;
}

/** The request, and the line key behind each request id (kept in the app, never sent). */
export function buildAiReviewRequest(result: ScanResult): { request: AiReviewRequest; keys: Record<string, string> } {
  const lines = result.lines.filter(needsAiReview);
  const sent = lines.slice(0, AI_REVIEW_MAX_LINES);
  const keys = Object.fromEntries(sent.map((line, index) => [`L${index + 1}`, line.bomLineKey]));
  return { keys, request: { version: AI_REVIEW_VERSION, assembly: result.assemblyName, leftOut: lines.length - sent.length, lines: sent.map((line, index) => ({
    id: `L${index + 1}`, name: line.name, description: line.description, material: line.material, partNumber: line.partNumber,
    configuration: configurationValues(line.configuration), usedIn: line.instancePaths.slice(0, 3), quantity: line.qty,
    source: line.isStandardContent ? 'standard content' : line.documentId === result.documentId ? 'this document' : 'linked document',
    current: { disposition: line.disposition, suggestion: line.suggestedDisposition, match: line.matchStatus, reason: line.reviewReason, packUnknown: Boolean(line.vendor && !line.vendor.packSizeVerified) },
    candidates: lineCandidates(line).map(record => ({ id: candidateId(record), vendor: record.vendorId, sku: record.sku, name: record.name })),
  })) } };
}

/** Stable key for a request: identical inputs give the same hash, so a rescan of unchanged parts reuses the answer. */
export async function aiReviewHash(request: AiReviewRequest) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(request)));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

/** JSON Schema of the answer, shared by both providers. */
export const aiReviewSchema = {
  type: 'object',
  properties: { items: { type: 'array', items: { type: 'object', properties: {
    id: { type: 'string' }, disposition: { type: 'string', enum: [...aiDispositions] },
    candidateId: { type: ['string', 'null'] }, confidence: { type: 'number' }, reason: { type: 'string' },
  }, required: ['id', 'disposition', 'candidateId', 'confidence', 'reason'], additionalProperties: false } } },
  required: ['items'], additionalProperties: false,
} as const;

export const aiReviewInstructions = [
  'You recheck parts from an FTC robotics CAD bill of materials that an automatic matcher could not settle.',
  'For each line, say how the team gets the part: buy (a vendor product), print (3D printed), cnc, cut-2d (laser, waterjet, or router from sheet), fabricate (other shop work), hardware (screws, nuts, washers, spacers bought in bulk), or review (cannot tell).',
  'Teams model their own plates, mounts, and brackets; parts linked from vendor or library documents are usually bought. Names with vendor part numbers are bought.',
  'candidateId must be the id of one of that line\'s candidates, or null. Never invent a SKU, product, price, or link. If no candidate is the same product, use null.',
  'confidence is 0 to 1. Use review with low confidence when the evidence is thin. reason is one short sentence naming the evidence.',
  'Answer every line id exactly once, as JSON only.',
].join('\n');

/**
 * Keeps only well-formed answers about lines that were asked, with a candidate taken from that line's own list.
 * Anything else (unknown ids, invented candidates, out-of-range confidence, extra lines) is dropped, not repaired.
 */
export function parseAiReview(raw: unknown, request: AiReviewRequest): AiReviewItem[] {
  const items = raw && typeof raw === 'object' && Array.isArray((raw as { items?: unknown }).items) ? (raw as { items: unknown[] }).items : [];
  const asked = new Map(request.lines.map(line => [line.id, new Set(line.candidates.map(candidate => candidate.id))]));
  const seen = new Set<string>();
  return items.flatMap((value): AiReviewItem[] => {
    if (!value || typeof value !== 'object') return [];
    const item = value as Record<string, unknown>;
    const candidates = typeof item.id === 'string' ? asked.get(item.id) : undefined;
    if (!candidates || seen.has(item.id as string)) return [];
    if (!aiDispositions.includes(item.disposition as AiDisposition)) return [];
    if (item.candidateId !== null && (typeof item.candidateId !== 'string' || !candidates.has(item.candidateId))) return [];
    if (typeof item.confidence !== 'number' || !Number.isFinite(item.confidence) || item.confidence < 0 || item.confidence > 1) return [];
    if (typeof item.reason !== 'string' || !item.reason.trim()) return [];
    seen.add(item.id as string);
    return [{ id: item.id as string, disposition: item.disposition as AiDisposition, candidateId: item.candidateId as string | null, confidence: item.confidence, reason: item.reason.trim().slice(0, 200) }];
  });
}

/**
 * Puts each answer on the line it was asked about, by line key, so decisions made while the request ran do not shift
 * answers onto other lines. A line decided meanwhile, or not answered, gets no suggestion; a candidate must still be on it.
 */
export function applyAiReview(result: ScanResult, keys: Record<string, string>, items: AiReviewItem[], provider: AiProvider): ScanResult {
  const byKey = new Map(items.flatMap(item => keys[item.id] ? [[keys[item.id], item] as const] : []));
  const lines = result.lines.map(line => {
    const item = byKey.get(line.bomLineKey);
    if (!item || !needsAiReview(line) || (item.candidateId && !aiCandidateRecord(line, item.candidateId))) return line;
    return { ...line, aiSuggestion: { disposition: item.disposition, candidateId: item.candidateId, confidence: item.confidence, reason: item.reason, provider } };
  });
  return { ...result, lines, stats: { ...result.stats } };
}
