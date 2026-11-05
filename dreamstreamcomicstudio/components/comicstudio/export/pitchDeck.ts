// Comic pitch deck (.pptx), made in the browser (platform plan §8 and §12 W1.8): a title slide (the title, the
// logline or the premise, a creator line, the cover art when there is one), a cast slide (the leads, then the
// supports: "Name — role", with each one's model sheet when it is drawn), one slide per drawn page with the page's
// script lines as speaker notes, and a short closing slide. It opens in PowerPoint, Keynote, Google Slides and
// LibreOffice.
//
// Pages come from the same collector and renderer as the PDF (`collectExportSlots`, `renderSlotWith`), so the
// lettering is the board's own. Each picture is a JPEG of at most 1920 px on its long edge (never upscaled) at quality
// ≈ 0.82, about 0.3–0.6 MB for a 2K page; a picture over 1 MB is redrawn at a lower quality and then smaller until it
// fits, and a page that still does not fit is left out and reported. The deck keeps under the `deck.export`
// capability's limits (packages/platform-core/src/capabilities.ts: 40 MB, 120 s): a deck that would be bigger stops
// with an `ExportError` that says so, so a phone never runs out of memory building it. The 120 s is a hard limit: a
// timer aborts the export wherever it is (a picture being drawn, an image load that stalled, the file being made)
// and the export stops with an `ExportError` that says it took too long; nothing downloads.
//
// Pictures enter the deck only as `data:image/jpeg` URIs drawn on our own canvas from the comic's own signed images;
// nothing here fetches anything else, and the renderers never fetch at all. The DeckSpec is checked against the
// platform contract (`checkDeckSpec`, `deckOverlaps`) before services/platformExport.ts makes the file; that module is
// the only door to the renderers (it loads PptxGenJS lazily, in its own chunk).

import { bookOf, readerOf, type Character, type ComicDoc, type LineKind, type Page } from '../../../shared/comic/doc';
import { sameLanguage } from '../../../shared/comic/languages';
import { canServeToOwner } from '../../../shared/comic/safety';
import type { DeckElement, DeckRect, DeckSpec, Slide } from '../../../packages/platform-core/src/contract/deck';
import { DECK_LIMITS } from '../../../packages/platform-core/src/contract/deck';
import { MODEL_LIMITS } from '../../../packages/platform-core/src/contract/schema';
import { getCapability } from '../../../packages/platform-core/src/capabilities';
import { checkDeckSpec, deckOverlaps } from '../../../packages/platform-core/src/models/deck/index';
import { downloadPlatformFile, exportPptx, type PlatformPptxExportOptions } from '../../../services/platformExport';
import { checkCancelled, renderSlotWith, type ExportProgress, type FailedSlot, type SlotRenderers } from './batch';
import { CANCELLED, ExportError, friendlyExportError } from './errors';
import { exportFileStem } from './filenames';
import { prepareExportFonts } from './fonts';
import { renderImageToBlob, type RasterOptions } from './rasterize';
import { collectExportSlots, localizedFor, type ExportSlot, type UrlFor } from './sequence';
import { blobBytes } from './zipExport';

// ── Limits ──────────────────────────────────────────────────────────────────────────────────────────────────────

const DECK_EXPORT_LIMITS = getCapability('deck.export')?.limits;

/** The deck cap: the `deck.export` capability's `maxBytes` (40 MB). Over it the export stops with an `ExportError`. */
export const PITCH_DECK_MAX_BYTES: number = DECK_EXPORT_LIMITS?.maxBytes ?? 40 * 1000000;
/** The time budget: the `deck.export` capability's `timeoutMs` (120 s). */
export const PITCH_DECK_TIMEOUT_MS: number = DECK_EXPORT_LIMITS?.timeoutMs ?? 120000;
/** Long edge of a slide picture (px). Art drawn smaller keeps its own size. */
export const PITCH_DECK_LONG_EDGE = 1920;
/** JPEG quality of a slide picture. */
export const PITCH_DECK_JPEG_QUALITY = 0.82;
/** Every slide picture is at most this many bytes (1 MB, 10^6 bytes as the platform counts). */
export const PITCH_DECK_IMAGE_MAX_BYTES = 1000000;
/** Page slides in one deck (plan §8: ≤ 30); later pages are reported, not silently dropped. */
export const PITCH_DECK_MAX_PAGES = 30;
/** What a deck adds around its pictures (slide XML, notes, the zip directory), counted before the file is made. */
export const PITCH_DECK_OVERHEAD_BYTES = 200000;

/** One encoding of a slide picture. */
export interface JpegStep {
  quality: number;
  /** Long-edge cap in px. */
  edge: number;
}

