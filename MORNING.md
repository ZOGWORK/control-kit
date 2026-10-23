# Control Kit — owner actions for the morning

Development continues against mocks and fixtures. These are the steps only the Onshape/Cloudflare account owner can complete:

1. In Onshape **My account → Developer → OAuth applications**, create the Control Kit app using the exact values in the README. Set the OAuth URL to `https://control-kit.control-kit-worker.workers.dev/oauth/start` and Redirect URL to `https://control-kit.control-kit-worker.workers.dev/oauth/redirect`.
2. Save the newly issued OAuth **client ID** and **client secret** directly in Cloudflare Worker **Settings → Variables and Secrets** for `control-kit`, as secrets named `ONSHAPE_OAUTH_CLIENT_ID` and `ONSHAPE_OAUTH_CLIENT_SECRET`. Do not put them in chat or Git. The API key shared earlier is not a substitute for OAuth.
3. Add the **Element right panel / Assembly** extension with the README's Action URL. Create the private store entry and subscribe your account if Onshape requires those steps before the extension appears.
4. Open a real FTC assembly in Onshape, launch Control Kit, connect, reload the iframe, and confirm it remains connected. Share only the assembly document URL or its IDs for the real validation gate. Do not share tokens or secrets.

Live Onshape API requests spent by automated development and tests: **0**. Real validation will consume requests and will be counted explicitly.
