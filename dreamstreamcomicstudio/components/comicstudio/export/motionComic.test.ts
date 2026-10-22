import { describe, expect, it } from 'vitest';
import { emptyRender, type ComicDoc } from '../../../shared/comic/doc';
import { makeSampleDoc } from '../board/__fixtures__/sampleDoc';
import { buildMotionTimeline, cameraRect, kenBurns, pickRecorderMime, readMs } from './motionComic';

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
