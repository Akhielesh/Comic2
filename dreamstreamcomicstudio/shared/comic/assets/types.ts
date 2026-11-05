// Pro Edit asset library: catalogue metadata and library references (master plan §2.3 "Sticker", §2.6). PE-0 contract;
// dependency-free.
//
// A sticker is an image layer whose picture comes from the bundled library instead of a storage path:
// `{kind: 'image', src: {lib: {pack, id, v}}}` (exactly one of src.path or src.lib). It resolves to the same-origin file
// `/library/<pack>/<v>/<id>.svg`, so nothing is hotlinked and nothing is copied per comic. A client may write a triple
// only when it is in the catalogue (server sanitizer, PE-SERVER); a stored triple this build's catalogue lacks is kept
// and draws nothing until it is known.

/** A bundled library asset: its pack, its id in the pack, and the pack version (a pinned commit or release). */
export interface AssetLibRef {
  pack: string;
  id: string;
  v: string;
}

export type AssetKind = 'procedural' | 'bundled' | 'generated';
export const ASSET_KINDS: readonly AssetKind[] = ['procedural', 'bundled', 'generated'];

/** One catalogue entry (shared/comic/assets/catalog.ts, PE-ASSETS; the vendored sticker list, PE-STICKERS). */
export interface AssetCatalogEntry {
  id: string;
  name: string;
  keywords: string[];
  pack: string;
  kind: AssetKind;
  /** SPDX id, or null for our own work. */
  licence: string | null;
  author: string;
  sourceUrl: string;
  /** The credit line readers see ("Fluent Emoji · MIT · © Microsoft"), or null when none is needed. */
  attribution: string | null;
  /** A small preview (a same-origin path). */
  poster: string;
  /** Pack version the entry belongs to (the `v` of its AssetLibRef). */
  v: string;
}

/** Pack ids and asset ids as stored: lower-case words joined by '-' or '_'. */
export const ASSET_PACK_RE = /^[a-z0-9][a-z0-9_-]{0,47}$/;
export const ASSET_ID_RE = /^[a-z0-9][a-z0-9_-]{0,95}$/;
/** Pack versions: a release ('1', '2.1') or a pinned commit. */
export const ASSET_VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
