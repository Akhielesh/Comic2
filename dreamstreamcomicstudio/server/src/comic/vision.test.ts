// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { createEmptyDoc, emptyRender, type Balloon, type Box, type ComicDoc, type Line, type Page, type Panel } from '../../../shared/comic/doc.js';
import {
  MAX_BALLOON_W,
  MIN_BALLOON_W,
  VISION_SCHEMA,
  analyzePageRender,
  balloonWidth,
  compareLettering,
  coordinateScale,
  estimateBalloonHeight,
  estimatePanelBoxes,
  fallbackBalloons,
  visionSpecText
} from './vision.js';
import { StudioError, type LlmClient, type LlmRequest, type LlmResult } from './types.js';

// ── Fixtures ─────────────────────────────────────────────────────────────────

const line = (id: string, kind: Line['kind'], text: string, speakerId?: string): Line => ({ id, kind, text, ...(speakerId ? { speakerId } : {}) });

const panel = (n: number, castIds: string[], lines: Line[] = [], over: Partial<Panel> = {}): Panel => ({
  id: `pn_${n}`,
  n,
  size: 'medium',
  shot: 'medium',
  action: `Action ${n}.`,
  castIds,
  lines,
  ...over
});

const page = (panels: Panel[], over: Partial<Page> = {}): Page => ({
  id: 'pg_1',
  n: 1,
  summary: '',
  layout: '',
  panels,
  render: { ...emptyRender(), status: 'ready', asset: { path: 'pages/1.png', source: 'generated', at: 1, w: 1000, h: 1500 } },
  balloons: [],
  ...over
});

const doc = (patch: (d: ComicDoc) => void = () => undefined): ComicDoc => {
  const d = createEmptyDoc('doc_v', 'Test', 1);
  d.cast = [
    { id: 'maya', name: 'Maya', tier: 'lead', look: { summary: 'Courier in a red kurta' }, refs: [], sheet: emptyRender() },
    { id: 'arjun', name: 'Arjun', tier: 'support', look: { summary: 'Merchant with a grey beard' }, refs: [], sheet: emptyRender() }
  ];
  patch(d);
  return d;
};

const fakeLlm = (replies: (Partial<LlmResult> | Error)[]) => {
  const calls: LlmRequest[] = [];
  const llm: LlmClient = {
    complete: async (req) => {
      calls.push({ ...req, messages: [...req.messages] });
      const next = replies.shift();
      if (!next) throw new Error('unexpected call');
      if (next instanceof Error) throw next;
      return { text: '', model: 'google/gemini-3.8-flash', byok: false, provider: 'openrouter', ...next };
    }
  };
  return { llm, calls };
};

const within = (b: Balloon, box: Box, h = 0) => {
  const eps = 1e-6;
  expect(b.x).toBeGreaterThanOrEqual(box.x - eps);
  expect(b.y).toBeGreaterThanOrEqual(box.y - eps);
  expect(b.x + b.w).toBeLessThanOrEqual(box.x + box.w + eps);
  expect(b.y + h).toBeLessThanOrEqual(box.y + box.h + eps);
};

const noOverlap = (a: Box, b: Box) => a.x + a.w <= b.x + 1e-6 || b.x + b.w <= a.x + 1e-6 || a.y + a.h <= b.y + 1e-6 || b.y + b.h <= a.y + 1e-6;

const ASPECT = 1000 / 1500;
const rectOf = (b: Balloon, text: string): Box => ({ x: b.x, y: b.y, w: b.w, h: estimateBalloonHeight(text, b.w, ASPECT) });

// ── Layout parsing ───────────────────────────────────────────────────────────

