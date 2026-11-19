// The pictures of a look (stylepick SC-1): the one place a look's static files are named. LookArt paints from here,
// and so does LibraryImage when a look's library preview (style.<id>) is missing or fails, so every surface shows the
// same art for a look, at once, with no library index and no call to the backend.
//
// Today the only files are the bundled Paper Boat samples (sampleArt.ts): the 480 px thumb is the scene, and the two
// sample pages are the large pictures. The look-samples work (homestyles) extends this file to read its own sample
// files first; the shape below is the contract it keeps. Each picture carries its file's pixel size, so the img
// reserves the file's own aspect before it arrives. Pure: no React, no fetch, no index.

import { stylePreviewId } from '../../../shared/comic/library';
import { SAMPLE_LOOKS, SAMPLE_THUMB_SIZE, samplePageSize, samplePageUrl, sampleThumbnailUrl, type SampleLook } from './sampleArt';

/** A file's size in pixels. */
export interface LookSize {
  width: number;
  height: number;
}

/** One picture at two widths. The same file at both widths means there is no larger copy. */
export interface LookPicture {
  w320: string;
  w640: string;
  /** The picture's pixel size (both widths share its aspect); absent when the source does not say. */
  size?: LookSize;
}

export interface LookSources {
  /** The look drawn as a scene: what a tile shows. */
  scene?: LookPicture;
  /** A character portrait in the look (none bundled yet). */
  cast?: LookPicture;
  /** Full sample pages, largest pictures first. */
  pages: string[];
  /** The pixel size the look's sample pages share; absent when the source does not say. */
  pageSize?: LookSize;
}

export type LookArtSize = 'tile' | 'large';

/** The file a size paints, with its pixel size when the source names it. */
export interface LookFile {
  src: string;
  size?: LookSize;
}

const isSampleLook = (id: string): id is SampleLook => (SAMPLE_LOOKS as readonly string[]).includes(id);

/** The static pictures of one look (empty when it has none yet). */
export function lookSourcesOf(presetId: string): LookSources {
  if (!isSampleLook(presetId)) return { pages: [] };
  const thumb = sampleThumbnailUrl(presetId);
  return {
    scene: { w320: thumb, w640: thumb, size: { ...SAMPLE_THUMB_SIZE } },
    pages: [samplePageUrl(presetId, 1), samplePageUrl(presetId, 2)],
    pageSize: samplePageSize(presetId)
  };
}

/**
 * The file a size paints. A tile reads the scene at 320; large reads the scene at 640, or the first sample page when
 * the scene has no larger copy (or no scene exists) and the page is then the only large picture.
 */
export function lookFileOf(sources: LookSources, size: LookArtSize): LookFile | undefined {
  const { scene, pages, pageSize } = sources;
  const of = (src: string | undefined, at: LookSize | undefined): LookFile | undefined => (src ? (at ? { src, size: at } : { src }) : undefined);
  if (size === 'tile') return of(scene?.w320, scene?.size);
  if (scene && scene.w640 !== scene.w320) return of(scene.w640, scene.size);
  if (pages[0]) return of(pages[0], pageSize);
  return of(scene?.w640, scene?.size);
}

/** The URL a size paints (lookFileOf without the size). */
export function lookPictureOf(sources: LookSources, size: LookArtSize): string | undefined {
  return lookFileOf(sources, size)?.src;
}

/** The look a library preview id names: "style.<presetId>" gives the preset id; any other id (a cast bust too) none. */
export function lookIdOfPreview(libraryId: string): string | undefined {
  const prefix = stylePreviewId('');
  if (!libraryId.startsWith(prefix)) return undefined;
  const id = libraryId.slice(prefix.length);
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id) && stylePreviewId(id) === libraryId ? id : undefined;
}
