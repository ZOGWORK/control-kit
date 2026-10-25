export type VendorId = 'gobilda' | 'servocity' | 'andymark' | 'rev' | 'pitsco';
/** Who provided data or an image, under what terms, and the credit to show. */
export type Attribution = { source: string; license: string; credit: string; url?: string | null };
/** An image Control Kit may show because its owner allowed it; never built from a scraped URL. */
export type LicensedImage = { url: string; attribution: Attribution };
/**
 * A parts library's statement that one of its parts is a vendor product (for example an FTC Parts Library or
 * FRCDesign insert). Keyed by the library part's document and element, optionally narrowed by part and configuration.
 * Stored in VENDOR_CATALOG at `library-map:{documentId}` as a list.
 */
export type LibraryMapping = { library: string; documentId: string; elementId?: string | null; partId?: string | null; configuration?: string | null;
  vendorId: VendorId; sku: string; productUrl?: string | null; image?: LicensedImage | null; attribution: Attribution };
export const libraryMapKey = (documentId: string) => `library-map:${documentId}`;
/** The most specific mapping for a part: part and configuration, then part, then the whole element or document. */
export function findLibraryMapping(mappings: LibraryMapping[], line: { documentId: string; elementId: string; partId: string | null; configuration: string | null }) {
  const fits = mappings.filter(mapping => mapping.documentId === line.documentId && (!mapping.elementId || mapping.elementId === line.elementId)
    && (!mapping.partId || mapping.partId === line.partId) && (!mapping.configuration || mapping.configuration === line.configuration));
  const rank = (mapping: LibraryMapping) => Number(Boolean(mapping.partId)) * 4 + Number(Boolean(mapping.configuration)) * 2 + Number(Boolean(mapping.elementId));
  return fits.sort((a, b) => rank(b) - rank(a))[0] ?? null;
}
export type VendorRecord = {
  vendorId: VendorId;
  sku: string;
  normalizedSku: string;
  name: string;
  normalizedName: string;
  url: string;
  priceUsd: number | null; // Price charged for one purchasable pack.
  packSize: number | null;
  packSizeVerified: boolean;
  stock: 'in' | 'out' | 'low' | 'unknown';
  stockQty: number | null;
  category: string;
  updatedAt: string; // When the product page was fetched; price and stock are as of this time.
  source: 'feed' | 'sitemap' | 'scrape';
  /** Exact product text that established `packSize`, e.g. `variant label "25 Pack"`. Null when unverified. */
  packEvidence?: string | null;
  /** Which page structure produced the record. */
  parser?: 'jsonld' | 'shopify-variant' | 'bigcommerce-variant' | 'shopify-feed' | 'official-feed';
  /** A product image, only from a source that granted permission to show it (an official feed or library). */
  image?: LicensedImage | null;
  /** Page that was fetched, when it differs from the canonical product `url`. */
  sourceUrl?: string;
  /** Catalog generation the record was published in. */
  catalogVersion?: string;
};
/** `choices` lists the products a person picks between when a line names more than one exact SKU. */
export type MatchResult = { vendor: VendorRecord | null; confidence: number; status: 'unmatched' | 'possible' | 'confirmed' | 'exact'; reasons: string[]; choices?: VendorRecord[] };

const prefixes: Record<VendorId, string[]> = {
  gobilda: ['GB'], servocity: ['SC'], andymark: ['AM'], rev: ['REV'], pitsco: [],
};
const brands = new Set(['gobilda', 'rev', 'robotics', 'andymark', 'servocity', 'pitsco', 'ftc', 'series']);
const categories = new Set(['motor', 'wheel', 'gear', 'bearing', 'channel', 'bracket', 'shaft', 'servo', 'screw', 'belt', 'pulley']);

export function normalizeSku(value: string, vendor?: VendorId): string {
  let compact = value.toUpperCase().trim().replace(/[\s_-]+/g, '');
  if (vendor) for (const prefix of prefixes[vendor]) if (compact.startsWith(prefix) && compact.length > prefix.length) { compact = compact.slice(prefix.length); break; }
  return compact;
}

export function normalizeName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/)
    .filter(token => token && !brands.has(token))
    .map(token => token.length > 3 && token.endsWith('s') && !token.endsWith('ss') ? token.slice(0, -1) : token)
    .join(' ');
}

