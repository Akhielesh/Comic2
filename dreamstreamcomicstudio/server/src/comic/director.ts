// The Comic Director (v4): a tool-calling LLM that turns conversation into doc changes.
//
// One turn = the user's message is committed → the director model sees a compact DOC
// SUMMARY (the truth), its long-term memory and the last 14 messages → it calls tools
// (tools.ts) that commit DocOps, up to 8 rounds → its reply streams live as `delta`
// events for a pre-created message id → the final assistant message lands with the
// cards collected during the turn (questions, gates, plan) and 2–4 next-step chips.
// The director never sees or writes image prompts; the job runner compiles those from
// the doc. See docs/features/comic-studio-v4.md §6.8.

import { castKindOf, newId, totalPanels, isPageStale, type AssetRef, type Card, type ComicDoc, type Msg, type RefAsset } from '../../../shared/comic/doc.js';
import type { StudioFocus } from '../../../shared/comic/events.js';
import { aspectFromSize, aspectMatches, estimateJobs, resolveImageJob, tierPagePrice } from '../../../shared/comic/models.js';
import { costFormatter, costFormatterFor, governCard, governDollars, type CostFormatter } from './costText.js';
import { effectiveRating, type ContentRating } from '../../../shared/comic/safety.js';
import type { ChatMessage, MessagePart } from '../ai/providers/types.js';
import { logger } from '../lib/logger.js';
import { billedLlm, newTextSpendTracker, noticeCard, recordTextSpend, spendIsByok, suggestNextSteps, type TextSpendTracker } from './jobs.js';
import { isProviderRefusal, looksLikeRefusal } from './llm.js';
import { carriedImages, refIntentHint, unassignedImages, whoIsInTheseCard } from './refs/index.js';
import {
  composeTurnReply,
  detectNamedIp,
  drawIntentInContext,
  ipNoteFor,
  openQuestionsLine,
  recapLine,
  reconcileReply,
  retryNextSteps,
  runFailureLine,
  runOutcome,
  understandingChanges,
  userTurnCount,
  wantsRecap
} from './replies.js';
import { REDIRECT_COPY, prefilterText } from './safety/index.js';
import { buildTurnToolset, createDirectorTurn, pushNextSteps, type DirectorTool, type DirectorTurn } from './tools.js';
import { toolGroups } from './tools/index.js';
import { StudioError, type LlmResult, type StudioContext } from './types.js';

export const MAX_TOOL_ROUNDS = 8;
/** Tool calls honored in a single round; extras are refused so one round can't fan out unboundedly. */
export const MAX_CALLS_PER_ROUND = 12;
/** Conversation messages the director sees verbatim each turn. */
export const HISTORY_WINDOW = 14;
/** Past this many messages, older ones are folded into doc.memory. */
export const MEMORY_TRIGGER = 40;
/** Fold at least this many new out-of-window messages at a time (one cheap call). */
const MEMORY_MIN_BATCH = 10;
/** Images shown to the director per turn (768 px previews; attachments first, then carried ones). */
export const MAX_TURN_IMAGES = 8;
const PREVIEW_EDGE = 768;
const SUMMARY_CHAR_BUDGET = 12_000;
const MEMORY_MARKER = /\n?⟦through:([A-Za-z0-9_-]+)⟧\s*$/;
/**
 * Model-call failures that waiting does not fix and whose message already says what to do
 * (usage used up / a limit / a cooldown): the reply IS that message, with no "try again in a
 * moment" and no Try-again chip that would fail identically.
 */
const NOT_TRANSIENT_FAILURES: ReadonlySet<string> = new Set(['BILLING_DENIED', 'BUDGET_EXCEEDED', 'LIMIT', 'COOLDOWN']);

// ── System prompt (§6.8, director.md §3.11) ──────────────────────────────────

