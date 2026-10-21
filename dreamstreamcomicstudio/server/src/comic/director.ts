// The Comic Director (v4): a tool-calling LLM that turns conversation into doc changes.
//
// One turn = the user's message is committed → the director model sees a compact DOC
// SUMMARY (the truth), its long-term memory and the last 14 messages → it calls tools
// (tools.ts) that commit DocOps, up to 8 rounds → its reply streams live as `delta`
// events for a pre-created message id → the final assistant message lands with the
// cards collected during the turn (questions, gates, plan) and 2–4 next-step chips.
// The director never sees or writes image prompts; the job runner compiles those from
// the doc. See docs/features/comic-studio-v4.md §6.8.

import { newId, totalPanels, isPageStale, type AssetRef, type Card, type ComicDoc, type Msg } from '../../../shared/comic/doc.js';
import { formatUsd, resolveImageJob, tierPagePrice } from '../../../shared/comic/models.js';
import type { ChatMessage, MessagePart } from '../ai/providers/types.js';
import { logger } from '../lib/logger.js';
import { billedLlm, newTextSpendTracker, noticeCard, recordTextSpend, spendIsByok, suggestNextSteps, type TextSpendTracker } from './jobs.js';
import { buildDirectorTools, createDirectorTurn, type DirectorTool, type DirectorTurn } from './tools.js';
import { StudioError, type LlmResult, type StudioContext } from './types.js';

export const MAX_TOOL_ROUNDS = 8;
/** Conversation messages the director sees verbatim each turn. */
export const HISTORY_WINDOW = 14;
/** Past this many messages, older ones are folded into doc.memory. */
export const MEMORY_TRIGGER = 40;
/** Fold at least this many new out-of-window messages at a time (one cheap call). */
const MEMORY_MIN_BATCH = 10;
const MAX_TURN_IMAGES = 4;
const SUMMARY_CHAR_BUDGET = 12_000;
const MEMORY_MARKER = /\n?⟦through:([A-Za-z0-9_-]+)⟧\s*$/;

// ── System prompt (§6.8) ─────────────────────────────────────────────────────

export const DIRECTOR_SYSTEM_PROMPT = `You are the Comic Director of DreamStream's Comic Studio — a warm, decisive comics editor and art director. The user makes a comic just by talking to you. You keep a structured document (the doc) up to date with tools; every image the studio draws is compiled from the doc, so anything that is not in the doc is lost.

RULES
1. Capture first. Every concrete idea the user states goes into the doc in the same turn, through tools: brief (title, logline, premise, genre, tone, audience, setting), notes, cast (with every look detail they gave), places, format and style. Never ask for something the user already said. Give every character you create a drawable look.summary; where the user gave no details, choose sensible ones that fit the story and mention that they can be changed.
2. One question at a time, always through ask_user with 2–5 tappable options. Put a sensible default first instead of interrogating. When a reasonable default exists, pick it, say so in a few words, and keep moving.
3. Default forward motion: idea → style → character sheets → page plan → draw pages → cover. Every reply moves one step forward or offers the next step.
4. Plan before pixels. Never draw pages before the user has seen the page plan (plan_pages), unless they explicitly ask to skip it. Plan changes go through revise_pages or edit_panel_text — they cost nothing in images.
5. Money. The spend tools (propose_styles, render_character_sheets, render_pages, edit_page, render_cover) may answer "Waiting for the user to approve ~$X" — then tell the user the estimate in one line and stop; the approve button is already on screen. You cannot approve spending yourself — if the user says "yes" to a waiting approval, ask them to tap Approve on the card. Never claim something was drawn, saved or changed unless a tool result says it was. Drawing runs in the background: say it is on its way, not that it is done.
6. Brevity. Replies of at most 80 words unless the user asks for depth. Plain sentences — no markdown headings, no lists of everything you saved. Mention what matters in one line.

HOW TO USE TOOLS
- Call the tools first, then write your reply once, at the end. Do not narrate tool calls ("Let me save that…").
- Several independent facts → several tool calls in the same round.
- Use the ids from the DOC SUMMARY when you have them; names work too.
- If a tool answers "Error: …", fix the arguments and try once more, or tell the user plainly what went wrong.
- After ask_user, end your turn.
- A long pasted script or story: call save_source with useMessage:true (it extracts the brief, cast and places), then offer the next step.
- To change a page's dialogue, read it first with read_pages, then edit_panel_text. To change a drawn page's art, use edit_page; to change its script, revise_pages.

ATTACHMENTS
Images attached to the user's message are numbered "Attached image 1, 2, …" and you can see them. They are references: a person or drawing for a character (upsert_character with attachmentRefs), a look to follow (set_style with attachmentRefs), or a location (upsert_place with attachmentRefs). Do what the user says they are for; if that is unclear, ask with ask_user (for example "Is this Maya, or a style to follow?"). Also write what you see (face, hair, build, outfit, colors) into the look fields, so the identity holds even where the photo is not used.

The DOC SUMMARY below is the current truth — older messages may be out of date. Reply in the user's language.`;

