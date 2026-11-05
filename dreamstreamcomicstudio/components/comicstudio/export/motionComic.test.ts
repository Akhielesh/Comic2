import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { emptyRender, type Box, type ComicDoc, type Page, type Panel } from '../../../shared/comic/doc';
import { makeSampleDoc } from '../board/__fixtures__/sampleDoc';
import { guidedStops } from '../immersive/guidedModel';
import type { ReaderItem } from '../reader/readerModel';
import { PLATE_COLORS } from '../timeline/plates';
import { fakeContext } from './__fixtures__/fakeCanvas';
import { makeBook } from './__fixtures__/books';
import {
  buildMotionTimeline,
  cameraRect,
  centeredText,
  keepShots,
  kenBurns,
  MOTION_COLOR_TOKENS,
  MOTION_EXPORT_EVENT,
  motionExportEvent,
  motionPalette,
  panelHoldMs,
  pickRecorderMime,
  readMs,
  SHOT_MIN_HOLD_MS,
  type MotionExportStats,
  type MotionShot
} from './motionComic';

const drawn = (mutate?: (d: ComicDoc) => void): ComicDoc =>
  makeSampleDoc((d) => {
    d.cover = { ...d.cover, render: { ...emptyRender(), status: 'ready', asset: { path: 'cover.webp', source: 'generated', at: 1 } } };
    d.pages = d.pages.map((p) => ({ ...p, render: { ...emptyRender(), status: 'ready', asset: { path: `p${p.n}.webp`, source: 'generated', at: 1 } } }));
    mutate?.(d);
  });

describe('motion comic timeline', () => {
  it('cover → (page overview → panels)* → outro, contiguous, pages in book order', () => {
    const doc = drawn();
    const { shots, totalMs } = buildMotionTimeline(doc);
    expect(shots[0].kind).toBe('cover');
    expect(shots[shots.length - 1].kind).toBe('outro');
    const pages = shots.filter((s) => s.kind === 'page').map((s) => s.pageId);
    expect(pages).toEqual([...doc.pages].sort((a, b) => a.n - b.n).map((p) => p.id));
    for (let i = 1; i < shots.length; i += 1) expect(shots[i].startMs).toBe(shots[i - 1].startMs + shots[i - 1].durationMs);
    expect(totalMs).toBe(shots[shots.length - 1].startMs + shots[shots.length - 1].durationMs);
    expect(shots.filter((s) => s.kind === 'panel')).toHaveLength(doc.pages.reduce((n, p) => n + p.panels.length, 0));
  });

  it('reveals overlay balloons at reading speed and keeps earlier ones on screen', () => {
    const doc = drawn((d) => (d.format.lettering = 'overlay'));
    const { shots } = buildMotionTimeline(doc);
    const page = doc.pages[0];
    const panelShots = shots.filter((s) => s.kind === 'panel' && s.pageId === page.id);
    const firstWithLines = panelShots.findIndex((s) => s.reveals.length);
    expect(firstWithLines).toBeGreaterThanOrEqual(0);
    const shot = panelShots[firstWithLines];
    shot.reveals.forEach((r, i) => i && expect(r.atMs).toBeGreaterThan(shot.reveals[i - 1].atMs));
    const later = panelShots[firstWithLines + 1];
    if (later) expect(later.carried).toEqual(expect.arrayContaining(shot.reveals.map((r) => r.lineId)));
    expect(shot.durationMs).toBeGreaterThanOrEqual(1800);
  });

  it('in-art pages hold panels without overlay reveals; undrawn pages are skipped', () => {
    const doc = drawn((d) => {
      d.format.lettering = 'in_art';
      d.pages[1] = { ...d.pages[1], render: emptyRender() };
    });
    const { shots } = buildMotionTimeline(doc);
    expect(shots.every((s) => s.reveals.length === 0)).toBe(true);
    expect(shots.some((s) => s.pageId === doc.pages[1].id)).toBe(false);
  });

  it('shows the book plates as title cards in book order', () => {
    const doc = makeBook();
    const kinds = buildMotionTimeline(doc).shots.filter((s) => s.kind !== 'panel').map((s) => (s.kind === 'plate' ? `plate:${s.plate}` : s.kind));
    expect(kinds).toEqual(['cover', 'plate:title', 'page', 'page', 'plate:end', 'plate:back_cover', 'outro']);
    expect(buildMotionTimeline(doc, { plates: false }).shots.some((s) => s.kind === 'plate')).toBe(false);
  });

  it('never shows withheld art', () => {
    const doc = drawn((d) => {
      d.pages[0].render.asset = { ...d.pages[0].render.asset!, safety: { assessed: 'X', at: 1 } };
      d.cover.render.asset = { ...d.cover.render.asset!, safety: { quarantined: true, at: 1 } };
    });
    const { shots } = buildMotionTimeline(doc);
    expect(shots.some((s) => s.kind === 'cover')).toBe(false);
    expect(shots.some((s) => s.pageId === doc.pages[0].id)).toBe(false);
  });

  it('drops the shots of art that did not load and re-times the rest back to back', () => {
    const doc = drawn();
    const full = buildMotionTimeline(doc);
    const gone = doc.pages[0].id;
    const kept = keepShots(full, (s) => s.pageId !== gone && s.kind !== 'cover');
    expect(kept.shots.some((s) => s.pageId === gone || s.kind === 'cover')).toBe(false);
    expect(kept.shots[0].startMs).toBe(0);
    for (let i = 1; i < kept.shots.length; i += 1) expect(kept.shots[i].startMs).toBe(kept.shots[i - 1].startMs + kept.shots[i - 1].durationMs);
    const dropped = full.shots.filter((s) => s.pageId === gone || s.kind === 'cover').reduce((ms, s) => ms + s.durationMs, 0);
    expect(kept.totalMs).toBe(full.totalMs - dropped);
  });

  it('reading time grows with words but never drops under a beat', () => {
    expect(readMs('Hi')).toBe(650);
    expect(readMs('one two three four five six seven eight nine ten eleven twelve')).toBeGreaterThan(3000);
  });
});

