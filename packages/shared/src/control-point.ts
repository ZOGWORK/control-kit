import type { AssemblyContext, BomLine, ScanResult } from './index';
import type { Disposition } from './classifier';

/**
 * The bundle a reviewed scan attaches to Control Point: every line (active, suppressed, and missing-metadata), scan
 * metadata, the workbook and STEP zip as files, and each line in Control Point's CAD parts shape with every Control
 * Kit field kept beside it. Built from the scan the person already reviewed (their accepted AI suggestions are saved
 * choices by then), with no rescan or rematch. There is no network adapter: the live endpoint, auth, and file-upload
 * contract are unconfirmed, so only the in-memory test adapter below exists.
 */
export const CONTROL_POINT_CAD_URL = 'https://tryctrlpoint.org/cad-parts';
/** Files up to this size travel inside the bundle (base64); larger ones as a reference with name, size, and hash. */
export const INLINE_FILE_LIMIT_BYTES = 4 * 1024 * 1024;

/** Control Point's `cad_parts` row (server/cad.ts): sections, sources, and statuses are its own enums. */
export type ControlPointCadPart = {
  name: string; section: 'Intake' | 'Outtake' | 'Drivetrain' | 'Chassis' | 'End Game' | 'Electronics' | 'Other'; quantity: number;
  source: 'printed' | 'purchased' | 'gobilda' | 'other'; unit_cost: number; status: 'to_order' | 'ordered' | 'received' | 'printed' | 'installed'; notes: string;
};
export type ControlPointLine = {
  key: string; name: string; qty: number; unitsPerPack: number | null; packsToOrder: number | null; packPriceUsd: number | null; lineTotalUsd: number | null;
  vendor: string | null; sku: string | null; vendorUrl: string | null; stock: string;
  disposition: Disposition; dispositionSource: BomLine['dispositionSource']; manualOverride: Disposition | null;
  /** Legacy three-way type, kept for readers of the first payload version. */
  type: 'commercial' | 'printed' | 'unknown';
  matchStatus: BomLine['matchStatus']; matchConfidence: number; matchReasons: string[]; dispositionEvidence: string[]; reviewReason: string | null;
  /** On the line that carries a combined order: the pieces across every line ordering this SKU, and how many lines. */
  order: { qty: number; lines: number } | null; orderedWith: string | null; partNumber: string | null; configuration: string | null;
  documentId: string; elementId: string; partId: string | null; partStudioUrl: string; usedIn: string[]; suppressed: boolean; metadataIssue: string | null;
};
export type ControlPointFile = { name: string; mediaType: string; sizeBytes: number; sha256: string } & (
  | { delivery: 'inline'; contentBase64: string }
  | { delivery: 'reference'; reason: string });
export type ControlPointBomPayload = {
  idempotencyKey: string;
  source: 'control-kit';
  bundleVersion: 2;
  assembly: { name: string; documentId: string; elementId: string; onshapeUrl: string; assemblyUrl: string; documentName: string | null };
  revision: { type: 'v' | 'm'; id: string } | null;
  generatedAt: string;
  vendorDataUpdatedAt: string | null;
  staleVendorData: boolean;
  lines: ControlPointLine[];
  suppressedLines: ControlPointLine[];
  missingMetadataLines: ControlPointLine[];
  suppressedCount: number;
  totals: { uniqueLines: number; totalInstances: number; totalCostUsd: number | null; outOfStockLines: number };
  /** One Control Point CAD part per active line, in the same order, with the full Control Kit line under `extra`. */
  cadParts: Array<ControlPointCadPart & { extra: ControlPointLine }>;
  controlPointCadUrl: string;
  files: ControlPointFile[];
  /** Files the bundle should hold but does not, with why (a STEP zip before any STEP export ran). Never silently absent. */
  filesNotIncluded: Array<{ name: string; reason: string }>;
};

export interface ControlPointAdapter {
  isLinked(userId: string): Promise<boolean>;
  linkAccount(userId: string, code: string): Promise<void>;
  unlinkAccount(userId: string): Promise<void>;
  syncBom(userId: string, payload: ControlPointBomPayload): Promise<{ workspaceRecordId: string }>;
}

const hex = (buffer: ArrayBuffer) => [...new Uint8Array(buffer)].map(value => value.toString(16).padStart(2, '0')).join('');
const sha256 = async (data: Uint8Array | string) => hex(await crypto.subtle.digest('SHA-256', typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data)));
function base64(bytes: Uint8Array) {
  let text = '';
  for (let start = 0; start < bytes.length; start += 0x8000) text += String.fromCharCode(...bytes.subarray(start, start + 0x8000));
  return btoa(text);
}