describe('estimatePanelBoxes', () => {
  it('parses a row blueprint into boxes with 2% margins and gutters, in reading order', () => {
    const pg = page([1, 2, 3, 4, 5, 6].map((n) => panel(n, [])), {
      layout: 'Row 1: one wide panel. Row 2: two equal panels. Row 3: three small panels.'
    });
    const boxes = estimatePanelBoxes(pg);
    expect(boxes).toHaveLength(6);
    expect(boxes[0]).toMatchObject({ x: 0.02, y: 0.02, w: 0.96 });
    expect(boxes[1].x).toBe(0.02);
    expect(boxes[2].x).toBeCloseTo(0.02 + boxes[1].w + 0.02, 4);
    expect(boxes[1].y).toBeCloseTo(boxes[0].y + boxes[0].h + 0.02, 4);
    expect(boxes[3].w).toBeCloseTo((0.96 - 0.04) / 3, 4);
    expect(boxes[5].x + boxes[5].w).toBeCloseTo(0.98, 4);
    expect(boxes[5].y + boxes[5].h).toBeCloseTo(0.98, 4);
    for (let i = 0; i < boxes.length; i += 1) for (let j = i + 1; j < boxes.length; j += 1) expect(noOverlap(boxes[i], boxes[j])).toBe(true);
  });

  it('reads numerals and weights larger rows taller', () => {
    const pg = page([1, 2, 3].map((n) => panel(n, [])), { layout: 'Row 1: 2 panels. Row 2: 1 large panel.' });
    const boxes = estimatePanelBoxes(pg);
    expect(boxes).toHaveLength(3);
    expect(boxes[2].w).toBeCloseTo(0.96, 4);
    expect(boxes[2].h).toBeGreaterThan(boxes[0].h * 1.4);
  });

  it('mirrors rows for right-to-left reading', () => {
    const pg = page([1, 2].map((n) => panel(n, [])), { layout: 'Row 1: two equal panels.' });
    const ltr = estimatePanelBoxes(pg);
    const rtl = estimatePanelBoxes(pg, { readingDirection: 'rtl' });
    expect(ltr[0].x).toBeLessThan(ltr[1].x);
    expect(rtl[0].x).toBeGreaterThan(rtl[1].x);
  });

  it('places a tall spanning panel beside its stack', () => {
    const pg = page([1, 2, 3].map((n) => panel(n, [])), {
      layout: 'Rows 1–2: one tall panel on the left beside two stacked panels on the right.'
    });
    const [tall, top, bottom] = estimatePanelBoxes(pg);
    expect(tall.x).toBe(0.02);
    expect(top.x).toBeGreaterThan(tall.x + tall.w);
    expect(tall.h).toBeCloseTo(top.h + bottom.h + 0.02, 4);
    expect(bottom.y).toBeGreaterThan(top.y);
  });

  it('falls back to a blueprint from panel sizes when the layout is missing or disagrees', () => {
    const panels = [panel(1, [], [], { size: 'wide' }), panel(2, []), panel(3, [])];
    const fromSizes = estimatePanelBoxes(page(panels, { layout: '' }));
    expect(fromSizes[0].w).toBeCloseTo(0.96, 4);
    expect(fromSizes[1].w).toBeCloseTo(0.47, 4);
    const disagreeing = estimatePanelBoxes(page(panels, { layout: 'Row 1: four panels.' }));
    expect(disagreeing).toEqual(fromSizes);
    expect(estimatePanelBoxes(page([]))).toEqual([]);
  });

  it('stacks webtoon panels full width with generous gutters', () => {
    const pg = page([1, 2, 3, 4].map((n) => panel(n, [])), { layout: 'Row 1: two panels. Row 2: two panels.' });
    const boxes = estimatePanelBoxes(pg, { kind: 'webtoon' });
    expect(boxes.every((b) => Math.abs(b.w - 0.96) < 1e-4)).toBe(true);
    expect(boxes[1].y - (boxes[0].y + boxes[0].h)).toBeCloseTo(0.04, 4);
  });
});

// ── Sizing ───────────────────────────────────────────────────────────────────

describe('balloon sizing', () => {
  it('width grows with text length within 0.16–0.34', () => {
    expect(balloonWidth('Hi!')).toBe(MIN_BALLOON_W);
    expect(balloonWidth('x'.repeat(300))).toBe(MAX_BALLOON_W);
    const mid = balloonWidth('The monsoon is early this year, and so are they.');
    expect(mid).toBeGreaterThan(MIN_BALLOON_W);
    expect(mid).toBeLessThan(MAX_BALLOON_W);
  });

  it('height grows with wrapped lines and scales with the page aspect', () => {
    const short = estimateBalloonHeight('Hi!', 0.2);
    const long = estimateBalloonHeight('word '.repeat(40), 0.2);
    expect(long).toBeGreaterThan(short * 3);
    expect(estimateBalloonHeight('Hi!', 0.2, 1)).toBeGreaterThan(short);
  });
});

// ── Fallback layout ──────────────────────────────────────────────────────────

