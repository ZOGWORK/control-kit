# Control Kit ↔ Control Point link contract (v1.2)

Written 2026-10-26 at the owner's request ("build both sides now"). Both repositories build to this document, so it is the confirmed contract that `control-point.ts` waited for. Change it only in both places at once.

v1.1 (2026-10-26, the owner's CAD rebuild: robots by season, the whole BOM in Control Point, and choices made there): §2 gains the bundle's additive line fields and where an import lands, and §5 describes how choices made in Control Point reach Control Kit. Nothing in v1 changes meaning; `bundleVersion` stays 2 and every new field is optional for a reader.

v1.2 (2026-10-28, the owner's requests "i should also be able to download all the parts in control point itself, also show the preview images in control point too" and, for AI review, "when control point is linked it should work"): §6 adds files uploaded after a send (the STEP zip always goes this way now, and anything over 4 MB) and part pictures; §7 adds AI review answered with Control Point's own model keys. `bundleVersion` stays 2; a v1.1 reader ignores everything new.

Hosts: Control Point `https://tryctrlpoint.org` (Express on Render, SQLite). Control Kit Worker `https://control-kit.control-kit-worker.workers.dev`, Pages `https://control-kit.pages.dev`.

## Principles

- The browser never holds a Control Point token. Only the Control Kit Worker does, AES-GCM encrypted in `APP_STATE`, like the Onshape tokens.
- A grant belongs to one Control Point **account** (its email), not one workspace. The workspace is picked in Control Kit and sent with every call; Control Point checks the account is an active member of that workspace, with CAD edit rights, on **every** call.
- Nothing is sent automatically. Sending is a button press on a reviewed scan.
- A failed link or send never blocks scan, Excel, or STEP.

## 1. Linking (authorization code)

1. Browser → Worker `GET /control-point/start`. The Worker makes a random `state`, puts it in a signed HttpOnly cookie `controlkit_cp` (same HMAC pattern as `controlkit_oauth`, `Path=/control-point`, 10 minutes), and redirects to:

   `https://tryctrlpoint.org/connect/control-kit?state={state}&redirect_uri={encoded https://control-kit.control-kit-worker.workers.dev/control-point/callback}`

   Control Kit opens this in a popup (`window.open`), because Onshape's iframe cannot show Control Point's sign-in.
2. Control Point page `/connect/control-kit` (SPA route): if signed out, sign in and come back. Shows "Control Kit wants to send BOMs from Onshape to your workspaces" with the account email, the list of workspaces it will be able to see, **Allow** and **Cancel**. `redirect_uri` must equal one entry of the server allowlist `CONTROL_KIT_REDIRECT_URIS` (comma-separated env; default the production URI above, tests add a local one). Anything else: error page, no redirect.
3. Allow → `POST /api/integrations/control-kit/authorize {state, redirect_uri}` (normal session auth) returns `{redirect}` = `redirect_uri?code={code}&state={state}`. Cancel → `redirect_uri?error=access_denied&state={state}`. The code is random, 32+ bytes, stored hashed, one-use, expires in 5 minutes, bound to the member email and redirect_uri.
4. Worker `GET /control-point/callback` checks the state cookie, then calls server-to-server:

   `POST https://tryctrlpoint.org/api/integrations/control-kit/token`
   `Authorization: Basic base64("control-kit:" + CONTROL_KIT_CLIENT_SECRET)`
   body `{ "grant_type": "authorization_code", "code": "...", "redirect_uri": "..." }`

   → `200 { "access_token": "ckp_…", "token_type": "Bearer", "account": { "email": "…", "name": "…" } }`.
   The token has no expiry and is revocable; Control Point stores only its SHA-256. Errors: `400 {error:"invalid_grant"}`, `401 {error:"invalid_client"}`.
5. Worker stores `cp-link:{userId}` = encrypted `{token, account, workspaceId: null, linkedAt}` and returns a small HTML page that `postMessage`s `{type:"control-point-linked"}` to `https://control-kit.pages.dev` (and the fixture origin in dev) and closes itself.

`CONTROL_KIT_CLIENT_SECRET` is a secret in both apps (Render env / Worker secret). It is never in Git.

## 2. Bearer API (Control Point)

All with `Authorization: Bearer ckp_…`. An unknown or revoked token → `401 {error:"revoked"}`; Control Kit then deletes `cp-link:{userId}` and shows "Link again".

### `GET /api/integrations/control-kit/workspaces`

```json
{ "account": { "email": "a@b.org", "name": "Sam" },
  "workspaces": [
    { "id": 12, "name": "HORS", "ftcNumber": "6980", "accentColor": "#2f6bff",
      "canEditCad": true, "cadUrl": "https://tryctrlpoint.org/cad-parts" } ] }
```

`accentColor` is the team's admin-set `teams.accent_color` when it is a valid `#rrggbb`, else `null` (Control Kit then stays volt). `ftcNumber` is the verified FTC number or `null`. Only active memberships of the token's email are listed. An empty list is normal (teamless account); create/join links are `https://tryctrlpoint.org/teams?tab=workspaces&new=1` and `…&join=1`.

### `POST /api/integrations/control-kit/workspaces/{id}/bom`

Body: the `ControlPointBomPayload` (bundleVersion 2, `packages/shared/src/control-point.ts` in Control Kit), **with `idempotencyKey` computed including the workspace id**. `Content-Type: application/json`, at most 12 MB.

Behaviour:
- 403 `{error:"not_member"}` if the email is not an active member of workspace `id`; 403 `{error:"no_cad_edit"}` without CAD edit rights; 413 over size; 400 `{error:"bad_payload", detail}` when `source !== "control-kit"`, `bundleVersion !== 2`, or `cadParts` is missing.
- Same `idempotencyKey` already imported to that workspace → `200` with the earlier result and `"duplicate": true`. Nothing changes.
- Otherwise one transaction:
  - Upsert an import record `cad_imports(team_id, idempotency_key UNIQUE per team, document_id, element_id, assembly_name, revision, part_count, sent_by, created_at, files)`.
  - For each `cadParts[i]`: the row is identified by `(team_id, ck_document_id, ck_element_id, ck_part_key)` where `ck_part_key = cadParts[i].extra.identity` (document:element:part:configuration from Control Kit, stable across revisions). New → insert with `status` from the payload. Existing → update name, section, quantity, source, unit_cost, notes, `ck_extra`, `ck_import_id`; **keep the people's fields** `status` (unless still `to_order`), `assignee`. Rows of this assembly missing from the new bundle are not deleted; they get `ck_removed_at` set and show as "Not in latest scan" in the Parts tab.
  - Files (`files[]` with `delivery: 'inline'` and base64 bytes in `contentBase64`, as `ControlPointFile` defines them): stored as CAD docs attached to the import (existing upload storage, R2 when configured). Files with `delivery: 'reference'` are recorded as "available in Control Kit".
- Response `200`:

```json
{ "importId": 41, "duplicate": false, "workspace": { "id": 12, "name": "HORS", "ftcNumber": "6980" },
  "created": 30, "updated": 89, "markedRemoved": 2, "filesStored": 2,
  "url": "https://tryctrlpoint.org/cad-parts?import=41", "sentAt": "2026-10-26T15:00:00.000Z" }
```

New `cad_parts` columns (nullable, migration): `ck_document_id`, `ck_element_id`, `ck_part_key`, `ck_import_id`, `ck_extra` (JSON text), `ck_removed_at`. Unique index on `(team_id, ck_document_id, ck_element_id, ck_part_key)` where `ck_part_key IS NOT NULL`. Hand-made parts are untouched.

### `GET /api/integrations/control-kit/workspaces/{id}/imports?document={documentId}&element={elementId}`

Latest 10 imports of that assembly: `[{importId, idempotencyKey, sentAt, sentBy, created, updated, markedRemoved, url}]`. Control Kit uses it to show "Last sent …".

### `POST /api/integrations/control-kit/revoke`

Revokes the bearer token. `204`. Control Point's own Settings also lists "Connected apps → Control Kit (linked {date})" with **Disconnect**, which revokes every Control Kit token of that account.

### Where an import lands (v1.1)

Control Point groups CAD by FTC season and robot (a season is named by its starting year, `2025` = 2025–26 DECODE; a season may hold several robots, one of them the main robot). An import goes to the robot already linked to its assembly (`document_id`, `element_id`). An assembly no robot has yet goes to the main robot of the latest season that has robots, when that robot has no assembly yet; otherwise Control Point creates a robot in the current season named after the assembly. People can move a robot to another season or relink its assembly in Control Point. The response gains `robot: {id, name, season}` and `url` opens that robot's BOM (`/cad/robots/{id}?import={importId}`); `/cad-parts?import={id}` keeps working and redirects there.

### Bundle line fields added in v1.1 (all optional for a reader)

Each `ControlPointLine` (so each `cadParts[i].extra`) also carries:

| Field | Meaning |
|---|---|
| `description`, `material` | From the Onshape BOM, or null. |
| `matchNormalizedSku` | The current match's normalized SKU (the `normalizedSku` a product choice names), or null. |
| `image` | The matched product's licensed picture `{url, attribution}` (`LicensedImage`) from an official feed, or null. Control Point shows nothing without one. |
| `priceCheck` | Control Kit's sanity-check note when it refused to price an order, or null. |
| `manualOverrideAt`, `manualOverrideBy` | When and by whom the part's current shared type was set (Control Kit's `disposition:{documentId}:{sha256(identity)}` record), or null. |
| `matchDecisionAt` | When the product choice in force on this line was saved, or null. |
| `candidates` | The products a person may pick between: `{ id, vendor, sku, normalizedSku, name, priceUsd, unitsPerPack, stock, url, image, kind }`, where `id` = `{vendor}:{normalizedSku}` and `kind` is `match` (the current match), `choice` (Control Kit's `choices`), or `near` (`nearMatches`). At most 8. `unitsPerPack` is null unless the pack size is verified. |

Control Point stores the whole line (`ck_extra`), so the rest of Control Kit's fields (disposition, match status, packs, price, stock, links, review reason) need no new columns.

Rate limit: 30 calls per token per minute (existing `rateLimit.ts`), `429` with `Retry-After`.

## 3. Control Kit Worker routes (browser-facing, cookie session)

| Route | Does |
|---|---|
| `GET /control-point/start` | Step 1 above. Needs a Control Kit session. |
| `GET /control-point/callback` | Step 4–5. |
| `GET /api/control-point/link` | `{linked:false}` or `{linked:true, account, workspace: {id,name,ftcNumber,accentColor,canEditCad} \| null, workspaces:[…], linkedAt}`. Refreshes the workspace list from Control Point at most every 10 minutes (cached inside `cp-link`); on 401 unlinks. `?refresh=1` ("Check again", after creating or joining a workspace) forces that refresh, at most once per 30 seconds per person, counting failed attempts; within those 30 seconds no read calls Control Point, even with the cache expired, and the cached list is served (marked `stale` when expired). A linked answer carries `refreshAfter` (ISO time) for when the next forced refresh can happen. With no `CONTROL_KIT_CLIENT_SECRET` set: `{linked:false, available:false}`. |
| `POST /api/control-point/workspace {workspaceId}` | Saves the picked workspace (must be in the list). Never sends anything. |
| `POST /api/control-point/send?scanId=…&workspaceId=…` | `workspaceId` is the workspace the Send button named; when it is not the link's saved workspace the Worker sends nothing and answers 409 `{error, code:"workspace_changed"}`. Body: the payload JSON the browser built. The Worker checks `Content-Length` ≤ 12 MB and that `scanId` is the caller's `scan:{userId}:{scanId}` for the same document, then streams the body to Control Point **without parsing it** (free-plan 10 ms CPU), to the saved workspace. Returns Control Point's response. Records `cp-sent:{userId}:{documentId}:{elementId}` = `{importId, workspaceId, sentAt, idempotencyKey, url}`. |
| `GET /api/control-point/sent?documentId&elementId` | That record, or null. |
| `POST /api/control-point/unlink` | Calls revoke (best effort), deletes `cp-link:{userId}` and `cp-sent:*` is kept. Origin-checked like `/api/logout`. |

Idempotency: `buildControlPointPayload` gains `workspaceId` and folds it into the hash, so one scan sent to two workspaces is two imports. The sorted media types of the files sent inline are folded in too (not their names, which carry a date, nor their bytes, which change on every workbook build), so sending again with the STEP zip attached is a new import rather than a duplicate that drops the zip. `controlPointIdempotencyKey(result, {workspaceId, inlineMediaTypes})` in `packages/shared/src/control-point.ts` computes the same key without building files.

## 4. What the browser shows

- Not available (no secret): Control Point card with "View CAD in Control Point" and the preview; no link button.
- Not linked: preview of this scan in Control Point's sections and statuses, labelled as a preview, with **Link Control Point** and **Create a free workspace**.
- Linked, no workspace or several: picker. One workspace: shown selected, with a confirm.
- Linked with workspace: "Send to {name} · FTC {n}" and the last-sent line. Workspace `accentColor` replaces the brand accent (primary buttons, active tab, header mark) when it passes contrast; status colours never change.

## 5. Choices made in Control Point (v1.1)

People decide in Control Point what Control Kit asks for, and those choices reach Control Kit's next scan. Control Point never writes to Control Kit: Control Kit reads the choices with the link's bearer token and saves them as its own.

### What a choice is

Per part identity (`ck_part_key`, document:element:part:configuration) in a workspace, two independent choices, each with who and when:

- **Type**: `buy`, `print`, `cnc`, `cut-2d`, `fabricate`, `hardware` (fastener), or `ignore` (not needed); or `null`, meaning "let Control Kit decide" (clears a manual type).
- **Product**: one of the line's `candidates` (`vendor` + `normalizedSku`). Picking a product also means the part is bought; Control Point sets the type to `buy` in the same choice unless it already is.

Who may choose: an active member of the workspace whose role carries Control Point's **Manage CAD** permission (`manage_cad`; admins have it, and the default Member and Verified Member roles are given it so nobody loses CAD editing). Every change is kept in Control Point's history with who and when.

### `GET /api/integrations/control-kit/workspaces/{id}/decisions?document={documentId}`

Bearer, same checks as `/imports` (active member; CAD module on). Returns every choice made in Control Point for parts of that document:

```json
{ "decisions": [
  { "identity": "d1:e1:JHD:default", "elementId": "e1",
    "type": { "value": "print", "by": "Sam Lee", "at": "2026-10-26T18:00:00.000Z" } | null,
    "product": { "vendor": "gobilda", "normalizedSku": "1611001408", "by": "Sam Lee", "at": "2026-10-26T18:01:00.000Z" } | null } ] }
```

`type.value` may be `null` (cleared in Control Point). At most 2,000 decisions, newest first. Errors as §2.

### Control Kit: `POST /api/control-point/decisions {documentId, scanId}`

Browser-facing Worker route (Origin-checked, cookie session). The app calls it after a scan and when a saved scan reopens, while linked with a workspace; a failure is shown quietly and never blocks the scan. The Worker:

1. Checks `scan:{userId}:{scanId}` is the caller's scan of `documentId`, reads the decisions above for the link's workspace, and ignores any identity not in that scan.
2. **Type**: when the Control Point choice is newer than Control Kit's `disposition:{documentId}:{sha256(identity)}` record (`at`), or there is none, and the value differs, it saves it there exactly as a person in Control Kit would (current record plus a never-overwritten history key) with `by: "{name} in Control Point"`, `byId: "control-point"`, and `at` = Control Point's time.
3. **Product**: when the choice is newer than the caller's saved match decision (`match-decision:{userId}:{documentId}:{sha256(identity)}`; a decision saved before v1.1 has no time and counts as older), it saves `{status: "confirmed", vendorId, normalizedSku, at}`. Match decisions stay per person in Control Kit, so each linked person picks up Control Point's product choices on their own next scan.
4. Answers `{ types: n, products: m }` (how many it saved). The app then reloads choices (`/api/choices`) and rematches, so the open scan shows them at once.

Writes happen only for real changes, so an unchanged pull writes nothing to KV.

### Which choice wins

The newest. A person's later choice in Control Kit is newer than Control Point's, so the pull skips it, and the next send carries it (`manualOverrideAt`, `matchDecisionAt`). Control Point shows, per part, the newer of its own choice and the line's; its own choice reads "Chosen in Control Point · reaches Control Kit at its next scan" until a send carries the same value. A re-send never erases a Control Point choice: imports update `ck_extra` and the Control Kit columns only, and choices live in their own columns.

## 6. Files after a send, and part pictures (v1.2)

### Files

A bundle names every file it should hold. Files over 4 MB, and **the STEP zip always** (whatever its size), are listed with `delivery: "reference"` and uploaded right after the send, to the import the send answered with (a duplicate send included). The zip therefore never changes the idempotency key: adding STEP later reaches the same import instead of creating a new one. A file over 64 MB stays in Control Kit (its `reason` says so).

`POST /api/integrations/control-kit/workspaces/{id}/imports/{importId}/files?name={name}`

- Bearer, same checks as the BOM send (active member, CAD module on). The import must belong to workspace `id` (else 404 `not_found`) and be finished (else 409 `in_progress` with `Retry-After`).
- Body: the file's raw bytes, at most 64 MB (413 `too_large`). `Content-Type` is `application/zip`, the xlsx type, or `text/csv`, and must match the name's extension (415 `bad_file`). `X-Content-SHA256` is the bytes' hex SHA-256; a mismatch is 400 `checksum_mismatch`. `name` is 1 to 160 characters with no slash, backslash, or control characters.
- Stored as a CAD doc of the import (on its robot). In the import's `files` it replaces the entry of the same name, else the first unstored entry it completes (a `.zip` fills an entry named `*.zip` or mentioning STEP; an `.xlsx` one named `*.xlsx`, Excel, or workbook), else it is appended. The list is swapped from the value it was read as, so two uploads to one import never drop each other.
- The same name with the same bytes again: `200 {duplicate: true}`, nothing changes. New bytes under the same name replace the stored file (the old one is deleted).
- `200 { name, url, sizeBytes, sha256, duplicate }`; `url` is `/api/files/{id}` on Control Point.

Control Kit Worker: `POST /api/control-point/file?documentId&elementId&importId&workspaceId&name` (Origin-checked, cookie session), headers `Content-Type`, `Content-Length` (411 without), `X-Content-SHA256`. Only for the caller's own latest send of that assembly (`cp-sent:{userId}:{documentId}:{elementId}` names that `importId` and workspace; else 409 `not_sent` or `workspace_changed`), with the link still on that workspace. The body streams through unread (the free plan's 10 ms CPU rules out hashing 64 MB; Control Point checks the hash), and a body longer than declared errors rather than arriving short. A new name is added to the sent record's `files`, so the panel knows STEP is there. A Control Point 401 ends the link and answers 409 `revoked`.

The panel uploads the referenced files right after each send, and offers **Add STEP files** (exporting first when this session has no current zip) while the last send of the current scan has no zip in Control Point. Control Point shows the newest stored STEP zip and workbook of a robot as downloads.

### Part pictures

Each Control Point CAD part may carry one Onshape picture of the part (or, for a vendor product listed as one unit, of that product), drawn by Control Kit's `/api/preview` and stored in `cad_parts.ck_picture_url` with Control Kit's picture **key**: the revision the Worker caches the picture at (the scanned microversion `m:{id}` for workspace parts, else `{v|m}:{sourceId}`) plus 16 hex characters of SHA-256 of `{bomLineKey}|{part|assembly}` (`controlPointPictureKey`, at most 128 characters of `[A-Za-z0-9_:.-]`). The robot's own picture stays the send's `{assembly} assembly.png` file.

- `GET …/workspaces/{id}/imports/{importId}/pictures` (Bearer, membership): `{ pictures: [{ identity, key, at }] }` for the parts of that import's assembly that have one.
- `POST …/workspaces/{id}/imports/{importId}/pictures` (Bearer, CAD edit), JSON at most 8 MB: `{ pictures: [{ identity, key, contentBase64 }] }`, 1 to 40 items. Each must be a PNG of at most 1 MB for a part of that import's assembly; others count as `rejected` (bad key, not a PNG, too large) or `unknown` (no such part). A part already holding that key is `unchanged`; a new key replaces the picture (the old file is deleted). Imports never touch these columns. `200 { stored, unchanged, unknown, rejected }`.

Control Kit Worker: `GET /api/control-point/pictures?documentId&elementId&importId` and `POST /api/control-point/pictures?documentId&elementId&importId&workspaceId` (Origin-checked, at most 8 MB, streamed unread), with the same send and link checks as files. `GET /api/preview?scanId&line&cached=1` answers a picture the Worker already drew, or 404 `not_cached`, never an Onshape request.

**Onshape budget.** After a send the panel lists Control Point's keys and walks the scan's parts (one per identity, parts to make first, Not needed and undrawable lines left out). A part whose key Control Point holds is skipped. A picture the Worker already drew (cached 30 days per revision) is sent free. Only a part Control Point has **no** picture of is drawn now, at most `PICTURE_FILL_PER_SEND` = 30 per send (one billable `shaded-view` request each). A part whose newer revision was never drawn keeps its older picture. So a robot of N drawable parts costs at most N requests once, 30 per send, and later sends cost nothing unless new parts appear (again at most 30 per send).

## 7. AI review through Control Point (v1.2)

When the Control Kit Worker has no model key of its own (`GEMINI_API_KEY`, `ANTHROPIC_API_KEY`), a person linked with a workspace gets AI review through Control Point; Control Kit's own keys, if set, always take precedence. Control Kit keeps its per-person and global allowance (the `AiAllowance` Durable Object), its 30-day answer cache (`ai-review:{hash}:control-point`, apart from its own models' answers), and its `parseAiReview` check of every answer. No key or token reaches the browser.

