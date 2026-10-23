# Control Kit

Control Kit is an Onshape assembly BOM tool for FTC teams, alongside the separate Control Point and Control Scout products. This repository is a new project intended for `ZOGWORK/control-kit`.

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

To regenerate the fixture workbook and mock STL zip from the repository root:

```sh
pnpm sample:excel
pnpm sample:stl
```

The checked-in samples are `samples/FTC_Competition_Robot_BOM_2026-10-23.xlsx` and `samples/FTC_Competition_Robot_prints.zip`. Both scripts use only fixtures and the same builders as the app. Alternative product links in the workbook are illustrative fixture data. The mock STL is illustrative geometry; its README records a deliberately failed part.

If XLSX generation fails, the app offers **Download CSV instead** from the same BOM sheet data. The CSV has values and no styling or live formulas.

## Printed parts and STL export

The deterministic classifier scores each active BOM line using print keywords, custom-part terms, vendor matches, and the optional team number saved in Settings. Scores of 60 or more are Printed, 35–59 are Possibly printed, and lower scores are Commercial. An exact normalized vendor SKU always forces Commercial unless the user explicitly sets a manual type. Manual Commercial/Printed choices are stored per user and document and reapplied on every rescan.

**Download printed parts STL zip** exports the current scan's printed lines, with at most three part requests in flight and a 60-second timeout per part. It tries the Onshape single-part STL endpoint first and then its async translation endpoint. The zip groups files by mechanism and includes `README.txt` with source links and every failed part; one failure does not discard successful STLs. The mock server and fixture tests cover this flow without live Onshape calls. Live endpoint shape and permissions still require validation after the owner creates the OAuth app.

## Vendor catalog refresh

