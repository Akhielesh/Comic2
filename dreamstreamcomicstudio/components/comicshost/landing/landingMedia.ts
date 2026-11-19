// The landing's pictures and its clip: real Comic Studio screens captured from the QA app (the real components on the
// sample fixture, never production, never anyone's comic, never an admin-only screen), with the fixture's page images
// answered by the product's own sample art (public/assets/comic-sample). How they were made is in
// docs/design/atlas-skin.md, "How the landing pictures were made". Files live in public/landing/ on the same origin;
// landingMedia.test.ts pins that every file exists, is within its budget and is listed here.
//
// `width` / `height` are the display size in CSS pixels; each still's WebP is twice that (sharp on 2x screens). A file
// never changes in place: a new capture gets a new name, so the one-day cache can never show a stale picture.

export interface LandingSources {
  webp?: string;
  webm?: string;
  mp4?: string;
  poster?: string;
}

export type LandingMediaId = 'plan' | 'lettering' | 'languages' | 'share' | 'reader';

export interface LandingMedia {
  id: LandingMediaId;
  kind: 'still' | 'clip';
  width: number;
  height: number;
  alt: string;
  caption: string;
  /** A short name for the clip's Play / Pause control. */
  short?: string;
  light: LandingSources;
  dark: LandingSources;
}

const still = (id: LandingMediaId, width: number, height: number, alt: string, caption: string): LandingMedia => ({
  id,
  kind: 'still',
  width,
  height,
  alt,
  caption,
  light: { webp: `/landing/${id}-light.webp` },
  dark: { webp: `/landing/${id}-dark.webp` }
});

export const LANDING_MEDIA: readonly LandingMedia[] = [
  still(
    'plan',
    390,
    401,
    'The Comic Director’s plan card, listing the comic’s story, format, audience, setting, locked look and cast, each with a Change button.',
    'The Director’s plan for a sample project, agreed before anything is drawn.'
  ),
  still(
    'lettering',
    560,
    480,
    'The page editor with lettering tools for speech, thoughts, captions and sound effects above a lettered comic page.',
    'The page editor on a sample project: every balloon is text you can drag and rewrite.'
  ),
  still(
    'languages',
    560,
    305,
    'A language picker listing the languages a comic can be translated into, each written in its own script.',
    'Adding a language from the Languages tab.'
  ),
  still(
    'share',
    433,
    500,
    'Sharing options for a published comic: a read-only link, a choice of Private, Link only or Library plus link, and switches for downloads and embedding.',
    'The Share sheet of a published sample comic.'
  ),
  {
    id: 'reader',
    kind: 'clip',
    width: 280,
    height: 502,
    alt: 'A lettered comic in the reader on a phone, turning forward two pages and back.',
    caption: 'Turning pages in the reader on a phone, with the studio’s sample art.',
    short: 'the reader on a phone',
    // The reader is dark in both themes, so one recording serves both.
    light: { webm: '/landing/reader.webm', mp4: '/landing/reader.mp4', poster: '/landing/reader-poster.webp' },
    dark: { webm: '/landing/reader.webm', mp4: '/landing/reader.mp4', poster: '/landing/reader-poster.webp' }
  }
];

export const landingMedia = (id: LandingMediaId): LandingMedia => {
  const found = LANDING_MEDIA.find((m) => m.id === id);
  if (!found) throw new Error(`landing media: no entry ${id}`);
  return found;
};

/** Hard caps per file (bytes): every still, clip file and poster stays near 120 KB. */
export const MEDIA_CAP_BYTES = 122_880;
