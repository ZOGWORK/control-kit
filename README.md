# Control Kit

Control Kit is an Onshape assembly BOM tool for FTC teams, alongside the separate Control Point and Control Scout products. This repository is a new project intended for `ZOGWORK/control-kit`.

## Fresh clone and build

Install Node.js 24 and pnpm 11. From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

For local development, run `pnpm --filter @control-kit/web dev` and `pnpm --filter @control-kit/worker dev` in separate terminals. Copy `.env.example` into local configuration, enter OAuth credentials only in Worker secrets or untracked `.dev.vars`, and replace placeholder KV namespace IDs before deployment. Never put credentials in the web build.

## M1 mock OAuth

Run `pnpm --filter @control-kit/worker mock` to start mock Onshape on `http://localhost:8788`. Use untracked `apps/worker/.dev.vars` for `ONSHAPE_OAUTH_CLIENT_ID=mock-id`, `ONSHAPE_OAUTH_CLIENT_SECRET=mock-secret`, `ONSHAPE_OAUTH_REDIRECT_URI=http://localhost:8787/oauth/redirect`, and a base64-encoded random 32-byte `SESSION_ENCRYPTION_KEY`. In separate terminals, run the web dev command above and start the Worker with these local overrides (from the repository root):

```sh
pnpm --filter @control-kit/worker exec wrangler dev --port 8787 --var WEB_ORIGIN:http://localhost:5173 --var ONSHAPE_API_BASE:http://localhost:8788 --var ONSHAPE_OAUTH_BASE:http://localhost:8788 --var ONSHAPE_OAUTH_REDIRECT_URI:http://localhost:8787/oauth/redirect
```

Open `http://localhost:5173/?documentId=simple&workspaceOrVersion=w&workspaceOrVersionId=work1&elementId=elem1` and click **Scan Assembly**. Substitute `robot` or `empty` for `simple` to test the other fixtures. Tests use the same mock handler in process and make zero live Onshape calls. M2 pins `ONSHAPE_API_VERSION=v9` for the documented assembly and Part Studio calls; real-response validation remains pending.

For fixture-only vendor matching in local development, generate and load the seed into local Wrangler KV (never use `--remote` for this seed):

```sh
node --experimental-strip-types scripts/seed-dev-kv.ts
pnpm --filter @control-kit/worker exec wrangler kv bulk put ../../.wrangler/seed-kv.json --binding VENDOR_CATALOG --local --config ../../wrangler.toml
```

The seed is synthetic and is not a production catalog. A matched record's price is a **pack price**: Control Kit shows Qty Needed and Packs to Order separately, calculates charges from packs, and leaves the line total blank unless the pack size is verified. Possible matches also stay out of totals until confirmed.

## Excel BOM export

After a scan, **Download Excel BOM** creates a workbook locally in the browser without another API call. The BOM sheet shows Qty Needed, Packs to Order, Pack Price, and formula-driven Line Total; the Estimated Total formula sums those line totals. Unverified pack sizes and unconfirmed possible matches have blank line totals. Separate sheets list printed parts, suppressed parts, and missing metadata. Vendor data age and stale status appear in the header.

To regenerate the fixture workbook, bundle and run the sample script from the repository root:

```sh
node node_modules/.pnpm/esbuild@0.25.12/node_modules/esbuild/bin/esbuild scripts/generate-sample-excel.ts --bundle --platform=node --format=esm --outfile=work/generate-sample-excel.mjs
node work/generate-sample-excel.mjs
```

The checked-in sample is `fixtures/FTC_Competition_Robot_BOM_2026-10-23.xlsx`. The script calls the same `buildExcelWorkbook` function as the UI and uses only fixtures.

## Printed parts and STL export

The deterministic classifier scores each active BOM line using print keywords, custom-part terms, vendor matches, and the optional team number saved in Settings. Scores of 60 or more are Printed, 35–59 are Possibly printed, and lower scores are Commercial. An exact normalized vendor SKU always forces Commercial unless the user explicitly sets a manual type. Manual Commercial/Printed choices are stored per user and document and reapplied on every rescan.

