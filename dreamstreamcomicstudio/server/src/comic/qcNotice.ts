// The page-check notice (plan §3 C14, §4.3 Ship 1): what the chat says after a page is checked.
//
// It replaces the bare `qc.score < 0.45` rule in jobs.ts letterPage. A calm "Check page N" notice
// fires for a MAJOR structured problem — the drawn panel count differs from the plan, the pictures
// show the planned moments in another order or leave one out, a speaker who should be visible is
// not drawn, or (once COMIC_IDENTITY_NOTICES is on, Ship 2) a character is drawn off-model — or for
// a score below QC_NOTICE_SCORE. Badges and the page's quality list always show everything; this
// only decides when to speak up in the chat. Off-panel voices are never a problem (vision.ts).
//
// The notice carries fix chips, free first. Every fix is an action that exists today: the free one
// is a script edit that changes no hashed field (so the page never goes falsely "out of date"); the
// paid ones carry the caller's quote, because a paid chip is a confirmation (jobs.ts priced()), and
// are left out when no quote is given. The Ship 2 fixes (rebind_panels, apply_finding, fix_panel)
// join here when they exist. Pure: no I/O, no clock, no env.

import type { ComicDoc, Line, Page, Panel, QcReport } from '../../../shared/comic/doc.js';
import type { DocOp, SpendAction, StudioAction } from '../../../shared/comic/ops.js';
import { LOW_QC_SCORE } from '../../../shared/comic/plan.js';
import { upperName } from './prompts.js';
import { beatProblems, offPanelSpeakerIds, panelSpeakerIds, type MissingSpeaker, type QcPanelChecks } from './vision.js';

/** C14: a page check scoring below this raises a notice even with no structured problem (provisional; one constant). */
export const QC_NOTICE_SCORE = 0.75;
/** At most this many fix chips on one notice (free first). */
export const MAX_NOTICE_FIXES = 4;
/** At most this many problems of one kind are named in the text (the page's quality list has the rest). */
const MAX_NAMED = 2;
/** Planned action text carried into a paid panel redraw instruction (edit_page accepts 2 000). */
const MAX_ACTION_IN_INSTRUCTION = 400;

/** One fix chip. Paid actions carry `quotedUsd` and go through the existing spend gate. */
export interface QcNoticeFix {
  label: string;
  free: boolean;
  action: StudioAction;
}

/** What the chat shows after a page check (K1 turns it into the `notice` card with `fixes`). */
export interface QcNotice {
  tone: 'info' | 'warn';
  text: string;
  fixes: QcNoticeFix[];
}

export interface QcNoticeOptions {
  /** The comic: names in the text and its lettering mode (the caption fix is for overlay pages only).
   *  Without it names read "a speaker" and no caption fix is offered. */
  doc?: Pick<ComicDoc, 'cast' | 'format'>;
  /** The price of a paid fix in the user's terms (jobs.ts: estimateSpendAction(doc, action, byok).usd).
   *  Without it no paid fix is offered — a paid chip always carries its quote. */
  quote?: (action: SpendAction) => number | undefined;
  /** COMIC_IDENTITY_NOTICES (Ship 2): identity "no" findings raise the notice. Off by default. */
  identityNotices?: boolean;
}

/** The env switch for identity notices (Ship 2); off unless COMIC_IDENTITY_NOTICES=1. */
export const identityNoticesEnabled = (env: Record<string, string | undefined> = process.env): boolean => env.COMIC_IDENTITY_NOTICES === '1';

// ── Reading a stored report (old, partial or malformed fields are ignored, never trusted) ──

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const VOICE_KINDS: ReadonlySet<Line['kind']> = new Set<Line['kind']>(['speech', 'thought', 'whisper', 'shout']);

/** Ship 2's identity findings, read defensively (typed here until K2a adds QcReport.findings). */
interface IdentityProblem {
  panel: number;
  characterId?: string;
}

const storedBeats = (qc: QcPanelChecks): number[] | undefined =>
  Array.isArray(qc.beats) && qc.beats.every((b) => Number.isInteger(b) && b >= 0) ? qc.beats : undefined;

/** Missing speakers that still hold on the page as it is now: the panel exists, the character still
 *  speaks there, and is not (now) an off-panel voice. */