Five staggered Worker crons refresh public product sitemaps every six hours: goBILDA at :00, ServoCity at :12, AndyMark at :24, REV at :36, and Pitsco at :48. Each run fetches at most 40 products, at no more than two requests per second per vendor, and resumes from a KV cursor on the next run. This keeps external fetches within [Cloudflare's 50-subrequest free-plan limit](https://developers.cloudflare.com/changelog/post/2026-02-11-subrequests-limit/). A completed catalog is published by updating one last-good version pointer after all versioned records and indexes exist. Initial backfill can take many cron cycles, especially for ServoCity's large sitemap; until then, no partial version appears in scans. [Free Workers KV allows 1,000 writes per day](https://developers.cloudflare.com/kv/platform/limits/), so monitor quota and cursor progress during backfill. The separate snapshot status records success or failure on every run. A stale-data warning appears when a used vendor's last complete refresh is older than `VENDOR_STALE_HOURS` or its latest refresh failed. Check `vendor:{vendorId}:__snapshot__` and `vendor:{vendorId}:__cursor__` in `VENDOR_CATALOG` to verify cron progress.

The owner-only actions and missing inputs are listed in [MORNING.md](MORNING.md). No secret belongs in chat or Git.

## Control Point integration status

V1 contains a `ControlPointAdapter` contract, a deterministic BOM payload builder, and an in-memory `MockControlPointAdapter` for tests. Repeating an unchanged payload reuses its SHA-256 idempotency key and mock record ID. There is no Control Point link UI, HTTP adapter, live sync, or network request. These stay out of the product until Control Point's actual BOM endpoint and authentication are confirmed.

## Deploy and verify

The production Cloudflare Pages project, Worker, and two KV namespaces already exist. The namespace IDs and five staggered crons are in `wrangler.toml`. In a new account, create equivalent Pages, Worker, and KV resources first and replace the namespace IDs. Put `SESSION_ENCRYPTION_KEY`, `ONSHAPE_OAUTH_CLIENT_ID`, and `ONSHAPE_OAUTH_CLIENT_SECRET` in the Worker as secrets, not in `wrangler.toml`, Pages variables, or Git. The owner has not yet created the Onshape OAuth app, so production currently reports `setupPending`.

After `pnpm install --frozen-lockfile` and the checks above, deploy from the repository root:

```sh
pnpm --filter @control-kit/worker exec wrangler deploy --config ../../wrangler.toml
pnpm --filter @control-kit/web build
pnpm --filter @control-kit/worker exec wrangler pages deploy ../../apps/web/dist --project-name control-kit --branch main
```

Verify `https://control-kit.pages.dev` loads and `https://control-kit.control-kit-worker.workers.dev/api/session` responds. Without OAuth secrets, the session response is `setupPending`; once configured, validate connect and iframe reload with a real Onshape assembly. In Cloudflare's KV dashboard, inspect `vendor:{vendorId}:__snapshot__` and `vendor:{vendorId}:__cursor__` for each cron. Initial full vendor backfill takes multiple six-hour cycles; a partial catalog is not served as complete.

On free Onshape plans, documents must be public for some API operations and rate limits are lower, so scans may take longer. The scan performance target is under 10 seconds for 200–500 instances with warm vendor KV, excluding 429 backoff. Larger assemblies remain scannable with progress shown. No plan level is inferred when Onshape does not expose it.

## Onshape App Store listing checklist

- Create the OAuth application with the exact redirect and OAuth URLs below; select read-profile and read-document permissions.
- Add an **Element right panel** extension for **Assembly** using the iframe Action URL below. Create the private store entry and subscribe for an in-document test.
- Verify connect, iframe reload, a real FTC assembly scan, Excel export, and STL zip after the owner supplies a validation document. Check actual API permissions before requesting any additional scope.
- Include a privacy note: the Worker stores encrypted Onshape tokens server-side under an opaque session cookie, caches a completed scan for one hour for STL export, and uses catalog data for vendor enrichment. V1 sends no data to Control Point.
- Confirm Pages/Worker HTTPS URLs, free-plan wording, support contact, and screenshots before public submission.

## Owner's Onshape Developer Portal step

1. Sign in to Onshape. Open the account icon (top right) → **My account** → **Developer** → **OAuth applications** → **Create new OAuth application**.
2. Enter **Name** `Control Kit`; **Primary format** `org.zogwork.controlkit` (permanent identifier); **Summary** `Read FTC assemblies to prepare a bill of materials and print files`; **Type** `Integrated Cloud App`.
3. Enter the **production Redirect URL** `https://control-kit.control-kit-worker.workers.dev/oauth/redirect`. Onshape requires HTTPS; its localhost exception is documented for installed desktop apps.
4. Enter **OAuth URL** `https://control-kit.control-kit-worker.workers.dev/oauth/start`. Onshape's Applications page can open this without Assembly context; if it supplies `redirectOnshapeUri`, Control Kit returns to that Onshape page after authorization. The **iframe Action URL** is `https://control-kit.pages.dev/?documentId={$documentId}&workspaceOrVersion={$workspaceOrVersion}&workspaceOrVersionId={$workspaceOrVersionId}&elementId={$elementId}`. These replacement tokens are documented for the Element right panel; `workspaceId` is deprecated there.
5. Choose **read profile** (`OAuth2ReadPII`) and **read documents** (`OAuth2Read`) permissions. Check whether STL translation needs `OAuth2Write` in current Onshape documentation before requesting it. Click **Create application**. Save the OAuth client ID and newly generated client secret directly to Cloudflare Worker secrets when resources exist; do not put them in Git or chat.
6. Open the new app → **Extensions** → **Add extension**. Choose **Element right panel** location and **Assembly** context, then set the Action URL from step 4. Create a private store entry and subscribe for in-document testing when those controls are available.

These clicks and fields follow [Onshape Developer settings](https://cad.onshape.com/help/Content/Plans/my_account_developer.htm), [extension parameters](https://onshape-public.github.io/docs/app-dev/extensions/), the [OAuth guide](https://onshape-public.github.io/docs/auth/oauth/), and [Onshape's sample app](https://github.com/onshape-public/app-gltf-viewer). The Pages and Worker URLs respond over HTTPS. Onshape's OAuth guide says embedded apps need third-party cookies enabled. Actual iframe/OAuth behavior and permission details still require live portal verification. No live Onshape request has been spent.

## Repository and review

The private repository is [`ZOGWORK/control-kit`](https://github.com/ZOGWORK/control-kit). Every PR is merged only after Greptile reviews its exact head commit at 5/5 confidence with zero unresolved threads.