`POST /api/integrations/control-kit/workspaces/{id}/ai/review` (Bearer, active member, CAD module on), JSON at most 256 KB:

```json
{ "instructions": "…", "schema": { "…": "JSON Schema for the answer" }, "geminiSchema": { "…": "the same in Gemini's OpenAPI subset" },
  "request": { "version": 1, "assembly": "…", "leftOut": 0, "lines": [] } }
```

- `request` is the review the Worker rebuilt from the caller's own stored scan (`trustedAiRequest`): version 1, 1 to 150 lines, each with `id`, `name`, optional facts, and at most 8 catalog `candidates` (`id`, `vendor`, `sku`, `name`). `instructions` at most 8,000 characters, each schema at most 8,000 characters of JSON. Anything else is 400 `bad_payload`, so the route is not a general model proxy.
- Control Point asks Gemini (`GEMINI_MODEL`, default `gemini-3.5-flash-lite`) with the instructions as the system prompt, the request as JSON, and `responseSchema: geminiSchema`; it asks Anthropic (`ANTHROPIC_MODEL`, default `claude-sonnet-5-5`, effort low, `output_config.format` from `schema`) once, only when Gemini answers 429 or 5xx or cannot be reached, never on an auth or request error. Each call times out at 90 seconds; nothing is retried blindly.
- Per workspace, at most 20 reviews an hour and 100 a day (in memory, reset on restart): 429 `rate_limited` with `Retry-After`. The token's own 30 calls a minute still apply.
- `200 { items: [...], provider: "gemini" | "anthropic", usage: { inputTokens, outputTokens } }`: the model's items as it gave them (an unparseable answer is `items: []`). 501 `ai_unavailable` without keys; 502 `ai_failed`; 504 `ai_timeout`.

Control Kit Worker: `GET /api/ai/status` answers `{enabled: true, via: "control-kit"}` with its own keys, `{enabled: true, via: "control-point"}` for a person linked with a workspace (and the `AI_ALLOWANCE` binding), else `{enabled: false}` (with `linkToEnable: true` when linking would turn it on). `POST /api/ai/review` is unchanged for the browser; through Control Point it waits at most 190 seconds (Gemini then Anthropic), answers with `via: "control-point"`, maps Control Point's 429, 501, 502 and 504 to the same statuses with plain words, and a 401 ends the link and answers 409 `{code: "revoked", linked: false}` like the other link routes.
