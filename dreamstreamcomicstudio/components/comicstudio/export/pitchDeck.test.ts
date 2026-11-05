// @vitest-environment jsdom
//
// Comic pitch deck (plan §8, §12 W1.8): the slides and their order, JPEG pictures of at most 1 MB (quality steps
// down, then size), the deck cap and time budget from the `deck.export` capability, cancel, and a real .pptx made by
// the lazy renderer through services/platformExport. Synthetic fixtures only; the canvas is replaced by renderers
// that return JPEG bytes of a chosen size.
import JSZip from 'jszip';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { emptyRender, type ComicDoc, type Page } from '../../../shared/comic/doc';
import { getCapability } from '../../../packages/platform-core/src/capabilities';
import { checkDeckSpec, deckOverlaps } from '../../../packages/platform-core/src/models/deck/index';
import type { DeckImage, DeckSpec, DeckText } from '../../../packages/platform-core/src/contract/deck';
import { makeSampleDoc, fakeUrlFor } from '../board/__fixtures__/sampleDoc';
import { makeBook } from './__fixtures__/books';
import { CANCELLED, ExportError } from './errors';
import type { RasterOptions } from './rasterize';
import { collectExportSlots } from './sequence';
import { blobBytes } from './zipExport';
import {
  PITCH_DECK_CAST_EDGE,
  PITCH_DECK_CAST_STEPS,
  PITCH_DECK_IMAGE_MAX_BYTES,
  PITCH_DECK_JPEG_QUALITY,
  PITCH_DECK_JPEG_STEPS,
  PITCH_DECK_LONG_EDGE,
  PITCH_DECK_MAX_BYTES,
  PITCH_DECK_MAX_CAST,
  PITCH_DECK_MAX_PAGES,
  PITCH_DECK_TIMEOUT_MS,
  assertExportableDeck,
  buildComicPitchDeck,
  composePitchDeck,
  exportComicPitchDeck,
  pageScriptNotes,
  pitchDeckCast,
  rasterSlideJpeg,
  untilAborted,
  type PitchDeckCastMember,
} from './pitchDeck';

// ── Fixtures ────────────────────────────────────────────────────────────────────────────────────────────────────

/** A real (progressive, 1×1) JPEG; its header is what the renderer reads for the picture's size. */
const JPEG_1x1 = Uint8Array.from(
  atob('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA='),
  (c) => c.charCodeAt(0),
);

/**
 * A valid JPEG of about `size` bytes: SOI, COM segments of seeded random bytes (they do not compress, like real
 * photo data), then the 1×1 image.
 */
const makeJpeg = (size: number, seed = 7): Uint8Array => {
  const tail = JPEG_1x1.subarray(2);
  const out = new Uint8Array(Math.max(size, tail.length + 2));
  out[0] = 0xff;
  out[1] = 0xd8;
  let at = 2;
  let x = seed >>> 0 || 1;
  let room = out.length - tail.length - at;
  while (room >= 5) {
    const n = Math.min(65533, room - 4);
    out[at] = 0xff;
    out[at + 1] = 0xfe;
    out[at + 2] = ((n + 2) >> 8) & 0xff;
    out[at + 3] = (n + 2) & 0xff;
    for (let i = 0; i < n; i++) {
      x ^= x << 13;
      x ^= x >>> 17;
      x ^= x << 5;
      out[at + 4 + i] = x & 0xff;
    }
    at += n + 4;
    room = out.length - tail.length - at;
  }
  out.set(tail, at);
  return out.subarray(0, at + tail.length);
};

const jpegBlob = (size: number, seed?: number): Blob => new Blob([makeJpeg(size, seed) as BlobPart], { type: 'image/jpeg' });

/** Bytes a fake page draws to: `full` at the first step, less at a lower quality or a smaller edge. */
const sized = (full: number, o: RasterOptions): number => Math.round(full * ((o.quality ?? 0.9) / PITCH_DECK_JPEG_QUALITY) * ((o.maxEdge ?? PITCH_DECK_LONG_EDGE) / PITCH_DECK_LONG_EDGE) ** 2);

const renderersOf = (sizes: { cover?: number; page?: number | ((p: Page) => number); sheet?: number } = {}) => {
  const calls: { what: string; opts: RasterOptions }[] = [];
  let seed = 1;
  const renderPage = vi.fn(async (_d: ComicDoc, page: Page, _url: string, opts: RasterOptions) => {
    calls.push({ what: page.id, opts });
    const full = typeof sizes.page === 'function' ? sizes.page(page) : (sizes.page ?? 300_000);
    return jpegBlob(sized(full, opts), (seed += 1));
  });
  const renderCover = vi.fn(async (_d: ComicDoc, _url: string, opts: RasterOptions) => {
    calls.push({ what: 'cover', opts });
    return jpegBlob(sized(sizes.cover ?? 250_000, opts), (seed += 1));
  });
  // The cast's model sheets are drawn as plain images.
  const renderImage = vi.fn(async (url: string, opts: RasterOptions) => {
    calls.push({ what: `image ${url}`, opts });
    return jpegBlob(sized(sizes.sheet ?? 400_000, opts), (seed += 1));
  });
  return { renderPage, renderCover, renderImage, calls };
};