export const DIRECTOR_SYSTEM_PROMPT = `You are the Comic Director of DreamStream's Comic Studio — a warm, decisive comics editor and art director. The user makes a comic just by talking to you. You keep a structured document (the doc) up to date with tools; every image is compiled from the doc, so anything not in the doc is lost.

RULES
1. Capture first. Every concrete idea goes into the doc this turn through tools: brief, notes, cast (every look detail given), places, format, style. Never ask for what the user already said. Recurring animals, pets, sea creatures, toys, LEGO-style figures, vehicles, robots and key props are CAST too: upsert_character with kind (and count for a group). Vague group ("other animals")? Pick 2–3 that fit (lake + toddlers → three Ducklings, a Frog, a Bunny), name them, and let the user change them. Give everyone a drawable look.summary.
2. Understand out loud. On early turns open with one line of what you understood ("Got it — a one-page watercolor storybook for toddlers: the baby by a lake with three ducklings, a frog and a bunny.").
3. One question at a time (ask_user, 2–5 options, default first), only when something material is open (OPEN QUESTIONS). Put the price in options that spend.
4. Plan before pixels: idea → style → plan_pages → pages → cover. Draw only after the user saw the plan, never in the turn you planned it (unless they said to skip review). A look: a FREE preset (set_style presetId, or suggest_presets/use_preset when offered) before paid style tests.
5. FREE first. FREE tools cost nothing: use them for every edit they can do (text, line kinds, fonts, colors, balloons, page order, versions). When FREE or PAID could do it, do the FREE one and offer the PAID one with its price. Lettering is never fixed with a redraw — except in_art comics, where the words are painted in: say a text change there needs a PAID redraw.
6. Money. Never call a PAID tool on a question, complaint or feedback — ask which fix, with prices. "Draw everything" = render_pages without pages (+ include_cover); it only draws what is missing and costs $0 when nothing is. redraw:true only when the user asked for another take. A spend may answer "Waiting for the user to approve ~$X": say the estimate in one line and stop — you cannot approve for them. Never claim something was drawn, saved, published or shared unless a tool result says so; drawing runs in the background ("on its way").
7. Named characters and brands (Shin-chan, Baahubali, LEGO, Disney, Marvel…): warmly make an original homage — new name, distinct design, same spirit — say so once; never refuse silently.
8. Brevity: at most 80 words, plain sentences, no headings or lists. Always at least one sentence, in the SAME message as your tool calls.

HOW TO USE TOOLS
- Write your reply in the same message as your tool calls; never send tool calls without a sentence.
- Several independent facts → several calls in one round. Use ids from the DOC SUMMARY; names work too.
- "Error: …" → fix the arguments once, or tell the user plainly what went wrong.
- After ask_user, end your turn.
- A long pasted script: save_source (no arguments if the message says it was already saved, else useMessage:true), then offer the next step.
- Dialogue: read_pages, then edit_panel_text or set_line. A drawn page's art: edit_page; its script: revise_pages.

ATTACHMENTS
Images are numbered "Attached image 1, 2, …" (earlier unassigned images continue the numbering) and you can see them. Do what the user says they are for: a person or drawing for a character (attach_refs — keep every photo of them), a look to follow (set_style), or a location (upsert_place). If unclear, ask ("Is this Maya, or a style to follow?"). Also write what you see into the look fields. A SAFETY, IP or CARE NOTE after the message is from the studio: follow it.

The DOC SUMMARY below is the current truth — older messages may be out of date. Reply in the user's language.`;

// ── Doc summary ──────────────────────────────────────────────────────────────

