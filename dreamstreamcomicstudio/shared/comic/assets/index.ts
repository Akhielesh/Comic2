// Pro Edit asset library (master plan §2.6). PE-0 contract: the library reference shape and how it resolves.
// STUB for the catalogue itself: PE-ASSETS adds shared/comic/assets/catalog.ts (and PE-STICKERS the vendored list) and
// re-exports it here; the server sanitizer reads the catalogue to accept a triple. Pure; no imports from doc.ts.

export * from './types.js';
import { ASSET_ID_RE, ASSET_PACK_RE, ASSET_VERSION_RE, type AssetLibRef } from './types.js';

/** A well-formed library reference (structure only; catalogue membership is the server's check), or undefined. */
export const normalizeAssetLibRef = (raw: unknown): AssetLibRef | undefined => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const { pack, id, v } = raw as Record<string, unknown>;
  if (typeof pack !== 'string' || !ASSET_PACK_RE.test(pack)) return undefined;
  if (typeof id !== 'string' || !ASSET_ID_RE.test(id)) return undefined;
  if (typeof v !== 'string' || !ASSET_VERSION_RE.test(v)) return undefined;
  return { pack, id, v };
};

/** The same-origin file a library reference draws: `/library/<pack>/<v>/<id>.svg` (never a remote URL). */
export const libAssetUrl = (ref: AssetLibRef): string => `/library/${encodeURIComponent(ref.pack)}/${encodeURIComponent(ref.v)}/${encodeURIComponent(ref.id)}.svg`;

/** Two references name the same asset version. */
export const sameLibRef = (a: AssetLibRef | undefined, b: AssetLibRef | undefined): boolean =>
  !!a && !!b && a.pack === b.pack && a.id === b.id && a.v === b.v;
