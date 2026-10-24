import type { BomLine, ScanResult } from './index';

/**
 * The subset of Onshape's getBillOfMaterials response (BTBillOfMaterialsInfo, API v9) that Control Kit reads.
 * Requested flattened (`indented=false`) with all columns, so each row is one distinct part/configuration with its
 * BOM properties, keyed by header id.
 */
export type BomHeader = { id: string; name?: string; propertyName?: string; valueType?: string };
export type BomItemSource = { documentId?: string; elementId?: string; partId?: string; wvmType?: string; wvmId?: string; configuration?: string; fullConfiguration?: string; isStandardContent?: boolean; sourceElementMicroversionId?: string };
export type BomRow = { rowId?: string; indentLevel?: number; headerIdToValue?: Record<string, unknown>; itemSource?: BomItemSource; relatedOccurrences?: string[] };
export type BillOfMaterials = { name?: string; headers?: BomHeader[]; rows?: BomRow[]; bomSource?: { document?: { name?: string }; element?: { name?: string; configuration?: string }; documentMicroversion?: { id?: string } } };

/** BOM fields Control Kit uses. A missing field is null, never an empty string. */
export type BomProperties = { name: string | null; partNumber: string | null; description: string | null; vendor: string | null; material: string | null; quantity: number | null;
  /** A team-kept manufacturing/process column, when the BOM template has one. */
  process: string | null };
type Field = keyof BomProperties;
const fieldAliases: Record<Field, string[]> = {
  name: ['name', 'partname'],
  partNumber: ['partnumber', 'partno', 'pn'],
  description: ['description'],
  vendor: ['vendor', 'supplier', 'manufacturer'],
  material: ['material'],
  quantity: ['quantity', 'qty'],
  process: ['process', 'manufacturing', 'manufacturingprocess', 'manufacturingmethod', 'fabrication', 'makebuy', 'makeorbuy'],
};
const compact = (value: string | undefined) => (value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** Maps each field to a header id by property name first, then by the column's display name. */
export function bomColumns(headers: BomHeader[] = []): Partial<Record<Field, string>> {
  const columns: Partial<Record<Field, string>> = {};
  for (const field of Object.keys(fieldAliases) as Field[]) {
    const header = headers.find(item => fieldAliases[field].includes(compact(item.propertyName))) ?? headers.find(item => fieldAliases[field].includes(compact(item.name)));
    if (header?.id) columns[field] = header.id;
  }
  return columns;
}

/** BOM cell values arrive as strings, numbers, or objects such as a material `{ displayName }`; this reads all three. */
export function bomText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value.trim() || null;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return bomText(value[0]);
  if (typeof value === 'object') {
    const object = value as Record<string, unknown>;
    for (const key of ['displayName', 'value', 'name', 'id']) { const found = bomText(object[key]); if (found) return found; }
  }
  return null;
}

export function bomProperties(row: BomRow, columns: Partial<Record<Field, string>>): BomProperties {
  const cell = (field: Field) => (columns[field] ? bomText(row.headerIdToValue?.[columns[field]!]) : null);
  const quantity = Number(cell('quantity'));
  return { name: cell('name'), partNumber: cell('partNumber'), description: cell('description'), vendor: cell('vendor'), material: cell('material'), process: cell('process'), quantity: Number.isFinite(quantity) && cell('quantity') !== null ? quantity : null };
}

/** "default" and an absent configuration name the same thing; the definition and BOM do not always agree on which. */
const normalizedConfiguration = (value: string | null | undefined) => (!value || value === 'default' ? '' : value);
/** Identity shared by assembly-definition lines and BOM rows: source part plus configuration, ignoring revision. */
export const bomIdentity = (value: { documentId?: string | null; elementId?: string | null; partId?: string | null; configuration?: string | null }) =>
  `${value.documentId ?? ''}:${value.elementId ?? ''}:${value.partId ?? ''}:${normalizedConfiguration(value.configuration)}`;

/** A line still without a source revision has no working Onshape link or file export, so it gets a reason. */
export function flagMissingSources(lines: BomLine[]) {
  for (const line of lines) if (!line.metadataIssue && !line.unresolvedSubassembly && (!line.sourceType || !line.sourceId)) line.metadataIssue = { code: 'source-revision-unavailable', httpStatus: null };
}

export type BomReconciliation = { status: 'merged' | 'unavailable'; httpStatus: number | null; rows: number; matchedLines: number; linesWithoutRow: number; rowsWithoutLine: number; quantityMismatches: number;
  /** Header ids and property names of the BOM, plus value types per column: enough to check field mapping on a live scan, without any part data. */
  columns: Array<{ id: string; propertyName: string | null; name: string | null; sampleType: string | null }> };