/** Quality first, then size: the first step that fits under the picture cap is used. */
export const PITCH_DECK_JPEG_STEPS: readonly JpegStep[] = Object.freeze([
  { quality: PITCH_DECK_JPEG_QUALITY, edge: PITCH_DECK_LONG_EDGE },
  { quality: 0.72, edge: PITCH_DECK_LONG_EDGE },
  { quality: 0.62, edge: PITCH_DECK_LONG_EDGE },
  { quality: 0.62, edge: 1600 },
  { quality: 0.62, edge: 1280 },
  { quality: 0.55, edge: 1024 },
]);

/** Characters on the cast slide (the rest are named in its speaker notes). */
export const PITCH_DECK_MAX_CAST = 6;
/** Long edge of a cast member's model-sheet picture (px): it fills at most half the slide's width. */
export const PITCH_DECK_CAST_EDGE = 960;
/** The same ladder for model sheets, scaled to their smaller edge, under the same 1 MB picture cap. */
export const PITCH_DECK_CAST_STEPS: readonly JpegStep[] = Object.freeze(
  PITCH_DECK_JPEG_STEPS.map((s) => ({ quality: s.quality, edge: Math.round((s.edge * PITCH_DECK_CAST_EDGE) / PITCH_DECK_LONG_EDGE) })),
);

const mb = (n: number): string => `${Math.round(n / 100000) / 10} MB`;

// ── Text ────────────────────────────────────────────────────────────────────────────────────────────────────────

// Characters no platform document field may hold (platform-core schema/check.ts): C0 controls but tab and line breaks,
// DEL and C1 controls, bidi embedding/override/isolate controls, and unpaired surrogates.
const BAD_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** Text a deck field may hold, at most `max` characters (cut with an ellipsis). */
const clean = (value: unknown, max: number): string => {
  const text = (typeof value === 'string' ? value : '').replace(BAD_CHARS, '').replace(/\r\n?/g, '\n').trim();
  if (text.length <= max) return text;
  // Never split a surrogate pair at the cut.
  let cut = max - 1;
  const c = text.charCodeAt(cut - 1);
  if (c >= 0xd800 && c <= 0xdbff) cut -= 1;
  return `${text.slice(0, cut).trimEnd()}…`;
};

/** One line of text (line breaks become spaces). */
const oneLine = (value: unknown, max: number): string => clean(typeof value === 'string' ? value.replace(/[\r\n\u2028\u2029\t]+/g, ' ').replace(/\s+/g, ' ') : '', max);

const LOGLINE_MAX = 600;
const CREATOR_MAX = 300;

/** The comic's name as readers see it. */
export const pitchDeckTitle = (book: ComicDoc): string => oneLine(book.cover?.title?.trim() || book.brief?.title?.trim() || '', DECK_LIMITS.title) || 'Untitled comic';

/** The pitch line: the logline, else the premise (synopsis), else nothing. */
export const pitchDeckLogline = (book: ComicDoc): string => clean(book.brief?.logline?.trim() || book.brief?.premise?.trim() || '', LOGLINE_MAX);

/**
 * Who made it: the author's own credit lines (book furniture), else the reader end-card credit, else the studio.
 * Software never puts the owner's account name here (BookSettings.credits).
 */
export const pitchDeckCreatorLine = (book: ComicDoc): string => {
  const credits = (bookOf(book).credits ?? []).map((c) => oneLine(c, 120)).filter(Boolean);
  if (credits.length) return oneLine(credits.slice(0, 3).join(' · '), CREATOR_MAX);
  const end = oneLine(readerOf(book).credits, CREATOR_MAX);
  return end || 'Made in DreamStream Comic Studio';
};

const KIND_TAG: Partial<Record<LineKind, string>> = { thought: ' (thinks)', whisper: ' (whispers)', shout: ' (shouts)' };

/** A page's script, panel by panel ("Maya (whispers): Just one more…"), for the speaker notes. Empty when it has none. */
export const pageScriptNotes = (book: ComicDoc, page: Page | undefined): string => {
  if (!page || !Array.isArray(page.panels)) return '';
  const nameOf = (id?: string): string => oneLine(book.cast?.find((c) => c.id === id)?.name, 80) || 'Someone';
  const blocks: string[] = [];
  for (const panel of page.panels) {
    const lines: string[] = [];
    for (const line of panel?.lines ?? []) {
      const text = oneLine(line?.text, 1000);
      if (!text) continue;
      if (line.kind === 'caption') lines.push(`Caption: ${text}`);
      else if (line.kind === 'sfx') lines.push(`SFX: ${text}`);
      else lines.push(`${nameOf(line.speakerId)}${KIND_TAG[line.kind] ?? ''}: ${text}`);
    }
    if (lines.length) blocks.push([`Panel ${typeof panel.n === 'number' ? panel.n : blocks.length + 1}`, ...lines].join('\n'));
  }
  return clean(blocks.join('\n\n'), DECK_LIMITS.notes);
};