describe('camera', () => {
  it('frames a panel at the output aspect, expanded not cropped, and kept on the page', () => {
    const r = cameraRect({ x: 0.05, y: 0.05, w: 0.4, h: 0.2 }, 1000, 1500, 9 / 16, 0);
    expect(r.w / r.h).toBeCloseTo(9 / 16, 5);
    expect(r.w).toBeGreaterThanOrEqual(400 - 1e-6);
    expect(r.h).toBeGreaterThanOrEqual(300 - 1e-6);
    expect(r.x).toBeGreaterThanOrEqual(0);
    expect(r.y).toBeGreaterThanOrEqual(0);
    expect(r.y + r.h).toBeLessThanOrEqual(1500 + 1e-6);
  });

  it('centres frames larger than the page', () => {
    const r = cameraRect({ x: 0, y: 0, w: 1, h: 1 }, 1000, 1500, 16 / 9, 0);
    expect(r.x).toBeLessThan(0);
    expect(r.x + r.w / 2).toBeCloseTo(500, 5);
  });

  it('Ken Burns pushes in around the centre', () => {
    const r = kenBurns({ x: 0, y: 0, w: 100, h: 200 }, 1, 0.1);
    expect(r).toEqual({ x: 5, y: 10, w: 90, h: 180 });
  });
});

describe('recorder format', () => {
  it('prefers MP4 and falls back to WebM, or reports no support', () => {
    expect(pickRecorderMime((m) => m.startsWith('video/mp4'))?.ext).toBe('mp4');
    expect(pickRecorderMime((m) => m === 'video/webm;codecs=vp9')).toEqual({ mime: 'video/webm;codecs=vp9', ext: 'webm' });
    expect(pickRecorderMime(() => false)).toBeNull();
  });
});

describe('title card text', () => {
  it('wraps with the script-aware wrapper and sets the direction', () => {
    const f = fakeContext(1080, 1920);
    const end = centeredText(f.ctx, 'سلام دوست چلو چاند تک چلیں', 'ur', 540, 100, 120, 50);
    const lines = f.calls.filter((c) => c.name === 'fillText');
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.every((c) => c.state.direction === 'rtl' && c.state.textAlign === 'center')).toBe(true);
    expect(end).toBe(100 + lines.length * 50);
    const te = fakeContext();
    centeredText(te.ctx, 'కుంకుమపువ్వు దొంగ', 'te', 500, 0, 130, 40);
    // Never breaks inside a word / syllable: every drawn line is made of whole words.
    for (const c of te.calls.filter((x) => x.name === 'fillText')) for (const w of String(c.args[0]).split(' ')) expect(['కుంకుమపువ్వు', 'దొంగ']).toContain(w);
  });
});

// ── AV-0 (av.md §7; F4, F5, F9, F10) ────────────────────────────────────────

/** The reader's item for a page (what Guided View walks). */
const itemOf = (p: Page): ReaderItem => ({ key: p.id, kind: 'page', label: `Page ${p.n}`, asset: p.render.asset!, page: p });

