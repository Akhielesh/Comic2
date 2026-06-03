import { post } from './apiClient';
import type { ChatRequest, ChatResponse } from '../apiTypes';

/**
 * Send a chat completion request to the AI Chat Platform backend.
 *
 * The selected model/source travel in the body (the server reads them before the
 * global header selection), so a chat session's model is independent of whatever
 * model the rest of the app has pinned.
 */
export const sendChatMessage = (
  req: ChatRequest,
  options?: { signal?: AbortSignal }
): Promise<ChatResponse> => post<ChatRequest, ChatResponse>('/api/chat', req, options);