/** The story facts behind the pitch (premise, genre, tone, audience, setting) for the title slide's notes. */
const briefNotes = (book: ComicDoc): string => {
  const b = book.brief;
  if (!b) return '';
  const rows: [string, unknown][] = [
    ['Premise', b.premise],
    ['Genre', b.genre],
    ['Tone', b.tone],
    ['Audience', b.audience],
    ['Setting', b.setting],
  ];
  return clean(
    rows
      .map(([k, v]) => [k, oneLine(v, 800)] as const)
      .filter(([, v]) => v)
      .map(([k, v]) => `${k}: ${v}`)
      .join('\n'),
    DECK_LIMITS.notes,
  );
};

/** The characters a pitch names: the leads, then the supports, in cast order. Extras are background, never listed. */
export const pitchDeckCast = (book: ComicDoc): Character[] => {
  const cast = (Array.isArray(book.cast) ? book.cast : []).filter((c) => c && typeof c === 'object' && oneLine(c.name, 80));
  // A stored character without a tier reads as a support (doc.ts normalises it the same way).
  return [...cast.filter((c) => c.tier === 'lead'), ...cast.filter((c) => c.tier !== 'lead' && c.tier !== 'extra')];
};

/** One cast member as the deck shows them. */
const castMemberOf = (c: Character, picture?: SlidePicture): PitchDeckCastMember => {
  const about = [
    ['Personality', c.personality],
    ['Voice', c.voice],
  ]
    .map(([k, v]) => [k, oneLine(v, 600)] as const)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
  return {
    name: oneLine(c.name, 80),
    // The role ("Pickpocket"); a character without one is introduced by their personality.
    role: oneLine(c.role, 80) || oneLine(c.personality, 80),
    ...(about ? { about } : {}),
    ...(picture ? { picture } : {}),
  };
};

// ── The DeckSpec ────────────────────────────────────────────────────────────────────────────────────────────────

/** A slide picture, ready for the deck. */
export interface SlidePicture {
  /** `data:image/jpeg;base64,…` from our own canvas. */
  dataUri: string;
  bytes: number;
}

/** A character on the cast slide. */
export interface PitchDeckCastMember {
  name: string;
  /** "Pickpocket": the role, else a short personality line; may be empty. */
  role: string;
  /** Personality and voice, for the cast slide's speaker notes. */
  about?: string;
  /** Their model sheet, drawn small. */
  picture?: SlidePicture;
}

export interface PitchDeckContent {
  title: string;
  logline: string;
  creator: string;
  /** Title-slide notes (the story facts). */
  notes?: string;
  cover?: SlidePicture;
  /**
   * The leads, then the supports. Non-empty → a cast slide after the title slide: the first `PITCH_DECK_MAX_CAST`
   * on the slide, everyone in its speaker notes.
   */
  cast?: PitchDeckCastMember[];
  pages: { label: string; caption: string; picture: SlidePicture; notes?: string }[];
}

const text = (id: string, rect: DeckRect, role: 'title' | 'subtitle' | 'body' | 'caption', value: string, align: 'left' | 'center' = 'left'): DeckElement => ({
  kind: 'text',
  id,
  rect,
  layer: 'content',
  role,
  align,
  paragraphs: [{ runs: [{ text: clean(value, MODEL_LIMITS.runText) }] }],
});

const picture = (id: string, rect: DeckRect, pic: SlidePicture, alt: string): DeckElement => ({
  kind: 'image',
  id,
  rect,
  layer: 'content',
  ref: { kind: 'data', dataUri: pic.dataUri },
  alt: clean(alt, MODEL_LIMITS.alt),
  fit: 'contain',
});

/** A thin accent bar down the left edge (background: it may sit under anything). */
const ACCENT_BAR: DeckElement = { kind: 'shape', id: 'accent', rect: [0, 0, 0.012, 1], layer: 'background', shape: 'rect' };

/** Slide fractions rounded down to 1/10000, so a computed rect never pokes past its cell or the slide. */
const r4 = (n: number): number => Math.floor(n * 10000) / 10000;

