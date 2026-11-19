// Synthetic books for the free review (LT-10). Six clean formats a careful creator could finish: an RTL manga, a webtoon,
// a strip, a storybook, a wordless two-page book shaped like The Last Tram (big quiet panels, almost no text) and a Telugu
// comic. Every page is drawn and checked: its page check carries the panel boxes, a face box and a head for every
// character drawn in each panel (low in the panel, where pictures put people), the beats in order and no findings. The
// lines carry no stored balloons, so the lettering engine places them around the faces and aims the tails, as it does
// for a new comic. Defects are seeded on top with the small helpers at the end. No real people, comics or user data.

import { estimatePanelBoxes } from '../../pageGeometry.js';
import {
  createEmptyDoc,
  type AspectRatio,
  type Balloon,
  type Box,
  type CastKind,
  type ComicDoc,
  type ComicKind,
  type KeepOut,
  type Line,
  type LineKind,
  type Page,
  type Panel,
  type PanelSize,
  type QcReport,
  type ShotType,
  type SpeakerMark
} from '../../doc.js';
import type { LetteringPresetId } from '../../lettering/style.js';

export const REVIEW_NOW = 1_762_000_000_000;

export interface LineSpec {
  kind?: LineKind;
  /** Speaker id (speech, thought, whisper, shout). */
  who?: string;
  text: string;
}
export interface PanelSpec {
  /** Characters drawn in the panel (each gets a face box and a head in the page check). */
  cast?: string[];
  lines?: LineSpec[];
  shot?: ShotType;
  size?: PanelSize;
}
export interface PageSpec {
  layout?: string;
  panels: PanelSpec[];
}
export interface BookSpec {
  id: string;
  title: string;
  kind: ComicKind;
  aspect: AspectRatio;
  language?: string;
  rtl?: boolean;
  preset?: LetteringPresetId;
  lettering?: 'overlay' | 'in_art';
  audience?: string;
  cast: { id: string; name: string; kind?: CastKind }[];
  pages: PageSpec[];
}

const ratioOf = (aspect: AspectRatio): number => {
  const [w, h] = aspect.split(':').map(Number);
  return w / h;
};
const r4 = (n: number) => Math.round(n * 10000) / 10000;

/** One face box and one head per drawn character, spread across the lower part of the panel. */
const facesFor = (box: Box, n: number, cast: string[], aspect: number): { keepOut: KeepOut[]; heads: SpeakerMark[] } => {
  const keepOut: KeepOut[] = [];
  const heads: SpeakerMark[] = [];
  cast.forEach((id, i) => {
    const cx = box.x + (box.w * (i + 1)) / (cast.length + 1);
    const cy = box.y + box.h * 0.7;
    const fw = Math.min(0.08, (box.w / (cast.length + 1)) * 0.6);
    const fh = Math.min(box.h * 0.25, fw * aspect);
    keepOut.push({ panel: n, kind: 'face', box: { x: r4(cx - fw / 2), y: r4(cy - fh / 2), w: r4(fw), h: r4(fh) } });
    heads.push({ panel: n, characterId: id, head: { x: r4(cx), y: r4(cy) } });
  });
  return { keepOut, heads };
};

