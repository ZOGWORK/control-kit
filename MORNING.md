# Control Kit — owner action to finish live validation

The FTC Control Kit OAuth app is active with read-profile and read-document scopes. Its redirect URL matches the deployed Worker. The App Store entry and Assembly right-panel extension are installed, and the panel opens on the HORS 25-26 **MR. HORS** assembly. The panel receives the correct document, workspace, and element IDs.

The live connection currently stops at Onshape's token endpoint with **HTTP 401 `unauthorized_client`**. No profile or assembly API call has run, and the Onshape Developer counter still reads **0 / 2,500**. Mock tests pass; the real assembly scan remains unverified.

1. In Onshape, go to **My account → Developer → OAuth applications → FTC Control Kit → Keys and secret**. Regenerate the OAuth client secret. Onshape displays it only immediately after regeneration.
2. In Cloudflare, go to **Workers & Pages → control-kit → Settings → Variables and Secrets**. Replace the encrypted `ONSHAPE_OAUTH_CLIENT_SECRET` with the newly generated **OAuth client secret**, then save. Confirm `ONSHAPE_OAUTH_CLIENT_ID` contains the **OAuth client identifier** from the same Onshape tab. These are OAuth credentials, separate from the older Onshape API key pair.
3. Open the HORS assembly, select the FTC Control Kit right-panel icon, choose **Connect Onshape**, then return to the panel and choose **Check connection**. Never paste either secret into chat or Git.

If the token endpoint still returns `unauthorized_client` after the replacement, preserve the Onshape app and Cloudflare settings and report the error; the next investigation should focus on the app's OAuth grant configuration. Once connected, the real HORS scan, STL ZIP, and Excel export can be validated and the API counter recorded.

Rotate the Onshape API key previously shared in chat after the OAuth setup is working.
