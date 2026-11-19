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

## Sign-in links in the fragment

The edge never sees a fragment. When the auth server builds a link itself (a dashboard invite or recovery, or a
`redirect_to` it does not allow) it lands on the Supabase Site URL, the bare front page, with the sign-in in the
fragment (`/#access_token=…&refresh_token=…&type=…`, or `/#error=…&error_code=…`). Without the member hint that
page is redirected, and the browser carries the fragment to `https://comics.dreamstreamstudio.ai/#…`.

The comics host sends it straight back (`services/frontPageSignIn.ts` `signInLinkBackToMain`, called by
`index.tsx` before anything renders): on the comics host's bare `/`, with a query of tracking keys at most and a
fragment the main app reads as a sign-in link (`services/authLink.ts` `readMainAuthLink`), the page is replaced
with `https://dreamstreamstudio.ai/?home=1#…`. That page is never redirected, and the main app reads the link there
exactly as before (`hooks/useAuthLinkCallback.ts`). Comic Studio's own links always land on its `/auth/callback`,
so none of them is moved; nothing about the token is read or used on the way. Optional, owner side: setting the
Supabase Site URL to `https://dreamstreamstudio.ai/auth/callback` keeps such links off the bare `/` altogether
(check the email templates that use `{{ .SiteURL }}` first).

Order in the middleware: after the host redirects, the runtime files, `/csp-report`, the open paths
(`/robots.txt`, `/llms.txt`, `/.well-known/*`) and the AI-agent check-in (AI agents still go to
`/api/agent-gate`); before everything else. Search engines and link-preview bots follow the redirect like people.

## Escape hatch

`https://dreamstreamstudio.ai/?home=1` is never redirected (`home` is not a tracking key). A member whose
browser has no hint yet opens it, or any existing sign-in route on the main site, and signs in there.
`mainFrontPageUrl()` in `services/productHost.ts` builds it, and every link that means "the DreamStream home page"
uses it, never the bare `/`: the comics host's FAQ links (`App.tsx` `handleOpenFaq`, `/?home=1#home-faq`), the
comics sign-in card's "Sign in there" line, Stream Studio's sign-in gate ("DreamStream home"), and a sign-in
handoff into the main app whose destination is the front page (`server/src/services/authEmailLinks.ts`
`parseMainHandoffPath` turns `/` into `/?home=1`, so the browser does not leave before the new session sets the hint).

## Members on the day this ships

No browser has the hint before this release: only the main app writes it, while a member is signed in there. So a
member's first visit to `https://dreamstreamstudio.ai/` after the release opens Comic Studio, where they are signed
out (sessions are per host). The comics sign-in card says so in one quiet line, "The other DreamStream studios are
on the main site. Sign in there", which opens `/?home=1`; signing in (or simply opening any main-site page while
still signed in there) sets the hint, and from then on the bare address serves their own front page.

## Member hint cookie

`ds_member=1; Path=/; Secure; SameSite=Lax; Max-Age=31536000`, host-only on `dreamstreamstudio.ai`.

- Written by the browser, never by a server: `App.tsx` observes the auth state it already has through
  `hooks/useMemberHint.ts` — set while this tab has a signed-in user, removed (`Max-Age=0`) when that user signs
  out in this tab. A tab that merely opens signed out (with "Remember me" off each tab keeps its own session) leaves
  the hint alone, so another tab's session keeps its front page. Nothing about sign-in, sessions or roles changed.
- Safari (ITP) keeps a cookie written by script for at most 7 days. A member who stays away longer gets Comic
  Studio on the bare address and uses the comics sign-in card's link (or `/?home=1`); the next visit to the main
  site while signed in writes the hint again.
- Only on the main site (`isMainSiteHost`); never on the comics host, previews or localhost.
- It is not a credential and grants nothing. Sessions stay in browser storage, which the edge cannot see;
  the cookie only tells the edge to serve this browser the main front page. A forged cookie gets the old
  front page, which anyone can open with `?home=1`.

## After a deploy (owner checks, read-only)

- `curl -sI https://dreamstreamstudio.ai/` → `302`, `location: https://comics.dreamstreamstudio.ai/`, `cache-control: no-store`.
- `curl -sI 'https://dreamstreamstudio.ai/?utm_source=x'` → `302` with `?utm_source=x` kept.
- `curl -sI 'https://dreamstreamstudio.ai/?home=1'`, `'/?view=privacy'`, `'/?invite=x'`, `/auth/callback` → `200`.
- `curl -sI -H 'Cookie: ds_member=1' https://dreamstreamstudio.ai/` → `200`.

Tests: `services/productHost.frontPage.test.ts` (every condition, the escape-hatch links), `functions/frontPage.test.ts`
(wiring, order, no loop), `services/frontPageSignIn.test.ts` (fragment sign-in links finish on the main site),
`hooks/useMemberHint.test.tsx` (when the hint is set and removed).
