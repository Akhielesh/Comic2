// Synthetic fixtures for the letter-fit tests (coverage cap, text-clear placement). Shaped like a stored v4 page
// (2:3 book, a drawn 1696×2528 take with measured panel boxes, six panels in a 2/1/3 layout, the last small
// panel carrying two long speech lines in software-placed, unpinned balloons) — the text is made up.

import { createEmptyDoc, emptyRender, type Balloon, type ComicDoc, type Line, type LineKind, type Page } from '../../doc';

const WORDS =
  'listen the carrier behind those flower stalls has no plates and nobody has unloaded anything since morning which means someone wants us watching it closely tonight'.split(
    ' '
  );

/** Made-up dialogue of about `chars` characters (whole words), deterministic per seed. */
export const sayChars = (chars: number, seed = 0): string => {
  let out = '';
  for (let i = seed; out.length < chars; i += 1) out += (out ? ' ' : '') + WORDS[i % WORDS.length];
  return out;
};

const line = (id: string, kind: LineKind, text: string, speakerId?: string): Line => ({ id, kind, text, ...(speakerId ? { speakerId } : {}) });

/** The measured panel boxes of the shape (page fractions). */
export const P2_BOXES = [
  { x: 0.028, y: 0.018, w: 0.591, h: 0.31 },
  { x: 0.635, y: 0.017, w: 0.334, h: 0.312 },
  { x: 0.028, y: 0.339, w: 0.941, h: 0.32 },
  { x: 0.028, y: 0.668, w: 0.281, h: 0.313 },
  { x: 0.32, y: 0.668, w: 0.315, h: 0.313 },
  { x: 0.645, y: 0.668, w: 0.324, h: 0.313 }
];

export interface P2Options {
  /** Panel 6 carries both long lines (default) or only the first. */
  panel6?: 'two' | 'one';
  /** The owner pinned panel 6's balloons where they are. */
  pin6?: boolean;
  /** A children's book (the kids' cap applies). */
  kids?: boolean;
}

/**
 * A page shaped like the owner's worst stored page: panel 6 (0.10 of the page) holds 29 words in two unpinned
 * speech balloons stored one under the other; three balloons elsewhere are pinned; panel 3 (wide) is silent.
 */
export function p2ShapedDoc(opts: P2Options = {}): { doc: ComicDoc; page: Page } {
  const doc = createEmptyDoc('doc_letterfit', 'Gate Lights', 1);
  doc.format.pageAspect = '2:3';
  doc.format.lettering = 'overlay';
  if (opts.kids) doc.format.kind = 'storybook';
  doc.letterStyle = { auto: true, presetId: 'classic' } as ComicDoc['letterStyle'];
  doc.cast = [
    { id: 'c_meera', name: 'Meera', tier: 'lead', look: { summary: 'Engineer with a wrist console' }, refs: [], sheet: emptyRender() },
    { id: 'c_kal', name: 'Kalyani', tier: 'support', look: { summary: 'Courier in a yellow raincoat' }, refs: [], sheet: emptyRender() },
    { id: 'c_dev', name: 'Dev', tier: 'support', look: { summary: 'Mechanic with a cap' }, refs: [], sheet: emptyRender() }
  ];
  const six: Line[] = [line('ln_6a', 'speech', sayChars(78, 7), 'c_meera')];
  if (opts.panel6 !== 'one') six.push(line('ln_6b', 'speech', sayChars(83, 12), 'c_kal'));
  const balloons: Balloon[] = [
    { lineId: 'ln_1', x: 0.04, y: 0.03, w: 0.2647, tailX: 0.1724, tailY: 0.1415, pinned: true },
    { lineId: 'ln_2', x: 0.647, y: 0.029, w: 0.16, pinned: true },
    { lineId: 'ln_4', x: 0.04, y: 0.68, w: 0.16, pinned: true },
    { lineId: 'ln_5', x: 0.332, y: 0.68, w: 0.291, tailX: 0.4775, tailY: 0.8062 },
    { lineId: 'ln_6a', x: 0.657, y: 0.68, w: 0.2812, tailX: 0.7976, tailY: 0.7915, ...(opts.pin6 ? { pinned: true } : {}) }
  ];
  if (opts.panel6 !== 'one') balloons.push({ lineId: 'ln_6b', x: 0.657, y: 0.7665, w: 0.2904, tailX: 0.8022, tailY: 0.878, ...(opts.pin6 ? { pinned: true } : {}) });
  const page: Page = {
    id: 'pg_2',
    n: 2,
    summary: 'At the gate the courier and the engineer argue about the carrier.',
    layout: 'Row 1: two equal panels. Row 2: one wide panel. Row 3: three small panels.',
    panels: [
      { id: 'pn_1', n: 1, size: 'medium', shot: 'wide', action: 'The three reach the gate.', castIds: ['c_meera', 'c_kal', 'c_dev'], lines: [line('ln_1', 'speech', sayChars(69, 0), 'c_meera')] },
      { id: 'pn_2', n: 2, size: 'medium', shot: 'medium', action: 'A shutter slams.', castIds: ['c_kal'], lines: [line('ln_2', 'sfx', 'KRRAK!')] },
      { id: 'pn_3', n: 3, size: 'wide', shot: 'wide', action: 'The empty market lane.', castIds: ['c_meera', 'c_kal'], lines: [] },
      { id: 'pn_4', n: 4, size: 'small', shot: 'insert', action: 'A wrist console blinks.', castIds: ['c_meera'], lines: [line('ln_4', 'sfx', 'BEEP!')] },
      { id: 'pn_5', n: 5, size: 'small', shot: 'close_up', action: 'Kalyani frowns.', castIds: ['c_kal'], lines: [line('ln_5', 'speech', sayChars(107, 3), 'c_kal')] },
      { id: 'pn_6', n: 6, size: 'small', shot: 'pov', action: 'From behind Kalyani: Meera at the plate.', castIds: ['c_meera', 'c_kal'], lines: six }
    ],
    render: {
      ...emptyRender(),
      status: 'ready',
      asset: { path: 'u/doc_letterfit/p2.png', w: 1696, h: 2528, source: 'generated', at: 1790000000000 },
      qc: { score: 0.75, issues: [], checkedAt: 1790000000000, panelBoxes: P2_BOXES.map((b) => ({ ...b })) }
    },
    balloons
  };
  doc.pages = [page];
  return { doc, page };
}
