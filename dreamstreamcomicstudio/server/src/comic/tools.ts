// Comic Director tools (v4/v5): the only way the director changes the comic.
//
// Each tool validates its arguments defensively, turns them into DocOps (or a job-runner
// action), and returns a SHORT string the model can act on ("Saved MAYA (lead). Cast:
// MAYA, ARJUN."). Tools never throw: bad arguments come back as an "Error: …" sentence
// the model can correct on the next round. Spend tools go through the job runner's gate
// — when the user must approve, the result says so with the estimate. See
// docs/features/comic-studio-v4.md §6.8 and contract §12.2.
//
// v5 guards (all deterministic, $0): a turn whose user never asked to draw only ever QUOTES
// (forced gate); a plan written this turn is never drawn in the same turn; page numbers never
// redraw a drawn, current page (redraw needs the user's own "another take"); "draw everything"
// on a finished book returns `nothing` for $0 with next steps. Every description carries its
// cost class ("FREE — …", "TEXT ≈$0.01 — …", "PAID (quoted) — …").

import {
  CAST_KINDS,
  castNoun,
  isPageStale,
  isTargetStale,
  newId,
  pageByNumber,
  resolveCharacter,
  type AssetRef,
  type Card,
  type CastKind,
  type Character,
  type CharacterLook,
  type ComicDoc,
  type Gate,
  type Line,
  type LineKind,
  type Msg,
  type NextStep,
  type OptionChoice,
  type Page,
  type Panel,
  type Place,
  type RefAsset,
  type RefOwner,
  type RenderTarget,
  type StyleBible
} from '../../../shared/comic/doc.js';
import type { StudioFocus } from '../../../shared/comic/events.js';
import { canServeToOwner, type ContentRating } from '../../../shared/comic/safety.js';
import { applyOps, type DocOp, type SpendAction } from '../../../shared/comic/ops.js';
import { DOC_LIMITS } from '../../../shared/comic/limits.js';
import { lineLengthRule } from '../../../shared/comic/languages.js';
import {
  BUBBLE_SHAPES,
  DEFAULT_LETTERING,
  FONT_IDS,
  normalizeColor,
  presetForComic,
  resolveLetterStyle,
  sanitizeLetterStylePatch,
  type LetterStylePatch
} from '../../../shared/comic/lettering/style.js';
import { estimateJobs, resolveImageJob } from '../../../shared/comic/models.js';
import { REF_LIMITS } from '../../../shared/comic/refs.js';
import { panelBoxesFor } from '../../../shared/comic/pageGeometry.js';
import { coverNeedsDraw, pageTargets as drawablePages } from '../../../shared/comic/plan.js';
import { sheetRefsChanged } from '../../../shared/comic/refRanking.js';
import { STYLE_PRESETS, getStylePreset } from '../../../shared/comic/stylePresets.js';
import { logger } from '../lib/logger.js';
import { castOpsForUncast, describeUncast, findUncastBeings } from './castScan.js';
import { costFormatterFor } from './costText.js';
import { clipText, enteredText, storableText } from './sanitize/text.js';
import {
  ASPECT_RATIOS,
  COLOR_MODES,
  COMIC_KINDS,
  CONFIRM_POLICIES,
  LETTERING_MODES,
  LINE_KINDS,
  QUALITY_TIERS,
  billedLlm,
  newTextSpendTracker,
  planPages,
  recordTextSpend,
  sanitizeFormatPatch,
  sanitizeLook,
  sanitizeSettingsPatch,
  spendIsByok,
  startAction,
  type ActionOutcome
} from './jobs.js';
import {
  MAX_TOOLS_PER_TURN,
  ToolArgError,
  defineTool,
  type DirectorTool,
  type ToolCost,
  type ToolGroup
} from './extensions.js';
import { addRefs } from './refs/index.js';
import { LETTERING_STYLE_ARGS_SCHEMA, balloonAtPosition, styleArgsToPatch } from './tools/lettering.js';
import { SKIP_REVIEW_RE, joinList, nothingNextSteps } from './replies.js';
import { StudioError, type StudioContext } from './types.js';
import { analyzeSource } from './writer.js';

export type { DirectorTool, ToolCost } from './extensions.js';

/** One executed tool call this turn (feeds composeTurnReply, P1-DIRECTOR). */
export interface TurnLogEntry {
  tool: string;
  ok: boolean;
  cost: ToolCost;
  result: string;
  ops?: number;
}

/** Per-turn state shared between the director loop and its tools. */
export interface DirectorTurn {
  /** Cards for the assistant message being written this turn (options, gates, plan, notices). */
  cards: Card[];
  /** ask_user ran: the director ends its turn after this round. */
  askedUser: boolean;
  question?: string;
  /** Images attached to the user's message this turn (tools refer to them 1-based). */
  attachments: AssetRef[];
  /** The user's message text this turn (save_source can store it verbatim). */
  userText: string;
  /** The route already saved the user's full paste/attachment to source.script this turn. */
  sourceSaved: boolean;
  /** USD of image spends this turn has already started without approval (per-turn 'big' gate). */
  spentUsd: number;
  /** A spend this turn is waiting on the user's approval — stop starting more. */
  gated: boolean;
  /** Paid writer calls (plan/revise/source analysis) made this turn. */
  paidText: number;
  // ── v5 (contract §12.2) ──
  /** Every executed tool call, in order. */
  log: TurnLogEntry[];
  /** Short facts saved this turn ("kids 2–6", "1 page, 4:5"). */
  captured: string[];
  /** From userText or the tapped option reply (DRAW_RE / REDRAW_RE). */
  drawIntent: 'explicit' | 'redraw' | 'none';
  /** plan_pages/revise_pages ran this turn: render_pages refuses same-turn draws unless SKIP_REVIEW_RE. */
  plannedThisTurn: boolean;
  /** Current attachments + carried unassigned images (numbering continues). */
  images: RefAsset[];
  /** What the user is looking at / has selected (balloons, page, panel). */
  focus?: StudioFocus;
  /** Next steps attached to the assistant message. */
  nextSteps: NextStep[];
  /** SAFETY/IP NOTE appended to the user turn (adapt decisions). */
  safetyNote?: string;
  /** effectiveRating() at turn start. */
  rating: ContentRating;
  // ── P1-DIRECTOR bookkeeping (optional; filled by runDirectorTurn) ──
  /** Turn start (ms): render failures recorded after it belong to this turn's runs. */
  startedAt?: number;
  /** Render targets this turn queued (re-read before the reply is committed — honest outcomes). */
  runs?: RenderTarget[];
  /** Error notices background work posted while the turn was running. */
  bgErrors?: string[];
  /** Status of the turn's last spend tool ('nothing' = everything already drawn, $0). */
  outcome?: ActionOutcome['status'];
  /** Trademarked names this turn steers to an original homage (said once). */
  ipNames?: string[];
}

/** Source material shorter than this is stored without a (paid) writer analysis. */
export const ANALYZE_SOURCE_MIN_CHARS = 1500;
/** Paid writer calls (plan/revise/source analysis) allowed in a single director turn. */
export const MAX_PAID_TEXT_PER_TURN = 2;
const MAX_SOURCE_CHARS = 200_000;
const SPOKEN = new Set<LineKind>(['speech', 'thought', 'whisper', 'shout']);
const LOOK_KEYS = ['summary', 'age', 'gender', 'build', 'face', 'hair', 'eyes', 'skin', 'outfit', 'palette', 'props', 'marks', 'species', 'markings'] as const;
const POSITIONS = ['top-left', 'top', 'top-right', 'left', 'center', 'right', 'bottom-left', 'bottom', 'bottom-right'] as const;
type Position = (typeof POSITIONS)[number];

const latestUserMessage = (doc: ComicDoc): Msg | undefined => [...doc.conversation].reverse().find((m) => m.role === 'user');

export const createDirectorTurn = (init: Partial<DirectorTurn> = {}): DirectorTurn => ({
  cards: [],
  askedUser: false,
  attachments: [],
  userText: '',
  sourceSaved: false,
  spentUsd: 0,
  gated: false,
  paidText: 0,
  log: [],
  captured: [],
  drawIntent: 'none',
  plannedThisTurn: false,
  images: [],
  nextSteps: [],
  rating: 'PG-13',
  ...init
});

/** The images a turn can reference by number: attachments, then carried unassigned images. */
export const turnImages = (turn: DirectorTurn): RefAsset[] => (turn.images.length ? turn.images : (turn.attachments as RefAsset[]));

/** Add next-step chips to the turn (deduped by label, capped). */
export const pushNextSteps = (turn: DirectorTurn, steps: NextStep[] = []) => {
  for (const step of steps) {
    if (!step?.label || turn.nextSteps.some((s) => s.label === step.label)) continue;
    if (turn.nextSteps.length >= DOC_LIMITS.nextSteps) break;
    turn.nextSteps.push(step);
  }
};

// ── Arg helpers ──────────────────────────────────────────────────────────────

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
/** Director-written text as it enters the doc (P2-GATE L5): jsonb-safe (sanitize/text.ts), whitespace collapsed, clipped without splitting a pair. */
const text = (v: unknown, max = 2000): string => (typeof v === 'string' ? clipText(storableText(v).replace(/\s+/g, ' ').trim(), max) : '');
const int = (v: unknown): number | undefined => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : Number.NaN;
  return Number.isFinite(n) ? Math.round(n) : undefined;
};
const intList = (v: unknown): number[] =>
  (Array.isArray(v) ? v : typeof v === 'number' || typeof v === 'string' ? [v] : []).map(int).filter((n): n is number => n !== undefined);
const strList = (v: unknown, maxItems = 20, max = 300): string[] =>
  (Array.isArray(v) ? v : typeof v === 'string' ? [v] : []).map((x) => text(x, max)).filter(Boolean).slice(0, maxItems);
const upper = (name?: string) => (name || '').trim().toUpperCase() || 'UNNAMED';
const castList = (doc: ComicDoc) => (doc.cast.length ? doc.cast.map((c) => upper(c.name)).join(', ') : '(none)');
const placeList = (doc: ComicDoc) => (doc.places.length ? doc.places.map((p) => upper(p.name)).join(', ') : '(none)');

const argError = (message: string) => new ToolArgError(message);

const schema = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'object',
  properties,
  ...(required.length ? { required } : {})
});
const S = (description: string, extra: Record<string, unknown> = {}) => ({ type: 'string', description, ...extra });
const N = (description: string) => ({ type: 'number', description });
const I = (description: string) => ({ type: 'integer', description });
const B = (description: string) => ({ type: 'boolean', description });
const A = (items: Record<string, unknown>, description: string) => ({ type: 'array', items, description });

