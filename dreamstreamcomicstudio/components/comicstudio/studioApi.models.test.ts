// studioApi.changeImageModel (models.md §3.4 item 7): the confirm's action is built exactly — `ack: true`, a
// registry id, a known redraw scope and a finite non-negative quote ('none' is always 0) — and anything else is
// refused here with calm copy, so a malformed switch never reaches the server.

import { describe, expect, it, vi } from 'vitest';
import { StudioApiError, buildChangeImageModelAction, changeImageModel } from './studioApi';
import type { RedrawScope } from '../../shared/comic/doc';

describe('buildChangeImageModelAction', () => {
  it('builds the acknowledged action with the quote shown (rounded to 4 decimals)', () => {
    expect(buildChangeImageModelAction({ modelId: 'nano-banana-pro', redraw: 'pages_cover', quotedUsd: 1.067812 })).toEqual({
      type: 'change_image_model',
      modelId: 'nano-banana-pro',
      redraw: 'pages_cover',
      quotedUsd: 1.0678,
      ack: true
    });
  });

  it('"keep them as they are" always quotes 0; a route id resolves to its registry id', () => {
    expect(buildChangeImageModelAction({ modelId: 'google/gemini-3-pro-image', redraw: 'none', quotedUsd: 3 })).toMatchObject({ modelId: 'nano-banana-pro', redraw: 'none', quotedUsd: 0, ack: true });
  });

  it('refuses an unknown model, scope or a missing / negative quote', () => {
    expect(() => buildChangeImageModelAction({ modelId: 'not-a-model', redraw: 'none', quotedUsd: 0 })).toThrow(StudioApiError);
    expect(() => buildChangeImageModelAction({ modelId: 'nano-banana-pro', redraw: 'some' as RedrawScope, quotedUsd: 0 })).toThrow(/nothing was changed/);
    expect(() => buildChangeImageModelAction({ modelId: 'nano-banana-pro', redraw: 'all', quotedUsd: Number.NaN })).toThrow(/can't be priced/);
    expect(() => buildChangeImageModelAction({ modelId: 'nano-banana-pro', redraw: 'all', quotedUsd: -1 })).toThrow(StudioApiError);
  });
});

describe('changeImageModel', () => {
  it('sends the action through the controller and resolves its outcome', async () => {
    const outcome = { ok: true, aborted: false, retryable: false, gated: true };
    const act = vi.fn(async () => outcome);
    await expect(changeImageModel(act, { modelId: 'nano-banana-pro', redraw: 'all', quotedUsd: 1.7667 })).resolves.toBe(outcome);
    expect(act).toHaveBeenCalledWith({ type: 'change_image_model', modelId: 'nano-banana-pro', redraw: 'all', quotedUsd: 1.7667, ack: true });
  });

  it('never calls the controller for an invalid switch', async () => {
    const act = vi.fn();
    await expect(changeImageModel(act, { modelId: 'x', redraw: 'none', quotedUsd: 0 })).rejects.toBeInstanceOf(StudioApiError);
    expect(act).not.toHaveBeenCalled();
  });
});
