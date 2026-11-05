import { describe, expect, it } from 'vitest';
import type { ComicDoc, Page } from '../doc.js';
import type { LetterPlan } from '../lettering/layout.js';
import { apply, baseDoc, drawnPage, line, pageOf, panel, T0, undrawnPage, withPages } from './__fixtures__/editorDoc.js';
import { checkFixEdit, checksSummary, pageChecks, type PageCheck } from './checks.js';
import { buildScene, type EditOk } from './scene.js';

const byId = (checks: PageCheck[], id: PageCheck['id']) => checks.find((c) => c.id === id)!;

/** A synthetic lettering plan: an outline box (page fractions) on a 2:3 page (plan units: W 1000, H 1500). */
const plan = (lineId: string, panelN: number, box: { x: number; y: number; w: number; h: number }, extra: Partial<LetterPlan> = {}): LetterPlan =>
  ({
    lineId,
    panelN,
    kind: 'speech',
    x: box.x * 1000,
    y: box.y * 1500,
    w: box.w * 1000,
    h: box.h * 1500,
    style: { shape: 'rect' },
    geometry: { bounds: { x: 0, y: 0, w: box.w * 1000, h: box.h * 1500 } },
    overflow: false,
    outOfSafeArea: false,
    ...extra
  }) as unknown as LetterPlan;

