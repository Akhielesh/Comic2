import { get, post, postStream } from './apiClient';
import type { ChatRequest, ChatResponse, SwarmTraceArtifact } from '../apiTypes';

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
  const res = await postStream('/api/chat/stream', req, { signal: handlers.signal });
  let final: ChatResponse | null = null;
  let streamError: string | null = null;
  await consumeEventStream(res, (event, parsed) => {
    if (event === 'delta' && typeof parsed.content === 'string') handlers.onDelta?.(parsed.content);
    else if (event === 'reasoning' && typeof parsed.reasoning === 'string') handlers.onReasoning?.(parsed.reasoning);
    else if (event === 'final') final = parsed as ChatResponse;
    else if (event === 'error') streamError = String(parsed.message || 'The request failed.');
  });
  if (streamError) throw new Error(streamError);
  if (!final) throw new Error('The model returned no response.');
  return final;
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
