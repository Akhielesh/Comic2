import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { coverSpecHash, createEmptyDoc, pageSpecHash, type AssetRef, type ComicDoc } from '../../../../shared/comic/doc.js';
import { aspectFromSize } from '../../../../shared/comic/models.js';
import { isContentRating, type ContentRating } from '../../../../shared/comic/safety.js';

import {
  ORIGINAL_KEYS,
  ORIGINAL_SLUGS,
  collectionEdition,
  originalStoryPages,
  type CollectionEdition,
  type OriginalKey
} from '../../../../shared/comic/originals.js';
export { ORIGINAL_KEYS, type OriginalKey };
export const IMPRINT = 'DreamStream Studio Originals';

type SourcePage = { n: number; alt: string; transcript: string };
export interface OriginalMetadata {
  title: string;
  summary: string;
  coverAlt: string;
  style: string;
  rating: ContentRating;
  pages: SourcePage[];
  kind?: CollectionEdition['kind'];
  readingDirection?: CollectionEdition['readingDirection'];
  colorMode?: CollectionEdition['colorMode'];
  orientation?: CollectionEdition['orientation'];
}
export interface OriginalImage {
  name: string;
  file: string;
  sha256: string;
  width: number;
  height: number;
  bytes: number;
}
export interface OriginalBook {
  key: OriginalKey;
  metadata: OriginalMetadata;
  images: OriginalImage[];
  digest: string;
}

export const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
function text(value: unknown, field: string, limit: number) {
  if (typeof value !== 'string' || !value.trim() || value.length > limit || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) {
    throw new Error('Invalid original book field: ' + field);
  }
  return value.trim();
}
export function originalMetadata(key: OriginalKey, raw: unknown): OriginalMetadata {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Expected book metadata.');
  const data = raw as Record<string, unknown>;
  if (!isContentRating(data.rating)) throw new Error('Expected a supported publication rating.');
  if (data.language && data.language !== 'en') throw new Error('This edition is prepared for English.');
  const count = originalStoryPages(key);
  if (!Array.isArray(data.pages) || data.pages.length !== count) throw new Error(`This edition requires ${count} story pages.`);
  const edition = collectionEdition(key);
  if (edition?.rating && data.rating !== edition.rating) throw new Error('The rating differs from this registered edition.');
  if (
    edition &&
    (data.title !== edition.title ||
      data.kind !== edition.kind ||
      data.readingDirection !== edition.readingDirection ||
      data.orientation !== edition.orientation ||
      (data.colorMode !== undefined && data.colorMode !== (edition.colorMode ?? 'color')))
  ) {
    throw new Error('The title or reading format differs from this registered edition.');
  }
  return {
    title: text(data.title, 'title', 90),
    summary: text(data.summary ?? data.description, 'summary', 600),
    coverAlt: text(data.coverAlt, 'coverAlt', 1600),
    style: text(data.style, 'style', 300),
    rating: data.rating,
    pages: data.pages.map((value, i) => {
      if (!value || value.n !== i + 1) throw new Error(`Pages must be numbered in reading order from 1 to ${count}.`);
      return { n: i + 1, alt: text(value.alt, 'page alt', 1600), transcript: text(value.transcript, 'transcript', 8000) };
    }),
    // Earlier editions retain the exact metadata serialization used in their immutable digests.
    ...(edition && { kind: edition.kind, readingDirection: edition.readingDirection, orientation: edition.orientation }),
    ...(edition?.colorMode && { colorMode: edition.colorMode })
  };
}

export function editionDigest(key: OriginalKey, metadata: OriginalMetadata, images: OriginalImage[]): string {
  return sha256(JSON.stringify([key, metadata, images.map(({ name, sha256 }) => [name, sha256])]));
}

