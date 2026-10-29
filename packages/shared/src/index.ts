export const productName = 'Control Kit';
export { classifyMatchScore, configurationValues, findBestMatch, findLibraryMapping, libraryMapKey, nameCoverage, nameSimilarity, vendorTag, normalizeName, normalizeSku, rankVendorAlternatives, skuCandidates } from './matching';
export { applyClassificationChoice, classificationIdentity, classifyLine, classifyScan, decideDisposition, dispositionLabel, dispositions, parseOverride, printCategory, purchasedAssemblyReason } from './classifier';
import { purchasedAssemblyReason } from './classifier';
export type { ClassificationOverride, ClassificationOverrides, Confidence, Disposition, DispositionSource, Provenance, UserSettings } from './classifier';
export type { Attribution, LibraryMapping, LicensedImage, VendorId, VendorRecord, MatchResult } from './matching';
export { buildControlPointPayload, controlPointIdempotencyKey, CONTROL_POINT_CAD_URL, ControlPointError, INLINE_FILE_LIMIT_BYTES, MockControlPointAdapter } from './control-point';
export { recalculatePurchasing, updatePurchasing } from './purchasing';
export { isBundle, knownProduct, successorOf, withKnownPack } from './known-products';
export { AI_REVIEW_MAX_LINES, AI_REVIEW_VERSION, aiCandidateRecord, aiDispositions, aiReviewHash, aiReviewInstructions, aiReviewSchema, applyAiReview, buildAiReviewRequest, lineCandidates, needsAiReview, parseAiReview } from './ai-review';
export type { AiCandidate, AiDisposition, AiProvider, AiReviewItem, AiReviewLine, AiReviewRequest, AiSuggestion } from './ai-review';
import { recalculatePurchasing } from './purchasing';
export { batchKey, catalogReadKey, catalogVendors, clearCatalogMemoryCache, indexKey, matchCatalog, pointerKey } from './catalog-read';
export type { MatchProgress } from './catalog-read';
export type { CatalogReader, IndexEntry } from './catalog-read';
export type { ControlPointAccount, ControlPointAdapter, ControlPointBomPayload, ControlPointCadExtra, ControlPointCadPart, ControlPointCandidate, ControlPointChoiceTimes, ControlPointDecision, ControlPointFile, ControlPointImport, ControlPointImportSummary, ControlPointLine, ControlPointWorkspace } from './control-point';
export { checkStep, exportManifest, stepDispositions, stepFileName, wantsDxf, wantsStep } from './step';
export type { DxfPart, ExportPart, StepCheck } from './step';
export { cutsFromSheet, maxCutThicknessMm, statedThicknessMm, thicknessRule, tooThickText } from './thickness';
export { drawFlatPart, dxfFileName, flatFaceDxf, needsTessellatedEdges, pickFlatFace, tessellatedPoints, withDrawnDxf } from './dxf';
export type { BodyDetails, DxfResult, FlatFace, TessellatedEdges } from './dxf';
export { bomColumns, bomIdentity, bomProperties, bomText, flagMissingSources, mergeBom } from './bom';
export type { BillOfMaterials, BomHeader, BomItemSource, BomProperties, BomReconciliation, BomRow } from './bom';
import type { Attribution, LicensedImage, VendorRecord } from './matching';
import type { BomProperties, BomReconciliation } from './bom';
import type { Confidence, Disposition, DispositionSource, Provenance } from './classifier';
import type { AiSuggestion } from './ai-review';

export type AssemblyContext = { documentId: string; workspaceOrVersion: 'w' | 'v' | 'm'; workspaceOrVersionId: string; elementId: string };
export type AssemblyInstance = { id: string; name: string; type?: string; documentId: string; elementId: string; partId?: string; partNumber?: string; configuration?: string; fullConfiguration?: string; documentMicroversion?: string; documentVersion?: string; versionId?: string; workspaceId?: string; suppressed?: boolean; isSuppressed?: boolean; isStandardContent?: boolean;
  /** Onshape marks instances whose linked source cannot be resolved with a non-OK `status` or an `errorStatus`. */
  status?: string; errorStatus?: string };
