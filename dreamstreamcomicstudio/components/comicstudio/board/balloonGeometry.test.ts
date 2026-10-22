import { describe, expect, it } from 'vitest';
import type { Balloon, Page } from '../../../shared/comic/doc';
import {
  LETTERING,
  balloonFontPx,
  balloonShape,
  balloonWidthForText,
  burstPoints,
  clamp,
  clampBalloon,
  cloudPath,
  fitBalloonOnPage,
  KIND_FONT_SCALE,
  outlineBounds,
  defaultTailTip,
  estimateBalloonHeight,
  fitOutlineScale,
  insideBody,
  letteringText,
  resolveBalloons,
  sfxFontPx,
  sfxStyle,
  speechBodyPath,
  strokePx,
  superellipsePoints,
  tailPath,
  tailTipOf,
  thoughtBubbles,
  wrapBalanced,
  wrapText
} from './balloonGeometry';
import { estimatePanelBoxes } from './pageLayout';
import { makeSampleDoc } from './__fixtures__/sampleDoc';

describe('font size', () => {
  it('scales with the rendered page width (≈1.7%)', () => {
    expect(balloonFontPx(600)).toBeCloseTo(10.2, 5);
    expect(balloonFontPx(1200)).toBeCloseTo(20.4, 5);
  });

  it('never goes below a readable minimum', () => {
    expect(balloonFontPx(200)).toBe(LETTERING.minFontPx);
    expect(balloonFontPx(0)).toBe(LETTERING.minFontPx);
  });

  it('weights kinds: shouts bigger, whispers smaller, sfx display-sized', () => {
    expect(balloonFontPx(800, 'shout')).toBeGreaterThan(balloonFontPx(800, 'speech'));
    expect(balloonFontPx(800, 'whisper')).toBeLessThan(balloonFontPx(800, 'speech'));
    expect(balloonFontPx(800, 'sfx')).toBeCloseTo(800 * 0.017 * 2.4, 1);
  });

  it('fits a sound effect to its box', () => {
    const roomy = sfxFontPx('POW', 200, 800);
    const cramped = sfxFontPx('KRAKATHOOOOOM', 60, 800);
    expect(roomy).toBeCloseTo(balloonFontPx(800, 'sfx'), 1);
    expect(cramped).toBeLessThan(roomy);
    expect(cramped).toBeGreaterThanOrEqual(LETTERING.minFontPx);
  });

  it('stroke scales with the page but stays visible', () => {
    expect(strokePx(100)).toBe(LETTERING.minStrokePx);
    expect(strokePx(1000)).toBeCloseTo(2.8, 5);
  });
});

describe('clamp', () => {
  it('clamps numbers and treats NaN as the lower bound', () => {
    expect(clamp(5, 0, 1)).toBe(1);
    expect(clamp(-1, 0, 1)).toBe(0);
    expect(clamp(Number.NaN, 0.2, 1)).toBe(0.2);
  });

  it('keeps a balloon on the page with a sane width', () => {
    const b = clampBalloon({ lineId: 'l', x: 0.95, y: 1.4, w: 0.3, tailX: 1.6, tailY: -2 });
    expect(b.w).toBe(0.3);
    expect(b.x).toBeCloseTo(0.7, 5);
    expect(b.y).toBe(0.99);
    expect(b.tailX).toBe(1);
    expect(b.tailY).toBe(0);
  });

  it('drops half-specified tails and enforces width bounds', () => {
    const b = clampBalloon({ lineId: 'l', x: 0, y: 0, w: 0.001, tailX: 0.5 } as Balloon);
    expect(b.w).toBe(LETTERING.minW);
    expect('tailX' in b).toBe(false);
    expect(clampBalloon({ lineId: 'l', x: 0, y: 0, w: 3 }).w).toBe(LETTERING.maxW);
  });
});

describe('sizing mirrors the server', () => {
  it('widens with text length within 0.16–0.34', () => {
    expect(balloonWidthForText('Hi')).toBe(0.16);
    expect(balloonWidthForText('x'.repeat(200))).toBe(0.34);
    const mid = balloonWidthForText('This is a medium length line of dialogue, okay?');
    expect(mid).toBeGreaterThan(0.16);
    expect(mid).toBeLessThan(0.34);
  });

  it('estimates height from wrapped lines (page-height fraction)', () => {
    const one = estimateBalloonHeight('Hi there', 0.2, 2 / 3);
    expect(one).toBeCloseTo((LETTERING.lineH + LETTERING.padH) * (2 / 3), 4);
    const many = estimateBalloonHeight('word '.repeat(40), 0.2, 2 / 3);
    expect(many).toBeGreaterThan(one * 3);
  });
});

