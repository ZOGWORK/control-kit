import { strToU8, zipSync } from 'fflate';
import { printCategory, type BomLine, type ScanResult, type VendorRecord } from '../../shared/src/index';

type Cell = { col: number; type: 's' | 'n' | 'f'; value: string | number; style: number; cached?: number };
type Sheet = { name: string; rows: Map<number, Cell[]>; widths: number[]; merges: string[]; links: { cell: string; url: string }[]; filter?: string; frozen?: number; landscape?: boolean };
export type ExcelExport = { bytes: Uint8Array; filename: string };
export type CsvExport = { bytes: Uint8Array; filename: string };
const HEADERS = ['#', 'Part Name', 'Qty Needed', 'Packs to Order', 'Vendor', 'SKU / Part #', 'Pack Price', 'Line Total', 'Stock', 'Stock Qty', 'Type', 'Alternatives (in-stock)', 'Notes'];
const esc = (value: string | number) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
const col = (index: number) => { let out = ''; for (let n = index; n; n = Math.floor((n - 1) / 26)) out = String.fromCharCode(65 + (n - 1) % 26) + out; return out; };
const cellRef = (column: number, row: number) => `${col(column)}${row}`;
const sheet = (name: string, columns: number): Sheet => ({ name, rows: new Map(), widths: Array(columns).fill(10), merges: [], links: [] });
function safeUrl(value?: string) { try { const url = new URL(value ?? ''); return url.protocol === 'https:' && !url.username && !url.password ? url.toString() : undefined; } catch { return undefined; } }
function put(target: Sheet, row: number, column: number, value: string | number, style = 0, type: Cell['type'] = typeof value === 'number' ? 'n' : 's', link?: string, cached?: number) {
  const cells = target.rows.get(row) ?? [];
  cells.push({ col: column, type, value, style, ...(cached === undefined ? {} : { cached }) });
  target.rows.set(row, cells);
  const url = safeUrl(link);
  if (url) target.links.push({ cell: cellRef(column, row), url });
  const width = String(value).split('\n').reduce((longest, part) => Math.max(longest, part.length), 0) + 2;
  target.widths[column - 1] = Math.max(target.widths[column - 1] ?? 10, Math.min(42, width));
}
function renderSheet(target: Sheet) {
  const last = Math.max(1, ...target.rows.keys());
  const rows = [...target.rows.entries()].sort(([a], [b]) => a - b).map(([number, cells]) => `<row r="${number}">${cells.sort((a, b) => a.col - b.col).map(value => {
    const address = cellRef(value.col, number);
    if (value.type === 'f') return `<c r="${address}" s="${value.style}"><f>${esc(value.value)}</f>${value.cached === undefined ? '' : `<v>${value.cached}</v>`}</c>`;
    if (value.type === 'n') return `<c r="${address}" s="${value.style}"><v>${value.value}</v></c>`;
    return `<c r="${address}" s="${value.style}" t="inlineStr"><is><t xml:space="preserve">${esc(value.value)}</t></is></c>`;
  }).join('')}</row>`).join('');
  const widths = target.widths.map((width, index) => `<col min="${index + 1}" max="${index + 1}" width="${index === 11 ? 38 : Math.max(index === 1 ? 22 : 10, Math.min(42, width))}" customWidth="1"/>`).join('');
  const freeze = target.frozen ? `<sheetViews><sheetView workbookViewId="0"><pane ySplit="${target.frozen}" topLeftCell="A${target.frozen + 1}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>` : '<sheetViews><sheetView workbookViewId="0"/></sheetViews>';
  const merges = target.merges.length ? `<mergeCells count="${target.merges.length}">${target.merges.map(range => `<mergeCell ref="${range}"/>`).join('')}</mergeCells>` : '';
  const links = target.links.length ? `<hyperlinks>${target.links.map((link, index) => `<hyperlink ref="${link.cell}" r:id="rId${index + 1}"/>`).join('')}</hyperlinks>` : '';
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${target.landscape ? '<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>' : ''}<dimension ref="A1:${cellRef(target.widths.length, last)}"/>${freeze}<sheetFormatPr defaultRowHeight="16"/><cols>${widths}</cols><sheetData>${rows}</sheetData>${target.filter ? `<autoFilter ref="${target.filter}"/>` : ''}${merges}${links}<printOptions/><pageMargins left="0.3" right="0.3" top="0.5" bottom="0.5" header="0.2" footer="0.2"/>${target.landscape ? '<pageSetup orientation="landscape" fitToWidth="1" fitToHeight="0"/>' : ''}</worksheet>`;
}
const fill = (hex: string) => `<fill><patternFill patternType="solid"><fgColor rgb="FF${hex}"/><bgColor indexed="64"/></patternFill></fill>`;
const font = (size: number, color: string, bold = false, underline = false) => `<font>${bold ? '<b/>' : ''}${underline ? '<u/>' : ''}<sz val="${size}"/><name val="Calibri"/><color rgb="FF${color}"/></font>`;
const xf = (fontId: number, fillId: number, currency = false, wrap = false) => `<xf numFmtId="${currency ? 164 : 0}" fontId="${fontId}" fillId="${fillId}" borderId="0" xfId="0" applyFont="1" applyFill="1"${currency ? ' applyNumberFormat="1"' : ''}${wrap ? ' applyAlignment="1"><alignment wrapText="1"/></xf>' : '/>'}`;
// Style IDs: 0/1/2 body white/gray/lavender; 3/4/5 bold; 6 header; 7 title; 8 summary navy;
// 9–13 stock colors; 14–16 currency; 17–19 hyperlinks; 20–22 summary; 23 suppressed; 24 subheader.
const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="$#,##0.00"/></numFmts><fonts count="7">${font(11, '202326')}${font(11, '202326', true)}${font(11, 'FFFFFF', true)}${font(16, 'FFFFFF', true)}${font(11, 'FFFFFF')}${font(11, '175CD3', false, true)}${font(11, '6B7280')}</fonts><fills count="11"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>${['FFFFFF', 'F2F4F7', '13294B', '1F7A3A', 'C0392B', 'F2B705', '6B7280', '6D28D9', 'F3EFFF'].map(fill).join('')}</fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="25">${[
  xf(0, 2), xf(0, 3), xf(0, 10), xf(1, 2), xf(1, 3), xf(1, 10), xf(2, 4), xf(3, 4), xf(2, 4),
  xf(4, 5), xf(4, 6), xf(0, 7), xf(4, 8), xf(4, 9), xf(0, 2, true), xf(0, 3, true), xf(0, 10, true),
  xf(5, 2, false, true), xf(5, 3, false, true), xf(5, 10, false, true), xf(1, 2), xf(0, 2), xf(1, 2, true), xf(6, 3), xf(2, 4),
].join('')}</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;
function rels(target: Sheet) { return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${target.links.map((link, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${esc(link.url)}" TargetMode="External"/>`).join('')}</Relationships>`; }

const typeLabel = (line: BomLine) => line.classification === 'printed' ? '3D Printed' : line.classification === 'unknown' ? 'Unknown — verify' : 'Commercial';
function stockLabel(line: BomLine): { value: string; style: number } {
  if (line.classification === 'printed') return { value: 'Print', style: 13 };
  if (line.vendor?.stock === 'in') return { value: 'In Stock', style: 9 };
  if (line.vendor?.stock === 'out') return { value: 'Out of Stock', style: 10 };
  if (line.vendor?.stock === 'low') return { value: 'Low Stock', style: 11 };
  return { value: 'Unknown', style: 12 };
}
function notes(line: BomLine, result: ScanResult) {
  const values: string[] = [];
  if (line.matchStatus === 'possible') values.push('Possible match — unconfirmed; excluded from totals');
  if (result.stats.staleVendorData && line.vendor) values.push('Vendor data may be stale');
  if (line.manualClassification) values.push('Type set manually');
  if (line.missingMetadataReason) values.push(line.missingMetadataReason);
  return values.join('; ');
}
function alternatives(line: BomLine): VendorRecord[] {
  if (!line.vendor || !['out', 'low'].includes(line.vendor.stock)) return [];
  return (line.alternatives ?? []).filter(item => item.vendorId === line.vendor?.vendorId && item.category.toLowerCase() === line.vendor?.category.toLowerCase()
    && item.stock === 'in' && item.priceUsd !== null).slice(0, 3);
}
function bom(result: ScanResult, now: Date): Sheet {
  const target = sheet('BOM', 13);
  const documentUrl = `https://cad.onshape.com/documents/${encodeURIComponent(result.documentId)}`;
  for (const row of [1, 2, 3]) for (let c = 1; c <= 13; c++) put(target, row, c, '', row === 1 ? 7 : 8);
  target.rows.get(1)![0].value = 'Control Kit — Bill of Materials';
  target.rows.get(2)![0].value = `Assembly: ${result.assemblyName} · Open in Onshape`;
  target.links.push({ cell: 'A2', url: documentUrl });
  const vendorDates = result.lines.map(line => line.vendor?.updatedAt).filter((value): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value)));
  target.rows.get(3)![0].value = `Generated: ${now.toLocaleString()} · Vendor data as of: ${result.vendorDataUpdatedAt ?? vendorDates.sort()[0] ?? 'Unknown'}${result.stats.staleVendorData ? ' — STALE' : ''}`;
  target.merges.push('A1:M1', 'A2:M2', 'A3:M3', 'A5:M5');
  put(target, 4, 1, 'Unique parts', 20); put(target, 4, 2, result.stats.uniqueLines, 21);
  put(target, 4, 3, 'Total instances', 20); put(target, 4, 4, result.stats.totalInstances, 21);
  put(target, 4, 5, 'Estimated total', 20);
  put(target, 4, 7, 'Out of stock', 20); put(target, 4, 8, result.stats.outOfStockLines, 21);
  put(target, 4, 9, '3D printed lines', 20); put(target, 4, 10, result.stats.printedLines, 21);
  put(target, 5, 1, '', 0);
  HEADERS.forEach((value, index) => put(target, 6, index + 1, value, 6));
  const commercial = result.lines.filter(line => line.classification !== 'printed').sort((a, b) => (a.vendor?.vendorId ?? 'zz').localeCompare(b.vendor?.vendorId ?? 'zz') || a.name.localeCompare(b.name));
  const printed = result.lines.filter(line => line.classification === 'printed').sort((a, b) => a.name.localeCompare(b.name));
  let row = 7; let ordinal = 1; let total = 0;
  const alternativeRows: Array<{ source: string; choice: VendorRecord }> = [];
  const write = (line: BomLine, isPrinted: boolean) => {
    const band = isPrinted ? row % 2 ? 2 : 0 : row % 2 ? 0 : 1;
    const bold = isPrinted ? row % 2 ? 5 : 3 : row % 2 ? 3 : 4;
    const currency = isPrinted ? row % 2 ? 16 : 14 : row % 2 ? 14 : 15;
    const linkStyle = isPrinted ? row % 2 ? 19 : 17 : row % 2 ? 17 : 18;
    put(target, row, 1, ordinal++, band);
    put(target, row, 2, line.name, bold);
    put(target, row, 3, line.qty, band);
    if (!isPrinted && line.packsToOrder !== null) put(target, row, 4, line.packsToOrder, band);
    put(target, row, 5, isPrinted ? '3D Printed' : line.vendor?.vendorId ?? '—', isPrinted || line.vendor ? linkStyle : band, 's', isPrinted ? line.partStudioUrl : line.vendor?.url);
    put(target, row, 6, line.vendor?.sku ?? line.partNumber ?? '—', bold);
    if (!isPrinted && line.vendor?.priceUsd !== null && line.vendor) put(target, row, 7, line.vendor.priceUsd, currency);
    const chargeable = !isPrinted && line.vendor?.packSizeVerified && line.vendor.priceUsd !== null && line.packsToOrder !== null && ['exact', 'confirmed'].includes(line.matchStatus);
    if (chargeable) {
      const cache = Math.round(line.packsToOrder! * line.vendor!.priceUsd! * 100) / 100;
      total += cache;
      put(target, row, 8, `D${row}*G${row}`, currency, 'f', undefined, cache);
    }
    const stock = stockLabel(line); put(target, row, 9, stock.value, stock.style);
    if (!isPrinted && line.vendor?.stockQty !== null && line.vendor) put(target, row, 10, line.vendor.stockQty!, band);
    put(target, row, 11, typeLabel(line), band);
    const choices = alternatives(line);
    if (choices.length) put(target, row, 12, choices.map(item => `${item.name} — $${item.priceUsd!.toFixed(2)}`).join('\n'), linkStyle, 's', choices[0].url);
    for (const choice of choices) alternativeRows.push({ source: line.name, choice });
    put(target, row, 13, notes(line, result), band);
    row++;
  };
  commercial.forEach(line => write(line, false));
  const commercialEnd = row - 1;
  if (printed.length) {
    row++;
    put(target, row, 1, '— 3D PRINTED PARTS —', 24);
    for (let c = 2; c <= 13; c++) put(target, row, c, '', 24);
    target.merges.push(`A${row}:M${row}`);
    row++;
    printed.forEach(line => write(line, true));
  }
  const bomEnd = row - 1;
  if (alternativeRows.length) {
    row += 2;
    put(target, row, 1, '— IN-STOCK ALTERNATIVES —', 24);
    for (let c = 2; c <= 13; c++) put(target, row, c, '', 24);
    target.merges.push(`A${row}:M${row}`);
    for (const alternative of alternativeRows) {
      row++;
      put(target, row, 2, alternative.source, row % 2 ? 0 : 1);
      put(target, row, 5, alternative.choice.vendorId, row % 2 ? 0 : 1);
      put(target, row, 6, alternative.choice.sku, row % 2 ? 3 : 4);
      put(target, row, 12, `${alternative.choice.name} — $${alternative.choice.priceUsd!.toFixed(2)}`, row % 2 ? 17 : 18, 's', alternative.choice.url);
    }
  }
  put(target, 4, 6, `SUM(H7:H${Math.max(7, bomEnd)})`, 22, 'f', undefined, Math.round(total * 100) / 100);
  target.filter = `A6:M${Math.max(6, commercialEnd)}`;
  target.frozen = 6;
  target.landscape = true;
  return target;
}
function simple(name: string, headings: string[], entries: Array<Array<{ value: string | number; link?: string }>>, empty: string): Sheet {
  const target = sheet(name, headings.length);
  headings.forEach((heading, index) => put(target, 1, index + 1, heading, 6));
  if (!entries.length) put(target, 2, 1, empty);
  entries.forEach((entry, index) => entry.forEach((item, c) => put(target, index + 2, c + 1, item.value,
    name === 'Suppressed Parts' ? 23 : item.link ? 17 : index % 2 ? 1 : 0, typeof item.value === 'number' ? 'n' : 's', item.link)));
  target.frozen = 1;
  if (entries.length) target.filter = `A1:${cellRef(headings.length, entries.length + 1)}`;
  return target;
}