export type AssemblyDefinition = { rootAssembly: { name?: string; documentMicroversion?: string; instances?: AssemblyInstance[] }; subAssemblies?: Array<{ documentId: string; elementId: string; configuration?: string; documentMicroversion?: string; instances?: AssemblyInstance[] }>; parts?: Array<{ documentId: string; elementId: string; partId: string; name?: string }> };
export type BomLine = { bomLineKey: string; name: string; description: string | null; documentId: string; elementId: string; partId: string | null; partNumber: string | null; configuration: string | null; sourceType: 'w' | 'v' | 'm' | null; sourceId: string | null; qty: number; packsToOrder: number | null; lineTotalUsd: number | null; suppressed: boolean; instancePaths: string[]; massKg: number | null; material: string | null; missingMetadataReason: string | null; metadataIssue?: MetadataIssue | null; vendor: VendorRecord | null; alternatives: VendorRecord[]; matchConfidence: number; matchStatus: 'unmatched' | 'possible' | 'confirmed' | 'exact' | 'rejected'; matchReasons: string[]; classification: 'commercial' | 'printed' | 'unknown'; classificationScore: number; classificationReasons: string[]; manualClassification: Disposition | null; partStudioUrl: string;
  /** How the part will be obtained, what decided it, and why it still needs review. Set by `classifyLine`. */
  disposition: Disposition; dispositionSource: DispositionSource; dispositionConfidence: Confidence; dispositionEvidence: string[]; reviewReason: string | null; suggestedDisposition: Disposition | null; provenance: Provenance; unresolvedSubassembly?: boolean;
  /** Properties from Onshape's BOM for this part, when its row was found. */
  bomProperties?: BomProperties | null; isStandardContent?: boolean;
  /** Workspace or version a file export can read this part from; Onshape's translation endpoint takes no microversion. */
  exportSource?: { type: 'w' | 'v'; id: string } | null;
  /** Set when a subassembly is listed as one bought product instead of its internal parts. */
  purchasedAssembly?: { parts: number; reason: string; includes?: string[]; inside?: string[] } | null;
  /** The exact-SKU products a person picks between when the line names more than one; a saved decision may pick any of them. */
  choices?: VendorRecord[];
  /** The closest catalog records that were not chosen (at most 3), offered to the AI review and to a person. */
  nearMatches?: VendorRecord[];
  /** The optional AI review's proposal for this line; a person accepts or dismisses it. */
  aiSuggestion?: AiSuggestion | null;
  /** Set when a parts library's mapping supplied the SKU, with the library's credit. */
  libraryMatch?: { library: string; attribution: Attribution } | null;
  /** A licensed picture of the product (library or vendor feed). Empty until a source grants permission. */
  thumbnail?: LicensedImage | null;
  /** The person's saved confirm/reject for a possible match on this line, applied when the line is matched. */
  matchDecision?: MatchDecision | null;
  /** On the line that carries an order: the pieces it covers across every line ordering the same SKU, and how many lines. */
  order?: { qty: number; lines: number } | null;
  /** On a line whose SKU is ordered by another line: that line's key. It carries no packs or total of its own. */
  orderedWith?: string | null;
  /** Set when an order's quantity is more than an FTC robot uses of an expensive product; the order is then not priced. */
  priceCheck?: string | null };
