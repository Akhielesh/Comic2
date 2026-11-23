// A page can return to the same hero or set after a long cut. Select a single
// current, checked drawing from this book. Selection is local to the document;
// it never reads a library, calls a model or infers plot from pixels.
import { castKindOf, isPageStale, type ComicDoc, type Page } from '../../../../shared/comic/doc.js';
import { drawnCastIds } from '../../../../shared/comic/directions.js';
import { anchorKeys } from '../../../../shared/comic/anchors.js';
import { itemKey, sceneIndex } from '../../../../shared/comic/continuity.js';
import { QC_NOTICE_SCORE } from '../../../../shared/comic/plan.js';
import { safetyStatusOf, type ContentRating } from '../../../../shared/comic/safety.js';

export interface EarlierArtwork {
  page: Page;
  cast: string[];
  places: string[];
}

const presentCast = (doc: ComicDoc, page: Page) => new Set(page.panels.flatMap(panel => drawnCastIds(doc, panel)));
const presentPlaces = (page: Page) => new Set(page.panels.flatMap(panel => panel.placeId ? [panel.placeId] : []));

export function mentionsProp(doc: ComicDoc, page: Page, prop: string): boolean {
  const key = itemKey(prop);
  if (!key) return false;
  const cast = presentCast(doc, page);
  if (doc.cast.some(c => cast.has(c.id) && castKindOf(c) === 'object' && itemKey(c.name) === key)) return true;
  return page.panels.some(panel => {
    const words = itemKey(panel.action || '').replace(/[^\p{L}\p{N}]+/gu, ' ');
    return (' ' + words + ' ').includes(' ' + key.replace(/[^\p{L}\p{N}]+/gu, ' ') + ' ') ||
      Object.values(panel.direction?.cast ?? {}).some(c => c.holding?.some(item => itemKey(item) === key));
  });
}

export function skippedPageSubjects(doc: ComicDoc, page: Page, skip: ReadonlySet<string>): boolean {
  if (!skip.size) return false;
  const cast = presentCast(doc, page);
  return doc.cast.some(c => cast.has(c.id) && skip.has(anchorKeys.cast(c))) ||
    [...presentPlaces(page)].some(id => skip.has(anchorKeys.place(id)));
}

export function conflictsWithPageChange(doc: ComicDoc, source: Page, change: Page): boolean {
  const cast = presentCast(doc, source);
  const changed = Object.entries(change.continuity?.cast ?? {}).some(([id, delta]) =>
    cast.has(id) && (delta === null || delta.outfit !== undefined || delta.marks !== undefined || delta.holding !== undefined));
  return changed || Object.keys(change.continuity?.props ?? {}).some(name => mentionsProp(doc, source, name));
}

function checkedRaster(doc: ComicDoc, page: Page, rating: ContentRating, owns: (path: string) => boolean, skip: ReadonlySet<string>, attached: ReadonlySet<string>) {
  const render = page.render;
  const asset = render.asset;
  if (render.status !== 'ready' || render.withheld || !asset || !owns(asset.path) || attached.has(asset.path)) return false;
  if (asset.source !== 'generated' && asset.source !== 'derived') return false;
  if (safetyStatusOf(asset.safety, rating) !== 'pass' || (!render.specHash && !render.parts?.context)) return false;
  // Old pageSpecHash does not fingerprint the continuity ledger. A correction
  // made to the donor page after rendering is evidence against using that raster.
  if (!render.parts?.context && doc.pages.some(p => p.n <= page.n &&
      (p.continuity?.cast || p.continuity?.props || p.continuity?.notes?.length))) return false;
  if (skip.has(anchorKeys.previous(page.id)) || skip.has(anchorKeys.styleKey(page.id))) return false;
  const qc = render.qc;
  if (!qc) return doc.consistency?.styleKeyPageId === page.id;
  return qc.checkedAt > 0 && qc.score >= QC_NOTICE_SCORE && Array.isArray(qc.issues) && !qc.issues.length &&
    !qc.missingSpeakers?.length && !qc.findings?.some(f => !f.dismissed && f.severity === 'major');
}

export function earlierArtwork(doc: ComicDoc, page: Page, rating: ContentRating, owns: (path: string) => boolean, attached: ReadonlySet<string>, adjacent?: Page): EarlierArtwork | undefined {
  if (page.n < 3) return;
  const cast = presentCast(doc, page);
  const places = presentPlaces(page);
  const coveredCast = adjacent ? presentCast(doc, adjacent) : new Set<string>();
  const coveredPlaces = adjacent ? presentPlaces(adjacent) : new Set<string>();
  const scenes = sceneIndex(doc, { derive: true }).byPage;
  const skip = new Set(doc.consistency?.skip ?? []);
  const prior = doc.pages.filter(p => p.id !== page.id && p.n < page.n)
    .sort((a, b) => b.n - a.n || a.id.localeCompare(b.id));
  const changes = [page];
  const ranked: { page: Page; cast: string[]; places: string[]; score: number }[] = [];
  for (const source of prior) {
    if (source.n < page.n - 1 && checkedRaster(doc, source, rating, owns, skip, attached)) {
      const sourceCast = presentCast(doc, source);
      const sourcePlaces = presentPlaces(source);
      const sharedCast = doc.cast.filter(c => cast.has(c.id) && sourceCast.has(c.id) && !coveredCast.has(c.id));
      const sharedPlaces = doc.places.filter(p => places.has(p.id) && sourcePlaces.has(p.id) && !coveredPlaces.has(p.id));
      if ((sharedCast.length || sharedPlaces.length) && !skippedPageSubjects(doc, source, skip) &&
          !changes.some(change => conflictsWithPageChange(doc, source, change))) {
        // Prefer evidence covering more visible subjects, then a matching scene or a
        // creator-selected canonical page. The deterministic tiebreaker is most recent.
        const sameScene = !!scenes[page.id] && scenes[page.id] === scenes[source.id];
        const score = sharedCast.length * 5 + sharedPlaces.length * 3 + Number(sameScene) * 2 + Number(doc.consistency?.styleKeyPageId === source.id);
        ranked.push({ page: source, cast: sharedCast.map(c => c.name), places: sharedPlaces.map(p => p.name), score });
      }
    }
    if (source.continuity?.cast || source.continuity?.props) changes.push(source);
  }
  return ranked.sort((a, b) => b.score - a.score || b.page.n - a.page.n || a.page.id.localeCompare(b.page.id))
    .find(candidate => !isPageStale(doc, candidate.page));
}
