// steerStudio (agent-editor plan §3 A2): POST /projects/:id/steer, the response checked, every refusal a StudioApiError
// whose `code` tells the queue what to do with the note.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  postStream: vi.fn()
}));

vi.mock('../../services/apiClient', () => api);

import { StudioApiError, steerStudio } from './studioApi';

/** What apiClient throws for a non-2xx answer: the JSON body rides in `details`. */
const httpError = (status: number, code: string, message: string) =>
  Object.assign(new Error(message), { status, details: { error: { message, code } } });

beforeEach(() => {
  api.post.mockReset();
});

describe('steerStudio', () => {
  it('posts the note and its focus to the steer endpoint and returns the steered message id', async () => {
    api.post.mockResolvedValueOnce({ ok: true, msgId: 'msg_42' });
    const out = await steerStudio('p 1', { text: 'add rain', focus: { pageId: 'pg_1' } });
    expect(out).toEqual({ ok: true, msgId: 'msg_42' });
    expect(api.post).toHaveBeenCalledWith('/api/comic/projects/p%201/steer', { text: 'add rain', focus: { pageId: 'pg_1' } }, {});
  });

  it('sends only the contract fields and passes the abort signal through', async () => {
    api.post.mockResolvedValueOnce({ ok: true, msgId: 'msg_1' });
    const controller = new AbortController();
    await steerStudio('p', { text: 'x', extra: 1 } as never, { signal: controller.signal });
    expect(api.post).toHaveBeenCalledWith('/api/comic/projects/p/steer', { text: 'x' }, { signal: controller.signal });
  });

  it('an answer without a message id is an honest error, never a silent success', async () => {
    api.post.mockResolvedValueOnce({ ok: true });
    await expect(steerStudio('p', { text: 'x' })).rejects.toMatchObject({ kind: 'server' });
    api.post.mockResolvedValueOnce(null);
    await expect(steerStudio('p', { text: 'x' })).rejects.toBeInstanceOf(StudioApiError);
  });

  it.each([
    [409, 'NOT_RUNNING', "The director isn't working on anything right now — your note goes as a new message."],
    [409, 'BUSY', 'The director already has 3 notes to read — this one waits in Up next and goes when it finishes.'],
    [409, 'LIMIT', 'That note is long, so it goes as its own message once the director finishes (long scripts are saved as the source).']
  ])('a %i %s refusal keeps its code (the client queues the note) and the server copy', async (status, code, message) => {
    api.post.mockRejectedValueOnce(httpError(status, code, message));
    const err = await steerStudio('p', { text: 'x' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StudioApiError);
    expect(err).toMatchObject({ code, status, message });
  });

  it('steering off (501 NOT_AVAILABLE), a block (422 CONTENT_POLICY) and a network failure map to their kinds', async () => {
    api.post.mockRejectedValueOnce(httpError(501, 'NOT_AVAILABLE', "Adding a note while the director works isn't on yet — your note waits in Up next and goes when it finishes."));
    await expect(steerStudio('p', { text: 'x' })).rejects.toMatchObject({ kind: 'not_available', code: 'NOT_AVAILABLE' });
    api.post.mockRejectedValueOnce(httpError(422, 'CONTENT_POLICY', "That note doesn't fit DreamStream's content rules, so it wasn't added. Try different wording — bold action and spooky moments are fine."));
    await expect(steerStudio('p', { text: 'x' })).rejects.toMatchObject({ kind: 'content_policy', code: 'CONTENT_POLICY' });
    api.post.mockRejectedValueOnce({ status: 0, message: 'Failed to fetch' });
    await expect(steerStudio('p', { text: 'x' })).rejects.toMatchObject({ kind: 'network' });
  });
});
