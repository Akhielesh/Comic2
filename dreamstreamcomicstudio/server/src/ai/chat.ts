// AI Chat Platform — free-form multi-turn chat on any catalog model.
//
// Unlike the Universal Assistant (which is platform-scoped and locked to a free
// OpenRouter model), this powers the standalone "AI Chat Platform" product: the
// user picks any model from the catalog and chats with it directly. It reuses the
// same provider gateway, so model choice, pricing, BYOK and usage metering all
// flow through one control plane.

import type { ChatMessage } from './providers/types.js';
import type { ChatArtifact, ChatClientContext, CapabilityNotice, AgentActivityEvent } from '../../../apiTypes.js';
import { logCapabilityNotice } from './capabilities.js';
import { composePersona } from './persona.js';
import { getProvider, resolveProviderContext } from './gateway.js';
import { markModelDown, TEXT_FALLBACK } from './autoRouter.js';
import { buildUsage } from './usage.js';
import type { AIProviderId } from './providers/types.js';
import { toToolSpec, type ChatTool } from './tools/registry.js';
import { buildJsonToolSystemBlock, extractToolCall, stripToolCallJson, formatToolResult } from './tools/jsonToolProtocol.js';
import { capToolOutput, CHAT_TOOL_OUTPUT_MAX } from './tools/capToolOutput.js';
import { coerceJsonOrNull } from './jsonCoerce.js';
import { JSON_TOOL_PROTOCOL_ENABLED, CHAT_MAX_OUTPUT_TOKENS } from '../config.js';
import { buildUserMemoryBlock } from '../services/userMemory.js';
import { buildConnectorContextBlock } from '../connectors/retrieval.js';

export type ChatReasoningLevel = 'none' | 'low' | 'medium' | 'high';

/** A file the user attached to the current turn (base64 data URI). */
export interface ChatAttachmentInput {
  name: string;
  mimeType: string;
  dataUri: string;
}

export interface ChatToolEvent {
  tool: string;
  query?: string;
  ok: boolean;
  summary?: string;
}

export interface ChatToolImage {
  url: string;
  title?: string;
  thumbnail?: string;
  source?: string;
}

/**
 * Parse a tool call's raw `arguments` string defensively.
 *
 * The provider passes `arguments` through verbatim, and for streamed calls it's the
 * concatenation of streamed fragments — which the output-token budget can cut off
 * mid-JSON (the whole chart/app/UI payload rides INSIDE this string). The old
 * `try { JSON.parse } catch { {} }` silently ran the tool with NO arguments, so the tool
 * hit its own "no input" guard and returned a plausible empty result — the model then
 * saw a fake success and dead-ended ("build me a chart silently produced nothing").
 *
 * Instead: fast-path valid JSON objects, recover fenced/trailing-comma/prose-wrapped
 * JSON via the shared, tested `coerceJsonOrNull`, and report genuinely-unreadable input
 * as `malformed` so the loop can tell the model to RE-ISSUE the call rather than fake an
 * empty run. Valid-but-non-object JSON (an array/scalar) is treated as empty args, not
 * malformed — it isn't corrupt, just unusable as args.
 */
export const parseToolArguments = (
  raw: string | undefined
): { args: Record<string, unknown>; recovered: boolean; malformed: boolean } => {
  if (!raw || !raw.trim() || raw.trim() === '{}') return { args: {}, recovered: false, malformed: false };
  try {
    const p = JSON.parse(raw);
    if (p && typeof p === 'object' && !Array.isArray(p)) return { args: p as Record<string, unknown>, recovered: false, malformed: false };
    // Valid JSON but not an object (array/scalar) — use empty args, don't flag a retry.
    return { args: {}, recovered: false, malformed: false };
  } catch {
    /* not valid JSON — fall through to recovery */
  }
  const c = coerceJsonOrNull(raw);
  if (c && typeof c === 'object' && !Array.isArray(c)) return { args: c as Record<string, unknown>, recovered: true, malformed: false };
  // Genuinely unreadable (truncated mid-JSON / garbage) — surface it so the model retries.
  return { args: {}, recovered: false, malformed: true };
};

/** Max model⇄tool round-trips before we force a final answer. Each round can fire
 *  several tools in parallel, so this bounds *rounds*, not total tool calls. Set to 9
 *  (up from 6) so deeper multi-source research — search → read several → fetch quotes →
 *  news → synthesize — finishes instead of truncating; the model still stops early when
 *  done, so typical turns are unaffected. */
const MAX_TOOL_ITERATIONS = 9;

export interface RunChatParams {
  provider: AIProviderId;
  /** Resolved key for the chosen provider (BYOK header or platform env). */
  apiKey: string;
  model: string;
  /** Already-mapped conversation turns (user/assistant), most recent last. */
  messages: ChatMessage[];
  systemPrompt?: string;
  /**
   * Replace the default DreamStream persona entirely (e.g. utility calls like the
   * prompt enhancer that must return raw text, not richly-formatted Markdown).
   */
  systemOverride?: string;
  temperature?: number;
  maxTokens?: number;
  reasoningLevel?: ChatReasoningLevel;
  webSearch?: boolean;
  fallbackModel?: string;
  /** Ordered fallback chain (≤3) → OpenRouter routes past dead/rate-limited models. */
  fallbackModels?: string[];
  timeoutMs?: number;
  /**
   * Pre-sanitized DreamStream workspace context (JSON string). Present only when the
   * user enabled the DreamStream connector for the session. Injected as a guardrailed
   * block so the model can help with the user's own projects but can't act or leak.
   */
  dreamstreamContextJson?: string;
  /**
   * Authenticated user id + explicit opt-in for cross-product memory (RAG).
   * When both are set, durable user memories are retrieved (vector → FTS →
   * recency) and injected as a system block BEFORE the model call — for ANY
   * provider/model, so context follows the user across Chat Studio, Code
   * Studio and Comic Studio. Utility/sub-agent calls must NOT opt in (cost,
   * and the memory distiller itself would recurse).
   */
  userId?: string;
  userMemory?: boolean;
  /**
   * Explicit opt-in to inject RAG context from the user's connected ACCOUNT
   * connectors (Gmail/Drive/Calendar/…). When set with userId, the top matching
   * normalized items are retrieved (scoped to the user) and injected as a system
   * block — same fail-open, time-boxed pattern as userMemory.
   */
  connectorContext?: boolean;
  /** Agentic tools the model may call (DuckDuckGo, etc.). OpenRouter only. */
  tools?: ChatTool[];
  /** Runtime situational context (date/timezone/locale/units/location). */
  clientContext?: ChatClientContext;
  /**
   * Files attached to the CURRENT user turn. Images already ride along as image
   * parts in the message (vision); these are surfaced to the model as a manifest +
   * inlined text so it can actually READ and reference them instead of claiming it
   * "can't open the file". Heavy/binary processing still flows through run_python.
   */
  attachments?: ChatAttachmentInput[];
  /** Abort signal for in-flight tool calls. */
  signal?: AbortSignal;
  /** When set, stream content/reasoning deltas as they arrive (SSE). */
  onDelta?: (delta: { content?: string; reasoning?: string }) => void;
  /**
   * Called before a follow-up model turn (after tools ran) so the client can DISCARD
   * the prior turn's streamed pre-tool narration — otherwise the model's "let me look
   * that up…" preamble bleeds into the final answer on screen, then snaps away on
   * finalize. Lets the live view match the saved answer.
   */
  onReset?: () => void;
  /**
   * Live per-tool activity for the DEFAULT chat loop, streamed step-by-step so the
   * client can show the agent working (search → read → fetch → synthesize) during the
   * long tool-grounded window before any answer streams. `start` fires when a tool
   * begins, `end` when it settles. No-op when the turn runs no tools — so plain chat is
   * completely unaffected.
   */
  onToolEvent?: (event: AgentActivityEvent) => void;
}

