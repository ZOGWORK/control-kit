import { strToU8, zipSync } from 'fflate';
import { dxfFileName, isBundle, metadataIssueText, stepFileName, wantsDxf, wantsStep, type BomLine, type CatalogHealth, type Disposition, type ScanResult, type VendorHealth, type VendorRecord } from '../../shared/src/index';

type Cell = { col: number; type: 's' | 'n' | 'f'; value: string | number; style: number; cached?: number };
type Sheet = { name: string; rows: Map<number, Cell[]>; widths: number[]; fixed: Record<number, number>; merges: string[]; links: { cell: string; url: string }[]; filter?: string; frozen?: number; landscape?: boolean; drawing?: boolean; tall?: number[] };
export type ExcelExport = { bytes: Uint8Array; filename: string };
export type CsvExport = { bytes: Uint8Array; filename: string };
const esc = (value: string | number) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
const col = (index: number) => { let out = ''; for (let n = index; n; n = Math.floor((n - 1) / 26)) out = String.fromCharCode(65 + (n - 1) % 26) + out; return out; };
const cellRef = (column: number, row: number) => `${col(column)}${row}`;
const sheet = (name: string, columns: number, fixed: Record<number, number> = {}): Sheet => ({ name, rows: new Map(), widths: Array(columns).fill(10), fixed: { 1: 6, ...fixed }, merges: [], links: [] });
function safeUrl(value?: string | null) { try { const url = new URL(value ?? ''); return url.protocol === 'https:' && !url.username && !url.password ? url.toString() : undefined; } catch { return undefined; } }
function put(target: Sheet, row: number, column: number, value: string | number, style = 0, type: Cell['type'] = typeof value === 'number' ? 'n' : 's', link?: string | null, cached?: number) {
  const cells = (target.rows.get(row) ?? []).filter(cell => cell.col !== column);
  cells.push({ col: column, type, value, style, ...(cached === undefined ? {} : { cached }) });
  target.rows.set(row, cells);
  const url = safeUrl(link);
  if (url) target.links.push({ cell: cellRef(column, row), url });
  const width = String(type === 'f' ? cached ?? '' : value).split('\n').reduce((longest, part) => Math.max(longest, part.length), 0) + 2;
  target.widths[column - 1] = Math.max(target.widths[column - 1] ?? 10, Math.min(48, width));
}
function renderSheet(target: Sheet) {
  const last = Math.max(1, ...target.rows.keys());
  const height = (number: number) => target.drawing && number <= 3 ? ` ht="${number === 1 ? 38 : number === 2 ? 26 : 24}" customHeight="1"` : target.tall?.includes(number) ? ' ht="30" customHeight="1"' : '';
  const rows = [...target.rows.entries()].sort(([a], [b]) => a - b).map(([number, cells]) => `<row r="${number}"${height(number)}>${cells.sort((a, b) => a.col - b.col).map(value => {
    const address = cellRef(value.col, number);
    if (value.type === 'f') return `<c r="${address}" s="${value.style}"><f>${esc(value.value)}</f>${value.cached === undefined ? '' : `<v>${value.cached}</v>`}</c>`;
    if (value.type === 'n') return `<c r="${address}" s="${value.style}"><v>${value.value}</v></c>`;
    return `<c r="${address}" s="${value.style}" t="inlineStr"><is><t xml:space="preserve">${esc(value.value)}</t></is></c>`;
  }).join('')}</row>`).join('');
  const widths = target.widths.map((width, index) => `<col min="${index + 1}" max="${index + 1}" width="${target.fixed[index + 1] ?? Math.max(8, Math.min(48, width))}" customWidth="1"/>`).join('');
  const freeze = target.frozen ? `<sheetViews><sheetView workbookViewId="0"><pane ySplit="${target.frozen}" topLeftCell="A${target.frozen + 1}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>` : '<sheetViews><sheetView workbookViewId="0"/></sheetViews>';
  const merges = target.merges.length ? `<mergeCells count="${target.merges.length}">${target.merges.map(range => `<mergeCell ref="${range}"/>`).join('')}</mergeCells>` : '';
  const links = target.links.length ? `<hyperlinks>${target.links.map((link, index) => `<hyperlink ref="${link.cell}" r:id="rId${index + 1}"/>`).join('')}</hyperlinks>` : '';
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${target.landscape ? '<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>' : ''}<dimension ref="A1:${cellRef(target.widths.length, last)}"/>${freeze}<sheetFormatPr defaultRowHeight="16"/><cols>${widths}</cols><sheetData>${rows}</sheetData>${target.filter ? `<autoFilter ref="${target.filter}"/>` : ''}${merges}${links}<printOptions/><pageMargins left="0.3" right="0.3" top="0.5" bottom="0.5" header="0.2" footer="0.2"/>${target.landscape ? '<pageSetup orientation="landscape" fitToWidth="1" fitToHeight="0"/>' : ''}${target.drawing ? `<drawing r:id="rId${target.links.length + 1}"/>` : ''}</worksheet>`;
}
const fill = (hex: string) => `<fill><patternFill patternType="solid"><fgColor rgb="FF${hex}"/><bgColor indexed="64"/></patternFill></fill>`;
const font = (size: number, color: string, bold = false, underline = false) => `<font>${bold ? '<b/>' : ''}${underline ? '<u/>' : ''}<sz val="${size}"/><name val="Calibri"/><color rgb="FF${color}"/></font>`;
const xf = (fontId: number, fillId: number, currency = false, wrap = false, left = false) => `<xf numFmtId="${currency ? 164 : 0}" fontId="${fontId}" fillId="${fillId}" borderId="0" xfId="0" applyFont="1" applyFill="1"${currency ? ' applyNumberFormat="1"' : ''} applyAlignment="1"><alignment vertical="center"${left ? ' horizontal="left"' : ''}${wrap ? ' wrapText="1"' : ''}/></xf>`;
/** Named style IDs, in the order of the `cellXfs` list below. */
const S = {
  body: 0, bodyAlt: 1, bodySoft: 2, bold: 3, boldAlt: 4, header: 6, title: 7, band: 8,
  inStock: 9, outStock: 10, lowStock: 11, unknownStock: 12, money: 14, moneyAlt: 15,
  link: 17, linkAlt: 18, label: 20, value: 21, total: 22, muted: 23, section: 24, wrap: 25, wrapAlt: 26, note: 27,
} as const;
const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="$#,##0.00"/></numFmts><fonts count="8">${font(11, '09090B')}${font(11, '09090B', true)}${font(11, 'FFC700', true)}${font(16, 'FFC700', true)}${font(11, 'F4F4F5')}${font(11, '725800', false, true)}${font(11, '71717A')}${font(11, 'FFC700', true)}</fonts><fills count="11"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>${['FFFFFF', 'F4F4F5', '09090B', '1F7A3A', 'C0392B', 'FFC700', '71717A', '26262C', 'FFF8D6'].map(fill).join('')}</fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="28">${[
  xf(0, 2), xf(0, 3), xf(0, 10), xf(1, 2), xf(1, 3), xf(1, 10), xf(2, 4), xf(3, 4), xf(4, 4),
  xf(4, 5), xf(4, 6), xf(0, 7), xf(4, 8), xf(7, 9), xf(0, 2, true), xf(0, 3, true), xf(0, 10, true),
  xf(5, 2, false, true), xf(5, 3, false, true), xf(5, 10, false, true), xf(1, 2), xf(1, 10, false, false, true), xf(1, 10, true, false, true), xf(6, 3), xf(1, 7),
  xf(0, 2, false, true), xf(0, 3, false, true), xf(6, 2, false, true),
].join('')}</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;
function rels(target: Sheet) { return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${target.links.map((link, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${esc(link.url)}" TargetMode="External"/>`).join('')}${target.drawing ? `<Relationship Id="rId${target.links.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/>` : ''}</Relationships>`; }
const LOGO_DRAWING = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><xdr:oneCellAnchor><xdr:from><xdr:col>0</xdr:col><xdr:colOff>95250</xdr:colOff><xdr:row>0</xdr:row><xdr:rowOff>47625</xdr:rowOff></xdr:from><xdr:ext cx="952500" cy="952500"/><xdr:pic><xdr:nvPicPr><xdr:cNvPr id="1" name="Control Kit logo" descr="Black and yellow Control Kit hexagon logo"/><xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr></xdr:nvPicPr><xdr:blipFill><a:blip r:embed="rId1"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill><xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="952500" cy="952500"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr></xdr:pic><xdr:clientData/></xdr:oneCellAnchor></xdr:wsDr>`;