describe('fallbackBalloons', () => {
  const texts: Record<string, string> = {};
  const L = (id: string, kind: Line['kind'], text: string, speakerId?: string) => {
    texts[id] = text;
    return line(id, kind, text, speakerId);
  };
  const pg = page(
    [
      panel(1, ['maya', 'arjun'], [
        L('c1', 'caption', 'Old Mumbai. Dawn.'),
        L('s1', 'speech', 'You are late, courier. The buyers left an hour ago.', 'arjun'),
        L('s2', 'speech', 'The monsoon is early.', 'maya'),
        L('s3', 'shout', 'MOVE!', 'arjun')
      ]),
      panel(2, ['maya'], [L('fx', 'sfx', 'KRAK!'), L('c2', 'caption', 'Too late.')]),
      panel(3, [], [])
    ],
    { layout: 'Row 1: one wide panel. Row 2: two equal panels.' }
  );

  it('gives every line a balloon inside its panel, captions in the top-left corner, in reading order, without overlaps', () => {
    const boxes = estimatePanelBoxes(pg);
    const balloons = fallbackBalloons(pg, boxes);
    expect(balloons.map((b) => b.lineId)).toEqual(['c1', 's1', 's2', 's3', 'fx', 'c2']);
    const byId = Object.fromEntries(balloons.map((b) => [b.lineId, b]));
    for (const b of balloons) {
      const box = boxes[['c1', 's1', 's2', 's3'].includes(b.lineId) ? 0 : 1];
      within(b, box, estimateBalloonHeight(texts[b.lineId], b.w, ASPECT));
      expect(b.w).toBeGreaterThanOrEqual(Math.min(MIN_BALLOON_W, box.w));
      expect(b.w).toBeLessThanOrEqual(MAX_BALLOON_W);
    }
    expect(byId.c1.x).toBeCloseTo(boxes[0].x + 0.012, 4);
    expect(byId.c1.y).toBeCloseTo(boxes[0].y + 0.012, 4);
    expect(byId.s1.y).toBeGreaterThan(byId.c1.y);
    expect(byId.s2.y).toBeGreaterThan(byId.s1.y);
    // Maya is staged left, Arjun right (first-appearance order on the page).
    expect(byId.s2.x).toBeLessThan(byId.s1.x);
    // Spoken lines have tails below the balloon inside the panel; captions/sfx don't.
    expect(byId.s1.tailY).toBeGreaterThan(byId.s1.y);
    expect(byId.c1.tailX).toBeUndefined();
    expect(byId.fx.tailX).toBeUndefined();
    // Closing caption goes to the bottom-right corner.
    expect(byId.c2.x + byId.c2.w).toBeCloseTo(boxes[1].x + boxes[1].w - 0.012, 4);
    const rects = balloons.map((b) => rectOf(b, texts[b.lineId]));
    for (let i = 0; i < rects.length; i += 1) for (let j = i + 1; j < rects.length; j += 1) expect(noOverlap(rects[i], rects[j])).toBe(true);
  });

  it('puts captions in the top-right corner for right-to-left pages', () => {
    const boxes = estimatePanelBoxes(pg, { readingDirection: 'rtl' });
    const c1 = fallbackBalloons(pg, boxes, { readingDirection: 'rtl' }).find((b) => b.lineId === 'c1')!;
    expect(c1.x + c1.w).toBeCloseTo(boxes[0].x + boxes[0].w - 0.012, 4);
  });

  it('keeps pinned balloons exactly where the user put them', () => {
    const pinned = { ...pg, balloons: [{ lineId: 's2', x: 0.6, y: 0.2, w: 0.2, pinned: true }] };
    const out = fallbackBalloons(pinned);
    expect(out.find((b) => b.lineId === 's2')).toEqual({ lineId: 's2', x: 0.6, y: 0.2, w: 0.2, pinned: true });
  });

  it('is deterministic and estimates boxes itself when none are given', () => {
    expect(fallbackBalloons(pg)).toEqual(fallbackBalloons(pg, estimatePanelBoxes(pg)));
  });
});

// ── Lettering verification ───────────────────────────────────────────────────

