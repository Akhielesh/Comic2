// Per-panel art direction (Ship 2, B4; pro plan §4.2 "Per-panel directions", §5.2 PanelDirection). Pure and $0.
//
// The writer (B6) writes a direction per panel: lens, composition, light, a palette accent, focus, up to
// CONSISTENCY_LIMITS.directionBackground background details, and per drawn character their expression, pose, gaze,
// what they hold, where they stand (left/center/right) and how deep (fg/mid/bg); `offPanel` lists who is heard but
// not drawn. A plan never fails because of them: normalizeDirection clips and coerces what the writer sent (lens to
// the panel's shot, cast entries to who is drawn, `offPanel` to who is not) and derives a deterministic direction when
// nothing valid is left. directionPhrases turns a direction into the "Who" and "Detail" words the page prompt (B5)
// adds, dropping gaze → extra background → composition → pose (DIRECTION_DROP_ORDER) when the prompt runs over its
// CONSISTENCY_LIMITS.promptChars budget. lintDirections names contradictions for the card and the editor.
//
// Back-compat (I8): a panel without a direction gets no phrases and no lint, so its prompt is unchanged.

import { CONSISTENCY_LIMITS } from './limits.js';
import { normalizePanelDirection, type ComicDoc, type DirectionLens, type Page, type Panel, type PanelCastDirection, type PanelDirection, type ShotType } from './doc.js';
import { castNameOf, itemKey, itemMatches, resolveContinuity, type ContinuityState } from './continuity.js';

// ── Lens and shot ────────────────────────────────────────────────────────────

/** Lenses that suit each shot; the first is the one a missing or contradicting lens becomes. */
export const SHOT_LENSES: Readonly<Record<ShotType, readonly DirectionLens[]>> = {
  establishing: ['wide'],
  wide: ['wide', 'normal'],
  full: ['normal', 'wide'],
  medium: ['normal', 'wide', 'long'],
  close_up: ['long', 'normal'],
  extreme_close_up: ['macro', 'long'],
  over_shoulder: ['normal', 'long'],
  insert: ['macro', 'long', 'normal'],
  pov: ['normal', 'wide']
};

const lensesFor = (shot: ShotType): readonly DirectionLens[] => SHOT_LENSES[shot] ?? ['normal'];
/** The lens a shot defaults to. */
export const lensForShot = (shot: ShotType): DirectionLens => lensesFor(shot)[0];
/** The lens suits the shot. */
export const lensFits = (shot: ShotType, lens: DirectionLens): boolean => lensesFor(shot).includes(lens);

const SPOKEN = new Set(['speech', 'thought', 'whisper', 'shout']);

/** Speakers with a line in the panel who are not drawn in it (heard, not seen), in line order. */
export const undrawnSpeakers = (panel: Pick<Panel, 'castIds' | 'lines'>): string[] => {
  const drawn = new Set(panel.castIds);
  const out: string[] = [];
  for (const line of panel.lines) {
    if (!line.speakerId || !SPOKEN.has(line.kind) || drawn.has(line.speakerId) || out.includes(line.speakerId)) continue;
    out.push(line.speakerId);
  }
  return out;
};

// ── Normalize and derive ─────────────────────────────────────────────────────

type CastPick = Pick<ComicDoc, 'cast'>;

/** A direction from the panel alone: the shot's lens and its unseen speakers as off-panel voices (by 'derived'). */
export const deriveDirection = (panel: Pick<Panel, 'shot' | 'castIds' | 'lines'>, doc?: CastPick): PanelDirection => {
  const known = doc ? new Set(doc.cast.map((c) => c.id)) : undefined;
  const offPanel = undrawnSpeakers(panel)
    .filter((id) => !known || known.has(id))
    .slice(0, CONSISTENCY_LIMITS.castChanges);
  return { lens: lensForShot(panel.shot), ...(offPanel.length ? { offPanel } : {}), by: 'derived' };
};

