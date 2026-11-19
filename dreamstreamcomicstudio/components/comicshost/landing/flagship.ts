// The comics the landing features by name, each through its public share link. Both were checked (read-only) to be
// live, public publications of the current studio, rated inside the PG-13 ceiling. The flagship opens its English
// edition (`?lang=en`): its default edition is not English, and visitors arrive from an English-language post.
// A link here is a plain <a href>: nothing on the landing fetches a comic.

export interface FeaturedComic {
  title: string;
  /** The public share link (comics host, /c/<slug>), with the edition to open. */
  href: string;
  /** The comic's own published description (its share card's), shown under the title. */
  line: string;
  /** Says the link opens the English edition (shown under the title). */
  english?: boolean;
}

/** The flagship: "Brick Legends: Rama Setu", English edition. The one place its link is written. */
export const FLAGSHIP: FeaturedComic = Object.freeze({
  title: 'Brick Legends: Rama Setu',
  href: 'https://comics.dreamstreamstudio.ai/c/GnXtWqO2iUh4l8g7M?lang=en',
  line: 'Prince Rama and his loyal Vanara army inscribe holy names onto giant stone toy-bricks to construct the legendary floating causeway to Lanka.',
  english: true
});

/** A second live, public publication (English only). */
export const SECOND: FeaturedComic = Object.freeze({
  title: 'Calling Card',
  href: 'https://comics.dreamstreamstudio.ai/c/628OT7TSIzIwwgplb',
  line: 'In late 1999, a young Indian graduate student arrives in New Jersey with two steel trunks, navigating dial-up internet, payphones, and snowy campus winters to build an American life from scratch.'
});

export const FEATURED: readonly FeaturedComic[] = Object.freeze([FLAGSHIP, SECOND]);
