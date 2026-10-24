# Onshape API request ledger

The owner's Educator plan allows **2,500 Onshape API requests per year** until the FTC Control Kit extension is public. Each live request made during development is logged here with its purpose. Automated tests use mock Onshape only and never appear here.

Since PR 1, the Worker also counts every outbound Onshape request it sends, including 429 retries and redirects. It writes a per-day aggregate to `APP_STATE` key `onshape-ledger:YYYY-MM-DD`. `node --experimental-strip-types scripts/ops-report.ts` prints it. The Onshape Developer page counter is authoritative; the Worker aggregate can under-count when two operations finish at the same moment.

## Counter readings

| When (UTC) | Counter | Source |
|---|---|---|
| Before 2026-10-24 | 16, read *during* a HORS scan, not after | Owner, from the prior session |
| — | *pending:* to be read before the next live call | Onshape Developer page |

## Development requests

| Date | PR | Requests | Purpose | Result |
|---|---|---|---|---|
| 2026-10-24 | PR 1 | 0 | Baseline diagnosis used repository code and production KV only | — |
