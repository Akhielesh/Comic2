import { describe, expect, it } from 'vitest';
import { LETTERING as BOARD_LETTERING } from '../../../components/comicstudio/board/balloonGeometry';
import { createEmptyDoc, type Line } from '../doc';
import {
  DEFAULT_LETTERING,
  FONT_IDS,
  KIND_FONT_SCALE,
  LETTERING_PRESETS,
  LETTER_METRICS,
  mergeStylePatch,
  normalizeColor,
  presetForComic,
  resolveLetterStyle,
  sanitizeLetterStylePatch,
  sanitizeLetteringStyle,
  sanitizeLetteringStyleOpPatch
} from './style';

const line = (kind: Line['kind'], extra: Partial<Line> = {}): Line => ({ id: 'l', kind, text: 'Hi', ...extra });

describe('classic preset parity (regression-locked to today)', () => {
  it('matches the board constants', () => {
    const doc = createEmptyDoc('d', 'D', 1);
    const speech = resolveLetterStyle(doc, line('speech'));
    expect(speech).toMatchObject({ font: 'comic-neue', weight: 700, textCase: 'upper', textColor: BOARD_LETTERING.ink, fill: BOARD_LETTERING.fill, border: BOARD_LETTERING.ink, shape: 'squircle', tail: 'curved', sizeScale: 1, lineHeight: BOARD_LETTERING.lineHeight });
    expect(resolveLetterStyle(doc, line('caption'))).toMatchObject({ shape: 'rect', fill: BOARD_LETTERING.captionFill, tail: 'none' });
    expect(resolveLetterStyle(doc, line('thought'))).toMatchObject({ shape: 'cloud', tail: 'bubbles' });
    expect(resolveLetterStyle(doc, line('shout'))).toMatchObject({ shape: 'burst', tail: 'straight' });
    expect(resolveLetterStyle(doc, line('whisper'))).toMatchObject({ italic: true, borderStyle: 'dashed' });
    expect(resolveLetterStyle(doc, line('sfx'))).toMatchObject({ font: 'bangers', weight: 400, textColor: 'auto', rotate: 'auto', shape: 'none', textStroke: { color: '#111111', width: 0.12 } });
    expect(KIND_FONT_SCALE).toEqual({ speech: 1, thought: 1, whisper: 0.94, shout: 1.08, caption: 0.95, sfx: 2.4 });
    expect(LETTER_METRICS).toMatchObject({ fontScale: BOARD_LETTERING.fontScale, padX: BOARD_LETTERING.padX, padY: BOARD_LETTERING.padY, charW: BOARD_LETTERING.charW, lineH: BOARD_LETTERING.lineH, strokeScale: BOARD_LETTERING.strokeScale });
  });

  it('every preset base is complete and uses registry fonts', () => {
    const keys = Object.keys(LETTERING_PRESETS.classic.base).sort();
    for (const p of Object.values(LETTERING_PRESETS)) {
      expect(Object.keys(p.base).sort()).toEqual(keys);
      expect(FONT_IDS).toContain(p.base.font);
      for (const k of Object.values(p.kinds)) if (k.font) expect(FONT_IDS).toContain(k.font);
      expect(sanitizeLetterStylePatch(p.base)).toEqual(p.base); // presets are valid patches
    }
  });
});

describe('resolveLetterStyle precedence', () => {
  it('preset.base → preset.kinds → doc.base → doc.kinds → speakers → line.style', () => {
    const doc = {
      ...createEmptyDoc('d', 'D', 1),
      letterStyle: {
        presetId: 'classic' as const,
        base: { fill: '#000001', textColor: '#000001', border: '#000001' },
        kinds: { caption: { fill: '#000002', textColor: '#000002' } },
        speakers: { c1: { textColor: '#000003', border: '#000003' } }
      }
    };
    expect(resolveLetterStyle(doc, line('speech'))).toMatchObject({ fill: '#000001', textColor: '#000001', border: '#000001' });
    expect(resolveLetterStyle(doc, line('caption'))).toMatchObject({ fill: '#000002', textColor: '#000002' });
    expect(resolveLetterStyle(doc, line('caption', { speakerId: 'c1' }))).toMatchObject({ fill: '#000002', textColor: '#000003', border: '#000003' });
    expect(resolveLetterStyle(doc, line('caption', { speakerId: 'c1', style: { textColor: '#000004' } })).textColor).toBe('#000004');
    expect(resolveLetterStyle({ format: doc.format }, line('speech')).font).toBe('comic-neue'); // no letterStyle → DEFAULT
  });
});

