// A page can return to the same hero or set after a long cut. Select a single
// current, checked drawing from this book. Selection is local to the document;
// it never reads a library, calls a model or infers plot from pixels.
import { castKindOf, isPageStale, type ComicDoc, type Page } from '../../../../shared/comic/doc.js';
import { drawnCastIds } from '../../../../shared/comic/directions.js';
import { anchorKeys } from '../../../../shared/comic/anchors.js';
import { itemKey, sceneIndex } from '../../../../shared/comic/continuity.js';
import { visualReferenceQcAllows } from '../../../../shared/comic/visualReferenceQc.js';
import { QC_NOTICE_SCORE } from '../../../../shared/comic/plan.js';
import { safetyStatusOf, type ContentRating } from '../../../../shared/comic/safety.js';

export interface EarlierArtwork {
  page: Page;
  cast: string[];
  places: string[];
  props: string[];
}

const presentCast = (doc: ComicDoc, page: Page) => new Set(page.panels.flatMap(panel => drawnCastIds(doc, panel)));
const presentPlaces = (page: Page) => new Set(page.panels.flatMap(panel => panel.placeId ? [panel.placeId] : []));

const wordKey = (value: string) => itemKey(value).replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

function propMatcher(doc: ComicDoc, page: Page) {
  const cast = presentCast(doc, page);
  const stated = new Set(doc.cast.filter(c => cast.has(c.id) && castKindOf(c) === 'object').map(c => itemKey(c.name)));
  const actions = page.panels.map(panel => {
    for (const subject of Object.values(panel.direction?.cast ?? {})) {
      for (const item of subject.holding ?? []) stated.add(itemKey(item));
    }
    return ' ' + wordKey(panel.action || '') + ' ';
  });
  return (name: string) => {
    const key = wordKey(name);
    return !!key && (stated.has(itemKey(name)) || actions.some(action => action.includes(' ' + key + ' ')));
  };
}

export const mentionsProp = (doc: ComicDoc, page: Page, prop: string) => propMatcher(doc, page)(prop);

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

const namedProps = (doc: ComicDoc) => [...new Set(doc.pages.flatMap(page => Object.keys(page.continuity?.props ?? {})))];
const visibleProps = (doc: ComicDoc, page: Page, names: readonly string[]) => names.length ? names.filter(propMatcher(doc, page)) : [];

/**
 * Wait for at most one already-quoted page: the illustration establishing an explicit appearance
 * change, or the last time a returning subject appeared. Continuous, unchanged scenes retain their
 * parallelism. This only orders jobs; the live compiler still validates the actual raster after QC.
 */
export function artworkDependencies(doc: ComicDoc, targets: ReadonlySet<string>): Record<string, string> {
  const after: Record<string, string> = {};
  if (targets.size < 2) return after;
  const pages = [...doc.pages].sort((a, b) => a.n - b.n || a.id.localeCompare(b.id));
  const skip = new Set(doc.consistency?.skip ?? []);
  const props = namedProps(doc);
  const castKeys = new Map(doc.cast.map(c => [c.id, anchorKeys.cast(c)]));
  const changedAt = new Map<string, number>();
  const established = new Map<string, Page>();
  const lastSeen = new Map<string, Page>();
  const subjects = new Map<string, string[]>();
  for (const page of pages) {
    const keys = [
      ...[...presentCast(doc, page)].flatMap(id => castKeys.get(id) ?? []),
      ...[...presentPlaces(page)].map(anchorKeys.place),
      ...visibleProps(doc, page, props).map(name => 'item:' + itemKey(name))
    ];
    subjects.set(page.id, keys);
    const changes = Object.entries(page.continuity?.cast ?? {}).flatMap(([id, delta]) => {
      if (delta && delta.outfit === undefined && delta.marks === undefined && delta.holding === undefined) return [];
      return castKeys.get(id) ?? [];
    });
    for (const name of Object.keys(page.continuity?.props ?? {})) changes.push('item:' + itemKey(name));
    for (const key of changes) {
      changedAt.set(key, page.n);
      established.delete(key);
    }
    const candidates = new Map<Page, number>();
    const consider = (source: Page | undefined, weight: number) => {
      if (!source || source.n >= page.n || !targets.has(source.id)) return;
      if (skip.has(anchorKeys.previous(source.id)) || skip.has(anchorKeys.styleKey(source.id))) return;
      // The whole image would include any other subject whose look has changed since.
      if (subjects.get(source.id)?.some(key => skip.has(key) || (changedAt.get(key) ?? 0) > source.n)) return;
      candidates.set(source, (candidates.get(source) ?? 0) + weight);
    };
    for (const key of keys) {
      if (skip.has(key)) continue;
      if (targets.has(page.id)) {
        const previous = lastSeen.get(key);
        // Short cuts keep the pair scheduler's throughput; typed visual changes always take priority.
        if (previous && page.n - previous.n >= 4) consider(previous, key.startsWith('place:') ? 3 : 5);
        consider(established.get(key), 6);
      }
      if (changedAt.has(key) && !established.has(key)) established.set(key, page);
      lastSeen.set(key, page);
    }
    const best = [...candidates].sort(([a, aw], [b, bw]) => bw - aw || b.n - a.n || a.id.localeCompare(b.id))[0];
    if (best) after[page.id] = best[0].id;
  }
  return after;
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
  return qc.checkedAt > 0 && qc.score >= QC_NOTICE_SCORE && visualReferenceQcAllows(qc, true, asset.path);
}

