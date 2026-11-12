// PE-MOTION-ENGINE beats (master plan §2.5 graft 9, §2.12; AV-0 wave note 2, collision A-1): pageBeats IS the export's
// page timing. The golden: for every fixture motionComic's own tests use, plus every QA fixture (left to right and right
// to left), pageBeats equals buildMotionTimeline's page and panel shots, with its defaults (AV-0's shot holds adopted, so
// the preview equals the export) and with other options. Panel order is the visual reading order from
// shared/comic/readingOrder.ts, which pageBeats calls and never re-implements.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { makeSampleDoc } from '../../../components/comicstudio/board/__fixtures__/sampleDoc';
import { makeBook } from '../../../components/comicstudio/export/__fixtures__/books';
import * as exporter from '../../../components/comicstudio/export/motionComic';
import { makeQaDoc, QA_FIXTURES } from '../../../components/comicstudio/testing/qaFixtures';
import { emptyRender, type Box, type ComicDoc, type Page, type Panel, type PanelSize, type ShotType } from '../doc';
import { MOTION_LIMITS } from '../limits';
import {
  lineChainHeads,
  lineRevealMs,
  pageBeats,
  panelBeatAt,
  panelBeatOf,
  panelHoldMs,
  readMs,
  SHOT_MIN_HOLD_MS,
  SIZE_HOLD_BONUS_MS,
  type BeatOptions
} from './beats';

// ── Fixtures (the ones components/comicstudio/export/motionComic.test.ts builds, plus the QA fixtures) ─────────

const drawn = (mutate?: (d: ComicDoc) => void): ComicDoc =>
  makeSampleDoc((d) => {
    d.cover = { ...d.cover, render: { ...emptyRender(), status: 'ready', asset: { path: 'cover.webp', source: 'generated', at: 1 } } };
    d.pages = d.pages.map((p) => ({ ...p, render: { ...emptyRender(), status: 'ready', asset: { path: `p${p.n}.webp`, source: 'generated', at: 1 } } }));
    mutate?.(d);
  });

const measured = (p: Page, boxes: Box[]): Page => ({ ...p, render: { ...p.render, qc: { score: 0.9, issues: [], checkedAt: 1, panelBoxes: boxes, boxesFrom: 'vision' } } });

/** motionComic.test.ts's RTL fixture: a manga book whose pages came out in another arrangement than the script. */
const rtlBook = (): ComicDoc =>
  drawn((d) => {
    d.format = { ...d.format, readingDirection: 'rtl', lettering: 'overlay' };
    d.pages = d.pages.map((p) => {
      if (p.id === 'pg_1')
        return measured(p, [
          { x: 0.04, y: 0.52, w: 0.92, h: 0.44 },
          { x: 0.04, y: 0.04, w: 0.44, h: 0.44 },
          { x: 0.52, y: 0.04, w: 0.44, h: 0.44 }
        ]);
      if (p.id === 'pg_5')
        return measured(p, [
          { x: 0.04, y: 0.04, w: 0.44, h: 0.44 },
          { x: 0.52, y: 0.04, w: 0.44, h: 0.44 },
          { x: 0.04, y: 0.52, w: 0.92, h: 0.44 }
        ]);
      return p;
    });
  });

const onePanel = (patch: Partial<Panel>) =>
  drawn((d) => {
    d.pages = d.pages.map((p) => (p.id === 'pg_1' ? { ...p, panels: [{ ...p.panels[0], ...patch }] } : p));
  });
const wordsOf = (n: number) => Array.from({ length: n }, (_, i) => `word${i}`).join(' ');

const FIXTURES: [string, () => ComicDoc][] = [
  ['sample, drawn', () => drawn()],
  ['sample, overlay', () => drawn((d) => (d.format.lettering = 'overlay'))],
  [
    'sample, in-art with an undrawn page',
    () =>
      drawn((d) => {
        d.format.lettering = 'in_art';
        d.pages[1] = { ...d.pages[1], render: emptyRender() };
      })
  ],
  ['book', () => makeBook()],
  ['book, telugu edition', () => makeBook(undefined, { telugu: true })],
  ['RTL manga, rearranged pages', rtlBook],
  [
    'LTR, rearranged page',
    () =>
      drawn((d) => {
        d.pages = d.pages.map((p) =>
          p.id === 'pg_1'
            ? measured(p, [
                { x: 0.04, y: 0.52, w: 0.92, h: 0.44 },
                { x: 0.04, y: 0.04, w: 0.44, h: 0.44 },
                { x: 0.52, y: 0.04, w: 0.44, h: 0.44 }
              ])
            : p
        );
      })
  ],
  ['silent establishing panel', () => onePanel({ shot: 'establishing', size: 'wide', lines: [] })],
  ['silent splash', () => onePanel({ shot: 'establishing', size: 'splash', lines: [] })],
  ['silent insert', () => onePanel({ shot: 'insert', size: 'small', lines: [] })],
  ['long speech', () => onePanel({ shot: 'establishing', size: 'small', lines: [{ id: 'lx', kind: 'speech', text: wordsOf(20) }] })],
  ['speech past the cap', () => onePanel({ shot: 'establishing', size: 'splash', lines: [{ id: 'ly', kind: 'speech', text: wordsOf(60) }] })],
  ['odd stored shot and size', () => onePanel({ shot: 'hasOwnProperty' as Panel['shot'], size: 'valueOf' as Panel['size'], lines: [] })],
  ...QA_FIXTURES.flatMap((name): [string, () => ComicDoc][] => [
    [`QA ${name}`, () => makeQaDoc(name)],
    [`QA ${name}, RTL`, () => makeQaDoc(name, { rtl: true })]
  ])
];