describe('compareLettering', () => {
  const pg = page([
    panel(1, ['maya'], [line('a', 'speech', 'We are late, courier!', 'maya'), line('b', 'caption', 'Old Mumbai. Dawn.')]),
    panel(2, ['arjun'], [line('c', 'speech', 'The monsoon is early this year.', 'arjun'), line('d', 'sfx', 'KRAK!')])
  ]);

  it('accepts case/punctuation differences and text split across entries', () => {
    const check = compareLettering(pg, ['WE ARE LATE,', 'COURIER!', 'OLD MUMBAI — DAWN', 'THE MONSOON IS EARLY THIS YEAR', 'krak']);
    expect(check).toEqual({ missing: [], misspelled: [], unexpected: [] });
  });

  it('flags misspelled, missing and unexpected text', () => {
    const check = compareLettering(pg, ['WE ARE LATE, COURIER!', 'OLD MUMBIA DAWN', 'THE MOONSON IS ERLY THIS YEAR', 'OPEN 24 HOURS']);
    expect(check.misspelled.map((m) => m.line.id).sort()).toEqual(['b', 'c']);
    expect(check.missing.map((m) => m.line.id)).toEqual(['d']);
    expect(check.unexpected).toEqual(['OPEN 24 HOURS']);
  });
});

// ── analyzePageRender ────────────────────────────────────────────────────────

