# Public Library: what a visitor sees listed

Code: `services/publicListing.ts` (the rule), `components/PublicGallery.tsx` (the Library on both hosts),
`services/db.ts` `getPublicProjectsByUser` (a public profile's comics), `services/stats.ts` (public counts). Tests: `services/publicListing.test.ts`,
`components/PublicGallery.test.tsx`, `services/db.publicProjects.test.ts`.

## The rule

Member publications use the same listing rule in the Library, profile grids and studio counts. A member comic must pass the publish check and satisfy every condition below on its `projects` row.

| Part | Who writes it |
|---|---|
| `is_public = true`, `is_forced_private` not true | the server mirror (v4 rows); moderation holds |
| `state.studioVersion = 4` | the studio's store; pinned on client writes by `projects_guard_publication_state` |
| `state.shareSlug` (17 letters and digits) | the server mirror at publish; removed at unpublish |
| `content_rating` in G, PG, PG-13 | the server mirror at publish; a client cannot set it (`projects_guard_content_rating`) |

The rating is the part an owner cannot forge, so an older comic that copies the studio keys into its own state is
still not listed. G, PG and PG-13 are the only ratings a publication carries, which also keeps the PG-13 ceiling.

The rule runs twice: as PostgREST filters in the query (`filterPublicListing`: hidden rows are never downloaded) and
again on the rows that come back (`isPubliclyListed`, a backstop). The Library's first page asks for an exact count, so
"N comics" counts every listed comic, less any the backstop dropped.

What the rule is, and is not: it decides what the public lists show and count. It is not access control. Every
`projects` row with `is_public = true` stays readable through the API under the existing select policy (public or
owner), as before this release; an older public comic is hidden from lists, not made private. Making older public
rows reachable by id only would take a view or function that applies the rule and a narrower select policy (a
schema change, not part of this release).

## Older comics

`LEGACY_PUBLIC_LISTING = false`: comics made before the current Comic Studio are not listed or counted anywhere public.
Nothing about them changes, and a direct link (`/?view=read&id=…`, `getPublicProject`) still opens one. Setting the
constant to true brings back the old rule (public and not held) for every list at once.

## Discover and reading progress

Discover is the default Library order. It recommends up to three comics from the first 48 eligible results. Likes and completed or unfinished reads can match another story through words shared by its published title and synopsis. A recommendation explains which comic prompted it. The remaining entries keep their catalog order. Without a match, Discover mixes popular and newer publications, preferring different creators and rating categories when available. The standard Trending and Recent orders, title search and Kids-friendly filter are also available.

Guests keep up to 24 recent public reading positions in tab session storage. Clearing reading history removes these positions. Guests’ earlier bookmarks stay separate. Neither guest history nor device bookmarks are imported into a member account.

Members can open **Reading progress → Sync my reading progress** in the Library. Sync starts off. An opted-in member’s public reader saves the last actual page displayed, and their Library on another signed-in device can resume at that page. **Clear reading history** erases the saved positions across devices. **Turn off sync and delete progress** also withdraws consent. A tab opened under the old consent or book revision cannot restore a cleared or superseded position. If the account service is unavailable, the catalog and reader remain usable; the control offers a refresh.

The account stores the publication ID, page, database timestamp and revision. The consenting member can retrieve up to 24 positions from the past 30 days. Owner previews, embeds and unlisted links are excluded. Visibility, current publication slug, rating, moderation holds and frozen page bounds are checked in the database. Withdrawals, rotations and moderation holds remove affected saved positions. Discovery also rechecks the public listing before showing a card or using its published title as a recommendation reason.

Apply `server/sql/comic_reader_library.sql` after `comic_publications.sql` and the project content-rating guard. Its authenticated, owner-bound `comic_reader_library` RPC exposes no direct table grants. The migration installs a ten-minute, bounded expiry cleanup when `pg_cron` is enabled. On installations without `pg_cron`, schedule `select comic_reader_private.expire_positions()` as the migration owner for physical expiry of inactive accounts’ rows. Reads always enforce the 30-day boundary. Auth-user deletions cascade. The rollback path is to revert the client, unschedule `comic-reader-expiry` if installed, and withdraw the authenticated execute grants on both the public wrapper and the private implementation. Preserve private records for recovery unless an intentional data deletion has been approved.

An unfinished comic opens directly at its saved page. Older reads beyond the first page and recent likes are revalidated against the same public catalog before use.

## Studio Originals

The Library combines the approved editorial editions from `comic_originals_catalog()` with member results. Each editorial card carries the DreamStream Studio Originals byline, published cover and story-page count. Title search, rating filters, local guest reading history and recommendations include these books. Member project pagination, likes, profile grids and account reading history keep their existing scope.

Readers can search by art style, format, reading direction or page count. **Start a comic like this** opens an editable brief in the same tab, including after sign-up or sign-in. A sign-up verification link opened in another browser can restore the selection through its registered public edition identifier. The brief carries over the public art technique and reading format. The Director plans the new story and shows a quote before any drawing begins.

Each registered editorial slug uses its own published share-card and frozen-payload RPC on the ordinary `/c/<slug>`, embed and oEmbed routes. Withdrawing the publication removes its Library entry and makes its reader unavailable. Editorial feedback opens the shared report form with the title and current page editable before submission.

### Registering and publishing an edition

The publisher runs each registered current edition independently. Apply `server/sql/studio_original_harbor.sql` after `studio_original_editions.sql` to register Harbor’s independent identifier. The migration checks for member slug collisions. Harbor first appears at `/c/DSOriginalPort001` once the deployed publisher has checked its manuscript, cover and fifteen page illustrations and verified the uploaded bytes. The normal publication workflow waits for the deployed backend to match the selected Git revision.

Apply `server/sql/studio_original_collection.sql` after the Harbor, rating-review and Discover migrations. The collection registers `margin`, `parrots`, `bubble`, `glass-hills` and `night-atlas`. Their source manifests include the title, reading direction, comic kind and orientation. The publisher verifies physical dimensions on the cover and every story page, plus the exact number of numbered pages assigned in `shared/comic/originals.ts`. Each edition’s first publication requires text, cover and all its illustrations to pass the ordinary gate. The frozen reader keeps its reading direction and derives its supported aspect ratio from the artwork.

Tide’s identifier is reserved for its historical record. Operators can inspect its bundled files offline with `npx tsx scripts/ops/studioOriginal.ts check tide server/assets/originals`. The publisher rejects a release request for the held edition.

## A small Library

With no listed Originals and `LIBRARY_TOOLS_MIN` (6) member comics or fewer the Library shows the comics and nothing else: no search box, sort,
Kids-friendly toggle or visible count (the count stays in a screen-reader status). With none it shows the Studio samples
alone, never an empty shelf. With one or two (`LIBRARY_FEW_MAX`) a cover grid would leave most of its row empty, so
each comic is a wide card the shape of the Studio samples below it: the cover on the left; title, date and "Read
comic" on the right (one link), the likes at its foot; two a row from `sm`, one below. The page is the `<main>` landmark. Cards carry no maker name: profiles are readable by their owner only, and a publication's
"show my name" choice is not on the listing row.

## Reading without an account

A listed card links to the comic's share page `/c/<slug>` (a plain link: a full page load the share reader owns), which
the app serves to everyone (`publiccomic` view; not in App's protected views). The Library itself is not protected
either. Likes are shown to visitors as a count; only a signed-in reader gets the like button. A card shows its read
count only when it is above zero: a current Comic Studio comic's reads are counted with its publication
(`comic_publication_stats`), not on the `projects` row, so the row's count stays 0 and is left out rather than shown.

## Catalog queries

The Library reads eligible member publications from `projects` and editorial publications from `comic_originals_catalog()`. The production Discover list and shelf RPCs also include published Studio Originals and enforce their rating and visibility filters. Member reading progress uses its own authenticated RPC. See [Discover](discovery.md).