/**
 * The direction a panel keeps: the contract normalizer (doc.ts normalizePanelDirection: text clipped to
 * PRO_PAGE_LIMITS, lists capped, unknown values dropped), then made consistent with the panel — a missing lens or one
 * that contradicts the shot becomes the shot's lens; per-character entries only for who is drawn; `offPanel` never
 * lists someone drawn (and always lists an unseen speaker); with `doc`, only the book's cast. Nothing valid left →
 * deriveDirection. Deterministic and idempotent.
 */
export const normalizeDirection = (raw: unknown, panel: Pick<Panel, 'shot' | 'castIds' | 'lines'>, doc?: CastPick): PanelDirection => {
  const base = normalizePanelDirection(raw);
  if (!base) return deriveDirection(panel, doc);
  const known = doc ? new Set(doc.cast.map((c) => c.id)) : undefined;
  const drawn = new Set(panel.castIds);
  const out: PanelDirection = { ...base };
  if (!out.lens || !lensFits(panel.shot, out.lens)) out.lens = lensForShot(panel.shot);
  if (out.cast) {
    const cast: Record<string, PanelCastDirection> = {};
    for (const [id, d] of Object.entries(out.cast)) if (drawn.has(id) && (!known || known.has(id))) cast[id] = d;
    if (Object.keys(cast).length) out.cast = cast;
    else delete out.cast;
  }
  const offPanel = [...new Set([...(out.offPanel ?? []), ...undrawnSpeakers(panel)])]
    .filter((id) => !drawn.has(id) && (!known || known.has(id)))
    .slice(0, CONSISTENCY_LIMITS.castChanges);
  if (offPanel.length) out.offPanel = offPanel;
  else delete out.offPanel;
  return out;
};

// ── Lint ─────────────────────────────────────────────────────────────────────

export type DirectionIssueKind = 'lens_shot' | 'offpanel_drawn' | 'cast_not_drawn' | 'unknown_cast' | 'speaker_unplaced' | 'same_spot' | 'holding_ledger';

export interface DirectionIssue {
  pageId: string;
  /** Page number. */
  n: number;
  /** Panel number on the page. */
  panel: number;
  panelId: string;
  kind: DirectionIssueKind;
  severity: 'minor' | 'major';
  castId?: string;
  text: string;
}

const SHOT_WORDS: Record<ShotType, string> = {
  establishing: 'an establishing shot',
  wide: 'a wide shot',
  full: 'a full shot',
  medium: 'a medium shot',
  close_up: 'a close-up',
  extreme_close_up: 'an extreme close-up',
  over_shoulder: 'an over-the-shoulder shot',
  insert: 'an insert',
  pov: 'a point-of-view shot'
};
const POS_WORDS: Record<NonNullable<PanelCastDirection['pos']>, string> = { left: 'left', center: 'center', right: 'right' };
const DEPTH_WORDS: Record<NonNullable<PanelCastDirection['depth']>, string> = { fg: 'foreground', mid: 'midground', bg: 'background' };

