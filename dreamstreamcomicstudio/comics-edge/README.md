# comics-edge — `dreamstream-comics` Worker

The front door of Comic Studio at **https://comics.dreamstreamstudio.ai** (the same idea as Atlas at
`atlas.dreamstreamstudio.ai`). It serves the same Pages frontend (`comic2`) and the same API Worker
(`dreamstream-api`) as the apex; the comics host only changes the address, the `<head>` branding and
the boot experience (signed-out visitors land on the Comic Studio page, signed-in people go straight
to their comics — see `services/productHost.ts` and `components/comicshost/`).

| Request | Answer |
|---|---|
| `GET /__edge/health` (any host) | `{"status":"ok","service":"dreamstream-comics",…}`, `no-store` |
| `http://…` | `301` to `https://` (aliases go straight to `comics.`) |
| `comic.dreamstreamstudio.ai/*` | `301` to `comics.` (same path + query); any other host (workers.dev) → `302` |
| `/api`, `/api/*` | `env.API.fetch(request)` — the original request, untouched (agent gate, rate limits and client-IP forwarding stay in `dreamstream-api`) |
| `/live*`, `/models`, `/share/*`, `/studio.html` | `302` to the main site (other products; separate session) |
| everything else | fetched from `PAGES_ORIGIN` (same path + query) with `X-Forwarded-Host: comics.dreamstreamstudio.ai`, so the Pages middleware serves instead of redirecting to the apex |

On top of that:

- **Location** headers that point at the Pages origin or the apex are mapped back to the comics host.
- **HTML** (except `/c/*`, owned by the share Pages Function, and legacy `/?view=read&id=` reader heads)
  gets the Comic Studio head through `HTMLRewriter`: title "Comic Studio — DreamStream", description,
  `og:*`/`twitter:*` defaults with `/icons/comics-og.png`, `<meta name="ds-product" content="comics">`,
  theme colours and the `/comics.webmanifest` manifest. Nothing from the request is reflected.
- **Security headers on every response:** `Strict-Transport-Security: max-age=31536000` (never
  `includeSubDomains` — other subdomains are separate products), `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: strict-origin-when-cross-origin`, a minimal `Permissions-Policy`, and
  `X-Frame-Options: DENY` + `frame-ancestors 'none'` everywhere except embeds (`/embed/*`,
  `/c/<slug>/embed`) and share pages (whose Function sets its own framing).
- **Caching:** `/assets/*` → `public, max-age=31536000, immutable`; HTML → `no-cache`. A missing hashed
  chunk returns a real `404` instead of the SPA's `index.html`.
- **Honest failure:** if Pages is unreachable the edge answers a calm `502` page ("Your comics are
  safe"); if the API binding fails, a `502` JSON error.

## Sessions

Supabase keeps its session in each origin's `localStorage`, so `comics.` and the apex have separate
sign-ins (sign in once on `comics.`). Never share tokens through a `Domain=.dreamstreamstudio.ai`
cookie and never copy refresh tokens across hosts — other subdomains (formerly Code Studio previews)
can run user code.

## Deploying

`.github/workflows/deploy-comics-edge.yml` (repo root) deploys on pushes to `Dreamstrream-v1` that touch
this folder, then probes `https://dreamstream-comics.akhieleshsrirangam.workers.dev/__edge/health` and,
best-effort, the custom host. It uses the same `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` secrets
as the other Worker deploys (Workers Scripts: Edit + zone Workers Routes: Edit).

### DNS precondition

Worker **routes** only run for hostnames with a **proxied (orange-cloud)** DNS record. Today the zone's
proxied wildcard record `*.dreamstreamstudio.ai` covers `comics.` and `comic.`. ADR 0005 asks the owner
to delete the retired `dreamstream-studio` Worker and its `*.dreamstreamstudio.ai/*` **route** — that is
fine (our more specific `comics.dreamstreamstudio.ai/*` route wins either way). But if the wildcard **DNS
record** is ever removed, first add proxied records:

```
AAAA  comics  100::   (Proxied)
AAAA  comic   100::   (Proxied)
```

Why routes and not a Workers Custom Domain: a Custom Domain makes the Worker the origin, so the old
catch-all route would still run in front of it until it is deleted, and it creates its own DNS record
and certificate (it cannot be created where a CNAME already exists). Routes need only the zone
"Workers Routes: Edit" permission the deploy token already has (Cloudflare docs, Workers → Routing →
Custom Domains / Authorization).

## Owner checklist (one time)

1. Supabase → Authentication → URL Configuration → Redirect URLs: add exactly
   `https://comics.dreamstreamstudio.ai/auth/callback` (no wildcard).
2. Backend env: `AUTH_LINK_ORIGINS=https://comics.dreamstreamstudio.ai` so sign-up, magic-link and
   password-reset emails requested on the comics host link back to it (exact origin only).
3. Turnstile widget hostnames must cover `comics.dreamstreamstudio.ai` (a `dreamstreamstudio.ai`
   entry covers its subdomains; add it explicitly if the sign-in captcha fails there).

## Local checks

```
npx vitest run comics-edge/src/index.test.ts      # from dreamstreamcomicstudio/
cd comics-edge && npm ci && npx tsc -p tsconfig.json
```

The tests use a fake API binding, a fake Pages fetch and a jsdom-backed `HTMLRewriter` double
(`src/testing/fakeHtmlRewriter.ts`).
