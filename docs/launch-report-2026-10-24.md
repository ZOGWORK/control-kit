# Control Kit launch report (2026-10-24/25)

What was checked end to end against production, what it showed, and what is still open. "Verified" means run against the live Worker and app with the real HORS robot (team 4215, "HORS 25-26 / MR. HORS"), unless a line says otherwise.

## Production

- App: https://control-kit.pages.dev, opened from the Onshape Assembly right panel.
- Worker: https://control-kit.control-kit-worker.workers.dev.
- Deployed from `main` after every merge below.

## Merged pull requests

Each one merged only after Greptile scored its exact head commit 5/5 with no unresolved threads.

| PR | What |
|---|---|
| [#13](https://github.com/ZOGWORK/control-kit/pull/13) | Onshape request ledger, catalog health, CI baseline |
| [#14](https://github.com/ZOGWORK/control-kit/pull/14) | Incremental vendor catalogs; fuzzy matches are candidates only |
| [#15](https://github.com/ZOGWORK/control-kit/pull/15) | Scan through Onshape's BOM in three requests |
| [#16](https://github.com/ZOGWORK/control-kit/pull/16) | Manufacturing disposition with evidence and shared overrides |
| [#17](https://github.com/ZOGWORK/control-kit/pull/17), [#18](https://github.com/ZOGWORK/control-kit/pull/18) | STEP export job (replaces STL); paced polls and rate-limit waits |
| [#19](https://github.com/ZOGWORK/control-kit/pull/19) | UI redesign in the Control apps' style |
| [#20](https://github.com/ZOGWORK/control-kit/pull/20) | Six-sheet Excel workbook with a Links sheet |
| [#21](https://github.com/ZOGWORK/control-kit/pull/21) | Shopify product feeds (AndyMark, Pitsco) and hourly crawls |
| [#22](https://github.com/ZOGWORK/control-kit/pull/22), [#23](https://github.com/ZOGWORK/control-kit/pull/23) | Vendor kits as one part, fasteners set aside, part pictures, Show in Onshape |
| [#24](https://github.com/ZOGWORK/control-kit/pull/24) | Official-feed import, staged catalog publish with validation, library mapping and licensed-image slots |
| [#25](https://github.com/ZOGWORK/control-kit/pull/25) | Pack size from vendor evidence |
| [#26](https://github.com/ZOGWORK/control-kit/pull/26) | Catalog matching moved to the browser (production scans exceeded the Worker CPU limit) |
| [#27](https://github.com/ZOGWORK/control-kit/pull/27) | Orders priced per SKU, maker preferred, Pack Info scoped to the page's own product |

**Checks.** Every PR passed lint, typecheck, unit tests (183 at the end), build, and the Playwright browser tests (8) locally. GitHub Actions did not run any of them: ZOGWORK's jobs are refused before they start ("recent account payments have failed or your spending limit needs to be increased").

## HORS end to end

- **Scan in the real Onshape panel.** The app loads in the Assembly right panel, is already connected, and scans HORS. A scan reads 3 Onshape requests, or 1 when the workspace is unchanged.
- **Onshape BOM agreement.** 180 of 193 part lines match a BOM row, with **0 quantity mismatches**. The rest are kit internals that Onshape's BOM also leaves out.
- **Final list** (production, all five catalogs live, matching in the browser; the owner's description of HORS: "mainly goBILDA and a couple REV parts; other stuff is either 3D printed or fabricated"):

| | First scan (2026-10-24 morning) | Final |
|---|---|---|
| Part lines | 193 | 130 (15 vendor kits now one line each) |
| Exact vendor matches | 0 | 51 (47 goBILDA, 4 REV bodies of one switch) |
| Vendors in the Buy list | none | **goBILDA, REV** |
| Buy lines priced | 0 | **51 of 53** |
| Known subtotal | none | **$1,991.63** |
| Needs review | 163 | 66 (the team's own plates, wedges, and similar parts) |
| Make | 11 | 8 prints (3 REV parts that were "prints" by material are now Buy by exact SKU) |

- **Purchasing checks on the final list:**
  - 43 M4×12 screws on 3 CAD lines → **2 packs of 25** ($7.18).
  - Four 1611 bearings in four elements → **2 packs of 2**.
  - The REV magnetic limit switch (four bodies, part number REV-31-1462) → **1 product**.
  - goBILDA parts that ServoCity resells → **goBILDA**.
  - Single items show pack of 1 under the verified single-unit rule. The 1613 thrust bearing and 1106 beam were checked by hand: one piece's weight, no pack wording.
- **Still open on HORS:**
  - "24mm × 6mm Round Standoff" has no SKU.
  - "Control Hub REV-31-1152" uses a part number REV no longer sells (the current Control Hub is REV-31-1595).
  - Four "[LS]" screws are listed under Fasteners.

## Vendor catalogs

| Vendor | Source | Live SKUs | Load |
|---|---|---|---|
| goBILDA | BigCommerce sitemap → product pages | 1,991 | Local crawl, 2,387 pages in 22¾ min |
| ServoCity | BigCommerce sitemap → product pages | 4,318 | Local crawl, 5,152 pages in 46 min (re-crawled after the Pack Info fix) |
| AndyMark | Shopify `/products.json` | 5,313 | 9 feed requests in 27 s |
| REV | BigCommerce sitemap → product pages | 278 | Local crawl, 390 pages in 3½ min |
| Pitsco | Shopify `/products.json` | 1,625 | Hourly Worker cron |

- **How each was loaded.** Through `scripts/catalog-load.ts`: staged as a new generation, validated, then published with the previous generation kept for 24 h of rollback. Validation means:
  - read-back of every batch;
  - no more than 20% smaller than a complete live catalog;
  - expected SKUs present;
  - 20 random records checked against the vendor's live page.

  All passed. One REV mismatch turned out to be the checker missing "$2,000.00" formatting; that is fixed.
- **No faster public source for BigCommerce.** goBILDA, REV and ServoCity are BigCommerce stores: `/products.json` returns 404, and they expose no public product API. The sitemap lists URLs only, so each product page is read once, at 2 requests per second.
- **Pack sizes**, decided from data:
  - the product's own wording;
  - ServoCity's "Pack Info" field for the page's own product only;
  - REV `-PKn` SKUs;
  - otherwise one unit for goBILDA, REV and ServoCity, whose catalogs name every multi-unit product. All 186 ServoCity screw, nut and washer products carry their own pack evidence.

  AndyMark and Pitsco totals stay blank without stated packs.
- **REV gap.** 112 of REV's 390 pages are option-picker families whose variant SKUs only exist in REV's storefront API, which was not used without permission. REV's official feed would close it.

## Exports

- **Excel** (downloaded from the deployed app on HORS and opened in Excel):
  - six sheets (Overview, Buy list, Make, Review, Links, Exceptions), logo embedded, no repair prompt;
  - live subtotal formulas that read "None priced" when nothing is priced;
  - the Links sheet links every part to Onshape and matched parts to their vendor page;
  - the synthetic 12 screws / 10-pack / $8.99 case gives 2 packs, $17.98.
- **STEP:** 10 of 11 HORS print parts exported in the live run. **PrusaSlicer 2.9.6 imported all 10**: one manifold part each at real size, e.g. the pulley base at 169.8 × 169.8 × 21 mm.
- **Part pictures.** Onshape's render of a part or a whole kit came back in 2 s the first time and 16 ms from cache.

## Incident during verification

With all five catalogs live, production scans failed: "Worker exceeded CPU time limit", the free plan's 10 ms. Matching HORS against about 13,800 SKUs took about 900 ms of CPU. PR #26 moved matching to the browser: the Worker serves stored catalog keys and the panel matches in about a second. After the fix, catalog requests use about 1 ms of Worker CPU each. The scan itself used 76 ms reading HORS's assembly and was allowed. Very large assemblies may still approach the free plan's limit; that is the one case where Workers Paid ($5/month) would matter.

## Onshape requests

The Developer page read **144 / 2,500** after the first day's checks and was 98 before the rework. The Worker ledger counts 49 billable requests for the rework's live checks, so the counter should now read about 147. Automated tests made none.

## Not verified

- **"Show its tab in Onshape" inside the panel.** The browser pane used here is too narrow for Onshape's panel, so the button could not be clicked in place. It sends Onshape's documented `openAnotherElementInCurrentWorkspace` message.
- **Control Point** remains an interface with an in-memory adapter by design: no network calls.

## Owner-only

1. **GitHub billing** for ZOGWORK, so Actions runs CI again.
2. **Outreach** (in progress by the owner): official feeds import with `scripts/catalog-load.ts`, library mappings go into `library-map:{documentId}`. Worth asking REV about its storefront API for option-picker products.
3. **Onshape App Store listing**, which removes the 2,500-request yearly limit.