describe('page checks on fixtures', () => {
  it('54% coverage → look, naming the panel and the share; the fixes start free', () => {
    const page = drawnPage('pg_a', 1, 'two-tiers', [panel('p1', 1, [line('l1', 'A long speech about the storm.', 'speech', 'c_maya')]), panel('p2', 2)], {
      balloons: [{ lineId: 'l1', x: 0.1, y: 0.05, w: 0.6, pinned: true }]
    });
    const doc = withPages(baseDoc(), [page]);
    // Panel 1 is 0.96 × 0.47 = 0.4512 of the page; a 0.6 × 0.406 outline covers 54% of it.
    const checks = pageChecks(doc, page, { plans: [plan('l1', 1, { x: 0.1, y: 0.05, w: 0.6, h: 0.406 })] });
    const text = byId(checks, 'text');
    expect(text.state).toBe('look');
    expect(text.detail).toBe('Panel 1: balloons cover 54% of the panel');
    expect(text.targets).toContainEqual({ kind: 'frame', id: 'p1' });
    expect(text.fixes.every((f) => f.free)).toBe(true);
    expect(text.fixes.map((f) => f.key)).toEqual(expect.arrayContaining(['make_bigger', 'shrink_text']));
    // Under the cap it is ok.
    expect(byId(pageChecks(doc, page, { plans: [plan('l1', 1, { x: 0.1, y: 0.05, w: 0.3, h: 0.2 })] }), 'text').state).toBe('ok');
  });

  it('without plans the density fit decides (a crammed small panel reads as overfull)', () => {
    const words = 'We have to get across the river before the storm comes down the valley and floods the old bridge again tonight';
    const page = undrawnPage('pg_u', 1, [panel('u1', 1), panel('u2', 2, [line('a', words), line('b', words), line('c', words)]), panel('u3', 3), panel('u4', 4)], 'Row 1: two equal panels. Row 2: two equal panels.');
    const doc = withPages(baseDoc(), [page]);
    const text = byId(pageChecks(doc, page), 'text');
    expect(text.state).toBe('look');
    expect(text.detail).toMatch(/^Panel 2: balloons cover about \d+% of the panel$/);
    const move = text.fixes.find((f) => f.key === 'move_line')!;
    expect(move.ops![0]).toMatchObject({ op: 'line_move', id: 'c' });
  });

  it('a balloon over a face → look, with the free fix to move it clear', () => {
    const base = drawnPage('pg_a', 1, 'two-tiers', [panel('p1', 1, [line('l1', 'Hi!', 'speech', 'c_maya')]), panel('p2', 2)], {
      balloons: [{ lineId: 'l1', x: 0.1, y: 0.1, w: 0.25, pinned: true }]
    });
    // The face keep-out overlaps the balloon's outline; the head point itself sits just below the balloon, so only the
    // keep-out can find the overlap.
    const b = buildScene(withPages(baseDoc(), [base]), base).objects.find((o) => o.id === 'l1')!.box;
    const face = { x: b.x + 0.04, y: b.y + 0.01, w: 0.1, h: b.h + 0.01 };
    const head = { x: b.x + 0.09, y: b.y + b.h + 0.005 };
    const page = { ...base, render: { ...base.render, qc: { ...base.render.qc!, keepOut: [{ panel: 1, kind: 'face' as const, box: face }], heads: [{ panel: 1, characterId: 'c_maya', head }] } } };
    const doc = withPages(baseDoc(), [page]);
    const faces = byId(pageChecks(doc, page), 'faces');
    expect(faces).toMatchObject({ state: 'look', detail: "A balloon covers Maya's face in panel 1", targets: [{ kind: 'balloon', id: 'l1' }] });
    expect(faces.fixes[0]).toMatchObject({ key: 'move_clear', free: true, lineIds: ['l1'] });
    // Moved away, it is ok.
    const clear = { ...page, balloons: [{ lineId: 'l1', x: 0.6, y: 0.3, w: 0.25, pinned: true }] };
    expect(byId(pageChecks(withPages(doc, [clear]), clear), 'faces').state).toBe('ok');
  });

  it('no page check → unknown (honest), offering the paid re-check, never a false ok', () => {
    const page = drawnPage('pg_a', 1, 'two-tiers', [panel('p1', 1), panel('p2', 2)]);
    const bare: Page = { ...page, artMode: undefined, render: { ...page.render, qc: undefined, cuts: undefined } };
    const doc = withPages(baseDoc(), [bare]);
    const checks = pageChecks(doc, bare);
    for (const id of ['faces', 'characters', 'speakers', 'plan'] as const) {
      expect(byId(checks, id).state, id).toBe('unknown');
      expect(byId(checks, id).fixes).toEqual([{ key: 'recheck', label: 'Re-check this page', free: false }]);
    }
    const s = checksSummary(checks);
    expect(s.unknown).toBe(4);
    expect(s.label).toBe(`Checks ${s.ok}/${checks.length}`);
  });

  it('swapped lines → a reading-order look whose free fix swaps them back', () => {
    const page = drawnPage('pg_a', 1, 'two-tiers', [panel('p1', 1, [line('l1', 'Stop!'), line('l2', 'Run!')]), panel('p2', 2)], {
      balloons: [
        { lineId: 'l1', x: 0.6, y: 0.1, w: 0.2, pinned: true },
        // A touch lower but in the same row: it still reads first (left before right).
        { lineId: 'l2', x: 0.1, y: 0.11, w: 0.2, pinned: true }
      ]
    });
    const doc = withPages(baseDoc(), [page]);
    const order = byId(pageChecks(doc, page), 'order');
    expect(order.state).toBe('look');
    expect(order.detail).toBe('“Run!” is read before “Stop!”');
    expect(order.fixes).toEqual([{ key: 'swap_lines', label: 'Swap the two lines', free: true, ops: [{ op: 'line_move', pageId: 'pg_a', id: 'l2', toPanelId: 'p1', index: 0 }], lineIds: ['l2', 'l1'], panelId: 'p1' }]);
    const fixed = apply(doc, (checkFixEdit(doc, page, order.fixes[0]) as EditOk).ops);
    expect(byId(pageChecks(fixed, pageOf(fixed, 'pg_a')), 'order').state).toBe('ok');
  });

  it('lines the software places (a lettering plan, no stored balloon) never make a reading-order look', () => {
    const page = drawnPage('pg_a', 1, 'two-tiers', [panel('p1', 1, [line('l1', 'Stop!'), line('l2', 'Run!')]), panel('p2', 2)]);
    const doc = withPages(baseDoc(), [page]);
    // Settle put "Run!" to the left of "Stop!": nobody placed it there, so the script order stands.
    const plans = [plan('l1', 1, { x: 0.6, y: 0.1, w: 0.2, h: 0.05 }), plan('l2', 1, { x: 0.1, y: 0.11, w: 0.2, h: 0.05 })];
    expect(byId(pageChecks(doc, page, { plans }), 'order').state).toBe('ok');
    // The same places stored on the page (the user put them there) read out of order.
    const placed = { ...page, balloons: [{ lineId: 'l1', x: 0.6, y: 0.1, w: 0.2, pinned: true }, { lineId: 'l2', x: 0.1, y: 0.11, w: 0.2, pinned: true }] };
    expect(byId(pageChecks(withPages(doc, [placed]), placed, { plans }), 'order').state).toBe('look');
  });

  it('cuts that do not match the plan: free fixes first (check the edges; match the script when the beats are reordered), then the paid redraw', () => {
    const base = drawnPage('pg_a', 1, 'two-tiers', [panel('p1', 1), panel('p2', 2)], { qc: { beats: [2, 1] } });
    const page: Page = { ...base, render: { ...base.render, cuts: { ...base.render.cuts!, status: 'mismatch', note: 'The drawn panels may be swapped' } } };
    const doc = withPages(baseDoc(), [page]);
    const planC = byId(pageChecks(doc, page), 'plan');
    expect(planC.state).toBe('look');
    expect(planC.fixes).toEqual([
      { key: 'check_edges', label: 'Check the edges', free: true },
      { key: 'rebind', label: 'Match the script to the drawing', free: true, order: [2, 1] },
      { key: 'redraw_page', label: 'Redraw the page', free: false }
    ]);
    // Beats in the plan's own order (or not a reordering): no rebind.
    const inOrder: Page = { ...page, render: { ...page.render, qc: { ...page.render.qc!, beats: [1, 1] } } };
    expect(byId(pageChecks(withPages(doc, [inOrder]), inOrder), 'plan').fixes.map((f) => f.key)).toEqual(['check_edges', 'redraw_page']);
  });

  it('frames moved out of their order → "Panel 2 now reads before panel 1", renumber fixes it', () => {
    const page = drawnPage('pg_a', 1, 'two-tiers', [panel('p1', 1), panel('p2', 2)]);
    const swapped: Page = { ...page, panels: [{ ...page.panels[0], frame: page.panels[1].frame }, { ...page.panels[1], frame: page.panels[0].frame }] };
    const doc = withPages(baseDoc(), [swapped]);
    const order = byId(pageChecks(doc, swapped), 'order');
    expect(order.detail).toBe('Panel 2 now reads before panel 1');
    expect(order.fixes[0].ops).toEqual([{ op: 'panels_order', pageId: 'pg_a', order: ['p2', 'p1'] }]);
  });

  it('undrawn pages run only the checks that make sense before drawing', () => {
    const page = undrawnPage('pg_u', 1, [panel('u1', 1), panel('u2', 2, [], { action: '', castIds: [] })]);
    const doc = withPages(baseDoc(), [page]);
    const checks = pageChecks(doc, page);
    expect(checks.map((c) => c.id)).toEqual(['text', 'order', 'empty']);
    expect(byId(checks, 'empty')).toMatchObject({ state: 'look', detail: 'Panel 2 has nothing planned yet' });
  });

  it('a newer page check reads speakers, findings and the plan', () => {
    const page = drawnPage('pg_a', 1, 'two-tiers', [panel('p1', 1, [line('l1', 'Hi', 'speech', 'c_ravi')], { castIds: ['c_maya', 'c_ravi'] }), panel('p2', 2)], {
      qc: {
        checkV: 2,
        missingSpeakers: [{ panel: 1, castId: 'c_ravi' }],
        findings: [{ id: 'f1', kind: 'identity', panel: 2, characterId: 'c_maya', severity: 'major', note: "Maya's raincoat is blue here" }]
      }
    });
    const doc = withPages(baseDoc(), [page]);
    const checks = pageChecks(doc, page);
    expect(byId(checks, 'speakers')).toMatchObject({ state: 'look', detail: "Ravi speaks in panel 1 but isn't drawn" });
    expect(byId(checks, 'characters')).toMatchObject({ state: 'look', detail: "Panel 2: Maya's raincoat is blue here" });
    expect(byId(checks, 'characters').fixes[0]).toEqual({ key: 'looks_fine', label: 'Looks fine', free: true, findingId: 'f1', ops: [{ op: 'finding', pageId: 'pg_a', id: 'f1', patch: { dismissed: true } }] });
    expect(byId(checks, 'plan').state).toBe('ok');
    expect(byId(checks, 'empty').state).toBe('ok');
  });
});

