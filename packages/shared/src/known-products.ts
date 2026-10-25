import type { VendorId, VendorRecord } from './matching';

/**
 * FTC products teams model under their plain product name, with the vendor SKUs they are sold as. Each SKU was looked up
 * in the live vendor catalogs on 2026-10-25. When a name fits more than one product (Pinpoint V1 and V2), every one is
 * listed and a person picks; nothing is guessed. A name only counts when it is the product's own name: "Pinpoint case"
 * or "Axon mount" is a part the team makes.
 */
type KnownProduct = { product: string; name: RegExp; skus: Array<[VendorId, string]> };
const knownProducts: KnownProduct[] = [
  { product: 'goBILDA Pinpoint Odometry Computer', name: /^(?:gobilda )?pinpoint(?: odometry)?(?: computer)?$/, skus: [['gobilda', '3110-0002-0001'], ['gobilda', '3110-0002-0002']] },
  { product: 'goBILDA Pinpoint V2 Odometry Computer', name: /^(?:gobilda )?pinpoint(?: odometry)?(?: computer)? v2$/, skus: [['gobilda', '3110-0002-0002']] },
  { product: 'goBILDA Swingarm Odometry Pod', name: /^(?:gobilda )?swing ?arm odometry pod$/, skus: [['gobilda', '3110-0001-0001']] },
  { product: 'goBILDA 4-Bar Odometry Pod', name: /^(?:gobilda )?4 ?bar odometry pod$/, skus: [['gobilda', '3110-0001-0002']] },
  { product: 'Axon MAX Servo', name: /^axon max(?: servo)?(?: mk ?2)?$/, skus: [['gobilda', '2004-0025-0002']] },
  { product: 'Axon MINI Servo', name: /^axon mini(?: servo)?(?: mk ?2)?$/, skus: [['gobilda', '2004-0025-0001']] },
  { product: 'Limelight 3A', name: /^limelight(?: 3a)?(?: smart)?(?: camera)?$/, skus: [['gobilda', '3122-0002-0001']] },
  { product: 'REV Control Hub', name: /^(?:rev )?control hub$/, skus: [['rev', 'REV-31-1595']] },
  { product: 'REV Expansion Hub', name: /^(?:rev )?expansion hub$/, skus: [['rev', 'REV-31-1153']] },
  { product: 'REV Color Sensor V3', name: /^(?:rev )?colou?r sensor(?: v3)?$/, skus: [['rev', 'REV-31-1557']] },
  { product: 'REV 2m Distance Sensor', name: /^(?:rev )?2 ?m distance sensor$/, skus: [['rev', 'REV-31-1505']] },
  { product: 'REV Through Bore Encoder', name: /^(?:rev )?through ?bore encoder$/, skus: [['rev', 'REV-11-3174'], ['rev', 'REV-11-1271']] },
  { product: 'REV Through Bore Encoder V2', name: /^(?:rev )?through ?bore encoder v2$/, skus: [['rev', 'REV-11-3174']] },
];

/** The product a part or subassembly name denotes, and its SKUs, or null. */
export function knownProduct(name: string): { product: string; skus: Array<[VendorId, string]> } | null {
  const plain = name.toLowerCase()
    .replace(/\s*<\d+>\s*$/, '').replace(/\(\d+\)/g, ' ').replace(/[[\]()™®]/g, ' ')
    .replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  const found = knownProducts.find(entry => entry.name.test(plain));
  return found ? { product: found.product, skus: found.skus } : null;
}

/**
 * Pack sizes vendors leave unstated but every FTC team knows: a mecanum wheel set is four wheels (two left, two right).
 * It replaces only an unverified pack or the "sold individually" convention, never wording on the product page.
 */
export function withKnownPack(record: VendorRecord): VendorRecord {
  if (record.packSizeVerified && !record.packEvidence?.startsWith('sold individually')) return record;
  // Roller sets, pairs, and intake wheels are other products; parenthesized details ("Bearing Supported Rollers") are not.
  const product = record.name.replace(/\([^)]*\)/g, ' ');
  if (/\bmecanum\b.*\bset\b/i.test(record.name) && !/\b(?:roller|pair|half|replacement|intake)s?\b/i.test(product)) {
    return { ...record, packSize: 4, packSizeVerified: true, packEvidence: 'a mecanum wheel set is 4 wheels (2 left, 2 right)' };
  }
  return record;
}
