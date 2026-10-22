import { describe, expect, it } from 'vitest';
import { balloonShape, hashSeed as boardHashSeed, sfxStyle } from '../../../components/comicstudio/board/balloonGeometry';
import { makeSampleDoc } from '../../../components/comicstudio/board/__fixtures__/sampleDoc';
import { normalizeDoc, type ComicDoc, type Page } from '../doc';
import { applyTextCase, estimateMeasure, letteringAspect, letteringSizer, planLettering, planLetteringForPage, sfxAutoStyle, type Measure } from './layout';
import { FONT_REGISTRY } from './fonts';

const ASPECT = 2 / 3;
const H = 1000 / ASPECT;
/** Deterministic stand-in for canvas measureText: 0.6 em per grapheme at the font's px. */
const fixedMeasure: Measure = (text, font) => {
  const px = Number(/(\d+(?:\.\d+)?)px/.exec(font)?.[1] ?? 17);
  return Array.from(text).length * px * 0.6;
};

const sample = (mutate?: (doc: ComicDoc) => void) => {
  const doc = normalizeDoc(makeSampleDoc());
  mutate?.(doc);
  return { doc, page: doc.pages[0] };
};

describe('planLettering: the classic look', () => {
  it('plans every lettered line (stored + fallback) with classic numbers', () => {
    const { doc, page } = sample();
    const plans = planLettering(doc, page, ASPECT, fixedMeasure);
    expect(plans.map((p) => p.lineId).sort()).toEqual(['pg_1_l1', 'pg_1_l2', 'pg_1_l3', 'pg_1_l4', 'pg_1_l5']);
    const by = new Map(plans.map((p) => [p.lineId, p]));
    expect(by.get('pg_1_l4')!.fallback).toBe(true);
    expect(by.get('pg_1_l1')!.fallback).toBe(false);
    const speech = by.get('pg_1_l4')!;
    expect(speech.fontSize).toBe(17);
    expect(speech.font).toMatch(/^700 17px "DSL Comic Neue"/);
    expect(speech.stroke).toBe(2.8);
    expect(speech.pad).toEqual({ x: 15, y: 13 });
    expect(speech.lineHeight).toBe(1.3);
    expect(speech.runs.map((r) => r.text).join(' ')).toBe('YOU OWE ME AN EXPLANATION, MAYA.');
    expect(by.get('pg_1_l2')!.style.italic).toBe(true); // whisper
    expect(by.get('pg_1_l2')!.style.borderStyle).toBe('dashed');
    expect(by.get('pg_1_l3')!.fontSize).toBe(18.36); // shout ×1.08
    // Stored balloons keep their stored position (inside the page, so no render-time shift).
    const cap = by.get('pg_1_l1')!;
    expect(cap.x).toBe(40);
    expect(cap.w).toBe(300);
  });

  it('the plan geometry equals the classic board shapes for the same box', () => {
    const { doc, page } = sample();
    for (const plan of planLettering(doc, page, ASPECT, fixedMeasure)) {
      if (plan.kind === 'sfx') {
        expect(plan.geometry.body).toBeUndefined();
        continue;
      }
      const stored = page.balloons.find((b) => b.lineId === plan.lineId);
      const tip = stored && typeof stored.tailX === 'number' ? { x: stored.tailX * 1000 - plan.x, y: stored.tailY! * H - plan.y } : null;
      if (!tip) continue;
      const board = balloonShape(plan.kind, plan.w, plan.h, { tip, seed: boardHashSeed(plan.lineId), inset: plan.pad });
      expect(plan.geometry.body, plan.lineId).toBe(board.body);
      expect(plan.geometry.tail, plan.lineId).toBe(board.tail);
    }
  });

  it('SFX keep the classic hashed colour + tilt and fit the box width', () => {
    const { doc, page } = sample();
    const sfx = planLettering(doc, page, ASPECT, fixedMeasure).find((p) => p.kind === 'sfx')!;
    expect(sfxAutoStyle('pg_1_l5')).toEqual(sfxStyle('pg_1_l5'));
    expect(sfx.style.textColor).toBe(sfxStyle('pg_1_l5').color);
    if (sfxStyle('pg_1_l5').rotate) expect(sfx.transform?.rotate).toBe(sfxStyle('pg_1_l5').rotate);
    expect(sfx.fontId).toBe('bangers');
    for (const run of sfx.runs) expect(fixedMeasure(run.text, sfx.font)).toBeLessThanOrEqual(sfx.w * 0.94 + 0.5);
  });

  it('is pure, deterministic and memoized (no re-measuring on re-render)', () => {
    const { doc, page } = sample();
    let calls = 0;
    const counting: Measure = (t, f) => {
      calls += 1;
      return fixedMeasure(t, f);
    };
    const a = planLettering(doc, page, ASPECT, counting);
    const first = calls;
    expect(first).toBeGreaterThan(0);
    const b = planLettering(doc, page, ASPECT, counting);
    expect(b).toEqual(a);
    expect(calls).toBe(first);
    expect(planLettering(doc, page, ASPECT, fixedMeasure)).toEqual(planLettering(doc, page, ASPECT, fixedMeasure));
  });

  it('honours explicit line breaks and z order; links only to lines on the page', () => {
    const { doc, page } = sample((d) => {
      d.pages[0].panels[0].lines[0].text = 'OLD DELHI.\nBEFORE THE HEAT.';
      d.pages[0].balloons = d.pages[0].balloons.map((b) =>
        b.lineId === 'pg_1_l1' ? { ...b, z: 50, linkTo: 'pg_1_l2' } : b.lineId === 'pg_1_l2' ? { ...b, linkTo: 'nope' } : b
      );
    });
    const plans = planLettering(doc, page, ASPECT, fixedMeasure);
    const cap = plans.find((p) => p.lineId === 'pg_1_l1')!;
    expect(cap.runs.map((r) => r.text)).toEqual(['OLD DELHI.', 'BEFORE THE HEAT.']);
    expect(plans[plans.length - 1].lineId).toBe('pg_1_l1');
    expect(cap.linkTo).toBe('pg_1_l2');
    expect(plans.find((p) => p.lineId === 'pg_1_l2')!.linkTo).toBeUndefined();
  });
});

