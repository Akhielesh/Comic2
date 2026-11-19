// The free whole-comic review (liveturn LT-10): one pure pass over the stored comic that lists what is wrong, where and
// what fixes it. $0 and deterministic: no model, no network, no clock, no randomness; the same comic always gives the same
// report with the same ids. Users (LT-11, at the end of a run, from a tool or a chip) and the house runner share it.
//
// It reads what the studio already stores and draws, never new data:
//   * the lettering engine's plans of each page (planLettering with the caller's Measure: the board's canvas measure,
//     or estimateMeasure on the server): letter fit overflow, crowded reasons, the drawn tail tips, the resolved styles;
//   * the page check (QcReport) in page space (pageSpaceQc): face boxes, speakers' heads, beats, missing speakers and
//     the stored findings;
//   * the editor's reading-order checks (lineOrderIssues, panelOrderIssue), the continuity ledger lint
//     (lintContinuity), what a drawn page carries now against what it was drawn with (staleReasons), the plan's word
//     budget (textBudget) and the script registry (languages.ts).
//
// Format-aware and advisory: no rule asks for a panel count, an establishing panel or a minimum of words, and style
// and pacing are notes only, so a wordless book of big quiet panels reviews clean. Pages with no art are not reviewed.
// Findings never quote a line's words (they name the place: "Page 4, panel 2, line 1") and never carry a price.

import { artModeOf, type Balloon, type Box, type ComicDoc, type Line, type LineKind, type Page, type Panel, type QcReport } from '../doc.js';
import { lintContinuity, type ContinuityIssue } from '../continuity.js';
import { staleReasons } from '../anchors.js';
import { hashString } from '../hash.js';
import { scriptOf, sameLanguage, languageSpec, SCRIPTS, type ScriptId } from '../languages.js';
import { estimateMeasure, letteringAspect, planLettering, PLAN_W, TEXT_SLIVER, turnedOutlineBox, type LetterPlan, type Measure } from '../lettering/layout.js';
import { KIND_FONT_SCALE, LETTER_METRICS, resolveLetterStyle } from '../lettering/style.js';
import { panelBoxesFor } from '../pageGeometry.js';
import { pageSpaceQc } from '../panelize/space.js';
import { OFF_PANEL_SHOTS, PANEL_LIMITS, panelWords, textBudget, textUnitFor } from '../panelRules.js';
import { isKidsAudience } from '../safety.js';
import { normalizeLetteringText } from '../textLayout.js';
import { lineRefsOf, whereText, type LineRef } from '../translationProblems.js';
import { lineOrderIssues, panelOrderIssue } from '../editor/readingOrder.js';
import { buildScene, planOutlineBox } from '../editor/scene.js';
import { REVIEW_LIMITS, REVIEW_RULES, type PageRef, type ReviewFinding, type ReviewFix, type ReviewReport, type ReviewRule, type ReviewSeverity } from './types.js';

export interface ReviewOptions {
  /** The measure the lettering is planned with: the board's (canvas, fonts ready) or estimateMeasure (server, tests). */
  measure: Measure;
  /**
   * The lettering plans of a page when the caller already drew them (the board): used as given. Undefined for a page →
   * planned here with `measure`.
   */
  plansFor?: (page: Page) => readonly LetterPlan[] | undefined;
}

// ── Small helpers ────────────────────────────────────────────────────────────

const LIMIT = REVIEW_LIMITS;
const SPOKEN: ReadonlySet<LineKind> = new Set<LineKind>(['speech', 'thought', 'whisper', 'shout']);
const RULE_ORDER = new Map(REVIEW_RULES.map((r, i) => [r, i]));
const KIND_WORD: Record<LineKind, string> = { speech: 'balloon', thought: 'thought balloon', whisper: 'whisper', shout: 'shout', caption: 'caption', sfx: 'sound effect' };
const SCRIPT_WORD: Record<ScriptId, string> = {
  Latn: 'Latin',
  Deva: 'Devanagari',
  Telu: 'Telugu',
  Taml: 'Tamil',
  Knda: 'Kannada',
  Mlym: 'Malayalam',
  Beng: 'Bengali',
  Gujr: 'Gujarati',
  Guru: 'Gurmukhi',
  Arab: 'Arabic',
  Aran: 'Arabic',
  Jpan: 'Japanese',
  Kore: 'Korean',
  Hans: 'Chinese'
};

/** Scripts a foreign letter is named by (Han reads as Chinese unless it is kana; Urdu letters as Arabic). */
const FOREIGN_ORDER: readonly ScriptId[] = ['Latn', 'Deva', 'Telu', 'Taml', 'Knda', 'Mlym', 'Beng', 'Gujr', 'Guru', 'Arab', 'Kore', 'Hans', 'Jpan'];