function toLine(line: BomLine): ControlPointLine {
  const vendor = line.vendor;
  return {
    key: line.bomLineKey, name: line.name, qty: line.qty, unitsPerPack: vendor?.packSizeVerified ? vendor.packSize : null, packsToOrder: line.packsToOrder,
    packPriceUsd: vendor?.priceUsd ?? null, lineTotalUsd: line.lineTotalUsd, vendor: vendor?.vendorId ?? null, sku: vendor?.sku ?? null, vendorUrl: vendor?.url ?? null,
    stock: vendor?.stock ?? 'unknown', disposition: line.disposition, dispositionSource: line.dispositionSource, manualOverride: line.manualClassification,
    type: line.classification, matchStatus: line.matchStatus, matchConfidence: line.matchConfidence, matchReasons: line.matchReasons, dispositionEvidence: line.dispositionEvidence,
    reviewReason: line.reviewReason, order: line.order ?? null, orderedWith: line.orderedWith ?? null,
    partNumber: line.partNumber, configuration: line.configuration, documentId: line.documentId, elementId: line.elementId, partId: line.partId,
    partStudioUrl: line.partStudioUrl, usedIn: line.instancePaths, suppressed: line.suppressed, metadataIssue: line.missingMetadataReason,
  };
}
const byKey = (a: ControlPointLine, b: ControlPointLine) => a.key.localeCompare(b.key);

/** Control Point's section for a line: the first top-level subassembly whose name names a section, otherwise Other. */
function sectionOf(line: BomLine): ControlPointCadPart['section'] {
  const words = line.instancePaths.join(' ').toLowerCase();
  if (/\b(drive ?train|drive|mecanum|wheel)\b/.test(words)) return 'Drivetrain';
  if (/\bintake\b/.test(words)) return 'Intake';
  if (/\b(outtake|shooter|scoring|deposit)\b/.test(words)) return 'Outtake';
  if (/\b(end ?game|hang|climb|lift)\b/.test(words)) return 'End Game';
  if (/\b(electronics?|control hub|wiring)\b/.test(words)) return 'Electronics';
  if (/\b(chassis|frame)\b/.test(words)) return 'Chassis';
  return 'Other';
}
const sourceOf = (line: BomLine): ControlPointCadPart['source'] =>
  line.disposition === 'print' ? 'printed' : line.vendor?.vendorId === 'gobilda' && ['buy', 'hardware'].includes(line.disposition) ? 'gobilda' : ['buy', 'hardware'].includes(line.disposition) ? 'purchased' : 'other';
function cadPart(line: BomLine, extra: ControlPointLine): ControlPointCadPart & { extra: ControlPointLine } {
  const notes = [
    extra.sku ? `${extra.vendor} ${extra.sku}` : null, extra.vendorUrl, extra.packsToOrder !== null ? `${extra.packsToOrder} pack${extra.packsToOrder === 1 ? '' : 's'} of ${extra.unitsPerPack}` : null,
    extra.orderedWith ? 'ordered with another line of the same SKU' : null, `Control Kit: ${extra.disposition}, match ${extra.matchStatus}`, extra.partStudioUrl,
  ].filter(Boolean).join(' · ');
  // unit_cost is what one CAD unit costs only when packs are known; a pack price is never passed off as a unit price.
  const unit = extra.lineTotalUsd !== null && extra.qty > 0 ? Math.round(extra.lineTotalUsd / extra.qty * 10000) / 10000 : 0;
  return { name: line.name, section: sectionOf(line), quantity: line.qty, source: sourceOf(line), unit_cost: unit, status: 'to_order', notes, extra };
}

/** The workbook and the STEP zip are always expected: one the caller did not supply or explain is listed as missing. */
function expectedFiles(files: Array<{ name: string }>, explained: Array<{ name: string; reason: string }>) {
  const missing = [...explained];
  for (const [label, pattern] of [['BOM workbook (.xlsx)', /\.xlsx$/i], ['STEP files (.zip)', /\.zip$/i]] as const) {
    if (!files.some(item => pattern.test(item.name)) && !explained.some(item => pattern.test(item.name) || item.name === label)) missing.push({ name: label, reason: 'Not supplied when this bundle was built.' });
  }
  return missing;
}