/** A cast member's name (bold) and role: on one line ("Maya — Pickpocket") in a list, on two under a picture. */
const castText = (id: string, rect: DeckRect, m: PitchDeckCastMember, under: boolean): DeckElement => {
  const name = { text: clean(m.name, MODEL_LIMITS.runText), marks: ['b' as const] };
  const role = clean(m.role, MODEL_LIMITS.runText);
  return {
    kind: 'text',
    id,
    rect,
    layer: 'content',
    role: 'body',
    align: under ? 'center' : 'left',
    ...(under ? { fontSize: 14 } : {}),
    paragraphs: under ? [{ runs: [name] }, ...(role ? [{ runs: [{ text: role }] }] : [])] : [{ runs: [name, ...(role ? [{ text: ` — ${role}` }] : [])] }],
  };
};

/**
 * The cast slide: a heading, then up to `PITCH_DECK_MAX_CAST` characters. With no model sheet to show they are text
 * rows; with any, a grid of cells (picture above, name and role below; the last row centred). Every rect sits inside
 * its own cell, with gaps between cells, so no two content elements overlap. Everyone, with personality and voice, is
 * in the speaker notes.
 */
const castSlide = (members: readonly PitchDeckCastMember[]): Slide => {
  const shown = members.slice(0, PITCH_DECK_MAX_CAST);
  const more = members.length - shown.length;
  const elements: DeckElement[] = [ACCENT_BAR, text('cast-title', [0.08, 0.06, 0.84, 0.14], 'title', 'Cast')];
  const top = 0.24;
  const bottom = more > 0 ? 0.86 : 0.94;
  if (shown.some((m) => m.picture)) {
    const cols = shown.length <= 3 ? shown.length : Math.ceil(shown.length / 2);
    const rows = Math.ceil(shown.length / cols);
    const gap = 0.03;
    const cellW = r4((0.88 - gap * (cols - 1)) / cols);
    const cellH = r4((bottom - top - gap * (rows - 1)) / rows);
    const textH = rows === 1 ? 0.14 : 0.11;
    shown.forEach((m, i) => {
      const row = Math.floor(i / cols);
      const inRow = Math.min(cols, shown.length - row * cols);
      const x = r4(0.06 + ((cols - inRow) * (cellW + gap)) / 2 + (i % cols) * (cellW + gap));
      const y = r4(top + row * (cellH + gap));
      if (m.picture) elements.push(picture(`cast-${i + 1}-sheet`, [x, y, cellW, r4(cellH - textH - 0.01)], m.picture, `${m.name}’s model sheet`));
      elements.push(castText(`cast-${i + 1}`, [x, r4(y + cellH - textH), cellW, textH], m, true));
    });
  } else {
    const gap = 0.02;
    const rowH = r4(Math.min(0.12, (bottom - top - gap * (shown.length - 1)) / shown.length));
    shown.forEach((m, i) => elements.push(castText(`cast-${i + 1}`, [0.08, r4(top + i * (rowH + gap)), 0.84, rowH], m, false)));
  }
  if (more > 0) elements.push(text('cast-more', [0.08, 0.88, 0.84, 0.07], 'caption', `And ${more} more in the speaker notes`));
  const notes = clean(
    members.map((m) => [`${m.name}${m.role ? ` — ${m.role}` : ''}`, ...(m.about ? [m.about] : [])].join('\n')).join('\n\n'),
    DECK_LIMITS.notes,
  );
  return { id: 'cast', layout: 'content', ...(notes ? { notes } : {}), elements };
};

/**
 * The pitch deck as a DeckSpec v1 (16:9, dark): title slide, cast slide (when there is a cast), one `image-full` slide
 * per page, closing slide. Every rect is explicit and no two content elements overlap, so `deckOverlaps` is empty by
 * construction.
 */
