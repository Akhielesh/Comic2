import { describe, expect, it, vi } from 'vitest';
import { LETTERING } from '../board/balloonGeometry';
import { makeSampleDoc } from '../board/__fixtures__/sampleDoc';
import { MAX_EXPORT_EDGE, drawCanvasBalloons, fontFor, planCanvasBalloons, rasterSize } from './rasterize';

const measure = (text: string, fontPx: number) => text.length * fontPx * 0.55;

describe('rasterSize', () => {
  it('keeps the art’s resolution by default and scales to a long edge on request', () => {
    expect(rasterSize(1000, 1500)).toEqual({ width: 1000, height: 1500 });
    expect(rasterSize(1000, 1500, 3000)).toEqual({ width: 2000, height: 3000 });
    expect(rasterSize(1500, 1000, 750)).toEqual({ width: 750, height: 500 });
  });

  it('never exceeds the canvas limit', () => {
    const s = rasterSize(6000, 9000);
    expect(Math.max(s.width, s.height)).toBe(MAX_EXPORT_EDGE);
  });
});

describe('planCanvasBalloons', () => {
  it('plans every lettered line with the board’s metrics', () => {
    const doc = makeSampleDoc();
    const plans = planCanvasBalloons(doc, doc.pages[0], 1000, 1500, measure);
    expect(plans.map((p) => p.lineId)).toEqual(['pg_1_l1', 'pg_1_l2', 'pg_1_l3', 'pg_1_l4', 'pg_1_l5']);
    const caption = plans[0];
    expect(caption.x).toBeCloseTo(40, 5);
    expect(caption.y).toBeCloseTo(60, 5);
    expect(caption.w).toBeCloseTo(300, 5);
    expect(caption.fontPx).toBeCloseTo(1000 * LETTERING.fontScale * 0.95, 2);
    expect(caption.padX).toBeCloseTo(15, 5);
    expect(caption.shape.fill).toBe(LETTERING.captionFill);
    expect(caption.lines.join(' ')).toBe('OLD DELHI. BEFORE THE HEAT.');
    // Height follows the wrapped text.
    expect(caption.h).toBeCloseTo(caption.lines.length * caption.lineHeightPx + 2 * caption.padY, 5);
  });

  it('wraps lines inside the balloon’s inner width', () => {
    const doc = makeSampleDoc();
    const plans = planCanvasBalloons(doc, doc.pages[0], 1000, 1500, measure);
    plans
      .filter((p) => p.kind !== 'sfx')
      .forEach((p) => p.lines.forEach((line) => expect(measure(line, p.fontPx)).toBeLessThanOrEqual(p.w - 2 * p.padX + 1e-6)));
  });

  it('gives speech a tail and sfx a color', () => {
    const doc = makeSampleDoc();
    const plans = planCanvasBalloons(doc, doc.pages[0], 1000, 1500, measure);
    expect(plans.find((p) => p.lineId === 'pg_1_l4')!.shape.tail).toBeTruthy();
    expect(plans.find((p) => p.lineId === 'pg_1_l5')!.sfx?.color).toMatch(/^#/);
  });

  it('plans nothing for in-art lettering', () => {
    const doc = makeSampleDoc((d) => (d.format.lettering = 'in_art'));
    expect(planCanvasBalloons(doc, doc.pages[0], 1000, 1500, measure)).toEqual([]);
  });
});

describe('drawCanvasBalloons', () => {
  const fakeCtx = () => {
    const calls: { name: string; args: unknown[] }[] = [];
    const record = (name: string) => (...args: unknown[]) => calls.push({ name, args });
    const ctx = {
      save: record('save'),
      restore: record('restore'),
      translate: record('translate'),
      rotate: record('rotate'),
      fill: record('fill'),
      stroke: record('stroke'),
      beginPath: record('beginPath'),
      arc: record('arc'),
      setLineDash: record('setLineDash'),
      fillText: record('fillText'),
      strokeText: record('strokeText'),
      measureText: (t: string) => ({ width: t.length * 10 })
    } as unknown as CanvasRenderingContext2D;
    return { ctx, calls };
  };

  it('draws outlines, then the text, for every balloon', () => {
    const doc = makeSampleDoc();
    const plans = planCanvasBalloons(doc, doc.pages[0], 1000, 1500, measure);
    const { ctx, calls } = fakeCtx();
    const makePath = vi.fn((d: string) => ({ d }) as unknown as Path2D);
    drawCanvasBalloons(ctx, plans, makePath);
    const texts = calls.filter((c) => c.name === 'fillText').map((c) => c.args[0]);
    plans.forEach((p) => p.lines.forEach((line) => expect(texts).toContain(line)));
    expect(calls.filter((c) => c.name === 'strokeText').length).toBeGreaterThan(0); // sfx outline
    expect(makePath).toHaveBeenCalledWith(plans[1].shape.body);
    expect(calls.filter((c) => c.name === 'save').length).toBe(plans.length);
    expect(calls.filter((c) => c.name === 'restore').length).toBe(plans.length);
  });

  it('uses the lettering fonts', () => {
    expect(fontFor('speech', 20)).toBe('700 20px "Comic Neue", "Comic Sans MS", cursive');
    expect(fontFor('whisper', 20)).toMatch(/^italic 700/);
    expect(fontFor('sfx', 40)).toMatch(/Bangers/);
  });
});