const vendorName: Record<VendorRecord['vendorId'], string> = { gobilda: 'goBILDA', servocity: 'ServoCity', andymark: 'AndyMark', rev: 'REV', pitsco: 'Pitsco' };
const shortLabel: Record<Disposition, string> = { buy: 'Buy', print: '3D print', cnc: 'CNC', 'cut-2d': '2D cut', fabricate: 'Fabricate', hardware: 'Fastener', ignore: 'Not needed', review: 'Needs review' };
const matchText: Record<BomLine['matchStatus'], string> = { exact: 'Exact SKU', confirmed: 'Confirmed', possible: 'Possible, not confirmed', rejected: 'Rejected', unmatched: 'No match' };
const order: Disposition[] = ['buy', 'hardware', 'print', 'cnc', 'cut-2d', 'fabricate', 'review', 'ignore'];
const date = (iso: string | null | undefined) => iso && Number.isFinite(Date.parse(iso)) ? iso.slice(0, 10) : 'unknown';
/**
 * When a product's price and stock were read. REV's feed terms require its update time beside every REV price and stock
 * shown, so an official feed's records give the date and time; a crawled page gives the date it was fetched.
 */
const asOf = (vendor: VendorRecord) => vendor.parser === 'official-feed' && Number.isFinite(Date.parse(vendor.updatedAt))
  ? `${vendorName[vendor.vendorId]} feed updated ${new Date(vendor.updatedAt).toISOString().slice(0, 16).replace('T', ' ')} UTC` : date(vendor.updatedAt);
