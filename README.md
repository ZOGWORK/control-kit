# Control Kit

Control Kit is an Onshape assembly BOM tool for FTC teams, alongside the separate Control Point and Control Scout products. Its app and four-sheet Excel export use the same black-and-yellow brand palette, with a Control Kit logo embedded in the BOM sheet. This repository is the `ZOGWORK/control-kit` project.

## Fresh clone and build

Install Node.js 24 and pnpm 11. From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm exec playwright install chromium
pnpm test:smoke
pnpm build
```

For local development, run `pnpm --filter @control-kit/web dev` and `pnpm --filter @control-kit/worker dev` in separate terminals. Copy `.env.example` into local configuration, enter OAuth credentials only in Worker secrets or untracked `.dev.vars`, and replace placeholder KV namespace IDs before deployment. Never put credentials in the web build.

## The app

Control Kit shares Control Scout's look: graphite surfaces, a volt yellow accent, Inter and Space Grotesk type, and [Arc](https://uiarc.dev) components themed to that palette (`apps/web/src/styles/theme.css`). It is organized around what a team does after a scan:

- **Overview**: totals for parts, Buy, Make, and Needs review; a known subtotal labeled with how many lines are priced; next steps, each with the action that resolves it; downloads; vendor catalog status.
- **Review**: only the parts that need a person. Possible vendor matches come first, then suggestions, then open questions. Each part says why it is there and offers the likely answer as one click, and **Accept all** saves every suggestion in the group.
- **Parts**: every part, filterable by Buy, Make, Review, or Suppressed, searchable by name, part number, or SKU. A part opens a drawer with its evidence, vendor product, Onshape source, and the choice of how it is obtained.
- **Buy list**: confirmed vendor products grouped by vendor, with packs and prices; parts to buy without a match are listed separately with what they need.
- **Make**: prints and fabricated parts by process, with the STEP export and its per-part results.

On desktop the sections sit in a sidebar; in the narrow Onshape right panel they become a scrollable row of tabs under a compact header. Settings (team number, sign-out) open in a drawer.

To review the UI without Onshape or secrets, run `pnpm --filter @control-kit/web fixture` and open `http://localhost:5173/?documentId=fixture&workspaceOrVersion=w&workspaceOrVersionId=w1&elementId=e1`. A local stand-in API (`apps/web/fixture-api.ts`) serves the synthetic robot fixture. To review a real scan, save its result JSON outside Git and name it in an untracked `apps/web/.env.fixture.local` as `CK_FIXTURE=../../work/your-scan.json`.

## M1 mock OAuth

Run `pnpm --filter @control-kit/worker mock` to start mock Onshape on `http://localhost:8788`. Use untracked `apps/worker/.dev.vars` for `ONSHAPE_OAUTH_CLIENT_ID=mock-id`, `ONSHAPE_OAUTH_CLIENT_SECRET=mock-secret`, `ONSHAPE_OAUTH_REDIRECT_URI=http://localhost:8787/oauth/redirect`, and a base64-encoded random 32-byte `SESSION_ENCRYPTION_KEY`. In separate terminals, run the web dev command above and start the Worker with these local overrides (from the repository root):

```sh
pnpm --filter @control-kit/worker exec wrangler dev --port 8787 --var WEB_ORIGIN:http://localhost:5173 --var ONSHAPE_API_BASE:http://localhost:8788 --var ONSHAPE_OAUTH_BASE:http://localhost:8788 --var ONSHAPE_OAUTH_REDIRECT_URI:http://localhost:8787/oauth/redirect
```

Open `http://localhost:5173/?documentId=simple&workspaceOrVersion=w&workspaceOrVersionId=work1&elementId=elem1` and click **Scan Assembly**. Substitute `robot` or `empty` for `simple` to test the other fixtures. Tests use the same mock handler in process and make zero live Onshape calls. `ONSHAPE_API_VERSION=v9` is pinned. A workspace scan makes three Onshape requests: the current microversion, then the assembly definition and the flattened bill of materials at that microversion. A rescan of an unchanged revision reads both from a per-user cache and costs one request. Part numbers, descriptions, vendors, and materials come from the Onshape BOM.

For fixture-only vendor matching in local development, generate and load the seed into local Wrangler KV (never use `--remote` for this seed):