export function earlierArtwork(doc: ComicDoc, page: Page, rating: ContentRating, owns: (path: string) => boolean, attached: ReadonlySet<string>, adjacent?: Page): EarlierArtwork | undefined {
  if (page.n < 3) return;
  const cast = presentCast(doc, page);
  const places = presentPlaces(page);
  const coveredCast = adjacent ? presentCast(doc, adjacent) : new Set<string>();
  const coveredPlaces = adjacent ? presentPlaces(adjacent) : new Set<string>();
  const props = visibleProps(doc, page, namedProps(doc)).filter(name => !adjacent || !mentionsProp(doc, adjacent, name));
  const scenes = sceneIndex(doc, { derive: true }).byPage;
  const skip = new Set(doc.consistency?.skip ?? []);
  const prior = doc.pages.filter(p => p.id !== page.id && p.n < page.n)
    .sort((a, b) => b.n - a.n || a.id.localeCompare(b.id));
  const changes = [page];
  const ranked: (EarlierArtwork & { score: number })[] = [];
  for (const source of prior) {
    if (source.n < page.n - 1 && checkedRaster(doc, source, rating, owns, skip, attached)) {
      const sourceCast = presentCast(doc, source);
      const sourcePlaces = presentPlaces(source);
      const sharedCast = doc.cast.filter(c => cast.has(c.id) && sourceCast.has(c.id) && !coveredCast.has(c.id));
      const sharedPlaces = doc.places.filter(p => places.has(p.id) && sourcePlaces.has(p.id) && !coveredPlaces.has(p.id));
      const sharedProps = visibleProps(doc, source, props);
      if ((sharedCast.length || sharedPlaces.length || sharedProps.length) && !skippedPageSubjects(doc, source, skip) &&
          !changes.some(change => conflictsWithPageChange(doc, source, change))) {
        // Prefer evidence covering more visible subjects, then a matching scene or a
        // creator-selected canonical page. The deterministic tiebreaker is most recent.
        const sameScene = !!scenes[page.id] && scenes[page.id] === scenes[source.id];
        const score = sharedCast.length * 5 + sharedPlaces.length * 3 + sharedProps.length * 3 + Number(sameScene) * 2 + Number(doc.consistency?.styleKeyPageId === source.id);
        ranked.push({ page: source, cast: sharedCast.map(c => c.name), places: sharedPlaces.map(p => p.name), props: sharedProps, score });
      }
    }
    if (source.continuity?.cast || source.continuity?.props) changes.push(source);
  }
  return ranked.sort((a, b) => b.score - a.score || b.page.n - a.page.n || a.page.id.localeCompare(b.page.id))
    .find(candidate => !isPageStale(doc, candidate.page));
}