/** A drawn, checked book from its spec. Line ids are `l_<page>_<panel>_<k>`, panels `p_<page>_<panel>`, pages `pg_<n>`. */
export const makeBook = (spec: BookSpec): ComicDoc => {
  const doc = createEmptyDoc(spec.id, spec.title, REVIEW_NOW - 3_600_000);
  doc.format = {
    ...doc.format,
    kind: spec.kind,
    pageCount: spec.pages.length,
    pageAspect: spec.aspect,
    panelsPerPage: 'auto',
    readingDirection: spec.rtl ? 'rtl' : 'ltr',
    lettering: spec.lettering ?? 'overlay',
    language: spec.language ?? 'en'
  };
  if (spec.audience) doc.brief = { ...doc.brief, audience: spec.audience };
  if (spec.preset) doc.letterStyle = { presetId: spec.preset };
  doc.cast = spec.cast.map((c) => ({
    id: c.id,
    name: c.name,
    tier: 'lead',
    look: { summary: `${c.name}, drawn the same on every page` },
    refs: [],
    sheet: { status: 'none', history: [] },
    ...(c.kind ? { kind: c.kind } : {})
  }));
  const aspect = ratioOf(spec.aspect);
  const W = 1024;
  const Hpx = Math.round(W / aspect);
  doc.pages = spec.pages.map((ps, pi): Page => {
    const n = pi + 1;
    const panels: Panel[] = ps.panels.map((pp, k) => ({
      id: `p_${n}_${k + 1}`,
      n: k + 1,
      size: pp.size ?? 'medium',
      shot: pp.shot ?? 'medium',
      action: `What happens in panel ${k + 1} of page ${n}`,
      castIds: pp.cast ?? [],
      lines: (pp.lines ?? []).map(
        (ls, j): Line => ({ id: `l_${n}_${k + 1}_${j + 1}`, kind: ls.kind ?? (ls.who ? 'speech' : 'caption'), text: ls.text, ...(ls.who ? { speakerId: ls.who } : {}) })
      )
    }));
    const shape: Pick<Page, 'panels' | 'layout'> = { panels, layout: ps.layout ?? '' };
    const boxes = estimatePanelBoxes(shape, { readingDirection: doc.format.readingDirection, kind: doc.format.kind });
    const keepOut: KeepOut[] = [];
    const heads: SpeakerMark[] = [];
    panels.forEach((p, i) => {
      const f = facesFor(boxes[i], p.n, p.castIds, aspect);
      keepOut.push(...f.keepOut);
      heads.push(...f.heads);
    });
    const qc: QcReport = {
      score: 0.92,
      issues: [],
      panelBoxes: boxes.map((b) => ({ ...b })),
      drawnBoxes: boxes.map((b) => ({ ...b })),
      boxesFrom: 'vision',
      checkedAt: REVIEW_NOW - 1_000_000,
      keepOut,
      heads,
      beats: panels.map((p) => p.n),
      missingSpeakers: [],
      checkV: 2,
      findings: []
    };
    return {
      id: `pg_${n}`,
      n,
      summary: `Page ${n}`,
      layout: ps.layout ?? '',
      panels,
      render: {
        status: 'ready',
        asset: { path: `u_fixture/${spec.id}/pg_${n}.webp`, source: 'generated', at: REVIEW_NOW - 2_000_000, w: W, h: Hpx },
        history: [],
        qc,
        updatedAt: REVIEW_NOW - 2_000_000
      },
      balloons: []
    };
  });
  return doc;
};

// ── The six clean formats ────────────────────────────────────────────────────

const MIRA = { id: 'c_mira', name: 'Mira' };
const ARJUN = { id: 'c_arjun', name: 'Arjun' };

/** Right-to-left manga in Japanese: three panels a page, short lines. */
export const mangaRtl = (): ComicDoc =>
  makeBook({
    id: 'fx_manga',
    title: 'Station at Dawn',
    kind: 'manga',
    aspect: '2:3',
    language: 'ja',
    rtl: true,
    cast: [
      { id: 'c_ren', name: 'Ren' },
      { id: 'c_aoi', name: 'Aoi' }
    ],
    pages: [
      {
        layout: 'Row 1: one wide panel. Row 2: two equal panels.',
        panels: [
          { cast: ['c_ren'], shot: 'wide', lines: [{ text: '朝の駅。' }] },
          { cast: ['c_ren'], lines: [{ who: 'c_ren', text: 'もう来ないの？' }] },
          { cast: ['c_aoi'], lines: [{ who: 'c_aoi', text: 'ここにいるよ。' }] }
        ]
      },
      {
        layout: 'Row 1: two equal panels. Row 2: one wide panel.',
        panels: [
          { cast: ['c_aoi'], lines: [{ who: 'c_aoi', text: '行こう。' }] },
          // Stretched vowels: the long-vowel mark is a letter of no one script (Common), never a foreign one.
          { cast: ['c_ren'], lines: [{ who: 'c_ren', text: 'うーーーん、いいよー。' }] },
          { cast: ['c_ren', 'c_aoi'], shot: 'wide', lines: [{ kind: 'sfx', text: 'ガタン' }] }
        ]
      }
    ]
  });