const MAYA_SHEET = `image ${fakeUrlFor('u/proj/sheets/maya-v2.png')}`;
const slideIds = (deck: DeckSpec): string[] => deck.slides.map((s) => s.id);

const unzip = async (blob: Blob) => JSZip.loadAsync(await blobBytes(blob));
const slideXml = async (zip: JSZip, n: number) => zip.file(`ppt/slides/slide${n}.xml`)!.async('string');
const slideCount = (zip: JSZip) => Object.keys(zip.files).filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f)).length;

const textsOf = (deck: DeckSpec, slide: number): string[] =>
  deck.slides[slide].elements.filter((e): e is DeckText => e.kind === 'text').map((e) => e.paragraphs.map((p) => p.runs.map((r) => r.text).join('')).join('\n'));
const imagesOf = (deck: DeckSpec): DeckImage[] => deck.slides.flatMap((s) => s.elements.filter((e): e is DeckImage => e.kind === 'image'));
const decodedBytes = (dataUri: string): number => atob(dataUri.slice(dataUri.indexOf(',') + 1)).length;

/** The sample book with `n` drawn pages. */
const bookWithPages = (n: number): ComicDoc =>
  makeBook((d) => {
    const proto = d.pages[0];
    d.pages = Array.from({ length: n }, (_, i) => ({ ...proto, id: `pg_x${i + 1}`, n: i + 1, render: { ...proto.render, asset: { ...proto.render.asset!, path: `u/proj/pages/x${i + 1}.png` } } }));
    d.format.pageCount = n;
  });

// ── The deck ────────────────────────────────────────────────────────────────────────────────────────────────────

