# Public Library: what a visitor sees listed

Code: `services/publicListing.ts` (the rule), `components/PublicGallery.tsx` (the Library on both hosts),
`services/db.ts` `getPublicProjectsByUser` (a public profile's comics). Tests: `services/publicListing.test.ts`,
`components/PublicGallery.test.tsx`, `services/db.publicProjects.test.ts`.

## The rule

Every public list a signed-out visitor can reach (the Library grid, its search and its count, a public profile's grid
and its count) shows the same comics: the current Comic Studio publications that passed the publish check. On a
`projects` row that is all of:

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

## Older comics

`LEGACY_PUBLIC_LISTING = false`: comics made before the current Comic Studio are not listed or counted anywhere public.
Nothing about them changes, and a direct link (`/?view=read&id=…`, `getPublicProject`) still opens one. Setting the
constant to true brings back the old rule (public and not held) for every list at once.

## A small Library

With `LIBRARY_TOOLS_MIN` (6) comics or fewer the Library shows the comics and nothing else: no search box, sort,
Kids-friendly toggle or visible count (the count stays in a screen-reader status). With none it shows the Studio samples
alone, never an empty shelf. Cards carry no maker name: profiles are readable by their owner only, and a publication's
"show my name" choice is not on the listing row.

## Reading without an account

A listed card links to the comic's share page `/c/<slug>` (a plain link: a full page load the share reader owns), which
the app serves to everyone (`publiccomic` view; not in App's protected views). The Library itself is not protected
either. Likes are shown to visitors as a count; only a signed-in reader gets the like button. A card shows its read
count only when it is above zero: a current Comic Studio comic's reads are counted with its publication
(`comic_publication_stats`), not on the `projects` row, so the row's count stays 0 and is left out rather than shown.

## Not used here

The Discover RPCs (`comic_discover_list`, `comic_discover_shelves`, `server/sql/comic_discovery.sql`, see
`discovery.md`) are not applied in production, so the Library reads `projects` directly and adds no SQL.
