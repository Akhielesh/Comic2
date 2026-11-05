// Staleness parts (Ship 2, K2a; pro plan §5.2): what a page version was drawn from, part by part. Pure.
//
// pageSpecHash says THAT a drawing is out of date; parts say WHAT changed ("Panel 2: who's in it"), so the redraw tray
// can name it and offer the smallest paid scope. The server stamps partsOf(doc, page) on a new page version
// (VersionMeta.parts, K2b); B4's partsStale / staleReasons compare it with partsOf of the live doc. Every value is a
// six-hex fingerprint of a stable serialisation (key order never matters). Renders without parts never become stale
// from consistency features (I8), and nothing here enters a spec hash (I1).

import { findPlace, hashString, scenesOf, stableStringify, type ComicDoc, type Page, type Panel, type PanelParts, type VersionParts } from './doc.js';
import { CONSISTENCY_LIMITS } from './limits.js';

/** Six-hex fingerprint of a value (stableStringify, so key order never matters). */
export const partHash = (value: unknown): string => hashString(stableStringify(value ?? null)).slice(0, 6);

/** A panel's parts: cast (ids, looks, groups), action, place (id and look), shot (size, shot, angle), mood, and its
 *  direction when it has one (the writer/user/derived marker is provenance, not content). */
export const panelPartsOf = (doc: Pick<ComicDoc, 'cast' | 'places'>, panel: Panel): PanelParts => {
  const cast = [...panel.castIds]
    .sort()
    .map((id) => {
      const c = doc.cast.find((x) => x.id === id);
      return c ? [id, c.look, c.kind ?? 'person', c.count ?? 1] : [id];
    });
  const place = panel.placeId ? [panel.placeId, findPlace(doc as ComicDoc, panel.placeId)?.look ?? ''] : [];
  const out: PanelParts = {
    c: partHash(cast),
    a: partHash(panel.action || ''),
    p: partHash(place),
    s: partHash([panel.size, panel.shot, panel.angle ?? '']),
    m: partHash(panel.mood ?? '')
  };
  if (panel.direction) {
    const { by: _by, ...direction } = panel.direction;
    out.d = partHash(direction);
  }
  return out;
};

/**
 * What `page` would be drawn from now: per panel (by id), the page's continuity (with its scene), the places its panels
 * use (by id) and the props its continuity names. Capped at CONSISTENCY_LIMITS.partsKeys keys (panels first). Pure.
 */
export const partsOf = (doc: Pick<ComicDoc, 'cast' | 'places' | 'scenes'>, page: Pick<Page, 'panels' | 'continuity'>): VersionParts => {
  let budget: number = CONSISTENCY_LIMITS.partsKeys;
  const out: VersionParts = {};
  const panels: Record<string, PanelParts> = {};
  for (const panel of page.panels || []) {
    if (budget <= 0) break;
    panels[panel.id] = panelPartsOf(doc, panel);
    budget -= 1;
  }
  if (Object.keys(panels).length) out.panels = panels;
  const continuity = page.continuity;
  if (continuity) {
    const { by: _by, ...content } = continuity;
    const scene = continuity.sceneId ? scenesOf(doc).find((s) => s.id === continuity.sceneId) : undefined;
    out.cont = partHash([content, scene ?? null]);
  }
  const places: Record<string, string> = {};
  for (const id of [...new Set((page.panels || []).map((p) => p.placeId).filter((id): id is string => !!id))].sort()) {
    if (budget <= 0) break;
    places[id] = partHash(findPlace(doc as ComicDoc, id)?.look ?? '');
    budget -= 1;
  }
  if (Object.keys(places).length) out.places = places;
  const props: Record<string, string> = {};
  for (const name of Object.keys(continuity?.props || {}).sort()) {
    if (budget <= 0) break;
    props[name] = partHash(continuity!.props![name]);
    budget -= 1;
  }
  if (Object.keys(props).length) out.props = props;
  return out;
};