describe('normalizeColor', () => {
  it.each([
    ['#F00', '#ff0000'],
    ['ff0000', '#ff0000'],
    ['#ff000080', '#ff000080'],
    ['#ff0000ff', '#ff0000'],
    ['#f008', '#ff000088'],
    ['rgb(255, 0, 0)', '#ff0000'],
    ['rgba(0,0,0,0.5)', '#00000080'],
    ['navy', '#1d3557'],
    ['Slate Gray', '#708090'],
    ['hot-pink', '#ff48b0'],
    ['none', 'none'],
    ['transparent', 'none'],
    ['auto', 'auto'],
    ['blurple', undefined],
    ['rgb(300,0,0)', undefined],
    [42, undefined],
    ['url(javascript:alert(1))', undefined]
  ])('%s → %s', (input, out) => {
    expect(normalizeColor(input)).toBe(out);
  });
});

describe('sanitizers and merge', () => {
  it('sanitizeLetterStylePatch clamps, validates and drops unknown keys', () => {
    expect(
      sanitizeLetterStylePatch({ font: 'papyrus', sizeScale: 9, weight: 650, italic: 'yes', textColor: 'red', textStroke: { color: '#000', width: 2 }, shadow: null, rotate: 'auto', shape: 'hexagon', evil: '<script>', arc: -4 })
    ).toEqual({ sizeScale: 3.5, weight: 600, textColor: '#e63946', textStroke: { color: '#000000', width: 0.3 }, shadow: null, rotate: 'auto', arc: -1 });
    expect(sanitizeLetterStylePatch({ bogus: 1 })).toBeUndefined();
    expect(sanitizeLetterStylePatch('nope')).toBeUndefined();
  });

  it('mergeStylePatch: shallow, wholesale stroke/shadow, null deletes, empty → undefined', () => {
    expect(mergeStylePatch({ fill: '#ffffff', textStroke: { color: '#000000', width: 0.1 } }, { textStroke: { color: '#ff0000', width: 0.2 } })).toEqual({ fill: '#ffffff', textStroke: { color: '#ff0000', width: 0.2 } });
    expect(mergeStylePatch({ fill: '#ffffff' }, { fill: null as never })).toBeUndefined();
    expect(mergeStylePatch({ fill: '#ffffff' }, null)).toBeUndefined();
    expect(mergeStylePatch(undefined, { italic: true })).toEqual({ italic: true });
  });

  it('sanitizeLetteringStyle: missing/invalid → classic without auto', () => {
    expect(sanitizeLetteringStyle(undefined)).toEqual(DEFAULT_LETTERING);
    expect(sanitizeLetteringStyle({ presetId: 'wingdings' })).toEqual({ presetId: 'classic' });
    expect(sanitizeLetteringStyle({ presetId: 'manga', auto: true, base: { fill: 'white' }, kinds: { sfx: { font: 'ultra' }, bogus: {} }, speakers: { c1: { nope: 1 } }, safeMargin: 2 })).toEqual({
      presetId: 'manga', auto: true, base: { fill: '#ffffff' }, kinds: { sfx: { font: 'ultra' } }, safeMargin: 0.1
    });
  });

  it('sanitizeLetteringStyleOpPatch: registry presets, cast-only speakers, ≤ 2 KB', () => {
    const cast = new Set(['c1']);
    expect(sanitizeLetteringStyleOpPatch({ presetId: 'noir', speakers: { c1: { shape: 'electronic' } }, auto: null }, cast)).toEqual({ presetId: 'noir', speakers: { c1: { shape: 'electronic' } }, auto: null });
    expect(sanitizeLetteringStyleOpPatch({ presetId: 'x' }, cast)).toBeNull();
    expect(sanitizeLetteringStyleOpPatch({ speakers: { ghost: { italic: true } } }, cast)).toBeNull();
    expect(sanitizeLetteringStyleOpPatch({ base: { fill: 'x'.repeat(3000) } }, cast)).toBeNull();
    expect(sanitizeLetteringStyleOpPatch({}, cast)).toBeNull();
    expect(sanitizeLetteringStyleOpPatch({ base: null, kinds: { sfx: null }, safeMargin: null }, cast)).toEqual({ base: null, kinds: { sfx: null }, safeMargin: null });
  });

  it('presetForComic', () => {
    const f = createEmptyDoc('d', 'D', 1).format;
    const b = { title: 'x', notes: [] };
    expect(presetForComic({ ...f, kind: 'storybook' }, b)).toBe('storybook');
    expect(presetForComic(f, { ...b, audience: 'kids 2–6' })).toBe('storybook');
    expect(presetForComic({ ...f, kind: 'manga' }, b)).toBe('manga');
    expect(presetForComic({ ...f, kind: 'webtoon' }, b)).toBe('webtoon');
    expect(presetForComic(f, { ...b, genre: 'Detective noir' })).toBe('noir');
    expect(presetForComic(f, b)).toBe('classic');
  });
});