/** Why a line lacks data. Codes are stable for UI, export, and diagnostics; the user-facing text lives in `metadataIssueText`. */
export type MetadataIssueCode = 'unresolved-subassembly' | 'unresolved-reference' | 'source-revision-unavailable' | 'not-in-bom' | 'bom-unavailable';
export type MetadataIssue = { code: MetadataIssueCode; httpStatus: number | null };
export const metadataIssueText: Record<MetadataIssueCode, string> = {
  'unresolved-subassembly': 'Subassembly has no resolvable children',
  'source-revision-unavailable': 'Source revision unavailable for linked document',
  'unresolved-reference': 'Linked part could not be resolved in Onshape',
  'not-in-bom': "Not in Onshape's bill of materials, so no part number or BOM properties",
  'bom-unavailable': "Onshape's bill of materials could not be read, so part numbers are missing",
};
/** Counted outbound Onshape requests for one operation, including retries. Never contains URLs or IDs. */
export type OnshapeRequestSummary = { total: number; billable: number; retries: number; byKind: Record<string, number>; byStatus: Record<string, number>; errors: Record<string, number> };
export type MetadataIssueGroup = { code: MetadataIssueCode; httpStatus: number | null; sourceType: BomLine['sourceType']; lines: number; suppressedLines: number };
/**
 * `revision` is the immutable revision that was read (a version, or the workspace's microversion at scan time).
 * `cache` says whether the definition and BOM for that revision came from the Worker's cache.
 */
export type ScanDiagnostics = { onshapeRequests: OnshapeRequestSummary | null; metadataIssues: MetadataIssueGroup[]; bom?: BomReconciliation | null; revision?: { type: 'v' | 'm'; id: string } | null; cache?: 'hit' | 'miss' | 'off' };

/** Groups issues by code, status, and source type so a scan's failure distribution can be read without part names. */
export function summarizeMetadataIssues(lines: BomLine[]): MetadataIssueGroup[] {
  const groups = new Map<string, MetadataIssueGroup>();
  for (const line of lines) {
    if (!line.metadataIssue) continue;
    const key = `${line.metadataIssue.code}:${line.metadataIssue.httpStatus ?? ''}:${line.sourceType ?? ''}`;
    const group = groups.get(key) ?? { code: line.metadataIssue.code, httpStatus: line.metadataIssue.httpStatus, sourceType: line.sourceType, lines: 0, suppressedLines: 0 };
    if (line.suppressed) group.suppressedLines++; else group.lines++;
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => (b.lines + b.suppressedLines) - (a.lines + a.suppressedLines) || a.code.localeCompare(b.code));
}
/**
 * Per-vendor catalog state. `published` means scans can match against it; `building` and `failing` mean no
 * usable catalog exists yet, so an empty Vendor column says nothing about whether a supplier sells the part.
 */
export type VendorHealthState = 'published' | 'building' | 'failing' | 'never-run';
/** `complete` is false while the first crawl is still publishing as it goes; coverage is partial until then. */
export type VendorHealth = { vendorId: VendorRecord['vendorId']; state: VendorHealthState; complete: boolean; recordCount: number; updatedAt: string | null; lastRunAt: string | null; stale: boolean; lastRunFailed: boolean; error: string | null; skipped: Record<string, number>;
  progress: { sitemapsDone: number; sitemapsTotal: number; pagesDoneInSitemap: number; pagesInSitemap: number; recordsCollected: number } | null };
export type CatalogHealth = { checkedAt: string; vendors: VendorHealth[] };
export const catalogUsable = (health: CatalogHealth | undefined, vendorId: VendorRecord['vendorId']) => health?.vendors.find(vendor => vendor.vendorId === vendorId)?.state === 'published';
/**
 * `vendorMatching: 'pending'` marks a Worker scan whose lines still need catalog matching (done in the browser, since
 * matching a large assembly against every catalog exceeds the Worker's CPU limit); `'done'` once matched.
 */