/** A webtoon: full-width panels stacked down a tall page. */
export const webtoon = (): ComicDoc =>
  makeBook({
    id: 'fx_webtoon',
    title: 'Upstairs Neighbours',
    kind: 'webtoon',
    aspect: '9:16',
    preset: 'webtoon',
    cast: [MIRA, ARJUN],
    pages: [
      {
        layout: 'Stacked vertically: three full-width panels.',
        panels: [
          { cast: ['c_mira'], shot: 'wide', lines: [{ text: 'Monday, too early.' }] },
          { cast: ['c_mira'], lines: [{ who: 'c_mira', text: 'Is that drilling again?' }] },
          { cast: ['c_arjun'], lines: [{ who: 'c_arjun', text: 'Sorry! Almost done.' }] }
        ]
      },
      {
        layout: 'Stacked vertically: three full-width panels.',
        panels: [
          { cast: ['c_mira'], lines: [{ who: 'c_mira', text: 'You said that yesterday.' }] },
          { cast: ['c_arjun'], lines: [{ who: 'c_arjun', text: 'Coffee? My treat.' }] },
          { cast: ['c_mira'], shot: 'close_up', lines: [{ kind: 'thought', who: 'c_mira', text: 'Fine. Just this once.' }] }
        ]
      }
    ]
  });

/** A newspaper strip: one row of three panels. */
export const strip = (): ComicDoc =>
  makeBook({
    id: 'fx_strip',
    title: 'Lunch Break',
    kind: 'strip',
    aspect: '4:1',
    cast: [MIRA, ARJUN],
    pages: [
      {
        layout: 'Row 1: three equal panels.',
        panels: [
          { cast: ['c_mira'], lines: [{ who: 'c_mira', text: 'Soup again?' }] },
          { cast: ['c_arjun'], lines: [{ who: 'c_arjun', text: 'It is Tuesday.' }] },
          { cast: ['c_mira'], lines: [{ who: 'c_mira', text: 'Fair.' }] }
        ]
      }
    ]
  });

/** A storybook for young readers: two big panels a page, one caption each. */
export const storybook = (): ComicDoc =>
  makeBook({
    id: 'fx_storybook',
    title: 'The Duck Who Counted',
    kind: 'storybook',
    aspect: '4:5',
    preset: 'storybook',
    audience: 'children 4-7',
    cast: [{ id: 'c_duck', name: 'Pip', kind: 'animal' }],
    pages: [
      {
        layout: 'Row 1: one wide panel. Row 2: one wide panel.',
        panels: [
          { cast: ['c_duck'], shot: 'wide', size: 'large', lines: [{ text: 'Pip counted the clouds.' }] },
          { cast: ['c_duck'], size: 'large', lines: [{ who: 'c_duck', text: 'One, two, three!' }] }
        ]
      },
      {
        layout: 'Row 1: one wide panel. Row 2: one wide panel.',
        panels: [
          { cast: ['c_duck'], size: 'large', lines: [{ text: 'Then the rain came.' }] },
          { cast: ['c_duck'], size: 'large', lines: [{ who: 'c_duck', text: 'Too many to count!' }] }
        ]
      }
    ]
  });

/** Two pages, mostly wordless, few big panels (the quality bar: The Last Tram's shape, not its pictures). */
export const wordlessTram = (): ComicDoc =>
  makeBook({
    id: 'fx_tram',
    title: 'Night Line',
    kind: 'comic',
    aspect: '2:3',
    cast: [{ id: 'c_rider', name: 'The Rider' }],
    pages: [
      {
        layout: 'Row 1: one wide panel. Row 2: one wide panel.',
        panels: [
          { cast: [], shot: 'establishing', size: 'large', lines: [{ text: 'The last tram.' }] },
          { cast: ['c_rider'], shot: 'wide', size: 'large' }
        ]
      },
      {
        layout: 'Row 1: one splash panel.',
        panels: [{ cast: ['c_rider'], shot: 'wide', size: 'splash' }]
      }
    ]
  });

/** A Telugu comic: Telugu lines, Latin cast names (stripped by the language rule). */
export const teluguComic = (): ComicDoc =>
  makeBook({
    id: 'fx_telugu',
    title: 'Ravi and the Kite',
    kind: 'comic',
    aspect: '2:3',
    language: 'te',
    cast: [
      { id: 'c_ravi', name: 'Ravi' },
      { id: 'c_sita', name: 'Sita' }
    ],
    pages: [
      {
        layout: 'Row 1: one wide panel. Row 2: two equal panels.',
        panels: [
          { cast: ['c_ravi'], shot: 'wide', lines: [{ text: 'పండగ రోజు.' }] },
          { cast: ['c_ravi'], lines: [{ who: 'c_ravi', text: 'గాలిపటం ఎగిరింది!' }] },
          { cast: ['c_sita'], lines: [{ who: 'c_sita', text: 'ఇంకా పైకి!' }] }
        ]
      }
    ]
  });

