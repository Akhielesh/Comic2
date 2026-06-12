import { get, post, postStream, ApiError } from './apiClient';
import type { ChatArtifact, ChatRequest, ChatResponse, SwarmTraceArtifact, SystemDashboard } from '../apiTypes';

/**
 * True when an error looks like a transport/connectivity failure rather than a
 * deliberate server response (4xx/5xx with a body). Mobile networks, captive
 * proxies and some CDNs terminate long-lived SSE streams mid-flight — the body
 * read then rejects with a bare "network error" / "Load failed" / "Failed to
 * fetch". `safeFetch` also surfaces unreachable-server failures as ApiError
 * status 0. In those cases the buffered (non-streaming) endpoint usually still
 * works, so callers can safely retry there.
 */
const isTransportError = (err: unknown): boolean => {
  if (err instanceof ApiError) return err.status === 0;
  const msg = String((err as Error)?.message || '').toLowerCase();
  return (
    msg.includes('network error') ||
    msg.includes('networkerror') ||
    msg.includes('failed to fetch') ||
    msg.includes('load failed') ||
    msg.includes('network connection was lost') ||
    msg.includes('streaming is not supported')
  );
};

// Re-exported from the dependency-free module so existing importers keep working.
export { friendlyChatError } from './chatErrors';

/** Admin-only: live system dashboard (capabilities, tool health, limits, gaps). */
export const getSystemDashboard = (): Promise<SystemDashboard> => get<SystemDashboard>('/api/system/dashboard');

export interface UnfurlResult {
  url: string;
  title?: string;
  description?: string;
  image?: string;
  siteName?: string;
  error?: string;
}

const unfurlCache = new Map<string, Promise<UnfurlResult>>();

/** Fetch OG/meta preview for a link (cached per URL). */
export const unfurlLink = (url: string): Promise<UnfurlResult> => {
  const cached = unfurlCache.get(url);
  if (cached) return cached;
  const p = get<UnfurlResult>(`/api/chat/unfurl?url=${encodeURIComponent(url)}`).catch((): UnfurlResult => ({ url }));
  unfurlCache.set(url, p);
  return p;
};

export interface ReadArticleResult {
  url: string;
  host: string;
  title?: string;
  byline?: string;
  image?: string;
  blocks: { type: 'h' | 'p'; text: string }[];
  ok: boolean;
  error?: string;
}

const readCache = new Map<string, Promise<ReadArticleResult>>();

/** Fetch extracted reader-mode content for an article URL (cached per URL). */
export const readArticle = (url: string): Promise<ReadArticleResult> => {
  const cached = readCache.get(url);
  if (cached) return cached;
  const p = get<ReadArticleResult>(`/api/chat/read-url?url=${encodeURIComponent(url)}`).catch(
    (): ReadArticleResult => ({ url, host: '', blocks: [], ok: false, error: 'fetch failed' })
  );
  readCache.set(url, p);
  return p;
};

/**
 * Send a chat completion request to the AI Chat Platform backend (non-streaming).
 *
 * The selected model/source travel in the body (the server reads them before the
 * global header selection), so a chat session's model is independent of whatever
 * model the rest of the app has pinned.
 */
export const sendChatMessage = (
  req: ChatRequest,
  options?: { signal?: AbortSignal }
): Promise<ChatResponse> => post<ChatRequest, ChatResponse>('/api/chat', req, options);

/**
 * Re-execute the tool call that produced a live-data widget (its `origin`) and get
 * fresh artifacts back. Server-whitelisted to pure data tools — no model involved.
 * `args` may patch the original call (e.g. a news widget switching topic).
 */
export const refreshArtifact = async (
  tool: string,
  args: Record<string, unknown>
): Promise<{ artifacts: ChatArtifact[]; asOf?: string }> => {
  const { gatherClientContext } = await import('./clientContext');
  const clientContext = await gatherClientContext().catch(() => undefined);
  return post<{ tool: string; args: Record<string, unknown>; clientContext?: unknown }, { artifacts: ChatArtifact[]; asOf?: string }>(
    '/api/chat/tool-refresh',
    { tool, args, ...(clientContext ? { clientContext } : {}) }
  );
};

/**
 * Improve a rough prompt draft without changing the user's intent. Returns the
 * enhanced text for the user to accept or discard — it never auto-sends.
 */
