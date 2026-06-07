import { get, post, postStream, ApiError } from './apiClient';
import type { ChatRequest, ChatResponse, SwarmTraceArtifact, SystemDashboard } from '../apiTypes';

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

/** Consume an SSE stream, dispatching each parsed record to `onRecord`. */
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

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const records = buffer.split('\n\n');
    buffer = records.pop() || '';
    for (const record of records) handleRecord(record);
  }
  if (buffer.trim()) handleRecord(buffer);
};

/**
 * Stream a chat completion via SSE. Calls handlers as deltas arrive and resolves
 * with the final ChatResponse (full text, citations, artifacts, usage, billing).
 */
export const sendChatMessageStream = async (
  req: ChatRequest,
  handlers: ChatStreamHandlers = {}
): Promise<ChatResponse> => {
  // Track whether ANY content arrived before a failure: if the stream is cut after
  // partial output we must surface the error (not silently re-answer), but if it
  // dies before a single byte we can transparently fall back to the buffered endpoint.
  let receivedAny = false;
  try {
    const res = await postStream('/api/chat/stream', req, { signal: handlers.signal });
    let final: ChatResponse | null = null;
    let streamError: string | null = null;
    await consumeEventStream(res, (event, parsed) => {
      if (event === 'delta' && typeof parsed.content === 'string') {
        receivedAny = true;
        handlers.onDelta?.(parsed.content);
      } else if (event === 'reasoning' && typeof parsed.reasoning === 'string') {
        receivedAny = true;
        handlers.onReasoning?.(parsed.reasoning);
      } else if (event === 'reset') {
        handlers.onReset?.();
      } else if (event === 'final') {
        receivedAny = true;
        final = parsed as ChatResponse;
      } else if (event === 'error') {
        streamError = String(parsed.message || 'The request failed.');
      }
    });
    if (streamError) throw new Error(streamError);
    if (!final) throw new Error('The model returned no response.');
    return final;
  } catch (err) {
    // SSE is brittle on mobile networks/proxies that don't pass long-lived streams —
    // the connection opens, then the body read rejects with a bare "network error".
    // When nothing was streamed and the user didn't cancel, fall back to the buffered
    // (non-streaming) endpoint, which is far more proxy-friendly. Retry it a couple of
    // times with backoff so a single transient drop / cold start doesn't sink the turn.
    // Push the full answer through onDelta so the UI renders it just like a streamed one.
    if (!receivedAny && !handlers.signal?.aborted && isTransportError(err)) {
      let lastErr: unknown = err;
      for (let attempt = 0; attempt < 3; attempt++) {
        if (handlers.signal?.aborted) break;
        if (attempt > 0) await new Promise((r) => setTimeout(r, 1000 * attempt));
        try {
          const final = await sendChatMessage(req, { signal: handlers.signal });
          if (final.text) handlers.onDelta?.(final.text);
          return final;
        } catch (retryErr) {
          lastErr = retryErr;
          // A real server response (rate limit, missing key, …) is not worth retrying —
          // surface it immediately so the user sees the actionable message.
          if (!isTransportError(retryErr)) throw retryErr;
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
  if (!final) throw new Error('The swarm returned no response.');
  return final;
};
