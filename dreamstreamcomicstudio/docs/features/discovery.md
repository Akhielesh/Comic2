# Discover: the public listing (edge route, RPCs, codec)

**Status:**
- **DS-R2 (S2) built the data path only:** the SQL, the edge route and the shared codec. Nothing on screen changes yet.
- **The SQL is ask-first (owner decision R-D3).** `server/sql/comic_discovery.sql` is written and tested, not applied.
  The lead applies it after the security review and before the PR that turns Discover on for admins (redesign plan
  §11.3 M12). Until then the edge route answers 503 ("Discover is taking a moment"), never an empty Discover.
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
| `sort` | `trending` (default) · `new` · `most_read` | Trending = unique readers in the last 7 days. New = first published, newest first (a republish does not move a comic up). Most read = unique readers ever |
| `q` | ≤ 60 characters | Title, description, a translated title, or a creator's username where the byline is shown |
| `rating` | `kids` · `G` · `PG` · `PG-13` | `kids` = G or PG; an unrated comic is never kids-friendly |
| `lang` | a language code (`en`, `pt-BR`) | Only comics published in it; titles shown in that edition |
| `kind` | `comic` · `manga` · `webtoon` · `strip` · `storybook` | |
| `length` | `short` (1–8 pages) · `medium` (9–24) · `long` (25+) | |
| `week` | `1` | New this week (first published ≤ 7 days ago) or Trending this week (read this week) |
| `limit` | 1–24 (default 24) | |
| `cursor` | the previous page's `next` | Opaque; bound to its sort |
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

- **Never** the snapshot, safety data, an asset key or a user id. No view counts.
- **`cover`** is the published cover's opaque copies (else page 1's), only under that publication's own `pub/<key>/`
  prefix; both sizes are always set (a missing variant falls back to the nearest copy). The edge turns the paths into
  public storage URLs; the UI refuses any cover that is not a `pub/` copy in our storage.
- **`creator`** only when the publication shows its creator (`comic_publications.show_creator`, the "Show my
  username" switch, default off), with the current username from `profiles`.
- **`avatarUrl`** only for an avatar in our storage whose URL holds no id. Uploaded avatars live at
  `<uid>/avatar-…` (`services/db.ts` `clientUploadPath`; the bucket's policies require the uid folder), so today a
  byline shows the username and the UI draws the initial. Showing uploaded avatars needs an opaque copy (for example
  `pub/<key>/avatar-…` made at publish when the byline is on): deferred.
- **Search** finds a username only where that username is shown, so a hidden byline cannot be found by searching for
  the creator.

The Worker rebuilds every item from this list (`discoverPageFromRpc`, `discoverShelvesFromRpc`) and the UI checks it
again (`decodeDiscoverPage`, `decodeDiscoverShelves`), so a field the RPC adds by mistake never reaches a component.

## 3. The SQL (`server/sql/comic_discovery.sql`, ask-first)

| Object | What it is |
|---|---|
| `comic_discover_list(p_sort, p_q, p_rating, p_lang, p_kind, p_length, p_week, p_limit, p_after_n, p_after_slug)` | One keyset page. SECURITY DEFINER, `search_path = public`, anon-executable |
| `comic_discover_shelves(p_rating, p_lang, p_kind, p_your_lang)` | The home: featured, trending (this week), new (this week), kids, lang, webtoon, manga; each shelf is a `comic_discover_list` call (12 comics) |
| `comic_featured` | Staff picks (`rank`, optional `starts_at` / `ends_at`, a staff note). Service-only: RLS on, no policies, no client grants. Seeded by SQL for now |
| `comic_discover_kind(card)` | Internal helper: the kind from the frozen card's `kindLabel` (keeps filtering off the snapshot). Not client-callable |
| `comic_publication_stats_day_idx` | Index on `comic_publication_stats(day)` for the 7-day trending window |

- **Only live public comics, never held ones.** Every query that reads `comic_publications` keeps
  `status = 'live'`, `visibility = 'public'` and a project that moderation has not forced private, in the ranking and
  again where the items are built.
- **Fail closed.** An unknown sort, rating, kind, length or language, or half a cursor, answers an empty page, never an
  unfiltered one (the anon RPCs can be called without the Worker). The limit is clamped to 1..24. A search is cut to 60
  characters and its `%`, `_` and `\` are escaped.
- **Keyset.** `(n, slug)` descending, where `n` is the 7-day unique readers, the first publish time in microseconds, the
  unique readers ever, or the featured rank. The cursor is `n` and the slug of a page's last item.
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
| `server/sql/tests/comic_discovery.test.sql` (psql harness, `sqlHarness.test.ts`) | On a throwaway Postgres: every live public comic exactly once across the pages of every sort and nothing else (unlisted, unpublished, suspended, held); full pages; only allow-listed keys; the creator and avatar rules; the cover prefix; the limit clamp; LIKE escaping and the username-search rule; filters; fail-closed inputs; the week windows; featured windows; the shelves; privileges; a later hold leaves the listing; re-apply is safe |
| `tests/config/discoveryListingGuard.test.ts` | The SQL text the lead applies: SECURITY DEFINER and `search_path`, the three clauses in every query over `comic_publications`, the item keys, the creator rule, the limit and LIKE escaping, the fail-closed sets, `comic_featured` service-only, the index; the limits, kinds, lengths and RPC arguments match the codec and the server's card labels |
| `shared/comic/discovery.test.ts` | Strict queries, the canonical cache key, the cursor, the allow-list both ways (round-trips, unknown fields dropped), covers, avatars, shelves |
| `api-proxy/src/publicDiscover.test.ts` | Against a fake RPC: 400 before any database call, 429, the cache header and the edge cache, 503 + no-store on a timeout (fake timers through the real RPC client) and on the SQL not applied, HEAD, only allow-listed fields, the dispatch in `proxy.ts` |

## 6. Deferred, and why

- **Uploaded avatars** on bylines: they need an opaque copy (§2).
- **"From creators you follow"** needs a signed-in listing; **Keep reading** and **Saved** are device-local (DS-R6).
- **Classic (pre-v4) comics** stay on the existing gallery query (DS-R6 `classicListing.ts`), not in these RPCs.
- **A trigram index for search**: the public set is small; the edge cache and the limiter bound the cost.
- **An admin "Feature" UI**: SQL seeding first (§4).
