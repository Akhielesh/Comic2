// Window classes and the studio layout rule (mobile.md §2.1, §10.1; contract §13.4: split from 720 px).

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SPLIT_MIN_WIDTH,
  classifyViewport,
  defaultSplitFor,
  headerVariantFor,
  isPhoneLayout,
  minPanePx,
  sameFormFactor,
  segmentsFromRects,
  showsPaneSwitcher,
  widthClassOf,
  type Segments
} from './formFactor';
import { formFactorFor, keyboardSteadyHeight, readFormFactor, resetFormFactorStore } from './useFormFactor';

const rect = (left: number, top: number, width: number, height: number): DOMRectReadOnly =>
  ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRectReadOnly;

describe('classifyViewport', () => {
  it.each<[string, number, number, boolean, string, string, string]>([
    // label, w, h, coarse, layout, widthClass, orientation
    ['Galaxy Z Fold cover', 344, 882, true, 'single', 'compact', 'portrait'],
    ['Galaxy S8', 360, 800, true, 'single', 'compact', 'portrait'],
    ['iPhone 15', 393, 852, true, 'single', 'compact', 'portrait'],
    ['iPhone 15 landscape', 852, 393, true, 'single-rail', 'expanded', 'landscape'],
    ['iPad mini portrait', 744, 1133, true, 'split', 'medium', 'portrait'],
    ['iPad Air portrait', 820, 1180, true, 'split', 'medium', 'portrait'],
    ['iPad Air landscape', 1180, 820, true, 'split', 'expanded', 'landscape'],
    ['iPad Pro 13 portrait', 1032, 1376, true, 'split', 'expanded', 'portrait'],
    ['iPad Pro 13 landscape', 1376, 1032, true, 'split', 'large', 'landscape'],
    ['Fold unfolded, no segment API', 882, 1104, true, 'split', 'expanded', 'portrait'],
    ['desktop', 1920, 1080, false, 'split', 'large', 'landscape'],
    ['iPad Split View 1/2', 694, 1024, true, 'single', 'medium', 'portrait'],
    ['exactly 720 splits', 720, 900, false, 'split', 'medium', 'portrait'],
    ['719 is still one pane', 719, 900, false, 'single', 'medium', 'portrait'],
    ['320 reflow width', 320, 640, false, 'single', 'compact', 'portrait']
  ])('%s (%i×%i)', (_label, w, h, coarse, layout, widthClass, orientation) => {
    expect(classifyViewport({ w, h, coarse })).toEqual({ layout, widthClass, heightClass: h < 480 ? 'compact' : 'regular', orientation });
  });

  it('splits from 720 px (contract §13.4)', () => {
    expect(SPLIT_MIN_WIDTH).toBe(720);
  });

  it('two side-by-side segments (book posture) are dual-screen; stacked segments keep the window layout', () => {
    const horizontal: Segments = { count: 2, axis: 'horizontal', rects: [] };
    const vertical: Segments = { count: 2, axis: 'vertical', rects: [] };
    expect(classifyViewport({ w: 1100, h: 1000, coarse: true, segments: horizontal }).layout).toBe('dual-screen');
    expect(classifyViewport({ w: 1100, h: 1000, coarse: true, segments: vertical }).layout).toBe('split');
    expect(classifyViewport({ w: 600, h: 900, coarse: true, segments: vertical }).layout).toBe('single');
  });

  it('garbage sizes fall back to a sane desktop box', () => {
    expect(classifyViewport({ w: NaN, h: -1, coarse: false }).layout).toBe('split');
  });

  it('widthClassOf follows Material 3 (600 / 840 / 1200)', () => {
    expect([599, 600, 839, 840, 1199, 1200].map(widthClassOf)).toEqual(['compact', 'medium', 'medium', 'expanded', 'expanded', 'large']);
  });
});

describe('segmentsFromRects', () => {
  it('reads book posture (side by side) with the hinge between', () => {
    const s = segmentsFromRects([rect(0, 0, 540, 1000), rect(560, 0, 540, 1000)]);
    expect(s).toMatchObject({ count: 2, axis: 'horizontal', hinge: { start: 540, end: 560 } });
  });
  it('reads tabletop posture (stacked) and normalises order', () => {
    const s = segmentsFromRects([rect(0, 520, 900, 480), rect(0, 0, 900, 500)]);
    expect(s).toMatchObject({ count: 2, axis: 'vertical', hinge: { start: 500, end: 520 } });
  });
  it('anything else is one segment', () => {
    expect(segmentsFromRects(null).count).toBe(1);
    expect(segmentsFromRects([rect(0, 0, 500, 500)]).count).toBe(1);
    expect(segmentsFromRects([rect(0, 0, 500, 500), rect(100, 300, 500, 500)]).count).toBe(1);
  });
});