const clip = (value: unknown, max: number): string => {
  const s = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  return s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`;
};
const upper = (s?: string) => (s || '').trim().toUpperCase() || 'UNNAMED';

const renderWord = (status: string, stale = false) => (stale ? 'out of date' : status === 'none' ? 'not drawn' : status);

/** Non-person cast reads "animal ×3" in the summary (people stay as before). */
const castKindTag = (c: ComicDoc['cast'][number]): string => {
  const kind = castKindOf(c);
  const count = c.count && c.count > 1 ? ` ×${c.count}` : '';
  return kind === 'person' ? count : `, ${kind}${count}`;
};

const focusLine = (doc: ComicDoc, focus?: StudioFocus): string => {
  if (!focus) return '';
  const page = focus.pageId ? doc.pages.find((p) => p.id === focus.pageId) : undefined;
  const parts: string[] = [];
  if (page) parts.push(`page ${page.n}${focus.panelN ? `, panel ${focus.panelN}` : ''}`);
  const selected = (focus.lineIds || []).slice(0, 6).flatMap((id) => {
    for (const p of doc.pages) for (const panel of p.panels) for (const l of panel.lines) if (l.id === id) return [`p${p.n} panel ${panel.n}: “${clip(l.text, 40)}” (${l.kind})`];
    return [];
  });
  if (selected.length) parts.push(`selected balloons — ${selected.join('; ')}`);
  return parts.length ? `Focus: the user is looking at ${parts.join('; ')}` : '';
};

/**
 * Compact, model-facing state of the comic (≈ ≤ 3k tokens). `extraLines` are the active
 * feature groups' summary lines (ToolGroup.summaryLines), placed before the money lines.
 * `opts.userText` adds the OPEN QUESTIONS line (materialGaps); `opts.focus` what the user selected.
 *
 * The summary has a body (story, cast, places, pages) and a tail (feature lines, the user's
 * focus, the money settings and spend — with the governed "never in dollars" instruction —
 * the open approval and the open question). The tail is what the model must never lose, so it
 * is built first and never clipped: when a big book overflows SUMMARY_CHAR_BUDGET, only the body
 * shrinks — notes to the last 6, cast lines to name/id/tier and page lines to number/status —
 * and is hard-cut last.
 */
export function summarizeDocForDirector(
  doc: ComicDoc,
  byok = false,
  extraLines: readonly string[] = [],
  opts: { userText?: string; focus?: StudioFocus; cost?: CostFormatter } = {}
): string {
  // Prices in the user's terms: a governed user's director never even sees a dollar figure to repeat.
  const c = opts.cost ?? costFormatter();
  const f = doc.format;

  const tail: string[] = [];
  for (const extra of extraLines) if (extra) tail.push(clip(extra, 400));
  const focus = focusLine(doc, opts.focus);
  if (focus) tail.push(focus);
  const set = doc.settings;
  const { spec, resolution } = resolveImageJob('page', set.quality, set.imageModelOverride);
  const coverUsd = estimateJobs([{ kind: 'cover', count: 1 }], set.quality, { override: set.imageModelOverride, byok }).usd;
  tail.push(
    `Settings: ${set.quality} quality (${spec.nickname} ${resolution}, ${c.approx(tierPagePrice(set.quality, byok))}/page, cover ${c.approx(coverUsd)}, text edits free); confirm ${set.confirm}${set.confirm === 'big' ? ` (above ${c(set.bigSpendUsd)})` : ''}; budget ${set.budgetUsd ? c(set.budgetUsd) : 'none'}`
  );
  tail.push(`Spend so far: ${c(doc.spend.totalUsd)}${c.governed ? ' (quote prices as a share of the user\'s usage, never in dollars)' : ''}`);
  if (doc.gate?.status === 'open') tail.push(`Waiting on approval: ${clip(doc.gate.title, 80)} ${c.approx(doc.gate.estimateUsd)} (${doc.gate.reason})`);
  const open = opts.userText !== undefined ? openQuestionsLine(doc, opts.userText) : '';
  if (open) tail.push(open);
  const tailText = tail.join('\n');

  const room = SUMMARY_CHAR_BUDGET - tailText.length - 1;
  let body = summaryBody(doc, false);
  if (body.length > room) body = summaryBody(doc, true);
  if (body.length > room) body = `${body.slice(0, Math.max(0, room - 1)).trimEnd()}…`;
  return `${body}\n${tailText}`;
}

/** The clippable part of the DOC SUMMARY; `compact` is the shorter form used when the book overflows the budget. */
function summaryBody(doc: ComicDoc, compact: boolean): string {
  const b = doc.brief;
  const f = doc.format;
  const lines: string[] = [`DOC SUMMARY (rev ${doc.rev})`];
  lines.push(`Title: ${clip(b.title, 120) || '(untitled)'}${b.logline ? ` | Logline: ${clip(b.logline, 240)}` : ''}`);
  if (b.premise) lines.push(`Premise: ${clip(b.premise, 600)}`);
  const facts = [b.genre && `genre ${clip(b.genre, 80)}`, b.tone && `tone ${clip(b.tone, 80)}`, b.audience && `audience ${clip(b.audience, 80)}`, b.setting && `setting ${clip(b.setting, 200)}`]
    .filter(Boolean)
    .join('; ');
  if (facts) lines.push(`Story: ${facts}`);
  if (b.themes?.length) lines.push(`Themes: ${b.themes.slice(0, 8).map((t) => clip(t, 60)).join(', ')}`);
  if (b.notes.length) lines.push(`Notes:\n${b.notes.slice(compact ? -6 : -14).map((n) => `- ${clip(n, 200)}`).join('\n')}`);
  const sourceWords = (doc.source.script?.match(/\S+/g) || []).length;
  lines.push(`Source: ${sourceWords ? `${sourceWords.toLocaleString('en-US')} words of the user's script/story are saved` : 'none'}`);
  lines.push(
    `Format: ${f.kind}, ${f.pageCount} page${f.pageCount === 1 ? '' : 's'}, ${f.pageAspect}, panels/page ${f.panelsPerPage}, ${f.readingDirection}, ${f.lettering} lettering, ${f.colorMode}, language ${f.language}`
  );

  const s = doc.style;
  const options = s.options.length ? ` | options: ${s.options.map((o) => `“${clip(o.name, 40)}” ${renderWord(o.render.status)} [${o.id}]`).join(', ')}` : '';
  lines.push(
    `Style: ${s.status}${s.name ? ` “${clip(s.name, 60)}”` : ''}${s.spec ? ` — ${clip(s.spec, 220)}` : ''}${s.refs.length ? ` | ${s.refs.length} style reference image(s)` : ''}${s.board ? ' | style board set' : ''}${options}`
  );

  if (doc.cast.length) {
    lines.push(`Cast (${doc.cast.length}):`);
    for (const c of doc.cast.slice(0, 24)) {
      lines.push(
        compact
          ? `- ${upper(c.name)} [${c.id}] ${c.tier}${castKindTag(c)}`
          : `- ${upper(c.name)} [${c.id}] ${c.tier}${castKindTag(c)}${c.role ? `, ${clip(c.role, 60)}` : ''} — ${clip(c.look.summary, 170) || '(no look yet)'}; ${c.tier === 'extra' ? 'text only' : `sheet ${renderWord(c.sheet.status)}`}${c.refs.length ? `; ${c.refs.length} reference photo(s)` : ''}`
      );
    }
    if (doc.cast.length > 24) lines.push(`- …and ${doc.cast.length - 24} more`);
  } else {
    lines.push('Cast: none yet');
  }
  if (doc.places.length) {
    lines.push(`Places: ${doc.places.slice(0, 16).map((p) => `${upper(p.name)} [${p.id}]${p.look ? ` — ${clip(p.look, 90)}` : ''}`).join('; ')}`);
  }

  if (doc.pages.length) {
    lines.push(`Plan: ${doc.planStatus} — ${doc.pages.length} page(s), ${totalPanels(doc)} panels`);
    for (const p of [...doc.pages].sort((a, b) => a.n - b.n).slice(0, 40)) {
      const a = p.render.status === 'ready' ? p.render.asset : undefined;
      const shape = a && !aspectMatches(f.pageAspect, a.w, a.h) && a.w && a.h ? `, drawn ${aspectFromSize(a.w, a.h)}` : '';
      const status = `[${renderWord(p.render.status, isPageStale(doc, p))}${shape}${typeof p.render.qc?.score === 'number' ? `, qc ${p.render.qc.score.toFixed(2)}` : ''}]`;
      lines.push(compact ? `- p${p.n} ${status}` : `- p${p.n} ${status} ${clip(p.summary, 110)} (${p.panels.length} panels)`);
    }
  } else {
    lines.push('Plan: none yet');
  }
  lines.push(
    `Cover: ${renderWord(doc.cover.render.status)}${doc.cover.title ? ` (title “${clip(doc.cover.title, 80)}”)` : ''}${(doc.cover.lettering ?? 'in_art') === 'overlay' ? ', title lettered on top (free edits)' : ''}`
  );
  return lines.join('\n');
}

// ── Conversation window ──────────────────────────────────────────────────────

/** One card as words for the model. Breakdown cards are live views: `doc` (when given) counts their pages. */
const cardText = (card: Card, cardDoc?: ComicDoc): string => {
  switch (card.type) {
    case 'options':
      return `[asked: ${clip(card.question, 160)} — options: ${card.choices.map((c) => clip(c.label, 40)).join(' / ')}${card.answered?.length ? `; answered: ${card.answered.join(', ')}` : ''}]`;
    case 'style_choice':
      return '[showed style options to pick from]';
    case 'cast':
      return '[showed the cast]';
    case 'plan':
      return '[showed the page plan]';
    case 'breakdown': {
      const ids = card.pageIds?.length ? new Set(card.pageIds) : null;
      const pages = cardDoc ? cardDoc.pages.filter((p) => !ids || ids.has(p.id)) : [];
      const panels = pages.reduce((n, p) => n + p.panels.length, 0);
      return cardDoc ? `[showed the page breakdown: ${pages.length} page${pages.length === 1 ? '' : 's'}, ${panels} panel${panels === 1 ? '' : 's'}]` : '[showed the page breakdown]';
    }
    case 'gate':
      return '[asked the user to approve a spend]';
    case 'renders':
      return `[drawing: ${clip(card.label, 80)}]`;
    case 'notice':
      return `[${card.tone}: ${clip(card.text, 200)}]`;
    default:
      return '';
  }
};

const messageText = (m: Msg, doc?: ComicDoc): string => {
  const parts = [clip(m.text, 3000)];
  if (m.attachments?.length) parts.push(`[${m.attachments.length} image(s) attached]`);
  for (const card of m.cards || []) parts.push(cardText(card, doc));
  return parts.filter(Boolean).join(' ');
};

/** The last messages as provider turns (consecutive same-role turns merged; starts with the user). */
export function conversationForDirector(conversation: Msg[], window = HISTORY_WINDOW, doc?: ComicDoc): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const m of conversation.slice(-window)) {
    const content = messageText(m, doc);
    if (!content) continue;
    const last = out[out.length - 1];
    if (last && last.role === m.role && typeof last.content === 'string') last.content = `${last.content}\n\n${content}`;
    else out.push({ role: m.role, content });
  }
  while (out.length && out[0].role !== 'user') out.shift();
  return out;
}

const parseMemory = (memory?: string): { summary: string; through?: string } => {
  if (!memory) return { summary: '' };
  const m = MEMORY_MARKER.exec(memory);
  return m ? { summary: memory.slice(0, m.index).trim(), through: m[1] } : { summary: memory.trim() };
};

// ── Turn ─────────────────────────────────────────────────────────────────────

const TOOL_ACTIVITY: Record<string, string> = {
  update_brief: 'Updating the story',
  add_notes: 'Taking notes',
  set_format: 'Setting the format',
  save_source: 'Reading your script',
  upsert_character: 'Updating the cast',
  remove_character: 'Updating the cast',
  upsert_place: 'Updating places',
  remove_place: 'Updating places',
  set_style: 'Setting the style',
  propose_styles: 'Preparing style options',
  render_character_sheets: 'Preparing character sheets',
  revise_pages: 'Rewriting pages',
  read_pages: 'Reading the plan',
  edit_panel_text: 'Editing dialogue',
  set_line: 'Editing a line',
  render_pages: 'Preparing pages',
  edit_page: 'Preparing the edit',
  render_cover: 'Preparing the cover',
  set_settings: 'Updating settings',
  ask_user: 'Asking you'
};

const parseArgs = (raw: string | undefined): { args: Record<string, unknown>; malformed: boolean } => {
  if (!raw || !raw.trim()) return { args: {}, malformed: false };
  try {
    const parsed = JSON.parse(raw);
    return { args: parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}, malformed: false };
  } catch {
    // Common model slips: fenced JSON or trailing commas.
    const stripped = raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, '').replace(/,\s*([}\]])/g, '$1');
    try {
      const parsed = JSON.parse(stripped);
      return { args: parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}, malformed: false };
    } catch {
      return { args: {}, malformed: true };
    }
  }
};

/** Show up to MAX_TURN_IMAGES images as ≤ 768 px previews (attachments, then carried unassigned images). */
async function loadTurnImages(ctx: StudioContext, images: RefAsset[], attachedCount: number): Promise<MessagePart[]> {
  const parts: MessagePart[] = [];
  for (const [i, a] of images.slice(0, MAX_TURN_IMAGES).entries()) {
    const label = i < attachedCount ? `Attached image ${i + 1}:` : `Attached image ${i + 1} (from an earlier message, not assigned yet):`;
    try {
      let url: string;
      try {
        url = await ctx.assets.previewDataUrl(a.path, PREVIEW_EDGE);
      } catch {
        url = await ctx.assets.loadDataUrl(a.path);
      }
      parts.push({ type: 'text', text: label });
      parts.push({ type: 'image_url', image_url: { url } });
    } catch (err) {
      parts.push({ type: 'text', text: `${label.slice(0, -1)} (could not be loaded)` });
      logger.warn('comic_director_image_load_failed', { projectId: ctx.projectId, path: a.path, message: (err as Error)?.message });
    }
  }
  return parts;
}

/** Trademarked names to steer to an homage this turn (prefilter seam ∪ the built-in list), minus ones already explained. */
const ipToSteer = (doc: ComicDoc, text: string, rating: ContentRating): string[] => {
  let fromFilter: string[] = [];
  try {
    fromFilter = prefilterText(text, rating).ip || [];
  } catch {
    fromFilter = [];
  }
  // "Shin-chan" (built-in list) and "shinchan" (prefilter) are one name.
  const keyOf = (n: unknown) => (typeof n === 'string' ? n.toLowerCase().replace(/^the\s+/, '').replace(/[^\p{L}\p{N}]+/gu, '') : '');
  const noted = new Set((doc.safety?.ipNoted || []).map(keyOf));
  const seen = new Set<string>();
  const names: string[] = [];
  for (const n of [...detectNamedIp(text), ...fromFilter]) {
    const key = keyOf(n);
    if (!key || seen.has(key) || noted.has(key)) continue;
    seen.add(key);
    names.push(n.trim());
  }
  return names.slice(0, 4);
};

/** The model's own words, opened with the recap on the first turns when it gave none (never a duplicate). */
const withEarlyRecap = (text: string, before: ComicDoc, after: ComicDoc, userText: string): string => {
  if (!text || userTurnCount(after) > 2 || understandingChanges(before, after) < 2) return text;
  // The recap phrases are English: never prepend them to a reply in another language.
  if (!/^en\b/i.test(after.format.language || 'en') || /[^\p{Script=Latin}\p{N}\p{P}\p{S}\s]/u.test(`${userText} ${text}`)) return text;
  if (/^(got it|love it|here'?s what|so[,:—-]|ok(?:ay)?[,!.—-]|great[,!.—-]|perfect[,!.—-])/i.test(text.trim())) return text;
  const lower = text.toLowerCase();
  if (after.cast.some((c) => c.name.trim().length > 2 && lower.includes(c.name.trim().toLowerCase()))) return text;
  if ((text.match(/\S+/g) || []).length > 40) return text;
  const recap = recapLine(after);
  return recap ? `Got it — ${recap}. ${text}` : text;
};

export interface DirectorTurnInput {
  text: string;
  attachments: AssetRef[];
  sourceSaved?: boolean;
  /** What the user is looking at / has selected (page editor, balloons). */
  focus?: StudioFocus;
  /** SAFETY/IP NOTE from screenTurnInput (adapt decisions), appended to the user turn. */
  safetyNote?: string;
}

/**
 * Run one director turn for a user message. Never throws for model/tool failures — they
 * become an honest notice in the conversation; only cancellation ends it quietly. Never
 * silent: when the model writes nothing, composeTurnReply says what the turn actually did,
 * and a reply is re-checked against the renders this turn started before it is committed.
 */
export async function runDirectorTurn(ctx: StudioContext, input: DirectorTurnInput): Promise<void> {
  const session = ctx.session;
  const startedAt = Date.now();
  const userText = (input.text || '').trim();
  const attachments = (input.attachments || []).filter((a) => a?.path);
  const userMsg: Msg = {
    id: newId('msg'),
    role: 'user',
    text: userText,
    at: startedAt,
    ...(attachments.length ? { attachments } : {})
  };
  session.commit([{ op: 'message', msg: userMsg }]);
  const msgId = newId('msg');
  try {
    await directorTurnBody(ctx, input, { userMsg, msgId, startedAt, userText, attachments });
  } catch (err) {
    // Never silent, even when something outside the model loop breaks (a malformed doc, a seam that
    // throws): the user's message always gets an honest answer and a way to try again.
    if (ctx.signal.aborted || session.doc.conversation.some((m) => m.id === msgId)) return;
    logger.error('comic_director_turn_crashed', { projectId: ctx.projectId, message: (err as Error)?.message });
    session.commit([
      {
        op: 'message',
        msg: {
          id: msgId,
          role: 'assistant',
          text: "Sorry — I couldn't finish that just now. Try again in a moment.",
          at: Date.now(),
          cards: [noticeCard('error', 'The studio assistant hit a snag. Please try again.')],
          ...(userText ? { nextSteps: [{ label: 'Try again', say: userText }] } : {})
        }
      }
    ]);
  }
}

async function directorTurnBody(
  ctx: StudioContext,
  input: DirectorTurnInput,
  t: { userMsg: Msg; msgId: string; startedAt: number; userText: string; attachments: AssetRef[] }
): Promise<void> {
  const session = ctx.session;
  const { userMsg, msgId, startedAt, userText, attachments } = t;
  const before = session.doc;
  let carried: RefAsset[] = [];
  try {
    carried = carriedImages(before, attachments).filter((r) => r?.path && !attachments.some((a) => a.path === r.path));
  } catch (err) {
    logger.warn('comic_director_carry_failed', { projectId: ctx.projectId, message: (err as Error)?.message });
  }
  const images: RefAsset[] = [...attachments, ...carried];
  const rating = ctx.rating ?? effectiveRating(before, ctx.caps?.ratingCeiling).rating;
  // The safety screen may already carry an IP NOTE (P1-SAFETY); never say it twice.
  const ipNames = /\bIP NOTE\b/.test(input.safetyNote || '') ? [] : ipToSteer(before, userText, rating);
  const turn: DirectorTurn = createDirectorTurn({
    attachments,
    userText,
    sourceSaved: !!input.sourceSaved,
    rating,
    // "yes" to the studio's own "Ready to draw?" counts as asking (director.md §3.4; gates still apply).
    drawIntent: drawIntentInContext(before, userText),
    images,
    ...(input.focus ? { focus: input.focus } : {}),
    ...(input.safetyNote ? { safetyNote: input.safetyNote } : {}),
    startedAt,
    runs: [],
    bgErrors: [],
    ipNames
  });
  // Core tools + the feature groups active this turn (contract §12.1).
  const toolset = buildTurnToolset(ctx, turn, toolGroups());
  const tools: DirectorTool[] = toolset.tools;
  const toolByName = new Map(tools.map((t) => [t.spec.function.name, t]));
  const tracker = newTextSpendTracker();
  const llm = billedLlm(ctx, { stage: 'chat', operation: 'comic.text.director', tracker });
  const byok = spendIsByok(ctx.keys);
  const cost = costFormatterFor(ctx);

  const doc = session.doc;
  const { summary: memory } = parseMemory(doc.memory);
  const prompt = toolset.promptRules.length ? `${DIRECTOR_SYSTEM_PROMPT}\n\n${toolset.promptRules.join('\n')}` : DIRECTOR_SYSTEM_PROMPT;
  const system = [
    prompt,
    summarizeDocForDirector(doc, byok, toolset.summaryLines, { userText, focus: input.focus, cost }),
    memory ? `MEMORY (older conversation):\n${clip(memory, 3000)}` : ''
  ]
    .filter(Boolean)
    .join('\n\n');
  const history = conversationForDirector(doc.conversation.filter((m) => m.id !== userMsg.id), HISTORY_WINDOW - 1, doc);
  const imageParts = await loadTurnImages(ctx, images, attachments.length);
  let hint: string | undefined;
  try {
    // With the doc: lower-case names and fuzzy cast matches resolve ("mya" → MAYA, "existing, 2 refs").
    hint = images.length ? refIntentHint(userText, images.length, before) : undefined;
  } catch {
    hint = undefined;
  }
  const notes = [
    input.safetyNote ? input.safetyNote.trim() : '',
    ipNames.length ? ipNoteFor(ipNames) : '',
    hint ? `REF HINT: ${hint}` : ''
  ].filter(Boolean);
  const currentText =
    (userText || (attachments.length ? '(The user sent images without a message.)' : '')) +
    (images.length > MAX_TURN_IMAGES ? `\n(${images.length} images available; the first ${MAX_TURN_IMAGES} are shown.)` : '') +
    (notes.length ? `\n\n${notes.join('\n')}` : '');
  const messages: ChatMessage[] = [
    { role: 'system', content: system },
    ...history,
    { role: 'user', content: imageParts.length ? [{ type: 'text', text: currentText }, ...imageParts] : currentText }
  ];
  // Providers need the conversation to open with a user turn after the system prompt.
  if (messages[1]?.role !== 'user') messages.splice(1, 0, { role: 'user', content: '(continuing)' });

  // Watch what this turn sets in motion: queued render targets and background error notices,
  // so the committed reply can be checked against what actually happened (honest outcomes).
  const unwatch = session.subscribe((e) => {
    if (e.type !== 'ops') return;
    for (const op of e.ops) {
      if (op.op === 'render' && op.patch?.status === 'queued') turn.runs!.push(op.target);
      else if (op.op === 'message' && op.msg.role === 'assistant' && op.msg.id !== msgId) {
        for (const card of op.msg.cards || []) if (card.type === 'notice' && card.tone === 'error' && card.text) turn.bgErrors!.push(card.text);
      }
    }
  });

  const spoken: string[] = [];
  let streamedChars = 0;
  const onDelta = (t: string) => {
    if (!t || ctx.signal.aborted) return;
    if (streamedChars === 0 && spoken.length) session.emit({ type: 'delta', msgId, text: '\n\n' });
    streamedChars += t.length;
    session.emit({ type: 'delta', msgId, text: t });
  };

  let failure: StudioError | null = null;
  let cancelled = false;
  try {
    let rounds = 0;
    for (;;) {
      const allowTools = rounds < MAX_TOOL_ROUNDS && !turn.askedUser;
      // On the forced final round we KEEP sending the tool specs: the history already holds
      // assistant tool_calls and their tool results, and some providers (Anthropic) reject a
      // request that carries those but defines no tools. We discard any tool call made here
      // (see `calls` below) and nudge the model to answer in words instead.
      if (!allowTools && rounds > 0) {
        messages.push({ role: 'user', content: '(Tool limit reached for this turn. Reply to the user now in plain words — do not call tools.)' });
      }
      streamedChars = 0;
      const result: LlmResult = await llm.complete({
        role: 'director',
        messages,
        tools: tools.map((t) => t.spec),
        onDelta,
        signal: ctx.signal
      });
      const said = (result.text || '').trim();
      if (said) spoken.push(said);
      const calls = allowTools ? result.toolCalls || [] : [];
      if (!calls.length) break;
      rounds += 1;
      messages.push({
        role: 'assistant',
        content: result.text || '',
        tool_calls: calls.map((c) => ({ id: c.id, type: 'function' as const, function: { name: c.name, arguments: c.arguments || '{}' } }))
      });
      // Sequential: every tool mutates the same doc. Re-check for a cancel before each call so
      // a Stop part-way through a round stops starting further (sometimes paid) work, and cap
      // the calls honored per round so a model that fans out can't run an unbounded number.
      for (const [i, call] of calls.entries()) {
        if (ctx.signal.aborted) throw new StudioError('CANCELLED', 'Cancelled.', { status: 499 });
        if (i >= MAX_CALLS_PER_ROUND) {
          messages.push({ role: 'tool', tool_call_id: call.id, content: 'Error: too many tool calls in one round — this one was skipped. Reply to the user or make fewer calls.' });
          continue;
        }
        const tool = toolByName.get(call.name);
        const { args, malformed } = parseArgs(call.arguments);
        let output: string;
        if (!tool) output = `Error: unknown tool "${call.name}".`;
        else if (malformed) output = `Error: the arguments for ${call.name} were not valid JSON. Re-issue the call with complete JSON.`;
        else {
          const actId = newId('act');
          const label = TOOL_ACTIVITY[call.name] ?? toolset.activity[call.name];
          // The badge follows THIS call: insert_page is free, but with write:true it runs the (paid) writer.
          const badge = call.name === 'insert_page' && args.write === true ? 'text' : tool.cost === 'paid' ? 'image' : tool.cost;
          if (label) session.emit({ type: 'activity', id: actId, label, phase: 'start', cost: badge });
          let committed = 0;
          const unsubscribe = session.subscribe((e) => {
            if (e.type === 'ops') committed += e.ops.length;
          });
          try {
            output = await tool.execute(args);
          } finally {
            unsubscribe();
          }
          const ok = !/^(Error|Refused)\b/.test(output);
          if (label) session.emit({ type: 'activity', id: actId, label, phase: 'end', ok, cost: badge });
          turn.log.push({ tool: call.name, ok, cost: tool.cost, result: output.slice(0, 400), ops: committed });
        }
        if (!tool || malformed) turn.log.push({ tool: call.name, ok: false, cost: tool?.cost ?? 'free', result: output.slice(0, 400), ops: 0 });
        messages.push({ role: 'tool', tool_call_id: call.id, content: output.slice(0, 16_000) });
      }
      if (ctx.signal.aborted) throw new StudioError('CANCELLED', 'Cancelled.', { status: 499 });
      // ask_user ends the turn: the question and its chips are the reply.
      if (turn.askedUser) break;
    }
  } catch (err) {
    const error = err instanceof StudioError ? err : new StudioError('INTERNAL', 'The studio assistant hit a snag. Please try again.', { cause: err });
    if (error.code === 'CANCELLED' || ctx.signal.aborted) cancelled = true;
    else {
      failure = error;
      logger.warn('comic_director_turn_failed', { projectId: ctx.projectId, code: error.code, message: (err as Error)?.message });
    }
  } finally {
    unwatch();
  }

  const after = session.doc;
  let text = spoken.join('\n\n').trim();
  const cards = [...turn.cards];
  // A provider refusal of the director turn (or a written refusal with no tool work) gets the
  // deterministic, warm redirect — never an error wall, never a strike (providers over-block horror).
  const refused = !cancelled && ((failure && isProviderRefusal(failure)) || (!failure && !turn.log.length && looksLikeRefusal(text)));
  if (refused) {
    if (failure) logger.info('comic_director_provider_refusal', { projectId: ctx.projectId, code: failure.code });
    failure = null;
    // The safety module's one copy (safety.md §3.5): warm text + options, never a strike.
    const redirect = REDIRECT_COPY.provider;
    text = redirect.text;
    cards.push({
      type: 'options',
      id: newId('card'),
      question: 'How should we go on?',
      choices: redirect.options.map((o) => ({ id: newId('opt'), label: o.label, reply: o.reply })),
      allowCustom: true
    });
  }
  const notTransient = !!failure && NOT_TRANSIENT_FAILURES.has(failure.code);
  // When the model said nothing, a not-transient reason is the reply itself (said once, not also as a card).
  const reasonIsReply = notTransient && !text;
  if (failure && !reasonIsReply) cards.push(noticeCard('error', failure.userMessage));
  if (!cancelled && !refused) {
    if (text) text = reconcileReply(withEarlyRecap(text, before, after, userText), { after, turn });
    else if (failure) {
      // Never claim work "keeps drawing" when it already failed (b4b5774f): say what really happened.
      const runLine = runFailureLine(after, runOutcome(after, turn));
      text = reasonIsReply
        ? [failure.userMessage, runLine].filter(Boolean).join(' ')
        : runLine
          ? `Sorry — I couldn't finish my reply. ${runLine}`
          : turn.outcome === 'started'
            ? "Sorry — I couldn't finish my reply, but what I already started keeps drawing."
            : "Sorry — I couldn't finish that just now. Try again in a moment.";
    } else text = composeTurnReply({ before, after, turn, userText });
  }
  if (cancelled && !text && !cards.length) {
    recordTextSpend(ctx, tracker, 'chat', 'Director');
    return;
  }
  const spokeBeforeStop = cancelled && !!text;
  if (cancelled && !text) text = 'Stopped.';
  // Early turns: a live recap card of what the studio understood (director.md §3.2).
  if (!cancelled && !failure && !refused && wantsRecap(before, after)) cards.unshift({ type: 'recap', id: newId('card') } as Card);
  // refs.md §6.6: photos nobody was assigned are never left hanging — "Who's in these photos?" (free taps).
  if (!cancelled && !refused && !turn.askedUser && images.length && !cards.some((c) => c.type === 'options')) {
    try {
      if (unassignedImages(after, images).length) {
        const who = whoIsInTheseCard(after, images);
        if (who) cards.push(who);
      }
    } catch (err) {
      logger.warn('comic_director_refs_guard_failed', { projectId: ctx.projectId, message: (err as Error)?.message });
    }
  }
  // Governed users never read dollars, whoever wrote them (a template, or the model) — in the reply
  // and on its cards (ask_user options carry prices the model writes; hosted job notices too).
  if (cost.governed) {
    if (text) text = governDollars(text, cost.view);
    for (let i = 0; i < cards.length; i += 1) cards[i] = governCard(cards[i], cost.view);
  }
  // Honest retry chips for renders this turn started that already failed.
  const run = runOutcome(after, turn);
  if (!cancelled && run.failed.length && !run.busy.length) pushNextSteps(turn, retryNextSteps(after, run.failed, byok));
  // A Try-again chip only when trying again can work; a used-up allowance would fail the same way.
  if (failure && userText && !notTransient) pushNextSteps(turn, [{ label: 'Try again', say: userText }]);
  const final: Msg = {
    id: msgId,
    role: 'assistant',
    text: spokeBeforeStop ? `${text} (stopped)` : text,
    at: Date.now(),
    ...(cards.length ? { cards } : {}),
    ...(!cancelled && !failure ? { suggestions: suggestNextSteps(after) } : {}),
    ...(!cancelled && turn.nextSteps.length ? { nextSteps: turn.nextSteps } : {})
  };
  const ops = [{ op: 'message' as const, msg: final }];
  session.commit(ops);
  // Say the IP note once per name (doc.safety.ipNoted, server-only) — only once a real reply carried it.
  if (!cancelled && !failure && !refused && ipNames.length) {
    const noted = [...new Set([...(after.safety?.ipNoted || []), ...ipNames])].slice(-40);
    session.commit([{ op: 'safety', patch: { ipNoted: noted } }]);
  }
  recordTextSpend(ctx, tracker, 'chat', 'Director');

  if (!cancelled) await maybeFoldMemory(ctx).catch(() => undefined);
}