/** buildMotionTimeline's shots of each page, timed from the page's start. */
const exportedPages = (doc: ComicDoc, opts?: BeatOptions) => {
  const { shots } = exporter.buildMotionTimeline(doc, opts);
  const out: { pageId: string; overviewMs: number; panels: unknown[]; beatsMs: number }[] = [];
  shots.forEach((s, i) => {
    if (s.kind !== 'page') return;
    const panels = [];
    for (let j = i + 1; j < shots.length && shots[j].kind === 'panel' && shots[j].pageId === s.pageId; j += 1) panels.push(shots[j]);
    const end = panels.length ? panels[panels.length - 1].startMs + panels[panels.length - 1].durationMs : s.startMs + s.durationMs;
    out.push({
      pageId: s.pageId!,
      overviewMs: s.durationMs,
      panels: panels.map((p) => ({ panelN: p.panelN, box: p.box, startMs: p.startMs - s.startMs, durationMs: p.durationMs, reveals: p.reveals, carried: p.carried })),
      beatsMs: end - s.startMs
    });
  });
  return out;
};

const beatsShape = (doc: ComicDoc, page: Page, opts?: BeatOptions) => {
  const b = pageBeats(doc, page, opts);
  return {
    pageId: b.pageId,
    overviewMs: b.overviewMs,
    panels: b.panels.map((p) => ({ panelN: p.panelN, box: p.box, startMs: p.startMs, durationMs: p.durationMs, reveals: p.reveals, carried: p.carried })),
    beatsMs: b.beatsMs
  };
};

const OPTIONS: [string, BeatOptions | undefined][] = [
  ['defaults (shot holds on, as the export)', undefined],
  ['shot holds off (today except panel order)', { shotHolds: false }],
  ['other speeds and bounds', { wordsPerMinute: 150, minPanelMs: 2000, maxPanelMs: 6000, pageOverviewMs: 900 }]
];

describe('pageBeats golden: equals buildMotionTimeline for every fixture (AV-0 #2)', () => {
  for (const [optName, opts] of OPTIONS) {
    it(`every page of every fixture, ${optName}`, () => {
      let pages = 0;
      let panels = 0;
      let reveals = 0;
      let rtlPages = 0;
      for (const [name, make] of FIXTURES) {
        const doc = make();
        for (const exported of exportedPages(doc, opts)) {
          const page = doc.pages.find((p) => p.id === exported.pageId)!;
          expect(beatsShape(doc, page, opts), `${name} ${page.id}`).toEqual(exported);
          pages += 1;
          panels += exported.panels.length;
          reveals += (exported.panels as { reveals: unknown[] }[]).reduce((n, p) => n + p.reveals.length, 0);
          if (doc.format.readingDirection === 'rtl') rtlPages += 1;
        }
      }
      // Not vacuous: hundreds of pages, overlay reveals and right-to-left books are all compared.
      expect(pages).toBeGreaterThan(150);
      expect(panels).toBeGreaterThan(500);
      expect(reveals).toBeGreaterThan(20);
      expect(rtlPages).toBeGreaterThan(50);
    });
  }

  it('the RTL fixture reads in visual order, not the written one (the golden is not trivially the script order)', () => {
    const doc = rtlBook();
    const order = (id: string) => pageBeats(doc, doc.pages.find((p) => p.id === id)!).panels.map((p) => p.panelN);
    expect(order('pg_1')).toEqual([3, 2, 1]);
    expect(order('pg_5')).toEqual([2, 1, 3]);
  });

  it('the shot holds are adopted: a silent establishing panel holds 3.5 s, as the export plays it', () => {
    const doc = onePanel({ shot: 'establishing', size: 'wide', lines: [] });
    const page = doc.pages[0];
    expect(pageBeats(doc, page).panels[0].durationMs).toBe(3500);
    expect(pageBeats(doc, page, { shotHolds: false }).panels[0].durationMs).toBe(1800);
  });
});