const lintPanel = (doc: ComicDoc, page: Page, panel: Panel, state: ContinuityState | undefined): DirectionIssue[] => {
  const d = panel.direction;
  if (!d) return [];
  const out: DirectionIssue[] = [];
  const at = { pageId: page.id, n: page.n, panel: panel.n, panelId: panel.id };
  const known = new Set(doc.cast.map((c) => c.id));
  const drawn = new Set(panel.castIds);
  const name = (id: string) => castNameOf(doc, id);
  if (d.lens && !lensFits(panel.shot, d.lens)) {
    out.push({ ...at, kind: 'lens_shot', severity: 'minor', text: `Panel ${panel.n} on page ${page.n} is ${SHOT_WORDS[panel.shot]} but asks for a ${d.lens} lens.` });
  }
  for (const id of d.offPanel ?? []) {
    if (!known.has(id)) out.push({ ...at, kind: 'unknown_cast', severity: 'major', castId: id, text: `Panel ${panel.n} on page ${page.n} names someone who isn't in the cast.` });
    else if (drawn.has(id)) out.push({ ...at, kind: 'offpanel_drawn', severity: 'major', castId: id, text: `${name(id)} is drawn in panel ${panel.n} on page ${page.n} but also marked as an off-panel voice.` });
  }
  for (const id of Object.keys(d.cast ?? {})) {
    if (!known.has(id)) out.push({ ...at, kind: 'unknown_cast', severity: 'major', castId: id, text: `Panel ${panel.n} on page ${page.n} directs someone who isn't in the cast.` });
    else if (!drawn.has(id)) out.push({ ...at, kind: 'cast_not_drawn', severity: 'minor', castId: id, text: `Panel ${panel.n} on page ${page.n} directs ${name(id)}, who isn't drawn there.` });
  }
  const off = new Set(d.offPanel ?? []);
  for (const id of undrawnSpeakers(panel)) {
    if (off.has(id) || !known.has(id)) continue;
    out.push({ ...at, kind: 'speaker_unplaced', severity: 'minor', castId: id, text: `${name(id)} speaks in panel ${panel.n} on page ${page.n} but isn't drawn there or marked as an off-panel voice.` });
  }
  // Two people in one spot.
  const spots = new Map<string, string>();
  for (const id of panel.castIds) {
    const c = d.cast?.[id];
    if (!c?.pos || !c.depth) continue;
    const spot = `${c.pos}/${c.depth}`;
    const other = spots.get(spot);
    if (other) {
      out.push({ ...at, kind: 'same_spot', severity: 'minor', castId: id, text: `${name(other)} and ${name(id)} stand in the same spot in panel ${panel.n} on page ${page.n} (${POS_WORDS[c.pos]}, ${DEPTH_WORDS[c.depth]}).` });
    } else spots.set(spot, id);
  }
  // What the direction shows someone holding against the ledger.
  if (state) {
    for (const [id, c] of Object.entries(d.cast ?? {})) {
      for (const item of c.holding ?? []) {
        const holder = Object.entries(state.cast).find(([other, s]) => other !== id && s.holding?.some((x) => itemKey(x) === itemKey(item)));
        if (holder) {
          out.push({
            ...at,
            kind: 'holding_ledger',
            severity: 'minor',
            castId: id,
            text: `Panel ${panel.n} on page ${page.n} shows ${name(id)} holding “${item}”, but ${name(holder[0])} holds it from page ${holder[1].since.holding}.`
          });
          continue;
        }
        const gone = Object.entries(state.gone).find(([prop]) => itemMatches(item, prop));
        if (gone) {
          out.push({ ...at, kind: 'holding_ledger', severity: 'minor', castId: id, text: `Panel ${panel.n} on page ${page.n} shows ${name(id)} holding “${item}”, but “${gone[0]}” is gone from page ${gone[1]}.` });
        }
      }
    }
  }
  return out;
};

/**
 * Contradictions in the panel directions of one page (or the whole book): a lens that fights the shot, someone both
 * drawn and off-panel, directions for someone not drawn or not in the cast, an unseen speaker not marked off-panel, two
 * people in one spot, and an item held against the continuity ledger. Panels without a direction are never linted.
 */
export const lintDirections = (doc: ComicDoc, page?: Page): DirectionIssue[] => {
  const pages = page ? [page] : [...doc.pages].sort((a, b) => a.n - b.n);
  const out: DirectionIssue[] = [];
  for (const p of pages) {
    if (!p.panels.some((panel) => panel.direction)) continue;
    const state = resolveContinuity(doc, p);
    for (const panel of p.panels) out.push(...lintPanel(doc, p, panel, state));
  }
  return out;
};

// ── Phrases for the page prompt ──────────────────────────────────────────────