```sh
node --experimental-strip-types scripts/seed-dev-kv.ts
pnpm --filter @control-kit/worker exec wrangler kv bulk put ../../.wrangler/seed-kv.json --binding VENDOR_CATALOG --local --config ../../wrangler.toml
```

The seed is synthetic and is not a production catalog. A matched record's price is a **pack price**: Control Kit shows Qty Needed and Packs to Order separately, calculates charges from packs, and leaves the line total blank unless the pack size is verified. Possible matches also stay out of totals until confirmed.

## Excel BOM export

After a scan, **Download Excel BOM** creates a workbook locally in the browser without another API call. The BOM sheet shows Qty Needed, Packs to Order, Pack Price, and formula-driven Line Total; the Estimated Total formula sums those line totals. Unverified pack sizes and unconfirmed possible matches have blank line totals. Separate sheets list printed parts, suppressed parts, and missing metadata. Vendor data age and stale status appear in the header.

To regenerate the fixture workbook and mock STEP ZIP from the repository root:

```sh
pnpm sample:excel
pnpm sample:step
```

The checked-in samples are `samples/FTC_Competition_Robot_BOM_2026-10-23.xlsx` and `samples/FTC_Competition_Robot_STEP.zip`. Both scripts use only fixtures and the same builders as the app; the STEP sample runs the real export job against mock Onshape. Alternative product links in the workbook are illustrative fixture data. The mock STEP file is a minimal valid ISO-10303-21 file, and the manifest records a deliberately failed part.

If XLSX generation fails, the app offers **Download CSV instead** from the same BOM sheet data. The CSV has values and no styling or live formulas.

## Dispositions and STEP export

Each active line gets a **disposition**: Buy, 3D print, CNC machine, 2D cut (laser/waterjet/router), Other fabrication, or Needs review. It also gets a provenance, a source, a confidence, and the evidence behind them. They are decided in this order:
1. A person's manual choice.
2. An exact vendor SKU, which makes the part Buy.
3. Explicit metadata: a process/manufacturing column in the Onshape BOM, a team tag in the part name such as `[3DP]`, `(CNC)`, `{laser}`, or `#COTS`, or a print material such as PLA, PETG, or TPU.
4. Strong provenance: Onshape standard content, a linked library part with a part number, or a vendor match you confirmed.
5. Otherwise Needs review, with a suggestion and a reason. Examples: a team-designed bracket suggests 3D print, and a custom plate suggests 2D cut.

A suggestion never decides by itself. A purchased CAD part therefore never becomes a print because of its name, and a flat plate is never assumed printable. Manual choices are shared by everyone who scans the document and are reapplied on every rescan. Each one records who set it and keeps a short history. Only someone whose own recent scan read that document can change one. Choices saved per user before this change are still honored.

**Download STEP files** exports every active part set to 3D print, CNC, 2D cut, or other fabrication. Name-only suggestions are not included until someone confirms them. The export runs as a job, so it fits the Worker's per-request limits:
1. The Worker starts one Onshape STEP translation per part. It uses `createPartStudioTranslation` with `formatName: STEP`, the part's configuration, and `storeInDocument: false`, which needs only read access.
2. The app polls while the Worker checks the translations a slice at a time. Each finished file is downloaded once and must be a complete ISO-10303-21 file. HTML, empty, or truncated responses fail that part, and a file over 20 MB fails with a pointer to Onshape. The units and the STEP product name are recorded, and the file is kept for one hour.
3. The browser fetches the ready files and builds `{Assembly}_STEP.zip`, with one folder per process plus `MANIFEST.txt`. The manifest lists every file with quantity, process, units, and Onshape source link, and every failure with its reason and link.

Failed parts are also shown in the app. If every part fails, no ZIP is produced and the app explains why. Each part costs one translation start, its status polls, and one download, all counted in the request ledger. A 2D-cut part gets a STEP solid; its DXF cut file must still be made from its flat face.

## Vendor catalog refresh