export const composePitchDeck = (c: PitchDeckContent): DeckSpec => {
  const titleSlide: Slide = c.cover
    ? {
        id: 'title',
        layout: 'title',
        elements: [
          ACCENT_BAR,
          picture('cover', [0.05, 0.07, 0.34, 0.86], c.cover, `Cover of ${c.title}`),
          text('title', [0.44, 0.14, 0.5, 0.26], 'title', c.title),
          ...(c.logline ? [text('logline', [0.44, 0.42, 0.5, 0.3], 'subtitle', c.logline)] : []),
          text('creator', [0.44, 0.76, 0.5, 0.12], 'caption', c.creator),
        ],
      }
    : {
        id: 'title',
        layout: 'title',
        elements: [
          ACCENT_BAR,
          text('title', [0.08, 0.14, 0.84, 0.26], 'title', c.title),
          ...(c.logline ? [text('logline', [0.08, 0.42, 0.84, 0.3], 'subtitle', c.logline)] : []),
          text('creator', [0.08, 0.76, 0.84, 0.12], 'caption', c.creator),
        ],
      };
  if (c.notes) titleSlide.notes = c.notes;

  const pageSlides: Slide[] = c.pages.map((p, i) => ({
    id: `page-${i + 1}`,
    layout: 'image-full',
    ...(p.notes ? { notes: p.notes } : {}),
    elements: [picture('art', [0.03, 0.04, 0.94, 0.82], p.picture, `${p.label} of ${c.title}`), text('label', [0.03, 0.88, 0.94, 0.08], 'caption', p.caption, 'center')],
  }));

  const endSlide: Slide = {
    id: 'end',
    layout: 'end',
    elements: [
      ACCENT_BAR,
      text('thanks', [0.08, 0.26, 0.84, 0.2], 'title', 'Thank you for reading', 'center'),
      text('name', [0.08, 0.5, 0.84, 0.14], 'subtitle', c.title, 'center'),
      text('credit', [0.08, 0.7, 0.84, 0.1], 'caption', c.creator, 'center'),
    ],
  };

  // A character without a usable name has nothing to show (the builder never passes one; other callers might).
  const named = (c.cast ?? []).filter((m) => m && clean(m.name, MODEL_LIMITS.runText));
  const cast = named.length ? [castSlide(named)] : [];
  return { v: 1, title: c.title, size: '16:9', theme: { preset: 'dark' }, slides: [titleSlide, ...cast, ...pageSlides, endSlide] };
};

/**
 * The platform contract's checks, before any file is made: a valid DeckSpec v1 (`checkDeckSpec`, caps included) whose
 * content elements never overlap (`deckOverlaps`). Throws `ExportError` otherwise.
 */
export const assertExportableDeck = (deck: DeckSpec): void => {
  const checked = checkDeckSpec(deck);
  if (!checked.ok) {
    const first = checked.errors[0];
    throw new ExportError(`This pitch deck couldn’t be put together (${first ? `${first.path || 'deck'}: ${first.message}` : 'invalid deck'}). Try again; if it keeps happening, tell us.`);
  }
  const overlaps = deckOverlaps(deck);
  if (overlaps.length) throw new ExportError(`Some things overlap on slide ${overlaps[0].slideId}, so the pitch deck wasn’t made. Try again; if it keeps happening, tell us.`);
};

// ── Pictures ────────────────────────────────────────────────────────────────────────────────────────────────────

const isJpeg = (b: Uint8Array): boolean => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;

/** Bytes → base64, in slices (a 1 MB picture would overflow `String.fromCharCode(...all)`). */
export const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + 0x8000)));
  return btoa(binary);
};

/**
 * `work`, but settled with `ExportError(CANCELLED)` the moment `signal` fires, even when `work` itself never settles
 * (a renderer that ignores the signal, an image load or a chunk load that stalled). What `work` does later is ignored.
 */
export const untilAborted = <T>(work: Promise<T>, signal?: AbortSignal): Promise<T> => {
  if (!signal) return work;
  if (signal.aborted) {
    work.catch(() => undefined);
    return Promise.reject(new ExportError(CANCELLED));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new ExportError(CANCELLED));
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
};

/**
 * One picture as a JPEG of at most `maxBytes`: `draw` runs at each step (quality, then size) until one fits. Throws
 * `ExportError` (code `too_big`) when even the last step is over, or when the browser did not write a JPEG; a fired
 * `base.signal` stops it at once, mid-draw included.
 */
const rasterJpeg = async (
  label: string,
  draw: (raster: RasterOptions) => Promise<Blob>,
  base: RasterOptions,
  opts: { maxBytes?: number; steps?: readonly JpegStep[] },
): Promise<SlidePicture & { step: JpegStep }> => {
  const maxBytes = opts.maxBytes ?? PITCH_DECK_IMAGE_MAX_BYTES;
  const steps = opts.steps ?? PITCH_DECK_JPEG_STEPS;
  let smallest = Infinity;
  for (const step of steps) {
    checkCancelled(base.signal);
    const blob = await untilAborted(draw({ ...base, mime: 'image/jpeg', quality: step.quality, maxEdge: step.edge }), base.signal);
    checkCancelled(base.signal);
    const bytes = await blobBytes(blob);
    if (!isJpeg(bytes)) throw new ExportError(`${label} couldn’t be saved as a JPEG picture in this browser. Try another browser, or download the PDF.`);
    if (bytes.length <= maxBytes) return { dataUri: `data:image/jpeg;base64,${bytesToBase64(bytes)}`, bytes: bytes.length, step };
    smallest = Math.min(smallest, bytes.length);
  }
  throw new ExportError(`${label} is too detailed for a slide: even smaller it is ${mb(smallest)}, over the ${mb(maxBytes)} a slide picture may be. The PDF has it in full.`, 'too_big');
};

