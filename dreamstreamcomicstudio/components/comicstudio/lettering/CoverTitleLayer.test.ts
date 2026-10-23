// CoverTitleLayer exports `blockNodes` (gate L15 / P2-EXPORT missing #4): the screen and the exports draw a
// cover title block with ONE implementation. These pin that the exported layer nodes equal the export's own
// copy (export/coverTitle.ts coverBlockNodes) — including a translucent outline, which the screen used to
// draw fully opaque — so the export can drop its copy and call blockNodes.

import { describe, expect, it } from 'vitest';
import { blockNodes, type CoverTextBlock } from './CoverTitleLayer';
import { coverBlockNodes } from '../export/coverTitle';

const block = (style: Partial<CoverTextBlock['style']> = {}): CoverTextBlock => ({
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
    sizeScale: 1,
    ...style
  },
  lang: 'en',
  dir: 'ltr'
});

describe('CoverTitleLayer blockNodes', () => {
  it('is exported and draws exactly what the export draws (shadow copy, then fill with its outline)', () => {
    const blk = block();
    const nodes = blockNodes(blk);
    expect(nodes).toEqual(coverBlockNodes(blk));
    expect(nodes).toHaveLength(2);
    const [shadow, fill] = nodes;
    expect(shadow.attrs).toMatchObject({ transform: 'translate(2.97 3.72)', opacity: 0.8 });
    // A translucent outline keeps its opacity on screen too.
    expect(fill.children?.[0].attrs).toMatchObject({ fill: '#ffffff', stroke: '#111111', 'stroke-opacity': 0.502, 'stroke-width': 9.86, 'paint-order': 'stroke' });
    expect(fill.children?.map((t) => t.text)).toEqual(['THE SAFFRON', 'THIEF']);
  });

  it('no outline, no shadow, right-to-left and italic faces match too', () => {
    const blk = { ...block({ textStroke: undefined, shadow: undefined }), font: 'italic 700 64px Noto Sans Arabic', dir: 'rtl' as const, lang: 'ar' };
    const nodes = blockNodes(blk);
    expect(nodes).toEqual(coverBlockNodes(blk));
    expect(nodes).toHaveLength(1);
    expect(nodes[0].children?.[0].attrs).toMatchObject({ 'font-style': 'italic', 'font-weight': 700, direction: 'rtl', 'font-family': 'Noto Sans Arabic' });
  });
});