export type ScanResult = { vendorMatching?: 'pending' | 'done'; scanId?: string; diagnostics?: ScanDiagnostics; catalogHealth?: CatalogHealth; documentName?: string; assemblyName: string; documentId: string; elementId: string; scannedAt: string; vendorDataUpdatedAt: string | null; lines: BomLine[]; suppressed: BomLine[]; missingMetadata: BomLine[]; stats: { uniqueLines: number; totalInstances: number; totalCostUsd: number | null; outOfStockLines: number; printedLines: number; staleVendorData: boolean } };
/** `at`: when it was saved (absent on decisions saved before Control Point choices, which count as older than any). */
export type MatchDecision = { status: 'confirmed' | 'rejected'; vendorId: VendorRecord['vendorId']; normalizedSku: string; at?: string };

/** The record a saved decision names on this line: its current match or one of the products it is choosing between. */
export function decisionRecord(line: BomLine, decision: Pick<MatchDecision, 'vendorId' | 'normalizedSku'> | null): VendorRecord | null {
  if (!decision) return null;
  return [line.vendor, ...(line.choices ?? []), ...(line.nearMatches ?? [])].find(record => record && record.vendorId === decision.vendorId && record.normalizedSku === decision.normalizedSku) ?? null;
}

/** Confirms or rejects a possible match. With `pick`, confirms that one of the line's choices instead, also after an earlier pick. */
export function applyMatchDecision(result: ScanResult, key: string, decision: 'confirmed' | 'rejected', pick?: Pick<MatchDecision, 'vendorId' | 'normalizedSku'>): ScanResult {
  const next: ScanResult = { ...result, stats: { ...result.stats }, lines: result.lines.map(line => ({ ...line })) };
  const line = next.lines.find(item => item.bomLineKey === key);
  const picked = line && pick ? decisionRecord(line, pick) : null;
  // A pick that is none of the line's records must not confirm the record that happens to be shown.
  if (pick && !picked) return next;
  // A pick can follow an earlier pick, no match at all, or a rejection (Review offers a rejected part's near matches).
  if (!line || (line.matchStatus !== 'possible' && !(picked && ['confirmed', 'unmatched', 'rejected'].includes(line.matchStatus)))) return next;
  if (picked) line.vendor = picked;
  line.matchStatus = decision;
  if (decision === 'rejected') { line.vendor = null; line.alternatives = []; }
  next.missingMetadata = next.missingMetadata.map(item => next.lines.find(active => active.bomLineKey === item.bomLineKey) ?? item);
  return recalculatePurchasing(next);
}

/** Whether an instance is a subassembly. Onshape omits `type` for an instance it cannot resolve, which is then a part. */
const isAssembly = (instance: Pick<AssemblyInstance, 'type'>) => (instance.type ?? '').toLowerCase() === 'assembly';

/** An instance whose linked source Onshape cannot resolve: any `errorStatus`, or a `status` other than OK. */
export const unresolvedReference = (instance: AssemblyInstance) => Boolean(instance.errorStatus) || (instance.status !== undefined && instance.status.toUpperCase() !== 'OK');

function subassemblyKey(value: Pick<AssemblyInstance, 'documentId' | 'elementId' | 'configuration' | 'documentMicroversion'>) { return `${value.documentId}:${value.elementId}:${value.configuration ?? ''}:${value.documentMicroversion ?? ''}`; }