/** Panel numbers of one page's panel shots, in the order the video plays them. */
const playedOrder = (shots: MotionShot[], pageId: string): number[] => shots.filter((s) => s.kind === 'panel' && s.pageId === pageId).map((s) => s.panelN!);

/** Panel numbers in Guided View's stop order for the same page. */
const guidedOrder = (doc: ComicDoc, page: Page): number[] =>
  guidedStops(doc, itemOf(page), 0, { overview: false }).map((stop) => page.panels[stop.panelIndex].n);

const measured = (p: Page, boxes: Box[]): Page => ({ ...p, render: { ...p.render, qc: { score: 0.9, issues: [], checkedAt: 1, panelBoxes: boxes, boxesFrom: 'vision' } } });

/**
 * The RTL fixture: a right-to-left (manga) book, overlay-lettered, whose drawn pages came out in another arrangement
 * than the script's panel numbers (the vision pass measured them). Page 1: panel 1 runs along the BOTTOM, panels 2
 * and 3 share the top row with 2 on the left — a manga reader reads 3, 2, 1. Page 5: panels 1 (left) and 2 (right)
 * on top, 3 below — read 2, 1, 3. Written order would be 1, 2, 3 on both.
 */
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

describe('panel order follows the page as read (AV-0, F4)', () => {
  it('the RTL fixture plays every page in exactly the Guided View stops, not the written order', () => {
    const doc = rtlBook();
    const { shots } = buildMotionTimeline(doc);
    const pages = doc.pages.filter((p) => shots.some((s) => s.kind === 'page' && s.pageId === p.id));
    expect(pages.length).toBeGreaterThanOrEqual(2);
    for (const page of pages) expect(playedOrder(shots, page.id), page.id).toEqual(guidedOrder(doc, page));
    // Not vacuous: the written order differs on both measured pages.
    expect(playedOrder(shots, 'pg_1')).toEqual([3, 2, 1]);
    expect(playedOrder(shots, 'pg_5')).toEqual([2, 1, 3]);
  });

  it('frames each panel by its own box and carries the balloons revealed earlier in READING order', () => {
    const doc = rtlBook();
    const page = doc.pages.find((p) => p.id === 'pg_1')!;
    const shots = buildMotionTimeline(doc).shots.filter((s) => s.kind === 'panel' && s.pageId === page.id);
    const boxes = page.render.qc!.panelBoxes!;
    for (const shot of shots) expect(shot.box).toEqual(boxes[page.panels.findIndex((p) => p.n === shot.panelN)]);
    // Panel 3 plays first, so its lines are already on screen when panel 2 and panel 1 play.
    const first = shots[0];
    expect(first.panelN).toBe(3);
    expect(first.carried).toEqual([]);
    const p3Lines = first.reveals.map((r) => r.lineId);
    expect(p3Lines.length).toBeGreaterThan(0);
    expect(shots[1].carried).toEqual(p3Lines);
    expect(shots[2].carried).toEqual(expect.arrayContaining([...p3Lines, ...shots[1].reveals.map((r) => r.lineId)]));
  });

  it('an LTR drawing whose panels came out rearranged also plays as drawn (same rule as the reader)', () => {
    const doc = drawn((d) => {
      d.pages = d.pages.map((p) =>
        p.id === 'pg_1'
          ? measured(p, [
              { x: 0.04, y: 0.52, w: 0.92, h: 0.44 },
              { x: 0.04, y: 0.04, w: 0.44, h: 0.44 },
              { x: 0.52, y: 0.04, w: 0.44, h: 0.44 }
            ])
          : p
      );
    });
    const { shots } = buildMotionTimeline(doc);
    const page = doc.pages.find((p) => p.id === 'pg_1')!;
    expect(playedOrder(shots, 'pg_1')).toEqual([2, 3, 1]);
    expect(playedOrder(shots, 'pg_1')).toEqual(guidedOrder(doc, page));
  });
});

