# Main front page → Comic Studio

While the rest of the platform stays out of sight, the bare front page of the main site,
`https://dreamstreamstudio.ai/`, sends visitors to `https://comics.dreamstreamstudio.ai/`.
Everything else on the main site keeps working at its own address, and signed-in members keep
their own home there.

## The switch

`MAIN_FRONT_PAGE_TO_COMICS` in `services/productHost.ts`. The Pages middleware
(`functions/_middleware.ts`) imports it, so there is one value for edge and client.
Setting it to `false` and deploying the frontend serves the old front page again at once
(the redirect is a `302` with `Cache-Control: no-store`, never stored by browsers or the CDN).

## The rule (`frontPageToComicsUrl`)

A `302` to `https://comics.dreamstreamstudio.ai/` only when **all** hold:

| Condition | Detail |
|---|---|
| Switch on | `MAIN_FRONT_PAGE_TO_COMICS === true` |
| Method | `GET` or `HEAD` |
| Host | exactly `dreamstreamstudio.ai` or `www.dreamstreamstudio.ai` (in practice www is sent to the apex first, by the zone redirect and by the middleware, so the rule runs on the apex where the member hint lives) |
| Path | exactly `/` |
| Query | empty, or tracking keys only: `utm_*`, `ref`, `fbclid`, `gclid`, `li_fat_id`, `msclkid`; they are carried over verbatim |
| Member hint | the request carries no `ds_member=1` cookie |

Served as before: any other path (`/index.html`, `/auth/callback`, `/settings`, `/c/<slug>`, `/live`,
…), any other query key (auth round trips `?code=` `?token=` `?token_hash=` `?type=` `?error=`, `?view=`,
`?invite=`, `?next=`, `?connected=`, …), other methods, preview and branch deploys (`*.comic2.pages.dev`),
`localhost`, the Stream Studio host, and requests the comics front door proxies to Pages
(`X-Forwarded-Host: comics.…`), so there is no loop. The fragment is never written; browsers keep it.

Order in the middleware: after the host redirects, the runtime files, `/csp-report`, the open paths
(`/robots.txt`, `/llms.txt`, `/.well-known/*`) and the AI-agent check-in (AI agents still go to
`/api/agent-gate`); before everything else. Search engines and link-preview bots follow the redirect like people.

## Escape hatch

`https://dreamstreamstudio.ai/?home=1` is never redirected (`home` is not a tracking key). A member whose
browser has no hint yet opens it, or any existing sign-in route on the main site, and signs in there.

## Member hint cookie

`ds_member=1; Path=/; Secure; SameSite=Lax; Max-Age=31536000`, host-only on `dreamstreamstudio.ai`.

- Written by the browser, never by a server: `App.tsx` observes the auth state it already has and calls
  `syncMemberHint` — set while a session is present, removed (`Max-Age=0`) once signed out. Nothing about
  sign-in, sessions or roles changed.
- Only on the main site (`isMainSiteHost`); never on the comics host, previews or localhost.
- It is not a credential and grants nothing. Sessions stay in browser storage, which the edge cannot see;
  the cookie only tells the edge to serve this browser the main front page. A forged cookie gets the old
  front page, which anyone can open with `?home=1`.

## After a deploy (owner checks, read-only)

- `curl -sI https://dreamstreamstudio.ai/` → `302`, `location: https://comics.dreamstreamstudio.ai/`, `cache-control: no-store`.
- `curl -sI 'https://dreamstreamstudio.ai/?utm_source=x'` → `302` with `?utm_source=x` kept.
- `curl -sI 'https://dreamstreamstudio.ai/?home=1'`, `'/?view=privacy'`, `'/?invite=x'`, `/auth/callback` → `200`.
- `curl -sI -H 'Cookie: ds_member=1' https://dreamstreamstudio.ai/` → `200`.

Tests: `services/productHost.frontPage.test.ts` (every condition), `functions/frontPage.test.ts` (wiring, order, no loop).