const item = (value: string | number, link?: string) => ({ value, link });
export function buildExcelWorkbook(result: ScanResult, now = new Date()): ExcelExport {
  const printed = result.lines.filter(line => line.classification === 'printed');
  const sheets = [
    bom(result, now),
    simple('3D Printed Parts', ['Part Name', 'Qty', 'Category (zip folder)', 'Classifier Score', 'Why Flagged', 'Print Files (Part Studio link)'],
      printed.map(line => [item(line.name), item(line.qty), item(printCategory(line.name)), item(line.classificationScore), item(line.classificationReasons.join('; ')), item(line.partStudioUrl, line.partStudioUrl)]), 'No 3D printed parts detected.'),
    simple('Suppressed Parts', ['Part Name', 'Qty', 'Instance Path(s)', 'Document'],
      result.suppressed.map(line => [item(line.name), item(line.qty), item(line.instancePaths.join('; ')), item(line.partStudioUrl, line.partStudioUrl)]), 'No suppressed parts.'),
    simple('Missing Metadata', ['Part Name', 'Qty', 'What Was Missing', 'Part Studio Link'],
      result.missingMetadata.map(line => [item(line.name), item(line.qty), item(line.missingMetadataReason ?? 'Metadata unavailable'), item(line.partStudioUrl, line.partStudioUrl)]), 'All parts enriched successfully.'),
  ];
  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><bookViews><workbookView/></bookViews><sheets>${sheets.map((entry, index) => `<sheet name="${esc(entry.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join('')}</sheets><definedNames><definedName name="_xlnm.Print_Titles" localSheetId="0">'BOM'!$6:$6</definedName></definedNames><calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>`;
  const workbookRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`).join('')}<Relationship Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_, index) => `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`;
  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8(contentTypes),
    '_rels/.rels': strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'),
    'xl/workbook.xml': strToU8(workbook),
    'xl/_rels/workbook.xml.rels': strToU8(workbookRels),
    'xl/styles.xml': strToU8(STYLES),
  };
  sheets.forEach((entry, index) => {
    files[`xl/worksheets/sheet${index + 1}.xml`] = strToU8(renderSheet(entry));
    if (entry.links.length) files[`xl/worksheets/_rels/sheet${index + 1}.xml.rels`] = strToU8(rels(entry));
  });
  return { bytes: zipSync(files, { level: 6 }), filename: buildFilename(result.assemblyName, now).filename };
}

/** Plain BOM fallback derived from the same sheet model as the XLSX export. */
export function buildBomCsv(result: ScanResult, now = new Date()): CsvExport {
  const source = bom(result, now);
  const last = Math.max(6, ...source.rows.keys());
  const quote = (value: string | number) => `"${String(value).replaceAll('"', '""')}"`;
  const rows = Array.from({ length: last }, (_, index) => {
    const columns = Array<string>(13).fill('');
    for (const cell of source.rows.get(index + 1) ?? []) columns[cell.col - 1] = quote(cell.type === 'f' ? cell.cached ?? '' : cell.value);
    return columns.join(',');
  });
  const { filename } = buildFilename(result.assemblyName, now);
  return { bytes: strToU8(`\uFEFF${rows.join('\r\n')}\r\n`), filename: filename.replace(/\.xlsx$/, '.csv') };
}

function buildFilename(assemblyName: string, now: Date) {
  const date = now.toISOString().slice(0, 10);
  const assembly = assemblyName.replace(/[^a-zA-Z0-9-_ ]/g, '').trim().replace(/ +/g, '_').slice(0, 80) || 'Assembly';
  return { filename: `${assembly}_BOM_${date}.xlsx` };
}
