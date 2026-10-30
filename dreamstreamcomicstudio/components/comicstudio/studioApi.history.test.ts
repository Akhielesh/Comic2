// Comic History on the studio stream (versions plan §3.3, §6.1 step 8; H5 wave notes 4 and 14): the client keeps the
// server's `history` event (a saved moment — an open History panel updates live) and a `history_restore` stream's
// `done.beforeVersionId` (the restore toast's Undo), and drops anything malformed instead of passing it on.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StudioEvent } from '../../shared/comic/events';
import type { VersionRow } from '../../shared/comic/history/types';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), postStream: vi.fn() }));
vi.mock('../../services/apiClient', () => api);

import { parseStudioEvent, streamStudio } from './studioApi';

const T = 1_760_000_300_000;
const VERSION = {
  id: 'ver_9',
  kind: 'restore',
  actor: 'you',
  label: 'You restored page 2',
  undoId: 'ver_8',
  pinned: false,
  rev: 3,
  contentAt: T,
  createdAt: T,
  codec: 'v5',
  changes: [],
  thumbs: [],
  stats: { pages: 6, drawn: 1, lines: 9, langs: [], models: [] }
} as unknown as VersionRow;

beforeEach(() => {
  api.postStream.mockReset();
});

describe('the history event', () => {
  it('passes a saved moment through (by SSE name or by its own type)', () => {
    expect(parseStudioEvent('history', JSON.stringify({ version: VERSION }))).toEqual({ type: 'history', version: VERSION });
    expect(parseStudioEvent('message', JSON.stringify({ type: 'history', version: VERSION }))).toEqual({ type: 'history', version: VERSION });
  });

  it('drops it unless version is a plain object', () => {
    for (const version of [undefined, null, 'ver_9', 9, true, [VERSION], []]) {
      expect(parseStudioEvent('history', JSON.stringify({ version })), JSON.stringify(version)).toBeNull();
    }
    expect(parseStudioEvent('history', '{}')).toBeNull();
    expect(parseStudioEvent('history', 'not json')).toBeNull();
  });

  it('arrives through the real stream reader between the other events', async () => {
    const enc = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode(`event: history\ndata: ${JSON.stringify({ type: 'history', version: VERSION })}\n\n`));
        c.enqueue(enc.encode(`event: done\ndata: ${JSON.stringify({ type: 'done', rev: 3, spentUsd: 0, beforeVersionId: 'ver_8' })}\n\n`));
      }
    });
    api.postStream.mockResolvedValue({ body });
    const events: StudioEvent[] = [];
    await streamStudio('p', { kind: 'action', action: { type: 'history_restore', versionId: 'ver_2', scope: { kind: 'book' } } }, (e) => events.push(e));
    expect(events).toEqual([
      { type: 'history', version: VERSION },
      { type: 'done', rev: 3, spentUsd: 0, beforeVersionId: 'ver_8' }
    ]);
  });
});

describe('done.beforeVersionId (a restore names the moment saved just before it)', () => {
  it('passes a non-empty string through, next to the usual fields', () => {
    expect(parseStudioEvent('done', JSON.stringify({ rev: 7, spentUsd: 0, beforeVersionId: 'ver_before' }))).toEqual({
      type: 'done',
      rev: 7,
      spentUsd: 0,
      beforeVersionId: 'ver_before'
    });
    expect(parseStudioEvent('done', JSON.stringify({ rev: 7, spentUsd: 0, savedUsd: 0.2, beforeVersionId: 'ver_b' }))).toEqual({
      type: 'done',
      rev: 7,
      spentUsd: 0,
      savedUsd: 0.2,
      beforeVersionId: 'ver_b'
    });
  });

  it('drops anything that is not a non-empty string (never coerced)', () => {
    for (const beforeVersionId of [42, '', null, true, { id: 'ver_x' }, ['ver_x']]) {
      const event = parseStudioEvent('done', JSON.stringify({ rev: 7, spentUsd: 0, beforeVersionId }));
      expect(event, JSON.stringify(beforeVersionId)).toEqual({ type: 'done', rev: 7, spentUsd: 0 });
      expect(event).not.toHaveProperty('beforeVersionId');
    }
  });
});
