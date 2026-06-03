import { get, post, postStream } from './apiClient';
import type { ChatRequest, ChatResponse } from '../apiTypes';

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

/**
 * Stream a chat completion via SSE. Calls handlers as deltas arrive and resolves
 * with the final ChatResponse (full text, citations, artifacts, usage, billing).
 */
export const sendChatMessageStream = async (
  req: ChatRequest,
  handlers: ChatStreamHandlers = {}
): Promise<ChatResponse> => {
  const res = await postStream('/api/chat/stream', req, { signal: handlers.signal });
  if (!res.body) throw new Error('Streaming is not supported by this response.');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let final: ChatResponse | null = null;
  let streamError: string | null = null;

  // Parse one SSE record ("event: x\ndata: {...}").
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
    if (event === 'delta' && typeof parsed.content === 'string') handlers.onDelta?.(parsed.content);
    else if (event === 'reasoning' && typeof parsed.reasoning === 'string') handlers.onReasoning?.(parsed.reasoning);
    else if (event === 'final') final = parsed as ChatResponse;
    else if (event === 'error') streamError = String(parsed.message || 'The request failed.');
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

  if (streamError) throw new Error(streamError);
  if (!final) throw new Error('The model returned no response.');
  return final;
};