describe('pitch deck: slides', () => {
  it('a drawn comic gives a title slide (with the cover), a cast slide, one slide per drawn page in reading order, and a closing slide', async () => {
    const r = renderersOf();
    const built = await buildComicPitchDeck(makeBook(), fakeUrlFor, r);
    expect(slideIds(built.deck)).toEqual(['title', 'cast', 'page-1', 'page-2', 'end']);
    expect(built.deck.slides.map((s) => s.layout)).toEqual(['title', 'content', 'image-full', 'image-full', 'end']);
    expect(r.calls.map((c) => c.what)).toEqual(['cover', MAYA_SHEET, 'pg_1', 'pg_5']);
    expect(built.pages).toBe(2);
    // Title slide: the title, the logline, the creator line (the author's own credit, never the account name).
    expect(textsOf(built.deck, 0)).toEqual(['The Saffron Thief', 'A pickpocket steals saffron to pay for her brother’s surgery.', 'Story by Maya’s friends']);
    expect(built.deck.slides[0].elements.some((e) => e.kind === 'image' && e.alt === 'Cover of The Saffron Thief')).toBe(true);
    // Cast slide: the lead, then the support (the extra is background), each name over their role.
    expect(textsOf(built.deck, 1)).toEqual(['Cast', 'Maya\nPickpocket', 'Arjun\nCop']);
    expect(textsOf(built.deck, 2)).toEqual(['Page 1']);
    expect(textsOf(built.deck, 3)).toEqual(['Page 5']);
    expect(textsOf(built.deck, 4)).toEqual(['Thank you for reading', 'The Saffron Thief', 'Story by Maya’s friends']);
    // Undrawn pages are reported, never silently dropped.
    expect(built.skipped).toEqual(['Page 2 (not drawn yet)', 'Page 3 (not drawn yet)', 'Page 4 (not drawn yet)', 'Page 6 (not drawn yet)']);
    // The contract's own checks pass on what we built.
    expect(checkDeckSpec(built.deck).ok).toBe(true);
    expect(deckOverlaps(built.deck)).toEqual([]);
  });

  it('speaker notes carry each page’s script lines; the title slide carries the story facts', async () => {
    const built = await buildComicPitchDeck(makeBook(), fakeUrlFor, renderersOf());
    const notes = built.deck.slides[2].notes!;
    expect(notes.split('\n')).toEqual([
      'Panel 1',
      'Caption: Old Delhi. Before the heat.',
      '',
      'Panel 2',
      'Maya (whispers): Just one more…',
      '',
      'Panel 3',
      'Vendor (shouts): Thief!',
      'Arjun: You owe me an explanation, Maya.',
      'SFX: GRAB',
    ]);
    expect(built.deck.slides[0].notes).toContain('Premise: Maya works the Old Delhi spice market');
    expect(built.deck.slides[4].notes).toBeUndefined();
    // A page without script lines has no notes field at all.
    const page = { ...makeBook().pages[0], panels: [] };
    expect(pageScriptNotes(makeBook(), page)).toBe('');
  });

  it('without a cover the title slide is text only; without a logline the premise stands in, and the studio is the creator', async () => {
    const doc = makeBook((d) => {
      d.cover.render = emptyRender();
      d.brief.logline = '';
      d.book = undefined;
    });
    const built = await buildComicPitchDeck(doc, fakeUrlFor, renderersOf());
    expect(built.deck.slides[0].elements.some((e) => e.kind === 'image')).toBe(false);
    expect(textsOf(built.deck, 0)).toEqual(['The Saffron Thief', 'Maya works the Old Delhi spice market; her best friend Arjun is a cop.', 'Made in DreamStream Comic Studio']);
    expect(deckOverlaps(built.deck)).toEqual([]);
  });

  it('holds at most 30 page slides and reports the rest', async () => {
    const built = await buildComicPitchDeck(bookWithPages(PITCH_DECK_MAX_PAGES + 5), fakeUrlFor, renderersOf({ page: 20_000, cover: 20_000 }));
    expect(built.deck.slides).toHaveLength(PITCH_DECK_MAX_PAGES + 3);
    expect(textsOf(built.deck, PITCH_DECK_MAX_PAGES + 1)).toEqual([`Page ${PITCH_DECK_MAX_PAGES}`]);
    expect(built.skipped).toEqual([`Page 31 to 35 (a pitch deck holds up to ${PITCH_DECK_MAX_PAGES} pages)`]);
  });

  it('text a document field may not hold (controls, bidi overrides) is dropped, so the deck still passes the contract', async () => {
    const doc = makeBook((d) => {
      d.cover.title = 'The \u202eSaffron\u0007 Thief\nPart 2';
    });
    const built = await buildComicPitchDeck(doc, fakeUrlFor, renderersOf());
    expect(built.deck.title).toBe('The Saffron Thief Part 2');
    expect(checkDeckSpec(built.deck).ok).toBe(true);
  });

  it('exports an edition: the edition’s title and script, and "-te" in the file name', async () => {
    const download = vi.fn();
    const result = await exportComicPitchDeck(makeBook(), fakeUrlFor, { ...renderersOf(), lang: 'te', download });
    expect(result.fileName).toBe('కుంకుమపువ్వు-దొంగ-te-pitch-deck.pptx');
    const built = await buildComicPitchDeck(makeBook(), fakeUrlFor, { ...renderersOf(), lang: 'te' });
    expect(built.deck.title).toBe('కుంకుమపువ్వు దొంగ');
    expect(built.deck.slides[2].notes).toContain('దొంగ!');
  });

  it('refuses a comic with nothing drawn', async () => {
    const doc = makeSampleDoc((d) => {
      d.cover.render = emptyRender();
      d.pages = d.pages.map((p) => ({ ...p, render: emptyRender() }));
    });
    await expect(buildComicPitchDeck(doc, fakeUrlFor, renderersOf())).rejects.toThrow(/Nothing to export yet/);
  });
});

