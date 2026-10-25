import { describe, expect, it } from 'vitest';
import { classifyMatchScore, configurationValues, findBestMatch, vendorTag, normalizeName, normalizeSku, rankVendorAlternatives, skuCandidates, type VendorId, type VendorRecord } from './matching';

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
  it('recognizes dashed all-digit goBILDA SKUs in names but not bare numbers or ratios', () => {
    expect(skuCandidates('5203-2402-0019 Yellow Jacket Motor')).toEqual(['520324020019']);
    expect(skuCandidates('Bracket 1120 19-2 ratio 312rpm 44260')).toEqual([]);
    expect(skuCandidates('TorqueNADO', '44260')).toEqual(['44260']);
  });
  it('takes a goBILDA SKU from goBILDA even when ServoCity resells it cheaper, and asks when one SKU names different products', () => {
    const record = (vendorId: VendorId, sku: string, name: string, priceUsd = 5): VendorRecord => ({ vendorId, sku, normalizedSku: normalizeSku(sku, vendorId), name, normalizedName: normalizeName(name), url: 'https://example.test/', priceUsd, packSize: 1, packSizeVerified: true, stock: 'in', stockQty: null, category: 'gear', updatedAt: '2026-10-24T00:00:00Z', source: 'sitemap' });
    const worm = 'Worm Gear Set (28:1 Ratio, 8mm REX Bore Worm)';
    const shared = findBestMatch({ name: 'Worm gear', partNumber: '3204-0001-0002' }, [record('gobilda', '3204-0001-0002', worm, 36.99), record('servocity', '3204-0001-0002', worm, 34.99)]);
    expect(shared).toMatchObject({ status: 'exact', vendor: { vendorId: 'gobilda' }, reasons: ['exact SKU 3204-0001-0002 from its maker; also sold by servocity'] });
    // Two different numbers, each at its maker, are a question for a person.
    const conflict = findBestMatch({ name: 'Bracket REV-41-1300', partNumber: 'am-1234' }, [record('rev', 'REV-41-1300', 'Bracket'), record('andymark', 'am-1234', 'Bracket')]);
    expect(conflict.status).toBe('possible');
    // A reseller-only number with the same product at two stores stays exact, at the in-stock cheaper one.
    const resold = findBestMatch({ name: 'Worm gear', partNumber: '555-1234' }, [record('servocity', '555-1234', worm, 34.99), record('andymark', '555-1234', worm, 36.99)]);
    expect(resold).toMatchObject({ status: 'exact', vendor: { vendorId: 'servocity' } });
    const sizes = findBestMatch({ name: 'Screw', partNumber: '2800-0003' }, [record('servocity', '2800-0003', 'Stainless Steel Socket Head Cap Screw M3'), record('andymark', '2800-0003', 'Stainless Steel Socket Head Cap Screw M4')]);
    expect(sizes.status).toBe('possible');
    const clash = findBestMatch({ name: 'Part', partNumber: '1309-0016' }, [record('gobilda', '1309-0016', '1309 Series Sonic Hub'), record('pitsco', '1309-0016', 'Classroom Battery Charger')]);
    expect(clash.status).toBe('possible');
    expect(clash.reasons[0]).toContain('names different products');
    expect(findBestMatch({ name: 'Hub', partNumber: '1309-0016' }, [record('gobilda', '1309-0016', 'Hub')]).reasons).toEqual(['exact SKU 1309-0016 from part number']);
  });
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
    // Only a person confirms: even a perfect name score stays a candidate.
    expect(classifyMatchScore(0.72)).toBe('possible');
    expect(classifyMatchScore(1)).toBe('possible');
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
  it('ranks only in-stock alternatives from the same vendor and category for low/out lines', () => {
    const selected = record('M3 10mm screw', 'OUT', 'rev', { stock: 'out' });
    const near = record('M3 10mm screw stainless', 'NEAR', 'rev', { priceUsd: 5 });
    const distant = record('M4 20mm screw', 'DISTANT', 'rev', { priceUsd: 2 });
    const otherVendor = record('M3 10mm screw', 'OTHER', 'andymark');
    const otherCategory = record('M3 10mm screw', 'CAT', 'rev', { category: 'motors' });
    const out = record('M3 10mm screw', 'OUT2', 'rev', { stock: 'out' });
    expect(rankVendorAlternatives(selected.name, selected, [distant, otherVendor, otherCategory, near, out]).map(value => value.sku)).toEqual(['NEAR', 'DISTANT']);
    expect(rankVendorAlternatives(selected.name, { ...selected, stock: 'in' }, [near])).toEqual([]);
  });
});

describe('parts library tags', () => {
  it('reads a trailing vendor tag and configuration values that describe the product', () => {
    expect(vendorTag('Servo Hub (GB)')).toEqual({ vendor: 'gobilda', name: 'Servo Hub' });
    expect(vendorTag('Control Hub (REV)')).toEqual({ vendor: 'rev', name: 'Control Hub' });
    expect(vendorTag('Bracket (GB) left')).toBeNull();
    expect(vendorTag('(GB)')).toBeNull();
    expect(configurationValues('Encoder_Cap_Color=4D4D4D;List_a1=_6000rpm_Bare_REX;Length=default')).toEqual(['6000rpm Bare REX']);
  });
});
