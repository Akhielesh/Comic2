// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { createEmptyDoc, emptyRender, type ComicDoc, type Line, type Page, type Panel, type QcReport } from '../../../shared/comic/doc.js';
import type { SpendAction } from '../../../shared/comic/ops.js';
import { MAX_NOTICE_FIXES, QC_NOTICE_SCORE, identityNoticesEnabled, qcNoticeFor } from './qcNotice.js';
import { analyzePageRender, type CheckedQcReport } from './vision.js';
import type { LlmClient, LlmResult } from './types.js';

// ── Fixtures (synthetic, shaped like b4b5774f p2: a pov panel whose speaker is heard, not drawn) ──

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

const doc = (patch: (d: ComicDoc) => void = () => undefined): ComicDoc => {
  const d = createEmptyDoc('doc_qc', 'Market', 1);
  d.cast = [
    { id: 'meera', name: 'Meera', tier: 'lead', look: { summary: 'Engineer in a teal jacket' }, refs: [], sheet: emptyRender() },
    { id: 'kalyani', name: 'Kalyani', tier: 'support', look: { summary: 'Flower seller, grey braid' }, refs: [], sheet: emptyRender() }
  ];
  patch(d);
  return d;
};

/** Page 2: panel 1 establishes the market; panel 2 Kalyani speaks; panel 3 (shot set per test) Meera speaks twice. */
const marketPage = (shot3: Panel['shot'] = 'medium'): Page => ({
  id: 'pg_2',
  n: 2,
  summary: '',
  layout: 'Row 1: one wide panel. Row 2: two equal panels.',
  panels: [
    panel(1, ['kalyani'], [line('c1', 'caption', 'The flower market, before dawn.')], { shot: 'wide', action: 'Flower stalls under strings of bulbs.' }),
    panel(2, ['kalyani'], [line('k1', 'speech', 'You came back.', 'kalyani')], { action: 'Kalyani looks up from her baskets.' }),
    panel(3, ['kalyani', 'meera'], [line('m1', 'speech', 'Someone is following us.', 'meera'), line('m2', 'whisper', 'Do not turn around.', 'meera')], {
      shot: shot3,
      action: 'From Kalyani’s view, a sleek unmarked carrier sits parked behind the stalls.'
    })
  ],
  render: { ...emptyRender(), status: 'ready', asset: { path: 'pages/2.png', source: 'generated', at: 1, w: 1000, h: 1500 } },
  balloons: []
});

const qc = (over: Partial<CheckedQcReport> = {}): CheckedQcReport => ({ score: 0.9, issues: [], checkedAt: 1, boxesFrom: 'vision', ...over });

const PRICES: Record<string, number> = { recheck_page: 0.004, edit_page: 0.069, render_pages: 0.072 };
const quote = (a: SpendAction) => PRICES[a.type];

// ── The C14 rule ─────────────────────────────────────────────────────────────

