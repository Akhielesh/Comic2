// Screen-reader transcript of a page (reader.md §8). Pure.
//
// The reader renders a localized doc, so the transcript is in the reading language with no extra
// branch. Panels follow the VISUAL reading order (the same order Guided View uses). For lettered-in-art
// comics this is the only accessible text, so it is always present; for overlay comics the lettering
// layer is aria-hidden in the reader to avoid reading every balloon twice.

import { findCharacter, type ComicDoc, type Line, type Page } from '../../../shared/comic/doc';
import { panelBoxesFor } from '../../../shared/comic/pageGeometry';
import type { ReaderItem } from '../reader/readerModel';
import { readingOrder } from './guidedModel';

const clean = (t: string | undefined) => (t || '').replace(/\s+/g, ' ').trim();
const sentence = (t: string) => (/[.!?…"”)]$/.test(t) ? t : `${t}.`);

export const lineTranscript = (doc: ComicDoc, line: Line): string | null => {
  const text = clean(line.text);
  if (!text) return null;
  const who = findCharacter(doc, line.speakerId)?.name || 'Someone';
  switch (line.kind) {
    case 'caption':
      return `Caption: ${sentence(text)}`;
    case 'sfx':
      return `Sound effect: ${sentence(text)}`;
    case 'thought':
      return `${who} thinks: “${text}”`;
    case 'whisper':
      return `${who} whispers: “${text}”`;
    case 'shout':
      return `${who} shouts: “${text}”`;
    default:
      return `${who} says: “${text}”`;
  }
};

/** Panel indexes of a page in visual reading order. */
export const panelOrder = (doc: ComicDoc, page: Page): number[] => {
  const boxes = panelBoxesFor(doc, page).slice(0, page.panels.length);
  const order = readingOrder(boxes, doc.format.readingDirection === 'rtl');
  // Panels without a box (malformed geometry) keep their written order at the end.
  const missing = page.panels.map((_, i) => i).filter((i) => !order.includes(i));
  return [...order, ...missing];
};

/** "Panel 2. Maya runs. Maya says: “Wait!”" */
export const panelTranscript = (doc: ComicDoc, page: Page, panelIndex: number, ordinal?: number): string => {
  const panel = page.panels[panelIndex];
  if (!panel) return '';
  const parts = [`Panel ${ordinal ?? panel.n}.`];
  const action = clean(panel.action);
  if (action) parts.push(sentence(action));
  for (const line of panel.lines) {
    const t = lineTranscript(doc, line);
    if (t) parts.push(t);
  }
  return parts.join(' ');
};

/** Paragraphs for one reader item: a heading line, then one paragraph per panel. */
export const pageTranscript = (doc: ComicDoc, item: ReaderItem | undefined): string[] => {
  if (!item) return [];
  if (item.kind === 'cover' || !item.page) {
    const title = clean(doc.cover.title) || clean(doc.brief.title);
    const tagline = clean(doc.cover.tagline) || clean(doc.brief.logline);
    return [[`Cover.`, title ? sentence(title) : '', tagline ? sentence(tagline) : ''].filter(Boolean).join(' ')];
  }
  const page = item.page;
  const head = [`Page ${page.n}.`];
  if (page.chapterTitle) head.push(sentence(clean(page.chapterTitle)));
  const summary = clean(page.summary);
  if (summary) head.push(sentence(summary));
  const order = panelOrder(doc, page);
  return [head.join(' '), ...order.map((idx, i) => panelTranscript(doc, page, idx, i + 1)).filter(Boolean)];
};