// Guardrail framing for the DreamStream connector. The context is read-only and
// already allowlist-sanitized server-side; the model may discuss/assist with it but
// has no tools to modify the workspace and must never expose secrets or other users' data.
const dreamstreamBlock = (json: string): string => `

DreamStream workspace access is ENABLED for this conversation. You are operating inside the DreamStream Comic Studio product and may use the sanitized context below to help the user with their own projects, account and usage.
Guardrails:
- Only reference the user's own data shown in the context. Never claim access to other users' data.
- Never reveal or request secrets (API keys, tokens, passwords).
- This access is read-only — you cannot create, edit, generate or delete anything; if the user asks you to act, explain how to do it in the app instead.
- If something isn't present in the context, say you don't have it rather than guessing or fabricating project details.

Sanitized DreamStream context (JSON):
${json}`;

// Default persona. Heavy emphasis on well-structured, component-friendly Markdown so
// the client's rich renderer can surface tables, code, links, images and lists cleanly.
// The chat-specific behavior below is LAYERED on the shared brand persona
// (server/src/ai/persona.ts) so chat speaks in the same voice as the swarm, the
// Universal Assistant and the studio build agent — one identity, one honesty contract.
const CHAT_BEHAVIOR = `You are operating as DreamStream Chat: live internet access and a suite of real-data tools are available to you.

CORE BEHAVIOR — read carefully:
- Be CONCISE and direct. Lead with the answer in the first sentence. Do NOT bombard the user with long preambles, caveats, or filler. Match the length of the answer to the question — short questions get short answers.
- CALIBRATE to the question type and the user's apparent level. A quick factual question gets a tight, sourced answer; a "how/why" or learning question gets a clear, structured explanation (and, when they're studying, proactively offer a quiz, flashcards, a downloadable guide, or a runnable playground); a complex analytical ask gets real reasoning and structure; a casual aside gets a casual reply. Don't over-engineer simple questions or under-serve hard ones. Infer the user's level and intent only from the conversation itself — never assume facts about them (job, years of experience, age, situation) that the conversation doesn't actually support.
- No padding. Do NOT add empty/"TBD"/"not retrieved" table rows, generic disclaimers, or suggestions to "check a real-time source", "open a terminal", or visit another site — you have live tools, so either use them or, if one genuinely failed, say so in one short line and move on. For news, give 2–4 sharp takeaways in your own words; don't re-list every headline, since the news card already shows the list.
- Be ACCURATE. For anything factual, current, numeric, or that you're not 100% sure of, CALL A TOOL and answer from the result. Never guess at facts you can verify. If you still don't know, say so plainly.
- NEVER fabricate. If a search/tool returns nothing useful, do NOT invent facts, prices, specs, dates, or links, and do NOT emit a table full of "TBD"/placeholder cells. Say clearly what you could not find, then answer from your own knowledge with an explicit caveat that it isn't from a live source and may be outdated.
- When a tool returns a CARD/visual (weather, news, stock/crypto, map, places, video, images), the card already shows the raw numbers — so don't restate them. Instead add a brief but genuinely insightful read of what they mean and what's notable (a few sentences), never a bare one-liner.
- Let the data and visuals do the work: cards, tables and images are complementary information that help the user faster than paragraphs.

Formatting (use only what helps — never pad):
- GitHub-Flavored Markdown. Use **tables** to compare options or list structured attributes; bullet lists for sets of items; short paragraphs otherwise.
- Fenced code blocks with a language tag for code/config/commands; one block per file, first line a comment naming the file (e.g. \`// src/app.ts\`).
- Markdown links [label](url) for sources; images ![alt](url) only with a real image URL; \`inline code\` for identifiers; \`$...$\` for math when helpful.

Prefer signal over length. A tight, sourced, well-structured answer beats a long one.`;

export const CHAT_SYSTEM_PROMPT = composePersona(CHAT_BEHAVIOR);

// Study / exam-prep intent. When a real chat turn looks like learning or test prep, we
// layer on EXAM/STUDY guidance so the answer carries genuine exam-ready DEPTH and routes
// the user into practice — a direct response to "need more in-depth information to
// prepare for exam" feedback. Kept deliberately specific so it doesn't fire on casual
// "what is X" asks.
const EXAM_STUDY_INTENT =
  /\b(exam|midterm|final exam|finals|test prep|quiz me|interview prep|study(ing)?|revis(e|ing|ion)|prepare for (?:my|the|an|a)|cram|memoriz|memoris|teach me|help me (?:learn|study|understand|prepare|revise)|for (?:my|the|an|a) (?:exam|test|quiz|midterm|final|interview|class|course)|practice (?:problems|questions))\b/i;

export const isStudyIntent = (text: string): boolean => Boolean(text) && EXAM_STUDY_INTENT.test(text);

// Trip-planning intent. When a turn looks like travel planning, layer on guidance that
// keeps the answer a SEAMLESS plan instead of a scroll wall: clarify first, consolidate
// everything onto ONE categorized map + the itinerary widget, honor the user's chosen
// transport mode, and never spam a failing tool.
const TRIP_INTENT =
  /\b(plan (?:a|my|the|our) (?:trip|vacation|holiday|getaway|weekend)|trip to|itinerary|travel(?:ing|ling)? to|visit(?:ing)? [A-Z]|day trip|road trip|weekend in|flights? to|fly(?:ing)? to)\b/i;

export const isTripIntent = (text: string): boolean => Boolean(text) && TRIP_INTENT.test(text);