describe('planLettering: page fit, safe area, overflow', () => {
  it('a stored cloud at x=0 is drawn with its outline inside the page; flagged outside the safe area', () => {
    const { doc, page } = sample((d) => {
      d.pages[0].panels[1].lines[0].kind = 'thought';
      d.pages[0].balloons = d.pages[0].balloons.map((b) => (b.lineId === 'pg_1_l2' ? { ...b, x: 0, y: 0.5, pinned: true } : b));
    });
    const plan = planLettering(doc, page, ASPECT, fixedMeasure).find((p) => p.lineId === 'pg_1_l2')!;
    expect(plan.x + plan.geometry.bounds.x).toBeGreaterThanOrEqual(8 - 0.01);
    expect(plan.outOfSafeArea).toBe(true);
  });
  it('balloons placed by the engine sit inside the safe area', () => {
    const { doc, page } = sample();
    const fallback = planLettering(doc, page, ASPECT, fixedMeasure).find((p) => p.fallback)!;
    expect(fallback.outOfSafeArea).toBe(false);
  });
  it('text that cannot fit even at the floor is flagged overflow — never clipped', () => {
    const long = 'word '.repeat(160).trim();
    const { doc, page } = sample((d) => {
      d.pages[0].panels[1].lines[0].text = long;
      d.pages[0].balloons = d.pages[0].balloons.map((b) => (b.lineId === 'pg_1_l2' ? { ...b, w: 0.12, pinned: true } : b));
    });
    const plan = planLettering(doc, page, ASPECT, fixedMeasure).find((p) => p.lineId === 'pg_1_l2')!;
    expect(plan.overflow).toBe(true);
    expect(plan.runs.map((r) => r.text).join(' ').split(' ')).toHaveLength(160);
  });
});