// ── Memory ───────────────────────────────────────────────────────────────────

const MEMORY_PROMPT = `You keep the running memory of a conversation between a user and the comics studio assistant that is making their comic. Update the memory with the NEW MESSAGES.
Keep: decisions, preferences and dislikes, rejected ideas, promises, open questions, anything the user asked to keep in mind. Skip pleasantries and anything already captured in the doc (titles, cast looks, plan details).
At most 180 words, as short lines starting with "- ". Return only the lines.`;

/**
 * When the conversation is long, fold messages that scrolled out of the director's window
 * into doc.memory with one cheap call. Fail-soft: errors only log.
 */
export async function maybeFoldMemory(ctx: StudioContext, opts: { trigger?: number; window?: number; minBatch?: number } = {}): Promise<boolean> {
  const doc = ctx.session.doc;
  const conv = doc.conversation;
  const window = opts.window ?? HISTORY_WINDOW;
  if (conv.length <= (opts.trigger ?? MEMORY_TRIGGER)) return false;
  const older = conv.slice(0, conv.length - window);
  const { summary, through } = parseMemory(doc.memory);
  const start = through ? older.findIndex((m) => m.id === through) + 1 : 0;
  const fresh = older.slice(Math.max(0, start));
  if (fresh.length < (opts.minBatch ?? MEMORY_MIN_BATCH)) return false;

  const transcript = fresh
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${messageText(m)}`)
    .join('\n')
    .slice(-12_000);
  const tracker: TextSpendTracker = newTextSpendTracker();
  try {
    const result = await billedLlm(ctx, { stage: 'chat', operation: 'comic.text.director', tracker }).complete({
      role: 'director',
      messages: [
        { role: 'system', content: MEMORY_PROMPT },
        { role: 'user', content: `CURRENT MEMORY:\n${summary || '(empty)'}\n\nNEW MESSAGES:\n${transcript}` }
      ],
      temperature: 0.2,
      maxTokens: 700,
      signal: ctx.session.abort.signal
    });
    const updated = (result.text || '').trim().slice(0, 2400);
    if (!updated) return false;
    ctx.session.commit([{ op: 'memory', text: `${updated}\n⟦through:${fresh[fresh.length - 1].id}⟧` }]);
    return true;
  } catch (err) {
    logger.warn('comic_director_memory_failed', { projectId: ctx.projectId, message: (err as Error)?.message });
    return false;
  } finally {
    recordTextSpend(ctx, tracker, 'chat', 'Conversation memory');
  }
}
