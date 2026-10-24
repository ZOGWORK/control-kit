# Live HORS scan — 2026-10-24

The first live scan through the BOM-based flow (PR 3), plus the manufacturing model (PR 4). It ran in the owner's signed-in Onshape session from the Control Kit app opened with the HORS 25-26 assembly context. Only counts and structural facts are recorded here; part data stays in Onshape.

## Requests

| Step | Requests | Status |
|---|---|---|
| OAuth profile on connect (`/users/sessioninfo`) | 1 | 200 |
| Current microversion | 1 | 200 |
| Assembly definition at that microversion | 1 | 200 |
| Flattened BOM at that microversion | 1 | 200 |
| **Total** | **4 billable** | |

The Onshape Developer counter read **98 / 2,500** on the personal account before this work. The earlier "16" reading was taken during a scan, and that scan's per-part mass-properties requests account for most of the difference. The new flow scans HORS in **3** requests, compared with about 190 before.

## Result

- Assembly **MR. HORS**, document **HORS 25-26**, read at an immutable microversion; the cache missed on this first scan.
- **193 unique lines, 1,181 active instances, 4 suppressed.** The totals match the earlier scan.
- **BOM reconciliation:**
  - 182 BOM rows.
  - **180 of 193 lines matched, with 0 quantity mismatches** against Onshape's own BOM.
  - 13 active lines are not in the BOM. These are likely excluded items or a subassembly's BOM behaviour; to be inspected.
  - 2 BOM rows have no line.
- **Missing metadata: 14** specific issues (13 `not-in-bom`, 1 unresolved suppressed subassembly), down from 194 "mass unavailable" flags.
- **Column mapping confirmed.** Real `propertyName`s are `partNumber` (string), `description` (string), `vendor` (string), `material` (object), `quantity` (number), and `name` (string), exactly the aliases in `packages/shared/src/bom.ts`. The BOM template also has `category` (array) and `appearance` (object), which are not used yet.
- **Part data:**
  - 22 lines have part numbers. Examples are goBILDA SKUs (`1501-0006-0320`, `2802-0004-0012`, `1121-0010-0264`) and REV SKUs (`REV-31-1152`, `REV-31-1462`).
  - One part number is free text (`24mm × 6mm Round Standoff`).
  - 19 lines have a Vendor property, 33 a material, and 21 a description.
- **Provenance:** 89 lines are team-designed (modelled in HORS 25-26), 104 are linked from other documents, and 0 are Onshape standard content.
- **Dispositions (PR 4 rules, no catalog yet):**
  - 11 are *3D print*, decided by the team's `(3D PRINT)` name prefix as explicit metadata.
  - 19 are *Buy*: linked parts with a part number, or the Vendor property.
  - 163 are *Needs review*, mostly linked library parts without a part number and team parts without process information.
- **Catalog health:** correctly reports goBILDA, AndyMark, REV, and Pitsco as *building* and ServoCity as *failing*. No catalog was published at scan time.

## Findings to act on

1. **Export source.** Every line lacked an export source in this scan, because the export source code had not been deployed yet. The next live check after PR 5 deploys must confirm that the 104 linked lines carry a `documentVersion` (or BOM `wvmType` `v`). Without it, STEP export cannot read them.
2. **Unused evidence.** The Vendor property and part number together are stronger evidence than "linked with a part number". Mapping `vendor` into provenance, and checking whether `category` marks purchased parts, should cut the review queue.
3. **The 13 `not-in-bom` lines** need a look against Onshape's BOM settings: excluded items and "Subassembly BOM behavior".