describe('analyzePageRender', () => {
  const twoPanel = () =>
    page(
      [
        panel(1, ['maya', 'arjun'], [
          line('l1', 'speech', 'You are late.', 'arjun'),
          line('l2', 'speech', 'The monsoon is early, and so are they.', 'maya'),
          line('l3', 'caption', 'Crawford Market.')
        ]),
        panel(2, ['maya'], [line('l4', 'thought', 'Run.', 'maya')])
      ],
      { layout: 'Row 1: one wide panel. Row 2: one wide panel.' }
    );
  const visionPanels = [
    { n: 2, box: { x: 0.03, y: 0.52, w: 0.94, h: 0.45 } },
    { n: 1, box: { x: 0.03, y: 0.03, w: 0.94, h: 0.46 } }
  ];

  it('sends the image + page spec to the vision role and post-processes balloons', async () => {
    const reply = {
      panels: visionPanels,
      issues: ['Panel 2: Maya\'s kurta is blue.'],
      textFound: [],
      extraOrMissingCharacters: ['Panel 1: an extra man behind Arjun'],
      score: 1.7,
      balloons: [
        { lineId: 'l1', x: 0.9, y: 0.6, w: 0.05, tailX: 0.95, tailY: 0.62 }, // outside its panel, tail inside the balloon
        { lineId: 'l2', x: -0.2, y: 0.05, w: 0.9, tailX: 0.3, tailY: 0.3 }, // off-page
        { lineId: 'l2', x: 0.5, y: 0.5, w: 0.2, tailX: 0.1, tailY: 0.1 }, // duplicate ignored
        { lineId: 'ghost', x: 0.1, y: 0.1, w: 0.2, tailX: -1, tailY: -1 },
        { lineId: 'l3', x: 0.05, y: 0.05, w: 0.2, tailX: 0.2, tailY: 0.2 } // overlaps l2; captions lose tails
      ]
    };
    const { llm, calls } = fakeLlm([{ json: reply, text: JSON.stringify(reply), costUsd: 0.0021 }]);
    const pg = twoPanel();
    const out = await analyzePageRender({ doc: doc(), page: pg, dataUrl: 'data:image/png;base64,AAAA', llm });

    expect(calls[0].role).toBe('vision');
    expect(calls[0].jsonSchema).toMatchObject({ name: 'comic_page_check', strict: true });
    const content = calls[0].messages[1].content as { type: string; image_url?: { url: string }; text?: string }[];
    expect(content[0]).toEqual({ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } });
    expect(content[1].text).toContain('l2 — MAYA (speech): "The monsoon is early, and so are they."');
    expect(String(calls[0].messages[0].content)).toContain('captions in the panel\'s top-left corner');

    expect(out.model).toBe('google/gemini-3.8-flash');
    expect(out.costUsd).toBeCloseTo(0.0021);
    expect(out.qc.score).toBe(0.75); // clamped to 1, capped by the character note
    expect(out.qc.issues).toEqual(["Panel 2: Maya's kurta is blue.", 'Panel 1: an extra man behind Arjun']);
    expect(out.qc.panelBoxes).toEqual([visionPanels[1].box, visionPanels[0].box]);

    expect(out.balloons.map((b) => b.lineId)).toEqual(['l1', 'l2', 'l3', 'l4']);
    const [b1, b2, b3, b4] = out.balloons;
    const p1 = visionPanels[1].box;
    const p2 = visionPanels[0].box;
    within(b1, p1, estimateBalloonHeight('You are late.', b1.w, ASPECT));
    within(b2, p1, estimateBalloonHeight('The monsoon is early, and so are they.', b2.w, ASPECT));
    within(b3, p1);
    within(b4, p2); // missing from the reply → fallback balloon in panel 2
    expect(b1.w).toBe(balloonWidth('You are late.')); // width from text, not the model's 0.05
    expect(b2.w).toBe(balloonWidth('The monsoon is early, and so are they.'));
    // l1 was pushed to the bottom of panel 1: its tail is moved out of the balloon (pointing
    // up, since there is no room below) and stays inside the panel.
    const r1 = rectOf(b1, 'You are late.');
    const tailInBalloon = b1.tailX! >= r1.x && b1.tailX! <= r1.x + r1.w && b1.tailY! >= r1.y && b1.tailY! <= r1.y + r1.h;
    expect(tailInBalloon).toBe(false);
    expect(b1.tailY!).toBeGreaterThanOrEqual(p1.y);
    expect(b1.tailY!).toBeLessThanOrEqual(p1.y + p1.h);
    expect(b3.tailX).toBeUndefined();
    expect(b4.tailX).toBeDefined();
    const rects = [
      rectOf(b1, 'You are late.'),
      rectOf(b2, 'The monsoon is early, and so are they.'),
      rectOf(b3, 'Crawford Market.')
    ];
    for (let i = 0; i < rects.length; i += 1) for (let j = i + 1; j < rects.length; j += 1) expect(noOverlap(rects[i], rects[j])).toBe(true);
  });

  it('converts 0–1000 grid coordinates (Gemini native) to page fractions', async () => {
    const reply = {
      panels: [
        { n: 1, box: { x: 30, y: 30, w: 940, h: 460 } },
        { n: 2, box: { x: 30, y: 520, w: 940, h: 450 } }
      ],
      issues: [],
      textFound: [],
      extraOrMissingCharacters: [],
      score: 0.9,
      balloons: [{ lineId: 'l1', x: 600, y: 60, w: 200, tailX: 700, tailY: 300 }]
    };
    const { llm } = fakeLlm([{ json: reply }]);
    const out = await analyzePageRender({ doc: doc(), page: twoPanel(), dataUrl: 'data:x', llm });
    expect(out.qc.panelBoxes).toEqual([visionPanels[1].box, visionPanels[0].box]);
    const b1 = out.balloons.find((b) => b.lineId === 'l1')!;
    expect(b1.x).toBeCloseTo(0.6, 4);
    expect(b1.y).toBeCloseTo(0.06, 4);
    expect(b1.tailX).toBeCloseTo(0.7, 4);
  });

  it('coordinateScale: fractions, 0–1000 grid, pixels with a known size, else unreadable', () => {
    expect(coordinateScale([0.2, 0.9])).toEqual({ sx: 1, sy: 1 });
    expect(coordinateScale([12, 980])).toEqual({ sx: 1000, sy: 1000 });
    expect(coordinateScale([12, 1400], { w: 1000, h: 1500 })).toEqual({ sx: 1000, sy: 1500 });
    expect(coordinateScale([12, 1400])).toBeNull();
  });

  it('flags a panel-count mismatch and uses estimated boxes', async () => {
    const reply = { panels: [visionPanels[1]], issues: [], textFound: [], extraOrMissingCharacters: [], score: 0.9, balloons: [] };
    const { llm } = fakeLlm([{ json: reply }, { json: reply }]);
    const pg = twoPanel();
    const out = await analyzePageRender({ doc: doc(), page: pg, dataUrl: 'data:x', llm });
    expect(out.qc.issues[0]).toBe('Expected 2 panels but the page shows 1.');
    expect(out.qc.score).toBe(0.6);
    expect(out.qc.panelBoxes).toEqual(estimatePanelBoxes(pg));
    expect(out.balloons).toHaveLength(4); // all from the layout fallback
  });

  it('reports stray text on overlay pages', async () => {
    const reply = { panels: visionPanels, issues: [], textFound: ['YOU ARE LATE'], extraOrMissingCharacters: [], score: 0.95, balloons: [] };
    const { llm } = fakeLlm([{ json: reply }, { json: reply }]);
    const out = await analyzePageRender({ doc: doc(), page: twoPanel(), dataUrl: 'data:x', llm });
    expect(out.qc.issues.some((i) => i.startsWith('Stray text drawn in the art: "YOU ARE LATE"'))).toBe(true);
    expect(out.qc.score).toBe(0.8);
    expect(out.qc.textFound).toEqual(['YOU ARE LATE']);
  });

  it('in-art lettering: compares text against the script and returns no overlay balloons', async () => {
    const reply = {
      panels: visionPanels,
      issues: [],
      textFound: ['YOU ARE LAET.', 'CRAWFORD MARKET', 'RUN.'],
      extraOrMissingCharacters: [],
      score: 0.92,
      balloons: []
    };
    const { llm, calls } = fakeLlm([{ json: reply }]);
    const out = await analyzePageRender({ doc: doc((d) => (d.format.lettering = 'in_art')), page: twoPanel(), dataUrl: 'data:x', llm });
    expect(calls).toHaveLength(1);
    expect(String(calls[0].messages[0].content)).toContain('balloons: [] — this page is lettered in the art.');
    expect(out.balloons).toEqual([]);
    expect(out.qc.issues).toContain('Panel 1: lettering differs from the script — expected "You are late.", found "YOU ARE LAET.".');
    expect(out.qc.issues).toContain('Panel 1: line missing from the art — "The monsoon is early, and so are they.".');
    expect(out.qc.score).toBe(0.6);
  });

  it('degrades to the layout fallback with an honest note when the reply is unusable twice', async () => {
    const { llm, calls } = fakeLlm([{ text: 'I cannot see the image.' }, { text: '???' }]);
    const pg = twoPanel();
    const out = await analyzePageRender({ doc: doc(), page: pg, dataUrl: 'data:x', llm });
    expect(calls).toHaveLength(2);
    expect(out.qc.score).toBe(0.5);
    expect(out.qc.issues[0]).toContain('Automatic page check returned no usable result');
    expect(out.balloons).toEqual(fallbackBalloons(pg, estimatePanelBoxes(pg), { readingDirection: 'ltr', kind: 'comic', pageAspect: ASPECT }));
  });

  it('propagates transport errors', async () => {
    const err = new StudioError('RATE_LIMIT', 'Busy.', { retryable: true });
    await expect(analyzePageRender({ doc: doc(), page: twoPanel(), dataUrl: 'data:x', llm: fakeLlm([err]).llm })).rejects.toBe(err);
  });

  it('keeps pinned balloons untouched', async () => {
    const pg = { ...twoPanel(), balloons: [{ lineId: 'l1', x: 0.7, y: 0.3, w: 0.2, pinned: true }] };
    const reply = {
      panels: visionPanels,
      issues: [],
      textFound: [],
      extraOrMissingCharacters: [],
      score: 0.9,
      balloons: [{ lineId: 'l1', x: 0.1, y: 0.1, w: 0.2, tailX: 0.2, tailY: 0.3 }]
    };
    const { llm } = fakeLlm([{ json: reply }]);
    const out = await analyzePageRender({ doc: doc(), page: pg, dataUrl: 'data:x', llm });
    expect(out.balloons.find((b) => b.lineId === 'l1')).toEqual({ lineId: 'l1', x: 0.7, y: 0.3, w: 0.2, pinned: true });
  });
});

