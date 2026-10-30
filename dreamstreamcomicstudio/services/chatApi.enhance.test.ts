// enhancePrompt (gate F8 follow-up): its result type carries `skipped?: 'usage'` — what
// /api/chat/enhance answers when the included usage is used up (the draft echoed back, nothing
// spent) — so the composer reads it typed instead of through a local cast.
import { afterEach, describe, expect, it, vi } from 'vitest';

const { postMock } = vi.hoisted(() => ({ postMock: vi.fn() }));
vi.mock('./apiClient', () => ({
  post: (...args: unknown[]) => postMock(...args),
  postStream: vi.fn(),
  get: vi.fn(),
  ApiError: class ApiError extends Error {}
}));

import { enhancePrompt, type EnhancePromptResult } from './chatApi';

afterEach(() => postMock.mockReset());

describe('enhancePrompt', () => {
  it('posts the draft to /api/chat/enhance and hands back the typed answer, `skipped` included', async () => {
    postMock.mockResolvedValue({ enhanced: 'draw a fox comic', skipped: 'usage' });
    const ctrl = new AbortController();
    const res = await enhancePrompt('draw a fox comic', { signal: ctrl.signal });
    expect(postMock).toHaveBeenCalledWith('/api/chat/enhance', { text: 'draw a fox comic' }, { signal: ctrl.signal });
    // Compile-time pin (`npm run typecheck` covers this file): before the fix the result type had no
    // `skipped`, so reading it here was TS2339 — the composer had to cast.
    const skipped: EnhancePromptResult['skipped'] = res.skipped;
    const narrowed: 'usage' | undefined = skipped;
    expect(narrowed).toBe('usage');
    expect(res.enhanced).toBe('draw a fox comic');
  });

  it('a normal answer has no `skipped`', async () => {
    postMock.mockResolvedValue({ enhanced: 'Draw a fox comic set at dusk.', model: 'm' });
    const res = await enhancePrompt('draw a fox comic');
    expect(res.skipped).toBeUndefined();
    expect(res.model).toBe('m');
  });
});