const LOOK_HINTS: Partial<Record<(typeof LOOK_KEYS)[number], string>> = {
  summary: 'One dense, drawable visual sentence.',
  marks: 'Marks that must never drift.',
  species: 'Non-humans: what they are (mallard duckling).',
  markings: 'Non-humans: markings that never drift.'
};
const lookSchema = {
  type: 'object',
  description: 'Fill every field the user gave.',
  properties: Object.fromEntries(LOOK_KEYS.map((k) => [k, LOOK_HINTS[k] ? { type: 'string', description: LOOK_HINTS[k] } : { type: 'string' }]))
};

/** A core tool: the description gets its cost prefix ("FREE — …"), the cost is logged per call. */
const define = (
  name: string,
  cost: ToolCost,
  description: string,
  parameters: Record<string, unknown>,
  run: (args: Record<string, unknown>) => Promise<string> | string
): DirectorTool => defineTool(name, cost, description, parameters, run);

// ── Resolution helpers ───────────────────────────────────────────────────────

const findCharacterArg = (doc: ComicDoc, args: Record<string, unknown>): Character | undefined => {
  const id = text(args.id, 80);
  const name = text(args.name, 80);
  return (id && doc.cast.find((c) => c.id === id)) || (name ? resolveCharacter(doc, name) : undefined);
};

const findPlaceArg = (doc: ComicDoc, args: Record<string, unknown>): Place | undefined => {
  const id = text(args.id, 80);
  const name = text(args.name, 80).toLowerCase();
  return (id && doc.places.find((p) => p.id === id)) || (name ? doc.places.find((p) => p.name.trim().toLowerCase() === name) : undefined);
};

const pagesByNumbers = (doc: ComicDoc, numbers: number[]): Page[] => {
  const missing = numbers.filter((n) => !pageByNumber(doc, n));
  if (missing.length) {
    throw argError(`No page ${missing.join(', ')} — the plan has ${doc.pages.length} page${doc.pages.length === 1 ? '' : 's'}.`);
  }
  return [...new Set(numbers)].map((n) => pageByNumber(doc, n)!).sort((a, b) => a.n - b.n);
};

const attachmentRefs = (turn: DirectorTurn, raw: unknown): RefAsset[] => {
  const numbers = intList(raw);
  if (!numbers.length) return [];
  const images = turnImages(turn);
  const carried = images.length > turn.attachments.length;
  const out: RefAsset[] = [];
  for (const n of numbers) {
    const ref = images[n - 1];
    if (!ref) {
      throw argError(
        images.length
          ? `There are only ${images.length} image(s) ${carried ? 'available (this message and earlier unassigned ones)' : 'attached to this message'} (use 1–${images.length}).`
          : 'No images are attached to this message.'
      );
    }
    if (!out.some((r) => r.path === ref.path)) out.push(ref);
  }
  return out;
};

/** Images the user attached to a cast member/place/style go through the refs package (honest caps). */
async function attachRefs(ctx: StudioContext, owner: RefOwner, refs: RefAsset[]): Promise<string> {
  if (!refs.length) return '';
  const added = await addRefs(ctx, owner, refs.map((r) => ({ ...r, addedBy: r.addedBy ?? 'user' })));
  if (added.ops.length) ctx.session.commit(added.ops, { origin: 'director', label: 'Attach photos' });
  return added.message;
}

const summaryFromLook = (look: Partial<CharacterLook>): string =>
  [
    [look.age, look.gender, look.build].filter(Boolean).join(' '),
    look.hair ? `${look.hair} hair` : '',
    look.outfit,
    look.marks
  ]
    .map((s) => text(s, 200))
    .filter(Boolean)
    .join(', ');

const lookChanged = (before: CharacterLook, patch: Partial<CharacterLook>) =>
  Object.entries(patch).some(([k, v]) => (before as unknown as Record<string, unknown>)[k] !== v);

const castKindArg = (v: unknown): CastKind | undefined => (typeof v === 'string' && (CAST_KINDS as readonly string[]).includes(v) ? (v as CastKind) : undefined);
/** 2–12 for a group; 1 / absent = a single being. */
const countArg = (v: unknown): number | undefined => {
  const n = int(v);
  return n !== undefined && n >= 2 ? Math.min(12, n) : undefined;
};

// ── Source analysis ──────────────────────────────────────────────────────────

async function storeAndAnalyzeSource(ctx: StudioContext, turn: DirectorTurn, args: Record<string, unknown>): Promise<string> {
  const doc = ctx.session.doc;
  const stored = (doc.source.script || '').trim();
  let script = typeof args.text === 'string' ? args.text.trim() : '';
  if (!script && args.useMessage === true) script = turn.userText.trim();
  // The route already saved the user's full paste/attachment to source.script this turn; the
  // message text the model can see holds only a short excerpt. Never let that excerpt (via
  // useMessage or an inlined text arg) overwrite the full script — read it back instead.
  if (turn.sourceSaved && stored && script.length < stored.length) script = '';
  const fromStore = !script;
  if (fromStore) script = stored;
  if (!script) throw argError('No source text: pass text, set useMessage:true to save the user’s message, or ask the user to paste their script.');
  // Kept as typed (line breaks, spacing); only what jsonb rejects goes, and the clip never splits a pair (P2-GATE L5).
  script = clipText(storableText(script), MAX_SOURCE_CHARS);
  if (!fromStore) ctx.session.commit([{ op: 'source', patch: { script, updatedAt: Date.now() } }], { origin: 'director', label: 'Save the script' });

  const words = (script.match(/\S+/g) || []).length;
  const analyze = args.analyze === true || (args.analyze !== false && script.length >= ANALYZE_SOURCE_MIN_CHARS);
  if (!analyze) return `Saved the source (${words.toLocaleString('en-US')} words).`;
  guardPaidText(ctx, turn);

  const tracker = newTextSpendTracker();
  let analysis: Awaited<ReturnType<typeof analyzeSource>>;
  try {
    analysis = await analyzeSource({
      doc: ctx.session.doc,
      llm: billedLlm(ctx, { stage: 'plan', operation: 'comic.text.writer', tracker }),
      text: script,
      signal: ctx.session.abort.signal
    });
  } finally {
    recordTextSpend(ctx, tracker, 'plan', 'Read the script');
  }

  const current = ctx.session.doc;
  const ops: DocOp[] = [];
  const briefPatch: Record<string, unknown> = {};
  const filled: string[] = [];
  const b = analysis.brief || {};
  for (const key of ['title', 'logline', 'premise', 'genre', 'tone', 'audience', 'setting'] as const) {
    const value = text(b[key], key === 'premise' ? 4000 : 600);
    if (!value) continue;
    const existing = text(current.brief[key]);
    const isDefaultTitle = key === 'title' && (!existing || /^untitled comic$/i.test(existing));
    if (!existing || isDefaultTitle) {
      briefPatch[key] = value;
      filled.push(key);
    }
  }
  if (Array.isArray(b.themes) && b.themes.length && !current.brief.themes?.length) briefPatch.themes = strList(b.themes, 8, 120);
  if (Object.keys(briefPatch).length) ops.push({ op: 'brief', patch: briefPatch });
  for (const note of strList(b.notes, 12, 400)) ops.push({ op: 'note_add', text: note });

  const castNames: string[] = [];
  for (const c of analysis.cast || []) {
    const name = text(c.name, 80);
    if (!name) continue;
    const existing = resolveCharacter(current, name);
    const look = sanitizeLook(c.look) || {};
    if (existing) {
      const lookFill = Object.fromEntries(
        Object.entries(look).filter(([k, v]) => v && !text((existing.look as unknown as Record<string, unknown>)[k]))
      );
      const patch: Partial<Character> = {};
      if (Object.keys(lookFill).length) patch.look = lookFill as unknown as CharacterLook;
      if (!existing.role && c.role) patch.role = text(c.role, 200);
      if (!existing.personality && c.personality) patch.personality = text(c.personality, 1000);
      if (!existing.voice && c.voice) patch.voice = text(c.voice, 600);
      if (Object.keys(patch).length) ops.push({ op: 'character', id: existing.id, patch });
      castNames.push(`${upper(existing.name)} (${existing.tier})`);
      continue;
    }
    const tier = c.tier === 'lead' || c.tier === 'support' || c.tier === 'extra' ? c.tier : 'support';
    const kind = castKindArg((c as { kind?: unknown }).kind);
    const count = countArg((c as { count?: unknown }).count);
    ops.push({
      op: 'character',
      id: newId('c'),
      patch: {
        name,
        tier,
        ...(kind && kind !== 'person' ? { kind } : {}),
        ...(count ? { count } : {}),
        // sanitizeLook already carries species / markings, cleaned (NUL, C1 controls, split surrogates).
        look: { summary: look.summary || summaryFromLook(look), ...look } as CharacterLook,
        ...(c.role ? { role: text(c.role, 200) } : {}),
        ...(c.personality ? { personality: text(c.personality, 1000) } : {}),
        ...(c.voice ? { voice: text(c.voice, 600) } : {})
      }
    });
    castNames.push(`${upper(name)} (${tier})`);
  }

  const placeNames: string[] = [];
  for (const p of analysis.places || []) {
    const name = text(p.name, 80);
    if (!name) continue;
    const existing = current.places.find((x) => x.name.trim().toLowerCase() === name.toLowerCase());
    const look = text(p.look, 1500);
    if (existing) {
      if (!existing.look && look) ops.push({ op: 'place', id: existing.id, patch: { look } });
    } else {
      ops.push({ op: 'place', id: newId('pl'), patch: { name, look } });
    }
    placeNames.push(upper(name));
  }

  let pagesNote = '';
  if (analysis.suggestedPageCount && current.planStatus === 'none' && analysis.suggestedPageCount !== current.format.pageCount) {
    ops.push({ op: 'format', patch: { pageCount: analysis.suggestedPageCount } });
    pagesNote = `; page count set to ${analysis.suggestedPageCount}`;
  } else if (analysis.suggestedPageCount) {
    pagesNote = `; suggested ${analysis.suggestedPageCount} pages`;
  }
  if (ops.length) ctx.session.commit(ops, { origin: 'director', label: 'Read the script' });

  const after = ctx.session.doc;
  return [
    `Saved and read the source (${words.toLocaleString('en-US')} words).`,
    filled.length ? `Brief: ${filled.map((k) => (k === 'title' ? `title “${after.brief.title}”` : k)).join(', ')}.` : 'Brief already set (kept).',
    castNames.length ? `Cast: ${castNames.slice(0, 12).join(', ')}${castNames.length > 12 ? ` +${castNames.length - 12}` : ''}.` : '',
    placeNames.length ? `Places: ${placeNames.slice(0, 10).join(', ')}.` : '',
    pagesNote ? `Format${pagesNote}.` : '',
    analysis.styleHint ? `Style hint from the text: ${text(analysis.styleHint, 300)}` : ''
  ]
    .filter(Boolean)
    .join(' ');
}