Five staggered Worker crons crawl the vendors' public product sitemaps every two hours: goBILDA at :00, ServoCity at :12, AndyMark at :24, REV at :36, and Pitsco at :48. Each run respects `robots.txt` and fetches at most 40 product pages, at no more than two requests per second. This keeps each run within [Cloudflare's 50-subrequest free-plan limit](https://developers.cloudflare.com/changelog/post/2026-02-11-subrequests-limit/).

**Parsing.** Each product page yields one record per purchasable SKU:
- Shopify pages (AndyMark, Pitsco): from the page's variant list, with a variant-specific link.
- BigCommerce family pages (goBILDA, ServoCity, REV): from their child rows.
- Otherwise: from Product JSON-LD.

A record must carry a real vendor SKU; none is derived from a name. A pack size is recorded only with its evidence, such as `variant label "25 Pack"`. Pages that are redirect stubs, lack product data, or lack a SKU are skipped and counted by reason. A page whose fetch fails holds the crawl position for up to three runs, then is skipped, so one bad page cannot stall a vendor.

**Storage and publication.** Each run appends its records as one batch and updates the generation's SKU/name index, so a run costs about five KV writes regardless of catalog size. [Free Workers KV allows 1,000 writes per day](https://developers.cloudflare.com/kv/platform/limits/).
- What a run writes becomes visible on the **next** run, two hours later. That gives KV time to propagate everywhere before any scan reads it.
- The **first** crawl goes live in parts this way and is labeled partial until it finishes.
- **Later** crawls build a new generation while the last complete one stays live. Scans switch to the new generation only when it is complete. The previous generation is kept for a day for rollback, then deleted in bounded steps.

**Health.** The snapshot records success or failure on every run. `GET /api/catalog/health` and `node --experimental-strip-types scripts/ops-report.ts` report each vendor's state: published (complete or partial), building, failing, or never run. They also report progress, skipped pages, staleness, and the last error. Every scan carries the same health. The app warns when a catalog is unpublished, partial, stale, or failing, even if no line matched. A matched price is stale after `VENDOR_STALE_HOURS` (336, two weeks), which allows for a full refresh cycle.

**Matching.** A scan tries exact SKUs first: the CAD part number in any format, then catalog-number-like tokens in the part name. A SKU found at one vendor is an exact match and forces Buy. The same SKU and product name at several vendors is also exact, because ServoCity resells goBILDA products under goBILDA SKUs; the best-stocked, then cheapest, seller is chosen and the others are named. A SKU that names different products at different vendors, or any name similarity, only produces a *possible* match. That match has no price until a person confirms it, and confirmations survive rescans and catalog refreshes. Pack size and price must also be verified for a line total; otherwise the line stays blank and out of the known subtotal.

## Onshape request budget

Until the FTC Control Kit extension is public, the owner's Educator plan allows 2,500 Onshape API requests per year. The Worker counts every outbound Onshape request, including retries, and stores daily totals in KV. Each scan also reports its own count in `diagnostics.onshapeRequests`. Tests and CI use mock Onshape only. Run `node --experimental-strip-types scripts/ops-report.ts` for the recorded totals; development requests are logged in [docs/onshape-request-ledger.md](docs/onshape-request-ledger.md).

The owner-only actions and missing inputs are listed in [MORNING.md](MORNING.md). No secret belongs in chat or Git.

## Control Point integration status

V1 contains a `ControlPointAdapter` contract, a deterministic BOM payload builder, and an in-memory `MockControlPointAdapter` for tests. Repeating an unchanged payload reuses its SHA-256 idempotency key and mock record ID. There is no Control Point link UI, HTTP adapter, live sync, or network request. These stay out of the product until Control Point's actual BOM endpoint and authentication are confirmed.

## Deploy and verify

The production Cloudflare Pages project, Worker, and two KV namespaces already exist. The namespace IDs and five staggered crons are in `wrangler.toml`. In a new account, create equivalent Pages, Worker, and KV resources first and replace the namespace IDs. Put `SESSION_ENCRYPTION_KEY`, `ONSHAPE_OAUTH_CLIENT_ID`, and `ONSHAPE_OAUTH_CLIENT_SECRET` in the Worker as secrets, not in `wrangler.toml`, Pages variables, or Git. The owner created the OAuth app and installed all three encrypted Worker secrets on 2026-10-23; production now returns `{"connected":false}` to an unauthenticated `/api/session` request rather than `setupPending`.

After `pnpm install --frozen-lockfile` and the checks above, deploy from the repository root:

```sh
pnpm --filter @control-kit/worker exec wrangler deploy --config ../../wrangler.toml
pnpm --filter @control-kit/web build
pnpm --filter @control-kit/worker exec wrangler pages deploy ../../apps/web/dist --project-name control-kit --branch main
```

Verify `https://control-kit.pages.dev` loads and `https://control-kit.control-kit-worker.workers.dev/api/session` responds. Without OAuth secrets, the session response is `setupPending`; once configured, validate connect and iframe reload with a real Onshape assembly. In Cloudflare's KV dashboard, inspect `vendor:{vendorId}:__snapshot__` and `vendor:{vendorId}:__cursor__` for each cron. Initial full vendor backfill takes multiple six-hour cycles; a partial catalog is not served as complete.

On free Onshape plans, documents must be public for some API operations and rate limits are lower, so scans may take longer. The scan performance target is under 10 seconds for 200–500 instances with warm vendor KV, excluding 429 backoff. Larger assemblies remain scannable with progress shown. No plan level is inferred when Onshape does not expose it.

## Onshape App Store listing checklist

- OAuth application and encrypted Worker secrets: complete. The exact redirect and OAuth URLs remain below for reference.
- Add an **Element right panel** extension for **Assembly** using the iframe Action URL below. Create the private store entry and subscribe for an in-document test.
- Verify connect, iframe reload, a real FTC assembly scan, Excel export, and STEP export after the owner supplies a validation document. Check actual API permissions before requesting any additional scope.
- Include a privacy note: the Worker stores encrypted Onshape tokens server-side under an opaque session cookie, caches a completed scan and STEP export files for one hour, caches the assembly definition and BOM per user for 30 days by revision, and uses catalog data for vendor enrichment. V1 sends no data to Control Point.
- Confirm Pages/Worker HTTPS URLs, free-plan wording, support contact, and screenshots before public submission.

## Owner's Onshape Developer Portal step

1. Sign in to Onshape. Open the account icon (top right) → **My account** → **Developer** → **OAuth applications** → **Create new OAuth application**.
2. Enter **Name** `Control Kit`; **Primary format** `org.zogwork.controlkit` (permanent identifier); **Summary** `Read FTC assemblies to prepare a bill of materials and print files`; **Type** `Integrated Cloud App`.
3. Enter the **production Redirect URL** `https://control-kit.control-kit-worker.workers.dev/oauth/redirect`. Onshape requires HTTPS; its localhost exception is documented for installed desktop apps.
4. Enter **OAuth URL** `https://control-kit.control-kit-worker.workers.dev/oauth/start`. Onshape's Applications page can open this without Assembly context; if it supplies `redirectOnshapeUri`, Control Kit returns to that Onshape page after authorization. The **iframe Action URL** is `https://control-kit.pages.dev/?documentId={$documentId}&workspaceOrVersion={$workspaceOrVersion}&workspaceOrVersionId={$workspaceOrVersionId}&elementId={$elementId}`. These replacement tokens are documented for the Element right panel; `workspaceId` is deprecated there.
5. Choose **read profile** (`OAuth2ReadPII`) and **read documents** (`OAuth2Read`) permissions. STEP translation (`createPartStudioTranslation`) needs only `OAuth2Read` per the current OpenAPI spec; recheck in current Onshape documentation before requesting it. Click **Create application**. Save the OAuth client ID and newly generated client secret directly to Cloudflare Worker secrets when resources exist; do not put them in Git or chat.
6. Open the new app → **Extensions** → **Add extension**. Choose **Element right panel** location and **Assembly** context, then set the Action URL from step 4. Create a private store entry and subscribe for in-document testing when those controls are available.

These clicks and fields follow [Onshape Developer settings](https://cad.onshape.com/help/Content/Plans/my_account_developer.htm), [extension parameters](https://onshape-public.github.io/docs/app-dev/extensions/), the [OAuth guide](https://onshape-public.github.io/docs/auth/oauth/), and [Onshape's sample app](https://github.com/onshape-public/app-gltf-viewer). The Pages and Worker URLs respond over HTTPS. Onshape's OAuth guide says embedded apps need third-party cookies enabled. Actual iframe/OAuth behavior and permission details still require live portal verification. No live Onshape request has been spent.

## Repository and review

The private repository is [`ZOGWORK/control-kit`](https://github.com/ZOGWORK/control-kit). Every PR is merged only after Greptile reviews its exact head commit at 5/5 confidence with zero unresolved threads.
