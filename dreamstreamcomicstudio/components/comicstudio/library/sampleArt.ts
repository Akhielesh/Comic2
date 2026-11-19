const ASSET_ROOT = '/assets/comic-sample';

export const SAMPLE_LOOKS = ['ligne-claire', 'manga-screentone', 'noir-ink', 'watercolor-storybook', 'indie-risograph', 'retro-pop'] as const;
export type SampleLook = (typeof SAMPLE_LOOKS)[number];

export const samplePageUrl = (look: SampleLook, page: number) => `${ASSET_ROOT}/${look}-${page}.webp`;
export const sampleThumbnailUrl = (look: SampleLook) => `${ASSET_ROOT}/${look}-thumb.webp`;
export const SAMPLE_COVER_URL = `${ASSET_ROOT}/paper-boat-cover.webp`;

/** The files' own pixel sizes (read from the webp headers; LookArt.test checks them against public/). */
export const SAMPLE_THUMB_SIZE = { width: 480, height: 240 } as const;
/** Both sample pages of a look share one size. */
export const samplePageSize = (look: SampleLook): { width: number; height: number } =>
  look === 'ligne-claire' ? { width: 1224, height: 1020 } : { width: 965, height: 809 };