// ── Spend helpers ────────────────────────────────────────────────────────────

type SpendKind = 'pages' | 'cover' | 'sheets' | 'edit' | 'style';

/** The comic has at least one generated image (style test, sheet, page or cover): its image model is locked. */
export const hasComicImage = (doc: ComicDoc): boolean => {
  const drawn = (r?: { status?: string; asset?: unknown; history?: unknown[] }) => !!r && (r.status === 'ready' || !!r.asset || !!r.history?.length);
  return (
    doc.pages.some((p) => drawn(p.render)) ||
    drawn(doc.cover.render) ||
    doc.cast.some((c) => drawn(c.sheet)) ||
    doc.places.some((p) => drawn(p.sheet)) ||
    doc.style.options.some((o) => drawn(o.render))
  );
};

/** No page of the book has ever been drawn (the first render gates for a review). */
const neverDrawn = (doc: ComicDoc) => doc.pages.every((p) => p.render.status !== 'ready' && !p.render.history.length);

/**
 * Why a director-initiated spend must wait for the user's tap even below the 'big' threshold
 * (contract §12.3 gates): a redraw, an unreviewed plan, the first render, or no draw intent.
 * Never when the user turned confirmations off — except a redraw, which always asks.
 */
export function forcedGateReason(doc: ComicDoc, turn: DirectorTurn, kind: SpendKind, opts: { redraw?: boolean } = {}): Gate['reason'] | undefined {
  if (opts.redraw) return 'redraw';
  if (doc.settings.confirm === 'never') return undefined;
  const skip = SKIP_REVIEW_RE.test(turn.userText);
  if (kind === 'pages' && doc.planStatus === 'draft' && !skip) return 'plan_review';
  if (kind === 'pages' && doc.settings.reviewFirstRender !== false && neverDrawn(doc) && !skip) return 'first_render';
  if (turn.drawIntent === 'none' && !(kind === 'style' && doc.style.status === 'empty')) return 'no_intent';
  return undefined;
}

async function spend(ctx: StudioContext, turn: DirectorTurn, action: SpendAction, forceGate?: Gate['reason']): Promise<string> {
  // One approval per turn: once a spend is waiting on the user, stop starting more so a turn
  // can't slip many individually-small spends past the 'big' threshold while one is unapproved.
  if (turn.gated) {
    return 'Refused: a spend from this turn is already waiting for the user to approve it. Tell them the estimate and stop; continue after they approve.';
  }
  // priorUsd lets the 'big' gate weigh this spend against what the turn has already started,
  // not just this one call — so N small edits in a turn still gate once their total is "big".
  const started = await startAction(ctx, action, {
    confirmed: false,
    priorUsd: turn.spentUsd,
    collectCard: (card) => turn.cards.push(card),
    collectNextSteps: (steps) => pushNextSteps(turn, steps),
    ...(forceGate ? { forceGate } : {}),
    ...(ctx.caps ? { caps: ctx.caps } : {}),
    origin: 'director'
  });
  const outcome = started.outcome;
  turn.outcome = outcome.status;
  if (outcome.status === 'started') turn.spentUsd += outcome.estimate.usd;
  else if (outcome.status === 'gated') turn.gated = true;
  else if (outcome.status === 'nothing') pushNextSteps(turn, outcome.nextSteps);
  // Renders continue after the turn; the stream stays open until they settle.
  void ctx.track(started.done);
  return outcome.message;
}

/**
 * Cap the paid writer calls (page planning, revisions, source analysis) a single turn can
 * run, and stop once the comic is at its budget cap — text spend otherwise goes through
 * neither the approval gate nor the budget, so an over-eager (or injected) run could spend
 * freely. Throws a ToolArgError the model surfaces to the user.
 */
function guardPaidText(ctx: StudioContext, turn: DirectorTurn): void {
  if (turn.paidText >= MAX_PAID_TEXT_PER_TURN) {
    throw argError('Already ran the writer twice this turn — show the user the result and ask before planning, revising or re-reading the script again.');
  }
  const budget = ctx.session.doc.settings.budgetUsd;
  if (typeof budget === 'number' && budget > 0 && ctx.session.doc.spend.totalUsd >= budget) {
    throw argError('The comic is at its budget cap — ask the user to raise it in Settings before running the writer again.');
  }
  turn.paidText += 1;
}

const priceOf = (ctx: StudioContext, kind: 'page' | 'cover' | 'sheet', count = 1): number => {
  const doc = ctx.session.doc;
  return estimateJobs([{ kind, count }], doc.settings.quality, { override: doc.settings.imageModelOverride, byok: spendIsByok(ctx.keys) }).usd;
};

const pageWord = (pages: Page[]) => (pages.length === 1 ? `Page ${pages[0].n}` : `Pages ${joinList(pages.map((p) => String(p.n)))}`);

/** Free safety net after a plan: recurring animals/props drawn in the panels become text-locked cast. */
function castUncastBeings(ctx: StudioContext): string {
  const beings = findUncastBeings(ctx.session.doc);
  if (!beings.length) return '';
  const ops = castOpsForUncast(ctx.session.doc, beings);
  if (!ops.length) return '';
  ctx.session.commit(ops, { origin: 'director', label: 'Add cast' });
  // Companions (tier support) get a model sheet with the next drawing: say what that costs.
  const companions = ops.flatMap((o) => (o.op === 'character' && o.patch.tier === 'support' && o.patch.name ? [o.patch.name] : []));
  const sheetNote = companions.length
    ? ` ${joinList(companions)} ${companions.length === 1 ? 'gets' : 'get'} a model sheet with the next drawing (${costFormatterFor(ctx).approx(priceOf(ctx, 'sheet', companions.length))}); make ${companions.length === 1 ? 'it' : 'them'} text-only (tier extra) to skip that.`
    : '';
  return ` Also added to the cast so they stay consistent: ${describeUncast(beings)} (free; the user can change or remove them).${sheetNote}`;
}

// ── Lettering helpers for edit_panel_text ────────────────────────────────────

/**
 * The lettering engine's style args (tools/lettering.ts), trimmed to the six keys a dialogue edit
 * needs so the core prompt stays small; the engine parses them (plain words, relative sizes).
 */
const LETTERING_STYLE_ARGS_COMPACT = {
  type: 'object',
  description: 'Optional lettering (free).',
  properties: Object.fromEntries(
    ['font', 'size', 'bold', 'text_color', 'fill_color', 'shape'].map((k) => [k, (LETTERING_STYLE_ARGS_SCHEMA.properties as Record<string, unknown>)[k]])
  )
};

/** The compact styleArgs subset → a sanitized LetterStylePatch (undefined when nothing valid). */
export function styleFromArgs(raw: unknown): LetterStylePatch | undefined {
  if (!isObject(raw)) return undefined;
  const out: Record<string, unknown> = {};
  if (typeof raw.font === 'string' && (FONT_IDS as readonly string[]).includes(raw.font.trim().toLowerCase())) out.font = raw.font.trim().toLowerCase();
  const size = raw.size;
  if (size === 'larger' || size === 'bigger') out.sizeScale = 1.25;
  else if (size === 'smaller') out.sizeScale = 0.85;
  else if (typeof size === 'number' || (typeof size === 'string' && /^\d+(\.\d+)?$/.test(size))) out.sizeScale = Number(size);
  if (raw.bold === true) out.weight = 700;
  if (raw.bold === false) out.weight = 400;
  const textColor = normalizeColor(raw.text_color);
  if (textColor) out.textColor = textColor;
  const fill = normalizeColor(raw.fill_color);
  if (fill) out.fill = fill;
  if (typeof raw.shape === 'string' && (BUBBLE_SHAPES as readonly string[]).includes(raw.shape.trim().toLowerCase())) out.shape = raw.shape.trim().toLowerCase();
  return sanitizeLetterStylePatch(out);
}

/**
 * The sheet's photo slots, exactly as compileCharacterSheet counts them: the shared cap, the model's
 * character (else object) slots, and the total minus the style board when one is attached.
 */
const sheetRefSlots = (doc: ComicDoc): number => {
  const { spec } = resolveImageJob('sheet', doc.settings.quality, doc.settings.imageModelOverride);
  const board = doc.style.board && canServeToOwner(doc.style.board) ? 1 : 0;
  return Math.max(0, Math.min(REF_LIMITS.sheetAuthorRefs, spec.refs.characters > 0 ? spec.refs.characters : spec.refs.objects, spec.refs.total - board));
};

/** A line's lettering patch from the compact style args, parsed by the lettering engine itself (same words as restyle_balloons). */
const lineStyleFromArgs = (doc: ComicDoc, line: Line, raw: unknown): LetterStylePatch | undefined => {
  if (!isObject(raw) || !Object.keys(raw).length) return undefined;
  const patch = styleArgsToPatch(raw, resolveLetterStyle(doc, line));
  return Object.keys(patch).length ? patch : undefined;
};

/** A 9-grid position inside the line's panel → a pinned balloon (page-normalized, clamped). */
function balloonAt(doc: ComicDoc, page: Page, panel: Panel, lineId: string, position: Position): DocOp {
  const boxes = panelBoxesFor(doc, page);
  const box = boxes[panel.n - 1] ?? { x: 0, y: 0, w: 1, h: 1 };
  const existing = page.balloons.find((b) => b.lineId === lineId);
  const w = Math.min(existing?.w ?? 0.28, Math.max(0.12, box.w - 0.04));
  const h = 0.09;
  const m = 0.02;
  const col = position.endsWith('left') ? 0 : position.endsWith('right') ? 1 : 0.5;
  const row = position.startsWith('top') ? 0 : position.startsWith('bottom') ? 1 : 0.5;
  const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(lo, hi));
  const x = clamp(box.x + m + (box.w - w - 2 * m) * col, 0, 1 - w);
  const y = clamp(box.y + m + (box.h - h - 2 * m) * row, 0, 1 - h);
  return { op: 'balloon', pageId: page.id, lineId, patch: { x: Math.round(x * 1000) / 1000, y: Math.round(y * 1000) / 1000, w: Math.round(w * 1000) / 1000, pinned: true } };
}

const tooLong = (doc: ComicDoc, lines: Pick<Line, 'text'>[]): number => {
  const rule = lineLengthRule(doc.format.language, doc.format.lettering === 'in_art');
  return lines.filter((l) => (rule.unit === 'chars' ? [...l.text.replace(/\s+/g, '')].length : (l.text.match(/\S+/g) || []).length) > rule.perLine).length;
};