describe('pageBeats: reading order and holds come from one source', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, 'beats.ts'), 'utf8');

  it('calls panelReadingOrder from shared/comic/readingOrder.ts and never re-implements the rule', () => {
    expect(src).toMatch(/import \{ panelReadingOrder \} from '\.\.\/readingOrder\.js';/);
    expect(src).toMatch(/panelReadingOrder\(boxes, page\.panels\.length, rtl\)/);
    // No row bands, no geometric sort of its own.
    expect(src).not.toMatch(/READING_ROW_TOLERANCE|\.sort\(|\bboxes\[\w+\]\.y\b/);
  });

  it('the hold constants deep-equal motionComic.ts exports (frozen there until PE-MOTION-EXPORT / AV-1 import them from here)', () => {
    expect(SHOT_MIN_HOLD_MS).toEqual(exporter.SHOT_MIN_HOLD_MS);
    expect(SIZE_HOLD_BONUS_MS).toEqual(exporter.SIZE_HOLD_BONUS_MS);
    const shots = [...Object.keys(exporter.SHOT_MIN_HOLD_MS), 'dutch', 'constructor', 'hasOwnProperty', '__proto__'] as ShotType[];
    const sizes = ['splash', 'large', 'wide', 'medium', 'small', 'inset', 'toString', '__proto__', 'valueOf'] as PanelSize[];
    for (const shot of shots) for (const size of sizes) expect(panelHoldMs({ shot, size }), `${shot}/${size}`).toBe(exporter.panelHoldMs({ shot, size }));
    for (const text of ['', 'Hi', wordsOf(3), wordsOf(12), wordsOf(60), '  spaced   out  words  ']) {
      expect(readMs(text)).toBe(exporter.readMs(text));
      expect(readMs(text, 120)).toBe(exporter.readMs(text, 120));
    }
  });
});

describe('page beats helpers', () => {
  it('lines carry their page time; anchors follow the reveal when dialogue grows', () => {
    const doc = drawn((d) => (d.format.lettering = 'overlay'));
    const page = doc.pages[0];
    const before = pageBeats(doc, page);
    // Panel 3's second line reveals after the first one has been read.
    const l3 = lineRevealMs(before, 'pg_1_l3')!;
    const l4 = lineRevealMs(before, 'pg_1_l4')!;
    expect(l4 - l3).toBe(readMs('Thief!'));
    expect(panelBeatOf(before, 'pg_1_p3')!.startMs + 450).toBe(l3);
    // Grow panel 1's caption: every later reveal moves by exactly the extra reading time.
    const longer = { ...page, panels: page.panels.map((p, i) => (i ? p : { ...p, lines: [{ ...p.lines[0], text: wordsOf(12) }] })) };
    const after = pageBeats(doc, longer);
    const grew = after.panels[0].durationMs - before.panels[0].durationMs;
    expect(grew).toBeGreaterThan(0);
    expect(lineRevealMs(after, 'pg_1_l4')! - l4).toBe(grew);
    expect(lineRevealMs(before, 'nope')).toBeUndefined();
  });

  it('in-art lettering reveals nothing; the hold is clamped to its write bound; panelBeatAt finds the shot on screen', () => {
    const doc = drawn((d) => (d.format.lettering = 'in_art'));
    const page = { ...doc.pages[0], motion: { clips: [], hold: 99_000 } };
    const beats = pageBeats(doc, page);
    expect(beats.lines).toEqual([]);
    expect(beats.holdMs).toBe(MOTION_LIMITS.holdMaxMs);
    expect(beats.totalMs).toBe(beats.beatsMs + MOTION_LIMITS.holdMaxMs);
    expect(pageBeats(doc, { ...page, motion: { clips: [], hold: -5 } }).holdMs).toBe(0);
    expect(panelBeatAt(beats, 0)).toBeUndefined();
    expect(panelBeatAt(beats, beats.overviewMs)?.panelId).toBe(beats.panels[0].panelId);
    expect(panelBeatAt(beats, beats.beatsMs)).toBeUndefined();
  });

  it('linked balloon chains map every member to their head (the line that links to no one)', () => {
    const page = drawn().pages[0];
    const chain = {
      ...page,
      balloons: [
        ...page.balloons.filter((b) => b.lineId !== 'pg_1_l5'),
        { lineId: 'pg_1_l4', x: 0.5, y: 0.6, w: 0.2, linkTo: 'pg_1_l3' },
        { lineId: 'pg_1_l5', x: 0.6, y: 0.8, w: 0.2, linkTo: 'pg_1_l4' }
      ]
    };
    expect([...lineChainHeads(chain)]).toEqual([
      ['pg_1_l3', 'pg_1_l3'],
      ['pg_1_l4', 'pg_1_l3'],
      ['pg_1_l5', 'pg_1_l3']
    ]);
    // A link to a line that is not on the page is ignored; a malformed cycle still resolves the same way every run.
    expect(lineChainHeads({ ...page, balloons: [{ lineId: 'pg_1_l1', x: 0, y: 0, w: 0.2, linkTo: 'pg_9_l1' }] }).size).toBe(0);
    const cycle = { ...page, balloons: [{ lineId: 'pg_1_l3', x: 0, y: 0, w: 0.2, linkTo: 'pg_1_l4' }, { lineId: 'pg_1_l4', x: 0, y: 0, w: 0.2, linkTo: 'pg_1_l3' }] };
    expect([...lineChainHeads(cycle)]).toEqual([
      ['pg_1_l3', 'pg_1_l3'],
      ['pg_1_l4', 'pg_1_l3']
    ]);
    expect(lineChainHeads(page).size).toBe(0);
  });
});
