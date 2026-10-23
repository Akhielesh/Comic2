import { describe, expect, it } from 'vitest';
import { emptyRender, type ComicDoc } from '../../../shared/comic/doc';
import { makeSampleDoc } from '../board/__fixtures__/sampleDoc';
import { fakeContext } from './__fixtures__/fakeCanvas';
import { makeBook } from './__fixtures__/books';
import { buildMotionTimeline, cameraRect, centeredText, keepShots, kenBurns, pickRecorderMime, readMs } from './motionComic';

const drawn = (mutate?: (d: ComicDoc) => void): ComicDoc =>
  makeSampleDoc((d) => {
    d.cover = { ...d.cover, render: { ...emptyRender(), status: 'ready', asset: { path: 'cover.webp', source: 'generated', at: 1 } } };
    d.pages = d.pages.map((p) => ({ ...p, render: { ...emptyRender(), status: 'ready', asset: { path: `p${p.n}.webp`, source: 'generated', at: 1 } } }));
    mutate?.(d);
  });

describe('motion comic timeline', () => {
  it('cover → (page overview → panels)* → outro, contiguous and in reading order', () => {
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