// ── Tool set ─────────────────────────────────────────────────────────────────

export function buildDirectorTools(ctx: StudioContext, turn?: DirectorTurn): DirectorTool[] {
  const state =
    turn ||
    createDirectorTurn({
      attachments: latestUserMessage(ctx.session.doc)?.attachments || [],
      userText: latestUserMessage(ctx.session.doc)?.text || ''
    });
  const doc = () => ctx.session.doc;
  // Every director edit is one undoable step with a short human label (origin 'director', contract §7).
  const commit = (ops: DocOp[], label?: string) => ctx.session.commit(ops, { origin: 'director', ...(label ? { label } : {}) });
  const byok = () => spendIsByok(ctx.keys);
  // Prices in the user's terms (governed users: "≈2% of your usage", never dollars).
  const cost = costFormatterFor(ctx);
  /** letterStyle.auto: the preset follows the comic (kids → storybook, manga, webtoon, noir) — free, never over a manual pick. */
  const followLetteringPreset = (): string => {
    const d = doc();
    const ls = d.letterStyle ?? DEFAULT_LETTERING;
    if (!ls.auto || d.format.lettering === 'in_art') return '';
    const fit = presetForComic(d.format, d.brief);
    if (fit === ls.presetId) return '';
    commit([{ op: 'letter_style', patch: { presetId: fit, auto: true, keepOverrides: true } }], 'Lettering preset');
    return ` Lettering now uses the ${fit.replace(/_/g, ' ')} preset to fit (free; it was on automatic).`;
  };
  const captured = (fact: string) => {
    if (fact && !state.captured.includes(fact) && state.captured.length < 12) state.captured.push(fact);
  };

  return [
    define(
      'update_brief',
      'free',
      'Save story facts the user stated. Only include fields that change.',
      schema({
        title: S('Comic title.'),
        logline: S('One-sentence pitch.'),
        premise: S('What the story is about (a short paragraph).'),
        genre: S('Genre, e.g. noir mystery.'),
        tone: S('Tone, e.g. funny, tense, cozy.'),
        audience: S('Who it is for, e.g. kids 6–9.'),
        setting: S('Where and when it takes place.'),
        themes: A({ type: 'string' }, 'Themes.')
      }),
      (args) => {
        const patch: Record<string, unknown> = {};
        for (const key of ['title', 'logline', 'premise', 'genre', 'tone', 'audience', 'setting'] as const) {
          const v = text(args[key], key === 'premise' ? 4000 : key === 'setting' ? 1000 : 600);
          if (v) patch[key] = key === 'title' ? v.slice(0, 200) : v;
        }
        if (args.themes !== undefined) patch.themes = strList(args.themes, 12, 120);
        if (!Object.keys(patch).length) throw argError('Pass at least one brief field.');
        commit([{ op: 'brief', patch }], 'Story details');
        if (typeof patch.title === 'string') captured(`the title “${patch.title}”`);
        if (typeof patch.audience === 'string') captured(`for ${patch.audience}`);
        if (typeof patch.setting === 'string') captured(`set at ${String(patch.setting).slice(0, 60)}`);
        if (typeof patch.genre === 'string') captured(String(patch.genre));
        if (!state.captured.length) captured('the story notes');
        const lettering = patch.audience !== undefined || patch.genre !== undefined || patch.tone !== undefined ? followLetteringPreset() : '';
        return `Brief updated: ${Object.keys(patch).join(', ')}.${lettering}`;
      }
    ),

    define(
      'add_notes',
      'free',
      "Record the user's decisions or wishes that don't fit a brief field (e.g. 'no gore', 'ends on a cliffhanger').",
      schema({ notes: A({ type: 'string' }, 'Short notes, one idea each.') }, ['notes']),
      (args) => {
        const notes = strList(args.notes, 12, 500);
        if (!notes.length) throw argError('Pass notes as a list of short strings.');
        commit(notes.map((n): DocOp => ({ op: 'note_add', text: n })), notes.length === 1 ? 'Note' : 'Notes');
        captured(notes.length === 1 ? 'your note' : 'your notes');
        return `Noted (${doc().brief.notes.length} notes total).`;
      }
    ),

    define(
      'set_format',
      'free',
      'Set the format. If drawn pages would go out of date, the first call only reports it (confirm:true applies).',
      schema({
        kind: S('Comic kind.', { enum: COMIC_KINDS }),
        pageCount: I('Number of pages, 1–40.'),
        pageAspect: S('Page aspect ratio (2:3 is a standard comic page).', { enum: ASPECT_RATIOS }),
        panelsPerPage: S('"auto" (writer varies 3–6) or a number like "4".'),
        readingDirection: S('ltr, or rtl for manga.', { enum: ['ltr', 'rtl'] }),
        lettering: S('overlay = editable balloons (default); in_art = the model letters the page.', { enum: LETTERING_MODES }),
        colorMode: S('Color mode.', { enum: COLOR_MODES }),
        language: S('BCP-47 dialogue language, e.g. en, hi, te.'),
        confirm: B('Apply although drawn pages go out of date.')
      }),
      (args) => {
        const raw: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(args)) if (k !== 'confirm' && v !== undefined && v !== null && v !== '') raw[k] = v;
        if (typeof raw.pageCount === 'string') raw.pageCount = int(raw.pageCount);
        if (raw.panelsPerPage !== undefined && raw.panelsPerPage !== 'auto') raw.panelsPerPage = int(raw.panelsPerPage);
        let patch;
        try {
          patch = sanitizeFormatPatch(raw);
        } catch (err) {
          throw argError(err instanceof StudioError ? err.userMessage : 'Invalid format.');
        }
        if (!Object.keys(patch).length) throw argError('Pass at least one format field.');
        const before = doc();
        // Tell BEFORE staling paid art (director.md §3.8.4): count drawn pages this change would make out of date.
        const preview: ComicDoc = { ...before, format: { ...before.format, ...patch } };
        const staled = before.pages.filter((p) => p.render.status === 'ready' && !isPageStale(before, p) && isPageStale(preview, p));
        const coverStaled = before.cover.render.status === 'ready' && !isTargetStale(before, { kind: 'cover' }) && isTargetStale(preview, { kind: 'cover' });
        if ((staled.length || coverStaled) && args.confirm !== true) {
          const usd = priceOf(ctx, 'page', staled.length) + (coverStaled ? priceOf(ctx, 'cover') : 0);
          const what = [staled.length ? `${staled.length} drawn page${staled.length === 1 ? '' : 's'}` : '', coverStaled ? 'the cover' : ''].filter(Boolean).join(' and ');
          return `Not changed yet: this makes ${what} out of date (redrawing ${cost.approx(usd)}). Tell the user and ask; call again with confirm:true to apply (they can also keep the drawings as they are).`;
        }
        commit([{ op: 'format', patch }], 'Format');
        const f = doc().format;
        logger.info('comic_format_changed', { projectId: ctx.projectId, by: 'director', keys: Object.keys(patch) });
        if (patch.pageCount !== undefined || patch.pageAspect) captured(`${f.pageCount} page${f.pageCount === 1 ? '' : 's'}, ${f.pageAspect}`);
        else captured('the format');
        const stale = staled.length ? ` ${staled.length} drawn page${staled.length === 1 ? ' is' : 's are'} now out of date (redraw ${cost.approx(priceOf(ctx, 'page', staled.length))}, or keep them).` : '';
        const lettering = patch.kind !== undefined || patch.lettering !== undefined ? followLetteringPreset() : '';
        return `Format: ${f.kind}, ${f.pageCount} pages, ${f.pageAspect}, panels ${f.panelsPerPage}, ${f.readingDirection}, ${f.lettering} lettering, ${f.colorMode}, ${f.language}.${stale}${lettering}`;
      }
    ),

    define(
      'save_source',
      'text',
      "Store the user's script/story/notes as the source. If the message says it was already saved, call with no arguments to read the full text. Otherwise text = the material, or useMessage:true for the current message. Long material is analyzed (brief, cast, places).",
      schema({
        text: S('The source material (omit when useMessage is true).'),
        useMessage: B("Store the user's current message text as the source."),
        analyze: B('Force (true) or skip (false) the analysis. Default: analyze when long.')
      }),
      (args) => storeAndAnalyzeSource(ctx, state, args)
    ),

    define(
      'upsert_character',
      'free',
      'Create/update a cast member — people AND recurring animals, creatures, robots, toys, vehicles, key props (matched by id or name). attachmentRefs = image numbers showing them (all kept).',
      schema(
        {
          id: S('Existing character id.'),
          name: S('Name (matches case-insensitively). Unnamed beings: a descriptive name ("Ducklings").'),
          newName: S('Rename to this.'),
          kind: S('Absent = person.', { enum: CAST_KINDS }),
          count: I('2–12 = a group drawn as one identity.'),
          tier: S('lead/support get a model sheet; extra = text only.', { enum: ['lead', 'support', 'extra'] }),
          role: S('Role in the story.'),
          look: lookSchema,
          personality: S('Personality.'),
          voice: S('How they talk.'),
          attachmentRefs: A({ type: 'integer' }, 'Image numbers to use as references.')
        },
        ['name']
      ),
      async (args) => {
        const d = doc();
        const existing = findCharacterArg(d, args);
        const name = text(args.name, 80);
        const newName = text(args.newName, 80);
        if (!existing && !name) throw argError('Pass the character name.');
        const finalName = newName || existing?.name || name;
        const clash = d.cast.find((c) => c.id !== existing?.id && c.name.trim().toLowerCase() === finalName.toLowerCase());
        if (clash) throw argError(`There is already a character named ${upper(clash.name)} (id ${clash.id}).`);
        // sanitizeLook covers every look line incl. species / markings (cleaned; never re-read raw).
        const look: Record<string, string> = { ...(sanitizeLook(args.look) || {}) };
        for (const k of Object.keys(look)) if (!look[k]) delete look[k];
        const refs = attachmentRefs(state, args.attachmentRefs);
        const tier = args.tier === 'lead' || args.tier === 'support' || args.tier === 'extra' ? args.tier : undefined;
        const kind = castKindArg(args.kind);
        const count = args.count === undefined ? undefined : countArg(args.count) ?? 1;
        const patch: Partial<Character> = {};
        if (!existing || newName) patch.name = finalName;
        if (tier) patch.tier = tier;
        if (kind && (existing ? (existing.kind ?? 'person') !== kind : kind !== 'person')) patch.kind = kind;
        if (count !== undefined && (existing ? (existing.count ?? 1) !== count : count > 1)) patch.count = count;
        for (const key of ['role', 'personality', 'voice'] as const) {
          const v = text(args[key], key === 'role' ? 200 : 1000);
          if (v) patch[key] = v;
        }
        let id: string;
        let note = '';
        if (existing) {
          id = existing.id;
          if (Object.keys(look).length) patch.look = look as unknown as CharacterLook;
          if (!Object.keys(patch).length && !refs.length) throw argError(`Nothing to change for ${upper(existing.name)}.`);
          const ops: DocOp[] = Object.keys(patch).length ? [{ op: 'character', id, patch }] : [];
          const changedLook = patch.look && lookChanged(existing.look, patch.look);
          if ((changedLook || patch.count !== undefined || patch.kind) && existing.sheet.status === 'ready') {
            ops.push({ op: 'render', target: { kind: 'sheet', id }, patch: { status: 'stale' } });
            note = ` ${upper(finalName)}'s sheet is now out of date (redraw ${cost.approx(priceOf(ctx, 'sheet'))} when the user wants it).`;
          }
          if (ops.length) commit(ops, `Cast: ${upper(finalName)}`);
        } else {
          const nonHuman = !!kind && kind !== 'person';
          patch.tier = tier || (nonHuman ? 'support' : d.cast.some((c) => c.tier === 'lead') ? 'support' : 'lead');
          patch.look = { ...look, summary: look.summary || summaryFromLook(look) } as CharacterLook;
          id = newId('c');
          commit([{ op: 'character', id, patch }], `Add ${upper(finalName)}`);
        }
        // Every attached photo is kept (honest caps from the refs package) — never a silent slice.
        const refNote = refs.length ? ` ${await attachRefs(ctx, { kind: 'character', id }, refs)}` : '';
        const saved = doc().cast.find((c) => c.id === id);
        if (refs.length && saved) {
          // The compiler's own photo cap (models differ in character slots; a style board takes one).
          const slots = sheetRefSlots(doc());
          if (saved.tier !== 'extra' && saved.sheet.status === 'ready' && sheetRefsChanged(saved, slots)) {
            note += ` The sheet was drawn from older photos — offer a redraw (${cost.approx(priceOf(ctx, 'sheet'))}); do not redraw without asking.`;
          } else if (saved.tier !== 'extra' && !saved.sheet.asset) {
            note += ` No sheet yet — offer to make ${upper(finalName)}'s model sheet from these photos (${cost.approx(priceOf(ctx, 'sheet'))}).`;
          }
        }
        const missing = saved && !saved.look.summary ? ' No look yet — ask for or propose one.' : '';
        const what = saved ? [saved.tier, saved.kind && saved.kind !== 'person' ? saved.kind : '', saved.count && saved.count > 1 ? `×${saved.count}` : ''].filter(Boolean).join(', ') : patch.tier;
        captured(saved ? castNoun(saved) : finalName);
        return `Saved ${upper(finalName)} (${what}).${refNote} Cast: ${castList(doc())}.${note}${missing}`;
      }
    ),

    define(
      'remove_character',
      'free',
      'Remove a character from the cast (and from every panel).',
      schema({ id: S('Character id.'), name: S('Character name.') }),
      (args) => {
        const c = findCharacterArg(doc(), args);
        if (!c) throw argError(`No such character. Cast: ${castList(doc())}.`);
        commit([{ op: 'character_remove', id: c.id }], `Remove ${upper(c.name)}`);
        captured(`removed ${c.name}`);
        return `Removed ${upper(c.name)}. Cast: ${castList(doc())}.`;
      }
    ),

    define(
      'upsert_place',
      'free',
      'Create or update a recurring location (matched by id or name). attachmentRefs = image numbers showing it.',
      schema(
        {
          id: S('Existing place id.'),
          name: S('Place name.'),
          newName: S('Rename to this.'),
          look: S('What it looks like: architecture, props, light, palette.'),
          attachmentRefs: A({ type: 'integer' }, 'Image numbers to use as reference.')
        },
        ['name']
      ),
      async (args) => {
        const d = doc();
        const existing = findPlaceArg(d, args);
        const name = text(args.name, 80);
        const newName = text(args.newName, 80);
        if (!existing && !name) throw argError('Pass the place name.');
        const finalName = newName || existing?.name || name;
        const look = text(args.look, 1500);
        const refs = attachmentRefs(state, args.attachmentRefs);
        const patch: Partial<Place> = {};
        if (!existing || newName) patch.name = finalName;
        if (look) patch.look = look;
        if (existing && !Object.keys(patch).length && !refs.length) throw argError(`Nothing to change for ${upper(existing.name)}.`);
        const id = existing?.id || newId('pl');
        const ops: DocOp[] = Object.keys(patch).length || !existing ? [{ op: 'place', id, patch }] : [];
        if (existing && look && existing.sheet.status === 'ready') ops.push({ op: 'render', target: { kind: 'place', id }, patch: { status: 'stale' } });
        if (ops.length) commit(ops, `${existing ? 'Place' : 'Add place'}: ${upper(finalName)}`);
        const refNote = refs.length ? ` ${await attachRefs(ctx, { kind: 'place', id }, refs)}` : '';
        captured(finalName);
        return `Saved place ${upper(finalName)}.${refNote} Places: ${placeList(doc())}.`;
      }
    ),

    define(
      'remove_place',
      'free',
      'Remove a location.',
      schema({ id: S('Place id.'), name: S('Place name.') }),
      (args) => {
        const p = findPlaceArg(doc(), args);
        if (!p) throw argError(`No such place. Places: ${placeList(doc())}.`);
        commit([{ op: 'place_remove', id: p.id }], `Remove ${upper(p.name)}`);
        captured(`removed ${p.name}`);
        return `Removed ${upper(p.name)}. Places: ${placeList(doc())}.`;
      }
    ),

    define(
      'set_style',
      'free',
      `Set the art style: presetId (${STYLE_PRESETS.map((p) => p.id).join(', ')}), OR a custom name + spec (medium, linework, color, shading). lock:true locks it. attachmentRefs = style reference images.`,
      schema({
        presetId: S('Preset id.', { enum: STYLE_PRESETS.map((p) => p.id) }),
        name: S('Custom style name (2–4 words).'),
        spec: S('Custom style spec: concrete, drawable art direction (35–80 words).'),
        palette: A({ type: 'string' }, 'Palette colors (hex or names).'),
        linework: S('Linework description.'),
        avoid: A({ type: 'string' }, 'Things the art must never do.'),
        lock: B('Lock this style for every render.'),
        attachmentRefs: A({ type: 'integer' }, 'Image numbers to use as style references.')
      }),
      async (args) => {
        const d = doc();
        const refs = attachmentRefs(state, args.attachmentRefs);
        const patch: Partial<Omit<StyleBible, 'options'>> = {};
        const ops: DocOp[] = [];
        const presetId = text(args.presetId, 60);
        let label = '';
        if (presetId) {
          const preset = getStylePreset(presetId);
          if (!preset) throw argError(`Unknown preset. Use one of: ${STYLE_PRESETS.map((p) => p.id).join(', ')}.`);
          Object.assign(patch, {
            name: preset.name,
            spec: preset.spec,
            palette: [...preset.palette],
            linework: preset.linework,
            avoid: [...preset.avoid],
            presetId: preset.id
          });
          if (preset.colorMode && preset.colorMode !== d.format.colorMode) ops.push({ op: 'format', patch: { colorMode: preset.colorMode } });
          label = preset.name;
        } else if (text(args.spec)) {
          const spec = text(args.spec, 2000);
          patch.spec = spec;
          patch.name = text(args.name, 80) || 'Custom style';
          patch.presetId = undefined;
          if (args.palette !== undefined) patch.palette = strList(args.palette, 8, 40);
          if (args.linework !== undefined) patch.linework = text(args.linework, 300);
          label = patch.name;
        } else if (text(args.name)) {
          throw argError('A custom style needs a spec (medium, linework, color, shading).');
        }
        if (args.avoid !== undefined) patch.avoid = strList(args.avoid, 12, 120);
        const specChanged = patch.spec !== undefined && patch.spec !== d.style.spec;
        // A new look invalidates the old board (it was drawn in the previous style).
        if (specChanged) patch.board = undefined;
        if (args.lock === true) {
          if (!patch.spec && !d.style.spec) throw argError('There is no style to lock yet — pick a preset or describe one.');
          patch.status = 'locked';
        } else if (patch.spec || refs.length || patch.avoid) {
          patch.status = specChanged || d.style.status === 'empty' ? 'drafted' : d.style.status;
        }
        if (!Object.keys(patch).length && !refs.length) throw argError('Pass presetId, or name + spec, or lock:true.');
        if (Object.keys(patch).length) ops.unshift({ op: 'style', patch });
        if (ops.length) commit(ops, 'Style');
        const refNote = refs.length ? ` ${await attachRefs(ctx, { kind: 'style' }, refs)}` : '';
        const s = doc().style;
        const short = !presetId && patch.spec && (patch.spec.match(/\S+/g) || []).length < 15 ? ' The spec is short — a fuller description (medium, linework, color, shading) draws more consistently.' : '';
        captured(`${s.name || label || 'custom'} style`);
        return `Style: ${s.name || label || 'custom'} (${s.status})${refs.length ? `, ${s.refs.length} style reference image(s)` : ''}${ops.some((o) => o.op === 'format') ? `; color mode set to ${doc().format.colorMode}` : ''}.${refNote}${short}`;
      }
    ),

    define(
      'propose_styles',
      'paid',
      'Draw 3 cheap style-test images (or the given 2–4 directions) so the user can tap one to lock.',
      schema({
        directions: A(
          { type: 'object', properties: { name: S('2–4 word name.'), spec: S('Concrete art direction, 35–80 words.') }, required: ['name', 'spec'] },
          'Optional directions you wrote; omit to have the art director propose them.'
        )
      }),
      (args) => {
        const directions = (Array.isArray(args.directions) ? args.directions : [])
          .filter(isObject)
          .map((d) => ({ name: text(d.name, 60), spec: text(d.spec, 1500) }))
          .filter((d) => d.name && d.spec)
          .slice(0, 4);
        return spend(ctx, state, { type: 'render_style_options', ...(directions.length ? { directions } : {}) }, forcedGateReason(doc(), state, 'style'));
      }
    ),

    define(
      'render_character_sheets',
      'paid',
      'Draw model sheets (turnaround + expressions) for lead/support cast that lack one, or for the named characters/places (force:true redraws).',
      schema({
        names: A({ type: 'string' }, 'Character (or place) names; omit for every lead/support missing a sheet.'),
        force: B('Redraw even if a sheet exists (only when the user asked).')
      }),
      (args) => {
        const d = doc();
        const names = strList(args.names, 20, 80);
        const ids: string[] = [];
        const unknown: string[] = [];
        for (const n of names) {
          const c = resolveCharacter(d, n);
          const p = d.places.find((x) => x.name.trim().toLowerCase() === n.toLowerCase());
          if (c) ids.push(c.id);
          else if (p) ids.push(p.id);
          else unknown.push(n);
        }
        if (unknown.length) throw argError(`Unknown: ${unknown.join(', ')}. Cast: ${castList(d)}. Places: ${placeList(d)}.`);
        if (!d.cast.length && !ids.length) throw argError('There is no cast yet — add characters first.');
        const force = args.force === true;
        const redraw = force && state.drawIntent === 'redraw';
        return spend(
          ctx,
          state,
          { type: 'render_sheets', ...(ids.length ? { characterIds: ids } : {}), ...(redraw ? { force: true } : {}) },
          forcedGateReason(d, state, 'sheets', { redraw })
        );
      }
    ),

    define(
      'plan_pages',
      'text',
      'Write the page-by-page script (layout, panels, cast, dialogue). No image spend; drawn pages are kept (out of date). Show it before drawing.',
      schema({ instructions: S('Extra direction for the writer (pacing, what to emphasize).') }),
      async (args) => {
        const d = doc();
        const hasStory = !!(d.brief.premise || d.brief.logline || d.source.script || d.cast.length || d.brief.notes.length);
        if (!hasStory) throw argError('Nothing to plan yet — capture the story (brief, cast or source) first.');
        guardPaidText(ctx, state);
        const outcome = await planPages(ctx, { instructions: text(args.instructions, 4000) }, { collectCard: (c) => state.cards.push(c) });
        // A refused plan (budget cap, drawn pages) is not a plan: nothing for the user to review.
        if (outcome.status === 'blocked') return outcome.message;
        state.plannedThisTurn = true;
        const cast = castUncastBeings(ctx);
        return `${outcome.message}${cast} The user reviews the plan on the board before any page is drawn.`;
      }
    ),

    define(
      'revise_pages',
      'text',
      'Rewrite specific pages of the plan following instructions (e.g. "make page 2 a splash"). Drawn pages become out of date, never wiped.',
      schema({ pages: A({ type: 'integer' }, 'Page numbers to rewrite.'), instructions: S('What to change.') }, ['pages', 'instructions']),
      async (args) => {
        const d = doc();
        if (!d.pages.length) throw argError('There is no plan yet — call plan_pages first.');
        const instructions = text(args.instructions, 4000);
        if (!instructions) throw argError('Say what to change.');
        const pages = pagesByNumbers(d, intList(args.pages));
        if (!pages.length) throw argError('Pass the page numbers to rewrite.');
        guardPaidText(ctx, state);
        const outcome = await planPages(ctx, { instructions, pageIds: pages.map((p) => p.id) }, { collectCard: (c) => state.cards.push(c) });
        if (outcome.status === 'blocked') return outcome.message;
        state.plannedThisTurn = true;
        return `${outcome.message}${castUncastBeings(ctx)}`;
      }
    ),

    define(
      'read_pages',
      'free',
      'Read the full script of planned pages (panels, cast, numbered lines) before editing them.',
      schema({ pages: A({ type: 'integer' }, 'Page numbers.') }, ['pages']),
      (args) => {
        const d = doc();
        const pages = pagesByNumbers(d, intList(args.pages).slice(0, 6));
        if (!pages.length) throw argError('Pass page numbers.');
        const name = (id?: string) => upper(d.cast.find((c) => c.id === id)?.name || id);
        return pages
          .map((p) =>
            [
              `PAGE ${p.n}: ${p.summary}${p.layout ? ` | Layout: ${p.layout}` : ''}`,
              ...p.panels.map(
                (panel) =>
                  `  Panel ${panel.n} (${panel.size}, ${panel.shot}): ${panel.action}${panel.castIds.length ? ` | Cast: ${panel.castIds.map(name).join(', ')}` : ''}` +
                  panel.lines.map((l, i) => `\n    ${i + 1}. ${l.kind}${l.speakerId ? ` ${name(l.speakerId)}` : ''}: "${l.text}"`).join('')
              )
            ].join('\n')
          )
          .join('\n')
          .slice(0, 12_000);
      }
    ),

    define(
      'edit_panel_text',
      'free',
      'Set one panel\'s lines (exact text; [] = silent). Matching lines keep their balloon and translations.',
      schema(
        {
          page: I('Page number.'),
          panel: I('Panel number.'),
          lines: A(
            {
              type: 'object',
              properties: {
                kind: S('Line kind.', { enum: LINE_KINDS }),
                speaker: S('Speaker name (speech/thought/whisper/shout).'),
                text: S('Exact text.'),
                style: LETTERING_STYLE_ARGS_COMPACT,
                position: S('Balloon spot.', { enum: POSITIONS })
              },
              required: ['kind', 'text']
            },
            'The panel’s lines in reading order (≤ 3 balloons).'
          )
        },
        ['page', 'panel', 'lines']
      ),
      (args) => {
        const d = doc();
        const page = pagesByNumbers(d, intList(args.page).slice(0, 1))[0];
        if (!page) throw argError('Pass the page number.');
        const panel = page.panels.find((p) => p.n === int(args.panel));
        if (!panel) throw argError(`Page ${page.n} has panels 1–${page.panels.length}.`);
        if (!Array.isArray(args.lines)) throw argError('Pass lines as a list (empty for a silent panel).');
        type Wanted = Omit<Line, 'id'> & { position?: Position };
        const wanted: Wanted[] = [];
        const addCast = new Set<string>();
        for (const raw of args.lines.slice(0, 6)) {
          if (!isObject(raw)) continue;
          const kind = LINE_KINDS.includes(raw.kind as LineKind) ? (raw.kind as LineKind) : 'speech';
          const lineText = typeof raw.text === 'string' ? enteredText(raw.text, 600) : '';
          if (!lineText) continue;
          const line: Wanted = { kind, text: lineText };
          if (SPOKEN.has(kind)) {
            const speaker = resolveCharacter(d, text(raw.speaker, 80));
            if (!speaker) throw argError(`Unknown speaker "${text(raw.speaker, 80)}". Cast: ${castList(d)}.`);
            line.speakerId = speaker.id;
            if (!panel.castIds.includes(speaker.id)) addCast.add(speaker.id);
          }
          const style = lineStyleFromArgs(d, { id: '', kind, text: lineText, ...(line.speakerId ? { speakerId: line.speakerId } : {}) } as Line, raw.style);
          if (style) line.style = style;
          if (typeof raw.position === 'string' && (POSITIONS as readonly string[]).includes(raw.position)) line.position = raw.position as Position;
          wanted.push(line);
        }
        // Keep line ids positionally when kind + speaker match (i18n.md §4.3): balloons keep their
        // pins, translations go stale instead of vanishing, and history shows an edit.
        const old = panel.lines;
        const reused = wanted.map((w, i) => (old[i] && old[i].kind === w.kind && (old[i].speakerId ?? '') === (w.speakerId ?? '') ? old[i] : undefined));
        const keep = new Set(reused.filter((l): l is Line => !!l).map((l) => l.id));
        const ops: DocOp[] = old.filter((l) => !keep.has(l.id)).map((l): DocOp => ({ op: 'line', pageId: page.id, panelId: panel.id, id: l.id, patch: null }));
        const finalIds: string[] = [];
        const positioned: { id: string; position: Position }[] = [];
        wanted.forEach((w, i) => {
          const prev = reused[i];
          const { position, ...line } = w;
          if (prev) {
            const patch: Partial<Line> = {};
            if (prev.text !== line.text) patch.text = line.text;
            if (line.style) patch.style = line.style;
            if (Object.keys(patch).length) ops.push({ op: 'line', pageId: page.id, panelId: panel.id, id: prev.id, patch });
            finalIds.push(prev.id);
          } else {
            const id = newId('l');
            ops.push({ op: 'line', pageId: page.id, panelId: panel.id, id, patch: { ...line, id }, index: i });
            finalIds.push(id);
          }
          if (position && d.format.lettering === 'overlay') positioned.push({ id: finalIds[i], position });
        });
        if (addCast.size) ops.push({ op: 'panel', pageId: page.id, id: panel.id, patch: { castIds: [...panel.castIds, ...addCast] } });
        if (positioned.length) {
          // Placed on the page as it will be after this edit (new lines exist), by the lettering engine:
          // the balloon's real outline stays inside its panel and the safe area. A 9-grid box is the fallback.
          const preview = applyOps(d, ops);
          const previewPage = preview.pages.find((p) => p.id === page.id);
          for (const { id, position } of positioned) {
            const b = previewPage ? balloonAtPosition(preview, previewPage, id, position) : undefined;
            ops.push(
              b
                ? { op: 'balloon', pageId: page.id, lineId: id, patch: { x: b.x, y: b.y, w: b.w, ...(typeof b.tailX === 'number' && typeof b.tailY === 'number' ? { tailX: b.tailX, tailY: b.tailY } : {}), pinned: true } }
                : balloonAt(d, page, panel, id, position)
            );
          }
        }
        if (ops.length) commit(ops, `Page ${page.n} panel ${panel.n} text`);
        const kept = reused.filter(Boolean).length;
        const long = tooLong(d, wanted);
        captured(`page ${page.n} panel ${panel.n}'s text`);
        return `Page ${page.n} panel ${panel.n} now has ${wanted.length} line${wanted.length === 1 ? '' : 's'}${kept ? ` (${kept} kept in place)` : ''}.${addCast.size ? ' Added the speaker to the panel.' : ''}${long ? ' Some lines are long for a balloon — consider trimming.' : ''}${page.render.status === 'ready' && d.format.lettering === 'in_art' ? ' The page is lettered in the art, so it is now out of date (redraw is PAID).' : ''}`;
      }
    ),

    define(
      'set_line',
      'free',
      'Change ONE line in place (kind e.g. thought bubble, speaker or text); its balloon stays. line = number from read_pages.',
      schema(
        {
          page: I('Page number.'),
          panel: I('Panel number.'),
          line: I('1-based line in the panel.'),
          kind: S('Kind.', { enum: LINE_KINDS }),
          speaker: S('Speaker name.'),
          text: S('Exact text.')
        },
        ['page', 'panel', 'line']
      ),
      (args) => {
        const d = doc();
        const page = pagesByNumbers(d, intList(args.page).slice(0, 1))[0];
        if (!page) throw argError('Pass the page number.');
        const panel = page.panels.find((p) => p.n === int(args.panel));
        if (!panel) throw argError(`Page ${page.n} has panels 1–${page.panels.length}.`);
        const n = int(args.line);
        const line = n !== undefined ? panel.lines[n - 1] : undefined;
        if (!line) throw argError(panel.lines.length ? `Page ${page.n} panel ${panel.n} has lines 1–${panel.lines.length}.` : `Page ${page.n} panel ${panel.n} has no lines — use edit_panel_text.`);
        const patch: Partial<Line> = {};
        const kind = LINE_KINDS.includes(args.kind as LineKind) ? (args.kind as LineKind) : undefined;
        const newText = typeof args.text === 'string' ? args.text.trim().slice(0, 600) : '';
        if (kind && kind !== line.kind) patch.kind = kind;
        if (newText && newText !== line.text) patch.text = newText;
        const finalKind = kind ?? line.kind;
        let speakerId = line.speakerId;
        if (text(args.speaker, 80)) {
          const speaker = resolveCharacter(d, text(args.speaker, 80));
          if (!speaker) throw argError(`Unknown speaker "${text(args.speaker, 80)}". Cast: ${castList(d)}.`);
          speakerId = speaker.id;
        }
        if (SPOKEN.has(finalKind)) {
          if (!speakerId) throw argError(`A ${finalKind} line needs a speaker. Cast: ${castList(d)}.`);
          if (speakerId !== line.speakerId) patch.speakerId = speakerId;
        } else if (line.speakerId) {
          patch.speakerId = undefined;
        }
        if (!Object.keys(patch).length) throw argError('Nothing to change on that line.');
        const ops: DocOp[] = [{ op: 'line', pageId: page.id, panelId: panel.id, id: line.id, patch }];
        if (patch.speakerId && !panel.castIds.includes(patch.speakerId)) ops.push({ op: 'panel', pageId: page.id, id: panel.id, patch: { castIds: [...panel.castIds, patch.speakerId] } });
        commit(ops, `Page ${page.n} panel ${panel.n} line ${n}`);
        captured(`page ${page.n} panel ${panel.n} line ${n}`);
        const inArt = d.format.lettering === 'in_art' && page.render.status === 'ready';
        return `Updated page ${page.n} panel ${panel.n} line ${n}${patch.kind ? ` (now ${patch.kind})` : ''}.${inArt ? ' The page is lettered in the art, so it is now out of date (redraw is PAID).' : ' Free — no redraw needed.'}`;
      }
    ),

    define(
      'render_pages',
      'paid',
      'Draw undrawn/out-of-date pages (no pages = all; "draw everything" adds include_cover). Never redraws a current page unless redraw:true (only when the user asked for another take). $0 when nothing needs drawing.',
      schema({
        pages: A({ type: 'integer' }, 'Limit to these pages.'),
        redraw: B('New take of current pages.'),
        include_cover: B('Also draw a missing cover.'),
        safe: B('A tamer take.')
      }),
      (args) => {
        const d = doc();
        if (d.planStatus === 'none' || !d.pages.length) {
          return 'Refused: there is no page plan yet. Call plan_pages first and let the user review the plan before drawing.';
        }
        if (state.plannedThisTurn && !SKIP_REVIEW_RE.test(state.userText)) {
          return "Refused: the user hasn't seen this plan yet — it is on the board now. Show it in one line and ask before drawing.";
        }
        const numbers = intList(args.pages);
        const pages = numbers.length ? pagesByNumbers(d, numbers) : [];
        const ids = pages.map((p) => p.id);
        const safe = args.safe === true;
        const wantsRedraw = args.redraw === true;
        const redraw = wantsRedraw && state.drawIntent === 'redraw';
        const scope = pages.length ? pages : [...d.pages].sort((a, b) => a.n - b.n);
        const current = scope.filter((p) => p.render.status === 'ready' && !isPageStale(d, p));
        if (wantsRedraw && !redraw && current.length) {
          const first = current[0];
          return `Not redrawn: ${pageWord(current)} ${current.length === 1 ? 'is' : 'are'} already drawn and current, and the user didn't ask for a new take. Offer: read it, ${coverNeedsDraw(d) ? 'make the cover, ' : ''}or a new take of page ${first.n} (${cost.approx(priceOf(ctx, 'page'))}).`;
        }
        // A safer take re-draws only the pages named (flagged ones), never the whole book.
        const saferRedraw = safe && ids.length > 0;
        const targets = drawablePages(d, { ...(ids.length ? { pageIds: ids } : {}), force: redraw || saferRedraw });
        const coverToo = args.include_cover === true && coverNeedsDraw(d);
        if (!targets.length && !coverToo) {
          // $0: nothing to draw — say so, show the book, offer next steps (never a redundant redraw).
          state.outcome = 'nothing';
          state.cards.push({ type: 'breakdown', id: newId('card'), view: 'status', cover: true, ...(ids.length ? { pageIds: ids } : {}) });
          pushNextSteps(state, nothingNextSteps(d, byok()));
          const busy = scope.filter((p) => p.render.status === 'queued' || p.render.status === 'rendering');
          if (busy.length) return `Nothing new to start: ${pageWord(busy)} ${busy.length === 1 ? 'is' : 'are'} already drawing. Nothing was spent.`;
          return `Nothing to draw: ${pages.length ? pageWord(current.length ? current : scope) : 'every page'} ${pages.length === 1 ? 'is' : 'are'} already drawn and up to date — nothing was spent.${coverNeedsDraw(d) ? ` The cover isn't drawn yet (${cost.approx(priceOf(ctx, 'cover'))}).` : ''} Offer: read it, add a page, or a new take only if the user asks.`;
        }
        if (!targets.length && coverToo) return spend(ctx, state, { type: 'render_cover', ...(safe ? { safe: true } : {}) }, forcedGateReason(d, state, 'cover'));
        return spend(
          ctx,
          state,
          {
            type: 'render_pages',
            ...(ids.length ? { pageIds: ids } : {}),
            ...(redraw || saferRedraw ? { force: true } : {}),
            ...(coverToo ? { includeCover: true } : {}),
            ...(safe ? { safe: true } : {})
          },
          forcedGateReason(d, state, 'pages', { redraw: redraw || (saferRedraw && current.some((p) => targets.includes(p))) })
        );
      }
    ),

    define(
      'edit_page',
      'paid',
      'Change part of a DRAWN page ("make it night"), optionally one panel. Never for text or balloons (free).',
      schema({ page: I('Page number.'), instruction: S('What to change, concretely.'), panel: I('Panel number (optional).'), safe: B('A tamer take.') }, ['page', 'instruction']),
      (args) => {
        const d = doc();
        const page = pagesByNumbers(d, intList(args.page).slice(0, 1))[0];
        if (!page) throw argError('Pass the page number.');
        if (page.render.status !== 'ready' || !page.render.asset) {
          throw argError(`Page ${page.n} isn't drawn yet — render it first (or revise its script with revise_pages).`);
        }
        const instruction = text(args.instruction, 2000);
        if (!instruction) throw argError('Say what to change.');
        const panelN = int(args.panel);
        if (panelN !== undefined && !page.panels.some((p) => p.n === panelN)) throw argError(`Page ${page.n} has panels 1–${page.panels.length}.`);
        return spend(
          ctx,
          state,
          { type: 'edit_page', pageId: page.id, instruction, ...(panelN !== undefined ? { panelN } : {}), ...(args.safe === true ? { safe: true } : {}) },
          forcedGateReason(d, state, 'edit')
        );
      }
    ),

    define(
      'render_cover',
      'paid',
      'Draw the cover. Title/tagline edits on a textless cover are FREE. textless:true = one-time re-render with an editable title.',
      schema({
        title: S('Cover title (defaults to the comic title).'),
        tagline: S('Short tagline.'),
        direction: S('Cover composition idea.'),
        textless: B('Re-render without painted text.'),
        safe: B('A tamer take.')
      }),
      (args) => {
        const d = doc();
        const cover = d.cover;
        const patch: Record<string, string> = {};
        const title = text(args.title, 200);
        const tagline = text(args.tagline, 300);
        const direction = text(args.direction, 1500);
        if (title && title !== cover.title) patch.title = title;
        if (tagline && tagline !== cover.tagline) patch.tagline = tagline;
        if (direction && direction !== cover.direction) patch.direction = direction;
        const overlay = (cover.lettering ?? 'in_art') === 'overlay';
        const drawn = cover.render.status === 'ready' && !!cover.render.asset;
        const textOnly = (!!patch.title || !!patch.tagline) && !patch.direction;
        if (Object.keys(patch).length) commit([{ op: 'cover', patch }], 'Cover text');
        if (drawn && overlay && textOnly && args.textless !== true) {
          captured('the cover title');
          return 'Updated the cover text — free, it is lettered on top of the art (no redraw).';
        }
        const safe = args.safe === true ? { safe: true } : {};
        if (args.textless === true) {
          if (overlay && drawn) return 'The cover is already textless with an editable title — title changes are free.';
          return spend(ctx, state, { type: 'render_cover', textless: true, ...safe }, forcedGateReason(d, state, 'cover'));
        }
        const current = drawn && !isTargetStale(doc(), { kind: 'cover' });
        if (current && !Object.keys(patch).length && !args.safe && state.drawIntent !== 'redraw') {
          state.outcome = 'nothing';
          return `Nothing to draw: the cover is already drawn and up to date — nothing was spent. A new take (${cost.approx(priceOf(ctx, 'cover'))}) only if the user asks.`;
        }
        const redraw = current && !Object.keys(patch).length && state.drawIntent === 'redraw';
        return spend(ctx, state, { type: 'render_cover', ...safe }, forcedGateReason(d, state, 'cover', { redraw }));
      }
    ),

    define(
      'set_settings',
      'free',
      'Tighten money settings: lower the quality tier, require more confirmations, lower the "big spend" threshold, or set/lower a budget cap in USD. Loosening is the user\'s call (quality chip or Settings).',
      schema({
        quality: S('Quality tier.', { enum: QUALITY_TIERS }),
        confirm: S('always = confirm every spend; big = only above the threshold; never = only the budget stops spend.', { enum: CONFIRM_POLICIES }),
        bigSpendUsd: N('Threshold for "big" spends (USD).'),
        budgetUsd: N('Project budget cap in USD; 0 clears it.')
      }),
      (args) => {
        const raw: Record<string, unknown> = {};
        for (const key of ['quality', 'confirm', 'bigSpendUsd', 'budgetUsd'] as const) if (args[key] !== undefined && args[key] !== null && args[key] !== '') raw[key] = args[key];
        for (const key of ['bigSpendUsd', 'budgetUsd'] as const) if (typeof raw[key] === 'string') raw[key] = Number(raw[key]);
        let patch;
        try {
          patch = sanitizeSettingsPatch(raw);
        } catch (err) {
          throw argError(err instanceof StudioError ? err.userMessage : 'Invalid settings.');
        }
        if (!Object.keys(patch).length && !('budgetUsd' in raw)) throw argError('Pass at least one setting.');
        // Money controls can only be TIGHTENED from here. Text the director reads (pasted
        // scripts, attachments, notes) is untrusted, so loosening — a pricier tier, fewer
        // confirmations, a higher threshold, a raised or cleared budget — needs the user's
        // own tap in the Quality chip / Settings sheet.
        const current = doc().settings;
        const clearsBudget = 'budgetUsd' in raw && patch.budgetUsd === undefined;
        const loosened: string[] = [];
        if (patch.quality && QUALITY_TIERS.indexOf(patch.quality) > QUALITY_TIERS.indexOf(current.quality)) loosened.push(`quality → ${patch.quality}`);
        if (patch.confirm && CONFIRM_POLICIES.indexOf(patch.confirm) > CONFIRM_POLICIES.indexOf(current.confirm)) loosened.push(`confirmations → ${patch.confirm}`);
        if (typeof patch.bigSpendUsd === 'number' && patch.bigSpendUsd > current.bigSpendUsd) loosened.push('a higher approval threshold');
        if (clearsBudget && current.budgetUsd !== undefined) loosened.push('removing the budget');
        if (typeof patch.budgetUsd === 'number' && current.budgetUsd !== undefined && patch.budgetUsd > current.budgetUsd) loosened.push('a higher budget');
        if (loosened.length) {
          throw argError(
            `Only the user can change ${loosened.join(', ')} (it raises what can be spent). Tell them to tap the quality chip under the message box or open Settings — one tap — and do not retry this call.`
          );
        }
        // Model lock (decisions-final, owner 2026-10-22 evening; models.md §3.4 #6): once the comic has
        // its first image, the director never changes the model or resolution — the user does, after a
        // warning that character consistency can be affected and the real redraw cost.
        if (patch.quality && patch.quality !== current.quality && hasComicImage(doc())) {
          const from = resolveImageJob('page', current.quality, current.imageModelOverride).spec.nickname;
          const to = resolveImageJob('page', patch.quality, current.imageModelOverride).spec.nickname;
          throw argError(
            `Locked comic: its images are drawn on ${from}${from !== to ? ` and ${patch.quality} would switch to ${to}` : ` at ${current.quality} quality`}, which can change how the characters look. Quality changes are the user's call — tell them to tap the quality chip (it shows the consistency warning and the real redraw cost). Do not retry this call.`
          );
        }
        commit([{ op: 'settings', patch: clearsBudget ? { ...patch, budgetUsd: undefined } : patch }], 'Money settings');
        const s = doc().settings;
        captured('your money settings');
        return `Settings: ${s.quality} quality; confirm ${s.confirm}${s.confirm === 'big' ? ` (above ${cost(s.bigSpendUsd)})` : ''}; budget ${s.budgetUsd ? cost(s.budgetUsd) : 'none'}.`;
      }
    ),

    define(
      'ask_user',
      'free',
      'Ask ONE question with 2–5 tappable options (default first; price in descriptions of options that spend).',
      schema(
        {
          question: S('The question, short.'),
          options: A(
            {
              type: 'object',
              properties: {
                label: S('Chip label, ≤ 5 words.'),
                description: S('Optional one-line detail (price when it spends).'),
                reply: S('Message sent when tapped (defaults to the label).')
              },
              required: ['label']
            },
            '2–5 options.'
          ),
          allowCustom: B('Let the user type their own answer (default true).'),
          multi: B('Allow picking several.')
        },
        ['question', 'options']
      ),
      (args) => {
        const question = text(args.question, 300);
        if (!question) throw argError('Pass the question.');
        const seen = new Set<string>();
        const choices: OptionChoice[] = (Array.isArray(args.options) ? args.options : [])
          .map((o) => (typeof o === 'string' ? { label: o } : o))
          .filter(isObject)
          .map((o) => ({ label: text(o.label, 60), description: text(o.description, 160), reply: text(o.reply, 600) }))
          .filter((o) => o.label && !seen.has(o.label.toLowerCase()) && seen.add(o.label.toLowerCase()))
          .slice(0, 5)
          .map((o) => ({
            id: newId('opt'),
            label: o.label,
            ...(o.description ? { description: o.description } : {}),
            ...(o.reply ? { reply: o.reply } : {})
          }));
        if (choices.length < 2) throw argError('Give 2–5 distinct options.');
        if (state.askedUser) throw argError('You already asked a question this turn — end your turn now.');
        state.cards.push({
          type: 'options',
          id: newId('card'),
          question,
          choices,
          allowCustom: args.allowCustom !== false,
          ...(args.multi === true ? { multi: true } : {})
        });
        state.askedUser = true;
        state.question = question;
        return 'Asked — the options are on screen. (Your reply in this message is what the user reads; if you wrote none, the studio adds a one-line recap.)';
      }
    )
  ];
}