const currentMissingSpeakers = (qc: QcPanelChecks, page: Page): MissingSpeaker[] => {
  const raw = Array.isArray(qc.missingSpeakers) ? qc.missingSpeakers : [];
  const seen = new Set<string>();
  const out: MissingSpeaker[] = [];
  for (const m of raw) {
    if (!isObject(m) || !Number.isInteger(m.panel) || typeof m.castId !== 'string' || !m.castId) continue;
    const panel = page.panels.find((p) => p.n === m.panel);
    if (!panel || !panelSpeakerIds(panel).includes(m.castId) || offPanelSpeakerIds(panel).has(m.castId)) continue;
    const key = `${m.panel}:${m.castId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ panel: m.panel, castId: m.castId });
  }
  return out;
};

const identityProblems = (qc: QcReport, page: Page): IdentityProblem[] => {
  const findings = (qc as { findings?: unknown }).findings;
  if (!Array.isArray(findings)) return [];
  return findings
    .filter(isObject)
    .filter((f) => f.kind === 'identity' && f.severity === 'major' && !f.dismissed && Number.isInteger(f.panel) && page.panels.some((p) => p.n === f.panel))
    .map((f) => ({ panel: f.panel as number, ...(typeof f.characterId === 'string' && f.characterId ? { characterId: f.characterId } : {}) }));
};

// ── Words ──

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const listWords = (items: string[]): string =>
  items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
const named = <T>(items: T[], say: (item: T) => string): string => {
  const shown = items.slice(0, MAX_NAMED).map(say);
  return items.length > MAX_NAMED ? `${shown.join('; ')}; and ${plural(items.length - MAX_NAMED, 'more')}` : shown.join('; ');
};
const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);
const clip = (text: string, max: number) => {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

const swapSentence = (swapped: { panel: number; shows: number }[]): string => {
  const pair = swapped.length === 2 && swapped[0].shows === swapped[1].panel && swapped[1].shows === swapped[0].panel;
  if (pair) return `panels ${swapped[0].panel} and ${swapped[1].panel} show each other's moments`;
  return named(swapped, (s) => `panel ${s.panel}'s picture shows panel ${s.shows}'s moment`);
};

// ── The notice ──

/**
 * The notice for one checked page, or null when the check has nothing the chat should raise
 * (plan §3 C14). `page` is the page as it is now; stored report fields that no longer hold on it
 * (a line moved since, a re-planned panel) are ignored.
 */
export function qcNoticeFor(qc: QcReport | undefined | null, page: Page, opts: QcNoticeOptions = {}): QcNotice | null {
  if (!qc || !isObject(qc) || !page) return null;
  const checks = qc as QcReport & QcPanelChecks;
  const planned = page.panels.length;
  const score = typeof qc.score === 'number' && Number.isFinite(qc.score) ? qc.score : undefined;
  const nameOf = (castId?: string) => {
    const c = castId ? opts.doc?.cast.find((x) => x.id === castId) : undefined;
    return c ? upperName(c.name) : 'a speaker';
  };

  // Major structured problems (C14).
  const drawn = Array.isArray(checks.drawnBoxes) ? checks.drawnBoxes.length : 0;
  const countOff = drawn > 0 && planned > 0 && drawn !== planned;
  const beats = countOff ? { permutation: false, swapped: [], undrawn: [] } : beatProblems(storedBeats(checks), planned);
  const speakers = currentMissingSpeakers(checks, page);
  const identity = opts.identityNotices ? identityProblems(qc, page) : [];
  const low = score !== undefined && score < QC_NOTICE_SCORE;
  const structured = countOff || beats.swapped.length > 0 || beats.undrawn.length > 0 || speakers.length > 0 || identity.length > 0;
  if (!structured && !low) return null;

  const sentences: string[] = [];
  if (countOff) sentences.push(`it has ${plural(drawn, 'drawn panel')}; the plan has ${planned}`);
  if (beats.permutation) sentences.push(swapSentence(beats.swapped));
  if (beats.undrawn.length) {
    sentences.push(
      beats.undrawn.length === 1
        ? `panel ${beats.undrawn[0]}'s moment isn't drawn in any panel`
        : `the moments of panels ${listWords(beats.undrawn.slice(0, 3).map(String))}${beats.undrawn.length > 3 ? ' and more' : ''} aren't drawn`
    );
  }
  if (speakers.length) sentences.push(named(speakers, (m) => `${nameOf(m.castId)} speaks in panel ${m.panel} but isn't drawn there`));
  if (identity.length) sentences.push(named(identity, (f) => `${f.characterId ? nameOf(f.characterId) : 'a character'} looks different from their sheet in panel ${f.panel}`));
  if (!sentences.length) {
    const issues = (Array.isArray(qc.issues) ? qc.issues : []).filter((i): i is string => typeof i === 'string' && !!i.trim()).slice(0, 2);
    sentences.push(issues.length ? issues.map((i) => i.trim().replace(/[.\s]+$/, '')).join('; ') : 'the page check scored it low');
  }

  // A check that measured nothing (no usable reply): its boxes are the blueprint's.
  const unmeasured = checks.boxesFrom === 'estimate' && !drawn;
  const fixes = fixesFor(page, { speakers, undrawn: beats.undrawn, countOff, unmeasured, structured, low }, opts, nameOf);
  const freeFixes = fixes.filter((f) => f.free);
  const lead = score !== undefined && score < LOW_QC_SCORE ? `Page ${page.n} may need another pass` : `Check page ${page.n}`;
  const text = [
    `${lead}: ${sentences.join('; ')}.`,
    freeFixes.length ? `Free fix: ${listWords(freeFixes.map((f) => lowerFirst(f.label)))}.` : '',
    `Open page ${page.n} to fix one panel, or say “redraw page ${page.n}” for a new take.`
  ]
    .filter(Boolean)
    .join(' ');
  return { tone: score !== undefined && score < LOW_QC_SCORE ? 'warn' : 'info', text, fixes };
}

/** Fix chips: free first, then paid by price (cheapest first), at most MAX_NOTICE_FIXES. */
function fixesFor(
  page: Page,
  found: { speakers: MissingSpeaker[]; undrawn: number[]; countOff: boolean; unmeasured: boolean; structured: boolean; low: boolean },
  opts: QcNoticeOptions,
  nameOf: (castId?: string) => string
): QcNoticeFix[] {
  const free: QcNoticeFix[] = [];
  const paid: { fix: QcNoticeFix; usd: number }[] = [];
  const offerPaid = (label: string, action: SpendAction) => {
    const usd = opts.quote?.(action);
    if (typeof usd !== 'number' || !Number.isFinite(usd) || usd < 0) return;
    paid.push({ fix: { label, free: false, action: { ...action, quotedUsd: usd } as StudioAction }, usd });
  };
  const panelOf = (n: number): Panel | undefined => page.panels.find((p) => p.n === n);

  // Missing speaker: a caption needs no drawing (overlay pages only — in-art lines are part of the
  // picture and hashed), or one quoted redraw of that panel.
  for (const m of found.speakers.slice(0, MAX_NAMED)) {
    const panel = panelOf(m.panel);
    if (!panel) continue;
    const lines = panel.lines.filter((l) => l.speakerId === m.castId && VOICE_KINDS.has(l.kind) && l.text.trim());
    const name = nameOf(m.castId);
    if (opts.doc && opts.doc.format.lettering !== 'in_art' && lines.length) {
      const ops: DocOp[] = lines.map((l) => ({ op: 'line', pageId: page.id, panelId: panel.id, id: l.id, patch: { kind: 'caption' } }));
      free.push({ label: `Make ${name}'s ${lines.length === 1 ? 'line' : 'lines'} in panel ${m.panel} a caption`, free: true, action: { type: 'patch', ops } });
    }
    offerPaid(`Redraw panel ${m.panel} with ${name}`, {
      type: 'edit_page',
      pageId: page.id,
      panelN: m.panel,
      instruction: `In panel ${m.panel} only, draw ${name} clearly — they speak in this panel and must be visible. Keep everything else on the page exactly as it is.`
    });
  }

  // A planned moment drawn nowhere: redraw the panel that should show it, from its own action.
  for (const n of found.undrawn.slice(0, 1)) {
    const action = clip(panelOf(n)?.action || '', MAX_ACTION_IN_INSTRUCTION);
    if (!action) continue;
    offerPaid(`Redraw panel ${n} to show its moment`, {
      type: 'edit_page',
      pageId: page.id,
      panelN: n,
      instruction: `In panel ${n} only, redraw the art to show: ${/[.!?…]$/.test(action) ? action : `${action}.`} Keep everything else on the page exactly as it is.`
    });
  }

  // The panels may simply have been misread (or not read at all): a re-check is the cheapest look.
  if (found.countOff || found.unmeasured) offerPaid(`Re-check page ${page.n}`, { type: 'recheck_page', pageId: page.id });
  if (found.structured || found.low) offerPaid(`Redraw page ${page.n}`, { type: 'render_pages', pageIds: [page.id], force: true });

  const seen = new Set<string>();
  return [...free, ...paid.sort((a, b) => a.usd - b.usd).map((p) => p.fix)]
    .filter((f) => (seen.has(f.label) ? false : (seen.add(f.label), true)))
    .slice(0, MAX_NOTICE_FIXES);
}