// ── Doc summary ──────────────────────────────────────────────────────────────

const clip = (value: unknown, max: number): string => {
  const s = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  return s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`;
};
const upper = (s?: string) => (s || '').trim().toUpperCase() || 'UNNAMED';

const renderWord = (status: string, stale = false) => (stale ? 'out of date' : status === 'none' ? 'not drawn' : status);

/** Compact, model-facing state of the comic (≈ ≤ 3k tokens). */
export function summarizeDocForDirector(doc: ComicDoc, byok = false): string {
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
  if (b.notes.length) lines.push(`Notes:\n${b.notes.slice(-14).map((n) => `- ${clip(n, 200)}`).join('\n')}`);
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
        `- ${upper(c.name)} [${c.id}] ${c.tier}${c.role ? `, ${clip(c.role, 60)}` : ''} — ${clip(c.look.summary, 170) || '(no look yet)'}; sheet ${renderWord(c.sheet.status)}${c.refs.length ? `; ${c.refs.length} reference photo(s)` : ''}`
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
      lines.push(`- p${p.n} [${renderWord(p.render.status, isPageStale(doc, p))}${p.render.qc ? `, qc ${p.render.qc.score.toFixed(2)}` : ''}] ${clip(p.summary, 110)} (${p.panels.length} panels)`);
    }
  } else {
    lines.push('Plan: none yet');
  }
  lines.push(`Cover: ${renderWord(doc.cover.render.status)}${doc.cover.title ? ` (title “${clip(doc.cover.title, 80)}”)` : ''}`);

  const set = doc.settings;
  const { spec, resolution } = resolveImageJob('page', set.quality, set.imageModelOverride);
  lines.push(
    `Settings: ${set.quality} quality (${spec.nickname} ${resolution}, ≈ ${formatUsd(tierPagePrice(set.quality, byok))}/page); confirm ${set.confirm}${set.confirm === 'big' ? ` (above ${formatUsd(set.bigSpendUsd)})` : ''}; budget ${set.budgetUsd ? formatUsd(set.budgetUsd) : 'none'}`
  );
  lines.push(`Spend so far: ${formatUsd(doc.spend.totalUsd)}`);
  if (doc.gate?.status === 'open') lines.push(`Waiting on approval: ${clip(doc.gate.title, 80)} ≈ ${formatUsd(doc.gate.estimateUsd)} (${doc.gate.reason})`);
  const out = lines.join('\n');
  return out.length <= SUMMARY_CHAR_BUDGET ? out : `${out.slice(0, SUMMARY_CHAR_BUDGET - 1)}…`;
}

// ── Conversation window ──────────────────────────────────────────────────────

const cardText = (card: Card): string => {
  switch (card.type) {
    case 'options':
      return `[asked: ${clip(card.question, 160)} — options: ${card.choices.map((c) => clip(c.label, 40)).join(' / ')}${card.answered?.length ? `; answered: ${card.answered.join(', ')}` : ''}]`;
    case 'style_choice':
      return '[showed style options to pick from]';
    case 'cast':
      return '[showed the cast]';
    case 'plan':
      return '[showed the page plan]';
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

const messageText = (m: Msg): string => {
  const parts = [clip(m.text, 3000)];
  if (m.attachments?.length) parts.push(`[${m.attachments.length} image(s) attached]`);
  for (const card of m.cards || []) parts.push(cardText(card));
  return parts.filter(Boolean).join(' ');
};

/** The last messages as provider turns (consecutive same-role turns merged; starts with the user). */
export function conversationForDirector(conversation: Msg[], window = HISTORY_WINDOW): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const m of conversation.slice(-window)) {
    const content = messageText(m);
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

const firstSentence = (s: string) => (s.match(/^[^.!?]*[.!?]/)?.[0] || s).trim();

async function loadTurnImages(ctx: StudioContext, attachments: AssetRef[]): Promise<MessagePart[]> {
  const parts: MessagePart[] = [];
  for (const [i, a] of attachments.slice(0, MAX_TURN_IMAGES).entries()) {
    try {
      const url = await ctx.assets.loadDataUrl(a.path);
      parts.push({ type: 'text', text: `Attached image ${i + 1}:` });
      parts.push({ type: 'image_url', image_url: { url } });
    } catch (err) {
      parts.push({ type: 'text', text: `Attached image ${i + 1}: (could not be loaded)` });
      logger.warn('comic_director_image_load_failed', { projectId: ctx.projectId, path: a.path, message: (err as Error)?.message });
    }
  }
  return parts;
}

/**
 * Run one director turn for a user message. Never throws for model/tool failures — they
 * become an honest notice in the conversation; only cancellation ends it quietly.
 */
export async function runDirectorTurn(ctx: StudioContext, input: { text: string; attachments: AssetRef[] }): Promise<void> {
  const session = ctx.session;
  const userText = (input.text || '').trim();
  const attachments = (input.attachments || []).filter((a) => a?.path);
  const userMsg: Msg = {
    id: newId('msg'),
    role: 'user',
    text: userText,
    at: Date.now(),
    ...(attachments.length ? { attachments } : {})
  };
  session.commit([{ op: 'message', msg: userMsg }]);

  const msgId = newId('msg');
  const turn: DirectorTurn = createDirectorTurn({ attachments, userText });
  const tools: DirectorTool[] = buildDirectorTools(ctx, turn);
  const toolByName = new Map(tools.map((t) => [t.spec.function.name, t]));
  const tracker = newTextSpendTracker();
  const llm = billedLlm(ctx, { stage: 'chat', operation: 'comic.text.director', tracker });

  const doc = session.doc;
  const { summary: memory } = parseMemory(doc.memory);
  const system = [DIRECTOR_SYSTEM_PROMPT, summarizeDocForDirector(doc, spendIsByok(ctx.keys)), memory ? `MEMORY (older conversation):\n${clip(memory, 3000)}` : '']
    .filter(Boolean)
    .join('\n\n');
  const history = conversationForDirector(doc.conversation.filter((m) => m.id !== userMsg.id), HISTORY_WINDOW - 1);
  const images = await loadTurnImages(ctx, attachments);
  const currentText =
    (userText || (attachments.length ? '(The user sent images without a message.)' : '')) +
    (attachments.length > MAX_TURN_IMAGES ? `\n(${attachments.length} images attached; the first ${MAX_TURN_IMAGES} are shown.)` : '');
  const messages: ChatMessage[] = [
    { role: 'system', content: system },
    ...history,
    { role: 'user', content: images.length ? [{ type: 'text', text: currentText }, ...images] : currentText }
  ];
  // Providers need the conversation to open with a user turn after the system prompt.
  if (messages[1]?.role !== 'user') messages.splice(1, 0, { role: 'user', content: '(continuing)' });

  const spoken: string[] = [];
  let streamedChars = 0;
  const onDelta = (t: string) => {
    if (!t || ctx.signal.aborted) return;
    if (streamedChars === 0 && spoken.length) session.emit({ type: 'delta', msgId, text: '\n\n' });
    streamedChars += t.length;
    session.emit({ type: 'delta', msgId, text: t });
  };

  let lastToolResult = '';
  let failure: StudioError | null = null;
  let cancelled = false;
  try {
    let rounds = 0;
    for (;;) {
      const allowTools = rounds < MAX_TOOL_ROUNDS && !turn.askedUser;
      streamedChars = 0;
      const result: LlmResult = await llm.complete({
        role: 'director',
        messages,
        ...(allowTools ? { tools: tools.map((t) => t.spec) } : {}),
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
      // Sequential: every tool mutates the same doc.
      for (const call of calls) {
        const tool = toolByName.get(call.name);
        const { args, malformed } = parseArgs(call.arguments);
        let output: string;
        if (!tool) output = `Error: unknown tool "${call.name}".`;
        else if (malformed) output = `Error: the arguments for ${call.name} were not valid JSON. Re-issue the call with complete JSON.`;
        else {
          const actId = newId('act');
          const label = TOOL_ACTIVITY[call.name];
          if (label) session.emit({ type: 'activity', id: actId, label, phase: 'start' });
          output = await tool.execute(args);
          if (label) session.emit({ type: 'activity', id: actId, label, phase: 'end', ok: !output.startsWith('Error') });
        }
        if (!output.startsWith('Error')) lastToolResult = output;
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
  }

  let text = spoken.join('\n\n').trim();
  const cards = [...turn.cards];
  if (failure) cards.push(noticeCard('error', failure.userMessage));
  if (!text && !failure && !cancelled) {
    text = turn.askedUser ? '' : lastToolResult ? firstSentence(lastToolResult) : "Sorry — I didn't catch that. Could you say it another way?";
  }
  if (cancelled && !text && !cards.length) {
    recordTextSpend(ctx, tracker, 'chat', 'Director');
    return;
  }
  const final: Msg = {
    id: msgId,
    role: 'assistant',
    text: cancelled && text ? `${text} (stopped)` : text,
    at: Date.now(),
    ...(cards.length ? { cards } : {}),
    ...(!cancelled && !failure ? { suggestions: suggestNextSteps(session.doc) } : {})
  };
  session.commit([{ op: 'message', msg: final }]);
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
