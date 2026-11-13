# Discover: the public listing (edge route, RPCs, codec)

**Status:**
- **DS-R2 (S2) built the data path only:** the SQL, the edge route and the shared codec. Nothing on screen changes yet.
- **The SQL is ask-first (owner decision R-D3).** `server/sql/comic_discovery.sql` is written and tested, not applied.
  The lead applies it after the security review and before the PR that turns Discover on for admins (redesign plan
  §11.3 M12). Until then the edge route answers 503 ("Discover is taking a moment"), never an empty Discover.
  - **Lead decision D12 (S2b integration): not applied with S2b.** It waits for its security review, which must cover
    the anon-executable SECURITY DEFINER RPCs (a direct anon RPC call bypasses the edge limiter and cache), and lands
    with DS-R6 (S3).
  - **Fixed at the S2b integration, before the review** (so the reviewed text is the text that ships): the avatar rule
    accepts only this project's storage host (`bdjfmxfmhqhzvgrhbbzm.supabase.co`), never another Supabase project; a
    publication whose stored rating is above PG-13 is never listed (an unrated one is); both definer RPCs run with
    `search_path = public, pg_temp`. Pinned by `server/sql/tests/comic_discovery.test.sql` and
    `tests/config/discoveryListingGuard.test.ts`. The edge route backs off for 30 s after a failed database answer
    (`DISCOVER_BACKOFF_MS`), so until the SQL is applied a hit costs no Supabase call.
  - **Security review checklist (before apply):**
    1. **Grants** (`comic_discovery.sql` grants): anon and authenticated can call both RPCs directly with the public anon
       key, which bypasses `PUBLIC_COMIC_RL` and the 30 s cache. Decide: accept, or move to a dedicated role or key for
       the Worker.
    2. **Cost per anonymous call:** the base CTE ranks every public row with leading-wildcard ILIKE over title,
       description, every i18n title (`jsonb_each`) and username, plus a 7-day stats aggregate;
       `comic_discover_shelves` repeats that 7 times. There is no function-level statement timeout (a `set
       statement_timeout` on the function does not bound the call itself): confirm the anon role's timeout in
       production. Plan `pg_trgm` or per-sort indexes past about 10k public rows.
    3. **search_path:** now `public, pg_temp` (pg_temp last), asserted after apply and by the guard. Confirm.
    4. **Avatars:** the host pin (above) and the UUID rule. The UUID rule matches only hyphenated UUIDs: confirm no
       avatar path carries a user id in another form.
    5. **Rating:** fail closed above the ceiling (above). Confirm the stored values are exactly `G`, `PG`, `PG-13`.
    6. **Unlisting completeness:** the filters are status, visibility and `is_forced_private`. Confirm that account
       suspension or deletion and `projects.is_public = false` (the `comic_hold_unlists` trigger) always end in a
       non-live publication.
    7. **comic_featured** stays service-only (RLS on, no policies). Confirm no other migration adds a policy, and
       define the staff write path.
    8. **Exposure:** `likes_count` and the trending order disclose relative readership; the cursor is slug-only.
       Confirm this is acceptable.
    9. After the apply, run `get_advisors(security)` and check that `comic_discover_kind` is not executable by anon or
       authenticated.
