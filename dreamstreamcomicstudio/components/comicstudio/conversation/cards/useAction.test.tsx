import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { StudioAction } from '../../../../shared/comic/ops';
import type { ComicDoc } from '../../../../shared/comic/doc';
import { stopsSequence, useAction, useStudioSequenceGuard } from './useAction';
import { makeSampleDoc } from '../testing/fixtures';

const approve: StudioAction = { type: 'approve_plan' };
const draw: StudioAction = { type: 'render_pages', quotedUsd: 0.2 };

describe('useAction sequences stop at the first step that did not go through', () => {
  it('stopsSequence reads an outcome object (forward-compatible with act returning its StreamOutcome)', () => {
    expect(stopsSequence(undefined)).toBe(false);
    expect(stopsSequence({ ok: true })).toBe(false);
    expect(stopsSequence({ ok: false })).toBe(true);
    expect(stopsSequence({ ok: true, gated: true })).toBe(true);
    expect(stopsSequence({ ok: true, aborted: true })).toBe(true);
  });

  it('runs every step when each goes through', async () => {
    const act1 = vi.fn(async () => ({ ok: true }));
    const { result } = renderHook(() => useAction(act1));
    let ok = false;
    await act(async () => {
      ok = await result.current.run('k', approve, draw);
    });
    expect(ok).toBe(true);
    expect(act1).toHaveBeenCalledTimes(2);
  });

  it('a refused or gated step stops the rest', async () => {
    const refused = vi.fn(async (a: StudioAction) => (a.type === 'approve_plan' ? { ok: false } : { ok: true }));
    const { result } = renderHook(() => useAction(refused));
    await act(async () => {
      await result.current.run('k', approve, draw);
    });
    expect(refused).toHaveBeenCalledTimes(1);

    const gated = vi.fn(async () => ({ ok: true, gated: true }));
    const { result: r2 } = renderHook(() => useAction(gated));
    await act(async () => {
      await r2.current.run('k', draw, { type: 'render_cover', quotedUsd: 0.07 });
    });
    expect(gated).toHaveBeenCalledTimes(1);
  });

  it('a throwing step stops the sequence without an unhandled rejection; the key is free again', async () => {
    const boom = vi.fn(async () => {
      throw new Error('nope');
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { result } = renderHook(() => useAction(boom));
    let ok = true;
    await act(async () => {
      ok = await result.current.run('k', approve, draw);
    });
    expect(ok).toBe(false);
    expect(boom).toHaveBeenCalledTimes(1);
    expect(result.current.isPending('k')).toBe(false);
    warn.mockRestore();
  });

  it('the studio guard stops when the step opened a NEW approval (a second gate never replaces the first)', async () => {
    let doc: ComicDoc = makeSampleDoc();
    const studio = { doc, error: null as string | null };
    const step = vi.fn(async (a: StudioAction) => {
      if (a.type === 'render_pages') {
        // The stream committed a gate; the next render reads it through the guard.
        doc = { ...doc, gate: { id: 'gate_new', action: a as never, title: 't', summary: 's', estimateUsd: 0.2, imageCount: 1, model: 'm', createdAt: 1, status: 'open', reason: 'budget' } };
      }
    });
    const { result, rerender } = renderHook(() => {
      const guard = useStudioSequenceGuard({ ...studio, doc });
      return useAction(step, { guard });
    });
    let ok = true;
    const run = result.current.run('retry-all', draw, { type: 'render_cover', quotedUsd: 0.07 });
    // React commits the stream's doc before the guard checks it.
    rerender();
    await act(async () => {
      ok = await run;
    });
    expect(ok).toBe(false);
    expect(step).toHaveBeenCalledTimes(1);
  });

  it('the guard also stops on a new error, and lets a clean sequence through', async () => {
    const live = { doc: makeSampleDoc(), error: null as string | null };
    const step = vi.fn(async (a: StudioAction) => {
      if (a.type === 'approve_plan') live.error = 'Couldn’t approve the plan.';
    });
    const { result } = renderHook(() => useAction(step, { guard: useStudioSequenceGuard(live) }));
    await act(async () => {
      await result.current.run('k', approve, draw);
    });
    expect(step).toHaveBeenCalledTimes(1);

    const clean = vi.fn(async () => undefined);
    const ok = { doc: makeSampleDoc(), error: null as string | null };
    const { result: r2 } = renderHook(() => useAction(clean, { guard: useStudioSequenceGuard(ok) }));
    await act(async () => {
      await r2.current.run('k', approve, draw);
    });
    await waitFor(() => expect(clean).toHaveBeenCalledTimes(2));
  });
});

// Keep React in scope for the JSX-free hook tests (tsconfig jsx: react).
void React;