/** Only an exact or confirmed match identifies the product a team orders; anything else is a candidate. */
const ordered = (line: BomLine) => Boolean(line.vendor && (line.matchStatus === 'exact' || line.matchStatus === 'confirmed'));
const verifiedPack = (line: BomLine) => ordered(line) && line.vendor!.packSizeVerified && line.vendor!.packSize && !isBundle(line.vendor!.name) ? line.vendor!.packSize : null;
const priced = (line: BomLine) => ordered(line) && line.lineTotalUsd !== null && line.packsToOrder !== null && line.vendor!.priceUsd !== null;
/** Ordered under another row for the same SKU, which carries the packs and total. */
const covered = (line: BomLine) => priced(line) || Boolean(line.orderedWith);
const product = (vendor: VendorRecord) => `${vendorName[vendor.vendorId]} ${vendor.sku}`;
function stock(line: BomLine): { value: string; style: number } {
  const vendor = line.vendor;
  if (!vendor || !ordered(line)) return { value: '', style: S.body };
  const asOf = `, ${date(vendor.updatedAt)}`;
  if (vendor.stock === 'in') return { value: `In stock${asOf}`, style: S.inStock };
  if (vendor.stock === 'out') return { value: `Out of stock${asOf}`, style: S.outStock };
  if (vendor.stock === 'low') return { value: `Low stock${asOf}`, style: S.lowStock };
  return { value: 'Unknown', style: S.unknownStock };
}
function purchaseNotes(line: BomLine, result: ScanResult) {
  const values: string[] = [];
  if (line.vendor && line.matchStatus === 'possible') values.push(`Possible match ${product(line.vendor)}: confirm it in Control Kit before ordering`);
  if (!line.vendor) values.push('No vendor product matched: add the vendor SKU to the part number in Onshape and rescan');
  if (ordered(line) && isBundle(line.vendor!.name)) values.push('A bundle of different pieces, so it is not priced per part');
  else if (ordered(line) && !verifiedPack(line)) values.push('Pack size not verified, so no total');
  if (line.priceCheck) values.push(`${line.priceCheck}; not priced`);
  if (ordered(line) && line.vendor!.priceUsd === null) values.push('No price, so no total');
  if (result.stats.staleVendorData && ordered(line)) values.push('Vendor data may be out of date');
  if (line.disposition === 'hardware') values.push('Fastener from stock: CAD count can be low if Replicate or patterns placed some');
  if (line.purchasedAssembly) values.push(`One product (${line.purchasedAssembly.parts} internal parts not listed${line.purchasedAssembly.includes?.length ? `; includes ${line.purchasedAssembly.includes.join(', ')}` : ''})`);
  if (line.order && line.order.lines > 1) values.push(`Packs cover ${line.order.qty} pieces across ${line.order.lines} CAD lines with this SKU`);
  if (line.orderedWith) values.push(`Ordered with ${result.lines.find(other => other.bomLineKey === line.orderedWith)?.name ?? 'another row'} (same SKU)`);
  if (line.manualClassification) values.push('Set by your team');
  if (line.missingMetadataReason) values.push(line.missingMetadataReason);
  return values.join('. ');
}
/** Same states and words as the app: an old or failed-to-update catalog is never "Ready". */
function catalogText(vendor: VendorHealth) {
  if (vendor.state === 'published') return !vendor.complete ? 'Partial' : vendor.lastRunFailed ? 'Last update failed' : vendor.stale ? 'Out of date' : 'Ready';
  return vendor.state === 'failing' ? 'Failing' : 'Loading';
}
function revisionText(result: ScanResult) {
  const revision = result.diagnostics?.revision;
  return revision ? `${revision.type === 'v' ? 'Version' : 'Microversion'} ${revision.id}` : 'Not recorded';
}
/** STEP file names exactly as the export names them: same lines, same order, same de-duplication. */
function stepNames(result: ScanResult) {
  const used = new Set<string>();
  return new Map(result.lines.filter(wantsStep).map(line => [line.bomLineKey, stepFileName(line, used)]));
}
const byName = (a: BomLine, b: BomLine) => a.name.localeCompare(b.name);
/** Live subtotal of filled Line Totals; with none filled it reads "None priced", never a $0.00 that looks complete. */
const subtotal = (range: string) => `IF(COUNT(${range}),SUM(${range}),"None priced")`;
const band = (index: number, even: number, odd: number) => index % 2 ? odd : even;