- **The UI is DS-R6 (S3)**, behind `DISCOVER_V2_STAGE` (DS-R3's flag; redesign plan §12). It builds against a fake of
  this contract (`components/discover/discoverApi.fake.ts`, DS-R6) until the SQL is applied.
- **Plan:** redesign plan §0, §1.3 and §3.5 (Discover), §10 DS-R2, §13 R-D3, §14 risk 6.

**What it is for:** public comics are browsed from a cached edge listing that keeps the backend container asleep.
A creator's byline shows only when they turned on "Show my username" for that comic.

## 1. Routes (the dreamstream-api Worker, `api-proxy/src/publicDiscover.ts`)

Both answer at the edge, after the agent gate and before the container proxy (`proxy.ts`). Neither can change anything.

| Route | Answer |
|---|---|
| `GET\|HEAD /api/comic/public/discover?sort=&q=&rating=&lang=&kind=&length=&week=&limit=&cursor=` | `DiscoverPage` = `{ items, next? }` |
| `GET\|HEAD /api/comic/public/discover/shelves?rating=&lang=&kind=&your_lang=` | `{ shelves }`: only the shelves worth showing |

**Parameters** (strict: an unknown, repeated or malformed one is a 400, before any database call):

| Param | Values | Meaning |
|---|---|---|
| `sort` | `trending` (default) · `new` · `most_read` | Trending = reads in the last 7 days. New = first published, newest first (a republish does not move a comic up). Most read = all-time reads. A read counts each reader once a day (`comic_publication_track`), so a reader who comes back on another day counts again |
| `q` | ≤ 60 characters | Title, description, a translated title, or a creator's username where the byline is shown |
| `rating` | `kids` · `G` · `PG` · `PG-13` | `kids` = G or PG; an unrated comic is never kids-friendly |
| `lang` | a language code (`en`, `pt-BR`) | Only comics published in it; titles shown in that edition |
| `kind` | `comic` · `manga` · `webtoon` · `strip` · `storybook` | |
| `length` | `short` (1–8 pages) · `medium` (9–24) · `long` (25+) | |
| `week` | `1` | New this week (first published ≤ 7 days ago) or Trending this week (read this week) |
| `limit` | 1–24 (default 24) | |
| `cursor` | the previous page's `next` | Opaque; bound to its sort; names the page's last comic only, never a score. If that comic has left the listing (held, unpublished, filtered out) the answer is an empty page with no `next`: start again |
| `your_lang` (shelves) | a language code | The reader's language, for "In your language" (not with `lang`) |

**Answers:**
- **400** `BAD_REQUEST`, no-store: a calm reason ("Unknown kind.").
- **429** `RATE_LIMIT`, `retry-after: 60`: the public comic limiter `PUBLIC_COMIC_RL` (key `discover:<ip>`, the same
  120 per minute binding the share routes use). Malformed requests count too.
- **503** `UNAVAILABLE`, no-store, `retry-after: 5`: the database did not answer in 4 s, answered an error, or the
  SQL is not applied yet (PostgREST's 404). Never shown as "nothing here".
- **200**: `cache-control: public, max-age=30, s-maxage=30`, `vary: Origin`. The body is also kept 30 s in the edge
  cache (`caches.default`) under the canonical query (parameter order, defaults and language case folded), without
  any CORS header; CORS is added per request for our sites only. A hold or an unpublish therefore leaves every listing
  within 60 s, and `/c/<slug>` (never cached) stops at once.
- **405** for other methods; **404** at the edge for any other path under `/discover` (it never wakes the container).

## 2. What a listing may say (the allow-list)

`shared/comic/discovery.ts` `DiscoverItem` is the complete list:
`slug`, `title`, `description`, `kind`, `pageCount`, `aspect`, `cover {w480, w1080}`, `rating`, `languages`,
`publishedAt`, `firstPublishedAt`, `likes`, `themeColor`, `creator {username, avatarUrl}`.

- **Never** the snapshot, safety data, an asset key or a user id. **No view counts or reader statistics, not even
  in the cursor:** the ranking score (7-day reads for Trending, all-time reads for Most read, the staff rank for
  Featured) stays inside the RPC, because `comic_publication_stats` is owner-only under RLS and anyone may page with
  `limit=1`. `next` is `<sort code>.<slug>` (§3).
- **`cover`** is the published cover's opaque copies (else page 1's), only under that publication's own `pub/<key>/`
  prefix; both sizes are always set (a missing variant falls back to the nearest copy). The edge turns the paths into
  public storage URLs; the UI refuses any cover that is not a `pub/` copy in our storage.
- **`creator`** only when the publication shows its creator (`comic_publications.show_creator`, the "Show my
  username" switch, default off), with the current username from `profiles`.
- **`avatarUrl`** only for an avatar in our storage (this project's own Supabase origin) whose URL holds no id.
  Uploaded avatars live at `<uid>/avatar-…` (`services/db.ts` `clientUploadPath`; the bucket's policies require the
  uid folder), so in practice a byline shows the username only and the UI draws the initial. Showing uploaded avatars
  needs an opaque copy (for example `pub/<key>/avatar-…` made at publish when the byline is on): deferred, and a
  follow-up ask-first SQL change.
  - **Lead decision (2026-11-12, D11 at the S2b integration): confirmed.** The row lists `creator {username,
    avatarUrl}` and also "never user ids"; the second wins, so an avatarUrl is sent only from our storage with no id in
    the URL, and in practice a byline shows the username and an initial until opaque copies exist (wave note 6).
    DS-R6's PublishPanel hint says only the username shows, not the avatar.
- **Search** finds a username only where that username is shown, so a hidden byline cannot be found by searching for
  the creator.

The Worker rebuilds every item from this list (`discoverPageFromRpc`, `discoverShelvesFromRpc`) and the UI checks it
again (`decodeDiscoverPage`, `decodeDiscoverShelves`), so a field the RPC adds by mistake never reaches a component.

## 3. The SQL (`server/sql/comic_discovery.sql`, ask-first)

| Object | What it is |
|---|---|
| `comic_discover_list(p_sort, p_q, p_rating, p_lang, p_kind, p_length, p_week, p_limit, p_after_slug)` | One keyset page. SECURITY DEFINER, `search_path = public`, anon-executable |
| `comic_discover_shelves(p_rating, p_lang, p_kind, p_your_lang)` | The home: featured, trending (this week), new (this week), kids (G/PG only, whatever the chips; hidden under a rating chip), lang (`p_your_lang`, hidden under a language chip), webtoon and manga (hidden under a kind chip); each shelf is a `comic_discover_list` call (12 comics) that reads no table itself |
| `comic_featured` | Staff picks (`rank`, optional `starts_at` / `ends_at`, a staff note). Service-only: RLS on, no policies, no client grants. Seeded by SQL for now |
| `comic_discover_kind(card)` | Internal helper: the kind from the frozen card's `kindLabel` (keeps filtering off the snapshot). Not client-callable |
| `comic_publication_stats_day_idx` | Index on `comic_publication_stats(day)` for the 7-day trending window |

- **Only live public comics, never held ones.** Every query that reads `comic_publications` keeps
  `status = 'live'`, `visibility = 'public'` and a project that moderation has not forced private, in the ranking and
  again where the items are built.
- **Fail closed.** An unknown sort, rating, kind, length or language, or a malformed cursor, answers an empty page, never an
  unfiltered one (the anon RPCs can be called without the Worker). The limit is clamped to 1..24. A search is cut to 60
  characters and its `%`, `_` and `\` are escaped.
- **Keyset.** `(n, slug)` descending, where `n` is the 7-day reads, the first publish time in microseconds, the
  all-time reads, or the featured rank (a read counts each reader once a day). `n` never leaves the function: one
  `base` query ranks every comic the query lists, and the page continues after the cursor comic's **current** `n`,
  looked up by its slug (`p_after_slug`). A slug that is not in `base` (held, unpublished, unlisted, filtered out,
  unknown) answers an empty page with `next` null, never the whole listing and never a hint that the comic exists.
  An earlier draft carried `n` in the cursor (`p_after_n`); the file drops that signature so no second overload
  survives on a database that had it.
- **Moving scores.** Trending and Most read change while someone pages, so an item can repeat or be skipped between
  page loads (never within a page): DS-R6 dedupes by slug across pages.
- **Cost.** One ranking pass over the public rows plus the last 7 days of stats, then the snapshot is read for the ≤ 25
  rows of the page only (their cover copies). The shelves are 7 such passes, cached at the edge. Past ~10k public
  comics, add per-sort indexes and split the ranking per sort.

## 4. Seeding featured picks (service role / SQL editor)

```sql
insert into public.comic_featured (publication_id, rank, starts_at, ends_at)
select id, 10, now(), now() + interval '14 days' from public.comic_publications where slug = '<slug>'
on conflict (publication_id) do update set rank = excluded.rank, starts_at = excluded.starts_at, ends_at = excluded.ends_at;
```

A held, unpublished or unlisted comic never shows, even when featured. Featured hides when nothing is featured.

## 5. Tests

| File | What it proves |
|---|---|
| `server/sql/tests/comic_discovery.test.sql` (psql harness, `sqlHarness.test.ts`) | On a throwaway Postgres: every live public comic exactly once across the pages of every sort (paging by the slug cursor) and nothing else (unlisted, unpublished, suspended, held); full pages; `next` is the slug only in every sort, featured included; a cursor outside the listing is an empty page; only allow-listed keys; the creator and avatar rules; the cover prefix; the limit clamp; LIKE escaping and the username-search rule; filters; fail-closed inputs; the week windows; featured windows; the shelves (Kids-friendly is G/PG only); privileges; a later hold leaves the listing; re-apply is safe |
| `tests/config/discoveryListingGuard.test.ts` | The SQL text the lead applies: SECURITY DEFINER and `search_path`, the three clauses in every query over `comic_publications`, and no other reference to that table under any alias, schema or quoting; the shelves read no table themselves and each passes exactly its arguments; the item keys; no score in an item or the cursor; the slug keyset; the creator rule, the limit and LIKE escaping, the fail-closed sets, `comic_featured` service-only, the index; the limits, kinds, lengths and RPC arguments match the codec and the server's card labels |
| `shared/comic/discovery.test.ts` | Strict queries, the canonical cache key, the cursor (`<sort>.<slug>`, no number even when the RPC sends one), the allow-list both ways (round-trips, unknown fields dropped), covers, avatars, shelves |
| `api-proxy/src/publicDiscover.test.ts` | Against a fake RPC: 400 before any database call, 429, the cache header and the edge cache (`vary: Origin` on hits and misses), 503 + no-store on a timeout (fake timers through the real RPC client) and on the SQL not applied, HEAD, only allow-listed fields, an avatar from another Supabase project dropped, no reader count in the cursor, the dispatch in `proxy.ts` |

## 6. Deferred, and why

- **Uploaded avatars** on bylines: they need an opaque copy (§2).
- **"From creators you follow"** needs a signed-in listing; **Keep reading** and **Saved** are device-local (DS-R6).
- **Classic (pre-v4) comics** stay on the existing gallery query (DS-R6 `classicListing.ts`), not in these RPCs.
- **A trigram index for search**: the public set is small; the edge cache and the limiter bound the cost.
- **An admin "Feature" UI**: SQL seeding first (§4).