describe('planLettering: styles and scripts', () => {
  it('presets change fonts, case and shapes (storybook keeps mixed case)', () => {
    const { doc, page } = sample((d) => {
      d.letterStyle = { presetId: 'storybook' };
    });
    const speech = planLettering(doc, page, ASPECT, fixedMeasure).find((p) => p.lineId === 'pg_1_l4')!;
    expect(speech.fontId).toBe('andika');
    expect(speech.runs.map((r) => r.text).join(' ')).toBe('You owe me an explanation, Maya.');
    expect(speech.style.shape).toBe('rounded_rect');
    expect(speech.geometry.body).toMatch(/A/);
  });
  it('case transforms are locale-aware and skip caseless scripts', () => {
    expect(applyTextCase('hi', 'upper', 'tr')).toBe('Hİ');
    expect(applyTextCase('नमस्ते', 'upper', 'hi')).toBe('नमस्ते');
    expect(applyTextCase('the old mcDuck', 'title', 'en')).toBe('The Old McDuck');
    expect(applyTextCase('LOUD', 'lower', 'en')).toBe('loud');
    expect(applyTextCase('As Typed', 'as_typed', 'en')).toBe('As Typed');
  });
  it('a Telugu edition line: Noto Sans Telugu, taller line height, no letter spacing or synthetic italics', () => {
    const { doc, page } = sample((d) => {
      d.letterStyle = { presetId: 'classic', base: { letterSpacing: 0.1 } };
      for (const p of d.pages[0].panels) for (const l of p.lines) {
        l.lang = 'te';
        l.text = 'నమస్కారం మిత్రమా ఎలా ఉన్నావు';
      }
    });
    const plans = planLettering(doc, page, ASPECT, fixedMeasure);
    const whisper = plans.find((p) => p.lineId === 'pg_1_l2')!;
    expect(whisper.lang).toBe('te');
    expect(whisper.fontId).toBe('noto-sans-telugu');
    expect(whisper.font).toContain('"Noto Sans Telugu"');
    expect(whisper.lineHeight).toBeCloseTo(1.7, 5);
    expect(whisper.style.letterSpacing).toBe(0);
    expect(whisper.style.italic).toBe(false);
    expect(whisper.transform).toBeUndefined();
    expect(whisper.runs.every((r) => !r.xs)).toBe(true);
    expect(whisper.runs.map((r) => r.text).join(' ')).toBe('నమస్కారం మిత్రమా ఎలా ఉన్నావు');
  });
  it('Urdu lines are rtl', () => {
    const { doc, page } = sample((d) => {
      d.pages[0].panels[2].lines[1].lang = 'ur';
      d.pages[0].panels[2].lines[1].text = 'یہ میرا دوست ہے';
    });
    const plan = planLettering(doc, page, ASPECT, fixedMeasure).find((p) => p.lineId === 'pg_1_l4')!;
    expect(plan.dir).toBe('rtl');
    expect(plan.fontId).toBe('noto-nastaliq-urdu');
  });
  it('letter spacing lays out glyphs explicitly (Latin)', () => {
    const { doc, page } = sample((d) => {
      d.letterStyle = { presetId: 'classic', kinds: { speech: { letterSpacing: 0.2 } } };
    });
    const speech = planLettering(doc, page, ASPECT, fixedMeasure).find((p) => p.lineId === 'pg_1_l4')!;
    const run = speech.runs[0];
    expect(run.xs).toHaveLength(Array.from(run.text).length);
    const gap = run.xs![1] - run.xs![0];
    expect(gap).toBeCloseTo(17 * 0.6 + 0.2 * 17, 1);
  });
  it('arched SFX glyphs are symmetric; pop ramps 0.85 → 1.15', () => {
    const arched = sample((d) => {
      d.letterStyle = { presetId: 'classic', kinds: { sfx: { sfxEffect: 'arched', arc: 0.6, rotate: 0 } } };
    });
    const sfx = planLettering(arched.doc, arched.page, ASPECT, fixedMeasure).find((p) => p.kind === 'sfx')!;
    const run = sfx.runs[0];
    const n = run.xs!.length;
    expect(n).toBe(4); // GRAB
    for (let i = 0; i < n; i += 1) {
      expect(run.ys![i]).toBeCloseTo(run.ys![n - 1 - i], 1);
      expect(run.rotates![i]).toBeCloseTo(-run.rotates![n - 1 - i], 1);
    }
    expect(run.rotates![n - 1]).toBeGreaterThan(0);
    const pop = sample((d) => {
      d.letterStyle = { presetId: 'classic', kinds: { sfx: { sfxEffect: 'pop' } } };
    });
    const popRun = planLettering(pop.doc, pop.page, ASPECT, fixedMeasure).find((p) => p.kind === 'sfx')!.runs[0];
    expect(popRun.scales![0]).toBe(0.85);
    expect(popRun.scales![popRun.scales!.length - 1]).toBe(1.15);
  });
  it('a Latin face without italics gets a synthetic skew', () => {
    const { doc, page } = sample((d) => {
      d.letterStyle = { presetId: 'classic', kinds: { whisper: { font: 'bangers' } } };
    });
    const whisper = planLettering(doc, page, ASPECT, fixedMeasure).find((p) => p.lineId === 'pg_1_l2')!;
    expect(whisper.transform?.skewX).toBe(-10);
  });
});

