// Storage layout and bucket routing for Comic Studio v5 (contract §12.5). REAL from wave 0
// (P0-B); owned in wave 1 by P1-STORAGE. Pure: no I/O, safe to import anywhere.
//
// | Lane                 | Bucket         | Path                                                   |
// |----------------------|----------------|--------------------------------------------------------|
// | generated / derived  | comic-assets   | u/<user>/p/<project>/img/<uuid>.webp (+ _w480/_w1080)  |
// | refs & uploads       | comic-private  | u/<user>/p/<project>/ref/<uuid>.webp                   |
// | quarantine           | comic-private  | q/<user>/<project>/<uuid>.webp                         |
// | publication copies   | comic-assets   | pub/<assetKey>/<slot>-<sha12>[-w480|-w1080].webp       |
// | platform library     | comic-assets   | library/v<ver>/<id>/<rev>[@320|@640].webp              |

import { ASSET_KEY_RE } from '../../../shared/comic/publication.js';
import { COMIC_PRIVATE_BUCKET, STORAGE_BUCKET } from '../config.js';

/** Public (not listable) bucket: generated art, publication copies, the platform library. */
export const PUBLIC_BUCKET: string = STORAGE_BUCKET;
/** Private bucket (no storage policies): reference photos, uploads, quarantine. */
export const PRIVATE_BUCKET: string = COMIC_PRIVATE_BUCKET;

/** Signed-URL lifetimes per bucket (seconds). */
export const SIGNED_TTL_SEC = { public: 3600, private: 300 } as const;

const REF_PATH_RE = /^u\/[^/]+\/p\/[^/]+\/ref\//;
const QUARANTINE_PATH_RE = /^q\//;
const PUB_PATH_RE = /^pub\/[A-Za-z0-9]{22}\//;
const LIBRARY_PATH_RE = /^library\//;
const SHA12_RE = /^[0-9a-f]{12}$/;

/** One path segment: letters, digits, `_` and `-` only (same rule as assets.ts buildAssetPath). */
const segment = (value: string, what: string): string => {
  const clean = String(value ?? '').replace(/[^a-zA-Z0-9_-]/g, '-');
  if (!clean || /^-+$/.test(clean)) throw new Error(`storagePaths: empty ${what}`);
  return clean;
};

/** Private lanes: reference photos (…/ref/…) and quarantine (q/…). */
export const isPrivatePath = (path: string): boolean =>
  typeof path === 'string' && (REF_PATH_RE.test(path) || QUARANTINE_PATH_RE.test(path));

/** The bucket that holds a path. Anything not private is in the public bucket. */
export const bucketForPath = (path: string): string => (isPrivatePath(path) ? PRIVATE_BUCKET : PUBLIC_BUCKET);

/** Signed-URL TTL for a path (private lanes: 5 minutes). */
export const signedTtlFor = (path: string): number => (isPrivatePath(path) ? SIGNED_TTL_SEC.private : SIGNED_TTL_SEC.public);

/** A reference photo / upload in the private bucket. `id` is the object id (no extension). */
export const buildRefPath = (userId: string, projectId: string, id: string): string =>
  `u/${segment(userId, 'user id')}/p/${segment(projectId, 'project id')}/ref/${segment(id, 'object id')}.webp`;

/** Quarantine lane (moderators only; 90-day hold). */
export const buildQuarantinePath = (userId: string, projectId: string, id: string): string =>
  `q/${segment(userId, 'user id')}/${segment(projectId, 'project id')}/${segment(id, 'object id')}.webp`;

/** The opaque prefix of one publication's copies (rotated with the slug). */
export const pubPrefix = (assetKey: string): string => {
  if (!ASSET_KEY_RE.test(assetKey)) throw new Error('storagePaths: invalid asset key');
  return `pub/${assetKey}/`;
};

/**
 * A publication copy: no user or project id, unguessable key, content hash in the name so
 * a changed image never reuses a cached URL. `slot` is e.g. "cover", "p3", "og-en".
 */
export const pubPath = (assetKey: string, slot: string, sha12: string, width?: 480 | 1080): string => {
  if (!SHA12_RE.test(sha12)) throw new Error('storagePaths: sha12 must be 12 lowercase hex characters');
  return `${pubPrefix(assetKey)}${segment(slot, 'slot')}-${sha12}${width ? `-w${width}` : ''}.webp`;
};

/** True for publication copies (pub/<22-char key>/…). */
export const isPublicationPath = (path: string): boolean => typeof path === 'string' && PUB_PATH_RE.test(path);

/** True for platform-library objects (never GC'd, never registered in image_assets). */
export const isLibraryPath = (path: string): boolean => typeof path === 'string' && LIBRARY_PATH_RE.test(path);
