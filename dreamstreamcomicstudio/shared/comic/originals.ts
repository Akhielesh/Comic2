/** Public editorial identifiers follow the reader's ordinary seventeen-character share format. */
export const ORIGINAL_SLUGS = {
  tide: 'DSOriginalTide001',
  orchard: 'DSOriginalTree001',
  fox: 'DSOriginalFox0001',
  'table-nine': 'DSOriginalNine001',
  harbor: 'DSOriginalPort001',
  margin: 'DSOriginalMarg001',
  parrots: 'DSOriginalBird001',
  bubble: 'DSOriginalBubl001',
  'glass-hills': 'DSOriginalWest001',
  'night-atlas': 'DSOriginalNite001'
} as const;
export type OriginalKey = keyof typeof ORIGINAL_SLUGS;
export const ORIGINAL_KEYS = Object.keys(ORIGINAL_SLUGS) as OriginalKey[];
/** A held edition keeps its original identifier and private audit history. Only current books enter the publisher. */
export const PUBLISHABLE_ORIGINAL_KEYS = [
  'orchard',
  'fox',
  'table-nine',
  'harbor',
  'margin',
  'parrots',
  'bubble',
  'glass-hills',
  'night-atlas'
] as const satisfies readonly OriginalKey[];
const publishableKeys: ReadonlySet<string> = new Set(PUBLISHABLE_ORIGINAL_KEYS);
export const isPublishableOriginal = (key: string): boolean => publishableKeys.has(key);

type OriginalFormat = { kind: 'comic' | 'manga'; readingDirection: 'ltr' | 'rtl'; orientation: 'portrait' | 'landscape'; colorMode?: 'bw' };
type CollectionKey = Exclude<OriginalKey, 'tide' | 'orchard' | 'fox' | 'table-nine' | 'harbor'>;
export type CollectionEdition = OriginalFormat & { title: string; pages: number };

const portraitComic = { kind: 'comic', readingDirection: 'ltr', orientation: 'portrait' } as const;
const landscapeComic = { ...portraitComic, orientation: 'landscape' } as const;
const collectionEditions: Partial<Record<OriginalKey, CollectionEdition>> = {
  margin: { title: 'The Girl in the Margin', pages: 30, kind: 'manga', readingDirection: 'rtl', orientation: 'portrait', colorMode: 'bw' },
  parrots: { title: 'The Weaver and the Seventh Parrot', pages: 20, ...portraitComic },
  bubble: { title: 'Pip and the Unsent Bubble', pages: 15, ...portraitComic },
  'glass-hills': { title: 'West of the Glass Hills', pages: 20, ...landscapeComic },
  'night-atlas': { title: 'The Night Garden Atlas', pages: 15, ...landscapeComic }
} satisfies Record<CollectionKey, CollectionEdition>;
export const collectionEdition = (key: OriginalKey): CollectionEdition | undefined => collectionEditions[key];
/** The first five registered sources used a fixed fifteen-page metadata format. */
export const originalStoryPages = (key: OriginalKey): number => collectionEdition(key)?.pages ?? 15;
const keysBySlug = new Map<string, OriginalKey>(ORIGINAL_KEYS.map((key) => [ORIGINAL_SLUGS[key], key]));
export const originalKeyForSlug = (slug: string): OriginalKey | undefined => keysBySlug.get(slug);
export const isOriginalSlug = (slug: string): boolean => keysBySlug.has(slug);