/** Title band shared by every sheet: sheet title, assembly with its Onshape link, and when it was read. */
function heading(target: Sheet, title: string, result: ScanResult, now: Date, from: number) {
  const last = target.widths.length;
  for (const row of [1, 2, 3]) for (let c = 1; c <= last; c++) put(target, row, c, '', row === 1 ? S.title : S.band);
  put(target, 1, from, title, S.title);
  put(target, 2, from, `${result.documentName ? `${result.documentName} / ` : ''}${result.assemblyName} · Open in Onshape`, S.band, 's', `https://cad.onshape.com/documents/${encodeURIComponent(result.documentId)}`);
  put(target, 3, from, `Scanned ${date(result.scannedAt)} (${revisionText(result)}) · Generated ${now.toISOString().slice(0, 16).replace('T', ' ')} UTC`, S.band);
  for (const row of [1, 2, 3]) target.merges.push(`${cellRef(from, row)}:${cellRef(last, row)}`);
  target.widths = target.widths.map(() => 8);
}
/** Header cells, widened for the filter button Excel draws at their right edge. */
function headers(target: Sheet, row: number, names: string[]) {
  names.forEach((name, index) => { put(target, row, index + 1, name, S.header); target.widths[index] = Math.max(target.widths[index], name.length + 5); });
}

/** The part name links to its product page; the Onshape column opens the Part Studio that holds the part. */
const BUY_HEADERS = ['#', 'Part', 'Qty Needed', 'Pack Size', 'Packs to Order', 'Vendor', 'SKU', 'Pack Price', 'Line Total', 'Stock', 'Price and Stock As Of', 'Match', 'Onshape Part Studio', 'Notes'];
/**
 * One row per part the team buys, grouped by vendor. Line Total is a live `Packs × Pack Price` formula only where the match
 * is exact or confirmed and the pack size and price are verified; every other row keeps its financial cells blank.
 */
function buySheet(result: ScanResult, now: Date) {
  const target = sheet('Buy list', BUY_HEADERS.length, { 2: 44, 11: 30, 14: 52 });
  heading(target, 'BUY LIST', result, now, 1);
  // Fasteners follow the parts to buy: listed with their CAD counts, never priced (an exact SKU would have made them Buy).
  const lines = result.lines.filter(line => line.disposition === 'buy' || line.disposition === 'hardware')
    .sort((a, b) => Number(a.disposition === 'hardware') - Number(b.disposition === 'hardware') || Number(ordered(b)) - Number(ordered(a)) || (a.vendor ? vendorName[a.vendor.vendorId] : '~').localeCompare(b.vendor ? vendorName[b.vendor.vendorId] : '~') || byName(a, b));
  const first = 7;
  const last = Math.max(first, first + lines.length - 1);
  // Stock fasteners are listed but are not purchases, so they never count toward "priced of parts to buy".
  const purchases = lines.filter(line => line.disposition === 'buy');
  const pricedLines = purchases.filter(covered);
  const total = Math.round(purchases.filter(priced).reduce((sum, line) => sum + line.lineTotalUsd!, 0) * 100) / 100;
  put(target, 4, 2, 'Lines', S.label); put(target, 4, 3, purchases.length, S.value);
  put(target, 4, 4, 'Priced', S.label); put(target, 4, 5, pricedLines.length, S.value);
  put(target, 4, 6, 'Unpriced', S.label); put(target, 4, 7, purchases.length - pricedLines.length, S.value);
  put(target, 4, 8, 'Known subtotal', S.label); put(target, 4, 9, subtotal(`I${first}:I${last}`), S.total, 'f', undefined, pricedLines.length ? total : undefined);
  put(target, 5, 1, 'Known subtotal adds only Line Totals that are filled in: an exact or confirmed product with a verified pack size and price. A blank Line Total is unknown, not zero. Packs to Order = Qty Needed ÷ Pack Size, rounded up.', S.note);
  target.merges.push(`A5:${cellRef(BUY_HEADERS.length, 5)}`); target.tall = [5];
  headers(target, 6, BUY_HEADERS);
  lines.forEach((line, index) => {
    const row = first + index;
    const body = band(index, S.body, S.bodyAlt);
    const vendor = ordered(line) ? line.vendor! : null;
    put(target, row, 1, index + 1, body);
    put(target, row, 2, line.name, vendor ? band(index, S.link, S.linkAlt) : band(index, S.bold, S.boldAlt), 's', vendor?.url);
    put(target, row, 3, line.qty, body);
    const pack = verifiedPack(line);
    if (pack) put(target, row, 4, pack, body); else put(target, row, 4, '', body);
    if (priced(line)) put(target, row, 5, line.packsToOrder!, body); else put(target, row, 5, '', body);
    put(target, row, 6, vendor ? vendorName[vendor.vendorId] : '', body);
    put(target, row, 7, vendor?.sku ?? '', band(index, S.bold, S.boldAlt));
    if (vendor?.priceUsd !== null && vendor) put(target, row, 8, vendor.priceUsd, band(index, S.money, S.moneyAlt)); else put(target, row, 8, '', body);
    if (priced(line)) put(target, row, 9, `E${row}*H${row}`, band(index, S.money, S.moneyAlt), 'f', undefined, line.lineTotalUsd!);
    else put(target, row, 9, '', body);
    const level = stock(line); put(target, row, 10, level.value, level.value ? level.style : body);
    put(target, row, 11, vendor ? asOf(vendor) : '', body);
    put(target, row, 12, matchText[line.matchStatus], body);
    put(target, row, 13, 'Open Part Studio', band(index, S.link, S.linkAlt), 's', line.partStudioUrl);
    put(target, row, 14, purchaseNotes(line, result), band(index, S.wrap, S.wrapAlt));
  });
  if (!lines.length) put(target, first, 1, 'No parts are marked Buy yet. Decide parts in Control Kit, then download again.', S.muted);
  target.filter = `A6:${cellRef(BUY_HEADERS.length, last)}`;
  target.frozen = 6; target.landscape = true;
  return { target, first, last, total, priced: pricedLines.length, lines: purchases.length };
}

