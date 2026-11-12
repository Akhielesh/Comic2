// updateChatMemory carries the chat's model source, as generateChatTitle and fetchFollowUps do, so
// POST /api/chat/memory merges on that provider and key (routes/chat.ts resolveChatProvider) instead of
// the server's auto pick. The field is sent only when given; `memoryConnected` is unchanged.
import { afterEach, describe, expect, it, vi } from 'vitest';

const { postMock } = vi.hoisted(() => ({ postMock: vi.fn() }));
vi.mock('./apiClient', () => ({
  post: (...args: unknown[]) => postMock(...args),
  postStream: vi.fn(),
  get: vi.fn(),
  ApiError: class ApiError extends Error {}
}));

import { updateChatMemory } from './chatApi';

afterEach(() => postMock.mockReset());

const MESSAGES = [
  { role: 'user' as const, content: 'I live in Lisbon' },
  { role: 'assistant' as const, content: 'Noted.' }
];

describe('updateChatMemory', () => {
  it('sends the session source when the chat has one, next to memoryConnected', async () => {
    postMock.mockResolvedValue({ memory: '- Lives in Lisbon' });
    await updateChatMemory(MESSAGES, '- Likes tides', { memoryConnected: true, source: 'anthropic' });
    expect(postMock).toHaveBeenCalledWith(
      '/api/chat/memory',
      { messages: MESSAGES, memory: '- Likes tides', memoryConnected: true, source: 'anthropic' },
      undefined
    );
  });

  it('leaves `source` out when the chat has none (Auto), exactly as before', async () => {
    postMock.mockResolvedValue({ memory: '' });
    const ctrl = new AbortController();
    await updateChatMemory(MESSAGES, '', { memoryConnected: false, source: undefined, signal: ctrl.signal });
    const [, body, init] = postMock.mock.calls[0];
    expect(body).toEqual({ messages: MESSAGES, memory: '' });
    expect('source' in (body as object)).toBe(false);
    expect(init).toEqual({ signal: ctrl.signal });

    postMock.mockClear();
    await updateChatMemory(MESSAGES, '');
    expect(postMock.mock.calls[0][1]).toEqual({ messages: MESSAGES, memory: '' });
  });
});