export const tripGuidanceBlock = (lastUserText: string): string => {
  if (!lastUserText || !TRIP_INTENT.test(lastUserText)) return '';
  return `\n\nTRIP PLANNING MODE — make the plan feel SEAMLESS, not a scroll wall:
- If key details are missing (dates, transport preference, lodging style, interests, budget), use ask_user ONCE with 2–4 focused questions before building the plan. Honor every answer — especially the chosen transport mode — in everything that follows.
- Consolidate: ONE plan_trip itinerary (with transport legs + lat/lng so stops are mapped) and AT MOST ONE places list (the single most useful category). Do NOT emit a separate map per category — the itinerary's map carries hotels/food/sights together via stop kinds.
- Keep prose SHORT: a 2–3 sentence overview and a tight budget line. The widgets carry the detail; never restate their contents as text, and never paste long numbered lists of places into prose.
- Mark each stop with its kind (flight/train/car/ferry/hotel/food/sight/…) so maps draw category icons, and include the transport legs with from/to and times.
- COMPOSE the plan from the travel widgets, only the ones that fit, roughly in this order: plan_trip (the day-by-day itinerary — ALWAYS), then render_packing_list (grouped from the destination weather + trip length + activities), render_trip_budget (categories that match the plan: flights, lodging, food, activities, local transport). Add render_trip_countdown ONLY with a concrete departure date, render_world_clocks ONLY when home and destination are in different time zones, and render_cheatsheet ONLY for a foreign destination (customs, plugs, key phrases). Emit render_boarding_pass ONLY when the user shares an actual booked flight/confirmation. A typical "5 days in Tokyo" = ONE itinerary + ONE packing list + ONE budget (+ world clocks if abroad) — purpose-built widgets that tell the story, never a wall of generic text.
- STAY ON TRIP-RELEVANT TOOLS: do NOT call get_stock, compare_stocks, build_portfolio, crypto_price, build_finance_terminal, get_news or other finance/market tools for a trip — they are irrelevant here. Use only plan_trip, find_places, get_weather, get_directions, get_flight_status and the render_* travel widgets.
- If a tool fails (e.g. place search unavailable), do NOT retry it more than once or call it for more categories — fold what you have into the plan and note the gap in ONE short line.`;
};

export const studyGuidanceBlock = (lastUserText: string): string => {
  if (!lastUserText || !EXAM_STUDY_INTENT.test(lastUserText)) return '';
  return `\n\nEXAM / STUDY MODE — the user is learning or preparing for a test. Give genuinely exam-ready DEPTH, not a shallow summary:
- Explain the CORE concepts clearly, then the key details, definitions and formulas they'd actually be tested on.
- Call out the common pitfalls, misconceptions, and the fine distinctions examiners probe.
- Include at least one concrete worked example or application when it aids understanding.
- For VISUAL concepts (anatomy, diagrams, geometry, processes), pull a relevant image to anchor understanding.
- Then help them PRACTICE: proactively offer or build a quick quiz, flashcards, a runnable code/SQL exercise, a downloadable study guide, or a complete study pack (guide + practice + flashcards bundled as a downloadable .zip) so they can drill it (use the learning tools when available).
- Stay accurate and grounded — verify facts you're unsure of rather than guessing. Calibrate the rigor to the level implied by the question; don't assume background the conversation doesn't support.`;
};

// Render the user's runtime context as a compact, authoritative block so the model
// stops being "situationally blind": it knows the real current date/time, the
// timezone, the locale, the unit system, and (when granted) the coarse location.
// This is what makes "today", "latest news", "weather", and "near me" resolve
// correctly instead of guessing or defaulting to stale/foreign assumptions.
export const buildContextBlock = (ctx?: ChatClientContext): string => {
  if (!ctx) return '';
  const lines: string[] = [];
  // Always anchor "now" — prefer the client's wall clock, fall back to server time.
  const now = ctx.now && !Number.isNaN(Date.parse(ctx.now)) ? new Date(ctx.now) : new Date();
  lines.push(`- Current date & time: ${now.toUTCString()} (UTC)`);
  if (ctx.timezone) lines.push(`- User timezone: ${ctx.timezone}`);
  if (ctx.locale) lines.push(`- User locale: ${ctx.locale}`);
  if (ctx.units) lines.push(`- Preferred units: ${ctx.units} (use ${ctx.units === 'imperial' ? '°F, miles' : '°C, km'} by default)`);
  if (ctx.location) {
    const loc = [ctx.location.city, ctx.location.region, ctx.location.country].filter(Boolean).join(', ');
    const coords =
      typeof ctx.location.lat === 'number' && typeof ctx.location.lng === 'number'
        ? ` (~${ctx.location.lat.toFixed(2)}, ${ctx.location.lng.toFixed(2)})`
        : '';
    if (loc || coords) lines.push(`- Approximate user location: ${loc}${coords}`);
  }
  if (!lines.length) return '';
  return `\n\nUSER CONTEXT (authoritative — use it, do not ask for what's already here):
${lines.join('\n')}
- When the user says "today", "now", "latest", "near me", "my area", or omits a place/date, resolve it from this context.
- Report measurements in the user's preferred units. Do not claim you don't know the date or the user's general location — it is given above.`;
};

// How much of each attached text/data file we inline into the system prompt so the
// model can READ it directly, and the total budget across all files. Beyond this the
// model is pointed at run_python to stream the rest from /input/<name>.
const ATTACH_PER_FILE_CHARS = 8_000;
const ATTACH_TOTAL_CHARS = 24_000;

const isTextLikeAttachment = (mimeType: string, name: string): boolean =>
  /^text\//i.test(mimeType) ||
  /^application\/(json|xml|csv|x-ndjson|x-yaml|yaml|x-www-form-urlencoded)/i.test(mimeType) ||
  /\.(csv|tsv|json|ndjson|txt|md|markdown|log|xml|yaml|yml|ini|toml|tex)$/i.test(name);

// Decode a base64 (or percent-encoded) data URI into UTF-8 text. Returns null when the
// input isn't a data URI we can read. FileReader.readAsDataURL always emits base64.
const decodeTextDataUri = (dataUri: string): string | null => {
  const m = /^data:([^;,]*)((?:;[^,]*)*),(.*)$/s.exec(dataUri);
  if (!m) return null;
  try {
    const params = m[2] || '';
    const payload = m[3] ?? '';
    return /;base64/i.test(params)
      ? Buffer.from(payload, 'base64').toString('utf8')
      : decodeURIComponent(payload);
  } catch {
    return null;
  }
};

// Rough decoded byte size of a data URI, for a human-readable size hint only.
const approxAttachmentBytes = (dataUri: string): number => {
  const comma = dataUri.indexOf(',');
  const payload = comma >= 0 ? dataUri.slice(comma + 1) : dataUri;
  return /;base64/i.test(dataUri.slice(0, comma >= 0 ? comma : 0))
    ? Math.floor((payload.length * 3) / 4)
    : payload.length;
};

