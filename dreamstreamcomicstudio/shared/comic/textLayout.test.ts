import { afterEach, describe, expect, it } from 'vitest';
import { balloonWidthForText, estimateBalloonHeight, wrapBalanced, wrapText } from '../../components/comicstudio/board/balloonGeometry';
import {
  estimateTextHeight,
  estimateWidthForText,
  fitBalloonText,
  graphemes,
  normalizeLetteringText,
  wrapBalancedLines,
  wrapLines,
  wrapUnits,
  type FitInput
} from './textLayout';

const realSegmenter = (Intl as unknown as { Segmenter?: unknown }).Segmenter;
const withoutSegmenter = <T>(fn: () => T): T => {
  (Intl as unknown as { Segmenter?: unknown }).Segmenter = undefined;
  try {
    return fn();
  } finally {
    (Intl as unknown as { Segmenter?: unknown }).Segmenter = realSegmenter;
  }
};
afterEach(() => {
  (Intl as unknown as { Segmenter?: unknown }).Segmenter = realSegmenter;
});

/** One unit per grapheme cluster (a stand-in for canvas measureText). */
const perGrapheme = (lang: string, unit = 10) => (s: string) => graphemes(s, lang).length * unit;

describe('estimates keep the pre-v5 Latin numbers (byte-equal golden)', () => {
  const FIXTURES = [
    'Hi',
    'Hi there',
    'word '.repeat(40),
    'You owe me an explanation, Maya.',
    'x'.repeat(140),
    'A very long sentence that wraps across several lines in a balloon for sure.',
    'This is a medium length line of dialogue, okay?',
    'Supercalifragilisticexpialidocious is a very long word indeed',
    '   spaced    out   words   ',
    ''
  ];
  it('estimateWidthForText(en) === balloonWidthForText', () => {
    for (const text of FIXTURES) expect(estimateWidthForText(text, 'en')).toBe(balloonWidthForText(text));
    for (const text of FIXTURES) expect(estimateWidthForText(text, 'en', 'comic-neue')).toBe(balloonWidthForText(text));
  });
  it('estimateTextHeight(en) === estimateBalloonHeight for every width and aspect', () => {
    for (const text of FIXTURES)
      for (const w of [0.08, 0.16, 0.2, 0.25, 0.34, 0.5])
        for (const aspect of [2 / 3, 0.8, 1, 9 / 16]) {
          expect(estimateTextHeight(text, w, aspect, 'en')).toBe(estimateBalloonHeight(text, w, aspect));
          expect(estimateTextHeight(text, w, aspect, 'en', 'comic-neue')).toBe(estimateBalloonHeight(text, w, aspect));
        }
  });
  it('Latin languages share the calibration; narrower faces estimate fewer lines', () => {
    const t = 'Bonjour mes amis, on y va maintenant ou jamais ?';
    expect(estimateTextHeight(t, 0.2, 2 / 3, 'fr')).toBe(estimateBalloonHeight(t, 0.2, 2 / 3));
    expect(estimateTextHeight('word '.repeat(30), 0.2, 2 / 3, 'en', 'bangers')).toBeLessThan(estimateTextHeight('word '.repeat(30), 0.2, 2 / 3, 'en'));
  });
  it('CJK estimates are ≈1.85× wider per grapheme than Latin', () => {
    const latin = estimateWidthForText('a'.repeat(40), 'en');
    const ja = estimateWidthForText('あ'.repeat(40), 'ja');
    expect(ja).toBeGreaterThan(latin);
    const linesOf = (h: number) => Math.round((h / (2 / 3) - 0.026) / (0.022 * (1.4 / 1.3)));
    const jaLines = linesOf(estimateTextHeight('あ'.repeat(80), 0.25, 2 / 3, 'ja'));
    const enLines = Math.round((estimateTextHeight('a'.repeat(80), 0.25, 2 / 3, 'en') / (2 / 3) - 0.026) / 0.022);
    expect(jaLines / Math.max(1, enLines)).toBeGreaterThan(1.4);
  });
  it('Telugu lines are taller (script line height) and wider (grapheme width)', () => {
    const te = 'నేను నిన్ను చూశాను మిత్రమా ఇది చాలా బాగుంది';
    expect(estimateTextHeight(te, 0.25, 2 / 3, 'te')).toBeGreaterThan(estimateTextHeight('I saw you my friend this is very good', 0.25, 2 / 3, 'en'));
  });
});

describe('normalization', () => {
  it('collapses ASCII spaces, keeps NBSP / U+202F, honours explicit line breaks', () => {
    expect(normalizeLetteringText('  a \t b  ')).toBe('a b');
    expect(normalizeLetteringText('Quoi ?')).toBe('Quoi ?');
    expect(normalizeLetteringText('one\r\n\n two ')).toBe('one\ntwo');
    expect(normalizeLetteringText(42)).toBe('');
  });
  it('explicit \\n is a hard break in wraps and estimates', () => {
    expect(wrapLines('HELLO\nTHERE', 'en', 1000, (s) => s.length)).toEqual(['HELLO', 'THERE']);
    const units = wrapUnits('a b\nc', 'en');
    expect(units.map((u) => [u.text, !!u.hard])).toEqual([['a', false], ['b', false], ['c', true]]);
    expect(estimateTextHeight('a\nb', 0.3, 1, 'en')).toBeGreaterThan(estimateTextHeight('a b', 0.3, 1, 'en'));
  });
});

