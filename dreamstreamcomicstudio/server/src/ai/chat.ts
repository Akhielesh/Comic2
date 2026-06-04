// AI Chat Platform — free-form multi-turn chat on any catalog model.
//
// Unlike the Universal Assistant (which is platform-scoped and locked to a free
// OpenRouter model), this powers the standalone "AI Chat Platform" product: the
// user picks any model from the catalog and chats with it directly. It reuses the
// same provider gateway, so model choice, pricing, BYOK and usage metering all
// flow through one control plane.

import type { ChatMessage } from './providers/types.js';
import type { ChatArtifact, ChatClientContext, CapabilityNotice } from '../../../apiTypes.js';
import { logCapabilityNotice } from './capabilities.js';
import { getProvider, resolveProviderContext } from './gateway.js';
import { buildUsage } from './usage.js';
import type { AIProviderId } from './providers/types.js';
import { toToolSpec, type ChatTool } from './tools/registry.js';

export type ChatReasoningLevel = 'none' | 'low' | 'medium' | 'high';

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

/** Max model⇄tool round-trips before we force a final answer. */
const MAX_TOOL_ITERATIONS = 4;

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
  timeoutMs?: number;
  /**
   * Pre-sanitized DreamStream workspace context (JSON string). Present only when the
   * user enabled the DreamStream connector for the session. Injected as a guardrailed
   * block so the model can help with the user's own projects but can't act or leak.
   */
  dreamstreamContextJson?: string;
  /** Agentic tools the model may call (DuckDuckGo, etc.). OpenRouter only. */
  tools?: ChatTool[];
  /** Runtime situational context (date/timezone/locale/units/location). */
  clientContext?: ChatClientContext;
  /** Abort signal for in-flight tool calls. */
  signal?: AbortSignal;
  /** When set, stream content/reasoning deltas as they arrive (SSE). */
  onDelta?: (delta: { content?: string; reasoning?: string }) => void;
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
export const CHAT_SYSTEM_PROMPT = `You are DreamStream Chat, a sharp, accurate AI assistant with live internet access and a suite of real-data tools.

CORE BEHAVIOR — read carefully:
- Be CONCISE and direct. Lead with the answer in the first sentence. Do NOT bombard the user with long preambles, caveats, or filler. Match the length of the answer to the question — short questions get short answers.
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

const reasoningMaxTokens = (level?: ChatReasoningLevel): number => {
  switch (level) {
    case 'high':
      return 4096;
    case 'medium':
      return 3072;
    default:
      return 2048;
  }
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
  if (params.dreamstreamContextJson) {
    systemContent += dreamstreamBlock(params.dreamstreamContextJson);
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
- When a tool result renders as a CARD (stock, weather, news, crypto, map, places), the card already shows the raw numbers — so DON'T restate them. Instead add a brief but genuinely insightful READ: for a stock, where the price sits in its 52-week range, recent momentum, valuation (P/E) and anything notable from the headlines or peers; for weather, what to actually expect/plan. Aim for 2-4 crisp, insightful sentences — never a bare one-liner, and never a long data dump.
- Use render_chart / show_metrics / render_table / render_heatmap to visualize any data you gather or compute, and build_finance_terminal for a live markets dashboard (focus quote + indices + watchlist + heatmap + news) when the user wants an overview/watchlist/multiple tickers.
- For COMPARISONS, baskets, or "X vs Y" across several items (e.g. "compare gold, oil and the S&P", "show me NVDA, AMD and Intel", "metals vs the dollar"), call the right tool ONCE PER ITEM in the SAME turn — tools run in parallel and the cards then lay out side by side in a grid. get_stock covers stocks, ETFs, indices, commodities (gold/oil/silver/copper/gas), FX pairs and crypto, so it's your go-to for any "price/trend of X" across asset classes. To show a trend or overlay several series on one chart, use render_chart.
- LIVE NUMBERS, NOT MEMORY: render_table / render_heatmap only DRAW the values you pass — they do not fetch. NEVER type stock/crypto prices, %s, market caps or other live figures into them (or into prose) from memory; fetch them first with get_stock / crypto_price / build_finance_terminal. A polished table of made-up numbers is a serious error. And on a FOLLOW-UP about a price you mentioned earlier, RE-FETCH it — do not reuse the earlier number, it has moved. Only discuss the tickers the user asked about; don't default to Apple/Tesla/Microsoft.`;
  }

  const messages: ChatMessage[] = [{ role: 'system', content: systemContent }, ...params.messages];

  const useReasoning =
    params.provider === 'openrouter' && params.reasoningLevel && params.reasoningLevel !== 'none';
  const useWeb = params.provider === 'openrouter' && Boolean(params.webSearch);
  // Agentic tools are OpenRouter-only (function-calling + tool_calls parsing).
  const tools = params.provider === 'openrouter' ? params.tools || [] : [];
  const toolSpecs = tools.length ? tools.map(toToolSpec) : undefined;

  const ctx = resolveProviderContext(params.apiKey, params.provider);
  const baseReq = {
    model: params.model,
    temperature: typeof params.temperature === 'number' ? params.temperature : 0.7,
    maxTokens: params.maxTokens ?? reasoningMaxTokens(params.reasoningLevel),
    timeoutMs: params.timeoutMs,
    retries: 2,
    fallbackModel: params.fallbackModel,
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
  const callModel = (msgs: ChatMessage[], withTools: boolean) => {
    const r = { ...baseReq, messages: msgs, ...(withTools && toolSpecs ? { tools: toolSpecs } : {}) };
    return params.onDelta && provider.generateTextStream
      ? provider.generateTextStream(r, ctx, params.onDelta)
      : provider.generateText(r, ctx);
  };

  // Agentic loop: call the model, run any tools it asks for, feed results back, repeat.
  // A single call (no tools enabled) collapses to one iteration with no tool round-trips.
  let result = await callModel(messages, true);

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
      result.toolCalls.map(async (call) => {
        const tool = tools.find((t) => t.name === call.name);
        let parsed: Record<string, unknown> = {};
        try {
          parsed = call.arguments ? JSON.parse(call.arguments) : {};
        } catch {
          parsed = {};
        }
        const query = typeof parsed.query === 'string' ? parsed.query : undefined;
        if (!tool) {
          return { call, query, ok: false as const, content: `Unknown tool: ${call.name}`, summary: 'Unknown tool' };
        }
        try {
          const out = await tool.execute(parsed, params.signal);
          return { call, query, ok: true as const, out, content: out.content, summary: out.content.slice(0, 160) };
        } catch (err) {
          const message = (err as Error)?.message || 'tool failed';
          return { call, query, ok: false as const, content: `Error: ${message}`, summary: message };
        }
      })
    );

    for (const r of settled) {
      if (r.ok && r.out) {
        if (r.out.images) images.push(...r.out.images);
        if (r.out.citations) citations.push(...r.out.citations);
        if (r.out.artifacts) artifacts.push(...r.out.artifacts);
        // A tool can flag a degraded/missing-data situation it wants surfaced.
        if (r.out.notice) addNotice({ tool: r.call.name, ...r.out.notice });
      } else if (!r.ok) {
        // A tool that errored is itself a capability gap worth recording.
        addNotice({ tool: r.call.name, level: 'error', message: r.summary || 'Tool failed.' });
      }
      toolEvents.push({ tool: r.call.name, query: r.query, ok: r.ok, summary: r.summary });
      messages.push({ role: 'tool', tool_call_id: r.call.id, content: r.content });
    }

    // Next turn. On the final allowed iteration, drop tools to force a written answer.
    const allowMoreTools = iterations < MAX_TOOL_ITERATIONS;
    result = await callModel(messages, allowMoreTools);
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