/**
 * One slot as a JPEG of at most `maxBytes`: drawn at each step (quality, then size) until one fits. Throws
 * `ExportError` (code `too_big`) when even the last step is over, or when the browser did not write a JPEG.
 */
export async function rasterSlideJpeg(
  book: ComicDoc,
  slot: ExportSlot,
  base: RasterOptions,
  renderers: SlotRenderers & { coverUrl?: string },
  opts: { maxBytes?: number; steps?: readonly JpegStep[] } = {},
): Promise<SlidePicture & { step: JpegStep }> {
  return rasterJpeg(slot.label, (raster) => renderSlotWith(book, slot, raster, renderers), base, opts);
}

// ── Building and exporting ──────────────────────────────────────────────────────────────────────────────────────

export interface PitchDeckOptions extends SlotRenderers {
  onProgress?: (progress: ExportProgress) => void;
  signal?: AbortSignal;
  /** Export this edition of `doc` (localized here; the file name gets "-te"). Default: the doc as given. */
  lang?: string;
  /** The deck cap (default `PITCH_DECK_MAX_BYTES`). */
  maxBytes?: number;
  /** The time budget (default `PITCH_DECK_TIMEOUT_MS`): a hard limit, enforced by a timer. */
  timeoutMs?: number;
  /** The per-picture cap (default `PITCH_DECK_IMAGE_MAX_BYTES`). */
  imageMaxBytes?: number;
  /** Counted toward the cap before the file is made (default `PITCH_DECK_OVERHEAD_BYTES`). */
  overheadBytes?: number;
  /** Clock read between pictures (tests); the budget's timer runs on the real clock. */
  now?: () => number;
  /** The renderers (tests); default the lazy pptx chunk. */
  load?: PlatformPptxExportOptions['load'];
  /** Override the download (tests). */
  download?: (blob: Blob, fileName: string) => void;
}

export interface PitchDeckBuild {
  deck: DeckSpec;
  /** Page slides in the deck. */
  pages: number;
  /** Pictures that failed to draw (reported; the rest of the deck is still made). */
  failed: FailedSlot[];
  /** Pages left out, and why (not drawn, withheld, past the page limit). */
  skipped: string[];
  /** A lettering face didn't load (the pictures may use a fallback face). */
  notice?: string;
  /** Bytes of every picture in the deck. */
  imageBytes: number;
  /** Pictures drawn or tried (the cover, the cast's model sheets, the pages): progress steps before the file is made. */
  steps: number;
  /** The download name without extension ("the-saffron-thief-te-pitch-deck"). */
  fileStem: string;
}

export interface PitchDeckResult {
  fileName: string;
  slides: number;
  pages: number;
  /** File size in bytes. */
  bytes: number;
  failed: FailedSlot[];
  skipped: string[];
  notice?: string;
}

const tooBig = (bytes: number, cap: number): ExportError =>
  new ExportError(`This pitch deck would be over ${mb(cap)} (${mb(bytes)} so far), too big to make safely on this device. Download the PDF instead.`, 'too_big');

const tooSlow = (timeoutMs: number): ExportError =>
  new ExportError(`Making this pitch deck took longer than ${Math.round(timeoutMs / 1000)} seconds, so it stopped. Try again on a faster connection, or download the PDF instead.`);

const NOTHING = 'Nothing to export yet — draw at least one page first.';

// ── The time budget ─────────────────────────────────────────────────────────────────────────────────────────────

/** `setTimeout` fires at once past 2^31 − 1 ms, so a budget that long (or not finite) is not timed. */
const MAX_TIMER_MS = 2147483647;

/** One export's time budget (`deck.export`'s `timeoutMs`), started when the export starts. */
interface Budget {
  /** Fires on the caller's cancel and when the budget runs out. Every picture, load and the file are given it. */
  signal: AbortSignal;
  /** Throws `tooSlow` once `now()` says the budget is spent (read between pictures, so a test clock can drive it). */
  check: () => void;
}

/**
 * Runs `work` under the time budget: an internal AbortController follows `opts.signal` and a timer aborts it when the
 * budget runs out, wherever the work is (a picture being drawn, an image load that stalled, the file being made). The
 * timer is cleared on the way out, so it lives only as long as the export (browser code; the backend is not involved).
 * An abort that came from the budget surfaces as the friendly `tooSlow` error; the caller's own cancel stays
 * `ExportError(CANCELLED)`.
 */
