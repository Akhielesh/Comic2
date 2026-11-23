import { SLUG_RE } from '../shared/comic/publication';
import { READ_PAGE_MAX } from '../shared/comic/reading';
import type { ContentRating } from '../shared/comic/safety';

export interface LibraryRead {
  slug: string;
  page: number;
  lastPage: number;
  at: number;
}
const HISTORY_AGE = 30 * 24 * 60 * 60 * 1000;
const HISTORY_LIMIT = 24;
export const GUEST_LIBRARY_HISTORY_KEY = 'ds.library.reads.v1.guest';
export const LIBRARY_HISTORY_CHANGED = 'ds:library-history-changed';

function validRead(row: LibraryRead, now: number) {
  return (
    row &&
    typeof row.slug === 'string' &&
    SLUG_RE.test(row.slug) &&
    Number.isSafeInteger(row.page) &&
    Number.isSafeInteger(row.lastPage) &&
    row.page > 0 &&
    row.page <= row.lastPage &&
    row.lastPage <= READ_PAGE_MAX &&
    Number.isFinite(row.at) &&
    now >= row.at &&
    now - row.at < HISTORY_AGE
  );
}
export function libraryReads(now = Date.now()): LibraryRead[] {
  try {
    const data = JSON.parse(window.sessionStorage.getItem(GUEST_LIBRARY_HISTORY_KEY) ?? '[]');
    if (!Array.isArray(data)) return [];
    const seen = new Set<string>();
    return data
      .filter((row) => validRead(row, now))
      .sort((a, b) => b.at - a.at)
      .filter((row) => {
        if (seen.has(row.slug)) return false;
        seen.add(row.slug);
        return true;
      })
      .slice(0, HISTORY_LIMIT);
  } catch {
    return [];
  }
}
export function rememberLibraryPage(
  publication: { slug: string; visibility: 'unlisted' | 'public' },
  page: number,
  lastPage: number
) {
  if (publication.visibility !== 'public') return;
  const at = Date.now();
  const next = { slug: publication.slug, page, lastPage, at };
  if (!validRead(next, at)) return;
  try {
    const old = libraryReads(at);
    if (
      old[0]?.slug === next.slug &&
      old[0].page === page &&
      old[0].lastPage === lastPage &&
      at - old[0].at < 60_000
    )
      return;
    window.sessionStorage.setItem(
      GUEST_LIBRARY_HISTORY_KEY,
      JSON.stringify([next, ...old.filter((row) => row.slug !== next.slug)].slice(0, HISTORY_LIMIT))
    );
    window.dispatchEvent(new Event(LIBRARY_HISTORY_CHANGED));
  } catch {
    /* Storage can be disabled while the reader stays usable. */
  }
}
export function clearLibraryReads() {
  try {
    window.sessionStorage.removeItem(GUEST_LIBRARY_HISTORY_KEY);
    window.dispatchEvent(new Event(LIBRARY_HISTORY_CHANGED));
  } catch {
    /* Nothing stored. */
  }
}