describe('qcNoticeFor: when the chat speaks up (plan §3 C14)', () => {
  it('a missing non-POV speaker raises a notice at score 0.75 (not below the threshold), free fix first', () => {
    const pg = marketPage('medium');
    const notice = qcNoticeFor(qc({ score: 0.75, missingSpeakers: [{ panel: 3, castId: 'meera' }] }), pg, { doc: doc(), quote });
    expect(QC_NOTICE_SCORE).toBe(0.75);
    expect(notice).not.toBeNull();
    expect(notice!.tone).toBe('info');
    expect(notice!.text).toBe(
      "Check page 2: MEERA speaks in panel 3 but isn't drawn there. Free fix: make MEERA's lines in panel 3 a caption. Open page 2 to fix one panel, or say “redraw page 2” for a new take."
    );
    expect(notice!.fixes.map((f) => [f.label, f.free])).toEqual([
      ["Make MEERA's lines in panel 3 a caption", true],
      ['Redraw panel 3 with MEERA', false],
      ['Redraw page 2', false]
    ]);
    // The free fix only changes line kinds (not hashed for overlay pages): the page never goes falsely stale.
    expect(notice!.fixes[0].action).toEqual({
      type: 'patch',
      ops: [
        { op: 'line', pageId: 'pg_2', panelId: 'pn_3', id: 'm1', patch: { kind: 'caption' } },
        { op: 'line', pageId: 'pg_2', panelId: 'pn_3', id: 'm2', patch: { kind: 'caption' } }
      ]
    });
    // Paid fixes carry their quote (a chip tap is the confirmation; a stale quote re-gates).
    expect(notice!.fixes[1].action).toMatchObject({ type: 'edit_page', pageId: 'pg_2', panelN: 3, quotedUsd: 0.069 });
    expect((notice!.fixes[1].action as { instruction: string }).instruction).toContain('In panel 3 only, draw MEERA');
    expect(notice!.fixes[2].action).toEqual({ type: 'render_pages', pageIds: ['pg_2'], force: true, quotedUsd: 0.072 });
  });

  it('a POV speaker does not: a stored entry for an off-panel voice is ignored, and 0.75 alone stays quiet', () => {
    for (const shot of ['pov', 'insert', 'establishing'] as const) {
      expect(qcNoticeFor(qc({ score: 0.75, missingSpeakers: [{ panel: 3, castId: 'meera' }] }), marketPage(shot), { doc: doc(), quote })).toBeNull();
    }
    // Nor a speaker the panel's cast no longer lists (made off-panel since the check).
    const pg = marketPage('medium');
    pg.panels[2].castIds = ['kalyani'];
    expect(qcNoticeFor(qc({ score: 0.9, missingSpeakers: [{ panel: 3, castId: 'meera' }] }), pg, { doc: doc(), quote })).toBeNull();
  });

  it('0.98 with no issues stays quiet; so does an old report with no new fields', () => {
    expect(qcNoticeFor(qc({ score: 0.98 }), marketPage(), { doc: doc(), quote })).toBeNull();
    const old: QcReport = { score: 0.9, issues: ['Panel 1: the bulbs are dim.'], checkedAt: 1, panelBoxes: [] };
    expect(qcNoticeFor(old, marketPage(), { doc: doc(), quote })).toBeNull();
    expect(qcNoticeFor(undefined, marketPage())).toBeNull();
  });

  it('a score below 0.75 speaks with the top issues; below 0.45 it warns, as today', () => {
    const mid = qcNoticeFor({ score: 0.6, issues: ['Panel 2: line missing from the art — "You came back.".', 'Panel 3: the cart is red.'], checkedAt: 1 }, marketPage(), { doc: doc(), quote });
    expect(mid).toMatchObject({ tone: 'info' });
    expect(mid!.text).toBe(
      'Check page 2: Panel 2: line missing from the art — "You came back."; Panel 3: the cart is red. Open page 2 to fix one panel, or say “redraw page 2” for a new take.'
    );
    expect(mid!.fixes.map((f) => f.label)).toEqual(['Redraw page 2']);
    const bad = qcNoticeFor({ score: 0.3, issues: ['Garbled art.'], checkedAt: 1 }, marketPage(), { doc: doc(), quote });
    expect(bad).toMatchObject({ tone: 'warn' });
    expect(bad!.text.startsWith('Page 2 may need another pass: Garbled art.')).toBe(true);
  });

  it('a beat permutation is reported, never re-assigned: no script edit is offered, only a quoted redraw', () => {
    const notice = qcNoticeFor(qc({ score: 0.95, beats: [1, 3, 2] }), marketPage(), { doc: doc(), quote });
    expect(notice!.text).toContain("Check page 2: panels 2 and 3 show each other's moments.");
    expect(notice!.fixes).toEqual([{ label: 'Redraw page 2', free: false, action: { type: 'render_pages', pageIds: ['pg_2'], force: true, quotedUsd: 0.072 } }]);
    expect(notice!.fixes.some((f) => f.action.type === 'patch')).toBe(false);
    // A longer cycle names each panel.
    const four = { ...marketPage(), panels: [...marketPage().panels, panel(4, [], [], { action: 'The carrier pulls away.' })] };
    expect(qcNoticeFor(qc({ beats: [2, 3, 1, 4] }), four, { quote })!.text).toContain(
      "panel 1's picture shows panel 2's moment; panel 2's picture shows panel 3's moment; and 1 more"
    );
  });

  it('a planned moment drawn nowhere offers a quoted redraw of that panel from its own action', () => {
    const notice = qcNoticeFor(qc({ score: 0.95, beats: [1, 1, 3] }), marketPage(), { doc: doc(), quote });
    expect(notice!.text).toContain("panel 2's moment isn't drawn in any panel");
    expect(notice!.fixes[0]).toMatchObject({ label: 'Redraw panel 2 to show its moment', free: false });
    expect((notice!.fixes[0].action as { instruction: string }).instruction).toBe(
      'In panel 2 only, redraw the art to show: Kalyani looks up from her baskets. Keep everything else on the page exactly as it is.'
    );
  });

  it('a count mismatch names both counts and offers the cheap re-check before a redraw; beats are not read then', () => {
    const box = { x: 0.02, y: 0.02, w: 0.96, h: 0.3 };
    const notice = qcNoticeFor(qc({ score: 0.6, boxesFrom: 'estimate', drawnBoxes: [box, box], beats: [2, 1] }), marketPage(), { doc: doc(), quote });
    expect(notice!.text).toContain('Check page 2: it has 2 drawn panels; the plan has 3.');
    expect(notice!.text).not.toContain('moment');
    expect(notice!.fixes.map((f) => f.label)).toEqual(['Re-check page 2', 'Redraw page 2']);
    expect(notice!.fixes[0].action).toEqual({ type: 'recheck_page', pageId: 'pg_2', quotedUsd: 0.004 });
  });

  it('without a quote no paid chip is offered; without the doc no caption fix and no names; in-art pages get no caption fix', () => {
    const report = qc({ score: 0.75, missingSpeakers: [{ panel: 3, castId: 'meera' }] });
    expect(qcNoticeFor(report, marketPage(), { doc: doc() })!.fixes.every((f) => f.free)).toBe(true);
    const bare = qcNoticeFor(report, marketPage());
    expect(bare!.fixes).toEqual([]);
    expect(bare!.text).toContain("a speaker speaks in panel 3 but isn't drawn there");
    const inArt = qcNoticeFor(report, marketPage(), { doc: doc((d) => (d.format.lettering = 'in_art')), quote });
    expect(inArt!.fixes.map((f) => f.label)).toEqual(['Redraw panel 3 with MEERA', 'Redraw page 2']);
    expect(inArt!.text).not.toContain('Free fix');
  });

  it('identity findings are dormant until COMIC_IDENTITY_NOTICES is on', () => {
    const report = { ...qc({ score: 0.9 }), findings: [{ kind: 'identity', severity: 'major', panel: 2, characterId: 'kalyani', note: 'braid black, sheet grey' }] } as QcReport;
    expect(qcNoticeFor(report, marketPage(), { doc: doc(), quote })).toBeNull();
    expect(qcNoticeFor(report, marketPage(), { doc: doc(), quote, identityNotices: true })!.text).toContain('KALYANI looks different from their sheet in panel 2');
    expect(identityNoticesEnabled({})).toBe(false);
    expect(identityNoticesEnabled({ COMIC_IDENTITY_NOTICES: '1' })).toBe(true);
  });

  it('malformed stored fields are ignored, never trusted; chips are capped', () => {
    const junk = { score: 0.9, issues: [], checkedAt: 1, beats: ['x'], missingSpeakers: [{ panel: 'a' }, null, { panel: 9, castId: 'meera' }], drawnBoxes: 'no' } as unknown as QcReport;
    expect(qcNoticeFor(junk, marketPage(), { doc: doc(), quote })).toBeNull();
    const many = qc({ score: 0.5, beats: [1, 1, 1], missingSpeakers: [{ panel: 2, castId: 'kalyani' }, { panel: 3, castId: 'meera' }] });
    expect(qcNoticeFor(many, marketPage(), { doc: doc(), quote })!.fixes.length).toBeLessThanOrEqual(MAX_NOTICE_FIXES);
  });
});