describe('pitch deck: the cast slide', () => {
  it('follows the title slide: the leads, then the supports, each one’s model sheet above their name; everyone in the notes', async () => {
    const doc = makeBook((d) => {
      d.cast[0].personality = 'Quick, proud, loyal to her brother';
      d.cast[0].voice = 'Short sentences, street slang';
      // A support listed before the lead still comes after them.
      d.cast = [d.cast[1], d.cast[2], d.cast[0]];
    });
    const built = await buildComicPitchDeck(doc, fakeUrlFor, renderersOf());
    const cast = built.deck.slides[1];
    expect(cast.id).toBe('cast');
    expect(textsOf(built.deck, 1)).toEqual(['Cast', 'Maya\nPickpocket', 'Arjun\nCop']);
    expect(cast.elements.filter((e): e is DeckImage => e.kind === 'image').map((e) => e.alt)).toEqual(['Maya’s model sheet']);
    expect(cast.notes!.split('\n')).toEqual(['Maya — Pickpocket', 'Personality: Quick, proud, loyal to her brother', 'Voice: Short sentences, street slang', '', 'Arjun — Cop']);
    expect(pitchDeckCast(doc).map((c) => c.name)).toEqual(['Maya', 'Arjun']);
    expect(checkDeckSpec(built.deck).ok).toBe(true);
    expect(deckOverlaps(built.deck)).toEqual([]);
  });

  it('a comic with no cast, or only extras, has no cast slide and draws no model sheet', async () => {
    const castless = (d: ComicDoc) => {
      d.cast = [];
    };
    const extrasOnly = (d: ComicDoc) => {
      d.cast = d.cast.map((c) => ({ ...c, tier: 'extra' as const }));
    };
    for (const mutate of [castless, extrasOnly]) {
      const r = renderersOf();
      const built = await buildComicPitchDeck(makeBook(mutate), fakeUrlFor, r);
      expect(slideIds(built.deck)).toEqual(['title', 'page-1', 'page-2', 'end']);
      expect(r.renderImage).not.toHaveBeenCalled();
      expect(checkDeckSpec(built.deck).ok).toBe(true);
      expect(deckOverlaps(built.deck)).toEqual([]);
    }
  });

  it('with no model sheet drawn the cast are text rows, "Name — role"; a character without a role shows their personality', async () => {
    const doc = makeBook((d) => {
      d.cast = d.cast.map((c) => ({ ...c, sheet: { status: 'none', history: [] } }));
      delete d.cast[1].role;
      d.cast[1].personality = 'By the book';
    });
    const r = renderersOf();
    const built = await buildComicPitchDeck(doc, fakeUrlFor, r);
    expect(textsOf(built.deck, 1)).toEqual(['Cast', 'Maya — Pickpocket', 'Arjun — By the book']);
    expect(built.deck.slides[1].elements.some((e) => e.kind === 'image')).toBe(false);
    expect(r.renderImage).not.toHaveBeenCalled();
    expect(deckOverlaps(built.deck)).toEqual([]);
  });

  it('a model sheet the safety check withheld is never fetched; one that fails to draw is reported; the name stays either way', async () => {
    const withheld = makeBook((d) => {
      d.cast[0].sheet.asset = { ...d.cast[0].sheet.asset!, safety: { quarantined: true, at: 1 } };
    });
    const r = renderersOf();
    const built = await buildComicPitchDeck(withheld, fakeUrlFor, r);
    expect(r.renderImage).not.toHaveBeenCalled();
    expect(textsOf(built.deck, 1)).toEqual(['Cast', 'Maya — Pickpocket', 'Arjun — Cop']);
    expect(built.failed).toEqual([]);

    const broken = renderersOf();
    broken.renderImage.mockRejectedValue(new ExportError('The image link expired. Refresh the page and try again.'));
    const built2 = await buildComicPitchDeck(makeBook(), fakeUrlFor, broken);
    expect(built2.failed).toEqual([{ label: 'Maya’s model sheet', message: 'The image link expired. Refresh the page and try again.' }]);
    expect(slideIds(built2.deck)).toEqual(['title', 'cast', 'page-1', 'page-2', 'end']);
    expect(textsOf(built2.deck, 1)).toEqual(['Cast', 'Maya — Pickpocket', 'Arjun — Cop']);
  });

  it('a model sheet over 1 MB steps down the same ladder at its smaller edge', async () => {
    const r = renderersOf({ sheet: 6_000_000 });
    const built = await buildComicPitchDeck(makeBook(), fakeUrlFor, r);
    const tries = r.calls.filter((c) => c.what === MAYA_SHEET).map((c) => [c.opts.quality, c.opts.maxEdge]);
    expect(tries).toEqual(PITCH_DECK_CAST_STEPS.slice(0, 4).map((s) => [s.quality, s.edge]));
    expect(PITCH_DECK_CAST_STEPS.map((s) => s.quality)).toEqual(PITCH_DECK_JPEG_STEPS.map((s) => s.quality));
    const sheet = built.deck.slides[1].elements.find((e): e is DeckImage => e.kind === 'image')!;
    expect(decodedBytes((sheet.ref as { dataUri: string }).dataUri)).toBeLessThanOrEqual(PITCH_DECK_IMAGE_MAX_BYTES);
  });
});

