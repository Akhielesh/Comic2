import { stylePreviewId } from '../../../shared/comic/library';

const ASSET_ROOT = '/assets/comic-sample';

export const SAMPLE_LOOKS = ['ligne-claire', 'manga-screentone', 'noir-ink', 'watercolor-storybook', 'indie-risograph', 'retro-pop'] as const;
export type SampleLook = (typeof SAMPLE_LOOKS)[number];

export const samplePageUrl = (look: SampleLook, page: number) => `${ASSET_ROOT}/${look}-${page}.webp`;
export const sampleThumbnailUrl = (look: SampleLook) => `${ASSET_ROOT}/${look}-thumb.webp`;
export const SAMPLE_COVER_URL = `${ASSET_ROOT}/paper-boat-cover.webp`;

export function bundledStylePreview(id: string): string | undefined {
  const look = SAMPLE_LOOKS.find((candidate) => stylePreviewId(candidate) === id);
  return look ? sampleThumbnailUrl(look) : undefined;
}