const humanBytes = (bytes: number): string =>
  bytes >= 1_000_000 ? `${(bytes / 1_000_000).toFixed(1)} MB` : bytes >= 1_000 ? `${Math.round(bytes / 1_000)} KB` : `${bytes} B`;

// Surface the user's attached files to the model. Without this the model was never
// even TOLD a file was attached (non-image files only reached the run_python sandbox),
// so it would insist it "can't access the attachment". Here we hand it a manifest plus
// the inlined text of any text/data files, and point it at run_python for the rest.
export const buildAttachmentsBlock = (
  attachments?: ChatAttachmentInput[],
  opts?: { canRunPython?: boolean }
): string => {
  if (!attachments || attachments.length === 0) return '';
  const canRunPython = opts?.canRunPython !== false;
  const manifest: string[] = [];
  const inlined: string[] = [];
  let budget = ATTACH_TOTAL_CHARS;

  for (const att of attachments) {
    if (!att || typeof att.name !== 'string' || typeof att.dataUri !== 'string') continue;
    const size = humanBytes(approxAttachmentBytes(att.dataUri));
    const mime = att.mimeType || 'application/octet-stream';

    if (/^image\//i.test(mime)) {
      manifest.push(`- ${att.name} (${mime}, ${size}) — provided to you as an image in this message; look at it directly to describe/analyze/extract from it.`);
      continue;
    }

    if (isTextLikeAttachment(mime, att.name) && budget > 0) {
      const text = decodeTextDataUri(att.dataUri);
      if (text != null) {
        const slice = text.slice(0, Math.min(ATTACH_PER_FILE_CHARS, budget));
        budget -= slice.length;
        const truncatedNote = slice.length < text.length ? `\n…(truncated — the full file is available to run_python at /input/${att.name})` : '';
        manifest.push(`- ${att.name} (${mime}, ${size}) — contents included below.`);
        inlined.push(`--- ${att.name} ---\n${slice}${truncatedNote}`);
        continue;
      }
    }

    manifest.push(
      canRunPython
        ? `- ${att.name} (${mime}, ${size}) — binary/large file; read or process it by writing code with the run_python tool (mounted read-only at /input/${att.name}).`
        : `- ${att.name} (${mime}, ${size}) — binary file; its contents can't be inlined here.`
    );
  }

  if (!manifest.length) return '';

  let block = `\n\nATTACHED FILES — the user attached the following file(s) to THIS message. You CAN access them. NEVER tell the user you can't open, read, or reference an attachment.
${manifest.join('\n')}`;
  if (inlined.length) {
    block += `\n\nAttached file contents:\n${inlined.join('\n\n')}`;
  }
  block += canRunPython
    ? `\n\nUse these files to answer. For analysis, conversion, parsing, or any processing beyond the text shown above, write Python with the run_python tool — the files are mounted read-only at /input/<name>.`
    : `\n\nUse the file contents shown above to answer.`;
  return block;
};