/**
 * Adds BOM properties to active and suppressed lines. A line without a BOM row keeps its definition data and is
 * flagged; BOM rows without a line are counted (they usually belong to excluded or non-geometric items).
 * The BOM's source revision fills a line's missing source so its Onshape link opens the exact linked part.
 */
export function mergeBom(result: ScanResult, bom: BillOfMaterials): BomReconciliation {
  const columns = bomColumns(bom.headers);
  const rows = (bom.rows ?? []).filter(row => row.itemSource?.partId);
  const byIdentity = new Map<string, BomRow>();
  const byPart = new Map<string, BomRow[]>();
  for (const row of rows) {
    const source = row.itemSource!;
    byIdentity.set(bomIdentity({ ...source, configuration: source.fullConfiguration ?? source.configuration ?? null }), row);
    // Some rows carry only the short configuration; index both forms so either definition form finds the row.
    if (source.configuration && source.configuration !== source.fullConfiguration) byIdentity.set(bomIdentity(source), row);
    const part = bomIdentity({ ...source, configuration: null });
    byPart.set(part, [...(byPart.get(part) ?? []), row]);
  }
  // A part's single BOM row stands in only when one side gives no configuration. Two explicit, different
  // configurations are different parts (an active len=10 must not lend its data to a suppressed len=20).
  const find = (line: BomLine) => {
    const exact = byIdentity.get(bomIdentity(line));
    if (exact) return exact;
    const candidates = byPart.get(bomIdentity({ ...line, configuration: null })) ?? [];
    if (candidates.length !== 1) return undefined;
    const source = candidates[0].itemSource!;
    const rowConfiguration = source.fullConfiguration ?? source.configuration ?? null;
    return bomIdentity({ configuration: line.configuration }) === bomIdentity({}) || bomIdentity({ configuration: rowConfiguration }) === bomIdentity({}) ? candidates[0] : undefined;
  };
  const used = new Set<BomRow>();
  let matchedLines = 0; let linesWithoutRow = 0; let quantityMismatches = 0;
  for (const line of [...result.lines, ...result.suppressed]) {
    if (line.unresolvedSubassembly || !line.partId) continue;
    const row = find(line);
    if (!row) {
      // Onshape's BOM leaves suppressed instances out by design, so only active lines count as missing.
      if (!line.suppressed) { linesWithoutRow++; if (!line.metadataIssue) line.metadataIssue = { code: 'not-in-bom', httpStatus: null }; }
      continue;
    }
    used.add(row);
    matchedLines++;
    const properties = bomProperties(row, columns);
    line.bomProperties = properties;
    if (properties.name) line.name = properties.name;
    line.partNumber = line.partNumber ?? properties.partNumber;
    line.description = line.description ?? properties.description;
    line.material = line.material ?? properties.material;
    line.isStandardContent = row.itemSource?.isStandardContent ?? line.isStandardContent ?? false;
    const source = row.itemSource!;
    if ((!line.sourceType || !line.sourceId) && source.wvmType && source.wvmId && ['w', 'v', 'm'].includes(source.wvmType)) {
      line.sourceType = source.wvmType as BomLine['sourceType'];
      line.sourceId = source.wvmId;
      line.partStudioUrl = `https://cad.onshape.com/documents/${encodeURIComponent(line.documentId)}/${line.sourceType}/${encodeURIComponent(line.sourceId!)}/e/${encodeURIComponent(line.elementId)}`;
      if (line.metadataIssue?.code === 'source-revision-unavailable') line.metadataIssue = null;
    }
    // Onshape's BOM excludes suppressed instances, so only active lines are compared with its quantity.
    if (!line.suppressed && properties.quantity !== null && properties.quantity !== line.qty) quantityMismatches++;
  }
  const sampleType = (id: string) => {
    const value = rows.map(row => row.headerIdToValue?.[id]).find(item => item !== null && item !== undefined);
    return value === undefined ? null : Array.isArray(value) ? 'array' : typeof value;
  };
  return { status: 'merged', httpStatus: null, rows: rows.length, matchedLines, linesWithoutRow, rowsWithoutLine: rows.filter(row => !used.has(row)).length, quantityMismatches,
    columns: (bom.headers ?? []).map(header => ({ id: header.id, propertyName: header.propertyName ?? null, name: header.name ?? null, sampleType: sampleType(header.id) })) };
}