export const enhancePrompt = (text: string, options?: { signal?: AbortSignal }): Promise<{ enhanced: string; model?: string }> =>
  post<{ text: string }, { enhanced: string; model?: string }>('/api/chat/enhance', { text }, options);

/**
 * Distill durable facts about the user from a recent exchange and merge them into
 * their long-term memory. Returns the updated memory (or the existing one if there
 * was nothing new / no key configured). Best-effort — callers ignore failures.
 */
export const updateChatMemory = (
  messages: ChatRequest['messages'],
  memory: string,
  options?: { signal?: AbortSignal }
): Promise<{ memory: string }> =>
  post<{ messages: ChatRequest['messages']; memory: string }, { memory: string }>(
    '/api/chat/memory',
    { messages, memory },
    options
  );

/**
 * Absorb memories/custom-instructions exported from another AI tool (ChatGPT, Claude,
 * Gemini, …) into the user's long-term memory here. The server distills the content
 * into the standard bullet format and merges it with the existing memory; the caller
 * shows the result for review before saving.
 */
export const importChatMemory = (
  source: 'chatgpt' | 'claude' | 'gemini' | 'other',
  content: string,
  memory: string,
  options?: { signal?: AbortSignal }
): Promise<{ memory: string; model?: string }> =>
  post<{ source: string; content: string; memory: string }, { memory: string; model?: string }>(
    '/api/chat/memory/import',
    { source, content, memory },
    options
  );

/**
 * After an answer, fetch a few proactive follow-up suggestions the user is likely to
 * want next (rendered as clickable chips). Best-effort — callers ignore failures, and
 * the server returns an empty list when there's nothing useful or no key is configured.
 */
export const fetchFollowUps = (
  messages: ChatRequest['messages'],
  source?: string,
  options?: { signal?: AbortSignal }
): Promise<{ suggestions: string[]; model?: string }> =>
  post<{ messages: ChatRequest['messages']; source?: string }, { suggestions: string[]; model?: string }>(
    '/api/chat/followups',
    { messages, source },
    options
  );

export interface ChatStreamHandlers {
  /** Incremental answer text. */
  onDelta?: (content: string) => void;
  /** Incremental reasoning trace. */
  onReasoning?: (text: string) => void;
  /**
   * The server is starting a new turn after running tools — discard the streamed
   * content/reasoning so far so the prior turn's pre-tool narration doesn't bleed into
   * the final answer on screen.
   */
  onReset?: () => void;
  signal?: AbortSignal;
}

// If the stream goes completely silent for this long, treat the connection as dead and
// fail with an actionable error instead of "loading" forever. The server sends an SSE
// keep-alive comment every 15s, so a live (even slow, tool-heavy) turn always delivers
// bytes well within this window — only a genuinely stalled/buffered/dead connection trips it.
const STREAM_IDLE_TIMEOUT_MS = 45_000;

/** Consume an SSE stream, dispatching each parsed record to `onRecord`. Aborts on a silent stall. */
const consumeEventStream = async (
  res: Response,
  onRecord: (event: string, parsed: any) => void
): Promise<void> => {
  if (!res.body) throw new Error('Streaming is not supported by this response.');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const handleRecord = (record: string) => {
    const lines = record.split('\n');
    let event = 'message';
    let data = '';
    for (const line of lines) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data += line.slice(5).trim();
    }
    if (!data) return;
    let parsed: any;
    try { parsed = JSON.parse(data); } catch { return; }
    onRecord(event, parsed);
  };

  // Idle watchdog: race each read against a timeout so a stalled connection can't hang
  // the UI indefinitely. ANY byte (including the server's keep-alive comments) resets it.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const idle = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error('The connection went silent — the network connection was lost. Please try again.')),
        STREAM_IDLE_TIMEOUT_MS
      );
    });
    let result: ReadableStreamReadResult<Uint8Array>;
    try {
      result = await Promise.race([reader.read(), idle]);
    } catch (err) {
      await reader.cancel().catch(() => {});
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
    }
    const { done, value } = result;
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const records = buffer.split('\n\n');
    buffer = records.pop() || '';
    for (const record of records) handleRecord(record);
  }
  if (buffer.trim()) handleRecord(buffer);
};

