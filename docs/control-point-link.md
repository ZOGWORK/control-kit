# Control Kit ↔ Control Point link contract (v1)

Written 2026-10-26 at the owner's request ("build both sides now"). Both repositories build to this document, so it is the confirmed contract that `control-point.ts` waited for. Change it only in both places at once.

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
