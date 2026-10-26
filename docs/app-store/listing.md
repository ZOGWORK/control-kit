# Onshape App Store listing

Everything Control Kit's store entry needs, ready to paste into the Onshape Developer Portal (My account → Developer → OAuth applications → Control Kit → Store entry). The owner signs in and submits; nothing here is sent automatically.

Every screenshot is the live app on the HORS assembly (MR. HORS, HORS 25-26), scanned from Onshape and matched against the production vendor catalogs, rendered with the current interface on 2026-10-26: 119 parts, 61 to buy, 55 to make, none waiting for review, $1,768.05 priced from 50 of 61 buy lines. No numbers are made up.

## What Onshape asks for

Onshape's docs list the store entry fields and the Launch Checklist but publish no image sizes, word limits, or fees. Sources: [My account, Developer](https://cad.onshape.com/help/Content/Plans/my_account_developer.htm), [Launch Checklist](https://onshape-public.github.io/docs/app-store/checklist/), [Testing Guidelines](https://onshape-public.github.io/docs/app-store/testingguidelines/), [Quality Considerations](https://onshape-public.github.io/docs/app-store/quality/).

| Field | Value |
| --- | --- |
| Name | Control Kit (set from the OAuth app) |
| Summary | Set from the OAuth app; see "Summary" below for the recommended text |
| Type | Integrated Cloud App |
| Category | The closest the portal offers; Onshape doesn't publish its list (Data Management or Utilities are likely fits) |
| Team visibility | None until the public release |
| Description | See "Description" below |
| Support URL | https://control-kit.pages.dev/support |
| Support email | An address the owner reads; Onshape sends subscription notices there and requires it to be monitored |
| Vendor | ZOGWORK |
| Version | 1.0 |
| Pricing | Free |
| EULA / terms | https://control-kit.pages.dev/terms |
| Privacy | https://control-kit.pages.dev/privacy |
| Images | Icon, feature graphic, and six screenshots, listed below |

## Summary

Turn an FTC robot assembly into a bill of materials: what to buy, with vendor prices, and what to make, with STEP files.

## Tagline

Your robot's BOM, straight from Onshape.

## Description

Control Kit reads your assembly and Onshape's bill of materials, then sorts every part into what your team buys and what it makes. It is built for FIRST Tech Challenge teams and the parts they use.

- **Every part, sorted.** Vendor part numbers, standard hardware, linked libraries, and team tags such as "(3D PRINT)" decide most parts automatically. Fasteners are listed on their own. A part Control Kit can't decide waits in Review, and your team's choices are saved with the document for everyone who scans it.
- **A buy list with real prices.** Parts are matched by SKU against the goBILDA, REV, ServoCity, AndyMark, and Pitsco catalogs. Orders round up to whole packs, and a part is priced only when its match, pack size, and price are all verified, so the total never looks complete when it isn't.
- **STEP files for everything you make.** 3D-printed, CNC, and 2D-cut parts download as one ZIP of STEP files straight from Onshape, with a manifest of sources and quantities.
- **Every decision explained.** Each part shows its picture from Onshape and why it was sorted the way it was. One click changes it for the whole team.
- **A workbook to order from.** The Excel workbook has the buy list with live totals, the make list, the parts still to review, and links to every product and Part Studio. A CSV is there too.

Control Kit only reads your documents and never edits your CAD. A scan uses about three Onshape API requests, and a rescan of an unchanged assembly uses one. Prices are public list prices before shipping, tax, or team discounts.

Control Kit is free. Privacy: https://control-kit.pages.dev/privacy. Help: https://control-kit.pages.dev/support.

## Features (short list, for any field that wants bullets)

- Sorts every part into buy, make, fastener, or review
- Matches parts by SKU to goBILDA, REV, ServoCity, AndyMark, and Pitsco
- Rounds orders to whole packs and prices only verified matches
- Downloads STEP files for printed, CNC, and 2D-cut parts
- Saves your team's choices with the document
- Exports an Excel workbook and a CSV
- Runs in the assembly's right panel; read-only

