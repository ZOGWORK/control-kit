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

Run `pnpm --filter @control-kit/worker mock` to start mock Onshape on `http://localhost:8788`. In separate terminals, run Worker and web dev commands above. Use untracked `apps/worker/.dev.vars` for `ONSHAPE_OAUTH_CLIENT_ID=mock-id`, `ONSHAPE_OAUTH_CLIENT_SECRET=mock-secret`, `ONSHAPE_OAUTH_REDIRECT_URI=http://localhost:8787/oauth/redirect`, and a base64-encoded random 32-byte `SESSION_ENCRYPTION_KEY`. For the mock, set `ONSHAPE_API_BASE` and `ONSHAPE_OAUTH_BASE` to `http://localhost:8788` in local Wrangler configuration. Open `http://localhost:5173/?documentId=doc1&workspaceId=work1&elementId=elem1`. Tests use the same mock handler in process and make zero live Onshape calls.

## Owner's Onshape Developer Portal step

1. Sign in to Onshape. Open the account icon (top right) → **My account** → **Developer** → **OAuth applications** → **Create new OAuth application**.
2. Enter **Name** `Control Kit`; **Primary format** `org.zogwork.controlkit` (permanent identifier); **Summary** `Read FTC assemblies to prepare a bill of materials and print files`; **Type** `Integrated Cloud App`.
3. Enter the **production Redirect URL** `https://<your-worker-host>/oauth/redirect`. The exact hostname is available only after the Control Kit Worker is created. Onshape requires HTTPS; its localhost exception is documented for installed desktop apps, so do not assume the browser iframe can register a localhost redirect.
4. Leave **OAuth URL** blank until the deployed Worker URL exists. Then set it to `https://<your-worker-host>/oauth/start` with the required assembly context parameters supplied by the Onshape extension. The **iframe Action URL** will be `https://<your-pages-host>/?documentId=...&workspaceId=...&elementId=...`; substitute the parameter tokens shown by Onshape's Extensions form after verifying its supported locations/contexts. Neither production hostname exists yet.
5. Choose **read profile** (`OAuth2ReadPII`) and **read documents** (`OAuth2Read`) permissions. Check whether STL translation needs `OAuth2Write` in current Onshape documentation before requesting it. Click **Create application**. Save the OAuth client ID and newly generated client secret directly to Cloudflare Worker secrets when resources exist; do not put them in Git or chat.
6. Open the new app → **Extensions** → **Add extension**. Choose the embedded location and Assembly context offered by the current portal, then set the Action URL from step 4. Create a private store entry and subscribe for in-document testing when those controls are available.

These clicks and fields follow [Onshape Developer settings](https://cad.onshape.com/help/Content/Plans/my_account_developer.htm) and the [OAuth guide](https://onshape-public.github.io/docs/auth/oauth/). The production URLs cannot be made exact until Cloudflare creates the Pages and Worker hostnames. API version, extension parameter tokens, iframe behavior, and permission details still require live portal verification. No live request has been spent.

## GitHub handoff

The target is `ZOGWORK/control-kit`. Once an authorized GitHub account can create repositories in `ZOGWORK`, create an empty private repository named `control-kit` without generated files. From this repository root:

```sh
git init
git add .
git commit -m "Scaffold Control Kit and mock Onshape OAuth"
git branch -M main
git remote add origin https://github.com/ZOGWORK/control-kit.git
git push -u origin main
```

No PR or merge has been performed. Before any later PR merge, run Greptile and wait for 5/5 confidence as requested.