export async function inspectOriginal(root: string, key: OriginalKey): Promise<OriginalBook> {
  if (!ORIGINAL_KEYS.includes(key)) throw new Error('Unknown Studio Original.');
  const directory = join(root, key);
  const metadata = originalMetadata(key, JSON.parse(await readFile(join(directory, 'book.json'), 'utf8')));
  const images: OriginalImage[] = [];
  const count = metadata.pages.length;
  const names = Array.from({ length: count }, (_, i) => 'p' + String(i + 1).padStart(2, '0') + '.webp');
  const expected = new Set(['cover.webp', ...names]);
  const supplied = (await readdir(directory)).filter((name) => /[.]webp$/i.test(name));
  if (supplied.length !== expected.size || supplied.some((name) => !expected.has(name)))
    throw new Error('Unexpected editorial artwork roster.');
  for (const name of expected) {
    const file = join(directory, name);
    const buffer = await readFile(file);
    if (!buffer.length || buffer.length > 40 * 1024 * 1024) throw new Error(key + '/' + name + ' exceeds the supported file size.');
    const input = sharp(buffer, { animated: true, limitInputPixels: 40_000_000, failOn: 'error' });
    const image = await input.metadata();
    if (image.format !== 'webp' || (image.pages ?? 1) !== 1 || !image.width || !image.height || image.width < 480 || image.height < 480) {
      throw new Error(key + '/' + name + ' must be a legible single-frame WebP at least 480 pixels on both axes.');
    }
    if (metadata.orientation) {
      const portrait = image.height > image.width;
      if (aspectFromSize(image.width, image.height) === '1:1' || portrait !== (metadata.orientation === 'portrait')) {
        throw new Error(`${key}/${name} must have the registered ${metadata.orientation} orientation.`);
      }
    }
    // Decode the complete file, including the final scanlines, before requesting a publication lease.
    await input.stats();
    const hash = sha256(buffer);
    if (images.some((prior) => prior.sha256 === hash)) throw new Error(key + ' contains duplicate illustrations.');
    images.push({ name, file, sha256: hash, width: image.width, height: image.height, bytes: buffer.length });
  }
  const digest = editionDigest(key, metadata, images);
  return { key, metadata, images, digest };
}

export function originalPath(book: OriginalBook, image: OriginalImage): string {
  // Logical source only, local immutable assets are read by name from the verified bundle.
  return 'library/studio-originals/' + book.key + '/' + image.sha256 + '.webp';
}

/** Build the native reader source with separate accessible text for each lettered illustration. */
export function originalDocument(book: OriginalBook, assets: AssetRef[], now: number): ComicDoc {
  if (assets.length !== originalStoryPages(book.key) + 1 || assets.some((a, i) => a.path !== originalPath(book, book.images[i])))
    throw new Error('Incomplete editorial artwork.');
  const { metadata } = book;
  const doc = createEmptyDoc(ORIGINAL_SLUGS[book.key], metadata.title, now);
  doc.brief.logline = metadata.summary;
  doc.brief.notes = ['Studio Originals source ' + book.key + ' ' + book.digest];
  doc.style.name = metadata.style; // Frozen into the publication and covered by publishableText.
  doc.format = {
    ...doc.format,
    lettering: 'in_art',
    language: 'en',
    pageCount: metadata.pages.length,
    ...(metadata.kind && { kind: metadata.kind }),
    ...(metadata.colorMode && { colorMode: metadata.colorMode }),
    ...(metadata.readingDirection && { readingDirection: metadata.readingDirection }),
    pageAspect: aspectFromSize(book.images[1].width, book.images[1].height)
  };
  doc.settings.rating = metadata.rating;
  doc.book = { ...doc.book, blurb: metadata.summary, credits: [IMPRINT] };
  doc.reader = { ...doc.reader, credits: IMPRINT };
  doc.cover = {
    title: metadata.title,
    lettering: 'in_art',
    readerAlt: metadata.coverAlt,
    render: { status: 'ready', history: [], asset: assets[0] }
  };
  doc.pages = metadata.pages.map((p, i) => ({
    id: 'page-' + p.n,
    n: p.n,
    summary: '',
    layout: 'Full page',
    readerAlt: p.alt,
    balloons: [],
    panels: [
      {
        id: 'panel-' + p.n,
        n: 1,
        size: 'splash',
        shot: 'wide',
        action: '',
        castIds: [],
        lines: p.transcript
          .split(/\r?\n/)
          .filter((s) => s.trim())
          .map((s, j) => ({ id: 'page-' + p.n + '-line-' + (j + 1), kind: 'caption', text: s.trim() }))
      }
    ],
    render: { status: 'ready', history: [], asset: assets[i + 1] }
  }));
  doc.cover.render.specHash = coverSpecHash(doc);
  for (const page of doc.pages) page.render.specHash = pageSpecHash(doc, page);
  return doc;
}