describe('speed', () => {
  /** A 9-panel drawn page with two placed lines a panel and a full page check. */
  const ninePanelDoc = (): ComicDoc => {
    const frames = Array.from({ length: 9 }, (_, i) => ({ x: 0.02 + (i % 3) * 0.3267, y: 0.02 + Math.floor(i / 3) * 0.3267, w: 0.3133, h: 0.3133 }));
    const panels = frames.map((box, i) =>
      panel(`p${i + 1}`, i + 1, [line(`l${i}a`, `Line one of panel ${i + 1}, a few words long.`, 'speech', 'c_maya'), line(`l${i}b`, `And a reply in panel ${i + 1}.`, 'speech', 'c_ravi')], { frame: { box } })
    );
    const page: Page = {
      id: 'pg_9',
      n: 1,
      summary: 'Nine',
      layout: 'Row 1: three panels. Row 2: three panels. Row 3: three panels.',
      artMode: 'panels',
      panels,
      balloons: frames.flatMap((b, i) => [
        { lineId: `l${i}a`, x: b.x + 0.01, y: b.y + 0.01, w: 0.14, pinned: true },
        { lineId: `l${i}b`, x: b.x + 0.15, y: b.y + 0.12, w: 0.14, pinned: true }
      ]),
      render: {
        status: 'ready',
        asset: { path: 'u_test/proj_test/pg_9.png', source: 'generated', at: T0, w: 1600, h: 2400 },
        history: [],
        cuts: { status: 'ok', by: 'detect', at: T0, cuts: frames.map((box, i) => ({ panelId: `p${i + 1}`, drawn: i + 1, box, conf: 0.95 })) },
        qc: {
          score: 0.9,
          issues: [],
          checkedAt: T0,
          boxesFrom: 'vision',
          drawnBoxes: frames,
          keepOut: frames.map((b, i) => ({ panel: i + 1, kind: 'face' as const, box: { x: b.x + 0.2, y: b.y + 0.2, w: 0.05, h: 0.05 } })),
          heads: frames.map((b, i) => ({ panel: i + 1, characterId: 'c_maya', head: { x: b.x + 0.22, y: b.y + 0.22 } }))
        }
      }
    };
    return withPages(baseDoc(), [page]);
  };

  it('pageChecks runs in under 2 ms on a 9-panel page (median of repeated runs, generous margin on shared CI)', () => {
    const doc = ninePanelDoc();
    const page = doc.pages[0];
    const BUDGET_MS = 2;
    // Shared CI machines run several suites at once: the assertion allows a margin, the target stays 2 ms.
    const MARGIN = process.env.CI ? 3 : 1;
    for (let i = 0; i < 10; i++) pageChecks({ ...doc }, page);
    const times: number[] = [];
    for (let i = 0; i < 60; i++) {
      // A new doc object each run, as after an edit: nothing keyed on the doc object survives; unchanged subtrees are shared.
      const d = { ...doc };
      const t0 = performance.now();
      const checks = pageChecks(d, page);
      times.push(performance.now() - t0);
      expect(checks).toHaveLength(9);
    }
    times.sort((a, b) => a - b);
    const median = times[Math.floor(times.length / 2)];
    expect(median).toBeLessThan(BUDGET_MS * MARGIN);

    // The canvas path: the lettering plans it draws (exact coverage, overflow and safe-area flags).
    const plans = page.balloons.map((b) => {
      const n = Number(b.lineId.slice(1, -1)) + 1;
      return plan(b.lineId, n, { x: b.x, y: b.y, w: b.w, h: 0.04 });
    });
    for (let i = 0; i < 10; i++) pageChecks({ ...doc }, page, { plans });
    const withPlans: number[] = [];
    for (let i = 0; i < 60; i++) {
      const d = { ...doc };
      const t0 = performance.now();
      pageChecks(d, page, { plans });
      withPlans.push(performance.now() - t0);
    }
    withPlans.sort((a, b) => a - b);
    expect(withPlans[Math.floor(withPlans.length / 2)]).toBeLessThan(BUDGET_MS * MARGIN);
  });
});