**Download printed parts STL zip** exports the current scan's printed lines, with at most three part requests in flight and a 60-second timeout per part. It tries the Onshape single-part STL endpoint first and then its async translation endpoint. The zip groups files by mechanism and includes `README.txt` with source links and every failed part; one failure does not discard successful STLs. The mock server and fixture tests cover this flow without live Onshape calls. Live endpoint shape and permissions still require validation after the owner creates the OAuth app.

## Vendor catalog refresh

Five staggered Worker crons refresh public product sitemaps every six hours: goBILDA at :00, ServoCity at :12, AndyMark at :24, REV at :36, and Pitsco at :48. Each run fetches at most 40 products, at no more than two requests per second per vendor, and resumes from a KV cursor on the next run. This keeps external fetches within [Cloudflare's 50-subrequest free-plan limit](https://developers.cloudflare.com/changelog/post/2026-02-11-subrequests-limit/). A completed catalog is published by updating one last-good version pointer after all versioned records and indexes exist. Initial backfill can take many cron cycles, especially for ServoCity's large sitemap; until then, no partial version appears in scans. [Free Workers KV allows 1,000 writes per day](https://developers.cloudflare.com/kv/platform/limits/), so monitor quota and cursor progress during backfill. The separate snapshot status records success or failure on every run. A stale-data warning appears when a used vendor's last complete refresh is older than `VENDOR_STALE_HOURS` or its latest refresh failed. Check `vendor:{vendorId}:__snapshot__` and `vendor:{vendorId}:__cursor__` in `VENDOR_CATALOG` to verify cron progress.

The owner-only actions and missing inputs are listed in [MORNING.md](MORNING.md). No secret belongs in chat or Git.

## Owner's Onshape Developer Portal step

1. Sign in to Onshape. Open the account icon (top right) → **My account** → **Developer** → **OAuth applications** → **Create new OAuth application**.
2. Enter **Name** `Control Kit`; **Primary format** `org.zogwork.controlkit` (permanent identifier); **Summary** `Read FTC assemblies to prepare a bill of materials and print files`; **Type** `Integrated Cloud App`.
3. Enter the **production Redirect URL** `https://control-kit.control-kit-worker.workers.dev/oauth/redirect`. Onshape requires HTTPS; its localhost exception is documented for installed desktop apps.
4. Enter **OAuth URL** `https://control-kit.control-kit-worker.workers.dev/oauth/start`. Onshape's Applications page can open this without Assembly context; if it supplies `redirectOnshapeUri`, Control Kit returns to that Onshape page after authorization. The **iframe Action URL** is `https://control-kit.pages.dev/?documentId={$documentId}&workspaceOrVersion={$workspaceOrVersion}&workspaceOrVersionId={$workspaceOrVersionId}&elementId={$elementId}`. These replacement tokens are documented for the Element right panel; `workspaceId` is deprecated there.
5. Choose **read profile** (`OAuth2ReadPII`) and **read documents** (`OAuth2Read`) permissions. Check whether STL translation needs `OAuth2Write` in current Onshape documentation before requesting it. Click **Create application**. Save the OAuth client ID and newly generated client secret directly to Cloudflare Worker secrets when resources exist; do not put them in Git or chat.
6. Open the new app → **Extensions** → **Add extension**. Choose **Element right panel** location and **Assembly** context, then set the Action URL from step 4. Create a private store entry and subscribe for in-document testing when those controls are available.

These clicks and fields follow [Onshape Developer settings](https://cad.onshape.com/help/Content/Plans/my_account_developer.htm), [extension parameters](https://onshape-public.github.io/docs/app-dev/extensions/), the [OAuth guide](https://onshape-public.github.io/docs/auth/oauth/), and [Onshape's sample app](https://github.com/onshape-public/app-gltf-viewer). The Pages and Worker URLs respond over HTTPS. Onshape's OAuth guide says embedded apps need third-party cookies enabled. Actual iframe/OAuth behavior and permission details still require live portal verification. No live Onshape request has been spent.

## GitHub handoff

The private repository is `ZOGWORK/control-kit`. From this repository root, after authenticating Git with an authorized GitHub account:

```sh
git status
git remote -v
git push origin main
```

M0–M3 are merged. Before any later PR merge, run Greptile on the current head and wait for 5/5 confidence with zero unresolved threads.
