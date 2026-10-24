# Control Kit — owner actions

OAuth is working: the FTC Control Kit panel connects on the HORS 25–26 **MR. HORS** assembly, and a full scan has run. The earlier `unauthorized_client` failure is resolved; no secret change is needed.

Open owner actions:

1. **Read the Onshape API counter** on the Developer page and give the number to the agent before any further live scan. The last reading (16) was taken during a scan, so the current total is unknown. Entries go in [docs/onshape-request-ledger.md](docs/onshape-request-ledger.md).
2. **Confirm the Cloudflare Workers plan** (Workers & Pages → Plans). The free plan limits each request to 50 outbound subrequests and KV to 1,000 writes per day, and both limits shape the scan and catalog design.
3. **Fix GitHub Actions billing for ZOGWORK.** GitHub would not start the new CI job: "recent account payments have failed or your spending limit needs to be increased" (Settings → Billing & plans). CI runs no live calls and needs no secrets; until billing is fixed, checks run locally before each merge.
4. **Revoke or rotate the Onshape API key** previously shared in chat, if not done already. OAuth does not use it.

Never paste secrets into chat or Git.