/** Reused subassemblies contribute once per insertion; suppression propagates to descendants. */
export function aggregateAssembly(definition: AssemblyDefinition, context: AssemblyContext, assemblyName: string): ScanResult {
  const definitions = new Map((definition.subAssemblies ?? []).map(part => [subassemblyKey(part), part]));
  const active = new Map<string, BomLine>();
  const suppressed = new Map<string, BomLine>();
  const partNames = new Map((definition.parts ?? []).map(part => [`${part.documentId}:${part.elementId}:${part.partId}`, part.name]));
  const rootName = assemblyName || definition.rootAssembly.name || 'Assembly';
  function add(instance: AssemblyInstance, path: string[], isSuppressed: boolean, unresolvedSubassembly = false, purchasedAssembly: BomLine['purchasedAssembly'] = null) {
    const configuration = instance.fullConfiguration ?? instance.configuration ?? null;
    const partId = instance.partId ?? null;
    const sourceType = instance.documentMicroversion ? 'm' : instance.versionId ?? instance.documentVersion ? 'v' : instance.workspaceId ? 'w' : instance.documentId === context.documentId ? context.workspaceOrVersion : null;
    const exportSource: BomLine['exportSource'] = instance.documentId === context.documentId && context.workspaceOrVersion !== 'm' ? { type: context.workspaceOrVersion, id: context.workspaceOrVersionId }
      : instance.versionId ?? instance.documentVersion ? { type: 'v', id: (instance.versionId ?? instance.documentVersion)! } : instance.workspaceId ? { type: 'w', id: instance.workspaceId } : null;
    const sourceId = instance.documentMicroversion ?? instance.versionId ?? instance.documentVersion ?? instance.workspaceId ?? (instance.documentId === context.documentId ? context.workspaceOrVersionId : null);
    const key = `${instance.documentId}:${instance.elementId}:${partId ?? ''}:${configuration ?? ''}:${sourceType ?? ''}:${sourceId ?? ''}`;
    const bucket = isSuppressed ? suppressed : active;
    const found = bucket.get(key);
    if (found) { found.qty++; found.instancePaths.push(path.join(' > ')); return found; }
    // Links use the workspace or version a person can open; a microversion link (the exact scanned revision) does not open from outside Onshape.
    // With no openable source, the link opens the document itself.
    const source = exportSource ? `${exportSource.type}/${encodeURIComponent(exportSource.id)}` : '';
    const name = partNames.get(`${instance.documentId}:${instance.elementId}:${partId}`) ?? instance.name.replace(/\s*<\d+>$/, '');
    bucket.set(key, { bomLineKey: key, name, description: null, documentId: instance.documentId, elementId: instance.elementId, partId, partNumber: instance.partNumber ?? null, configuration, sourceType, sourceId, qty: 1, packsToOrder: null, lineTotalUsd: null, suppressed: isSuppressed,
      instancePaths: [path.join(' > ')], massKg: null, material: null, missingMetadataReason: null, vendor: null, alternatives: [], matchConfidence: 0, matchStatus: 'unmatched', matchReasons: [], classification: 'unknown', classificationScore: 0,
      classificationReasons: [], manualClassification: null, disposition: 'review', dispositionSource: 'none', dispositionConfidence: 'low', dispositionEvidence: [], reviewReason: null, suggestedDisposition: null, provenance: 'unknown', unresolvedSubassembly, purchasedAssembly, isStandardContent: instance.isStandardContent ?? false, exportSource,
      metadataIssue: unresolvedSubassembly ? { code: 'unresolved-subassembly', httpStatus: null } : unresolvedReference(instance) ? { code: 'unresolved-reference', httpStatus: null } : null, partStudioUrl: !instance.documentId ? '' : source ? `https://cad.onshape.com/documents/${encodeURIComponent(instance.documentId)}/${source}/e/${encodeURIComponent(instance.elementId)}` : `https://cad.onshape.com/documents/${encodeURIComponent(instance.documentId)}` });
    return bucket.get(key)!;
  }
  /** Part Studios (document:element) whose parts make up a subassembly, nested ones included. */
  function studiosInside(instances: AssemblyInstance[], ancestry: Set<string>, into = new Set<string>()): Set<string> {
    for (const instance of instances) {
      // Configured Part Studios build different products per configuration, so the configuration is part of the source.
      if (!isAssembly(instance)) { into.add(`${instance.documentId}:${instance.elementId}:${instance.fullConfiguration ?? instance.configuration ?? ''}`); continue; }
      const key = subassemblyKey(instance);
      const child = definitions.get(key);
      if (child?.instances && !ancestry.has(key)) studiosInside(child.instances, new Set([...ancestry, key]), into);
    }
    return into;
  }
  /** Where each product listed as one unit sits (its parent path) and which Part Studios its insides come from. */
  const kitsByParent = new Map<string, Array<{ line: BomLine; studios: Set<string> }>>();
  /** Parts inside a subassembly, counting nested subassemblies' parts. */
  function countParts(instances: AssemblyInstance[], ancestry: Set<string>): number {
    return instances.reduce((total, instance) => {
      if (!isAssembly(instance)) return total + 1;
      const key = subassemblyKey(instance);
      const child = definitions.get(key);
      return total + (child?.instances && !ancestry.has(key) ? countParts(child.instances, new Set([...ancestry, key])) : 0);
    }, 0);
  }
  /** Names of the active parts and subassemblies inside a subassembly, nested ones included (at most 50). */
  function namesInside(instances: AssemblyInstance[], ancestry: Set<string>, into = new Set<string>()): Set<string> {
    for (const instance of instances) {
      if (into.size >= 50) break;
      // Suppressed bodies are not part of the product as placed.
      if (instance.suppressed || instance.isSuppressed) continue;
      into.add(partNames.get(`${instance.documentId}:${instance.elementId}:${instance.partId}`) ?? instance.name.replace(/\s*<\d+>$/, ''));
      if (!isAssembly(instance)) continue;
      const key = subassemblyKey(instance);
      const child = definitions.get(key);
      if (child?.instances && !ancestry.has(key)) namesInside(child.instances, new Set([...ancestry, key]), into);
    }
    return into;
  }
  /** True when a subassembly somewhere inside carries a vendor part number in its own name. */
  function containsVendorProduct(instances: AssemblyInstance[], ancestry: Set<string>): boolean {
    return instances.some(instance => {
      if (!isAssembly(instance)) return false;
      if (purchasedAssemblyReason(instance.name.replace(/\s*<\d+>$/, ''), instance.partNumber, false)) return true;
      const key = subassemblyKey(instance);
      const child = definitions.get(key);
      return Boolean(child?.instances && !ancestry.has(key) && containsVendorProduct(child.instances, new Set([...ancestry, key])));
    });
  }
  function walk(instances: AssemblyInstance[], path: string[], inheritedSuppression: boolean, ancestry: Set<string>) {
    for (const instance of instances) {
      const childPath = [...path, instance.name];
      const isSuppressed = inheritedSuppression || Boolean(instance.suppressed || instance.isSuppressed);
      // Onshape sends only an id and a name for an instance whose source it cannot resolve (a linked document that was
      // deleted or is not shared with this person). It is still part of the robot, so it is listed by name, flagged as
      // unresolved; its name can still match a product ("Control Hub (REV)").
      if (!instance.documentId || !instance.elementId) {
        add({ ...instance, type: 'Part', documentId: '', elementId: '', partId: `unresolved:${(instance.name ?? '').replace(/\s*<\d+>$/, '')}`, status: 'UNRESOLVED' }, childPath, isSuppressed);
        continue;
      }
      if (!isAssembly(instance)) { add(instance, childPath, isSuppressed); continue; }
      const key = subassemblyKey(instance);
      const child = definitions.get(key);
      let reason = purchasedAssemblyReason(instance.name.replace(/\s*<\d+>$/, ''), instance.partNumber, instance.documentId !== context.documentId);
      // A wrapper named only like a product ("Motor Smol") steps aside for the SKU-named product inside it, so the SKU survives.
      if (reason && !purchasedAssemblyReason(instance.name.replace(/\s*<\d+>$/, ''), instance.partNumber, false) && child?.instances && containsVendorProduct(child.instances, new Set([...ancestry, key]))) reason = null;
      if (reason) {
        const inside = child?.instances ? [...namesInside(child.instances, new Set([...ancestry, key]))] : [];
        const line = add(instance, childPath, isSuppressed, false, { parts: child?.instances ? countParts(child.instances, new Set([...ancestry, key])) : 0, reason, ...(inside.length ? { inside } : {}) });
        if (child?.instances) {
          const parent = path.join(' > ');
          kitsByParent.set(parent, [...(kitsByParent.get(parent) ?? []), { line, studios: studiosInside(child.instances, new Set([...ancestry, key])) }]);
        }
        continue;
      }
      if (!child || !Array.isArray(child.instances) || ancestry.has(key)) { add(instance, childPath, isSuppressed, true); continue; }
      walk(child.instances, childPath, isSuppressed, new Set([...ancestry, key]));
    }
  }
  walk(definition.rootAssembly.instances ?? [], [rootName], false, new Set());
  // A vendor product imported as a Part Studio often appears as a product subassembly plus a body or two placed beside
  // it straight from the same import (HORS: a goBILDA motor's output shaft next to "5000-0002-0001 Motor"). Such a body
  // is part of that product, not a separate part: it is folded into the product's line when every place it is used
  // sits beside a product built from the same Part Studio.
  for (const [key, line] of active) {
    // Standard content (screws, nuts) is placed beside kits all the time and is never part of one.
    if (line.purchasedAssembly || line.isStandardContent) continue;
    const studio = `${line.documentId}:${line.elementId}:${line.configuration ?? ''}`;
    const kits = line.instancePaths.map(path => (kitsByParent.get(path.split(' > ').slice(0, -1).join(' > ')) ?? []).find(kit => !kit.line.suppressed && kit.studios.has(studio)));
    if (!kits.length || kits.some(kit => !kit)) continue;
    for (const kit of new Set(kits.map(found => found!.line))) {
      const includes = kit.purchasedAssembly!.includes ?? [];
      if (!includes.includes(line.name)) kit.purchasedAssembly = { ...kit.purchasedAssembly!, includes: [...includes, line.name] };
    }
    active.delete(key);
  }
  // An imported vendor model is often one Part Studio whose bodies all carry the product's number (an Expansion Hub
  // imported as 32 bodies, every one named REV-31-1153). Those bodies are one product, listed once per placement and
  // drawn as the whole Part Studio. They fold together only when every body has the same name, that name carries a
  // vendor number, and every body is placed in the same places; anything else stays as separate lines.
  const studioGroups = new Map<string, BomLine[]>();
  for (const line of active.values()) {
    if (line.purchasedAssembly || !line.partId) continue;
    const studio = `${line.documentId}:${line.elementId}:${line.configuration ?? ''}:${line.sourceType ?? ''}:${line.sourceId ?? ''}`;
    studioGroups.set(studio, [...(studioGroups.get(studio) ?? []), line]);
  }
  const placesOf = (line: BomLine) => line.instancePaths.map(path => path.split(' > ').slice(0, -1).join(' > ')).sort().join('\n');
  for (const bodies of studioGroups.values()) {
    if (bodies.length < 2) continue;
    const name = bodies[0].name.trim().toLowerCase();
    if (!bodies.every(body => body.name.trim().toLowerCase() === name) || !purchasedAssemblyReason(bodies[0].name, null, false)) continue;
    if (!bodies.every(body => placesOf(body) === placesOf(bodies[0]))) continue;
    const [product, ...rest] = bodies;
    product.purchasedAssembly = { parts: bodies.length, reason: `its ${bodies.length} bodies in one Part Studio all carry ${bodies[0].name.trim()}` };
    for (const body of rest) active.delete(body.bomLineKey);
  }
  const lines = [...active.values()];
  const suppressedLines = [...suppressed.values()];
  return { assemblyName: rootName, documentId: context.documentId, elementId: context.elementId, scannedAt: new Date().toISOString(), vendorDataUpdatedAt: null, lines, suppressed: suppressedLines, missingMetadata: [],
    stats: { uniqueLines: lines.length, totalInstances: lines.reduce((total, line) => total + line.qty, 0), totalCostUsd: null, outOfStockLines: 0, printedLines: 0, staleVendorData: false } };
}