/** Parts the team makes, by process, with the STEP file name each one gets in the export ZIP, and a 2D-cut part's DXF. */
function makeSheet(result: ScanResult, now: Date) {
  const names = ['#', 'Part', 'Qty Needed', 'Process', 'Material', 'STEP file', 'DXF file', 'Onshape Part Studio', 'Why'];
  const target = sheet('Make', names.length, { 2: 44, 6: 44, 7: 44, 9: 52 });
  heading(target, 'MAKE', result, now, 1);
  put(target, 4, 1, 'STEP files come from Download STEP files in Control Kit; each file in the ZIP has the name shown here, in a folder for its process. A 2D-cut part also gets a DXF of its flat face, in millimetres.', S.note);
  target.merges.push(`A4:${cellRef(names.length, 4)}`); target.tall = [4];
  headers(target, 6, names);
  const files = stepNames(result);
  const lines = result.lines.filter(line => ['print', 'cnc', 'cut-2d', 'fabricate'].includes(line.disposition))
    .sort((a, b) => order.indexOf(a.disposition) - order.indexOf(b.disposition) || byName(a, b));
  lines.forEach((line, index) => {
    const row = 7 + index;
    const body = band(index, S.body, S.bodyAlt);
    put(target, row, 1, index + 1, body);
    put(target, row, 2, line.name, band(index, S.bold, S.boldAlt));
    put(target, row, 3, line.qty, body);
    put(target, row, 4, shortLabel[line.disposition], body);
    put(target, row, 5, line.material ?? '', body);
    const file = files.get(line.bomLineKey) ?? '';
    put(target, row, 6, file, body);
    put(target, row, 7, file && wantsDxf(line) ? dxfFileName(file) : '', body);
    put(target, row, 8, 'Open Part Studio', band(index, S.link, S.linkAlt), 's', line.partStudioUrl);
    put(target, row, 9, line.dispositionEvidence.join('; '), band(index, S.wrap, S.wrapAlt));
  });
  if (!lines.length) put(target, 7, 1, 'No parts are marked to make yet.', S.muted);
  target.filter = `A6:${cellRef(names.length, Math.max(7, 6 + lines.length))}`;
  target.frozen = 6; target.landscape = true;
  return target;
}

/** Parts without a decision, with Control Kit's suggestion and any possible product to confirm. */
function reviewSheet(result: ScanResult, now: Date) {
  const names = ['#', 'Part', 'Qty Needed', 'Suggested', 'Possible product', 'Why it needs review', 'Onshape Part Studio'];
  const target = sheet('Review', names.length, { 2: 44, 6: 64 });
  heading(target, 'NEEDS REVIEW', result, now, 1);
  put(target, 4, 1, 'Decide these parts in Control Kit. A possible product is a candidate only: it is not priced or ordered until someone confirms it.', S.note);
  target.merges.push(`A4:${cellRef(names.length, 4)}`); target.tall = [4];
  headers(target, 6, names);
  const lines = result.lines.filter(line => line.disposition === 'review')
    .sort((a, b) => Number(Boolean(b.vendor && b.matchStatus === 'possible')) - Number(Boolean(a.vendor && a.matchStatus === 'possible')) || Number(Boolean(b.suggestedDisposition)) - Number(Boolean(a.suggestedDisposition)) || b.qty - a.qty || byName(a, b));
  lines.forEach((line, index) => {
    const row = 7 + index;
    const body = band(index, S.body, S.bodyAlt);
    const candidate = line.vendor && line.matchStatus === 'possible' ? line.vendor : null;
    put(target, row, 1, index + 1, body);
    put(target, row, 2, line.name, band(index, S.bold, S.boldAlt));
    put(target, row, 3, line.qty, body);
    put(target, row, 4, line.suggestedDisposition ? shortLabel[line.suggestedDisposition] : '', body);
    put(target, row, 5, candidate ? product(candidate) : '', candidate ? band(index, S.link, S.linkAlt) : body, 's', candidate?.url);
    put(target, row, 6, line.reviewReason ?? line.dispositionEvidence.join('; '), band(index, S.wrap, S.wrapAlt));
    put(target, row, 7, 'Open Part Studio', band(index, S.link, S.linkAlt), 's', line.partStudioUrl);
  });
  if (!lines.length) put(target, 7, 1, 'Every part has a decision.', S.muted);
  target.filter = `A6:${cellRef(names.length, Math.max(7, 6 + lines.length))}`;
  target.frozen = 6; target.landscape = true;
  return target;
}