describe('sizer, estimate measure, helpers', () => {
  it('estimateMeasure uses the registry calibration', () => {
    expect(estimateMeasure('HELLO', '700 17px "DSL Comic Neue", sans-serif')).toBeCloseTo(5 * FONT_REGISTRY['comic-neue'].avgAdvanceEm * 17, 6);
    expect(estimateMeasure('hello', '400 10px "DSL Bangers", sans-serif')).toBeCloseTo(5 * FONT_REGISTRY.bangers.mixedCaseEm! * 10, 6);
    expect(estimateMeasure('నమస్తే', '700 20px "Noto Sans Telugu"')).toBeGreaterThan(estimateMeasure('abc', '700 20px "Noto Sans Telugu"'));
    expect(estimateMeasure('', 'x')).toBe(0);
  });
  it('letteringSizer bounds contain the text box (page fractions)', () => {
    const { doc, page } = sample();
    const sizer = letteringSizer(doc, page, ASPECT);
    const ln = page.panels[2].lines[0];
    const s = sizer(ln, 0.2);
    expect(s.h).toBeGreaterThan(0);
    expect(s.bounds.x).toBeLessThanOrEqual(0);
    expect(s.bounds.x + s.bounds.w).toBeGreaterThanOrEqual(0.2);
    expect(s.bounds.y + s.bounds.h).toBeGreaterThanOrEqual(s.h - 1e-9);
  });
  it('aspect from the render, else the format; empty pages plan nothing', () => {
    const { doc, page } = sample();
    expect(letteringAspect(doc, { render: { status: 'ready', asset: { path: 'x', source: 'generated', at: 1, w: 800, h: 1000 } } } as Page)).toBe(0.8);
    expect(letteringAspect({ format: { ...doc.format, pageAspect: '4:5' } } as ComicDoc, null)).toBe(0.8);
    expect(planLettering(doc, { ...page, panels: page.panels.map((p) => ({ ...p, lines: [] })) }, ASPECT, fixedMeasure)).toEqual([]);
    expect(planLetteringForPage(doc, 999)).toBeUndefined();
    expect(planLetteringForPage(doc, 1)!.length).toBe(5);
  });
});
