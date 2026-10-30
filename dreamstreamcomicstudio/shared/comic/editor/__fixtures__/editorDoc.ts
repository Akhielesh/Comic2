// Synthetic docs for the editor engine tests (B9): a cast of two, a place, an undrawn page planned from a template, and
// a drawn page shown in its frames (a 2:3 drawing whose cuts equal the frames, so page space = image space). No real
// user data.

import { createEmptyDoc, emptyRender, type Balloon, type Box, type ComicDoc, type Line, type Page, type Panel, type PanelCuts, type QcReport } from '../../doc.js';
import { applyOp, type DocOp } from '../../ops.js';
import { PAGE_TEMPLATES, templateLayout } from '../templates.js';

export const T0 = 1_761_000_000_000;
export const ASSET = 'u_test/proj_test/pg_a_v2.png';
export const OLD_TAKE = 'u_test/proj_test/pg_a_v1.png';

export const apply = (doc: ComicDoc, ops: DocOp[]): ComicDoc => ops.reduce((d, op) => applyOp(d, op), doc);

export const line = (id: string, text: string, kind: Line['kind'] = 'speech', speakerId?: string): Line => ({ id, kind, text, ...(speakerId ? { speakerId } : {}) });

export const panel = (id: string, n: number, lines: Line[] = [], extra: Partial<Panel> = {}): Panel => ({
  id,
  n,
  size: 'medium',
  shot: 'medium',
  action: `Something happens in panel ${n}`,
  castIds: ['c_maya'],
  lines,
  ...extra
});

export const baseDoc = (): ComicDoc => {
  const doc = createEmptyDoc('proj_test', 'Editor test', T0);
  return apply(doc, [
    { op: 'character', id: 'c_maya', patch: { name: 'Maya', tier: 'lead', look: { summary: 'A girl in a red raincoat' } } },
    { op: 'character', id: 'c_ravi', patch: { name: 'Ravi', tier: 'support', look: { summary: 'A boy with round glasses' } } },
    { op: 'place', id: 'pl_park', patch: { name: 'the park', look: 'A rainy city park' } }
  ]);
};

/** An undrawn page with `n` panels and no frames (the blueprint decides where they are). */
export const undrawnPage = (id: string, pageN: number, panels: Panel[], layout = ''): Page => ({
  id,
  n: pageN,
  summary: 'A planned page',
  layout,
  panels,
  render: emptyRender(),
  balloons: []
});

const template = (tid: string) => PAGE_TEMPLATES.find((t) => t.id === tid)!;

/**
 * A drawn page shown in frames: the template's frames, a 1600×2400 drawing, cuts equal to the frames (named by panel),
 * and a page check with keep-outs and heads (so face checks have data). Balloons as given.
 */
export const drawnPage = (id: string, pageN: number, tid: string, panels: Panel[], opts: { balloons?: Balloon[]; qc?: Partial<QcReport>; cuts?: Partial<PanelCuts> } = {}): Page => {
  const { frames } = templateLayout(template(tid));
  const framed = panels.map((p, i) => ({ ...p, frame: { box: { ...frames[i] } } }));
  const qc: QcReport = { score: 0.9, issues: [], checkedAt: T0, panelBoxes: frames.map((b) => ({ ...b })), keepOut: [], heads: [], boxesFrom: 'vision', drawnBoxes: frames.map((b) => ({ ...b })), ...(opts.qc ?? {}) };
  const cuts: PanelCuts = {
    status: 'ok',
    by: 'detect',
    at: T0,
    cuts: frames.map((box: Box, i) => ({ panelId: panels[i].id, drawn: i + 1, box: { ...box }, conf: 0.95 })),
    ...(opts.cuts ?? {})
  };
  return {
    id,
    n: pageN,
    summary: 'A drawn page',
    layout: template(tid).sentence,
    artMode: 'panels',
    panels: framed,
    render: {
      status: 'ready',
      asset: { path: ASSET, source: 'generated', at: T0 + 2, w: 1600, h: 2400 },
      history: [{ path: OLD_TAKE, source: 'generated', at: T0 + 1, w: 1600, h: 2400, cuts: { ...cuts, cuts: cuts.cuts.map((c) => ({ ...c })) } }],
      qc,
      cuts
    },
    balloons: opts.balloons ?? []
  };
};

export const withPages = (doc: ComicDoc, pages: Page[]): ComicDoc => ({ ...doc, pages, format: { ...doc.format, pageCount: pages.length } });

export const pageOf = (doc: ComicDoc, id: string): Page => doc.pages.find((p) => p.id === id)!;