// A clearly trivial / conversational message that needs no live web grounding:
// greetings, thanks, acknowledgements, or a bare arithmetic ask. Used to skip the
// always-on web plugin (which fires a search round-trip on EVERY message) for inputs
// like "hi"/"thanks"/"2+2" — the single biggest reason the SIMPLEST chats felt slow.
// The model still keeps the web_search TOOL, so a real question grounds the instant it
// needs to; we're only dropping the reflexive search on inputs that can't benefit.
const TRIVIAL_CHAT_RE =
  /^(?:hi+|hey+|hello+|yo|sup|hiya|howdy|gm|gn|good (?:morning|afternoon|evening|night)|thanks?|thank you|thank you so much|thx|ty|tysm|ok(?:ay)?|k|cool|nice|great|awesome|perfect|got it|gotcha|sounds good|understood|lol|haha|hehe|np|no problem|yw|you're welcome|please|yes|no|yep|yup|nope|nah|sure|right|bye|goodbye|see ya|cya|later|cheers)[\s!.?,]*$/i;
const PURE_ARITHMETIC_RE = /^[\d\s().,+\-*/×÷%^]+\??$/;
const ARITHMETIC_ASK_RE = /^(?:what(?:'s| is| are)?|calc(?:ulate)?|compute|solve|how much is)\s+[\d\s().,+\-*/×÷%^]+\s*\??$/i;

export const isTrivialChat = (text: string): boolean => {
  const t = (text || '').trim();
  if (!t) return true;
  if (t.length <= 80 && TRIVIAL_CHAT_RE.test(t)) return true;
  if (t.length <= 40 && PURE_ARITHMETIC_RE.test(t)) return true;
  if (t.length <= 60 && ARITHMETIC_ASK_RE.test(t)) return true;
  return false;
};

// Output-token budget for a chat answer. The old flat 2048 cap truncated long answers and —
// worse — cut off generate_app/render_chart tool-call arguments mid-JSON (the entire app or
// chart rides inside those arguments), so "build me an app/chart" silently produced nothing.
// OpenRouter (the tool-calling path) gets the full budget; reasoning models get extra headroom
// because the hidden reasoning trace is billed against the same completion budget. NVIDIA NIMs
// are text-only (no tool calls) and some cap completion lower, so they stay conservative.
const answerTokenBudget = (provider: AIProviderId, level?: ChatReasoningLevel): number => {
  const reasoningHeadroom =
    provider === 'openrouter'
      ? level === 'high'
        ? 4096
        : level === 'medium'
          ? 3072
          : level === 'low'
            ? 2048
            : 0
      : 0;
  const base = provider === 'openrouter' ? CHAT_MAX_OUTPUT_TOKENS : Math.min(CHAT_MAX_OUTPUT_TOKENS, 4096);
  return base + reasoningHeadroom;
};

const dedupeCitations = (citations: { url: string; title?: string }[]) => {
  const seen = new Set<string>();
  const out: { url: string; title?: string }[] = [];
  for (const c of citations) {
    if (!c.url || seen.has(c.url)) continue;
    seen.add(c.url);
    out.push(c);
  }
  return out;
};

export const runChat = async (
  params: RunChatParams
): Promise<{
  text: string;
  usage: ReturnType<typeof buildUsage>;
  model: string;
  reasoning?: string;
  citations?: { url: string; title?: string }[];
  toolEvents?: ChatToolEvent[];
  images?: ChatToolImage[];
  artifacts?: ChatArtifact[];
  notices?: CapabilityNotice[];
}> => {
  // A custom persona / durable user memory augments the rich-format base prompt
  // rather than replacing it, so structured-Markdown rules always hold.
  const base = params.systemOverride ?? CHAT_SYSTEM_PROMPT;
  const extra = params.systemPrompt?.trim();
  let systemContent = extra ? `${base}\n\nAdditional instructions:\n${extra}` : base;
  systemContent += buildContextBlock(params.clientContext);
  // Cross-product user memory: retrieved fresh per request and injected as plain
  // text, so it works identically for every provider and model. Time-boxed so a
  // slow lookup can never stall the chat; failures simply mean "no memory".
  if (params.userId && params.userMemory) {
    const lastUser = [...params.messages].reverse().find((m) => m.role === 'user');
    const memoryQuery =
      typeof lastUser?.content === 'string'
        ? lastUser.content
        : Array.isArray(lastUser?.content)
          ? lastUser!.content.map((p) => ('text' in p ? p.text : '')).join(' ')
          : '';
    const memoryBlock = await Promise.race([
      buildUserMemoryBlock(params.userId, memoryQuery).catch(() => null),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 2_500))
    ]);
    if (memoryBlock) systemContent += memoryBlock;
  }
  // RAG over the user's connected ACCOUNT connectors (Gmail/Drive/…). Same fail-open,
  // time-boxed contract as memory: a slow or failing lookup just means "no connector context".
  if (params.userId && params.connectorContext) {
    const lastUser = [...params.messages].reverse().find((m) => m.role === 'user');
    const connectorQuery =
      typeof lastUser?.content === 'string'
        ? lastUser.content
        : Array.isArray(lastUser?.content)
          ? lastUser!.content.map((p) => ('text' in p ? p.text : '')).join(' ')
          : '';
    const connectorBlock = await Promise.race([
      buildConnectorContextBlock(params.userId, connectorQuery).catch(() => null),
      new Promise<string | null>((resolve) => setTimeout(() => resolve(null), 2_500))
    ]);
    if (connectorBlock) systemContent += connectorBlock;
  }
  if (params.dreamstreamContextJson) {
    systemContent += dreamstreamBlock(params.dreamstreamContextJson);
  }
  // Make the user's attached files visible to the model (manifest + inlined text), so it
  // can actually read/reference them instead of claiming it can't open the attachment.
  if (params.attachments?.length) {
    const canRunPython = (params.tools || []).some((t) => t.name === 'run_python');
    systemContent += buildAttachmentsBlock(params.attachments, { canRunPython });
  }
  // When tools are available this turn, make it explicit the model HAS live web access —
  // otherwise weak models default to "I can't browse" even while results are fetched.
  const hasTools = params.provider === 'openrouter' && (params.tools?.length || 0) > 0;
  if (hasTools) {
    const names = (params.tools || []).map((t) => t.name).join(', ');
    systemContent += `\n\nLIVE TOOLS ARE ENABLED this turn (${names}). You DO have internet access through them — this is your primary way to be accurate.
- NEVER say you can't browse, access the internet, or fetch real-time/current data. Instead, CALL the relevant tool, then answer from what it returns.
- Default to calling a tool whenever the answer depends on current, factual, numeric, local, or post-training information — don't answer from memory and don't ask the user to look it up.
- Pick the RIGHT tool: get_news for news/headlines/"latest"; get_weather for weather; find_places to DISCOVER nearby places ("near me", restaurants, hotels, shops); show_map for a SPECIFIC place/route; get_stock for equities/indices and crypto_price for coins; wiki_lookup for background on a topic/person; the specialized tools (country_info, define_word, find_recipe, github_repo, etc.) when they fit; web_search for everything else. You may call several tools in one turn, and CHAIN them when it helps (e.g. a company quote plus its recent news).
- CRITICAL: if a tool or web search returned ANY results/snippets/sources, you MUST synthesize an answer from them and cite the sources. NEVER reply "I couldn't retrieve" or "found nothing" when results/citations are present.
- If a tool returns empty, do NOT call the SAME tool again with a slightly reworded query (it will keep returning nothing) — switch to a DIFFERENT tool (e.g. wiki_lookup, get_news) or answer from your own knowledge with a clear caveat. A couple of empty searches is enough; pivot rather than looping.
- HONESTY ON FAILURE: if a tool reports it FAILED or is UNAVAILABLE (not merely empty), tell the user in one short line that you could not reach live data right now, and only then fall back to your own knowledge WITH an explicit "not from a live source" caveat. Do not present memory as if you had just verified it live.
- RECOVER, don't dead-end: when get_stock / crypto_price fails for a ticker (common for a BRAND-NEW IPO not yet on the price feeds, or a thin/obscure listing), do NOT leave the user with only an error — pivot in the SAME turn to get_news and/or web_search on the company/ticker so they still get real, current information (the listing, what it does, the IPO price/range, recent coverage). One failed quote should still yield a useful, sourced answer, not just "unavailable".
- When a tool result renders as a CARD (stock, weather, news, crypto, map, places), the card already shows the raw numbers — so DON'T restate them. Instead add a brief but genuinely insightful READ: for a stock, where the price sits in its 52-week range, recent momentum, valuation (P/E) and anything notable from the headlines or peers; for weather, what to actually expect/plan. Aim for 2-4 crisp, insightful sentences — never a bare one-liner, and never a long data dump.
- Use render_chart / show_metrics / render_table / render_heatmap to visualize any data you gather or compute, and build_finance_terminal for a live markets dashboard (focus quote + indices + watchlist + heatmap + news) when the user wants an overview/watchlist/multiple tickers.
- BUILD A CUSTOM WIDGET when no fixed card fits but the answer is structured — a comparison, a mini-dashboard, a step-by-step breakdown, a "summary with sections + metrics + an embedded chart + a callout". Call render_ui to compose a BESPOKE card from stack/row/grid/section containers with heading, text, keyValue, metric, badge, pill, callout, progress, sparkline, chart and table blocks, instead of writing a wall of prose or a plain markdown list. Default to a polished visual card whenever it would communicate better than paragraphs — that is the whole point of this surface; don't fall back to generic text when a tailored widget is one tool call away. And when the user wants something GENUINELY CUSTOM that the block kit can't express — a small interactive tool, calculator, simulator, game or novel visualization — write a real self-contained React component and emit it with render_react (it runs sandboxed). Reach for render_react only for true custom interactivity; render_ui/render_chart/render_table remain the default for standard data displays. If a COMPONENT MCP is connected (its tools show up as mcp_magic_* / mcp_magicui_* / mcp_shadcn_*), you may call it to generate or fetch a component, then pass the resulting TSX to render_react to display it sandboxed.
- VISUALS ARE DECOUPLED FROM DATA — a chart, table or metric board can render ANY dataset, not just one domain. Pick the visual that fits the SHAPE of the data (a trend → line/area chart; categories → bars; parts of a whole → pie/donut; rows of items → table; KPIs → metric board; places → map), then feed it whatever you gathered or computed — render_chart / render_table / show_metrics / render_heatmap take ARBITRARY data. If NO tool supplies the data the user wants, SOURCE IT YOURSELF (web_search, read pages, analyze_data, or compute it) and still draw the visual; if even the right VISUAL doesn't exist, build a custom one with render_react and source its data as best you can. Never refuse a visualization for lack of a built-in feed — gather or derive the data and render it.
- For COMPARISONS / "X vs Y" across assets (e.g. "compare gold, oil and the S&P", "NVDA vs AMD vs Intel", "metals vs the dollar"), prefer compare_stocks — it overlays 2–6 assets on ONE chart with % rebasing (so very different price scales are comparable), a 1D…MAX range timeline and a legend that toggles each line. That is the right tool whenever the user wants to compare/contrast TRENDS. Use get_stock per asset only when they want each one IN DEPTH (full stats/peers/news) rather than an overlay; both tools cover stocks, ETFs, indices, commodities (gold/oil/silver/copper/gas), FX and crypto. When you do emit several cards in one turn they ride a swipeable gallery, not a tall stack — so include the few that genuinely add value. For non-market datasets you compute yourself, use render_chart.
- LIVE NUMBERS, NOT MEMORY: render_table / render_heatmap only DRAW the values you pass — they do not fetch. NEVER type stock/crypto prices, %s, market caps or other live figures into them (or into prose) from memory; fetch them first with get_stock / crypto_price / build_finance_terminal. A polished table of made-up numbers is a serious error. And on a FOLLOW-UP about a price you mentioned earlier, RE-FETCH it — do not reuse the earlier number, it has moved. Only discuss the tickers the user asked about; don't default to Apple/Tesla/Microsoft.`;
  }

  // JSON tool-protocol fallback (Phase 10): non-OpenRouter providers have no native
  // function-calling, so when enabled we teach the model to call tools via a JSON
  // convention injected into the system prompt and run a text-driven tool loop below.
  const useJsonTools =
    params.provider !== 'openrouter' && JSON_TOOL_PROTOCOL_ENABLED && (params.tools?.length || 0) > 0;
  if (useJsonTools) {
    systemContent += `\n\n${buildJsonToolSystemBlock(params.tools as ChatTool[])}`;
  }

  // Exam/study depth guidance — only on real chat turns (utility/sub-agent calls use a
  // systemOverride and must stay unflavored). Looks at the latest user message.
  if (!params.systemOverride) {
    const lastUser = [...params.messages].reverse().find((m) => m.role === 'user');
    const lastUserText =
      typeof lastUser?.content === 'string'
        ? lastUser.content
        : Array.isArray(lastUser?.content)
          ? lastUser!.content.map((p) => ('text' in p ? p.text : '')).join(' ')
          : '';
    systemContent += studyGuidanceBlock(lastUserText);
    systemContent += tripGuidanceBlock(lastUserText);
  }

  const messages: ChatMessage[] = [{ role: 'system', content: systemContent }, ...params.messages];

  const useReasoning =
    params.provider === 'openrouter' && params.reasoningLevel && params.reasoningLevel !== 'none';
  const useWeb = params.provider === 'openrouter' && Boolean(params.webSearch);
  // Native tools are OpenRouter-only (function-calling + tool_calls parsing); other
  // providers reach the same tools through the JSON protocol when it's enabled.
  const tools = params.provider === 'openrouter' ? params.tools || [] : useJsonTools ? params.tools || [] : [];
  const toolSpecs = params.provider === 'openrouter' && tools.length ? tools.map(toToolSpec) : undefined;

  const ctx = resolveProviderContext(params.apiKey, params.provider);
  const baseReq = {
    model: params.model,
    temperature: typeof params.temperature === 'number' ? params.temperature : 0.7,
    maxTokens: params.maxTokens ?? answerTokenBudget(params.provider, params.reasoningLevel),
    timeoutMs: params.timeoutMs,
    retries: 2,
    fallbackModel: params.fallbackModel,
    ...(params.provider === 'openrouter' && params.fallbackModels?.length ? { models: params.fallbackModels } : {}),
    ...(useReasoning ? { reasoningEffort: params.reasoningLevel as 'low' | 'medium' | 'high' } : {}),
    ...(useWeb ? { webSearch: true } : {})
  };

  const toolEvents: ChatToolEvent[] = [];
  const images: ChatToolImage[] = [];
  const citations: { url: string; title?: string }[] = [];
  const artifacts: ChatArtifact[] = [];
  const notices: CapabilityNotice[] = [];
  const addNotice = (n: CapabilityNotice) => {
    notices.push(n);
    logCapabilityNotice(n);
  };

  // One model call — streamed when a delta callback is provided and the provider
  // supports it (intermediate tool-call turns emit no content, so streaming the final
  // answer "just works"); otherwise a normal request.
  const provider = getProvider(params.provider);
  // Track whether any content/reasoning has streamed yet. If a slow model times out
  // BEFORE producing any output (the common free-tier "queued for 90s" case), we can
  // safely retry on a fast model without the client seeing duplicate text.
  let streamedAny = false;
  const trackedOnDelta = params.onDelta
    ? (d: { content?: string; reasoning?: string }) => {
        if (d.content || d.reasoning) streamedAny = true;
        params.onDelta!(d);
      }
    : undefined;
  // Huge :free models (550B-class reasoners) routinely sit QUEUED for the whole 90s
  // budget on the free tier. Give them a shorter first-attempt deadline so the
  // timeout-fallback below fires while the user is still waiting, not after.
  const paramCountB = (() => {
    const m = /(\d+(?:\.\d+)?)\s*b\b/i.exec(params.model);
    return m ? Number(m[1]) : 0;
  })();
  const timeoutProne = params.provider === 'openrouter' && /:free$/i.test(params.model) && paramCountB >= 200;
  const firstAttemptTimeoutMs =
    timeoutProne && params.timeoutMs ? Math.min(45_000, params.timeoutMs) : params.timeoutMs;

  const callModel = (msgs: ChatMessage[], withTools: boolean, modelOverride?: string) => {
    const r = {
      ...baseReq,
      messages: msgs,
      timeoutMs: modelOverride ? params.timeoutMs : firstAttemptTimeoutMs,
      ...(withTools && toolSpecs ? { tools: toolSpecs } : {}),
      // On a timeout-triggered retry, pin a single fast model and drop reasoning so the
      // reply actually fits the budget (no `models` chain, no reasoning effort).
      ...(modelOverride ? { model: modelOverride, models: undefined, reasoningEffort: undefined } : {})
    };
    return trackedOnDelta && provider.generateTextStream
      ? provider.generateTextStream(r, ctx, trackedOnDelta)
      : provider.generateText(r, ctx);
  };

  // OpenRouter only: when the chosen model is merely SLOW (not erroring), OpenRouter's
  // server-side `models` fallback never triggers — our AbortController fires at timeoutMs
  // and the whole turn fails with MODEL_TIMEOUT (the dominant production chat error: a
  // 550B :free reasoner queued for minutes). The honest recovery is exactly what the error
  // tells the user to do ("pick a faster model") — so do it for them: retry once on the
  // fast fallback, mark the slow model down so Auto skips it, and surface a notice.
  const isTimeoutError = (e: unknown): boolean =>
    (e as { publicCode?: string })?.publicCode === 'MODEL_TIMEOUT' ||
    /timed out|took too long/i.test(String((e as Error)?.message || ''));
  const callModelResilient = async (msgs: ChatMessage[], withTools: boolean) => {
    try {
      return await callModel(msgs, withTools);
    } catch (err) {
      const canFallback =
        params.provider === 'openrouter' &&
        isTimeoutError(err) &&
        params.model !== TEXT_FALLBACK &&
        !streamedAny;
      if (!canFallback) throw err;
      markModelDown(params.model);
      addNotice({
        tool: 'agent',
        level: 'warn',
        message: `Your selected model (${params.model}) was too slow and timed out, so this reply used a faster model (${TEXT_FALLBACK}). Pick a faster model in the switcher to avoid this.`
      });
      return await callModel(msgs, withTools, TEXT_FALLBACK);
    }
  };

  const lastUserSeed = (): string => {
    const m = [...params.messages].reverse().find((x) => x.role === 'user');
    return typeof m?.content === 'string'
      ? m.content
      : Array.isArray(m?.content)
        ? m!.content.map((p) => ('text' in p ? p.text : '')).join(' ')
        : '';
  };

  // --- JSON tool-protocol loop (non-OpenRouter providers) -------------------------
  // Mirrors the native loop below, but the model signals tool calls as JSON text rather
  // than `tool_calls`. Kept as a self-contained branch so the native path is untouched.
  if (useJsonTools) {
    const convo: ChatMessage[] = [...messages];
    let final = '';
    let lastModel = params.model;
    for (let i = 0; i <= MAX_TOOL_ITERATIONS; i += 1) {
      const r = await provider.generateText({ ...baseReq, messages: convo }, ctx);
      lastModel = r.model || lastModel;
      if (r.citations) citations.push(...r.citations);
      // On the final allowed turn, force an answer (ignore any further tool call).
      const call = i < MAX_TOOL_ITERATIONS ? extractToolCall(r.text || '') : null;
      if (!call) {
        final = stripToolCallJson(r.text || '') || (r.text || '');
        break;
      }
      convo.push({ role: 'assistant', content: r.text || '' });
      const query = typeof call.arguments.query === 'string' ? call.arguments.query : undefined;
      // Announce the tool as it STARTS so the client can show the agent working live.
      params.onToolEvent?.({ phase: 'start', tool: call.name, query, index: 0, iteration: i });
      const toolDef = tools.find((t) => t.name === call.name);
      if (!toolDef) {
        params.onToolEvent?.({ phase: 'end', tool: call.name, query, ok: false, summary: 'Unknown tool', index: 0, iteration: i });
        toolEvents.push({ tool: call.name, ok: false, summary: 'Unknown tool' });
        convo.push({ role: 'user', content: formatToolResult(call.name, `Unknown tool: ${call.name}`) });
        continue;
      }
      try {
        const out = await toolDef.execute(call.arguments, params.signal);
        if (out.images) images.push(...out.images);
        if (out.citations) citations.push(...out.citations);
        // Stamp each artifact with the call that produced it so the client's widget
        // refresh control can re-execute the same tool for live data.
        if (out.artifacts) artifacts.push(...out.artifacts.map((a) => ({ ...a, origin: { tool: call.name, args: call.arguments } })));
        if (out.notice) addNotice({ tool: call.name, ...out.notice });
        toolEvents.push({ tool: call.name, query, ok: true, summary: out.content.slice(0, 160) });
        params.onToolEvent?.({ phase: 'end', tool: call.name, query, ok: true, summary: out.content.slice(0, 160), index: 0, iteration: i });
        // Bound the model-facing text (the trace summary above stays full-fidelity).
        convo.push({ role: 'user', content: formatToolResult(call.name, capToolOutput(out.content, { max: CHAT_TOOL_OUTPUT_MAX, toolName: call.name })) });
      } catch (err) {
        const message = (err as Error)?.message || 'tool failed';
        addNotice({ tool: call.name, level: 'error', message });
        toolEvents.push({ tool: call.name, query, ok: false, summary: message });
        params.onToolEvent?.({ phase: 'end', tool: call.name, query, ok: false, summary: message, index: 0, iteration: i });
        convo.push({ role: 'user', content: formatToolResult(call.name, `Error: ${message}`) });
      }
    }
    // Same empty-answer recovery as the native loop: a 200-with-no-content turn should
    // retry once (tool-less) instead of handing the user a blank bubble.
    if (!final.trim() && images.length === 0 && artifacts.length === 0) {
      const retry = await provider.generateText({ ...baseReq, messages: [...convo, { role: 'user', content: 'Answer the request above now, in plain text.' }] }, ctx);
      lastModel = retry.model || lastModel;
      final = stripToolCallJson(retry.text || '') || (retry.text || '');
      if (final.trim()) {
        addNotice({ tool: 'agent', level: 'warn', message: 'The model initially returned an empty answer — retried once and recovered.' });
      }
    }

    const merged = dedupeCitations(citations);
    return {
      text: final,
      usage: buildUsage(lastUserSeed(), final, undefined),
      model: lastModel,
      citations: merged.length ? merged : undefined,
      toolEvents: toolEvents.length ? toolEvents : undefined,
      images: images.length ? images : undefined,
      artifacts: artifacts.length ? artifacts : undefined,
      notices: notices.length ? notices : undefined
    };
  }

  // Agentic loop: call the model, run any tools it asks for, feed results back, repeat.
  // A single call (no tools enabled) collapses to one iteration with no tool round-trips.
  let result = await callModelResilient(messages, true);

  let iterations = 0;
  while (result.toolCalls && result.toolCalls.length && iterations < MAX_TOOL_ITERATIONS) {
    iterations += 1;
    if (result.citations) citations.push(...result.citations);

    messages.push({
      role: 'assistant',
      content: result.text || '',
      tool_calls: result.toolCalls.map((c) => ({
        id: c.id,
        type: 'function' as const,
        function: { name: c.name, arguments: c.arguments }
      }))
    });

    // Run all tool calls for this turn concurrently (they're independent), then
    // append their results in the original call order. This cuts latency sharply
    // when the model requests several tools at once (e.g. news + weather + map).
    const settled = await Promise.all(
      result.toolCalls.map(async (call, index) => {
        const tool = tools.find((t) => t.name === call.name);
        const { args: parsed, malformed } = parseToolArguments(call.arguments);
        const query = typeof parsed.query === 'string' ? parsed.query : undefined;
        // Announce every tool in this round as it STARTS (all light up at once), then
        // settle each independently below — the client renders this as a live step list.
        params.onToolEvent?.({ phase: 'start', tool: call.name, query, index, iteration: iterations });
        if (!tool) {
          params.onToolEvent?.({ phase: 'end', tool: call.name, query, ok: false, summary: 'Unknown tool', index, iteration: iterations });
          return { call, query, args: parsed, ok: false as const, content: `Unknown tool: ${call.name}`, summary: 'Unknown tool' };
        }
        if (malformed) {
          // The streamed arguments were truncated/garbled (the output-token budget can cut
          // off a big render_chart/generate_app payload mid-JSON). Don't run the tool on
          // empty args and hand back a fake "no input" result — tell the model so it
          // re-issues the call with complete JSON next round (within MAX_TOOL_ITERATIONS).
          const summary = 'Unreadable tool arguments';
          params.onToolEvent?.({ phase: 'end', tool: call.name, query, ok: false, summary, index, iteration: iterations });
          return {
            call,
            query,
            args: parsed,
            ok: false as const,
            content: `The arguments for ${call.name} were truncated or malformed and could not be parsed. Re-issue the call with complete, valid JSON arguments (split a large payload into smaller pieces if needed).`,
            summary
          };
        }
        try {
          const out = await tool.execute(parsed, params.signal);
          params.onToolEvent?.({ phase: 'end', tool: call.name, query, ok: true, summary: out.content.slice(0, 160), index, iteration: iterations });
          return { call, query, args: parsed, ok: true as const, out, content: out.content, summary: out.content.slice(0, 160) };
        } catch (err) {
          const message = (err as Error)?.message || 'tool failed';
          params.onToolEvent?.({ phase: 'end', tool: call.name, query, ok: false, summary: message, index, iteration: iterations });
          return { call, query, args: parsed, ok: false as const, content: `Error: ${message}`, summary: message };
        }
      })
    );

    for (const r of settled) {
      if (r.ok && r.out) {
        if (r.out.images) images.push(...r.out.images);
        if (r.out.citations) citations.push(...r.out.citations);
        // Stamp origins so widgets can re-run the producing call for live refresh.
        if (r.out.artifacts) artifacts.push(...r.out.artifacts.map((a) => ({ ...a, origin: { tool: r.call.name, args: r.args ?? {} } })));
        // A tool can flag a degraded/missing-data situation it wants surfaced.
        if (r.out.notice) addNotice({ tool: r.call.name, ...r.out.notice });
      } else if (!r.ok) {
        // A tool that errored is itself a capability gap worth recording.
        addNotice({ tool: r.call.name, level: 'error', message: r.summary || 'Tool failed.' });
      }
      toolEvents.push({ tool: r.call.name, query: r.query, ok: r.ok, summary: r.summary });
      // Bound the model-facing tool result so one chatty tool/MCP can't overflow the
      // context window (a turn-killing provider 400) or inflate every later round's
      // payload. The trace summary above keeps the full short summary; only the text
      // re-fed to the model is capped. MCP results are pre-capped tighter at their source.
      messages.push({ role: 'tool', tool_call_id: r.call.id, content: capToolOutput(r.content, { max: CHAT_TOOL_OUTPUT_MAX, toolName: r.call.name }) });
    }

    // Next turn. On the final allowed iteration, drop tools to force a written answer.
    const allowMoreTools = iterations < MAX_TOOL_ITERATIONS;
    // Discard the just-streamed pre-tool narration on the client before the next turn
    // streams, so the live view doesn't accumulate "let me check…" preambles.
    params.onReset?.();
    result = await callModelResilient(messages, allowMoreTools);
  }

  // If we exhausted the tool-round budget, the model was forced to answer mid-plan —
  // be honest that the answer may be incomplete rather than letting it look complete.
  if (iterations >= MAX_TOOL_ITERATIONS) {
    addNotice({
      tool: 'agent',
      level: 'warn',
      message: `Reached the ${MAX_TOOL_ITERATIONS}-step tool limit for this turn — the answer may be incomplete. Ask a follow-up to continue.`
    });
  }

  // Empty-answer recovery. Some free/preview models return HTTP 200 with EMPTY content
  // (the production "says no response" failure) — the turn "succeeds" but the user gets a
  // blank bubble. If nothing renderable came back (no text, no images, no artifacts),
  // retry once: on OpenRouter switch to the fast fallback and mark the silent model down
  // so Auto skips it; otherwise retry the same model tool-less (some models only go
  // silent when tools are attached).
  if (!String(result.text || '').trim() && images.length === 0 && artifacts.length === 0 && !streamedAny) {
    if (params.provider === 'openrouter' && params.model !== TEXT_FALLBACK) {
      markModelDown(params.model);
      addNotice({
        tool: 'agent',
        level: 'warn',
        message: `Your selected model (${params.model}) returned an empty answer, so this reply used a faster model (${TEXT_FALLBACK}). Pick a different model in the switcher to avoid this.`
      });
      params.onReset?.();
      result = await callModel(messages, false, TEXT_FALLBACK);
    } else {
      params.onReset?.();
      result = await callModel(messages, false);
      if (String(result.text || '').trim()) {
        addNotice({ tool: 'agent', level: 'warn', message: 'The model initially returned an empty answer — retried once and recovered.' });
      }
    }
  }

  if (result.citations) citations.push(...result.citations);

  // Build a usage record from the last user turn's text + final response (provider usage
  // is attached separately by the route's settlement).
  const lastUserText = [...params.messages].reverse().find((m) => m.role === 'user');
  const promptSeed =
    typeof lastUserText?.content === 'string'
      ? lastUserText.content
      : Array.isArray(lastUserText?.content)
        ? lastUserText!.content.map((p) => ('text' in p ? p.text : '')).join(' ')
        : '';

  const mergedCitations = dedupeCitations(citations);

  return {
    text: result.text,
    usage: buildUsage(promptSeed, result.text, undefined),
    model: result.model || params.model,
    reasoning: result.reasoning,
    citations: mergedCitations.length ? mergedCitations : undefined,
    toolEvents: toolEvents.length ? toolEvents : undefined,
    images: images.length ? images : undefined,
    artifacts: artifacts.length ? artifacts : undefined,
    notices: notices.length ? notices : undefined
  };
};
