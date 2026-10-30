import { describe, expect, it } from 'vitest';
import type { ComicDoc, Page } from '../doc.js';
import type { LetterPlan } from '../lettering/layout.js';
import { apply, baseDoc, drawnPage, line, pageOf, panel, T0, undrawnPage, withPages } from './__fixtures__/editorDoc.js';
import { checkFixEdit, checksSummary, pageChecks, type PageCheck } from './checks.js';
import type { EditOk } from './scene.js';

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
    const page = drawnPage('pg_a', 1, 'two-tiers', [panel('p1', 1, [line('l1', 'Hi!', 'speech', 'c_maya')]), panel('p2', 2)], {
      balloons: [{ lineId: 'l1', x: 0.1, y: 0.1, w: 0.25, pinned: true }],
      qc: { keepOut: [{ panel: 1, kind: 'face', box: { x: 0.14, y: 0.1, w: 0.1, h: 0.06 } }], heads: [{ panel: 1, characterId: 'c_maya', head: { x: 0.19, y: 0.13 } }] }
    });
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
        { lineId: 'l2', x: 0.1, y: 0.1, w: 0.2, pinned: true }
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
    const page = drawnPage('pg_a', 1, 'two-tiers', [panel('p1', 1, [line('l1', 'Hi', 'speech', 'c_ravi')]), panel('p2', 2)], {
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
    const MARGIN = process.env.CI ? 3 : 2;
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
  });
});