describe('vision spec & schema', () => {
  it('spec text lists panels in order with staged cast and line ids', () => {
    const pg = page([panel(1, ['maya', 'arjun'], [line('ln_a', 'speech', 'Hi "there"', 'maya')]), panel(2, [])]);
    const text = visionSpecText(doc(), pg);
    expect(text).toContain('PAGE 1: 2 panels, read left-to-right, lettering: overlay');
    expect(text).toContain('CHARACTERS: MAYA — Courier in a red kurta; ARJUN — Merchant with a grey beard');
    expect(text).toContain('Panel 1 [medium, medium]: Action 1. Characters: MAYA (left), ARJUN (right).');
    expect(text).toContain('ln_a — MAYA (speech): "Hi \\"there\\""');
    expect(text).toContain('Panel 2 [medium, medium]: Action 2. Characters: none.');
  });

  it('schema is strict-mode compatible', () => {
    const walk = (node: Record<string, unknown>) => {
      if (node.type === 'object') {
        expect(node.additionalProperties).toBe(false);
        expect([...(node.required as string[])].sort()).toEqual(Object.keys(node.properties as object).sort());
        Object.values(node.properties as Record<string, Record<string, unknown>>).forEach(walk);
      }
      if (node.type === 'array') walk(node.items as Record<string, unknown>);
    };
    walk(VISION_SCHEMA as Record<string, unknown>);
  });
});