/**
 * Derive an AbortSignal that fires when the parent aborts OR after `ms` — so a single
 * request can be bounded by both user-cancel and a hard timeout. Call `done()` to clear.
 */
const withTimeoutSignal = (parent: AbortSignal | undefined, ms: number): { signal: AbortSignal; done: () => void } => {
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  if (parent) {
    if (parent.aborted) ctrl.abort();
    else parent.addEventListener('abort', onAbort, { once: true });
  }
  const timer = setTimeout(() => ctrl.abort(new DOMException('Request timed out', 'TimeoutError')), ms);
  return {
    signal: ctrl.signal,
    done: () => {
      clearTimeout(timer);
      parent?.removeEventListener('abort', onAbort);
    }
  };
};

/**
 * Stream a chat completion via SSE. Calls handlers as deltas arrive and resolves
 * with the final ChatResponse (full text, citations, artifacts, usage, billing).
 */
export const sendChatMessageStream = async (
  req: ChatRequest,
  handlers: ChatStreamHandlers = {}
): Promise<ChatResponse> => {
  // Track whether ANY event arrived, and—separately—whether actual ANSWER CONTENT
  // arrived. Reasoning ("thinking") tokens count as `receivedAny` but NOT as content:
  // a high-reasoning turn can stream a long thought trace and then end with no answer
  // (empty content, no `final`). We must still recover from that, so the recovery path
  // keys off `receivedContent`, not `receivedAny`.
  let receivedAny = false;
  let receivedContent = false;
  try {
    const res = await postStream('/api/chat/stream', req, { signal: handlers.signal });
    let final: ChatResponse | null = null;
    let streamError: string | null = null;
    await consumeEventStream(res, (event, parsed) => {
      if (event === 'delta' && typeof parsed.content === 'string') {
        receivedAny = true;
        receivedContent = true;
        handlers.onDelta?.(parsed.content);
      } else if (event === 'reasoning' && typeof parsed.reasoning === 'string') {
        receivedAny = true;
        handlers.onReasoning?.(parsed.reasoning);
      } else if (event === 'reset') {
        // A reset wipes the content streamed so far from the screen (pre-tool narration
        // dropped before the real answer). So any content counted before this point did
        // NOT reach the user — clear the flag so a turn that resets and then produces an
        // empty answer still falls into the recovery path below instead of returning blank.
        receivedContent = false;
        handlers.onReset?.();
      } else if (event === 'final') {
        receivedAny = true;
        if (typeof (parsed as ChatResponse).text === 'string' && (parsed as ChatResponse).text.trim()) {
          receivedContent = true;
        }
        final = parsed as ChatResponse;
      } else if (event === 'error') {
        streamError = String(parsed.message || 'The request failed.');
      }
    });
    if (streamError) throw new Error(streamError);
    // No `final`, OR a `final` with empty text (e.g. reasoning consumed the whole budget):
    // treat as "no usable answer" so the recovery path below can re-run and actually answer.
    if (!final || !receivedContent) throw new Error('The model returned no response.');
    return final;
  } catch (err) {
    // SSE is brittle on mobile networks/proxies that don't pass long-lived streams —
    // the connection opens, then the body read rejects with a bare "network error".
    // When nothing was streamed and the user didn't cancel, fall back to the buffered
    // (non-streaming) endpoint, which is far more proxy-friendly. Retry it a couple of
    // times with backoff so a single transient drop / cold start doesn't sink the turn.
    // Push the full answer through onDelta so the UI renders it just like a streamed one.
    // Recover whenever NO answer content reached the user (reasoning-only / empty
    // counts as "no content"). Two cases land here:
    //  (a) a transport drop before any content (SSE is brittle on mobile/proxies), and
    //  (b) the stream ended with only reasoning / empty content — the high-reasoning
    //      "thinks but never answers" failure we see in production.
    // For (b) we re-run with reasoning DOWNGRADED so the model spends its budget
    // answering instead of thinking, which is what actually fixes the empty turn.
    //  (c) the turn TIMED OUT (took too long) — production telemetry shows reasoning:high
    //      on the auto model regularly exceeding 90s. We recover those too, and since the
    //      reasoning budget is the cause, the recovery ALWAYS drops heavy reasoning so the
    //      retry answers fast instead of timing out again.
    const msg = err instanceof Error ? err.message : '';
    const emptyStream = /returned no response/i.test(msg);
    const tookTooLong = /timed out|too long|timeout/i.test(msg);
    if (!receivedContent && !handlers.signal?.aborted && (isTransportError(err) || emptyStream || tookTooLong)) {
      const highReasoning = req.reasoningLevel === 'high' || req.reasoningLevel === 'medium';
      // Any recovery on a heavy-reasoning turn retries LIGHT — empty AND slow turns are
      // both caused by the reasoning budget, so this is what actually gets an answer.
      const retryReq: ChatRequest = highReasoning ? { ...req, reasoningLevel: 'none' } : req;
      let lastErr: unknown = err;
      for (let attempt = 0; attempt < 3; attempt++) {
        if (handlers.signal?.aborted) break;
        if (attempt > 0) await new Promise((r) => setTimeout(r, 1000 * attempt));
        // Bound each buffered attempt so a dead/slow server can't hang the UI forever.
        const guard = withTimeoutSignal(handlers.signal, 120_000);
        try {
          const final = await sendChatMessage(retryReq, { signal: guard.signal });
          if (final.text && final.text.trim()) {
            handlers.onDelta?.(final.text);
            return final;
          }
          // Buffered also returned empty — keep trying (with the downgrade applied).
          lastErr = new Error('The model returned no response.');
        } catch (retryErr) {
          lastErr = retryErr;
          // A real server response (rate limit, missing key, …) is not worth retrying —
          // surface it immediately so the user sees the actionable message.
          if (!isTransportError(retryErr)) throw retryErr;
        } finally {
          guard.done();
        }
      }
      throw lastErr;
    }
    throw err;
  }
};