/** Exposed for tests and the director: the tool names in the order offered. */
export const directorToolNames = (tools: DirectorTool[]) => tools.map((t) => t.spec.function.name);

// ── Core + feature groups (contract §12.1) ───────────────────────────────────

/** Everything one director turn offers: tools, extra prompt rules, summary lines, activity labels. */
export interface TurnToolset {
  tools: DirectorTool[];
  /** Ids of the feature groups whose tools made it into this turn (core excluded). */
  groups: ToolGroup['id'][];
  /** Rules appended to DIRECTOR_SYSTEM_PROMPT (active groups only). */
  promptRules: string[];
  /** Extra DOC SUMMARY lines (active groups only). */
  summaryLines: string[];
  /** TOOL_ACTIVITY labels contributed by feature groups. */
  activity: Record<string, string>;
}

/**
 * Words that make a feature group relevant to THIS turn. When the per-turn cap must trim,
 * relevant groups are kept first (then by priority), so "make the shouts red" never loses the
 * lettering tools to an unrelated group. Tuned on the golden set (golden/scenarios/*.json).
 */
export const GROUP_HINTS: Partial<Record<ToolGroup['id'], RegExp>> = {
  lettering: /\b(fonts?|lettering|letters|balloons?|bubbles?|captions?|text|bigger|smaller|bold|colou?rs?|shouts?|whispers?|thoughts?|sfx|overlap\w*|cover(?:s|ing)? (?:her|his|their|the) faces?|re-?letter\w*|re-?check\w*|tails?)\b/i,
  timeline: /\b(move|swap|switch|insert|add (?:a|one|another) page|delete|remove (?:page|it)|duplicate|copy|versions?|undo|restore|earlier|previous|original|fit|square|book|back cover|title page)\b/i,
  publish: /\b(publish|share|link|unpublish|public|unlisted|readers?|post it|send (?:it|the link)|whats ?app|instagram)\b/i,
  i18n: /\b(translat\w*|languages?|telugu|hindi|tamil|kannada|malayalam|bengali|marathi|gujarati|punjabi|urdu|arabic|spanish|french|german|japanese|korean|chinese|portuguese|edition)\b|[\u0900-\u0DFF]/i,
  refs: /\b(photos?|pictures?|images?|pics?|references?|refs?|selfie)\b/i,
  safety: /\b(rating|pg-?13|pg\b|safe|safety|gore|violent|violence|scary|horror|blood)\b/i,
  library: /\b(presets?|styles?|looks?|library)\b/i,
  reader: /\b(reader|page turn|chapters?|dedication|credits|guided)\b/i,
  breakdown: /\b(pages?|panels?|breakdown|plan|cost|price|quote|how much|status|left)\b/i
};