const cap1 = (s: string): string => (s ? s[0].toUpperCase() + s.slice(1) : s);
const area = (b: Box): number => (b.w > 0 && b.h > 0 ? b.w * b.h : 0);
const overlapOf = (a: Box, b: Box): Box | null => {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const w = Math.min(a.x + a.w, b.x + b.w) - x;
  const h = Math.min(a.y + a.h, b.y + b.h) - y;
  return w > 1e-9 && h > 1e-9 ? { x, y, w, h } : null;
};
const inside = (b: Box, p: { x: number; y: number }): boolean => p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h;
const isDrawn = (page: Page): boolean => !!page.render?.asset?.path;
const hasText = (line: Line): boolean => !!normalizeLetteringText(line.text);

/** "Page 4, panel 2, line 1" / "Page 4, panel 2" / "Page 4". */
const placeOf = (ref: LineRef | PageRef): string =>
  'lineId' in ref ? cap1(whereText([ref])) : ref.panel ? `Page ${ref.page}, panel ${ref.panel}` : `Page ${ref.page}`;

// ── Colour (WCAG relative luminance) ─────────────────────────────────────────

/** '#rgb', '#rrggbb' or '#rrggbbaa' → rgb 0..255 and alpha 0..1; anything else (none, auto, a name) → undefined. */
const parseHex = (c: unknown): { r: number; g: number; b: number; a: number } | undefined => {
  if (typeof c !== 'string') return undefined;
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(c.trim());
  if (!m) return undefined;
  let h = m[1];
  if (h.length === 3) h = h.split('').map((x) => x + x).join('');
  const n = (i: number) => parseInt(h.slice(i, i + 2), 16);
  return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) / 255 : 1 };
};
const over = (top: { r: number; g: number; b: number; a: number }, under: { r: number; g: number; b: number }) => ({
  r: top.r * top.a + under.r * (1 - top.a),
  g: top.g * top.a + under.g * (1 - top.a),
  b: top.b * top.a + under.b * (1 - top.a)
});
const luminance = (c: { r: number; g: number; b: number }): number => {
  const ch = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * ch(c.r) + 0.7152 * ch(c.g) + 0.0722 * ch(c.b);
};
const ratio = (a: { r: number; g: number; b: number }, b: { r: number; g: number; b: number }): number => {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
};
const WHITE = { r: 255, g: 255, b: 255 };
const BLACK = { r: 0, g: 0, b: 0 };

/**
 * The worst contrast of text over a fill: a see-through fill is laid over white and over black art (the two ends of
 * what can be under it) and the lower ratio counts. Undefined when either colour is not a plain hex colour.
 */
export const contrastOver = (text: unknown, fill: unknown): number | undefined => {
  const t = parseHex(text);
  const f = parseHex(fill);
  if (!t || !f || f.a <= 0.05) return undefined;
  let worst = Infinity;
  for (const art of [WHITE, BLACK]) {
    const bg = over(f, art);
    worst = Math.min(worst, ratio(over(t, bg), bg));
  }
  return worst;
};

// ── The reading size on a phone ──────────────────────────────────────────────

/**
 * Pixels per page width when the reader shows this panel on a 360 × 640 phone. A webtoon scrolls at the full width.
 * Every other format is read panel by panel in the guided reader (its camera rule: the panel plus 5 % padding grown to
 * the view's shape, zoom 1..4 over the page fitted to the view).
 */
export const readPxPerPageWidth = (kind: string | undefined, aspect: number, box: Box | undefined): number => {
  const vw = LIMIT.readWidthPx;
  const vh = LIMIT.readHeightPx;
  const pageW = kind === 'webtoon' ? vw : Math.min(vw, vh * aspect);
  if (kind === 'webtoon' || !box || !(box.w > 0) || !(box.h > 0)) return pageW;
  const pageH = pageW / aspect;
  let w = box.w * pageW * (1 + 2 * LIMIT.guidedPad);
  let h = box.h * pageH * (1 + 2 * LIMIT.guidedPad);
  if (w / h > vw / vh) h = w / (vw / vh);
  else w = h * (vw / vh);
  const s = Math.min(LIMIT.guidedMaxZoom, Math.max(1, vw / w));
  return pageW * s;
};

// ── Book-wide context (built once per review) ────────────────────────────────

