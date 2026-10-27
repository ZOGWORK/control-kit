# Onshape App Store listing

Copy and images for Control Kit's App Store entry. Paste them into Control Kit's store entry in the Onshape Developer Portal, signed in as the app's owner. Onshape reviews the entry before it is public.

Every screenshot is the live app on the HORS assembly (MR. HORS, HORS 25-26) as scanned on 2026-10-26: 119 parts, 61 to buy, 55 to make, none waiting for review, $1,768.05 priced from 50 of 61 buy lines. They were rendered in the refreshed UI (2026-10-26) from that scan and the production vendor catalogs at 2560 × 1600 (the panel view at 840 × 1720), so they show exactly what a team sees. `5-scan.png` is a real capture of Onshape (2000 × 1000) with the panel scanning HORS beside the model. Onshape publishes no image sizes for listings; these are large enough to be scaled down.

## Name

Control Kit

## Summary (one line)

Turn an FTC assembly into a bill of materials: what to buy, with vendor prices, and what to make, with STEP files.

## Description

Control Kit reads your assembly and Onshape's bill of materials, then sorts every part into what your team buys and what it makes.

- **Every part, sorted.** Vendor part numbers, standard hardware, linked libraries, and team tags such as "(3D PRINT)" decide most parts automatically. Fasteners are listed on their own. A part Control Kit can't decide waits in Review, and your team's choices are saved with the document for everyone who scans it.
- **A buy list with real prices.** Parts are matched by SKU against the goBILDA, REV, ServoCity, AndyMark, and Pitsco catalogs. Orders round up to whole packs, and a part is priced only when its match, pack size, and price are all verified, so the total never looks complete when it isn't. Prices are public list prices before shipping, tax, or team discounts.
- **STEP files for everything you make.** 3D-printed, CNC, and 2D-cut parts download as one ZIP of STEP files straight from Onshape, with a manifest of sources and quantities.
- **Every decision explained.** Each part shows its picture from Onshape and why it was sorted the way it was. One click changes it for the whole team.
- **A workbook to order from.** The Excel workbook has the buy list with live totals, the make list, the parts still to review, and links to every product and Part Studio. A CSV is there too.

Control Kit only reads documents; it never edits your CAD. A scan uses about three Onshape API requests, and a rescan of an unchanged assembly uses one.

## Screenshots, in order, with captions

| File | Caption |
| --- | --- |
| `1-overview.png` | Every part of the robot, sorted into buy and make, with the known cost so far. |
| `2-buy-list.png` | A buy list matched to vendor SKUs, rounded to whole packs, priced only when verified. |
| `3-part-details.png` | Each part's picture from Onshape and the evidence behind its decision. |
| `4-make-list.png` | Parts to print and cut, ready to download as STEP files. |
| `5-scan.png` | Right beside your model in Onshape, a scan reads the assembly, its bill of materials, and the vendor catalogs in seconds. |
| `6-onshape-panel.png` | The same view in Onshape's right panel, beside your assembly. |

Feature graphic: `feature-graphic.png` (2400 × 1260; also served at 1200 × 630 as the site's share image).

## Links

- Website and install steps: https://control-kit.pages.dev
- Privacy (what Control Kit reads and stores): https://control-kit.pages.dev/#data
- Support: https://github.com/ZOGWORK/control-kit/issues
- Sign-in (OAuth) URL: `https://control-kit.control-kit-worker.workers.dev/oauth/start`

## Permissions to explain

- **Read your profile** (`OAuth2ReadPII`): your name, shown in the panel as who is signed in. Only your id and name are kept.
- **Read your documents** (`OAuth2Read`): the assembly, its bill of materials, part pictures, and STEP exports.

## After the listing is public

Set `listed = true` in `apps/web/src/app/Landing.tsx` so the site stops saying the listing is pending, and consider linking the listing itself in place of the App Store home page.
