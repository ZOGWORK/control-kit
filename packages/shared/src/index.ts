export const productName = 'Control Kit';
export { classifyMatchScore, findBestMatch, nameSimilarity, normalizeName, normalizeSku, rankVendorAlternatives, skuCandidates } from './matching';
export { applyClassificationChoice, classificationForScore, classificationIdentity, classifyLine, classifyScan, printCategory } from './classifier';
export type { ClassificationOverride, ClassificationOverrides, UserSettings } from './classifier';
export type { VendorId, VendorRecord, MatchResult } from './matching';
export { buildControlPointPayload, MockControlPointAdapter } from './control-point';
export type { ControlPointAdapter, ControlPointBomPayload } from './control-point';
export { bomColumns, bomIdentity, bomProperties, bomText, flagMissingSources, mergeBom } from './bom';
export type { BillOfMaterials, BomHeader, BomItemSource, BomProperties, BomReconciliation, BomRow } from './bom';
import type { VendorRecord } from './matching';
import type { BomProperties, BomReconciliation } from './bom';

export type AssemblyContext = { documentId: string; workspaceOrVersion: 'w' | 'v' | 'm'; workspaceOrVersionId: string; elementId: string };
export type AssemblyInstance = { id: string; name: string; type: string; documentId: string; elementId: string; partId?: string; partNumber?: string; configuration?: string; fullConfiguration?: string; documentMicroversion?: string; documentVersion?: string; versionId?: string; workspaceId?: string; suppressed?: boolean; isSuppressed?: boolean; isStandardContent?: boolean;
  /** Onshape marks instances whose linked source cannot be resolved with a non-OK `status` or an `errorStatus`. */
  status?: string; errorStatus?: string };
export type AssemblyDefinition = { rootAssembly: { name?: string; documentMicroversion?: string; instances?: AssemblyInstance[] }; subAssemblies?: Array<{ documentId: string; elementId: string; configuration?: string; documentMicroversion?: string; instances?: AssemblyInstance[] }>; parts?: Array<{ documentId: string; elementId: string; partId: string; name?: string }> };
export type BomLine = { bomLineKey: string; name: string; description: string | null; documentId: string; elementId: string; partId: string | null; partNumber: string | null; configuration: string | null; sourceType: 'w' | 'v' | 'm' | null; sourceId: string | null; qty: number; packsToOrder: number | null; lineTotalUsd: number | null; suppressed: boolean; instancePaths: string[]; massKg: number | null; material: string | null; missingMetadataReason: string | null; metadataIssue?: MetadataIssue | null; vendor: VendorRecord | null; alternatives: VendorRecord[]; matchConfidence: number; matchStatus: 'unmatched' | 'possible' | 'confirmed' | 'exact' | 'rejected'; matchReasons: string[]; classification: 'commercial' | 'printed' | 'unknown'; classificationScore: number; classificationReasons: string[]; manualClassification: 'commercial' | 'printed' | null; partStudioUrl: string; unresolvedSubassembly?: boolean;
  /** Properties from Onshape's BOM for this part, when its row was found. */
  bomProperties?: BomProperties | null; isStandardContent?: boolean };
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
export type ScanResult = { scanId?: string; diagnostics?: ScanDiagnostics; catalogHealth?: CatalogHealth; documentName?: string; assemblyName: string; documentId: string; elementId: string; scannedAt: string; vendorDataUpdatedAt: string | null; lines: BomLine[]; suppressed: BomLine[]; missingMetadata: BomLine[]; stats: { uniqueLines: number; totalInstances: number; totalCostUsd: number | null; outOfStockLines: number; printedLines: number; staleVendorData: boolean } };
export type MatchDecision = { status: 'confirmed' | 'rejected'; vendorId: VendorRecord['vendorId']; normalizedSku: string };

export function updatePurchasing(line: BomLine): BomLine {
  const record = line.vendor;
  if (!record || !['exact', 'confirmed'].includes(line.matchStatus) || !record.packSizeVerified || !Number.isInteger(record.packSize) || record.packSize! < 1 || record.priceUsd === null) {
    line.packsToOrder = null; line.lineTotalUsd = null; return line;
  }
  line.packsToOrder = Math.ceil(line.qty / record.packSize!);
  line.lineTotalUsd = Math.round(line.packsToOrder * record.priceUsd * 100) / 100;
  return line;
}

export function recalculatePurchasing(result: ScanResult): ScanResult {
  const priced = result.lines.map(line => updatePurchasing(line).lineTotalUsd).filter((price): price is number => price !== null);
  result.stats.totalCostUsd = priced.length ? Math.round(priced.reduce((total, price) => total + price, 0) * 100) / 100 : null;
  result.stats.outOfStockLines = result.lines.filter(line => line.vendor?.stock === 'out' && !['possible', 'rejected'].includes(line.matchStatus)).length;
  return result;
}

