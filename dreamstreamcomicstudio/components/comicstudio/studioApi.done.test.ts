// The shared `done` event carries `beforeVersionId` (wave 2b ig1 amendment; versions plan §6.1 step 8): a
// history_restore stream names the moment saved just before it, so the restore toast's Undo needs no lookup. The
// client's StudioDoneEvent is now a plain alias of the shared type, and the server's emit (H3) is typed by the contract.
//
// These are compile-time guards first: without the amendment `npm run typecheck` fails on the literal below (TS2353,
// unknown property), on the indexed access (TS2339) and on the alias equality. The runtime half pins that the parser's
// output is exactly that shared shape.

import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import type { StudioEvent } from '../../shared/comic/events';

vi.mock('../../services/apiClient', () => ({ get: vi.fn(), post: vi.fn(), postStream: vi.fn() }));

import { parseStudioEvent, type StudioDoneEvent } from './studioApi';

type SharedDone = Extract<StudioEvent, { type: 'done' }>;

describe('the shared done event names the moment saved before a restore', () => {
  it('a restore done event is a StudioEvent as written, with no cast, and parses to exactly that', () => {
    const done: StudioEvent = { type: 'done', rev: 3, spentUsd: 0, beforeVersionId: 'ver_8' };
    expect(parseStudioEvent('done', JSON.stringify(done))).toEqual(done);
    const plain: SharedDone = { type: 'done', rev: 4, spentUsd: 0.04, savedUsd: 0.01 };
    expect(parseStudioEvent('done', JSON.stringify(plain))).toEqual(plain);
  });

  it('beforeVersionId is an optional string on the shared type, and StudioDoneEvent is a plain alias of it', () => {
    expectTypeOf<SharedDone['beforeVersionId']>().toEqualTypeOf<string | undefined>();
    expectTypeOf<StudioDoneEvent>().toEqualTypeOf<SharedDone>();
    // Narrowing a StudioEvent on its type is enough to read it (useStudio's doneBeforeVersionId needs no cast).
    const read = (e: StudioEvent): string | undefined => (e.type === 'done' ? e.beforeVersionId : undefined);
    expect(read({ type: 'done', rev: 1, spentUsd: 0, beforeVersionId: 'ver_1' })).toBe('ver_1');
    expect(read({ type: 'done', rev: 1, spentUsd: 0 })).toBeUndefined();
  });
});
