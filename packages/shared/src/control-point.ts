import type { AssemblyContext, BomLine, ScanResult } from './index';
import { classificationIdentity, type Disposition } from './classifier';

/**
 * The bundle a reviewed scan attaches to Control Point: every line (active, suppressed, and missing-metadata), scan
 * metadata, the workbook and STEP zip as files, and each line in Control Point's CAD parts shape with every Control
 * Kit field kept beside it. Built from the scan the person already reviewed (their accepted AI suggestions are saved
 * choices by then), with no rescan or rematch. The link contract is docs/control-point-link.md: the Worker holds the
 * token and talks to Control Point through a `ControlPointAdapter` (HTTP in the Worker, in memory for tests).
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
  key: string;
  /** `documentId:elementId:partId:configuration`, stable across revisions: Control Point's `ck_part_key`. */
  identity: string; name: string; qty: number; unitsPerPack: number | null; packsToOrder: number | null; packPriceUsd: number | null; lineTotalUsd: number | null;
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

export type ControlPointAccount = { email: string; name: string };
export type ControlPointWorkspace = { id: number; name: string; ftcNumber: string | null; accentColor: string | null; canEditCad: boolean; cadUrl: string };
/** Control Point's answer to a BOM import (contract §2); `duplicate` means the same key was already imported and nothing changed. */
export type ControlPointImport = {
  importId: number; duplicate: boolean; workspace: { id: number; name: string; ftcNumber: string | null };
  created: number; updated: number; markedRemoved: number; filesStored: number; url: string; sentAt: string;
};
export type ControlPointImportSummary = { importId: number; idempotencyKey: string; sentAt: string; sentBy: string; created: number; updated: number; markedRemoved: number; url: string };
/** A refused Control Point call: HTTP status, Control Point's error code (`revoked`, `not_member`, ...), and any `Retry-After` seconds. */
export class ControlPointError extends Error {
  constructor(readonly status: number, readonly code: string, readonly detail: string | null = null, readonly retryAfter: number | null = null) { super(`Control Point ${status} ${code}`); }
}
/**
 * Control Point's integration API as the Worker uses it (contract §1 step 4 and §2). Every call except the code
 * exchange carries the account's bearer token; a refusal throws `ControlPointError`. `sendBom` takes the body the
 * browser built as-is (the Worker streams it without parsing) and its byte length.
 */
export interface ControlPointAdapter {
  exchangeCode(code: string, redirectUri: string): Promise<{ accessToken: string; account: ControlPointAccount }>;
  workspaces(token: string): Promise<{ account: ControlPointAccount; workspaces: ControlPointWorkspace[] }>;
  sendBom(token: string, workspaceId: number, body: ReadableStream<Uint8Array> | string, length: number): Promise<ControlPointImport>;
  imports(token: string, workspaceId: number, documentId: string, elementId: string): Promise<ControlPointImportSummary[]>;
  revoke(token: string): Promise<void>;
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
    key: line.bomLineKey, identity: classificationIdentity(line), name: line.name, qty: line.qty, unitsPerPack: vendor?.packSizeVerified ? vendor.packSize : null, packsToOrder: line.packsToOrder,
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
 * Stable for identical BOM data across rescans: the key is the Control Point workspace, document, element, revision,
 * and a hash of the scan's content (lines, suppressed and missing-metadata lines, totals), so one scan sent to two
 * workspaces is two imports. Timestamps, scan ids, and file bytes are left out. `workspaceId` is null only for a
 * preview that is never sent.
 */
export async function buildControlPointPayload(result: ScanResult, options: { workspaceId: number | null; context?: AssemblyContext; files?: Array<{ name: string; mediaType: string; bytes: Uint8Array }>; filesNotIncluded?: Array<{ name: string; reason: string }> }): Promise<ControlPointBomPayload> {
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
  const idempotencyKey = await sha256(`${options.workspaceId ?? ''}:${result.documentId}:${result.elementId}:${revision ? `${revision.type}/${revision.id}` : ''}:${contentHash}`);
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

const mockToken = 'ckp_mock';
/**
 * In-memory Control Point for tests: one account with the given workspaces, imports kept per workspace by
 * idempotency key (a repeat answers `duplicate: true` and changes nothing), and a token that `revoke` ends.
 */
export class MockControlPointAdapter implements ControlPointAdapter {
  readonly payloads: Array<{ workspaceId: number; payload: ControlPointBomPayload }> = [];
  private revoked = false;
  private readonly imported = new Map<string, ControlPointImport & { documentId: string; elementId: string; idempotencyKey: string }>();
  constructor(readonly account: ControlPointAccount = { email: 'student@example.org', name: 'Student' }, readonly list: ControlPointWorkspace[] = [
    { id: 12, name: 'HORS', ftcNumber: '6980', accentColor: null, canEditCad: true, cadUrl: CONTROL_POINT_CAD_URL },
  ]) {}
  private check(token: string) { if (this.revoked || token !== mockToken) throw new ControlPointError(401, 'revoked'); }
  async exchangeCode(code: string) {
    if (!code) throw new ControlPointError(400, 'invalid_grant');
    this.revoked = false;
    return { accessToken: mockToken, account: this.account };
  }
  async workspaces(token: string) { this.check(token); return { account: this.account, workspaces: structuredClone(this.list) }; }
  async sendBom(token: string, workspaceId: number, body: ReadableStream<Uint8Array> | string) {
    this.check(token);
    const workspace = this.list.find(item => item.id === workspaceId);
    if (!workspace) throw new ControlPointError(403, 'not_member');
    if (!workspace.canEditCad) throw new ControlPointError(403, 'no_cad_edit');
    const payload = JSON.parse(typeof body === 'string' ? body : await new Response(body).text()) as ControlPointBomPayload;
    if (payload.source !== 'control-kit' || payload.bundleVersion !== 2 || !Array.isArray(payload.cadParts)) throw new ControlPointError(400, 'bad_payload');
    const key = `${workspaceId}:${payload.idempotencyKey}`;
    const earlier = this.imported.get(key);
    if (earlier) return { ...earlier, duplicate: true };
    this.payloads.push({ workspaceId, payload: structuredClone(payload) });
    const importId = this.imported.size + 1;
    const result: ControlPointImport = { importId, duplicate: false, workspace: { id: workspace.id, name: workspace.name, ftcNumber: workspace.ftcNumber },
      created: payload.cadParts.length, updated: 0, markedRemoved: 0, filesStored: payload.files.filter(item => item.delivery === 'inline').length,
      url: `${CONTROL_POINT_CAD_URL}?import=${importId}`, sentAt: new Date().toISOString() };
    this.imported.set(key, { ...result, documentId: payload.assembly.documentId, elementId: payload.assembly.elementId, idempotencyKey: payload.idempotencyKey });
    return result;
  }
  async imports(token: string, workspaceId: number, documentId: string, elementId: string) {
    this.check(token);
    return [...this.imported.values()].filter(item => item.workspace.id === workspaceId && item.documentId === documentId && item.elementId === elementId).reverse().slice(0, 10)
      .map(item => ({ importId: item.importId, idempotencyKey: item.idempotencyKey, sentAt: item.sentAt, sentBy: this.account.email, created: item.created, updated: item.updated, markedRemoved: item.markedRemoved, url: item.url }));
  }
  async revoke(token: string) { this.check(token); this.revoked = true; }
}