export function applyMatchDecision(result: ScanResult, key: string, decision: 'confirmed' | 'rejected'): ScanResult {
  const next: ScanResult = { ...result, stats: { ...result.stats }, lines: result.lines.map(line => ({ ...line })) };
  const line = next.lines.find(item => item.bomLineKey === key);
  if (!line || line.matchStatus !== 'possible') return next;
  line.matchStatus = decision;
  if (decision === 'rejected') { line.vendor = null; line.alternatives = []; }
  next.missingMetadata = next.missingMetadata.map(item => next.lines.find(active => active.bomLineKey === item.bomLineKey) ?? item);
  return recalculatePurchasing(next);
}

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
  function add(instance: AssemblyInstance, path: string[], isSuppressed: boolean, unresolvedSubassembly = false) {
    const configuration = instance.fullConfiguration ?? instance.configuration ?? null;
    const partId = instance.partId ?? null;
    const sourceType = instance.documentMicroversion ? 'm' : instance.versionId ?? instance.documentVersion ? 'v' : instance.workspaceId ? 'w' : instance.documentId === context.documentId ? context.workspaceOrVersion : null;
    const sourceId = instance.documentMicroversion ?? instance.versionId ?? instance.documentVersion ?? instance.workspaceId ?? (instance.documentId === context.documentId ? context.workspaceOrVersionId : null);
    const key = `${instance.documentId}:${instance.elementId}:${partId ?? ''}:${configuration ?? ''}:${sourceType ?? ''}:${sourceId ?? ''}`;
    const bucket = isSuppressed ? suppressed : active;
    const found = bucket.get(key);
    if (found) { found.qty++; found.instancePaths.push(path.join(' > ')); return; }
    const source = sourceType && sourceId ? `${sourceType}/${encodeURIComponent(sourceId)}` : '';
    const name = partNames.get(`${instance.documentId}:${instance.elementId}:${partId}`) ?? instance.name.replace(/\s*<\d+>$/, '');
    bucket.set(key, { bomLineKey: key, name, description: null, documentId: instance.documentId, elementId: instance.elementId, partId, partNumber: instance.partNumber ?? null, configuration, sourceType, sourceId, qty: 1, packsToOrder: null, lineTotalUsd: null, suppressed: isSuppressed,
      instancePaths: [path.join(' > ')], massKg: null, material: null, missingMetadataReason: null, vendor: null, alternatives: [], matchConfidence: 0, matchStatus: 'unmatched', matchReasons: [], classification: 'unknown', classificationScore: 0,
      classificationReasons: [], manualClassification: null, unresolvedSubassembly, isStandardContent: instance.isStandardContent ?? false,
      metadataIssue: unresolvedSubassembly ? { code: 'unresolved-subassembly', httpStatus: null } : unresolvedReference(instance) ? { code: 'unresolved-reference', httpStatus: null } : null, partStudioUrl: source ? `https://cad.onshape.com/documents/${encodeURIComponent(instance.documentId)}/${source}/e/${encodeURIComponent(instance.elementId)}` : `https://cad.onshape.com/documents/${encodeURIComponent(instance.documentId)}` });
  }
  function walk(instances: AssemblyInstance[], path: string[], inheritedSuppression: boolean, ancestry: Set<string>) {
    for (const instance of instances) {
      const childPath = [...path, instance.name];
      const isSuppressed = inheritedSuppression || Boolean(instance.suppressed || instance.isSuppressed);
      if (instance.type.toLowerCase() !== 'assembly') { add(instance, childPath, isSuppressed); continue; }
      const key = subassemblyKey(instance);
      const child = definitions.get(key);
      if (!child || !Array.isArray(child.instances) || ancestry.has(key)) { add(instance, childPath, isSuppressed, true); continue; }
      walk(child.instances, childPath, isSuppressed, new Set([...ancestry, key]));
    }
  }
  walk(definition.rootAssembly.instances ?? [], [rootName], false, new Set());
  const lines = [...active.values()];
  const suppressedLines = [...suppressed.values()];
  return { assemblyName: rootName, documentId: context.documentId, elementId: context.elementId, scannedAt: new Date().toISOString(), vendorDataUpdatedAt: null, lines, suppressed: suppressedLines, missingMetadata: [],
    stats: { uniqueLines: lines.length, totalInstances: lines.reduce((total, line) => total + line.qty, 0), totalCostUsd: null, outOfStockLines: 0, printedLines: 0, staleVendorData: false } };
}
