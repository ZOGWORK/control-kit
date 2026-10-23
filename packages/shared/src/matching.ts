export type VendorId = 'gobilda' | 'servocity' | 'andymark' | 'rev' | 'pitsco';
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
  updatedAt: string;
  source: 'feed' | 'sitemap' | 'scrape';
};
export type MatchResult = { vendor: VendorRecord | null; confidence: number; status: 'unmatched' | 'possible' | 'confirmed' | 'exact'; reasons: string[] };

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

export function skuCandidates(name: string, partNumber?: string | null): string[] {
  const values = [partNumber ?? '', ...name.match(/\b(?=[a-z0-9_-]*\d{3,})[a-z0-9]+(?:[-_][a-z0-9]+)*\b/gi) ?? []];
  return [...new Set(values.filter(Boolean).map(value => normalizeSku(value)))];
}

export function classifyMatchScore(score: number): MatchResult['status'] {
  return score >= 0.72 ? 'confirmed' : score >= 0.50 ? 'possible' : 'unmatched';
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
  if ([...leftNumbers].some(token => rightNumbers.has(token))) { score += 0.15; reasons.push('number token matched (+0.15)'); }
  else if (leftNumbers.size && rightNumbers.size) { score -= 0.25; reasons.push('number tokens differ (-0.25)'); }
  if ([...left].some(token => categories.has(token) && right.has(token))) { score += 0.10; reasons.push('category keyword matched (+0.10)'); }
  return { score: Math.max(0, Math.min(1, score)), reasons };
}

/** Exact normalized SKU takes precedence over every fuzzy score and forces Commercial downstream. */
export function findBestMatch(line: { name: string; partNumber?: string | null }, candidates: VendorRecord[]): MatchResult {
  const skus = skuCandidates(line.name, line.partNumber);
  const exact = candidates.filter(vendor => skus.some(sku => normalizeSku(sku, vendor.vendorId) === vendor.normalizedSku));
  if (exact.length) {
    const vendor = exact.sort(preferStockThenPrice)[0];
    return { vendor, confidence: 1, status: 'exact', reasons: ['exact normalized SKU'] };
  }
  const ranked = candidates.map(vendor => ({ vendor, ...candidateScore(line.name, vendor) }));
  const highest = Math.max(...ranked.map(candidate => candidate.score));
  const best = ranked.filter(candidate => highest - candidate.score <= 0.03)
    .sort((a, b) => preferStockThenPrice(a.vendor, b.vendor) || b.score - a.score)[0];
  if (!best || best.score < 0.5) return { vendor: null, confidence: best?.score ?? 0, status: 'unmatched', reasons: best?.reasons ?? ['no candidates'] };
  return { vendor: best.vendor, confidence: best.score, status: classifyMatchScore(best.score), reasons: best.reasons };
}

function preferStockThenPrice(a: VendorRecord, b: VendorRecord) {
  const availability = (record: VendorRecord) => record.stock === 'in' ? 2 : record.stock === 'low' ? 1 : 0;
  return availability(b) - availability(a) || (a.priceUsd ?? Infinity) - (b.priceUsd ?? Infinity) || a.name.localeCompare(b.name);
}