describe('pitch deck: pictures', () => {
  it('every picture is a data:image/jpeg drawn at a 1920 px long edge and quality 0.82, at most 1 MB', async () => {
    const r = renderersOf({ page: 600_000 });
    const built = await buildComicPitchDeck(makeBook(), fakeUrlFor, r);
    const images = imagesOf(built.deck);
    expect(images).toHaveLength(4); // the cover, Maya's model sheet, two pages
    for (const img of images) {
      expect(img.ref.kind).toBe('data');
      const uri = (img.ref as { dataUri: string }).dataUri;
      expect(uri.startsWith('data:image/jpeg;base64,')).toBe(true);
      expect(decodedBytes(uri)).toBeLessThanOrEqual(PITCH_DECK_IMAGE_MAX_BYTES);
    }
    for (const c of r.calls.filter((c) => c.what !== MAYA_SHEET)) expect(c.opts).toMatchObject({ mime: 'image/jpeg', quality: PITCH_DECK_JPEG_QUALITY, maxEdge: PITCH_DECK_LONG_EDGE });
    // A model sheet is drawn smaller: it fills at most half the slide.
    expect(r.calls.find((c) => c.what === MAYA_SHEET)!.opts).toMatchObject({ mime: 'image/jpeg', quality: PITCH_DECK_JPEG_QUALITY, maxEdge: PITCH_DECK_CAST_EDGE });
    expect(PITCH_DECK_LONG_EDGE).toBe(1920);
    expect(PITCH_DECK_JPEG_QUALITY).toBeCloseTo(0.82);
  });

  it('a picture over 1 MB is drawn again at a lower quality, then smaller, until it fits', async () => {
    const r = renderersOf({ page: (p) => (p.id === 'pg_5' ? 1_400_000 : 300_000) });
    const built = await buildComicPitchDeck(makeBook(), fakeUrlFor, r);
    const tries = r.calls.filter((c) => c.what === 'pg_5').map((c) => [c.opts.quality, c.opts.maxEdge]);
    expect(tries).toEqual(PITCH_DECK_JPEG_STEPS.slice(0, 4).map((s) => [s.quality, s.edge]));
    expect(tries[1][0]).toBeLessThan(tries[0][0] as number); // quality steps down first…
    expect(tries[3][1]).toBeLessThan(tries[2][1] as number); // …then the size
    const pic = imagesOf(built.deck)[3];
    expect(decodedBytes((pic.ref as { dataUri: string }).dataUri)).toBeLessThanOrEqual(PITCH_DECK_IMAGE_MAX_BYTES);
  });

  it('a page that cannot fit even at the last step is refused with a friendly ExportError and reported; the deck is still made', async () => {
    const r = renderersOf({ page: (p) => (p.id === 'pg_5' ? 9_000_000 : 300_000) });
    const book = makeBook();
    const slot = collectExportSlots(book, fakeUrlFor, { plates: false }).slots.find((s) => s.key === 'pg_5')!;
    const err = await rasterSlideJpeg(book, slot, {}, r).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExportError);
    expect((err as ExportError).code).toBe('too_big');
    expect((err as ExportError).message).toMatch(/^Page 5 is too detailed for a slide: even smaller it is [\d.]+ MB, over the 1 MB/);
    expect(r.renderPage).toHaveBeenCalledTimes(PITCH_DECK_JPEG_STEPS.length);

    const built = await buildComicPitchDeck(book, fakeUrlFor, renderersOf({ page: (p) => (p.id === 'pg_5' ? 9_000_000 : 300_000) }));
    expect(slideIds(built.deck)).toEqual(['title', 'cast', 'page-1', 'end']);
    expect(built.failed).toEqual([{ label: 'Page 5', message: expect.stringMatching(/too detailed for a slide/) }]);
  });

  it('a renderer that does not write a JPEG is refused, and a comic whose pages all fail throws', async () => {
    const book = makeBook();
    const slot = collectExportSlots(book, fakeUrlFor, { plates: false }).slots.find((s) => s.key === 'pg_1')!;
    const png = vi.fn(async () => new Blob([Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])], { type: 'image/jpeg' }));
    await expect(rasterSlideJpeg(book, slot, {}, { renderPage: png })).rejects.toThrow(/couldn’t be saved as a JPEG/);
    await expect(buildComicPitchDeck(book, fakeUrlFor, { renderPage: png, renderCover: png, renderImage: png })).rejects.toThrow(/^Couldn’t export any pages\. Cover couldn’t be saved as a JPEG/);
  });
});

