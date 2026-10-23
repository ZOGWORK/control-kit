import { describe, expect, it } from 'vitest';
import { classifyMatchScore, findBestMatch, normalizeName, normalizeSku, skuCandidates, type VendorId, type VendorRecord } from './matching';

const record = (name: string, sku: string, vendorId: VendorId = 'rev', overrides: Partial<VendorRecord> = {}): VendorRecord => ({
  vendorId, sku, normalizedSku: normalizeSku(sku, vendorId), name, normalizedName: normalizeName(name), url: 'https://vendor.example/product',
  priceUsd: 8, packSize: null, packSizeVerified: false, stock: 'in', stockQty: null, category: 'hardware', updatedAt: '2026-10-23T00:00:00Z', source: 'feed', ...overrides,
});

describe('SKU and name normalization', () => {
  it.each([['GB-5203', 'gobilda', '5203'], ['SC_1234', 'servocity', '1234'], ['AM 4567', 'andymark', '4567'], ['REV-31-1234', 'rev', '311234'], ['PIT-4321', 'pitsco', 'PIT4321']])('strips only the configured prefix for %s', (input, vendor, expected) => expect(normalizeSku(input, vendor as VendorId)).toBe(expected));
  it('preserves token order while removing brands and singularizing plurals', () => {
    expect(normalizeName('REV Robotics 96mm Wheels, FTC Series')).toBe('96mm wheel');
    expect(normalizeName('Wheel 96mm')).toBe('wheel 96mm');
  });
  it('extracts explicit part numbers and SKU-like name tokens', () => expect(skuCandidates('REV-31-1234 Bearing', 'AM-5203')).toEqual(['AM5203', 'REV311234']));
  it('does not make a dimension an exact SKU', () => expect(skuCandidates('1000 mm rail and 1000mm rail')).toEqual([]));
});

describe('vendor matching', () => {
  it('makes an exact normalized SKU decisive even when names disagree', () => {
    const match = findBestMatch({ name: 'Custom 3D Printed Bracket', partNumber: 'REV-31-1234' }, [record('Planetary Motor', '31-1234')]);
    expect(match.status).toBe('exact');
    expect(match.confidence).toBe(1);
  });
  it('penalizes conflicting number tokens', () => {
    const match = findBestMatch({ name: '96mm wheel' }, [record('84mm wheel', 'other')]);
    expect(match.confidence).toBeLessThan(0.5);
    expect(match.reasons).toContain('number tokens differ (-0.25)');
    const size = findBestMatch({ name: 'M3 10mm screw' }, [record('M3 20mm screw', 'SKU-A')]);
    expect(size.status).not.toBe('confirmed');
    expect(size.reasons).toContain('number tokens differ (-0.25)');
  });
  it('uses exact threshold edges', () => {
    expect(classifyMatchScore(0.49)).toBe('unmatched');
    expect(classifyMatchScore(0.50)).toBe('possible');
    expect(classifyMatchScore(0.71)).toBe('possible');
    expect(classifyMatchScore(0.72)).toBe('confirmed');
  });
  it('breaks close ties by availability and then price', () => {
    const out = record('96mm Wheel', 'OUT', 'rev', { stock: 'out', priceUsd: 2 });
    const inStock = record('96mm Wheel', 'IN', 'rev', { stock: 'in', priceUsd: 9 });
    expect(findBestMatch({ name: '96mm Wheel' }, [out, inStock]).vendor?.sku).toBe('IN');
    const cheap = record('96mm Wheel', 'CHEAP', 'rev', { priceUsd: 5 });
    expect(findBestMatch({ name: '96mm Wheel' }, [inStock, cheap]).vendor?.sku).toBe('CHEAP');
  });
  it('selects close ties relative to the highest score regardless of index order', () => {
    const words = Array.from({ length: 50 }, (_, index) => String.fromCharCode(97 + Math.floor(index / 26), 97 + index % 26));
    const target = words.join(' ');
    const low = record('Low', 'LOW', 'rev', { normalizedName: words.slice(0, 25).join(' '), stock: 'in', priceUsd: 1 });
    const middle = record('Middle', 'MID', 'rev', { normalizedName: words.slice(0, 26).join(' '), stock: 'in', priceUsd: 2 });
    const high = record('High', 'HIGH', 'rev', { normalizedName: words.slice(0, 27).join(' '), stock: 'out', priceUsd: 3 });
    for (const candidates of [[low, middle, high], [high, low, middle], [middle, high, low]]) {
      expect(findBestMatch({ name: target }, candidates).vendor?.sku).toBe('MID');
    }
  });
  it('never lets a subthreshold in-stock item hide a possible match', () => {
    const valid = record('Flanged steel radial bearing', 'VALID', 'rev', { stock: 'out' });
    const weak = record('8mm', 'WEAK', 'rev', { stock: 'in' });
    const result = findBestMatch({ name: '8mm flanged bearing' }, [weak, valid]);
    expect(result.status).toBe('possible');
    expect(result.vendor?.sku).toBe('VALID');
  });
});