const withinBudget = async <T>(opts: PitchDeckOptions, work: (budget: Budget) => Promise<T>): Promise<T> => {
  const now = opts.now ?? Date.now;
  const started = now();
  const timeoutMs = opts.timeoutMs ?? PITCH_DECK_TIMEOUT_MS;
  const outer = opts.signal;
  const ctl = new AbortController();
  let expired = false;
  const expire = () => {
    expired = true;
    ctl.abort();
  };
  const follow = () => ctl.abort();
  if (outer?.aborted) ctl.abort();
  else outer?.addEventListener('abort', follow, { once: true });
  const timer = Number.isFinite(timeoutMs) && timeoutMs <= MAX_TIMER_MS ? setTimeout(expire, Math.max(0, timeoutMs)) : undefined;
  const budget: Budget = {
    signal: ctl.signal,
    check: () => {
      if (now() - started <= timeoutMs) return;
      expire();
      throw tooSlow(timeoutMs);
    },
  };
  try {
    return await work(budget);
  } catch (err) {
    // The budget's abort surfaces as CANCELLED wherever the work was: say what really stopped it.
    if (expired && !outer?.aborted) throw tooSlow(timeoutMs);
    throw err;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    outer?.removeEventListener('abort', follow);
  }
};

// ── Building and exporting ──────────────────────────────────────────────────────────────────────────────────────

/** A picture the deck needs: the cover, a cast member's model sheet or a page. */
interface PictureJob {
  /** For the failure list ("Page 5", "Maya’s model sheet"). */
  label: string;
  /** For the progress line ("page 5", "Maya’s model sheet"). */
  what: string;
  draw: (base: RasterOptions) => Promise<SlidePicture>;
}

const lowerFirst = (s: string): string => `${s.charAt(0).toLowerCase()}${s.slice(1)}`;

/** `buildComicPitchDeck` inside an export's budget (`exportComicPitchDeck` makes the file under the same one). */
async function buildWithin(doc: ComicDoc, urlFor: UrlFor, opts: PitchDeckOptions, budget: Budget): Promise<PitchDeckBuild> {
  const { signal } = budget;
  const maxBytes = opts.maxBytes ?? PITCH_DECK_MAX_BYTES;
  const overhead = opts.overheadBytes ?? PITCH_DECK_OVERHEAD_BYTES;

  const book = localizedFor(doc, opts.lang);
  const { slots, skipped } = collectExportSlots(book, urlFor, { plates: false });
  const cover = slots.find((s) => s.kind === 'cover');
  const allPages = slots.filter((s) => s.kind === 'page');
  if (!allPages.length) throw new ExportError(NOTHING);
  const pages = allPages.slice(0, PITCH_DECK_MAX_PAGES);
  if (allPages.length > pages.length) {
    const first = allPages[pages.length].label;
    const last = allPages[allPages.length - 1].label;
    skipped.push(`${first === last ? first : `${first} to ${last.replace(/^Page /, '')}`} (a pitch deck holds up to ${PITCH_DECK_MAX_PAGES} pages)`);
  }
  checkCancelled(signal);

  const overrides = !!(opts.renderPage || opts.renderImage || opts.renderCover || opts.renderPlate);
  const fonts = overrides ? null : await untilAborted(prepareExportFonts([book]), signal);
  checkCancelled(signal);

  const base: RasterOptions = { signal, mime: 'image/jpeg', quality: PITCH_DECK_JPEG_QUALITY, maxEdge: PITCH_DECK_LONG_EDGE, measure: fonts?.measure };
  const renderers = { ...opts, coverUrl: cover?.url };
  const imageOpts = { maxBytes: opts.imageMaxBytes };
  const slotJob = (slot: ExportSlot): PictureJob => ({
    label: slot.label,
    what: lowerFirst(slot.label),
    draw: (b) => rasterSlideJpeg(book, slot, b, renderers, imageOpts),
  });
  const coverJob = cover ? slotJob(cover) : undefined;
  const pageJobs = new Map(pages.map((s) => [s, slotJob(s)] as const));

  // The cast slide's model sheets, drawn small: only a sheet the owner may see (one the safety check withheld is never
  // fetched) with a signed link. A character without one keeps their text row.
  const cast = pitchDeckCast(book);
  const sheetJobs = new Map<Character, PictureJob>();
  for (const c of cast.slice(0, PITCH_DECK_MAX_CAST)) {
    const asset = c.sheet?.asset;
    const url = asset?.path && canServeToOwner(asset) ? urlFor(asset) : undefined;
    if (!url) continue;
    const label = `${oneLine(c.name, 80)}’s model sheet`;
    const plain = opts.renderImage ?? renderImageToBlob;
    sheetJobs.set(c, { label, what: label, draw: (b) => rasterJpeg(label, (raster) => plain(url, raster), b, { ...imageOpts, steps: PITCH_DECK_CAST_STEPS }) });
  }

  const work = [...(coverJob ? [coverJob] : []), ...sheetJobs.values(), ...pageJobs.values()];
  const total = work.length + 1;
  const failed: FailedSlot[] = [];
  const drawn = new Map<PictureJob, SlidePicture>();
  let imageBytes = 0;

  for (let i = 0; i < work.length; i += 1) {
    checkCancelled(signal);
    budget.check();
    const job = work[i];
    opts.onProgress?.({ done: i, total, label: `Rendering ${job.what} (${i + 1} of ${work.length})…` });
    let pic: SlidePicture;
    try {
      pic = await job.draw(base);
    } catch (err) {
      // A cancel, or the budget running out, stops the export; any other failure is reported and the deck goes on.
      checkCancelled(signal);
      failed.push({ label: job.label, message: friendlyExportError(err) });
      continue;
    }
    imageBytes += pic.bytes;
    if (imageBytes + overhead > maxBytes) throw tooBig(imageBytes + overhead, maxBytes);
    drawn.set(job, pic);
  }
  checkCancelled(signal);
  budget.check();

  const pageSlides = pages.filter((s) => drawn.has(pageJobs.get(s)!));
  if (!pageSlides.length) throw new ExportError(`Couldn’t export any pages. ${failed[0]?.message || ''}`.trim());

  const pictureOf = (job?: PictureJob): SlidePicture | undefined => (job ? drawn.get(job) : undefined);
  const title = pitchDeckTitle(book);
  const deck = composePitchDeck({
    title,
    logline: pitchDeckLogline(book),
    creator: pitchDeckCreatorLine(book),
    notes: briefNotes(book) || undefined,
    cover: pictureOf(coverJob),
    cast: cast.map((c) => castMemberOf(c, pictureOf(sheetJobs.get(c)))),
    pages: pageSlides.map((s) => {
      const page = book.pages.find((p) => p.id === s.page?.id) ?? s.page;
      const chapter = oneLine(page?.chapterTitle, 60);
      return {
        label: s.label,
        caption: chapter ? `${s.label} · ${chapter}` : s.label,
        picture: pictureOf(pageJobs.get(s))!,
        notes: pageScriptNotes(book, page) || undefined,
      };
    }),
  });
  assertExportableDeck(deck);
  const lang = opts.lang && !sameLanguage(opts.lang, doc.format?.language || 'en') ? opts.lang : undefined;
  return {
    deck,
    pages: pageSlides.length,
    failed,
    skipped,
    imageBytes,
    steps: work.length,
    fileStem: `${exportFileStem(book, lang)}-pitch-deck`,
    ...(fonts?.notice ? { notice: fonts.notice } : {}),
  };
}