describe('every panel holds at least its shot (AV-0, F5)', () => {
  const onePanel = (patch: Partial<Panel>) =>
    drawn((d) => {
      d.pages = d.pages.map((p) => (p.id === 'pg_1' ? { ...p, panels: [{ ...p.panels[0], ...patch }] } : p));
    });
  const panelShot = (doc: ComicDoc, opts = {}) => buildMotionTimeline(doc, opts).shots.find((s) => s.kind === 'panel' && s.pageId === 'pg_1')!;

  it('a silent establishing panel lasts at least 3.5 s (today: 1.8 s, a blink)', () => {
    const shot = panelShot(onePanel({ shot: 'establishing', size: 'wide', lines: [] }));
    expect(shot.reveals).toEqual([]);
    expect(shot.durationMs).toBeGreaterThanOrEqual(3500);
  });

  it('big panels add a beat; a silent insert stays a quick beat; the old flat floor is one option away', () => {
    expect(panelShot(onePanel({ shot: 'establishing', size: 'splash', lines: [] })).durationMs).toBeGreaterThanOrEqual(4500);
    expect(panelShot(onePanel({ shot: 'insert', size: 'small', lines: [] })).durationMs).toBe(1800);
    expect(panelShot(onePanel({ shot: 'establishing', size: 'wide', lines: [] }), { shotHolds: false }).durationMs).toBe(1800);
    expect(panelHoldMs({ shot: 'wide', size: 'large' })).toBe(SHOT_MIN_HOLD_MS.wide + 1000);
    // A stored doc with an unknown shot reads as a medium shot, never NaN.
    expect(panelHoldMs({ shot: 'dutch' as Panel['shot'], size: 'medium' })).toBe(SHOT_MIN_HOLD_MS.medium);
  });

  it('speech is never slowed and the cap still holds: reading time wins when the lines need longer', () => {
    const long = Array.from({ length: 20 }, (_, i) => `word${i}`).join(' '); // ≈ 5.7 s to read: above the 3.5 s hold, under the cap
    const spoken = panelShot(onePanel({ shot: 'establishing', size: 'small', lines: [{ id: 'lx', kind: 'speech', text: long }] }));
    expect(spoken.durationMs).toBe(450 + readMs(long) + 500);
    const huge = Array.from({ length: 60 }, (_, i) => `word${i}`).join(' ');
    expect(panelShot(onePanel({ shot: 'establishing', size: 'splash', lines: [{ id: 'ly', kind: 'speech', text: huge }] })).durationMs).toBe(7500);
  });
});

describe('the outro card is switchable (AV-0; owner decision D17)', () => {
  it('on by default, gone with outro: false, and the video ends on the last page instead', () => {
    const doc = drawn();
    const withOutro = buildMotionTimeline(doc);
    const without = buildMotionTimeline(doc, { outro: false });
    expect(withOutro.shots[withOutro.shots.length - 1].kind).toBe('outro');
    expect(without.shots.some((s) => s.kind === 'outro')).toBe(false);
    expect(without.totalMs).toBe(withOutro.totalMs - 2200);
  });
});

describe('design tokens, not literals (AV-0, F9)', () => {
  it('motionComic.ts spells no colour: no hex and no rgb() literal', () => {
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'motionComic.ts'), 'utf8');
    expect(source.match(/#[0-9a-f]{3,8}\b/gi) ?? []).toEqual([]);
    expect(source.match(/rgba?\(\s*\d/gi) ?? []).toEqual([]);
  });

  it('paints with the reader-room tokens, and falls back to the plate palette without a stylesheet', () => {
    const seen: string[] = [];
    const palette = motionPalette((name) => {
      seen.push(name);
      return name === MOTION_COLOR_TOKENS.room ? 'rgb(1 2 3)' : 'rgb(4 5 6)';
    });
    expect(seen).toEqual(['--ds-reader-room', '--ds-reader-paper-back']);
    expect(palette).toEqual({ room: 'rgb(1 2 3)', paper: 'rgb(4 5 6)' });
    expect(motionPalette(() => '')).toEqual({ room: PLATE_COLORS.ink, paper: PLATE_COLORS.paper });
  });
});

describe('telemetry event (AV-0, F10)', () => {
  const stats: MotionExportStats = {
    aspect: '9:16',
    stage: 'done',
    engine: 'webcodecs',
    videoMs: 61_000,
    pages: 2,
    panels: 6,
    skipped: 1,
    rtl: true,
    overlay: true,
    edition: false,
    outro: true,
    fontFallback: false
  };

  it('is one fixed event type from the comic studio, with counts, timings and enums only', () => {
    const ev = motionExportEvent('done', stats, 1234.6);
    expect(ev.eventType).toBe(MOTION_EXPORT_EVENT);
    expect(ev.source).toBe('comic_studio');
    expect(ev.severity).toBe('info');
    expect(ev.metadata).toEqual({ outcome: 'done', ...stats, elapsedMs: 1235 });
    for (const [key, value] of Object.entries(ev.metadata!)) {
      expect(['number', 'boolean', 'string'], key).toContain(typeof value);
      if (typeof value === 'string') expect(value, key).toMatch(/^[a-z0-9:_-]+$/);
    }
    expect(motionExportEvent('failed', { ...stats, stage: 'loading' }, 5).severity).toBe('warn');
    expect(motionExportEvent('cancelled', stats, 5).message).toBe('Motion comic export cancelled');
  });
});