// ── End to end: a vision reply through analyzePageRender into the notice ────

const fakeLlm = (json: unknown): LlmClient => ({
  complete: async () => ({ text: JSON.stringify(json), json, model: 'vision-fake', byok: false, provider: 'openrouter' }) as LlmResult
});

describe('qcNoticeFor after a real page check (fake vision, no paid call)', () => {
  const reply = {
    panels: [
      { n: 1, box: { x: 0.02, y: 0.02, w: 0.96, h: 0.46 }, beat: 1, crosses: false },
      { n: 2, box: { x: 0.02, y: 0.5, w: 0.47, h: 0.48 }, beat: 2, crosses: false },
      { n: 3, box: { x: 0.51, y: 0.5, w: 0.47, h: 0.48 }, beat: 3, crosses: false }
    ],
    issues: [],
    textFound: [],
    extraOrMissingCharacters: ['Panel 3: MEERA missing from art'],
    score: 0.92,
    balloons: ['c1', 'k1', 'm1', 'm2'].map((lineId, i) => ({ lineId, x: 0.1, y: 0.05 + i * 0.1, w: 0.2, tailX: -1, tailY: -1 })),
    safety: { rating: 'G', categories: [], notes: [] },
    keepOut: [],
    heads: []
  };

  it('non-POV: the check caps at 0.75, structures the speaker, and the notice fires', async () => {
    const pg = marketPage('medium');
    const out = await analyzePageRender({ doc: doc(), page: pg, dataUrl: 'data:x', llm: fakeLlm(reply) });
    expect(out.qc.score).toBe(0.75);
    expect(out.qc.missingSpeakers).toEqual([{ panel: 3, castId: 'meera' }]);
    expect(qcNoticeFor(out.qc, pg, { doc: doc(), quote })?.text).toContain("MEERA speaks in panel 3 but isn't drawn there");
  });

  it('POV (b4b5774f p2 panel 6 shape): the art followed the shot — no cap, no structure, no notice', async () => {
    const pg = marketPage('pov');
    const out = await analyzePageRender({ doc: doc(), page: pg, dataUrl: 'data:x', llm: fakeLlm(reply) });
    expect(out.qc.score).toBe(0.92);
    expect(out.qc.missingSpeakers).toBeUndefined();
    expect(out.qc.issues).toEqual([]);
    expect(qcNoticeFor(out.qc, pg, { doc: doc(), quote })).toBeNull();
  });
});