describe('speakers drawn: the free fixes clear the check honestly', () => {
  /** Ravi is planned in panel 1 (cast and staging) and speaks there; the page check found him not drawn. */
  const fixture = (lettering?: 'in_art') => {
    const page = drawnPage(
      'pg_a',
      1,
      'two-tiers',
      [
        panel('p1', 1, [line('l1', 'Hi', 'speech', 'c_ravi'), line('l2', 'Over here!', 'shout', 'c_ravi'), line('l3', 'Hello', 'speech', 'c_maya')], {
          castIds: ['c_maya', 'c_ravi'],
          direction: { cast: { c_ravi: { pos: 'left' }, c_maya: { pos: 'right' } }, by: 'writer' }
        }),
        panel('p2', 2)
      ],
      { qc: { checkV: 2, missingSpeakers: [{ panel: 1, castId: 'c_ravi' }] } }
    );
    let doc = withPages(baseDoc(), [page]);
    if (lettering) doc = { ...doc, format: { ...doc.format, lettering } };
    return doc;
  };
  const speakers = (doc: ComicDoc) => byId(pageChecks(doc, pageOf(doc, 'pg_a')), 'speakers');

  it('"a voice from off the panel" takes him out of the panel\'s cast and staging, marks him off-panel, and the check reads ok', () => {
    const doc = fixture();
    const before = speakers(doc);
    expect(before.state).toBe('look');
    expect(before.fixes.map((f) => [f.key, f.free])).toEqual([
      ['off_panel', true],
      ['caption', true],
      ['redraw_panel', false]
    ]);
    const r = checkFixEdit(doc, pageOf(doc, 'pg_a'), before.fixes[0]) as EditOk;
    const after = apply(doc, r.ops);
    const p1 = pageOf(after, 'pg_a').panels[0];
    expect(p1.direction?.offPanel).toEqual(['c_ravi']);
    expect(p1.castIds).toEqual(['c_maya']);
    expect(p1.direction?.cast).toEqual({ c_maya: { pos: 'right' } });
    expect(p1.direction?.by).toBe('user');
    expect(speakers(after).state).toBe('ok');
  });

  it('marked off-panel while still planned in the panel is a contradiction: still a look, never a false ok', () => {
    const doc = fixture();
    const page = pageOf(doc, 'pg_a');
    const both = { ...page, panels: page.panels.map((p, i) => (i === 0 ? { ...p, direction: { ...p.direction, offPanel: ['c_ravi'] } } : p)) };
    expect(speakers(withPages(doc, [both])).state).toBe('look');
  });

  it('"a caption" turns his spoken lines in the panel into captions (overlay lettering only), and the check reads ok', () => {
    const doc = fixture();
    const cap = speakers(doc).fixes.find((f) => f.key === 'caption')!;
    expect(cap.label).toBe("Make Ravi's lines in panel 1 a caption");
    expect(cap.ops).toEqual([
      { op: 'line', pageId: 'pg_a', panelId: 'p1', id: 'l1', patch: { kind: 'caption' } },
      { op: 'line', pageId: 'pg_a', panelId: 'p1', id: 'l2', patch: { kind: 'caption' } }
    ]);
    const after = apply(doc, (checkFixEdit(doc, pageOf(doc, 'pg_a'), cap) as EditOk).ops);
    expect(pageOf(after, 'pg_a').panels[0].lines.map((l) => l.kind)).toEqual(['caption', 'caption', 'speech']);
    expect(speakers(after).state).toBe('ok');
    // Lettering drawn into the art is part of the picture: no caption fix there.
    expect(speakers(fixture('in_art')).fixes.map((f) => f.key)).toEqual(['off_panel', 'redraw_panel']);
  });
});