describe('derived rules', () => {
  it('phones are single and single-rail', () => {
    expect(isPhoneLayout('single')).toBe(true);
    expect(isPhoneLayout('single-rail')).toBe(true);
    expect(isPhoneLayout('split')).toBe(false);
    expect(isPhoneLayout('dual-screen')).toBe(false);
  });

  it('minimum pane: 320 on small tablets, 360 from 1024', () => {
    expect(minPanePx(744)).toBe(320);
    expect(minPanePx(1024)).toBe(360);
  });

  it('default split per window (42/58 small tablets, 38/62 touch landscape, 40/60 otherwise)', () => {
    expect(defaultSplitFor({ width: 744, orientation: 'portrait', coarse: true })).toEqual([42, 58]);
    expect(defaultSplitFor({ width: 1180, orientation: 'landscape', coarse: true })).toEqual([38, 62]);
    expect(defaultSplitFor({ width: 1440, orientation: 'landscape', coarse: false })).toEqual([40, 60]);
  });

  it('header variant and pane switcher', () => {
    expect(headerVariantFor(formFactorFor({ w: 390, h: 844, coarse: true }))).toBe('compact');
    expect(headerVariantFor(formFactorFor({ w: 820, h: 1180, coarse: true }))).toBe('medium');
    expect(headerVariantFor(formFactorFor({ w: 1440, h: 900 }))).toBe('regular');
    expect(showsPaneSwitcher(formFactorFor({ w: 820, h: 1180, coarse: true }))).toBe(true);
    expect(showsPaneSwitcher(formFactorFor({ w: 1440, h: 900 }))).toBe(false);
    expect(showsPaneSwitcher(formFactorFor({ w: 1366, h: 1024, coarse: true }))).toBe(true);
    expect(showsPaneSwitcher(formFactorFor({ w: 390, h: 844, coarse: true }))).toBe(false);
  });

  it('sameFormFactor compares what consumers render from', () => {
    const a = formFactorFor({ w: 390, h: 844, coarse: true });
    expect(sameFormFactor(a, { ...a })).toBe(true);
    expect(sameFormFactor(a, { ...a, width: 391 })).toBe(false);
    expect(sameFormFactor(a, { ...a, reducedMotion: true })).toBe(false);
  });
});

describe('readFormFactor (the live store’s reader)', () => {
  const originalMatch = window.matchMedia;
  afterEach(() => {
    window.matchMedia = originalMatch;
    vi.unstubAllGlobals();
    resetFormFactorStore();
  });

  it('reads the window and the pointer/motion media queries', () => {
    vi.stubGlobal('innerWidth', 390);
    vi.stubGlobal('innerHeight', 844);
    window.matchMedia = ((q: string) =>
      ({ matches: q === '(pointer: coarse)' || q === '(prefers-reduced-motion: reduce)', addEventListener: () => undefined, removeEventListener: () => undefined }) as unknown as MediaQueryList) as typeof window.matchMedia;
    const ff = readFormFactor();
    expect(ff).toMatchObject({ width: 390, height: 844, layout: 'single', coarse: true, anyFine: false, hover: false, reducedMotion: true });
  });

  it('the on-screen keyboard is not a new form factor: an Android resize while typing keeps the phone layout', () => {
    vi.stubGlobal('innerWidth', 360);
    vi.stubGlobal('innerHeight', 740);
    window.matchMedia = ((q: string) =>
      ({ matches: q === '(pointer: coarse)', addEventListener: () => undefined, removeEventListener: () => undefined }) as unknown as MediaQueryList) as typeof window.matchMedia;
    const before = readFormFactor();
    expect(before.layout).toBe('single');
    const box = document.createElement('textarea');
    document.body.appendChild(box);
    try {
      box.focus();
      // interactive-widget=resizes-content: the keyboard shrinks the layout viewport to 360 × 352.
      vi.stubGlobal('innerHeight', 352);
      const typing = readFormFactor(before);
      expect(typing).toMatchObject({ layout: 'single', heightClass: 'regular', height: 740 });
      // Without a focused field the same shrink is a real resize (phone landscape / a short window).
      box.blur();
      expect(readFormFactor(before)).toMatchObject({ layout: 'single-rail', heightClass: 'compact', height: 352 });
      // Rotating (a new width) re-learns even while typing.
      box.focus();
      vi.stubGlobal('innerWidth', 740);
      vi.stubGlobal('innerHeight', 360);
      expect(readFormFactor(before).layout).toBe('single-rail');
    } finally {
      box.remove();
    }
  });

  it('keyboardSteadyHeight holds the height only for a focused field, the same width and a SHORTER window', () => {
    const prev = { width: 1280, height: 800 };
    expect(keyboardSteadyHeight(prev, 1280, 450, true)).toBe(800); // Android tablet landscape keyboard
    expect(keyboardSteadyHeight(prev, 1280, 450, false)).toBe(450);
    expect(keyboardSteadyHeight(prev, 800, 1280, true)).toBe(1280);
    expect(keyboardSteadyHeight(prev, 1280, 900, true)).toBe(900);
    expect(keyboardSteadyHeight(null, 1280, 450, true)).toBe(450);
  });

  it('reads foldable segments from the Viewport Segments API when present', () => {
    vi.stubGlobal('innerWidth', 1100);
    vi.stubGlobal('innerHeight', 1000);
    (window as unknown as { viewport?: unknown }).viewport = { segments: [rect(0, 0, 540, 1000), rect(560, 0, 540, 1000)] };
    try {
      expect(readFormFactor().layout).toBe('dual-screen');
    } finally {
      delete (window as unknown as { viewport?: unknown }).viewport;
    }
  });
});
