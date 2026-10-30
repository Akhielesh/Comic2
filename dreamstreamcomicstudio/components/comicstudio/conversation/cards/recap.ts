// "Here's what I've got" — the pure model behind the recap card (director.md §3.2). It reads
// the CURRENT doc (cards are live), so the recap always shows what the studio understands
// right now: the story, the format, who it is for, where it happens, the look and the cast.
// No model call, no clock; strings only.

import { DEFAULT_FORMAT, type ComicDoc } from '../../../../shared/comic/doc';
import { languageSpec } from '../../../../shared/comic/languages';

export type RecapKey = 'story' | 'format' | 'audience' | 'setting' | 'style';

export interface RecapRow {
  key: RecapKey;
  label: string;
  value: string;
  /** Nothing decided yet (the value is a gentle prompt, shown muted). */
  open?: boolean;
}

const KIND_WORD: Record<string, string> = { comic: 'Comic', manga: 'Manga', webtoon: 'Webtoon', strip: 'Comic strip', storybook: 'Storybook' };
const COLOR_WORD: Record<string, string> = { bw: 'black & white', limited: 'limited color' };
export const DEFAULT_TITLE_RE = /^\s*untitled( comic)?\s*$/i;

const clean = (v: unknown): string => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '');
const clip = (s: string, max: number): string => (s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`);
const firstSentence = (s: string): string => {
  const m = clean(s).match(/^.*?[.!?](?=\s|$)/);
  return m ? m[0] : clean(s);
};
const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/** The page count the user (or a plan) actually set — never the untouched default. */
export const knownPageCount = (doc: ComicDoc): number | undefined =>
  doc.pages.length || (doc.format.pageCount !== DEFAULT_FORMAT.pageCount ? doc.format.pageCount : undefined);

/** True once there is anything worth recapping. */
export const hasRecap = (doc: ComicDoc): boolean => {
  const b = doc.brief;
  return !!(
    clean(b.premise) ||
    clean(b.logline) ||
    clean(b.audience) ||
    clean(b.setting) ||
    clean(b.genre) ||
    doc.cast.length ||
    doc.pages.length ||
    (clean(b.title) && !DEFAULT_TITLE_RE.test(clean(b.title)))
  );
};

/** Rows for the recap card, in reading order. Undecided essentials show as open prompts. */
export const recapRows = (doc: ComicDoc): RecapRow[] => {
  const b = doc.brief;
  const f = doc.format;
  const rows: RecapRow[] = [];

  const title = clean(b.title);
  const pitch = firstSentence(clean(b.logline) || clean(b.premise));
  const story = [title && !DEFAULT_TITLE_RE.test(title) ? `“${clip(title, 60)}”` : '', clip(pitch, 160)].filter(Boolean).join(' — ');
  rows.push(story ? { key: 'story', label: 'Story', value: story } : { key: 'story', label: 'Story', value: 'Tell me what happens — a line is enough.', open: true });

  const pages = knownPageCount(doc);
  const lang = f.language && f.language !== 'en' ? languageSpec(f.language) : undefined;
  const format = [
    KIND_WORD[f.kind] || 'Comic',
    pages ? `${pages} ${pages === 1 ? 'page' : 'pages'}` : '',
    f.pageAspect,
    COLOR_WORD[f.colorMode] || '',
    f.readingDirection === 'rtl' ? 'right to left' : '',
    lang ? (lang.endonym && lang.endonym !== lang.english ? `${lang.english} (${lang.endonym})` : lang.english) : ''
  ]
    .filter(Boolean)
    .join(' · ');
  rows.push({ key: 'format', label: 'Format', value: format });

  const audience = [clean(b.audience), clean(b.genre).toLowerCase(), clean(b.tone).toLowerCase()].filter(Boolean);
  if (audience.length) rows.push({ key: 'audience', label: 'For', value: cap(clip(audience.join(' · '), 120)) });

  const setting = clean(b.setting);
  if (setting) rows.push({ key: 'setting', label: 'Setting', value: cap(clip(setting, 120)) });

  const styleName = clean(doc.style.name);
  if (doc.style.status === 'empty' || !styleName) {
    rows.push({ key: 'style', label: 'Look', value: 'Not chosen yet — pick a preset (free), or I can draw a few options to compare.', open: true });
  } else {
    rows.push({ key: 'style', label: 'Look', value: `${clip(styleName, 60)}${doc.style.status === 'locked' ? ' · locked' : ''}` });
  }
  return rows;
};