/**
 * SKU candidates from the explicit part number (trusted in any format, including numeric-only) and from name tokens.
 * A name token counts only when it looks like a catalog number: letters with 3+ digits (REV-41-1600, am-5185a), or
 * 2+ dash-separated digit groups totalling 8+ digits (goBILDA 5203-2402-0019). Bare numbers and dimensions do not.
 */
export function skuCandidates(name: string, partNumber?: string | null): string[] {
  const tokens = name.match(/\b[a-z0-9]+(?:[-_][a-z0-9]+)*\b/gi) ?? [];
  const looksLikeSku = (token: string) => !/^\d+(?:\.\d+)?(?:mm|cm|in|ft|kg|g|lb|oz|rpm|v)$/i.test(token)
    && ((/\d{3,}/.test(token) && /[a-z]/i.test(token)) || (/^\d+(?:[-_]\d+)+$/.test(token) && token.replace(/\D/g, '').length >= 8));
  const values = [partNumber ?? '', ...tokens.filter(looksLikeSku)];
  return [...new Set(values.filter(Boolean).map(value => normalizeSku(value)).filter(Boolean))];
}

/**
 * A name score can only nominate a candidate. `confirmed` is reserved for a person's decision (MatchDecision),
 * so a fuzzy match never reaches purchasing totals on its own, however high it scores.
 */
export function classifyMatchScore(score: number): MatchResult['status'] {
  return score >= 0.50 ? 'possible' : 'unmatched';
}

const numberTokens = (normalizedName: string) => new Set(normalizedName.split(' ').filter(token => /\d/.test(token)));
/** Two listings name the same product only if their names agree and every size or number token matches (M3 is not M4). */
function sameProductName(a: VendorRecord, b: VendorRecord) {
  const left = numberTokens(a.normalizedName || normalizeName(a.name));
  const right = numberTokens(b.normalizedName || normalizeName(b.name));
  return left.size === right.size && [...left].every(token => right.has(token)) && candidateScore(a.name, b).score >= 0.5;
}
/** The matcher's own name score, for ranking catalog index entries before their records are read. */
export function nameSimilarity(name: string, normalizedName: string) {
  return candidateScore(name, { name: normalizedName, normalizedName } as VendorRecord).score;
}

function candidateScore(name: string, vendor: VendorRecord) {
  const left = new Set(normalizeName(name).split(' ').filter(Boolean));
  const right = new Set((vendor.normalizedName || normalizeName(vendor.name)).split(' ').filter(Boolean));
  const union = new Set([...left, ...right]);
  const intersection = [...left].filter(token => right.has(token));
  let score = union.size ? intersection.length / union.size : 0;
  const reasons = [`name tokens ${intersection.length}/${union.size}`];
  const numbers = (set: Set<string>) => new Set([...set].filter(token => /\d/.test(token)));
  const leftNumbers = numbers(left);
  const rightNumbers = numbers(right);
  if (leftNumbers.size && rightNumbers.size && ([...leftNumbers].some(token => !rightNumbers.has(token)) || [...rightNumbers].some(token => !leftNumbers.has(token)))) { score -= 0.25; reasons.push('number tokens differ (-0.25)'); }
  else if ([...leftNumbers].some(token => rightNumbers.has(token))) { score += 0.15; reasons.push('number token matched (+0.15)'); }
  if ([...left].some(token => categories.has(token) && right.has(token))) { score += 0.10; reasons.push('category keyword matched (+0.10)'); }
  return { score: Math.max(0, Math.min(1, score)), reasons };
}

/** The vendor whose own numbering a SKU follows, when the format says so. */
function makerOf(sku: string): VendorId | null {
  if (/^\d{4}-\d{4}-\d{4}/.test(sku)) return 'gobilda';
  if (/^REV-\d{2}-\d{4}/i.test(sku)) return 'rev';
  if (/^am-\d{3,5}/i.test(sku)) return 'andymark';
  return null;
}

