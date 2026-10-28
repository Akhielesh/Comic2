// export/coverTitle.ts (gate F8 follow-up, P2-EXPORT #4): the export draws a cover title block with the
// SAME function the screen uses — CoverTitleLayer's `blockNodes` — not a copy of it. The parity test in
// lettering/CoverTitleLayer.test.ts pins equal output; this pins that there is one implementation, so
// the two can never drift again (before the fix coverBlockNodes was a separate function).
import { describe, expect, it } from 'vitest';
import { blockNodes, type CoverTextBlock } from '../lettering/CoverTitleLayer';
import { coverBlockNodes, coverTitleNodes, coverTitleSvgMarkup, coverTitleText } from './coverTitle';
import { makeSampleDoc } from '../board/__fixtures__/sampleDoc';
import type { Measure } from '../../../shared/comic/lettering/layout';

const block: CoverTextBlock = {
  text: 'The Saffron Thief',
  lines: ['THE SAFFRON', 'THIEF'],
  font: '400 72px Bangers',
  fontSize: 72,
  lineHeight: 1.05,
  x: 500,
  ys: [180, 256],
  anchor: 'middle',
  style: {
    font: 'bangers',
    weight: 400,
    italic: false,
    textCase: 'upper',
    textColor: '#ffffff',
    textStroke: { color: '#11111180', width: 0.137 },
    shadow: { color: '#111111cc', dx: 0.0413, dy: 0.0517 },
    align: 'center',
    lineHeight: 1.05,
    sizeScale: 1
  },
  lang: 'en',
  dir: 'ltr'
};

/** A fixed-width measure (page units, W = 1000): enough for the plan to lay a title out without a canvas. */
const measure: Measure = (text: string, font: string) => {
  const m = /(\d+(?:\.\d+)?)px/.exec(font);
  const px = m ? Number(m[1]) : 16;
  return text.length * px * 0.55;
};

describe('coverBlockNodes', () => {
  it('IS CoverTitleLayer.blockNodes (one implementation, not an equal copy)', () => {
    expect(coverBlockNodes).toBe(blockNodes);
    expect(coverBlockNodes(block)).toEqual(blockNodes(block));
    expect(coverBlockNodes(block)).toHaveLength(2);
  });
});

describe('coverTitleNodes', () => {
  it('a painted (in-art) cover draws nothing: no nodes, no text, no markup', () => {
    const doc = makeSampleDoc((d) => {
      d.cover = { ...d.cover, lettering: 'in_art', title: 'The Saffron Thief' };
    });
    expect(coverTitleNodes(doc, 2 / 3, measure)).toEqual([]);
    expect(coverTitleText(doc, 2 / 3, measure)).toBe('');
    expect(coverTitleSvgMarkup(doc, 2 / 3, measure)).toBe('');
  });

  it('an overlay cover draws its title through blockNodes, in plan units', () => {
    const doc = makeSampleDoc((d) => {
      d.cover = { ...d.cover, lettering: 'overlay', title: 'The Saffron Thief' };
    });
    const nodes = coverTitleNodes(doc, 2 / 3, measure);
    expect(nodes.length).toBeGreaterThan(0);
    expect(nodes.every((n) => n.tag === 'g')).toBe(true);
    expect(coverTitleText(doc, 2 / 3, measure)).toContain('The Saffron Thief');
    expect(coverTitleSvgMarkup(doc, 2 / 3, measure)).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" class="cover-title" viewBox="0 0 1000 1500"/);
  });
});