describe('text', () => {
  it('letters in uppercase, locale-aware', () => {
    expect(letteringText('  hello   there ')).toBe('HELLO THERE');
    expect(letteringText('istanbul', 'tr')).toBe('İSTANBUL');
    expect(letteringText('こんにちは', 'ja')).toBe('こんにちは');
  });

  it('survives an invalid language tag', () => {
    expect(letteringText('ok', 'not a locale!!')).toBe('OK');
  });

  it('wraps greedily and breaks words longer than a line', () => {
    const measure = (s: string) => s.length * 10;
    expect(wrapText('aa bb cc dd', 50, measure)).toEqual(['aa bb', 'cc dd']);
    expect(wrapText('abcdefghij', 40, measure)).toEqual(['abcd', 'efgh', 'ij']);
    expect(wrapText('   ', 40, measure)).toEqual([]);
  });

  it('balances lines without adding any', () => {
    const measure = (s: string) => s.length * 10;
    const text = 'one two three four five six seven';
    const greedy = wrapText(text, 200, measure);
    const balanced = wrapBalanced(text, 200, measure);
    expect(balanced.length).toBe(greedy.length);
    const spread = (lines: string[]) => Math.max(...lines.map((l) => l.length)) - Math.min(...lines.map((l) => l.length));
    expect(spread(balanced)).toBeLessThanOrEqual(spread(greedy));
  });
});