/**
 * The comic as a pitch deck (plan §8 `buildComicPitchDeck(doc, urlFor)`): every picture drawn, the DeckSpec composed and
 * checked. Throws `ExportError`: nothing drawn, every page failed, over the deck cap or the time budget, or cancelled.
 */
export async function buildComicPitchDeck(doc: ComicDoc, urlFor: UrlFor, opts: PitchDeckOptions = {}): Promise<PitchDeckBuild> {
  return withinBudget(opts, (budget) => buildWithin(doc, urlFor, opts, budget));
}

/**
 * Builds the pitch deck, makes the .pptx and downloads it, all inside one time budget. The file is refused over the
 * deck cap (`exportPptx`'s `maxBytes`), like the pictures before it. Throws `ExportError` (see `buildComicPitchDeck`);
 * a cancel throws `ExportError(CANCELLED)`.
 */
export async function exportComicPitchDeck(doc: ComicDoc, urlFor: UrlFor, opts: PitchDeckOptions = {}): Promise<PitchDeckResult> {
  return withinBudget(opts, async (budget) => {
    const built = await buildWithin(doc, urlFor, opts, budget);
    const total = built.steps + 1;
    opts.onProgress?.({ done: built.steps, total, label: 'Building the pitch deck…' });
    // The renderer's chunk load and the zip run under the budget too: a stalled load or a slow phone stops at the limit.
    const file = await untilAborted(
      exportPptx(built.deck, {
        maxBytes: opts.maxBytes ?? PITCH_DECK_MAX_BYTES,
        signal: budget.signal,
        fileName: built.fileStem,
        ...(opts.load ? { load: opts.load } : {}),
      }),
      budget.signal,
    );
    checkCancelled(budget.signal);
    downloadPlatformFile(file, opts.download);
    opts.onProgress?.({ done: total, total, label: 'Done' });
    return {
      fileName: file.fileName,
      slides: built.deck.slides.length,
      pages: built.pages,
      bytes: file.size,
      failed: built.failed,
      skipped: built.skipped,
      ...(built.notice ? { notice: built.notice } : {}),
    };
  });
}