/** Every part with a link to its exact vendor product page and to the part in Onshape. */
function linksSheet(result: ScanResult, now: Date) {
  const names = ['#', 'Part', 'Qty Needed', 'How obtained', 'Part number', 'Vendor product', 'Match', 'Onshape Part Studio'];
  const target = sheet('Links', names.length, { 2: 48, 6: 30 });
  heading(target, 'LINKS', result, now, 1);
  put(target, 4, 1, 'Each part links to its vendor product page (exact or confirmed products, and possible ones marked as such) and to the part in Onshape.', S.note);
  target.merges.push(`A4:${cellRef(names.length, 4)}`); target.tall = [4];
  headers(target, 6, names);
  const lines = [...result.lines].sort((a, b) => order.indexOf(a.disposition) - order.indexOf(b.disposition) || byName(a, b));
  lines.forEach((line, index) => {
    const row = 7 + index;
    const body = band(index, S.body, S.bodyAlt);
    const vendor = line.vendor && line.matchStatus !== 'rejected' ? line.vendor : null;
    put(target, row, 1, index + 1, body);
    put(target, row, 2, line.name, band(index, S.bold, S.boldAlt));
    put(target, row, 3, line.qty, body);
    put(target, row, 4, shortLabel[line.disposition], body);
    put(target, row, 5, line.partNumber ?? '', body);
    put(target, row, 6, vendor ? product(vendor) : '', vendor ? band(index, S.link, S.linkAlt) : body, 's', vendor?.url);
    put(target, row, 7, vendor ? matchText[line.matchStatus] : '', body);
    put(target, row, 8, 'Open Part Studio', band(index, S.link, S.linkAlt), 's', line.partStudioUrl);
  });
  target.filter = `A6:${cellRef(names.length, Math.max(7, 6 + lines.length))}`;
  target.frozen = 6;
  return target;
}

/** Things that keep the lists from being complete: suppressed parts, missing data, unresolved subassemblies, stock problems. */
function exceptionsSheet(result: ScanResult, now: Date) {
  const names = ['#', 'Kind', 'Part', 'Qty', 'Detail', 'Onshape Part Studio'];
  const target = sheet('Exceptions', names.length, { 3: 44, 5: 72 });
  heading(target, 'EXCEPTIONS', result, now, 1);
  headers(target, 6, names);
  const rows: Array<{ kind: string; line: BomLine; detail: string }> = [
    ...result.lines.filter(line => line.disposition === 'ignore').map(line => ({ kind: 'Not needed', line, detail: 'Marked not needed by your team: not bought or made' })),
    ...result.lines.filter(line => ordered(line) && line.disposition === 'buy' && ['out', 'low'].includes(line.vendor!.stock))
      .map(line => ({ kind: line.vendor!.stock === 'out' ? 'Out of stock' : 'Low stock', line, detail: `${product(line.vendor!)}, ${line.vendor!.parser === 'official-feed' ? '' : 'as of '}${asOf(line.vendor!)}` })),
    ...result.lines.filter(line => line.unresolvedSubassembly).map(line => ({ kind: 'Unresolved subassembly', line, detail: line.missingMetadataReason ?? 'Its parts could not be read' })),
    ...result.missingMetadata.filter(line => !line.suppressed && !line.unresolvedSubassembly)
      .map(line => ({ kind: 'Missing data', line, detail: line.metadataIssue ? metadataIssueText[line.metadataIssue.code] : line.missingMetadataReason ?? 'Metadata unavailable' })),
    ...result.suppressed.map(line => ({ kind: 'Suppressed', line, detail: `Suppressed in Onshape, so not bought or made (${line.instancePaths.length} place${line.instancePaths.length === 1 ? '' : 's'} in the assembly)` })),
  ];
  rows.forEach(({ kind, line, detail }, index) => {
    const row = 7 + index;
    const body = band(index, S.body, S.bodyAlt);
    put(target, row, 1, index + 1, body);
    put(target, row, 2, kind, band(index, S.bold, S.boldAlt));
    put(target, row, 3, line.name, body);
    put(target, row, 4, line.qty, body);
    put(target, row, 5, detail, band(index, S.wrap, S.wrapAlt));
    put(target, row, 6, 'Open Part Studio', band(index, S.link, S.linkAlt), 's', line.partStudioUrl);
  });
  if (!rows.length) put(target, 7, 1, 'Nothing to report.', S.muted);
  target.filter = `A6:${cellRef(names.length, Math.max(7, 6 + rows.length))}`;
  target.frozen = 6; target.landscape = true;
  return target;
}