const groupRelevant = (g: ToolGroup, turn: DirectorTurn): boolean => {
  const hint = GROUP_HINTS[g.id];
  if (g.id === 'refs' && (turn.attachments.length || turn.images.length)) return true;
  return !!hint && hint.test(turn.userText || '');
};

const groupFailed = (ctx: StudioContext, id: string, stage: string, err: unknown) =>
  logger.warn('comic_tool_group_failed', { projectId: ctx.projectId, group: id, stage, message: (err as Error)?.message });

/**
 * Merge the core tools with the feature groups that pass their phase gate — groups relevant to
 * this turn's words first (GROUP_HINTS), then by priority (lower first; ties keep registration order). Groups are kept or dropped WHOLE so a
 * feature is never half-offered; one that would push the turn past MAX_TOOLS_PER_TURN
 * is skipped (a smaller, lower-priority group may still fit). Tool names are unique:
 * a feature tool can never shadow a core tool or an earlier group's. A group that throws
 * is skipped and logged — a broken feature never breaks the director turn.
 */
export function buildTurnToolset(
  ctx: StudioContext,
  turn: DirectorTurn,
  groups: readonly ToolGroup[] = [],
  opts: { core?: DirectorTool[]; maxTools?: number } = {}
): TurnToolset {
  const core = opts.core ?? buildDirectorTools(ctx, turn);
  const max = opts.maxTools ?? MAX_TOOLS_PER_TURN;
  const tools = [...core];
  const names = new Set(tools.map((t) => t.spec.function.name));
  const out: TurnToolset = { tools, groups: [], promptRules: [], summaryLines: [], activity: {} };
  const doc = ctx.session.doc;
  const ordered = groups
    .map((g, i) => ({ g, i, hot: groupRelevant(g, turn) ? 0 : 1 }))
    .sort((a, b) => a.hot - b.hot || a.g.priority - b.g.priority || a.i - b.i);
  for (const { g } of ordered) {
    if (g.activity) Object.assign(out.activity, g.activity);
    let offered: DirectorTool[];
    try {
      if (g.when && !g.when(ctx, turn)) continue;
      offered = (g.tools(ctx, turn) || []).filter((t) => t?.spec?.function?.name && !names.has(t.spec.function.name));
    } catch (err) {
      groupFailed(ctx, g.id, 'tools', err);
      continue;
    }
    if (tools.length + offered.length > max) {
      logger.info('comic_tool_group_trimmed', { projectId: ctx.projectId, group: g.id, tools: offered.length, offered: tools.length });
      continue;
    }
    for (const t of offered) {
      names.add(t.spec.function.name);
      tools.push(t);
    }
    out.groups.push(g.id);
    try {
      const rules = g.promptRules?.(doc)?.trim();
      if (rules) out.promptRules.push(rules);
      for (const line of g.summaryLines?.(doc, turn) || []) if (typeof line === 'string' && line.trim()) out.summaryLines.push(line.trim());
    } catch (err) {
      groupFailed(ctx, g.id, 'prompt', err);
    }
  }
  return out;
}