interface BookCtx {
  doc: ComicDoc;
  refs: ReadonlyMap<string, LineRef>;
  lang: string;
  overlay: boolean;
  /** Names (cast, places, kept glossary terms and their forms) removed before the language check. */
  names: RegExp | undefined;
  unit: ReturnType<typeof textUnitFor>;
  kidsShare: number;
  /** The comic's own look's size for a kind (before the creator's size changes), plan units, by kind|lang. */
  ownSize: (kind: LineKind, lang: string) => number;
  lint: ReadonlyMap<string, ContinuityIssue[]>;
  nameOf: (castId: string | undefined) => string | undefined;
  /** What the lettering of every page reads from the book (format, lettering style, brief), as a memo key. */
  letteringKey: string;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const namesRe = (doc: ComicDoc): RegExp | undefined => {
  const words = new Set<string>();
  const add = (s: unknown) => {
    if (typeof s !== 'string') return;
    const t = s.trim();
    if (!t) return;
    words.add(t);
    for (const part of t.split(/[\s\-–—'’]+/u)) if ([...part].length >= 2) words.add(part);
  };
  for (const c of doc.cast || []) add(c.name);
  for (const p of doc.places || []) add(p.name);
  for (const g of doc.i18n?.glossary || []) {
    if (g.kind === 'character' || g.kind === 'place' || g.kind === 'title' || g.policy === 'keep') {
      add(g.term);
      for (const f of Object.values(g.forms || {})) add(f);
    }
  }
  if (!words.size) return undefined;
  const alts = [...words].sort((a, b) => b.length - a.length || (a < b ? -1 : 1)).map(escapeRe);
  return new RegExp(`(?:${alts.join('|')})`, 'giu');
};

const bookCtx = (doc: ComicDoc): BookCtx => {
  const lang = doc.format?.language || 'en';
  const ls = doc.letterStyle;
  const own = new Map<string, number>();
  const lint = new Map<string, ContinuityIssue[]>();
  for (const issue of lintContinuity(doc)) {
    const list = lint.get(issue.pageId) ?? [];
    list.push(issue);
    lint.set(issue.pageId, list);
  }
  let kids = false;
  try {
    kids = isKidsAudience(doc);
  } catch {
    kids = false;
  }
  const names = new Map((doc.cast || []).map((c) => [c.id, (c.name || '').trim()]));
  return {
    doc,
    refs: lineRefsOf(doc),
    lang,
    overlay: doc.format?.lettering !== 'in_art',
    names: namesRe(doc),
    unit: textUnitFor(lang),
    kidsShare: kids ? PANEL_LIMITS.coverCapKids / PANEL_LIMITS.coverCap : 1,
    ownSize: (kind, l) => {
      const key = `${kind}|${l}`;
      let v = own.get(key);
      if (v === undefined) {
        // The look the comic chose (its preset), without the creator's own size changes on top.
        const look = resolveLetterStyle({ letterStyle: { presetId: ls?.presetId ?? 'classic' }, format: doc.format }, { id: '', kind, text: '' });
        v = PLAN_W * LETTER_METRICS.fontScale * (KIND_FONT_SCALE[kind] ?? 1) * look.sizeScale * scriptOf(l).fontScale;
        own.set(key, v);
      }
      return v;
    },
    lint,
    nameOf: (id) => (id ? names.get(id) || undefined : undefined),
    letteringKey: JSON.stringify([doc.format ?? null, doc.letterStyle ?? null, doc.brief ?? null])
  };
};

// ── One page ─────────────────────────────────────────────────────────────────

interface Draft {
  rule: ReviewRule;
  severity: ReviewSeverity;
  ref: LineRef | PageRef;
  text: string;
  fix: ReviewFix;
  /** Tells apart two findings of one rule at one place (a stored finding's id, an issue kind). */
  key?: string;
}

interface PageCtx {
  book: BookCtx;
  page: Page;
  aspect: number;
  /** Plan units per page height (PLAN_W / aspect). */
  H: number;
  boxes: Box[];
  qc: QcReport | undefined;
  plans: readonly LetterPlan[];
  stored: ReadonlyMap<string, Balloon>;
  lines: ReadonlyMap<string, { line: Line; panel: Panel }>;
  out: Draft[];
}

const pageRef = (page: Page, panel?: number): PageRef => (panel ? { pageId: page.id, page: page.n, panel } : { pageId: page.id, page: page.n });

/** The line's address; a line the review cannot address (not on a live page) falls back to its page and panel. */
const refOf = (ctx: PageCtx, lineId: string): LineRef | PageRef => {
  const ref = ctx.book.refs.get(lineId);
  if (ref) return ref;
  const panel = ctx.lines.get(lineId)?.panel;
  return pageRef(ctx.page, panel?.n);
};

/** Pinned or locked: the creator put it there, so no free fix moves it. */
const fixedByCreator = (ctx: PageCtx, lineId: string): boolean => {
  const b = ctx.stored.get(lineId);
  return !!(b && (b.pinned || b.locked));
};
const freeOr = (ctx: PageCtx, lineId: string, fix: Exclude<ReviewFix, null>): ReviewFix => (fixedByCreator(ctx, lineId) ? 'ask' : fix);

const add = (ctx: PageCtx, d: Draft): void => {
  ctx.out.push(d);
};

const kindWord = (ctx: PageCtx, lineId: string): string => KIND_WORD[ctx.lines.get(lineId)?.line.kind ?? 'speech'] ?? 'balloon';

/** text_over_face, no_face_data. */
function facesRule(ctx: PageCtx): void {
  if (!ctx.book.overlay || !ctx.plans.length) return;
  const qc = ctx.qc;
  if (!qc || (!Array.isArray(qc.keepOut) && !Array.isArray(qc.heads))) {
    add(ctx, {
      rule: 'no_face_data',
      severity: 'note',
      ref: pageRef(ctx.page),
      text: `Page ${ctx.page.n} was checked before face checks, so faces and tails can't be checked for free.`,
      fix: 'paid_recheck'
    });
    return;
  }
  const heads = (qc.heads || []).filter((h) => h?.head && Number.isFinite(h.head.x) && Number.isFinite(h.head.y));
  const faces: { box: Box; who?: string }[] = [];
  for (const k of qc.keepOut || []) {
    if (!k || k.kind !== 'face' || !k.box || !(area(k.box) > 0)) continue;
    const head = heads.find((h) => h.panel === k.panel && inside(k.box, h.head));
    faces.push({ box: k.box, who: head?.characterId });
  }
  // A head with no face box gets one (the lettering engine avoids the same box: lettering/place.ts).
  const r = LIMIT.headFaceR;
  for (const h of heads) {
    if (faces.some((f) => inside(f.box, h.head))) continue;
    faces.push({ box: { x: h.head.x - r, y: h.head.y - r * ctx.aspect, w: 2 * r, h: 2 * r * ctx.aspect }, who: h.characterId });
  }
  if (!faces.length) return;
  for (const plan of ctx.plans) {
    const outline = planOutlineBox(plan, ctx.aspect);
    let worst: { share: number; who?: string } | undefined;
    for (const f of faces) {
      const hit = overlapOf(outline, f.box);
      const share = hit ? area(hit) / area(f.box) : 0;
      if (share > LIMIT.faceCover && (!worst || share > worst.share)) worst = { share, who: f.who };
    }
    if (!worst) continue;
    const who = ctx.book.nameOf(worst.who);
    add(ctx, {
      rule: 'text_over_face',
      severity: 'fix',
      ref: refOf(ctx, plan.lineId),
      text: `${placeOf(refOf(ctx, plan.lineId))}: the ${kindWord(ctx, plan.lineId)} covers ${who ? `${who}'s face` : 'a face'}.`,
      fix: freeOr(ctx, plan.lineId, 'free_layout')
    });
  }
}

/** text_cut: letter fit overflow (fix), past the safe margin (note). */
function fitRule(ctx: PageCtx): void {
  if (!ctx.book.overlay) return;
  for (const plan of ctx.plans) {
    const ref = refOf(ctx, plan.lineId);
    if (plan.overflow) {
      add(ctx, { rule: 'text_cut', severity: 'fix', ref, text: `${placeOf(ref)}: the words don't fit their ${kindWord(ctx, plan.lineId)}.`, fix: freeOr(ctx, plan.lineId, 'free_fit') });
    } else if (plan.outOfSafeArea) {
      add(ctx, { rule: 'text_cut', severity: 'note', ref, text: `${placeOf(ref)}: the ${kindWord(ctx, plan.lineId)} runs past the safe margin, where printing can cut it.`, fix: freeOr(ctx, plan.lineId, 'free_layout') });
    }
  }
}

/** balloon_overlap: words hidden under another balloon (blocking), or a balloon the engine could not clear (fix). */
function overlapRule(ctx: PageCtx): void {
  if (!ctx.book.overlay || !ctx.plans.length) return;
  // Draw order: z, then plan order (the board stacks lettering the same way).
  const order = ctx.plans.map((p, i) => ({ p, i })).sort((a, b) => (a.p.z ?? 0) - (b.p.z ?? 0) || a.i - b.i);
  const outline = order.map(({ p }) => turnedOutlineBox(p));
  const done = new Set<string>();
  for (let top = order.length - 1; top >= 0; top -= 1) {
    for (let under = 0; under < top; under += 1) {
      const a = order[top].p;
      const b = order[under].p;
      const hit = overlapOf(outline[top], { x: b.x, y: b.y, w: b.w, h: b.h });
      if (!hit || hit.w <= TEXT_SLIVER || hit.h <= TEXT_SLIVER) continue;
      // The finding sits on the balloon a free fix may move: the one on top, else the one under it.
      const movable = !fixedByCreator(ctx, a.lineId) ? a : !fixedByCreator(ctx, b.lineId) ? b : a;
      const other = movable === a ? b : a;
      if (done.has(movable.lineId)) continue;
      done.add(movable.lineId);
      const ref = refOf(ctx, movable.lineId);
      const words = movable === a ? `sits over the words of ${whereOf(ctx, other.lineId)}` : `has its words hidden under ${whereOf(ctx, other.lineId)}`;
      add(ctx, { rule: 'balloon_overlap', severity: 'blocking', ref, text: `${placeOf(ref)}: the ${kindWord(ctx, movable.lineId)} ${words}.`, fix: freeOr(ctx, movable.lineId, 'free_layout') });
    }
  }
  for (const plan of ctx.plans) {
    if (plan.crowdedReason !== 'overlap' || done.has(plan.lineId)) continue;
    done.add(plan.lineId);
    const ref = refOf(ctx, plan.lineId);
    add(ctx, { rule: 'balloon_overlap', severity: 'fix', ref, text: `${placeOf(ref)}: the ${kindWord(ctx, plan.lineId)} still overlaps another balloon.`, fix: freeOr(ctx, plan.lineId, 'free_layout') });
  }
}

const whereOf = (ctx: PageCtx, lineId: string): string => {
  const ref = ctx.book.refs.get(lineId);
  return ref ? whereText([ref]) : 'another balloon';
};

/** reading_order: read out of turn or outside its panel (the engine's reasons), stored balloons and frames out of order. */
function orderRule(ctx: PageCtx): void {
  const flagged = new Set<string>();
  if (ctx.book.overlay) {
    for (const plan of ctx.plans) {
      if (plan.crowdedReason !== 'order' && plan.crowdedReason !== 'outside') continue;
      flagged.add(plan.lineId);
      const ref = refOf(ctx, plan.lineId);
      const what = plan.crowdedReason === 'order' ? 'is read out of turn' : 'sits outside its panel';
      add(ctx, { rule: 'reading_order', severity: 'fix', ref, text: `${placeOf(ref)}: the ${kindWord(ctx, plan.lineId)} ${what}.`, fix: freeOr(ctx, plan.lineId, 'free_layout') });
    }
    if (ctx.page.balloons?.length) {
      const scene = buildScene(ctx.book.doc, ctx.page, { plans: ctx.plans });
      for (const issue of lineOrderIssues(ctx.book.doc, ctx.page, scene)) {
        if (flagged.has(issue.early)) continue;
        flagged.add(issue.early);
        const ref = refOf(ctx, issue.early);
        add(ctx, { rule: 'reading_order', severity: 'fix', ref, text: `${placeOf(ref)}: the ${kindWord(ctx, issue.early)} is placed so it reads before ${whereOf(ctx, issue.before)}.`, fix: 'ask' });
      }
    }
  }
  const panels = panelOrderIssue(ctx.book.doc, ctx.page);
  if (panels) {
    add(ctx, { rule: 'reading_order', severity: 'fix', ref: pageRef(ctx.page, panels.early), text: `Page ${ctx.page.n}: panel ${panels.early} now reads before panel ${panels.before}.`, fix: 'ask' });
  }
}

/** tail_wrong_speaker: the drawn tail tip is clearly nearer another character's head than the speaker's. */
function tailRule(ctx: PageCtx): void {
  if (!ctx.book.overlay || !Array.isArray(ctx.qc?.heads)) return;
  const heads = ctx.qc!.heads!.filter((h) => h?.head && Number.isFinite(h.head.x) && Number.isFinite(h.head.y));
  if (heads.length < 2) return;
  const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, (a.y - b.y) / ctx.aspect);
  for (const plan of ctx.plans) {
    const info = ctx.lines.get(plan.lineId);
    const speaker = info?.line.speakerId;
    if (!plan.tip || !speaker || !SPOKEN.has(plan.kind)) continue;
    const inPanel = heads.filter((h) => h.panel === plan.panelN);
    const own = inPanel.find((h) => h.characterId === speaker);
    if (!own) continue;
    const tip = { x: plan.tip.x / PLAN_W, y: plan.tip.y / ctx.H };
    const dOwn = dist(tip, own.mouth ?? own.head);
    let nearest: { d: number; who?: string } | undefined;
    for (const h of inPanel) {
      if (!h.characterId || h.characterId === speaker) continue;
      const d = dist(tip, h.mouth ?? h.head);
      if (!nearest || d < nearest.d) nearest = { d, who: h.characterId };
    }
    if (!nearest || !(nearest.d < LIMIT.tailMargin * dOwn)) continue;
    const ref = refOf(ctx, plan.lineId);
    const them = ctx.book.nameOf(nearest.who) ?? 'someone else';
    const me = ctx.book.nameOf(speaker);
    add(ctx, { rule: 'tail_wrong_speaker', severity: 'fix', ref, text: `${placeOf(ref)}: the tail points at ${them}${me ? `, not ${me}` : ''}.`, fix: freeOr(ctx, plan.lineId, 'free_tail') });
  }
}

/** speaker_not_drawn: the page check reads a speaker as not drawn where they still speak (vision.ts's own rule). */
function speakersRule(ctx: PageCtx): void {
  const missing = ctx.qc?.missingSpeakers;
  if (!Array.isArray(missing)) return;
  const seen = new Set<string>();
  for (const m of missing) {
    const panel = ctx.page.panels.find((p) => p.n === m?.panel);
    if (!panel || !m.castId || seen.has(`${panel.n}|${m.castId}`)) continue;
    // Off-panel shots and voices are never "missing"; someone the plan no longer has in the panel neither.
    if (OFF_PANEL_SHOTS.has(panel.shot) || !panel.castIds.includes(m.castId)) continue;
    const voice = panel.lines.find((l) => l.speakerId === m.castId && SPOKEN.has(l.kind) && hasText(l));
    if (!voice) continue;
    seen.add(`${panel.n}|${m.castId}`);
    const ref = refOf(ctx, voice.id);
    const who = ctx.book.nameOf(m.castId) ?? 'Someone';
    add(ctx, { rule: 'speaker_not_drawn', severity: 'fix', ref, text: `${placeOf(ref)}: ${who} speaks here but isn't drawn in the panel.`, fix: 'ask', key: m.castId });
  }
}

/** beats_out_of_order: a drawn panel shows another panel's moment (the page check's beats). */
function beatsRule(ctx: PageCtx): boolean {
  const beats = ctx.qc?.beats;
  if (!Array.isArray(beats) || beats.length !== ctx.page.panels.length) return false;
  const i = beats.findIndex((b, k) => b !== 0 && b !== k + 1);
  if (i < 0) return false;
  add(ctx, { rule: 'beats_out_of_order', severity: 'fix', ref: pageRef(ctx.page, i + 1), text: `Page ${ctx.page.n}: drawn panel ${i + 1} shows the moment of panel ${beats[i]}.`, fix: 'ask' });
  return true;
}

/** The page check's finding kinds in plain words (its own note is model text and is never copied). */
const FINDING_WORDS: Record<string, string> = {
  continuity: "shows a change the script didn't ask for",
  style: "drifts from the comic's style",
  extra: "shows someone the plan doesn't have here",
  missing: 'is missing someone the plan has here',
  beat: 'shows another moment than the plan'
};

/** open_page_finding: what the page check stored that nobody marked "Looks fine" (its words are not copied). */
function storedFindingsRule(ctx: PageCtx, beatsReported: boolean): void {
  const findings = ctx.qc?.findings;
  if (!Array.isArray(findings)) return;
  const missingReported = new Set(ctx.out.filter((d) => d.rule === 'speaker_not_drawn' && d.ref.pageId === ctx.page.id).map((d) => `${'panel' in d.ref ? d.ref.panel : 0}|${d.key}`));
  for (const f of findings) {
    if (!f || f.dismissed || typeof f.id !== 'string') continue;
    if (f.kind === 'beat' && beatsReported) continue;
    if (f.kind === 'missing' && missingReported.has(`${f.panel}|${f.characterId}`)) continue;
    const panelN = typeof f.panel === 'number' && f.panel > 0 && ctx.page.panels.some((p) => p.n === f.panel) ? f.panel : undefined;
    const ref = pageRef(ctx.page, panelN);
    const who = ctx.book.nameOf(f.characterId);
    const subject =
      f.kind === 'identity'
        ? `${who ?? 'someone'} may not look like themselves`
        : `${panelN ? 'the panel' : 'the page'} ${FINDING_WORDS[f.kind] ?? 'has something to look at'}${who ? ` (${who})` : ''}`;
    const fix: ReviewFix = f.fix?.kind === 'redraw' || f.fix?.kind === 'panel_fix' ? 'paid_redraw' : 'ask';
    add(ctx, { rule: 'open_page_finding', severity: f.severity === 'major' ? 'fix' : 'note', ref, text: `${placeOf(ref)}: the page check found that ${subject}.`, fix, key: f.id });
  }
}

/** low_contrast: text and fill too close in brightness (one finding per colour pair on a page). */
function contrastRule(ctx: PageCtx): void {
  if (!ctx.book.overlay) return;
  const groups = new Map<string, { lineId: string; ratio: number; count: number }>();
  for (const plan of ctx.plans) {
    const s = plan.style;
    if (!s || s.shape === 'none' || s.fill === 'none') continue;
    const c = contrastOver(s.textColor, s.fill);
    if (c === undefined || c >= LIMIT.minContrast) continue;
    // An outline that stands out from the fill keeps the words readable.
    const stroke = s.textStroke && s.textStroke.width >= 0.05 ? contrastOver(s.textStroke.color, s.fill) : undefined;
    if (stroke !== undefined && stroke >= LIMIT.minContrast) continue;
    const key = `${String(s.textColor).toLowerCase()}|${String(s.fill).toLowerCase()}`;
    const g = groups.get(key);
    if (g) g.count += 1;
    else groups.set(key, { lineId: plan.lineId, ratio: c, count: 1 });
  }
  for (const [key, g] of groups) {
    const ref = refOf(ctx, g.lineId);
    const more = g.count > 1 ? ` (and ${g.count - 1} more on this page)` : '';
    add(ctx, {
      rule: 'low_contrast',
      severity: 'fix',
      ref,
      text: `${placeOf(ref)}: the words and their ${kindWord(ctx, g.lineId)} are too close in brightness to read well (${g.ratio.toFixed(1)}:1; 3:1 reads well)${more}.`,
      fix: 'ask',
      key
    });
  }
}

/** tiny_text: words lettered smaller than their own look that read under 11 px on a phone (one note a page). */
function tinyRule(ctx: PageCtx): void {
  if (!ctx.book.overlay) return;
  const boxByN = new Map(ctx.page.panels.map((p, i) => [p.n, ctx.boxes[i]]));
  let smallest: { lineId: string; px: number } | undefined;
  let count = 0;
  for (const plan of ctx.plans) {
    if (plan.kind === 'sfx' || !(plan.fontSize > 0)) continue; // sound effects are part of the picture
    const own = ctx.book.ownSize(plan.kind, plan.lang || ctx.book.lang);
    if (!(plan.fontSize < LIMIT.ownLookShare * own)) continue;
    const px = (plan.fontSize / PLAN_W) * readPxPerPageWidth(ctx.book.doc.format?.kind, ctx.aspect, boxByN.get(plan.panelN));
    if (!(px < LIMIT.minReadPx)) continue;
    count += 1;
    if (!smallest || px < smallest.px) smallest = { lineId: plan.lineId, px };
  }
  if (!smallest) return;
  const ref = refOf(ctx, smallest.lineId);
  const lines = count === 1 ? 'the words read' : `${count} lines read`;
  add(ctx, {
    rule: 'tiny_text',
    severity: 'note',
    ref,
    text: `${placeOf(ref)}: ${lines} at about ${Math.max(1, Math.round(smallest.px))} px on a phone, smaller than this comic's lettering (11 px reads comfortably).`,
    fix: 'ask'
  });
}

/** wrong_language: a line not written in the comic's script (names, sound effects and a few letters aside). */
function languageRule(ctx: PageCtx): void {
  const book = ctx.book;
  const script = scriptOf(book.lang);
  const langName = languageSpec(book.lang)?.english ?? book.lang;
  for (const panel of ctx.page.panels) {
    for (const line of panel.lines || []) {
      if (line.kind === 'sfx' || line.noTranslate || !hasText(line)) continue;
      // A line the author marked as another language on purpose is theirs.
      if (line.lang && !sameLanguage(line.lang, book.lang)) continue;
      const text = book.names ? line.text.replace(book.names, ' ') : line.text;
      const letters = text.match(/\p{L}/gu) || [];
      if (letters.length < LIMIT.minForeign) continue;
      let own = 0;
      const others = new Map<ScriptId, number>();
      for (const ch of letters) {
        if (script.letters.test(ch)) {
          own += 1;
          continue;
        }
        const id = FOREIGN_ORDER.find((k) => SCRIPTS[k].letters.test(ch));
        if (id) others.set(id, (others.get(id) ?? 0) + 1);
      }
      const foreign = letters.length - own;
      if (foreign < LIMIT.minForeign || own / letters.length >= LIMIT.scriptShare) continue;
      const top = [...others].sort((a, b) => b[1] - a[1])[0]?.[0];
      const ref = refOf(ctx, line.id);
      const kind = KIND_WORD[line.kind] === 'balloon' ? 'line' : KIND_WORD[line.kind];
      add(ctx, {
        rule: 'wrong_language',
        severity: 'fix',
        ref,
        text: `${placeOf(ref)}: this ${kind} is written in ${top ? `${SCRIPT_WORD[top]} letters` : 'another script'}, not in ${langName}.`,
        fix: 'ask'
      });
    }
  }
}

/** too_many_words: a panel over 1.25 × the format's own word budget for its size (children's books budget less). */
function wordsRule(ctx: PageCtx): void {
  const unit = ctx.book.unit;
  ctx.page.panels.forEach((panel, i) => {
    const box = ctx.boxes[i];
    if (!box) return;
    const words = panelWords(panel, unit);
    if (!words) return;
    const balloons = panel.lines.filter((l) => l.kind !== 'sfx' && hasText(l)).length;
    const budget = textBudget(box.w * box.h, Math.max(1, balloons), unit) * ctx.book.kidsShare;
    if (!(words > LIMIT.wordsOver * budget)) return;
    const noun = unit.noun;
    add(ctx, {
      rule: 'too_many_words',
      severity: 'note',
      ref: pageRef(ctx.page, panel.n),
      text: `Page ${ctx.page.n}, panel ${panel.n}: ${words} ${noun}s for a panel this size; this format holds about ${Math.max(0, Math.floor(budget))} there.`,
      fix: 'ask'
    });
  });
}

const CARRIED_PARTS = new Set(['continuity', 'place_look', 'prop']);

/** continuity: the ledger's slips on this page, and what the page carries that changed since it was drawn. */
function continuityRule(ctx: PageCtx): void {
  for (const issue of ctx.book.lint.get(ctx.page.id) ?? []) {
    add(ctx, { rule: 'continuity', severity: 'note', ref: pageRef(ctx.page), text: issue.text, fix: 'ask', key: `${issue.kind}|${issue.castId ?? ''}|${issue.prop ?? ''}` });
  }
  const changed = staleReasons(ctx.book.doc, ctx.page).filter((r) => CARRIED_PARTS.has(r.part));
  if (changed.length) {
    const what = changed.slice(0, 3).map((r) => r.text).join('; ');
    const more = changed.length > 3 ? `; and ${changed.length - 3} more` : '';
    add(ctx, { rule: 'continuity', severity: 'note', ref: pageRef(ctx.page), text: `Page ${ctx.page.n} was drawn before these changed: ${what}${more}.`, fix: 'paid_redraw', key: 'drawn_before' });
  }
}

// ── Lettering plans, remembered ──────────────────────────────────────────────
//
// Planning the lettering is most of a review's time (the rules themselves take a few milliseconds for 40 pages), and a
// comic is reviewed again after edits that leave most pages as they were. The plans of a page are remembered per measure
// function (LRU), keyed by everything planLettering reads: the page's own content (panels and lines, balloons, layout,
// art mode, frame style, the drawing's size and its page check) and the book's format, lettering style and brief. The key
// is the content itself, never an object's identity, so a page edited in place is planned again. A page shown in its
// panel frames may read other pictures' sizes, so it is always planned afresh.

const PLAN_MEMO_SIZE = 200;
const PLAN_MEMO = new WeakMap<Measure, Map<string, readonly LetterPlan[]>>();

const pageKey = (page: Page): string => {
  const r = page.render;
  return JSON.stringify([page.n, page.layout, page.panels, page.balloons, page.frameStyle ?? null, r?.asset?.w ?? null, r?.asset?.h ?? null, r?.aspect ?? null, r?.qc ?? null]);
};

const plansOf = (book: BookCtx, page: Page, aspect: number, measure: Measure): readonly LetterPlan[] => {
  if (artModeOf(page) === 'panels') return planLettering(book.doc, page, aspect, measure);
  let memo = PLAN_MEMO.get(measure);
  if (!memo) PLAN_MEMO.set(measure, (memo = new Map()));
  const key = `${book.letteringKey}|${aspect}|${pageKey(page)}`;
  const hit = memo.get(key);
  if (hit) {
    memo.delete(key);
    memo.set(key, hit);
    return hit;
  }
  const plans = planLettering(book.doc, page, aspect, measure);
  memo.set(key, plans);
  if (memo.size > PLAN_MEMO_SIZE) {
    const oldest = memo.keys().next().value;
    if (oldest !== undefined) memo.delete(oldest);
  }
  return plans;
};

function reviewPage(book: BookCtx, page: Page, opts: ReviewOptions, out: Draft[]): void {
  const doc = book.doc;
  const aspect = letteringAspect(doc, page);
  const measure = typeof opts?.measure === 'function' ? opts.measure : estimateMeasure;
  const given = book.overlay ? opts?.plansFor?.(page) : undefined;
  const plans = book.overlay ? (given ?? plansOf(book, page, aspect, measure)) : [];
  const stored = new Map<string, Balloon>();
  for (const b of page.balloons || []) if (b && typeof b.lineId === 'string' && !stored.has(b.lineId)) stored.set(b.lineId, b);
  const lines = new Map<string, { line: Line; panel: Panel }>();
  for (const panel of page.panels || []) for (const line of panel.lines || []) lines.set(line.id, { line, panel });
  const ctx: PageCtx = { book, page, aspect, H: PLAN_W / aspect, boxes: panelBoxesFor(doc, page), qc: pageSpaceQc(doc, page), plans, stored, lines, out };
  facesRule(ctx);
  fitRule(ctx);
  overlapRule(ctx);
  orderRule(ctx);
  tailRule(ctx);
  speakersRule(ctx);
  const beats = beatsRule(ctx);
  storedFindingsRule(ctx, beats);
  contrastRule(ctx);
  tinyRule(ctx);
  languageRule(ctx);
  wordsRule(ctx);
  continuityRule(ctx);
}

// ── The report ───────────────────────────────────────────────────────────────

const refKey = (ref: LineRef | PageRef): string => ('lineId' in ref ? `l:${ref.lineId}` : `p:${ref.panel ?? 0}`);
const posOf = (ref: LineRef | PageRef): [number, number, number] => ('lineId' in ref ? [ref.page, ref.panel, ref.line] : [ref.page, ref.panel ?? 0, 0]);

/**
 * The free review of a whole comic: every drawn page, every rule. Pure and deterministic (same comic, same report, same
 * ids); a 40-page comic reviews in a few milliseconds once its lettering is planned.
 */
export function reviewComicFree(doc: ComicDoc, opts: ReviewOptions): ReviewReport {
  const pages = [...(doc?.pages || [])].sort((a, b) => a.n - b.n);
  const book = bookCtx(doc);
  const drafts: Draft[] = [];
  let checked = 0;
  for (const page of pages) {
    if (!isDrawn(page)) continue;
    checked += 1;
    reviewPage(book, page, opts, drafts);
  }
  const seen = new Set<string>();
  const findings: ReviewFinding[] = [];
  for (const d of drafts) {
    const id = `rv_${hashString([d.rule, d.ref.pageId, refKey(d.ref), d.key ?? ''].join('|'))}`;
    if (seen.has(id)) continue;
    seen.add(id);
    findings.push({ id, rule: d.rule, severity: d.severity, ref: d.ref, text: d.text, fix: d.fix });
  }
  findings.sort((a, b) => {
    const pa = posOf(a.ref);
    const pb = posOf(b.ref);
    return pa[0] - pb[0] || pa[1] - pb[1] || pa[2] - pb[2] || (RULE_ORDER.get(a.rule) ?? 0) - (RULE_ORDER.get(b.rule) ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  });
  const counts = { blocking: 0, fix: 0, note: 0 };
  for (const f of findings) counts[f.severity] += 1;
  return { v: 1, pages: pages.length, checked, findings, counts };
}