export interface SwarmStreamHandlers extends ChatStreamHandlers {
  /** Live plan/agent progress trace for the swarm UI. */
  onTrace?: (trace: SwarmTraceArtifact) => void;
}

/**
 * Run a turn through the agent swarm via SSE. Streams the synthesized answer
 * (onDelta) and the live plan/agent trace (onTrace); resolves with the final
 * ChatResponse (answer + swarm_trace and agent artifacts + usage + billing).
 */
export const runSwarmStream = async (
  req: ChatRequest,
  handlers: SwarmStreamHandlers = {}
): Promise<ChatResponse> => {
  const res = await postStream('/api/chat/swarm', { ...req, swarm: true }, { signal: handlers.signal });
  let final: ChatResponse | null = null;
  let streamError: string | null = null;
  await consumeEventStream(res, (event, parsed) => {
    if (event === 'delta' && typeof parsed.content === 'string') handlers.onDelta?.(parsed.content);
    else if (event === 'reasoning' && typeof parsed.reasoning === 'string') handlers.onReasoning?.(parsed.reasoning);
    else if (event === 'trace') handlers.onTrace?.(parsed as SwarmTraceArtifact);
    else if (event === 'final') final = parsed as ChatResponse;
    else if (event === 'error') streamError = String(parsed.message || 'The swarm failed.');
  });
  if (streamError) throw new Error(streamError);
  // A `final` whose text is empty/whitespace is NOT a usable answer (reasoning consumed
  // the budget, or agents produced nothing) — treat it exactly like a missing final so
  // the recovery below actually re-answers instead of returning a blank turn.
  const finalText = (final as ChatResponse | null)?.text;
  if (!final || !(typeof finalText === 'string' && finalText.trim())) {
    // The swarm synthesized no answer (e.g. reasoning-only / agents produced nothing).
    // There's no buffered-swarm endpoint, so recover with a regular completion (reasoning
    // downgraded if it was heavy) rather than failing the turn outright.
    if (!handlers.signal?.aborted) {
      const highReasoning = req.reasoningLevel === 'high' || req.reasoningLevel === 'medium';
      const fallbackReq: ChatRequest = highReasoning ? { ...req, reasoningLevel: 'none' } : req;
      try {
        const fallback = await sendChatMessage(fallbackReq, { signal: handlers.signal });
        if (fallback.text && fallback.text.trim()) {
          handlers.onDelta?.(fallback.text);
          return fallback;
        }
      } catch (fallbackErr) {
        if (!isTransportError(fallbackErr)) throw fallbackErr;
      }
    }
    throw new Error('The swarm returned no response.');
  }
  return final;
};
