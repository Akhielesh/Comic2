// Synthetic export fixtures: the board's sample comic with a drawn cover, book plates and a Telugu
// edition. No real user data.

import { DEFAULT_BOOK, type ComicDoc, type LanguageEdition, type TextTranslation } from '../../../../shared/comic/doc';
import { makeSampleDoc } from '../../board/__fixtures__/sampleDoc';

const tr = (text: string): TextTranslation => ({ text, status: 'reviewed', sourceHash: '', at: 0 });

export const TELUGU: Record<string, string> = {
  pg_1_l1: 'పాత దిల్లీ. ఎండకు ముందు.',
  pg_1_l2: 'ఇంకొక్కటే…',
  pg_1_l3: 'దొంగ!',
  pg_1_l4: 'నువ్వు నాకు వివరణ ఇవ్వాలి, మాయా.',
  pg_1_l5: 'పట్టు'
};

export const teluguEdition = (): LanguageEdition => ({
  lang: 'te',
  lines: Object.fromEntries(
    Object.entries(TELUGU).flatMap(([id, text]) => [
      [id, tr(text)],
      [id.replace('pg_1', 'pg_5'), tr(text)]
    ])
  ),
  cover: { title: tr('కుంకుమపువ్వు దొంగ') },
  brief: { title: tr('కుంకుమపువ్వు దొంగ') },
  balloons: {},
  register: 'everyday'
});

/** Sample comic with a drawn cover (+ overlay title when asked), plates on and a Telugu edition. */
export const makeBook = (mutate?: (doc: ComicDoc) => void, o: { plates?: boolean; overlayCover?: boolean; telugu?: boolean } = {}): ComicDoc =>
  makeSampleDoc((d) => {
    d.format.lettering = 'overlay';
    d.cover.title = 'The Saffron Thief';
    d.cover.render = { status: 'ready', history: [], asset: { path: 'u/proj/cover.png', source: 'generated', at: 0, w: 1000, h: 1500 } };
    if (o.overlayCover) d.cover.lettering = 'overlay';
    if (o.plates !== false) d.book = { ...DEFAULT_BOOK, titlePage: true, endPage: true, backCover: 'auto', credits: ['Story by Maya’s friends'] };
    if (o.telugu !== false) d.i18n = { editions: { te: teluguEdition() }, glossary: [] };
    mutate?.(d);
  });
