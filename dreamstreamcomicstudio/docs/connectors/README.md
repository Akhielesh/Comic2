# Connector setup runbooks

Operator setup guides for each account connector (the per-user OAuth + API-key
connectors documented in [`../CONNECTORS_FRAMEWORK.md`](../CONNECTORS_FRAMEWORK.md)).
Each guide is exact, copy-paste, and lists the env vars to set in Railway.

| Provider | Guide | Auth model | Env vars |
|---|---|---|---|
| Google (Gmail, Drive, Calendar, Sheets, YouTube) | [`google-setup.md`](./google-setup.md) | per-user OAuth 2.0 + PKCE | `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_OAUTH_REDIRECT_URL`, `CONNECTORS_APP_RETURN_URL` |
| Google Maps | [`google-setup.md`](./google-setup.md#part-7--google-maps-api-key) | API key | `GOOGLE_MAPS_API_KEY` |
| _next connector_ | _(add a sibling `*-setup.md`)_ | — | — |

## Golden rules (apply to every provider)

1. **Own the developer account under the company domain, not a personal email.** Use a
   `dreamstreamstudio.ai` identity owned by a role/group, so the app survives staff
   changes and shows a professional name on consent screens.
2. **One project per environment** (`dreamstream-prod`, `dreamstream-dev`), each with its
   own OAuth client + redirect URI. Never share a client across environments.
3. **Least privilege.** Only the read-only scopes the connector declares — nothing more.
4. **Secrets live in Railway env only**, never in the repo. The app encrypts user tokens
   at rest (AES-256-GCM); the provider client secret is an operator secret.
5. **Set, then verify.** After setting env vars, confirm `GET /api/connectors/catalog`
   shows the connector as `configured: true`.
