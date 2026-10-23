# Control Kit — owner actions for the morning

Development and tests continue against mocks and fixtures. Current owner-side setup status:

- **Done:** The Onshape OAuth application exists with the production OAuth and redirect URLs. The Worker lists `ONSHAPE_OAUTH_CLIENT_ID`, `ONSHAPE_OAUTH_CLIENT_SECRET`, and `SESSION_ENCRYPTION_KEY` as encrypted secrets. No values were read or stored in Git.
- **In progress:** Create the private App Store entry and add the **Element right panel / Assembly** extension with the README's Action URL. Onshape currently displays an Application Development Agreement notice for store entry creation. Subscribe your account if Onshape requires it before the extension appears.
- **Pending:** Open a real FTC assembly in Onshape, launch Control Kit, connect, reload the iframe, and confirm it remains connected. Share only the assembly document URL or IDs for the real validation gate. Do not share tokens or secrets.

Live Onshape API requests spent by automated development and tests: **0**. Real validation will consume requests and will be counted explicitly.
