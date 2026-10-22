// Platform library index for the client (assets.md §12; owner P1-LIBRARY).
// Wave 0 (P0-C) stub: no fetch; status 'unavailable', so every consumer renders its
// procedural fallback (the same path the real hook takes when the API is down).

import type { LibraryAssetPublic, LibraryKind } from '../../../shared/comic/library';

export interface ComicLibrary {
  status: 'idle' | 'loading' | 'ready' | 'unavailable';
  get(id: string): LibraryAssetPublic | undefined;
  byKind(kind: LibraryKind, filter?: { theme?: 'light' | 'dark'; presetId?: string; genre?: string }): LibraryAssetPublic[];
  /** style.<presetId> */
  preview(presetId: string): LibraryAssetPublic | undefined;
  /** dark → light fallback */
  empty(variant: string, theme: 'light' | 'dark'): LibraryAssetPublic | undefined;
}

const UNAVAILABLE: ComicLibrary = {
  status: 'unavailable',
  get: () => undefined,
  byKind: () => [],
  preview: () => undefined,
  empty: () => undefined
};

export function useComicLibrary(): ComicLibrary {
  return UNAVAILABLE;
}

export default useComicLibrary;