/** First sheet: the logo, what was scanned, the headline numbers (the subtotal live from the Buy list), catalogs, and how to read the rest. */
function overviewSheet(result: ScanResult, now: Date, buy: ReturnType<typeof buySheet>, drawing: boolean) {
  const target = sheet('Overview', 10, { 1: 12, 2: 10, 3: 16, 4: 10, 5: 16, 6: 10, 7: 16, 8: 10, 9: 18, 10: 14 });
  target.drawing = drawing;
  heading(target, 'CONTROL KIT  /  BILL OF MATERIALS', result, now, 3);
  target.merges.push('A1:B3');
  const count = (disposition: Disposition) => result.lines.filter(line => line.disposition === disposition).length;
  const make = count('print') + count('cnc') + count('cut-2d') + count('fabricate');
  put(target, 4, 1, 'Parts', S.label); put(target, 4, 2, result.lines.length, S.value);
  put(target, 4, 3, 'Buy', S.label); put(target, 4, 4, count('buy'), S.value);
  put(target, 4, 5, 'Make', S.label); put(target, 4, 6, make, S.value);
  put(target, 4, 7, 'Needs review', S.label); put(target, 4, 8, count('review'), S.value);
  put(target, 4, 9, 'Known subtotal', S.label); put(target, 4, 10, subtotal(`'Buy list'!I${buy.first}:I${buy.last}`), S.total, 'f', undefined, buy.priced ? buy.total : undefined);
  put(target, 5, 1, `${buy.priced} of ${buy.lines} parts to buy are priced. ${result.stats.totalInstances} instances in the assembly${result.suppressed.length ? `, plus ${result.suppressed.reduce((sum, line) => sum + line.qty, 0)} suppressed` : ''}.`, S.note);
  target.merges.push('A5:J5');

  let row = 7;
  put(target, row, 1, 'Vendor catalogs', S.section); for (let c = 2; c <= 10; c++) put(target, row, c, '', S.section); target.merges.push(`A${row}:J${row}`);
  row++;
  put(target, row, 1, 'Vendor', S.header); put(target, row, 3, 'Status', S.header); put(target, row, 5, 'Products', S.header); put(target, row, 7, 'Updated', S.header);
  for (const c of [2, 4, 6, 8, 9, 10]) put(target, row, c, '', S.header);
  const health: CatalogHealth | undefined = result.catalogHealth;
  for (const [index, vendor] of (health?.vendors ?? []).entries()) {
    row++;
    const body = band(index, S.body, S.bodyAlt);
    put(target, row, 1, vendorName[vendor.vendorId], band(index, S.bold, S.boldAlt));
    put(target, row, 3, catalogText(vendor), body);
    put(target, row, 5, vendor.recordCount, body);
    put(target, row, 7, date(vendor.updatedAt), body);
  }
  if (!health) { row++; put(target, row, 1, `Catalog status was not recorded with this scan. Vendor data as of ${date(result.vendorDataUpdatedAt)}.`, S.muted); }

  row += 2;
  put(target, row, 1, 'How to read this workbook', S.section); for (let c = 2; c <= 10; c++) put(target, row, c, '', S.section); target.merges.push(`A${row}:J${row}`);
  const notes = [
    'Buy list: parts to order, grouped by vendor, with product links, packs, and live Line Total formulas.',
    'Make: parts to 3D print, machine, cut, or fabricate, with the STEP file name each gets in the export ZIP (and the DXF for a 2D-cut part).',
    'Review: parts without a decision yet, with suggestions and possible products to confirm in Control Kit.',
    'Links: every part, with its vendor product page and its Onshape part.',
    'Exceptions: stock problems, unresolved subassemblies, parts missing data, and suppressed parts.',
    'Qty Needed counts every active instance in the assembly. Packs to Order = Qty Needed ÷ Pack Size, rounded up. Line Total = Packs to Order × Pack Price.',
    'A product is used only when its SKU matched exactly or someone confirmed it. Possible matches are listed but never priced. Known subtotal adds only filled Line Totals.',
  ];
  for (const note of notes) { row++; put(target, row, 1, note, S.wrap); target.merges.push(`A${row}:J${row}`); (target.tall ??= []).push(row); }
  return target;
}

