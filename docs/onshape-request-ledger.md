# Onshape API request ledger

The owner's Educator plan allows **2,500 Onshape API requests per year** until the FTC Control Kit extension is public. Each live request made during development is logged here with its purpose. Automated tests use mock Onshape only and never appear here.

Since PR 1, the Worker also counts every outbound Onshape request it sends, including 429 retries and redirects. It writes a per-day aggregate to `APP_STATE` key `onshape-ledger:YYYY-MM-DD`. `node --experimental-strip-types scripts/ops-report.ts` prints it. The Onshape Developer page counter is authoritative; the Worker aggregate can under-count when two operations finish at the same moment.

## Counter readings

| When (UTC) | Counter | Source |
|---|---|---|
| Before 2026-10-24 | 16, read *during* a HORS scan, not after | Owner, from the prior session |
| 2026-10-24 ~18:05 | **98 / 2,500** (personal account, day 46 of 365), before any rework live call | Onshape Developer page (My account → Developer), read by the agent in the owner's session |
| 2026-10-24 ~21:36 | **144 / 2,500** (day 46), after the PR 7 live checks so far; matches 98 + the Worker ledger's 46 billable | Onshape Developer page, read by the agent |
| 2026-10-25 ~07:00 | about **193 / 2,500** (estimate, not read): 98 + the Worker ledger's 95 billable over 2026-10-24 and 25 | Worker ledger (`scripts/ops-report.ts`) |

## Development requests

| Date | PR | Requests | Purpose | Result |
|---|---|---|---|---|
| 2026-10-24 | PR 1 | 0 | Baseline diagnosis used repository code and production KV only | — |
| 2026-10-24 | PR 3/4 check | 4 (all 2xx) | OAuth connect (1 session info), then one HORS scan: microversion, definition, BOM | Scan matched Onshape BOM: 180/193 lines, 0 quantity mismatches. See [hors-live-scan-2026-10-24.md](hors-live-scan-2026-10-24.md). Expected counter: 102 |
| 2026-10-24 | PR 5 live check | 37 (35 export + 2 rescan; 5 more 429 responses, not billed) | Rescan of HORS (cache hit: 1 microversion request), then a STEP export of its 11 print parts | 10 of 11 STEP files valid (AP214, one solid each, product names match, length unit metres); 1 failed on persistent 429, fixed in PR 5b. Expected counter: about 137 |
| 2026-10-24/25 | PR 7 launch check | 12 billable (scans: 9 microversion, 3 definition + BOM on new revisions; 1 shaded view) | Live HORS scans in the Onshape panel and the app, one part picture | Worker ledger totals 49 billable for the rework; expected counter about 147 |
| 2026-10-25 | Owner use of PRs 8 to 11 | 49 billable (41 shaded views, 11 microversion, 1 definition + 1 BOM), plus 5 HTTP 401 token refreshes | The owner's own scans in the Onshape panel, and part pictures opened in the drawer (one billable request per part the first time) | Part pictures are now the largest use; the audit report suggests loading them on a click |
| 2026-10-25 | Full audit (PRs 35 to 38) | 0 | Read-only audits, mocked tests, and production checks of public endpoints | — |

The owner said on 2026-10-24 not to ration live requests ("use as much as u want"); every request is still logged here.