export interface DiscoveryComic {
  slug: string;
  title: string;
  overview: string;
  owner?: string;
  rating?: ContentRating;
  likes: number;
  publishedAt: number;
  liked: boolean;
}
export interface LibraryPick {
  slug: string;
  reason: string;
  resumePage?: number;
}
const filler = new Set(
  'the and for with from that this their they into over through when where will what who whose then than are has had have can out one her his she its you your new tale story comic chapter part volume book las los del una con para les des est une der die das und ein'.split(
    ' '
  )
);
function words(s: string) {
  const tokens =
    s
      .slice(0, 900)
      .toLowerCase()
      .normalize('NFKC')
      .match(/[\p{L}][\p{L}\p{M}'’-]{2,}/gu) ?? [];
  return new Set(tokens.filter((word) => !filler.has(word)));
}

/** Both seeds and candidates come from the same, currently revalidated public listing. Titles are never read from history. */
export function libraryPicks(
  catalog: DiscoveryComic[],
  reads: LibraryRead[],
  extraSeeds: DiscoveryComic[] = []
): LibraryPick[] {
  const visible = new Map<string, DiscoveryComic>();
  for (const item of [...catalog, ...extraSeeds])
    if (SLUG_RE.test(item.slug) && !visible.has(item.slug)) visible.set(item.slug, item);
  const positions = new Map(reads.map((r) => [r.slug, r]));
  const result: LibraryPick[] = [];
  const selected = new Set<string>();
  const usedOwners = new Set<string>();
  const usedRatings = new Set<ContentRating>();
  const add = (item: DiscoveryComic, reason: string, resumePage?: number) => {
    result.push({ slug: item.slug, reason, resumePage });
    selected.add(item.slug);
    if (item.owner) usedOwners.add(item.owner);
    if (item.rating) usedRatings.add(item.rating);
  };
  for (const read of reads) {
    const item = visible.get(read.slug);
    if (item && read.page < read.lastPage) {
      add(item, 'Continue from page ' + read.page, read.page);
      break;
    }
  }
  const candidates = [
    ...new Map(catalog.filter((c) => SLUG_RE.test(c.slug)).map((c) => [c.slug, c])).values()
  ].filter((c) => !positions.has(c.slug) && !c.liked);
  const seeds = [...visible.values()].filter((c) => c.liked || positions.has(c.slug));
  const keywords = new Map([...visible.values()].map((c) => [c.slug, words(c.title + ' ' + c.overview)]));
  const docFreq = new Map<string, number>();
  for (const set of keywords.values()) for (const word of set) docFreq.set(word, (docFreq.get(word) ?? 0) + 1);
  const matches = candidates
    .flatMap((item) => {
      let best: { item: DiscoveryComic; score: number; reason: string } | undefined;
      for (const seed of seeds) {
        let score = 0;
        for (const term of keywords.get(seed.slug)!) {
          const n = docFreq.get(term)!;
          if (keywords.get(item.slug)!.has(term) && n <= Math.max(2, visible.size / 2)) score += 1 / n;
        }
        if (score > 0 && (!best || score > best.score))
          best = {
            item,
            score,
            reason: 'Because you ' + (seed.liked ? 'liked' : 'read') + ' “' + seed.title + '”'
          };
      }
      return best ? [best] : [];
    })
    .sort((a, b) => b.score - a.score || b.item.likes - a.item.likes);
  for (const match of matches) {
    if (result.length === 3) break;
    if (!usedOwners.has(match.item.owner ?? '') || !result.some((r) => r.reason.startsWith('Because you')))
      add(match.item, match.reason);
  }
  // Balance a popular pick, a newer publication and other creators when available.
  for (const sort of ['popular', 'recent', 'variety'] as const) {
    if (result.length === 3) break;
    const available = candidates.filter((c) => !selected.has(c.slug));
    if (!available.length) break;
    const freshCreators = available.filter((c) => !c.owner || !usedOwners.has(c.owner));
    const creators = freshCreators.length ? freshCreators : available;
    const differentRatings =
      sort === 'variety' ? creators.filter((c) => c.rating && !usedRatings.has(c.rating)) : [];
    const pool = differentRatings.length ? differentRatings : creators;
    pool.sort((a, b) =>
      sort === 'recent'
        ? b.publishedAt - a.publishedAt || b.likes - a.likes
        : b.likes - a.likes || b.publishedAt - a.publishedAt
    );
    const item = pool[0];
    const reason =
      sort === 'popular' && item.likes > 0
        ? 'Liked by readers'
        : sort === 'recent' && item.publishedAt
          ? 'Published ' +
            new Date(item.publishedAt).toLocaleDateString(undefined, { month: 'short', year: 'numeric' })
          : '';
    add(item, reason);
  }
  return result;
}