export function buildExcelWorkbook(result: ScanResult, now = new Date(), logo?: Uint8Array): ExcelExport {
  const buy = buySheet(result, now);
  const sheets = [overviewSheet(result, now, buy, Boolean(logo)), buy.target, makeSheet(result, now), reviewSheet(result, now), linksSheet(result, now), exceptionsSheet(result, now)];
  const titles = sheets.map((entry, index) => entry.frozen ? `<definedName name="_xlnm.Print_Titles" localSheetId="${index}">'${entry.name}'!$${entry.frozen}:$${entry.frozen}</definedName>` : '').join('');
  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><bookViews><workbookView/></bookViews><sheets>${sheets.map((entry, index) => `<sheet name="${esc(entry.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join('')}</sheets><definedNames>${titles}</definedNames><calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>`;
  const workbookRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`).join('')}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${logo ? '<Default Extension="png" ContentType="image/png"/><Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>' : ''}<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_, index) => `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`;
  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8(contentTypes),
    '_rels/.rels': strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'),
    'xl/workbook.xml': strToU8(workbook),
    'xl/_rels/workbook.xml.rels': strToU8(workbookRels),
    'xl/styles.xml': strToU8(STYLES),
  };
  sheets.forEach((entry, index) => {
    files[`xl/worksheets/sheet${index + 1}.xml`] = strToU8(renderSheet(entry));
    if (entry.links.length || entry.drawing) files[`xl/worksheets/_rels/sheet${index + 1}.xml.rels`] = strToU8(rels(entry));
  });
  if (logo) {
    files['xl/media/control-kit-logo.png'] = logo;
    files['xl/drawings/drawing1.xml'] = strToU8(LOGO_DRAWING);
    files['xl/drawings/_rels/drawing1.xml.rels'] = strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/control-kit-logo.png"/></Relationships>');
  }
  return { bytes: zipSync(files, { level: 6 }), filename: buildFilename(result.assemblyName, now).filename };
}

export const CSV_HEADERS = ['#', 'Part', 'Qty Needed', 'How obtained', 'Pack Size', 'Packs to Order', 'Vendor', 'SKU', 'Pack Price', 'Line Total', 'Stock', 'Price and Stock As Of', 'Match', 'Product URL', 'Onshape URL', 'Notes'];
/**
 * Plain fallback with the workbook's rules: every active part, one row each. Pack Size, Packs to Order, and Line Total are
 * filled only for an exact or confirmed product with a verified pack size and price; a possible match is only named in Notes.
 */
export function buildBomCsv(result: ScanResult, now = new Date()): CsvExport {
  const quote = (value: string | number) => `"${String(value).replaceAll('"', '""')}"`;
  const safeText = (value: string | number) => {
    const text = String(value);
    let offset = 0;
    while (offset < text.length && (text.charCodeAt(offset) <= 32 || text.charCodeAt(offset) === 127 || text[offset].trim() === '')) offset++;
    const leader = text[offset];
    return leader && '=+-@'.includes(leader) ? `'${text}` : text;
  };
  const text = (value: string | null | undefined) => quote(safeText(value ?? ''));
  const lines = [...result.lines].sort((a, b) => order.indexOf(a.disposition) - order.indexOf(b.disposition) || byName(a, b));
  const rows = [CSV_HEADERS.map(quote).join(','), ...lines.map((line, index) => {
    const vendor = ordered(line) ? line.vendor! : null;
    // Only parts the team buys carry purchasing amounts; a matched part set to print or fabricate is named, never charged.
    const buying = line.disposition === 'buy';
    const charged = buying && priced(line);
    return [String(index + 1), text(line.name), String(line.qty), text(shortLabel[line.disposition]), buying ? String(verifiedPack(line) ?? '') : '', charged ? String(line.packsToOrder) : '',
      text(vendor ? vendorName[vendor.vendorId] : ''), text(vendor?.sku), !buying || !vendor || vendor.priceUsd === null ? '' : vendor.priceUsd.toFixed(2), charged ? line.lineTotalUsd!.toFixed(2) : '',
      text(stock(line).value), text(vendor ? asOf(vendor) : ''), text(matchText[line.matchStatus]), text(vendor ? safeUrl(vendor.url) : ''), text(safeUrl(line.partStudioUrl)), text(purchaseNotes(line, result))].join(',');
  })];
  const { filename } = buildFilename(result.assemblyName, now);
  return { bytes: strToU8(`\uFEFF${rows.join('\r\n')}\r\n`), filename: filename.replace(/\.xlsx$/, '.csv') };
}

function buildFilename(assemblyName: string, now: Date) {
  const day = now.toISOString().slice(0, 10);
  const assembly = assemblyName.replace(/[^a-zA-Z0-9-_ ]/g, '').trim().replace(/ +/g, '_').slice(0, 80) || 'Assembly';
  return { filename: `${assembly}_BOM_${day}.xlsx` };
}