describe('wrapLines matches the board wrap for Latin text', () => {
  const measure = (s: string) => s.length * 7;
  it('greedy and balanced equal balloonGeometry.wrapText / wrapBalanced', () => {
    for (const text of ['aa bb cc dd', 'abcdefghij', 'The quick brown fox jumps over the lazy dog again and again', '   '])
      for (const w of [30, 50, 120, 300]) {
        expect(wrapLines(text, 'en', w, measure)).toEqual(wrapText(text, w, measure));
        expect(wrapBalancedLines(text, 'en', w, measure)).toEqual(wrapBalanced(text, w, measure));
      }
  });
});

describe('script-aware wrapping', () => {
  it('Hindi: long words break only at grapheme boundaries (never after a bare virama)', () => {
    expect(graphemes('क्षत्रिय', 'hi')).toEqual(['क्ष', 'त्रि', 'य']);
    for (const w of [10, 15, 20, 25]) {
      const lines = wrapLines('क्षत्रिय', 'hi', w, perGrapheme('hi'));
      expect(lines.join('')).toBe('क्षत्रिय');
      for (const l of lines) expect(l.endsWith('्')).toBe(false);
    }
  });
  it('Telugu: a narrow wrap keeps the conjunct స్కా intact', () => {
    expect(graphemes('నమస్కారం', 'te')).toEqual(['న', 'మ', 'స్కా', 'రం']);
    const lines = wrapLines('నమస్కారం', 'te', 15, perGrapheme('te'));
    expect(lines).toEqual(['న', 'మ', 'స్కా', 'రం']);
    const words = wrapLines('నమస్కారం మిత్రమా', 'te', 45, perGrapheme('te'));
    expect(words).toEqual(['నమస్కారం', 'మిత్రమా']);
  });
  it('fallback without Intl.Segmenter (virama/ZWJ merge) gives the same clusters', () => {
    const samples: [string, string][] = [
      ['क्षत्रिय', 'hi'],
      ['नमस्ते दोस्त', 'hi'],
      ['నమస్కారం', 'te'],
      ['శ్రీకృష్ణ', 'te'],
      ['ক্ষমা', 'bn'],
      ['ಕ್ಷಮೆ', 'kn'],
      ['café', 'fr']
    ];
    const withSeg = samples.map(([t, l]) => graphemes(t, l));
    const without = withoutSegmenter(() => samples.map(([t, l]) => graphemes(t, l)));
    expect(without).toEqual(withSeg);
    withoutSegmenter(() => {
      expect(wrapLines('నమస్కారం', 'te', 15, perGrapheme('te'))).toEqual(['న', 'మ', 'స్కా', 'రం']);
      for (const l of wrapLines('क्षत्रिय', 'hi', 10, perGrapheme('hi'))) expect(l.endsWith('्')).toBe(false);
    });
  });
  it('a ZWJ never starts or ends a cluster on its own', () => {
    const gs = withoutSegmenter(() => graphemes('क्‍ष', 'hi'));
    expect(gs).toEqual(['क्‍ष']);
  });

  const START_FORBIDDEN = /^[、。，．・：；！？）」』】〉》ーっゃゅょァィゥェォッャュョ…]/u;
  const jaCases = ['今日はいい天気ですね。散歩に行きましょう、いいですか？', '「こんにちは」と言った。コーヒーを飲みます。', 'ちょっと待って！ねえ、聞いてる？'];
  for (const [label, run] of [
    ['with Segmenter', (f: () => void) => f()],
    ['without Segmenter', (f: () => void) => withoutSegmenter(f)]
  ] as const) {
    it(`Japanese kinsoku (${label}): 。、ー never start a line, 「 never ends one`, () => {
      run(() => {
        for (const text of jaCases)
          for (const w of [20, 30, 40, 50, 60, 80]) {
            const lines = wrapLines(text, 'ja', w, perGrapheme('ja'));
            expect(lines.join('')).toBe(text);
            lines.slice(1).forEach((l) => expect(l).not.toMatch(START_FORBIDDEN));
            lines.forEach((l) => expect(l.endsWith('「')).toBe(false));
          }
      });
    });
  }
  it('Japanese word units come from the segmenter', () => {
    expect(wrapUnits('今日はいい天気ですね。', 'ja').map((u) => u.text)).toEqual(['今日', 'は', 'いい', '天気', 'です', 'ね。']);
    expect(wrapUnits('今日はいい天気ですね。', 'ja').every((u) => !u.spaced)).toBe(true);
  });
  it('Chinese: no spaces are ever inserted', () => {
    const text = '我们今天去公园玩吧，好不好？天气真好。';
    for (const w of [30, 50, 70]) {
      const lines = wrapLines(text, 'zh-Hans', w, perGrapheme('zh-Hans'));
      expect(lines.join('')).toBe(text);
      lines.forEach((l) => expect(l).not.toMatch(/ /));
      lines.slice(1).forEach((l) => expect(l).not.toMatch(/^[，。？]/));
    }
  });
  it('French: narrow no-break spaces keep « Quoi ? » together', () => {
    const NNBSP = String.fromCharCode(0x202f);
    const NBSP = String.fromCharCode(0xa0);
    const text = `«${NNBSP}Quoi${NNBSP}?${NNBSP}» Tu es sûr${NBSP}! Vraiment${NNBSP}?`;
    for (const w of [80, 120, 200]) {
      const lines = wrapLines(text, 'fr', w, (s) => s.length * 7);
      lines.forEach((l) => expect(l).not.toMatch(/^[?!»]/));
      expect(lines.join(' ')).toBe(text);
    }
    expect(wrapUnits(text, 'fr').map((u) => u.text)).toContain(`«${NNBSP}Quoi${NNBSP}?${NNBSP}»`);
    // Even an emergency break inside a too-long unit never starts a line with ? » or a no-break space.
    for (const l of wrapLines(text, 'fr', 30, (s) => s.length * 7).slice(1)) expect(l).not.toMatch(new RegExp(`^[?!»${NBSP}${NNBSP}]`));
  });
  it('Arabic / Urdu: units are in logical order; wrapping is direction-agnostic', () => {
    expect(wrapUnits('مرحبا بك يا صديقي', 'ar').map((u) => u.text)).toEqual(['مرحبا', 'بك', 'يا', 'صديقي']);
    expect(wrapLines('یہ میرا دوست ہے', 'ur', 80, (s) => s.length * 10)).toEqual(['یہ میرا', 'دوست ہے']);
  });
});