export const CLEAN_FORMATS: Readonly<Record<string, () => ComicDoc>> = {
  manga_rtl: mangaRtl,
  webtoon,
  strip,
  storybook,
  wordless_tram: wordlessTram,
  telugu: teluguComic
};

/** A plain two-speaker comic page: a wide panel, then two panels with one speaker each. */
export const twoSpeakerPage = (): PageSpec => ({
  layout: 'Row 1: one wide panel. Row 2: two equal panels.',
  panels: [
    { cast: ['c_mira', 'c_arjun'], shot: 'wide', lines: [{ text: 'The market, at noon.' }] },
    { cast: ['c_mira'], lines: [{ who: 'c_mira', text: 'Did you bring the list?' }] },
    { cast: ['c_arjun'], lines: [{ who: 'c_arjun', text: 'I am the list.' }] }
  ]
});

/** An English comic of `pages` two-speaker pages (the base most defects are seeded on). */
export const marketComic = (pages = 1): ComicDoc =>
  makeBook({
    id: 'fx_market',
    title: 'Market Day',
    kind: 'comic',
    aspect: '2:3',
    cast: [MIRA, ARJUN],
    pages: Array.from({ length: pages }, twoSpeakerPage)
  });

/**
 * The market comic with a speech chain: Mira's second balloon in panel 2 is linked to her first (linkTo) and stored
 * just under it, touching it as a chain does by design. `pinned` stores both as the creator's.
 */
export const linkedChainComic = (pinned = false): ComicDoc => {
  const doc = marketComic();
  const panel = pageOf(doc, 1).panels[1];
  panel.lines = [...panel.lines, { id: 'l_1_2_2', kind: 'speech', speakerId: 'c_mira', text: 'And the bags?' }];
  const mine = pinned ? { pinned: true } : {};
  putBalloon(doc, 1, { lineId: 'l_1_2_1', x: 0.06, y: 0.52, w: 0.25, ...mine });
  putBalloon(doc, 1, { lineId: 'l_1_2_2', x: 0.08, y: 0.555, w: 0.25, linkTo: 'l_1_2_1', ...mine });
  return doc;
};

/** A long, busy English comic for the timing test: four panels a page, two speakers each, captions and an SFX. */
export const longComic = (pages: number): ComicDoc =>
  makeBook({
    id: 'fx_long',
    title: 'The Long Week',
    kind: 'comic',
    aspect: '2:3',
    cast: [MIRA, ARJUN],
    pages: Array.from({ length: pages }, (_v, i) => ({
      layout: 'Row 1: two equal panels. Row 2: two equal panels.',
      panels: [
        { cast: ['c_mira', 'c_arjun'], shot: 'wide', lines: [{ text: `Day ${i + 1}, early.` }, { who: 'c_mira', text: 'We are late again.' }] },
        { cast: ['c_arjun'], lines: [{ who: 'c_arjun', text: 'The bus is later.' }] },
        { cast: ['c_mira'], lines: [{ who: 'c_mira', text: 'Run!' }, { kind: 'sfx', text: 'VROOM' }] },
        { cast: ['c_mira', 'c_arjun'], lines: [{ who: 'c_arjun', text: 'We made it.' }, { who: 'c_mira', text: 'Barely.' }] }
      ]
    }))
  });

// ── Seeding defects ──────────────────────────────────────────────────────────

/** The page with this number. */
export const pageOf = (doc: ComicDoc, n: number): Page => doc.pages.find((p) => p.n === n)!;
/** The line with this id (live pages). */
export const lineOf = (doc: ComicDoc, id: string): Line => doc.pages.flatMap((p) => p.panels.flatMap((pn) => pn.lines)).find((l) => l.id === id)!;
/** Store a balloon for a line (replacing any stored one). */
export const putBalloon = (doc: ComicDoc, pageN: number, b: Balloon): void => {
  const page = pageOf(doc, pageN);
  page.balloons = [...page.balloons.filter((x) => x.lineId !== b.lineId), b];
};
/** Patch the page check of a page. */
export const patchQc = (doc: ComicDoc, pageN: number, patch: Partial<QcReport>): void => {
  const page = pageOf(doc, pageN);
  page.render = { ...page.render, qc: { ...page.render.qc!, ...patch } };
};
