// The pictures of a look (stylepick SC-1): the one place a look's static files are named. LookArt paints from here,
// so every style surface shows the same art, at once, with no library index and no call to the backend.
//
// Today the only files are the bundled Paper Boat samples (sampleArt.ts): the 480 px thumb is the scene, and the two
// sample pages are the large pictures. The look-samples work (homestyles) extends this file to read its own sample
// files first; the shape below is the contract it keeps. Pure: no React, no fetch, no index.

import { SAMPLE_LOOKS, samplePageUrl, sampleThumbnailUrl, type SampleLook } from './sampleArt';

/** One picture at two widths. The same file at both widths means there is no larger copy. */
export interface LookPicture {
  w320: string;
  w640: string;
}

export interface LookSources {
  /** The look drawn as a scene: what a tile shows. */
  scene?: LookPicture;
  /** A character portrait in the look (none bundled yet). */
  cast?: LookPicture;
  /** Full sample pages, largest pictures first. */
  pages: string[];
}

export type LookArtSize = 'tile' | 'large';

const isSampleLook = (id: string): id is SampleLook => (SAMPLE_LOOKS as readonly string[]).includes(id);

/** The static pictures of one look (empty when it has none yet). */
export function lookSourcesOf(presetId: string): LookSources {
  if (!isSampleLook(presetId)) return { pages: [] };
  const thumb = sampleThumbnailUrl(presetId);
  return { scene: { w320: thumb, w640: thumb }, pages: [samplePageUrl(presetId, 1), samplePageUrl(presetId, 2)] };
}

/**
 * The file a size paints. A tile reads the scene at 320; large reads the scene at 640, or the first sample page when
 * the scene has no larger copy (or no scene exists) and the page is then the only large picture.
 */
export function lookPictureOf(sources: LookSources, size: LookArtSize): string | undefined {
  const { scene, pages } = sources;
  if (size === 'tile') return scene?.w320;
  if (scene && scene.w640 !== scene.w320) return scene.w640;
  return pages[0] ?? scene?.w640;
}