describe('shapes', () => {
  it('builds a closed smooth speech outline that bleeds slightly past the text box', () => {
    const d = speechBodyPath(200, 60);
    expect(d.startsWith('M')).toBe(true);
    expect(d.endsWith('Z')).toBe(true);
    const pts = superellipsePoints(200, 60);
    expect(Math.max(...pts.map((p) => p.x))).toBeGreaterThan(200);
    expect(Math.min(...pts.map((p) => p.y))).toBeLessThan(0);
  });

  it('grows the outline just enough to keep tall text blocks clear of it', () => {
    const base = { x: 1.04, y: 1.1 };
    // A one-liner keeps the base bleed.
    expect(fitOutlineScale(120, 34, 3, base, { x: 10, y: 9 })).toEqual(base);
    // A full four-line block needs more room; its corners end up inside with margin.
    const inset = { x: 10, y: 9 };
    const w = 240;
    const h = 80;
    const s = fitOutlineScale(w, h, 3, base, inset);
    expect(s.x).toBeGreaterThan(base.x);
    expect(s.y / s.x).toBeCloseTo(base.y / base.x, 6);
    const rx = 1 - (2 * inset.x) / w;
    const ry = 1 - (2 * inset.y) / h;
    expect((rx / s.x) ** 3 + (ry / s.y) ** 3).toBeLessThanOrEqual(0.86 + 1e-9);
  });

  it('points the tail at the tip and omits it when the tip is inside the balloon', () => {
    expect(tailPath(200, 60, { x: 100, y: 30 })).toBeNull();
    expect(insideBody(200, 60, { x: 100, y: 30 })).toBe(true);
    const d = tailPath(200, 60, { x: 120, y: 160 })!;
    expect(d).toContain('120 160');
    expect(d.startsWith('M')).toBe(true);
    expect(tailPath(200, 60, { x: 120, y: 160 }, 'straight')).toMatch(/^M[^Q]+L120 160L/);
  });

  it('makes a deterministic spiky burst with spikes outside the box', () => {
    const a = burstPoints(200, 80, 42);
    const b = burstPoints(200, 80, 42);
    expect(a).toEqual(b);
    expect(a.length % 2).toBe(0);
    expect(a.length).toBeGreaterThanOrEqual(24);
    expect(Math.max(...a.map((p) => p.x))).toBeGreaterThan(200);
    expect(burstPoints(200, 80, 7)).not.toEqual(a);
  });

  it('scallops thought clouds and trails shrinking bubbles to the tip', () => {
    expect(cloudPath(160, 60, 3)).toContain('Q');
    const bubbles = thoughtBubbles(160, 60, { x: 80, y: 200 });
    expect(bubbles.length).toBe(3);
    expect(bubbles[0].r).toBeGreaterThan(bubbles[1].r);
    expect(bubbles[1].r).toBeGreaterThan(bubbles[2].r);
    expect(bubbles[2].cy).toBeGreaterThan(bubbles[0].cy);
    expect(thoughtBubbles(160, 60, { x: 80, y: 30 })).toEqual([]);
  });

  it('describes each kind', () => {
    const tip = { x: 100, y: 150 };
    const speech = balloonShape('speech', 200, 60, { tip });
    expect(speech.body).toBeTruthy();
    expect(speech.tail).toBeTruthy();
    expect(speech.dashed).toBe(false);
    expect(balloonShape('whisper', 200, 60, { tip }).dashed).toBe(true);
    const caption = balloonShape('caption', 200, 60, { tip });
    expect(caption.fill).toBe(LETTERING.captionFill);
    expect(caption.tail).toBeUndefined();
    expect(balloonShape('sfx', 200, 60, { tip }).body).toBeUndefined();
    expect(balloonShape('thought', 200, 60, { tip }).bubbles.length).toBeGreaterThan(0);
    expect(balloonShape('shout', 200, 60, { tip, seed: 1 }).tail).toMatch(/L/);
    expect(balloonShape('speech', 200, 60).tail).toBeUndefined();
  });

  it('colors and tilts sound effects deterministically', () => {
    const s = sfxStyle('line_1');
    expect(sfxStyle('line_1')).toEqual(s);
    expect(s.rotate).toBeGreaterThanOrEqual(-6);
    expect(s.rotate).toBeLessThanOrEqual(6);
    expect(s.color).toMatch(/^#[0-9a-f]{6}$/);
  });
});

describe('tails', () => {
  it('uses the explicit tip, else a default just below the balloon', () => {
    const b: Balloon = { lineId: 'l', x: 0.1, y: 0.1, w: 0.2 };
    expect(tailTipOf({ ...b, tailX: 0.5, tailY: 0.6 }, 'speech', 0.05)).toEqual({ tailX: 0.5, tailY: 0.6 });
    const def = tailTipOf(b, 'speech', 0.05)!;
    expect(def).toEqual(defaultTailTip(b, 0.05));
    expect(def.tailY).toBeGreaterThan(0.15);
    expect(tailTipOf(b, 'caption', 0.05)).toBeNull();
    expect(tailTipOf(b, 'sfx', 0.05)).toBeNull();
  });
});

describe('resolveBalloons', () => {
  it('returns every non-empty line in reading order with its balloon', () => {
    const doc = makeSampleDoc();
    const page = doc.pages[0];
    const out = resolveBalloons(doc, page);
    expect(out.map((r) => r.line.id)).toEqual(['pg_1_l1', 'pg_1_l2', 'pg_1_l3', 'pg_1_l4', 'pg_1_l5']);
    expect(out.map((r) => r.panelN)).toEqual([1, 2, 3, 3, 3]);
    expect(out.find((r) => r.line.id === 'pg_1_l3')!.balloon.pinned).toBe(true);
  });

  it('places lines without a balloon inside their panel, at the top, with a tail', () => {
    const doc = makeSampleDoc();
    const page = doc.pages[0];
    const fallback = resolveBalloons(doc, page).find((r) => r.line.id === 'pg_1_l4')!;
    expect(fallback.fallback).toBe(true);
    const box = estimatePanelBoxes(page)[2];
    const b = fallback.balloon;
    expect(b.x).toBeGreaterThanOrEqual(box.x);
    expect(b.x + b.w).toBeLessThanOrEqual(box.x + box.w + 1e-6);
    expect(b.y).toBeGreaterThanOrEqual(box.y);
    expect(b.y).toBeLessThan(box.y + box.h / 2);
    expect(typeof b.tailX).toBe('number');
  });

  it('stacks several missing balloons in one panel without overlapping', () => {
    const doc = makeSampleDoc((d) => {
      d.pages[1].panels[2].lines.push({ id: 'extra_1', kind: 'speech', text: 'One more line here', speakerId: 'ch_maya' });
    });
    const page = doc.pages[1];
    const inPanel = resolveBalloons(doc, page).filter((r) => r.panelN === 3 && r.line.kind !== 'sfx');
    expect(inPanel.every((r) => r.fallback)).toBe(true);
    const ys = inPanel.map((r) => r.balloon.y);
    expect([...ys].sort((a, b) => a - b)).toEqual(ys);
    expect(new Set(ys).size).toBe(ys.length);
  });

  it('skips blank lines and ignores balloons for lines that no longer exist', () => {
    const doc = makeSampleDoc((d) => {
      d.pages[0].panels[0].lines[0].text = '   ';
      d.pages[0].balloons.push({ lineId: 'gone', x: 0.2, y: 0.2, w: 0.2 });
    });
    const ids = resolveBalloons(doc, doc.pages[0]).map((r) => r.line.id);
    expect(ids).not.toContain('pg_1_l1');
    expect(ids).not.toContain('gone');
  });

  it('puts fallback captions on the reading-start side (right for rtl)', () => {
    const doc = makeSampleDoc((d) => {
      d.format.readingDirection = 'rtl';
      d.pages[1].balloons = [] as Page['balloons'];
    });
    const caption = resolveBalloons(doc, doc.pages[1]).find((r) => r.line.kind === 'caption')!;
    expect(caption.balloon.x + caption.balloon.w).toBeGreaterThan(0.9);
  });
});

describe('render-time fit and page-wide placement (visualqa P0-3)', () => {
  it('fitBalloonOnPage keeps the OUTLINE on the page without touching stored values', () => {
    const m = 0.008;
    expect(fitBalloonOnPage({ x: 0.7, y: 0.92, w: 0.3 }, 'caption', 0.15, 0.8).y).toBeLessThanOrEqual(0.85 - m + 1e-9);
    expect(fitBalloonOnPage({ x: 0, y: 0.1, w: 0.3 }, 'thought', 0.1, 2 / 3).x).toBeGreaterThanOrEqual(0.3 * 0.08);
    const shout = fitBalloonOnPage({ x: 0.66, y: 0.3, w: 0.34 }, 'shout', 0.1, 2 / 3);
    expect(shout.x + shout.w + 0.12 * shout.w).toBeLessThanOrEqual(1 + 1e-9);
    const wide = fitBalloonOnPage({ x: 0, y: 0.3, w: 0.95 }, 'thought', 0.1, 2 / 3);
    expect(wide.w).toBeLessThan(0.95);
    expect(wide.crowded).toBe(true);
    const tail = fitBalloonOnPage({ x: 0.2, y: 0.2, w: 0.3, tailX: 1.4, tailY: -0.2 }, 'speech', 0.1, 2 / 3);
    expect(tail.tailX).toBe(1);
    expect(tail.tailY).toBe(0);
  });

  it('places fallback balloons around a stored balloon of ANOTHER panel sitting inside this panel', () => {
    const doc = makeSampleDoc((d) => {
      const page = d.pages[0];
      const box = estimatePanelBoxes(page)[2];
      // panel 2's balloon dragged over panel 3's top band
      page.balloons = [{ lineId: 'pg_1_l2', x: box.x + 0.02, y: box.y + 0.02, w: Math.min(0.4, box.w - 0.05), pinned: true }];
    });
    const page = doc.pages[0];
    const out = resolveBalloons(doc, page);
    const stored = out.find((r) => r.line.id === 'pg_1_l2')!;
    const storedBox = outlineBounds({ ...stored.balloon, h: estimateBalloonHeight(stored.line.text, stored.balloon.w, 2 / 3) }, 'whisper', 'squircle');
    for (const r of out.filter((x) => x.fallback && x.panelN === 3 && !x.crowded)) {
      const b = outlineBounds({ ...r.balloon, h: estimateBalloonHeight(r.line.text, r.balloon.w, 2 / 3) }, r.line.kind, r.line.kind === 'shout' ? 'burst' : r.line.kind === 'sfx' ? 'none' : 'squircle');
      const ix = Math.max(0, Math.min(b.x + b.w, storedBox.x + storedBox.w) - Math.max(b.x, storedBox.x));
      const iy = Math.max(0, Math.min(b.y + b.h, storedBox.y + storedBox.h) - Math.max(b.y, storedBox.y));
      expect(ix * iy).toBeLessThan(1e-6);
    }
  });

  it('flags crowded placements instead of silently overlapping', () => {
    const long = 'This is a very long line of dialogue that keeps going and going so that it fills the balloon completely and then some more.';
    const doc = makeSampleDoc((d) => {
      const panel = d.pages[0].panels[1];
      panel.lines = [0, 1, 2, 3].map((i) => ({ id: `long_${i}`, kind: 'speech' as const, speakerId: 'ch_maya', text: long }));
      d.pages[0].balloons = [];
    });
    const out = resolveBalloons(doc, doc.pages[0]).filter((r) => r.panelN === 2);
    expect(out).toHaveLength(4);
    // Every balloon is still drawn (no text lost) and fully on the page…
    for (const r of out) {
      expect(r.balloon.x).toBeGreaterThanOrEqual(0);
      expect(r.balloon.x + r.balloon.w).toBeLessThanOrEqual(1 + 1e-9);
    }
    // …and any that had to overlap are flagged for the editor's free fixes.
    const pairs: [number, number][] = [];
    for (let i = 0; i < out.length; i += 1) for (let j = i + 1; j < out.length; j += 1) pairs.push([i, j]);
    const overlap = pairs.some(([i, j]) => {
      const a = out[i].balloon;
      const b = out[j].balloon;
      const ha = estimateBalloonHeight(long, a.w, 2 / 3);
      const hb = estimateBalloonHeight(long, b.w, 2 / 3);
      return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + hb && b.y < a.y + ha;
    });
    if (overlap) expect(out.some((r) => r.crowded)).toBe(true);
  });

  it('re-exports the shared classic constants unchanged', () => {
    expect(KIND_FONT_SCALE).toEqual({ speech: 1, thought: 1, whisper: 0.94, shout: 1.08, caption: 0.95, sfx: 2.4 });
    expect(LETTERING.fontScale).toBe(0.017);
    expect(LETTERING.strokeScale).toBe(0.0028);
  });
});
