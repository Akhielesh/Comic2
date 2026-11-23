import type { AssetRef, ComicDoc } from '../../../shared/comic/doc.js';
import { canServeToOwner } from '../../../shared/comic/safety.js';
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object';

/**
 * Paths the owner may NOT be served (a `blocked` safety verdict): the asset, its variants
 * and its original. Walks the whole doc so every lane (pages, sheets, refs, archive, trash,
 * inbox, attachments, future fields) is covered by the one isServableToOwner rule.
 */
export function blockedAssetPaths(doc: ComicDoc): Set<string> {
  const blocked = new Set<string>();
  const seen = new Set<object>();
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object' || seen.has(value as object)) return;
    seen.add(value as object);
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    const obj = value as Record<string, unknown>;
    if (typeof obj.path === 'string' && obj.path && !canServeToOwner(obj as unknown as AssetRef)) {
      blocked.add(obj.path);
      if (Array.isArray(obj.variants)) obj.variants.forEach((v) => !!v && typeof v === 'object' && typeof v.path === 'string' && blocked.add(v.path));
      if (isRecord(obj.original) && typeof obj.original.path === 'string') blocked.add(obj.original.path);
    }
    for (const key of Object.keys(obj)) visit(obj[key]);
  };
  visit(doc);
  return blocked;
}

/** Filter paths down to the ones the owner may be served. */
export const servablePaths = (doc: ComicDoc, paths: string[]): string[] => {
  const blocked = blockedAssetPaths(doc);
  return blocked.size ? paths.filter((p) => !blocked.has(p)) : paths;
};
