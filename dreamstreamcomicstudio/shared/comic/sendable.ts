// What a page job may send to an image model, in one place: the studio's runner (server/src/comic/jobs.ts) and the
// Model Lab's Pro pages A/B (server/src/comic/models/lab.ts) compile from the same doc copy and attach the same
// previous page. Pure: nothing is loaded, stored or sent here.
//
// The lab's gate is stricter than the runner's: it also withholds uploads with no safety verdict yet, where the
// runner checks those lazily before their first use (safety.md §3.2). That extra rule lives in lab.ts and builds on
// blockedPaths below.

import { mapAssetRefs, type AssetRef, type ComicDoc, type Page, type RenderState } from './doc.js';
import { canServeToOwner } from './safety.js';

/** Paths that can never be sent to an image model: blocked or quarantined by the content check. */
export const blockedPaths = (doc: ComicDoc): Set<string> => {
  const out = new Set<string>();
  mapAssetRefs(doc, (a) => {
    if (a?.path && !canServeToOwner(a)) out.add(a.path);
    return a;
  });
  return out;
};

/**
 * Doc copy with the given storage paths removed, so a recompile labels only images we can attach: style board and
 * refs, cast and place refs, and any sheet or page render whose image is gone (that render reads as not drawn).
 * An empty set returns the doc itself.
 */
export const withoutAssets = (doc: ComicDoc, missing: ReadonlySet<string>): ComicDoc => {
  if (!missing.size) return doc;
  const keep = <T extends AssetRef>(a?: T) => (a && !missing.has(a.path) ? a : undefined);
  const render = (r: RenderState): RenderState => (r.asset && missing.has(r.asset.path) ? { ...r, asset: undefined, status: 'none' } : r);
  return {
    ...doc,
    style: { ...doc.style, board: keep(doc.style.board), refs: doc.style.refs.filter((a) => !missing.has(a.path)) },
    cast: doc.cast.map((c) => ({ ...c, refs: c.refs.filter((a) => !missing.has(a.path)), sheet: render(c.sheet) })),
    places: doc.places.map((p) => ({ ...p, refs: p.refs.filter((a) => !missing.has(a.path)), sheet: render(p.sheet) })),
    pages: doc.pages.map((p) => ({ ...p, render: render(p.render) }))
  };
};

/** The page before this one that a page job attaches for continuity: the nearest earlier page drawn and servable. */
export const nearestReadyBefore = (doc: ComicDoc, page: Page): Page | undefined =>
  doc.pages
    .filter((p) => p.n < page.n && p.render.status === 'ready' && p.render.asset?.path && canServeToOwner(p.render.asset))
    .sort((a, b) => b.n - a.n)[0];
