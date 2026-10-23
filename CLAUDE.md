# Control Kit engineering notes

## Architecture

`Onshape iframe → React/Vite Pages app → Cloudflare Worker → Onshape API`; Worker KV stores encrypted sessions and catalog snapshots. `packages/shared` holds domain logic and `packages/excel` will build exports. The browser never receives OAuth secrets or tokens.

## Repository

`apps/web` is the iframe UI. `apps/worker` owns OAuth, proxying, and scheduled ingestion. `fixtures`, `scripts`, and `samples` support later milestones. See README for setup and checks.

## Milestones and deviations

M0 is scaffold only. M1 adds OAuth and mock Onshape. Scanning, vendor ingestion, classification, STL, and Excel are subsequent milestones. The repository is `ZOGWORK/control-kit`; no Control Point source is modified. No API endpoint or vendor feed has yet been verified live. The mock server is reused directly by tests because this sandbox blocks loopback connections. The Worker stores AES-GCM encrypted Onshape tokens under an opaque cookie ID in APP_STATE KV and uses one-use OAuth state. Real iframe behavior, endpoint paths, and scopes await portal verification. Do not use an API key for this App Store flow.

Current Onshape extension docs specify `{$workspaceOrVersion}` and `{$workspaceOrVersionId}` for the Element right panel and label `{$workspaceId}` deprecated. This differs from the brief's iframe parameter assumption, so M1 preserves the current context pair through OAuth. The current Cloudflare CLI delegates a plain `pages project create` command to Workers; `--force` created the explicitly requested Pages project. Subsequent Pages deployments do not use `--force`. Production URLs are `https://control-kit.pages.dev` and `https://control-kit.control-kit-worker.workers.dev`. Cross-site cookie behavior inside a real Onshape iframe remains unverified.

Onshape's sample integrated app sets an OAuth URL separate from the iframe action URL; its Applications-page flow can arrive without Assembly context. The Worker therefore supports context-free `/oauth/start`, validates Onshape's optional `redirectOnshapeUri` against `https://cad.onshape.com`, and returns to that page after OAuth. This replaces the earlier README instruction to leave the OAuth URL blank. The source is [Onshape's sample app](https://github.com/onshape-public/app-gltf-viewer) and [Onshape help](https://onshape-public.github.io/docs/help/). The Onshape OAuth guide explicitly says third-party cookies must be enabled for embedded apps; real-browser behavior still needs validation.

M2 pins `ONSHAPE_API_VERSION=v9` from the official [assembly](https://onshape-public.github.io/docs/api-adv/assemblies/) and [Part Studio](https://onshape-public.github.io/docs/api-adv/partstudios/) examples. The API Explorer and a real response still need validation with the owner's OAuth app; no Onshape API requests have been made. M2 fixtures are synthetic but use the documented `rootAssembly.instances` and `subAssemblies.instances` fields. We added `missingMetadataReason` and `unresolvedSubassembly` to `BomLine` because the brief requires a reason and a fallback line but its interface omitted fields for them. The missing-metadata view includes suppressed lines with failures; suppressed quantities remain excluded from active totals. Mass properties are fetched once per unique element, with six concurrent requests, while assembly definition is fetched once. Later vendor matching/classification will extend the M2 types.