/** Exact normalized SKU takes precedence over every fuzzy score and forces Commercial downstream. */
export function findBestMatch(line: { name: string; partNumber?: string | null }, candidates: VendorRecord[]): MatchResult {
  const skus = skuCandidates(line.name, line.partNumber);
  const exact = candidates.filter(vendor => skus.some(sku => normalizeSku(sku, vendor.vendorId) === vendor.normalizedSku));
  const exactVendors = new Set(exact.map(vendor => vendor.vendorId));
  if (exactVendors.size === 1) {
    const vendor = exact.sort(preferStockThenPrice)[0];
    const from = line.partNumber && normalizeSku(line.partNumber, vendor.vendorId) === vendor.normalizedSku ? 'part number' : 'part name';
    return { vendor, confidence: 1, status: 'exact', reasons: [`exact SKU ${vendor.sku} from ${from}`] };
  }
  if (exactVendors.size > 1) {
    // The maker's own listing wins over resellers of the same number: a goBILDA-format SKU at goBILDA, REV- at REV.
    // Only when every match is the same number: two different numbers on one line are a question, not a reseller.
    const sameNumber = new Set(exact.map(vendor => vendor.sku.replace(/[^a-z0-9]/gi, '').toUpperCase())).size === 1;
    const maker = sameNumber ? exact.filter(vendor => makerOf(vendor.sku) === vendor.vendorId).sort(preferStockThenPrice)[0] : undefined;
    if (maker) {
      const others = [...exactVendors].filter(id => id !== maker.vendorId).join(', ');
      return { vendor: maker, confidence: 1, status: 'exact', reasons: [`exact SKU ${maker.sku} from its maker; also sold by ${others}`] };
    }
    const ranked = exact.sort(preferStockThenPrice);
    const vendor = ranked[0];
    if (!sameNumber) return { vendor, confidence: 0.9, status: 'possible', reasons: [`different SKUs on this part (${[...new Set(exact.map(item => item.sku))].join(', ')}); confirm which one`], choices: ranked };
    // goBILDA products are also sold by ServoCity under the same SKU: one product, several sellers. Only when the
    // product names disagree is the shared number ambiguous, and then a person must say which product it is.
    const sameProduct = ranked.every(other => sameProductName(vendor, other));
    const others = [...exactVendors].filter(id => id !== vendor.vendorId).join(', ');
    if (sameProduct) return { vendor, confidence: 1, status: 'exact', reasons: [`exact SKU ${vendor.sku}; also sold by ${others}`] };
    return { vendor, confidence: 0.9, status: 'possible', reasons: [`SKU ${vendor.sku} names different products at ${[...exactVendors].join(', ')}; confirm which one`], choices: ranked };
  }
  const ranked = candidates.map(vendor => ({ vendor, ...candidateScore(line.name, vendor) }));
  const eligible = ranked.filter(candidate => candidate.score >= 0.5);
  if (!eligible.length) {
    const highest = Math.max(...ranked.map(candidate => candidate.score));
    return { vendor: null, confidence: Number.isFinite(highest) ? highest : 0, status: 'unmatched', reasons: ranked.find(candidate => candidate.score === highest)?.reasons ?? ['no candidates'] };
  }
  const highest = Math.max(...eligible.map(candidate => candidate.score));
  const best = eligible.filter(candidate => highest - candidate.score <= 0.03)
    .sort((a, b) => preferStockThenPrice(a.vendor, b.vendor) || b.score - a.score)[0];
  if (!best || best.score < 0.5) return { vendor: null, confidence: best?.score ?? 0, status: 'unmatched', reasons: best?.reasons ?? ['no candidates'] };
  return { vendor: best.vendor, confidence: best.score, status: classifyMatchScore(best.score), reasons: best.reasons };
}

export function rankVendorAlternatives(lineName: string, selected: VendorRecord | null, candidates: VendorRecord[]): VendorRecord[] {
  if (!selected || !['out', 'low'].includes(selected.stock)) return [];
  const distinct = new Map(candidates.filter(candidate => candidate.vendorId === selected.vendorId
    && candidate.category.toLowerCase() === selected.category.toLowerCase()
    && candidate.normalizedSku !== selected.normalizedSku && candidate.stock === 'in' && candidate.priceUsd !== null)
    .map(candidate => [candidate.normalizedSku, candidate]));
  return [...distinct.values()].sort((a, b) => candidateScore(lineName, b).score - candidateScore(lineName, a).score
    || a.priceUsd! - b.priceUsd! || a.name.localeCompare(b.name)).slice(0, 3);
}

function preferStockThenPrice(a: VendorRecord, b: VendorRecord) {
  const availability = (record: VendorRecord) => record.stock === 'in' ? 2 : record.stock === 'low' ? 1 : 0;
  return availability(b) - availability(a) || (a.priceUsd ?? Infinity) - (b.priceUsd ?? Infinity) || a.name.localeCompare(b.name);
}
