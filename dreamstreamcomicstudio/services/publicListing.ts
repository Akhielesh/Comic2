/**
 * Which public comics a signed-out visitor sees listed (the Library, a public profile's grid, and any count
 * of them). One rule for every list, applied twice: in the database query (PostgREST filters, so hidden rows
 * are never downloaded) and again on the client over the rows that came back (a backstop).
 *
 * The rule: a comic is listed when it is a current Comic Studio publication that passed the publish check.
 * On its `projects` row that is all of
 *   - `is_public` true and `is_forced_private` not true (moderation holds stay out; unchanged from before);
 *   - `state.studioVersion` = 4: written by the studio's own store, and pinned by the database guard
 *     `projects_guard_publication_state` on every client write to a studio comic;
 *   - `state.shareSlug` a well-formed slug: mirrored by the server when the comic is published, removed when
 *     it is unpublished (server/src/comic/publication/store.ts `mirrorState`);
 *   - `content_rating` one of G, PG, PG-13: the publish gate's rating, mirrored by the server at publish. The
 *     database trigger `projects_guard_content_rating` keeps a client from setting it, so an older comic
 *     cannot dress itself up as a publication by editing its own state keys. G, PG and PG-13 are the only
 *     ratings a publication can carry (the PG-13 ceiling), so this also keeps that ceiling.
 *
 * Older comics, made before the current Comic Studio, are not listed while LEGACY_PUBLIC_LISTING is false.
 * They are not deleted or changed, and a direct link to one still opens it (`getPublicProject` is a lookup
 * by id, not a listing). Turn this back on when those comics have been moved to the current studio.
 */
import { COMIC_STUDIO_VERSION } from './studioDeepLink';
import { SLUG_RE } from '../shared/comic/publication';
import { CONTENT_RATINGS, isContentRating } from '../shared/comic/safety';

export const LEGACY_PUBLIC_LISTING = false;

/** The ratings a listed comic may carry (the publish gate's scale, PG-13 at most). */
export const LISTED_RATINGS: readonly string[] = CONTENT_RATINGS;

/** The fields of a `projects` row (or a card built from one) that the rule reads. */
export interface PublicListingRow {
  is_public?: unknown;
  is_forced_private?: unknown;
  content_rating?: unknown;
  state?: unknown;
}

const stateKey = (state: unknown, key: string): unknown =>
  state && typeof state === 'object' && !Array.isArray(state) ? (state as Record<string, unknown>)[key] : undefined;

/** True for a public row that is a current Comic Studio publication (whatever the legacy switch says). */
export const isCurrentStudioListing = (row: PublicListingRow | null | undefined): boolean => {
  if (!row || row.is_public !== true || row.is_forced_private === true) return false;
  const slug = stateKey(row.state, 'shareSlug');
  return stateKey(row.state, 'studioVersion') === COMIC_STUDIO_VERSION
    && typeof slug === 'string' && SLUG_RE.test(slug)
    && isContentRating(row.content_rating);
};

/** True for a row a public list may show and count. */
export const isPubliclyListed = (row: PublicListingRow | null | undefined, legacy: boolean = LEGACY_PUBLIC_LISTING): boolean =>
  legacy ? !!row && row.is_public === true && row.is_forced_private !== true : isCurrentStudioListing(row);

/** The filter methods of a PostgREST query builder this module uses (each returns the builder). */
export interface ListingQuery {
  eq(column: string, value: unknown): ListingQuery;
  not(column: string, operator: string, value: unknown): ListingQuery;
  in(column: string, values: readonly unknown[]): ListingQuery;
}

/**
 * Adds the listing rule to a `projects` query, so the database returns only listed rows. `state->>studioVersion`
 * compares as text ('4'); a row missing a key reads as null there and is left out. The builder's own type is
 * kept (the cast only spares the compiler from expanding Supabase's deep generic types).
 */
export const filterPublicListing = <Q>(query: Q, legacy: boolean = LEGACY_PUBLIC_LISTING): Q => {
  const base = (query as unknown as ListingQuery).eq('is_public', true).not('is_forced_private', 'is', true);
  if (legacy) return base as unknown as Q;
  return base
    .eq('state->>studioVersion', String(COMIC_STUDIO_VERSION))
    .not('state->>shareSlug', 'is', null)
    .in('content_rating', LISTED_RATINGS) as unknown as Q;
};
