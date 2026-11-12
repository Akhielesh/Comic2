// Synthetic comic for the dialogue engine tests (B-RESOLVE): a cast of four (two Patels, a robot), a drawn page with
// measured panel boxes and head marks, and a planned page. Fixed ids so goldens stay stable. No real user data.

import { createEmptyDoc, emptyRender, type Balloon, type ComicDoc, type Line, type Page, type Panel } from '../../doc.js';
import { applyOp, type DocOp } from '../../ops.js';

export const T0 = 1_762_000_000_000;

export const apply = (doc: ComicDoc, ops: DocOp[]): ComicDoc => ops.reduce((d, op) => applyOp(d, op), doc);

export const line = (id: string, kind: Line['kind'], text: string, speakerId?: string): Line => ({ id, kind, text, ...(speakerId ? { speakerId } : {}) });

export const panel = (id: string, n: number, castIds: string[], lines: Line[], extra: Partial<Panel> = {}): Panel => ({
  id,
  n,
  size: 'medium',
  shot: 'medium',
  action: `Something happens in panel ${n}`,
  castIds,
  lines,
  ...extra
});

/** Page 1's measured panels: one wide panel on top, two side by side below. */
export const P1_BOXES = [
  { x: 0.03, y: 0.03, w: 0.94, h: 0.44 },
  { x: 0.03, y: 0.5, w: 0.455, h: 0.47 },
  { x: 0.515, y: 0.5, w: 0.455, h: 0.47 }
];

const LAYOUT = 'Row 1: one wide panel (panel 1). Row 2: two equal panels side by side (panels 2–3).';

export const page1 = (balloons?: Balloon[]): Page => ({
  id: 'pg_1',
  n: 1,
  summary: 'The lab at midnight',
  layout: LAYOUT,
  panels: [
    panel('pn_1', 1, [], [line('l_cap', 'caption', 'The lab, midnight.')], { size: 'wide', shot: 'establishing' }),
    panel('pn_2', 2, ['c_mira', 'c_leo'], [
      line('l_mira1', 'speech', 'We have to go', 'c_mira'),
      line('l_leo1', 'speech', 'Wait for me', 'c_leo'),
      line('l_mira2', 'whisper', 'Quietly now', 'c_mira')
    ]),
    panel('pn_3', 3, ['c_bolt', 'c_mira'], [
      line('l_bolt1', 'speech', 'Intruder detected', 'c_bolt'),
      line('l_mira3', 'speech', 'Bolt, quiet!', 'c_mira'),
      line('l_sfx', 'sfx', 'BEEP')
    ])
  ],
  render: {
    status: 'ready',
    asset: { path: 'u_test/proj_dlg/pg_1_v1.png', source: 'generated', at: T0, w: 1000, h: 1500 },
    history: [],
    qc: {
      score: 0.9,
      issues: [],
      checkedAt: T0,
      panelBoxes: P1_BOXES.map((b) => ({ ...b })),
      boxesFrom: 'vision',
      keepOut: [],
      // Mira has a head and a mouth in panel 2; Leo only a head; Bolt (panel 3) has no mark at all.
      heads: [
        { panel: 2, characterId: 'c_mira', head: { x: 0.14, y: 0.78 }, mouth: { x: 0.15, y: 0.81 } },
        { panel: 2, characterId: 'c_leo', head: { x: 0.38, y: 0.76 } }
      ]
    }
  },
  balloons: balloons ?? [
    { lineId: 'l_cap', x: 0.05, y: 0.05, w: 0.3 },
    { lineId: 'l_mira1', x: 0.06, y: 0.53, w: 0.2, tailX: 0.15, tailY: 0.81, pinned: true },
    { lineId: 'l_leo1', x: 0.3, y: 0.6, w: 0.16 },
    { lineId: 'l_bolt1', x: 0.55, y: 0.53, w: 0.2 },
    { lineId: 'l_sfx', x: 0.75, y: 0.85, w: 0.15, locked: true, pinned: true }
    // l_mira2 and l_mira3 have no stored balloon: the software places them.
  ]
});

export const page2 = (): Page => ({
  id: 'pg_2',
  n: 2,
  summary: 'Outside, in the rain',
  layout: 'Row 1: two equal panels side by side (panels 1–2).',
  panels: [
    panel('pn_4', 1, ['c_mira', 'c_leo'], [line('l_p2cap', 'caption', 'Meanwhile, outside.'), line('l_p2mira', 'speech', 'Is anyone there?', 'c_mira')]),
    panel('pn_5', 2, ['c_leo'], [line('l_p2leo', 'thought', 'I should have stayed home.', 'c_leo')])
  ],
  render: emptyRender(),
  balloons: []
});

/** The comic: overlay lettering, a 2:3 book, cast Mira Patel, Leo, Bolt (a robot) and Asha Patel (Mira's mom). */
export const dialogueDoc = (mutate?: (doc: ComicDoc) => void): ComicDoc => {
  const base = createEmptyDoc('proj_dlg', 'Night at the lab', T0);
  const doc = apply(base, [
    { op: 'character', id: 'c_mira', patch: { name: 'Mira Patel', tier: 'lead', look: { summary: 'A girl with a torch' } } },
    { op: 'character', id: 'c_leo', patch: { name: 'Leo', tier: 'support', look: { summary: 'A boy in a hoodie' } } },
    { op: 'character', id: 'c_bolt', patch: { name: 'Bolt', tier: 'support', kind: 'robot', look: { summary: 'A small round robot' } } },
    { op: 'character', id: 'c_asha', patch: { name: 'Asha Patel', role: "Mira's mom", tier: 'extra', look: { summary: 'A woman in a lab coat' } } }
  ]);
  doc.format = { ...doc.format, lettering: 'overlay', pageAspect: '2:3' };
  doc.planStatus = 'approved';
  doc.pages = [page1(), page2()];
  mutate?.(doc);
  return doc;
};

/** Every lettered line id in reading order (pages, panels, lines). */
export const allLineIds = (doc: ComicDoc): string[] => doc.pages.flatMap((p) => p.panels.flatMap((pn) => pn.lines.map((l) => l.id)));