describe('fitBalloonText', () => {
  const measure = (s: string, px: number) => graphemes(s).length * px * 0.6;
  const base: FitInput = {
    text: 'Hi there!',
    lang: 'en',
    kind: 'speech',
    balloon: { x: 0.1, y: 0.1, w: 0.25 },
    panel: { x: 0.05, y: 0.05, w: 0.6, h: 0.4 },
    pageW: 700,
    pageH: 1050,
    baseFontPx: 12,
    measure
  };
  it('(a) fits as-is', () => {
    const r = fitBalloonText(base);
    expect(r).toMatchObject({ w: 0.25, fontPx: 12, overflow: false, grew: false, shrank: false });
    expect(r.lines).toEqual(['Hi there!']);
  });
  const long = 'This is a much longer line of dialogue that needs plenty of room to breathe inside its little balloon, really.';
  const tight = { ...base, text: long, balloon: { x: 0.1, y: 0.33, w: 0.16 }, panel: { x: 0.05, y: 0.05, w: 0.6, h: 0.4 } };
  it('(b) grows the width within the panel (≤ 0.42)', () => {
    const r = fitBalloonText(tight);
    expect(r.grew).toBe(true);
    expect(r.w).toBeGreaterThan(0.16);
    expect(r.w).toBeLessThanOrEqual(0.42);
    expect(r.overflow).toBe(false);
    expect(r.heightPx).toBeLessThanOrEqual((0.45 - 0.33) * 1050);
  });
  it('(c) a pinned balloon does not grow; the font shrinks instead', () => {
    const r = fitBalloonText({ ...tight, balloon: { ...tight.balloon, y: 0.38, pinned: true }, text: long.slice(0, 60) });
    expect(r.grew).toBe(false);
    expect(r.w).toBe(0.16);
    expect(r.shrank).toBe(true);
    expect(r.fontPx).toBeLessThan(12);
    expect(r.fontPx).toBeGreaterThanOrEqual(Math.max(9, 12 * 0.82) - 1e-9);
  });
  it('(d) at the floor: overflow, never clipped (every word is still there)', () => {
    const r = fitBalloonText({ ...tight, balloon: { ...tight.balloon, pinned: true }, text: `${long} ${long}` });
    expect(r.overflow).toBe(true);
    expect(r.fontPx).toBeCloseTo(Math.max(9, 12 * 0.82), 5);
    expect(r.lines.join(' ').split(/\s+/)).toEqual(`${long} ${long}`.split(/\s+/));
  });
  it('(e) deterministic', () => {
    expect(fitBalloonText(tight)).toEqual(fitBalloonText(tight));
  });
  it('source height bounds the growth of a translation (×1.45)', () => {
    const r = fitBalloonText({ ...base, text: long, sourceHeightPx: 40 });
    expect(r.grew || r.shrank || r.overflow).toBe(true);
  });
  it('scripts apply their font scale (Urdu 0.95)', () => {
    expect(fitBalloonText({ ...base, lang: 'ur', text: 'سلام' }).fontPx).toBeCloseTo(12 * 0.95, 2);
  });
});
