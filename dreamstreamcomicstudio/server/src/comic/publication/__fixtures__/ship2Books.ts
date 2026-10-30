// Synthetic publication fixtures for the Ship 2 snapshot whitelist (K2b; pro plan §8 "Publication"). No real user data:
// the shapes only (a v5 comic drawn before Ship 2, and the same comic with one page made editable as panels).
import { createEmptyDoc, emptyRender, type AssetRef, type ComicDoc, type Page, type RenderState } from '../../../../../shared/comic/doc.js';

export const FIXTURE_USER = 'user-fx';
export const FIXTURE_PROJECT = 'proj-fx';

/** A server-written image in this comic's own img lane, checked G (servable to the public). */
export const fxAsset = (name: string, extra: Partial<AssetRef> = {}): AssetRef => ({
  path: `u/${FIXTURE_USER}/p/${FIXTURE_PROJECT}/img/${name}.webp`,
  w: 1024,
  h: 1536,
  source: 'generated',
  at: 1,
  model: 'PRIVATE-MODEL',
  safety: { assessed: 'G', at: 1, by: 'qc' },
  variants: [
    { path: `u/${FIXTURE_USER}/p/${FIXTURE_PROJECT}/img/${name}_w480.webp`, w: 480, h: 720 },
    { path: `u/${FIXTURE_USER}/p/${FIXTURE_PROJECT}/img/${name}_w1080.webp`, w: 1080, h: 1620 }
  ],
  ...extra
});

const ready = (name: string, extra: Partial<RenderState> = {}): RenderState => ({
  status: 'ready',
  asset: fxAsset(name),
  history: [{ ...fxAsset(`${name}-take1`), note: 'PRIVATE-HISTORY' }],
  specHash: 'spec',
  qc: { score: 0.81, issues: ['PRIVATE-QC-ISSUE'], checkedAt: 2, model: 'PRIVATE-MODEL', panelBoxes: [{ x: 0.02, y: 0.02, w: 0.96, h: 0.46 }, { x: 0.02, y: 0.52, w: 0.46, h: 0.46 }, { x: 0.52, y: 0.52, w: 0.46, h: 0.46 }] },
  ...extra
});

const page = (n: number): Page => ({
  id: `pg_${n}`,
  n,
  summary: `PRIVATE-SUMMARY ${n}`,
  layout: 'Row 1: one wide panel. Row 2: two equal panels.',
  panels: [1, 2, 3].map((k) => ({
    id: `pn_${n}_${k}`,
    n: k,
    size: k === 1 ? 'wide' : 'medium',
    shot: k === 1 ? 'establishing' : 'medium',
    action: `PRIVATE-ACTION ${n}.${k}`,
    castIds: ['c_maya'],
    placeId: 'pl_market',
    lines: [{ id: `ln_${n}_${k}`, kind: 'speech', speakerId: 'c_maya', text: `Line ${n}.${k}` }]
  })),
  render: ready(`p${n}`),
  balloons: [1, 2, 3].map((k) => ({ lineId: `ln_${n}_${k}`, x: 0.1 * k, y: 0.1, w: 0.25, tailX: 0.2, tailY: 0.3 }))
});

/** A v5 comic published before Ship 2: no frames, no cuts, no layers, no rot/minH. */
export function legacyPublishedDoc(): ComicDoc {
  const doc = createEmptyDoc(FIXTURE_PROJECT, 'Spice Run', 1_700_000_000_000);
  doc.brief = { ...doc.brief, logline: 'A courier races through a spice market.', premise: 'PRIVATE-PREMISE' };
  doc.style = { ...doc.style, status: 'locked', name: 'Ligne claire', spec: 'PRIVATE-STYLE' };
  doc.cast = [{ id: 'c_maya', name: 'Maya', tier: 'lead', look: { summary: 'PRIVATE-LOOK' }, refs: [], sheet: emptyRender() }];
  doc.places = [{ id: 'pl_market', name: 'Spice Market', look: 'PRIVATE-PLACE', refs: [], sheet: emptyRender() }];
  doc.pages = [page(1), page(2)];
  doc.cover = { title: 'Spice Run', tagline: 'Hot on the trail', render: ready('cover') };
  doc.planStatus = 'approved';
  return doc;
}
