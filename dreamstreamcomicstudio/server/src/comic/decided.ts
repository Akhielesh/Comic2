// The DECIDED line of the director's DOC SUMMARY (agent-editor plan §3 A3.2, A3 CONFLICT): what the creator has
// settled, so the director never overrides it silently. A request that contradicts it gets ONE question (the
// contradiction gaps in replies.ts), never a quiet change.
//
// Pure and free: reads the doc only, no clock, no model, no storage. '' when nothing is settled yet (a fresh comic's
// summary is unchanged). Listed, in order: the approved plan, the page count once pages are planned for good or drawn,
// the locked (or picked) art style, the lettering preset with the comic's own looks, the image-model lock, and per page
// the balloons the creator pinned or locked.

import { letterStyleOf, totalPanels, type Balloon, type ComicDoc, type Line, type Page, type Panel } from '../../../shared/comic/doc.js';
import { LETTERING_PRESETS, type LetteringPresetId } from '../../../shared/comic/lettering/style.js';
import { lockOf } from '../../../shared/comic/modelLock.js';
import { getImageModel } from '../../../shared/comic/models.js';

/** Longest DECIDED line (the summary tail is never clipped, so it stays short). */
export const DECIDED_MAX_CHARS = 600;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const clip = (s: string, max: number) => (s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`);
const list = (items: string[]): string => (items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);

/** A balloon the creator pinned (moved by hand) or locked, with where it is. */
export interface PinnedBalloon {
  page: Page;
  panel: Panel;
  line: Line;
  /** 0-based index of the line in its panel. */
  index: number;
  balloon: Balloon;
  locked: boolean;
}

/** Every pinned or locked balloon, in page and reading order (a balloon whose line is gone is skipped). */
export function pinnedBalloons(doc: ComicDoc, pageIds?: ReadonlySet<string>): PinnedBalloon[] {
  const out: PinnedBalloon[] = [];
  for (const page of [...doc.pages].sort((a, b) => a.n - b.n)) {
    if (pageIds && !pageIds.has(page.id)) continue;
    const byLine = new Map(page.balloons.filter((b) => b.pinned || b.locked).map((b) => [b.lineId, b]));
    if (!byLine.size) continue;
    for (const panel of page.panels) {
      panel.lines.forEach((line, index) => {
        const balloon = byLine.get(line.id);
        if (balloon) out.push({ page, panel, line, index, balloon, locked: !!balloon.locked });
      });
    }
  }
  return out;
}

/** "page 2 · panel 1 · line 2 “We have to go”". */
export const pinnedLabel = (p: PinnedBalloon): string => `page ${p.page.n} · panel ${p.panel.n} · line ${p.index + 1} “${clip(p.line.text.replace(/\s+/g, ' ').trim(), 40)}”`;

const KIND_PLURAL: Record<string, string> = { speech: 'speech', thought: 'thoughts', whisper: 'whispers', shout: 'shouts', caption: 'captions', sfx: 'sound effects' };

/**
 * The comic's own lettering looks on top of its preset, in words ("shouts, Mira and 3 lines"): the base look, kind and
 * speaker overrides, named styles and lines with a look of their own. [] when the comic uses the preset as it is.
 */
export function ownLooks(doc: ComicDoc): { base: boolean; kinds: string[]; speakers: string[]; lines: number; named: number; words: string[] } {
  const ls = letterStyleOf(doc);
  const base = !!ls.base && Object.keys(ls.base).length > 0;
  const kinds = Object.entries(ls.kinds || {})
    .filter(([, p]) => p && Object.keys(p).length)
    .map(([k]) => KIND_PLURAL[k] ?? k);
  const speakers = Object.entries(ls.speakers || {})
    .filter(([, p]) => p && Object.keys(p).length)
    .map(([id]) => doc.cast.find((c) => c.id === id)?.name ?? 'a removed character');
  let lines = 0;
  for (const page of doc.pages) for (const panel of page.panels) for (const l of panel.lines) if ((l.style && Object.keys(l.style).length) || l.styleId) lines += 1;
  const named = Object.keys(ls.named || {}).length;
  const words = [
    ...(base ? ['the base look'] : []),
    ...kinds,
    ...speakers,
    ...(lines ? [plural(lines, 'line')] : []),
    ...(named ? [plural(named, 'saved style')] : [])
  ];
  return { base, kinds, speakers, lines, named, words };
}

/** The preset's display name ("Manga"), or the id when unknown. */
export const letteringPresetName = (id: string): string =>
  Object.prototype.hasOwnProperty.call(LETTERING_PRESETS, id) ? LETTERING_PRESETS[id as LetteringPresetId].name : id;

/**
 * "DECIDED (the creator's; ask once before changing any): plan approved (6 pages, 18 panels); 2 of 6 pages drawn;
 * style “Ligne claire” locked; lettering Manga, picked, with its own looks for shouts and Mira; drawing model …
 * locked; pinned balloons: p2 ×2 (1 locked), p4 ×1" — or '' when nothing is settled.
 */
export function decidedLine(doc: ComicDoc): string {
  const parts: string[] = [];
  const pages = doc.pages.length;
  const drawn = doc.pages.filter((p) => p.render.status === 'ready').length;
  const count = pages || doc.format.pageCount;
  if (doc.planStatus === 'approved' && pages) parts.push(`plan approved (${plural(pages, 'page')}, ${plural(totalPanels(doc), 'panel')})`);
  // A draft plan is not settled (its page count is only a proposal); drawn pages are.
  if (drawn) parts.push(`${drawn} of ${plural(count, 'page')} drawn`);

  const style = doc.style;
  if (style.status === 'locked') parts.push(`style${style.name ? ` “${clip(style.name, 40)}”` : ''} locked`);
  else if (style.presetId && style.status !== 'empty') parts.push(`style${style.name ? ` “${clip(style.name, 40)}”` : ''} picked`);

  const ls = letterStyleOf(doc);
  const looks = ownLooks(doc);
  // A preset the director chose itself (auto) may still change with the audience; a manual pick (auto false) is settled.
  const picked = doc.letterStyle !== undefined && ls.auto === false;
  if (picked || looks.words.length) {
    const name = letteringPresetName(ls.presetId);
    parts.push(`lettering ${name}${picked ? ', picked' : ''}${looks.words.length ? `, with its own looks for ${list(looks.words.slice(0, 5))}${looks.words.length > 5 ? ' and more' : ''}` : ''}`);
  }

  const lock = lockOf(doc);
  if (lock) parts.push(`drawing model ${getImageModel(lock.modelId)?.nickname ?? 'locked model'} locked${lock.origin === 'user_change' ? ' (changed by the creator)' : ''}`);

  const pinned = pinnedBalloons(doc);
  if (pinned.length) {
    const perPage = new Map<number, { n: number; locked: number }>();
    for (const p of pinned) {
      const at = perPage.get(p.page.n) ?? { n: 0, locked: 0 };
      at.n += 1;
      if (p.locked) at.locked += 1;
      perPage.set(p.page.n, at);
    }
    const shown = [...perPage].slice(0, 12).map(([n, c]) => `p${n} ×${c.n}${c.locked ? ` (${c.locked} locked)` : ''}`);
    parts.push(`pinned balloons: ${shown.join(', ')}${perPage.size > 12 ? ', …' : ''}`);
  }

  if (!parts.length) return '';
  return clip(`DECIDED (the creator's; ask once before changing any): ${parts.join('; ')}`, DECIDED_MAX_CHARS);
}