/** What goes first when the page prompt is over budget: gaze → extra background → composition → pose. */
export const DIRECTION_DROP_ORDER = ['gaze', 'background', 'composition', 'pose'] as const;
export type DirectionDrop = (typeof DIRECTION_DROP_ORDER)[number];

export interface WhoPhrase {
  castId: string;
  /** "MEERA (left, foreground): wide-eyed, crouching, looking at the gate, holding the lantern". */
  text: string;
  /** "left, foreground". */
  place?: string;
  /** "wide-eyed, crouching, looking at the gate, holding the lantern". */
  state?: string;
}

export interface DirectionPhrases {
  /** "long lens; low angle over her shoulder". */
  camera?: string;
  /** Drawn characters with a direction, in the panel's cast order. */
  who: WhoPhrase[];
  /** ["background: wet steps, a broken oar", "light: cold blue dusk", "palette accent: one red kite", "focus: the plate"]. */
  detail: string[];
  /** Heard, not drawn. */
  offPanel: { castId: string; name: string }[];
}

const GAZE_LEAD = /^(?:at|to|toward|towards|down|up|away|off|over|into|back|past|out|across|through|around|behind|ahead|forward|sideways)\b/i;
const gazeWords = (gaze: string): string => (GAZE_LEAD.test(gaze) ? `looking ${gaze}` : `looking at ${gaze}`);

/**
 * The words a panel's direction adds to its prompt block: Who (place and state per drawn character), Detail
 * (background, light, palette accent, focus), the camera (lens and composition) and the off-panel voices. `drop`
 * = how many steps of DIRECTION_DROP_ORDER to apply (0 = everything; 'background' keeps the first detail). A panel
 * without a direction has no phrases (I8).
 */
export const directionPhrases = (panel: Pick<Panel, 'castIds' | 'direction'>, doc: CastPick, opts: { drop?: number } = {}): DirectionPhrases => {
  const d = panel.direction;
  if (!d) return { who: [], detail: [], offPanel: [] };
  const level = Math.max(0, Math.min(DIRECTION_DROP_ORDER.length, Math.floor(opts.drop ?? 0)));
  const dropped = new Set<DirectionDrop>(DIRECTION_DROP_ORDER.slice(0, level));
  const name = (id: string) => castNameOf(doc, id);
  const who: WhoPhrase[] = [];
  for (const id of panel.castIds) {
    const c = d.cast?.[id];
    if (!c) continue;
    const place = [c.pos ? POS_WORDS[c.pos] : '', c.depth ? DEPTH_WORDS[c.depth] : ''].filter(Boolean).join(', ');
    const state = [
      c.expression ?? '',
      !dropped.has('pose') ? c.pose ?? '' : '',
      !dropped.has('gaze') && c.gaze ? gazeWords(c.gaze) : '',
      c.holding?.length ? `holding ${c.holding.join(' and ')}` : ''
    ]
      .filter(Boolean)
      .join(', ');
    if (!place && !state) continue;
    who.push({ castId: id, text: `${name(id)}${place ? ` (${place})` : ''}${state ? `: ${state}` : ''}`, ...(place ? { place } : {}), ...(state ? { state } : {}) });
  }
  const background = dropped.has('background') ? (d.background ?? []).slice(0, 1) : d.background ?? [];
  const detail = [
    background.length ? `background: ${background.join(', ')}` : '',
    d.light ? `light: ${d.light}` : '',
    d.palette ? `palette accent: ${d.palette}` : '',
    d.focus ? `focus: ${d.focus}` : ''
  ].filter(Boolean);
  const camera = [d.lens ? `${d.lens} lens` : '', !dropped.has('composition') ? d.composition ?? '' : ''].filter(Boolean).join('; ');
  return {
    ...(camera ? { camera } : {}),
    who,
    detail,
    offPanel: (d.offPanel ?? []).map((id) => ({ castId: id, name: name(id) }))
  };
};