async function file(name: string, mediaType: string, bytes: Uint8Array): Promise<ControlPointFile> {
  const base = { name, mediaType, sizeBytes: bytes.byteLength, sha256: await sha256(bytes) };
  return bytes.byteLength <= INLINE_FILE_LIMIT_BYTES ? { ...base, delivery: 'inline', contentBase64: base64(bytes) }
    : { ...base, delivery: 'reference', reason: `Larger than ${INLINE_FILE_LIMIT_BYTES / 1024 / 1024} MB, so it is uploaded separately once the file-upload contract is confirmed.` };
}

/**
 * Stable for identical BOM data across rescans: the key is document, element, revision, and a hash of the scan's
 * content (lines, suppressed and missing-metadata lines, totals). Timestamps, scan ids, and file bytes are left out.
 */
export async function buildControlPointPayload(result: ScanResult, options: { context?: AssemblyContext; files?: Array<{ name: string; mediaType: string; bytes: Uint8Array }>; filesNotIncluded?: Array<{ name: string; reason: string }> } = {}): Promise<ControlPointBomPayload> {
  const lines = result.lines.map(toLine).sort(byKey);
  const suppressedLines = result.suppressed.map(toLine).sort(byKey);
  const missingMetadataLines = result.missingMetadata.map(toLine).sort(byKey);
  const documentUrl = `https://cad.onshape.com/documents/${encodeURIComponent(result.documentId)}`;
  // A workspace or version link opens from outside Onshape; a microversion link does not, so it falls back to the document.
  const context = options.context;
  const assemblyUrl = context && context.workspaceOrVersion !== 'm' ? `${documentUrl}/${context.workspaceOrVersion}/${encodeURIComponent(context.workspaceOrVersionId)}/e/${encodeURIComponent(result.elementId)}` : documentUrl;
  const assembly = { name: result.assemblyName, documentId: result.documentId, elementId: result.elementId, onshapeUrl: documentUrl, assemblyUrl, documentName: result.documentName ?? null };
  const suppressedCount = result.suppressed.reduce((total, line) => total + line.qty, 0);
  const totals = { uniqueLines: result.stats.uniqueLines, totalInstances: result.stats.totalInstances, totalCostUsd: result.stats.totalCostUsd, outOfStockLines: result.stats.outOfStockLines };
  const revision = result.diagnostics?.revision ?? null;
  const contentHash = await sha256(JSON.stringify({ name: assembly.name, suppressedCount, totals, lines, suppressedLines, missingMetadataLines,
    revisions: result.lines.map(line => [line.bomLineKey, line.sourceType, line.sourceId]).sort(([a], [b]) => String(a).localeCompare(String(b))) }));
  const idempotencyKey = await sha256(`${result.documentId}:${result.elementId}:${revision ? `${revision.type}/${revision.id}` : ''}:${contentHash}`);
  const sorted = [...result.lines].sort((a, b) => a.bomLineKey.localeCompare(b.bomLineKey));
  return {
    idempotencyKey, source: 'control-kit', bundleVersion: 2, assembly, revision, generatedAt: result.scannedAt,
    vendorDataUpdatedAt: result.vendorDataUpdatedAt, staleVendorData: result.stats.staleVendorData,
    lines, suppressedLines, missingMetadataLines, suppressedCount, totals,
    cadParts: sorted.map((line, index) => cadPart(line, lines[index])),
    controlPointCadUrl: CONTROL_POINT_CAD_URL,
    files: await Promise.all((options.files ?? []).map(item => file(item.name, item.mediaType, item.bytes))),
    filesNotIncluded: expectedFiles(options.files ?? [], options.filesNotIncluded ?? []),
  };
}

/** In-memory contract test adapter only. It never performs I/O or contacts Control Point. */
export class MockControlPointAdapter implements ControlPointAdapter {
  readonly payloads: ControlPointBomPayload[] = [];
  private readonly linked = new Set<string>();
  private readonly records = new Map<string, string>();
  async isLinked(userId: string) { return this.linked.has(userId); }
  async linkAccount(userId: string, code: string) {
    if (!userId || !code) throw new Error('A user and mock code are required.');
    this.linked.add(userId);
  }
  async unlinkAccount(userId: string) { this.linked.delete(userId); }
  async syncBom(userId: string, payload: ControlPointBomPayload) {
    if (!this.linked.has(userId)) throw new Error('Mock account is not linked.');
    this.payloads.push(structuredClone(payload));
    const key = `${userId}:${payload.idempotencyKey}`;
    let workspaceRecordId = this.records.get(key);
    if (!workspaceRecordId) { workspaceRecordId = `mock-${this.records.size + 1}`; this.records.set(key, workspaceRecordId); }
    return { workspaceRecordId };
  }
}