describe('pitch deck: the .pptx file', () => {
  it('makes a real PowerPoint file under the deck cap: the slides in order, JPEG media of at most 1 MB, the script in the notes', async () => {
    const download = vi.fn();
    const progress: string[] = [];
    const result = await exportComicPitchDeck(makeBook(), fakeUrlFor, { ...renderersOf({ page: 700_000, cover: 500_000 }), download, onProgress: (p) => progress.push(p.label) });
    expect(download).toHaveBeenCalledTimes(1);
    const [blob, fileName] = download.mock.calls[0] as [Blob, string];
    expect(fileName).toBe('the-saffron-thief-pitch-deck.pptx');
    expect(result).toMatchObject({ fileName, slides: 5, pages: 2, failed: [] });
    expect(blob.size).toBe(result.bytes);
    expect(result.bytes).toBeLessThanOrEqual(PITCH_DECK_MAX_BYTES);
    expect(progress).toEqual([
      'Rendering cover (1 of 4)…',
      'Rendering Maya’s model sheet (2 of 4)…',
      'Rendering page 1 (3 of 4)…',
      'Rendering page 5 (4 of 4)…',
      'Building the pitch deck…',
      'Done',
    ]);

    const zip = await unzip(blob);
    expect(slideCount(zip)).toBe(5);
    expect(await slideXml(zip, 1)).toContain('The Saffron Thief');
    expect(await slideXml(zip, 2)).toContain('Pickpocket');
    expect(await slideXml(zip, 3)).toContain('Page 1');
    expect(await slideXml(zip, 4)).toContain('Page 5');
    expect(await slideXml(zip, 5)).toContain('Thank you for reading');
    const media = Object.keys(zip.files).filter((f) => f.startsWith('ppt/media/') && !zip.files[f].dir);
    expect(media.length).toBeGreaterThanOrEqual(4);
    for (const f of media) {
      const bytes = await zip.file(f)!.async('uint8array');
      expect([bytes[0], bytes[1], bytes[2]]).toEqual([0xff, 0xd8, 0xff]);
      expect(bytes.length).toBeLessThanOrEqual(PITCH_DECK_IMAGE_MAX_BYTES);
    }
    const notes = await Promise.all(Object.keys(zip.files).filter((f) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(f)).map((f) => zip.file(f)!.async('string')));
    expect(notes.some((n) => n.includes('Arjun: You owe me an explanation, Maya.'))).toBe(true);
  });

  it('the biggest deck the exporter makes (30 pages and a cover, each picture just under 1 MB) stays under 40 MB', async () => {
    const download = vi.fn();
    const result = await exportComicPitchDeck(bookWithPages(PITCH_DECK_MAX_PAGES + 2), fakeUrlFor, { ...renderersOf({ page: 990_000, cover: 990_000 }), download });
    expect(result.slides).toBe(PITCH_DECK_MAX_PAGES + 3);
    expect(result.bytes).toBeGreaterThan(30_000_000);
    expect(result.bytes).toBeLessThanOrEqual(PITCH_DECK_MAX_BYTES);
    expect((download.mock.calls[0][0] as Blob).size).toBe(result.bytes);
  }, 60_000);

  it('the caps are the deck.export capability’s numbers (40 MB, 120 s)', () => {
    const cap = getCapability('deck.export')!;
    expect(PITCH_DECK_MAX_BYTES).toBe(cap.limits.maxBytes);
    expect(PITCH_DECK_TIMEOUT_MS).toBe(cap.limits.timeoutMs);
    expect(PITCH_DECK_MAX_BYTES).toBe(40_000_000);
    expect(PITCH_DECK_TIMEOUT_MS).toBe(120_000);
  });

  it('a deck over the cap throws the friendly too_big ExportError before the file is made, and nothing downloads', async () => {
    const download = vi.fn();
    const err = await exportComicPitchDeck(makeBook(), fakeUrlFor, { ...renderersOf({ page: 900_000, cover: 900_000 }), download, maxBytes: 2_500_000 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExportError);
    expect((err as ExportError).code).toBe('too_big');
    expect((err as ExportError).message).toMatch(/^This pitch deck would be over 2\.5 MB \([\d.]+ MB so far\), too big to make safely on this device\. Download the PDF instead\.$/);
    expect(download).not.toHaveBeenCalled();
  });

  it('the made file itself is held to the cap too (exportPptx maxBytes)', async () => {
    const sizes = { page: 400_000, cover: 400_000 };
    const built = await buildComicPitchDeck(makeBook(), fakeUrlFor, renderersOf(sizes));
    const download = vi.fn();
    // The pictures fit with no allowance for the slides around them; the real file does not.
    const err = await exportComicPitchDeck(makeBook(), fakeUrlFor, { ...renderersOf(sizes), download, overheadBytes: 0, maxBytes: built.imageBytes + 1000 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExportError);
    expect((err as ExportError).code).toBe('too_big');
    expect((err as ExportError).message).toMatch(/^This PowerPoint file would be [\d.]+ MB, over the [\d.]+ MB limit\./);
    expect(download).not.toHaveBeenCalled();
  });

  it('cancel throws ExportError (before, during the pictures, and before the file), and nothing downloads', async () => {
    const download = vi.fn();
    const before = new AbortController();
    before.abort();
    await expect(exportComicPitchDeck(makeBook(), fakeUrlFor, { ...renderersOf(), download, signal: before.signal })).rejects.toEqual(new ExportError(CANCELLED));

    const during = new AbortController();
    const r = renderersOf();
    const renderPage = vi.fn(async (d: ComicDoc, p: Page, u: string, o: RasterOptions) => {
      during.abort();
      return r.renderPage(d, p, u, o);
    });
    const err = await exportComicPitchDeck(makeBook(), fakeUrlFor, { ...r, renderPage, download, signal: during.signal }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExportError);
    expect((err as ExportError).message).toBe(CANCELLED);
    expect(renderPage).toHaveBeenCalledTimes(1); // stopped at once: page 5 was never drawn
    expect(download).not.toHaveBeenCalled();

    const late = new AbortController();
    const err2 = await exportComicPitchDeck(makeBook(), fakeUrlFor, { ...renderersOf(), download, signal: late.signal, onProgress: (p) => p.label === 'Building the pitch deck…' && late.abort() }).catch((e: unknown) => e);
    expect(err2).toBeInstanceOf(ExportError);
    expect((err2 as ExportError).message).toBe(CANCELLED);
    expect(download).not.toHaveBeenCalled();
  });

  it('a deck that takes longer than the time budget stops with a friendly ExportError', async () => {
    let t = 0;
    const now = () => (t += 50_000);
    const download = vi.fn();
    await expect(exportComicPitchDeck(makeBook(), fakeUrlFor, { ...renderersOf(), download, now })).rejects.toThrow(
      /^Making this pitch deck took longer than 120 seconds, so it stopped\./,
    );
    expect(download).not.toHaveBeenCalled();
  });
});

describe('pitch deck: the time budget is a hard limit', () => {
  const never = <T,>(): Promise<T> => new Promise<T>(() => undefined);
  const TOO_SLOW = /^Making this pitch deck took longer than 120 seconds, so it stopped\./;
  /** Fake time for the quick steps (blob reads) to run in, well inside the budget. */
  const LET_RUN_MS = 200;
  const letWorkRun = async () => {
    for (let i = 0; i < LET_RUN_MS / 5; i += 1) await vi.advanceTimersByTimeAsync(5);
  };

  afterEach(() => {
    vi.useRealTimers();
  });

  it('a picture that never finishes drawing stops at 120 s with the friendly ExportError, and its image load is aborted', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const download = vi.fn();
    const seen: AbortSignal[] = [];
    const renderPage = vi.fn((_d: ComicDoc, _p: Page, _u: string, o: RasterOptions) => {
      seen.push(o.signal!);
      return never<Blob>();
    });
    let settled: unknown = 'pending';
    const done = exportComicPitchDeck(makeBook(), fakeUrlFor, { ...renderersOf(), renderPage, download }).catch((e: unknown) => e);
    void done.then((v) => (settled = v));
    await letWorkRun(); // the cover and the model sheet are drawn
    await vi.advanceTimersByTimeAsync(PITCH_DECK_TIMEOUT_MS - 1 - LET_RUN_MS);
    expect(settled).toBe('pending');
    expect(renderPage).toHaveBeenCalledTimes(1);
    expect(seen[0].aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const err = await done;
    expect(err).toBeInstanceOf(ExportError);
    expect((err as ExportError).message).toMatch(TOO_SLOW);
    expect(seen[0].aborted).toBe(true); // the renderer's own image load is cancelled with it
    expect(renderPage).toHaveBeenCalledTimes(1);
    expect(download).not.toHaveBeenCalled();
  });

  it('a renderer chunk that never loads stops at 120 s too: making the file is under the same budget', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const download = vi.fn();
    const load = vi.fn(() => never<never>());
    let settled: unknown = 'pending';
    const done = exportComicPitchDeck(makeBook(), fakeUrlFor, { ...renderersOf(), load, download }).catch((e: unknown) => e);
    void done.then((v) => (settled = v));
    await letWorkRun(); // every picture is drawn; the renderer's chunk is asked for and never comes
    expect(load).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(PITCH_DECK_TIMEOUT_MS - 1 - LET_RUN_MS);
    expect(settled).toBe('pending');
    await vi.advanceTimersByTimeAsync(1);
    expect(((await done) as ExportError).message).toMatch(TOO_SLOW);
    expect(download).not.toHaveBeenCalled();
  });

  it('a deck made in time leaves no timer behind', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const done = buildComicPitchDeck(makeBook(), fakeUrlFor, renderersOf());
    await letWorkRun();
    expect(slideIds((await done).deck)).toEqual(['title', 'cast', 'page-1', 'page-2', 'end']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('Cancel during a picture that never finishes stops at once with CANCELLED, not the time message', async () => {
    const ctl = new AbortController();
    const renderPage = vi.fn(() => {
      queueMicrotask(() => ctl.abort());
      return never<Blob>();
    });
    const download = vi.fn();
    const err = await exportComicPitchDeck(makeBook(), fakeUrlFor, { ...renderersOf(), renderPage, signal: ctl.signal, download }).catch((e: unknown) => e);
    expect(err).toEqual(new ExportError(CANCELLED));
    expect(download).not.toHaveBeenCalled();
  });

  it('untilAborted settles with the work, or with CANCELLED the moment the signal fires', async () => {
    await expect(untilAborted(Promise.resolve(7), new AbortController().signal)).resolves.toBe(7);
    await expect(untilAborted(Promise.reject(new Error('boom')), new AbortController().signal)).rejects.toThrow('boom');
    const ctl = new AbortController();
    const pending = untilAborted(never<number>(), ctl.signal);
    ctl.abort();
    await expect(pending).rejects.toEqual(new ExportError(CANCELLED));
    await expect(untilAborted(never<number>(), ctl.signal)).rejects.toEqual(new ExportError(CANCELLED));
  });
});

describe('pitch deck: the contract checks before export', () => {
  const pic = { dataUri: `data:image/jpeg;base64,${btoa(String.fromCharCode(...makeJpeg(2000)))}`, bytes: 2000 };
  const content = { title: 'T', logline: 'L', creator: 'C', cover: pic, pages: [{ label: 'Page 1', caption: 'Page 1', picture: pic, notes: 'Panel 1\nSFX: BAM' }] };

  it('composed decks pass checkDeckSpec with no overlaps, with or without a cover and a logline', () => {
    for (const c of [content, { ...content, cover: undefined }, { ...content, logline: '' }]) {
      const deck = composePitchDeck(c);
      expect(checkDeckSpec(deck).ok).toBe(true);
      expect(deckOverlaps(deck)).toEqual([]);
      expect(() => assertExportableDeck(deck)).not.toThrow();
    }
  });

  it('the cast slide holds up to six characters, without overlaps for any count, pictures or not; the rest are in its notes', () => {
    const member = (i: number, withPicture: boolean): PitchDeckCastMember => ({ name: `Hero ${i}`, role: `Role ${i}`, ...(withPicture ? { picture: pic } : {}) });
    for (let n = 1; n <= PITCH_DECK_MAX_CAST + 2; n += 1) {
      for (const mode of ['text', 'grid', 'mixed'] as const) {
        const cast = Array.from({ length: n }, (_, i) => member(i + 1, mode === 'grid' || (mode === 'mixed' && i % 2 === 0)));
        const deck = composePitchDeck({ ...content, cast });
        const where = `${n} characters, ${mode}`;
        expect(slideIds(deck), where).toEqual(['title', 'cast', 'page-1', 'end']);
        expect(checkDeckSpec(deck).ok, where).toBe(true);
        expect(deckOverlaps(deck), where).toEqual([]);
        expect(() => assertExportableDeck(deck)).not.toThrow();
        const slide = deck.slides[1];
        const shown = Math.min(n, PITCH_DECK_MAX_CAST);
        expect(slide.elements.filter((e) => /^cast-\d+$/.test(e.id)), where).toHaveLength(shown);
        expect(slide.elements.filter((e) => e.kind === 'image'), where).toHaveLength(cast.slice(0, shown).filter((m) => m.picture).length);
        for (const e of slide.elements) {
          const [x, y, w, h] = e.rect;
          expect(Math.min(x, y, w, h), `${where}: ${e.id}`).toBeGreaterThanOrEqual(0);
          expect(x + w, `${where}: ${e.id}`).toBeLessThanOrEqual(1);
          expect(y + h, `${where}: ${e.id}`).toBeLessThanOrEqual(1);
        }
        expect(slide.notes!.split('\n\n'), where).toEqual(cast.map((m) => `${m.name} — ${m.role}`));
        const more = textsOf(deck, 1).filter((t) => t.startsWith('And '));
        expect(more, where).toEqual(n > PITCH_DECK_MAX_CAST ? [`And ${n - PITCH_DECK_MAX_CAST} more in the speaker notes`] : []);
      }
    }
    expect(slideIds(composePitchDeck({ ...content, cast: [] }))).toEqual(['title', 'page-1', 'end']);
    // A nameless character (only control characters) has nothing to show: no empty row, no empty slide.
    expect(slideIds(composePitchDeck({ ...content, cast: [{ name: ' \u0007 ', role: 'Ghost' }] }))).toEqual(['title', 'page-1', 'end']);
    const one = composePitchDeck({ ...content, cast: [{ name: '‮', role: 'Ghost' }, member(1, false)] });
    expect(textsOf(one, 1)).toEqual(['Cast', 'Hero 1 — Role 1']);
  });

  it('a built deck the contract refuses never reaches the renderer (a picture over the contract\'s 5 MB data: cap)', async () => {
    const download = vi.fn();
    const big = { ...renderersOf({ page: 5_500_000, cover: 100_000 }), imageMaxBytes: 6_000_000, download };
    await expect(buildComicPitchDeck(makeBook(), fakeUrlFor, big)).rejects.toThrow(/^This pitch deck couldn’t be put together \(slides\[2\]/);
    await expect(exportComicPitchDeck(makeBook(), fakeUrlFor, big)).rejects.toBeInstanceOf(ExportError);
    expect(download).not.toHaveBeenCalled();
  });

  it('an invalid deck or one whose content overlaps is refused with an ExportError', () => {
    const deck = composePitchDeck(content);
    const bad: DeckSpec = { ...deck, slides: [{ ...deck.slides[1], elements: [{ ...(deck.slides[1].elements[0] as DeckImage), ref: { kind: 'asset', id: '../etc/passwd' } }] }] };
    expect(() => assertExportableDeck(bad)).toThrow(ExportError);
    const overlapping: DeckSpec = { ...deck, slides: [{ ...deck.slides[1], elements: deck.slides[1].elements.map((e) => ({ ...e, rect: [0.1, 0.1, 0.5, 0.5] as [number, number, number, number] })) }] };
    expect(() => assertExportableDeck(overlapping)).toThrow(/overlap on slide page-1/);
  });
});