## Privacy and data handling

Matches what the Worker does (see the [privacy page](https://control-kit.pages.dev/privacy) and `apps/web/src/app/Policies.tsx`).

- Reads your Onshape name and id, and the assembly you open it beside: its bill of materials, part pictures, and the STEP files you export. Never writes to Onshape.
- Stores Onshape tokens encrypted on the server for 30 days after last use; the browser holds only a random session cookie. Signing out deletes them.
- Keeps, per user, the assembly and BOM for 30 days per revision, the latest scan for a week, part pictures for 30 days, and STEP files for an hour.
- Keeps the team's part choices with the document, with who made each change; the change history for a year.
- Sends data elsewhere only when you ask: the reviewed BOM to Control Point when you link it and press Send (the Control Point token is kept encrypted until you unlink), and the undecided parts' names, descriptions, part numbers, and candidate products to Google Gemini or Anthropic when you ask for AI review.
- Runs on Cloudflare over HTTPS. No ads, no selling data, no tracking.

## Permissions to explain

- **Read your profile** (`OAuth2ReadPII`): your name, shown as who is signed in and who changed a part's type. Only your id and name are kept.
- **Read your documents** (`OAuth2Read`): the assembly, its bill of materials, part pictures, and STEP exports.

Control Kit asks for nothing else: no write, delete, or billing permissions.

## Images

Onshape publishes no image sizes, so these are large and sharp enough to be scaled down. Upload the feature graphic and screenshots in this order.

| File | Size | Use and caption |
| --- | --- | --- |
| `icon/control-kit-tile-512.png` | 512 × 512 | App icon on a light tile. `icon/control-kit-512.png` is the transparent mark. Both come in 512, 256, 128, 64, 48, and 32 px. |
| `feature-graphic.png` | 2400 × 1260 | Feature graphic (also served at 1200 × 630 as the site's share image). |
| `1-overview.png` | 2560 × 1600 | Every part of the robot, sorted into buy and make, with the known cost so far. |
| `2-buy-list.png` | 2560 × 1600 | A buy list matched to vendor SKUs, rounded to whole packs, priced only when verified. |
| `3-part-details.png` | 2560 × 1600 | Each part's picture from Onshape and the evidence behind its decision. |
| `4-make-list.png` | 2560 × 1600 | Parts to print and cut, ready to download as STEP files. |
| `5-scan.png` | 2560 × 1600 | A scan reads the assembly, its bill of materials, and the vendor catalogs in seconds. |
| `6-onshape-panel.png` | 840 × 1720 | The same view in Onshape's right panel, beside your assembly. |

## Links

- Website and install steps: https://control-kit.pages.dev
- Privacy: https://control-kit.pages.dev/privacy
- Terms of use (EULA): https://control-kit.pages.dev/terms
- Support: https://control-kit.pages.dev/support (GitHub issues: https://github.com/ZOGWORK/control-kit/issues)
- Sign-in (OAuth) URL: `https://control-kit.control-kit-worker.workers.dev/oauth/start`
- Redirect URL: `https://control-kit.control-kit-worker.workers.dev/oauth/redirect`
- Element right panel (Assembly) action URL: `https://control-kit.pages.dev/?documentId={$documentId}&workspaceOrVersion={$workspaceOrVersion}&workspaceOrVersionId={$workspaceOrVersionId}&elementId={$elementId}`

## Before Onshape's review

Onshape's testers check the items in its [Testing Guidelines](https://onshape-public.github.io/docs/app-store/testingguidelines/). Check these on a real account first:

- An empty assembly, an assembly opened at a version, and one on a branch each show something sensible.
- Revoking Control Kit in Onshape (My account → Applications) and reopening the panel leads back to Connect.
- No avoidable errors in the browser console.
- Sign-in works with third-party cookies allowed; the support page says so.

## After the listing is public

Set `listed = true` in `apps/web/src/app/Landing.tsx` so the site stops saying the listing is pending, and link the listing itself in place of the App Store home page.
