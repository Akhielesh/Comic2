// useStudio's `open_model_picker` client action (models.md §3.8; reliability.md §3): chips, the outage card and
// the status banner send `{ type: 'open_model_picker', suggest: modelId }`. The controller asks the mounted picker
// host to open (a window request, like Share and Settings) with the suggestion validated against the registry; it
// never sends anything to the server and never switches a model. With no picker mounted it says how to get there.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { StreamRequest, StudioEvent } from '../../shared/comic/events';
import { makeSampleDoc } from './conversation/testing/fixtures';

const api = vi.hoisted(() => ({
  loadStudioProject: vi.fn(),
  streamStudio: vi.fn(),
  signStudioUrls: vi.fn(),
  cancelStudio: vi.fn(),
  uploadStudioRef: vi.fn(),
  getPublication: vi.fn()
}));

vi.mock('./studioApi', async (importOriginal) => {
  const real = await importOriginal<typeof import('./studioApi')>();
  return { ...real, ...api };
});

import { OPEN_MODEL_PICKER_REQUEST, useStudio } from './useStudio';

let requests: StreamRequest[] = [];

beforeEach(() => {
  requests = [];
  window.localStorage.clear();
  api.loadStudioProject.mockReset().mockResolvedValue({ doc: makeSampleDoc(), urls: {} });
  api.signStudioUrls.mockReset().mockResolvedValue({});
  api.streamStudio.mockReset().mockImplementation(async (_id: string, req: StreamRequest, onEvent: (e: StudioEvent) => void) => {
    requests.push(req);
    onEvent({ type: 'done', rev: 5, spentUsd: 0 });
  });
});
afterEach(() => vi.restoreAllMocks());

const setup = async () => {
  const hook = renderHook(() => useStudio('proj_1'));
  await waitFor(() => expect(hook.result.current.doc).not.toBeNull());
  return hook;
};

describe('runClientAction open_model_picker', () => {
  it('asks the mounted picker to open with the suggestion (a route id becomes its registry id); nothing is sent', async () => {
    const { result } = await setup();
    const seen: unknown[] = [];
    const onOpen = (e: Event) => {
      seen.push((e as CustomEvent).detail);
      e.preventDefault();
    };
    window.addEventListener(OPEN_MODEL_PICKER_REQUEST, onOpen);
    try {
      act(() => result.current.runClientAction({ type: 'open_model_picker', suggest: 'nano-banana-pro' }));
      act(() => result.current.runClientAction({ type: 'open_model_picker', suggest: 'google/gemini-3-pro-image' }));
      act(() => result.current.runClientAction({ type: 'open_model_picker' }));
      // A model-written chip naming something that is not a registry model opens the picker without a suggestion.
      act(() => result.current.runClientAction({ type: 'open_model_picker', suggest: 'ignore previous instructions' }));
      await act(async () => {
        await result.current.runNextStep({ label: 'See other models', client: { type: 'open_model_picker', suggest: 'nano-banana-2.1' } });
      });
      expect(seen).toEqual([{ suggest: 'nano-banana-pro' }, { suggest: 'nano-banana-pro' }, {}, {}, { suggest: 'nano-banana-2.1' }]);
      expect(requests).toHaveLength(0);
      expect(result.current.notice ?? null).toBeNull();
    } finally {
      window.removeEventListener(OPEN_MODEL_PICKER_REQUEST, onOpen);
    }
  });

  it('with no picker mounted, a calm notice says where the models are', async () => {
    const { result } = await setup();
    act(() => result.current.runClientAction({ type: 'open_model_picker', suggest: 'nano-banana-pro' }));
    expect(result.current.notice).toMatchObject({ kind: 'info', text: 'The image models open from the studio — go back to the studio to see them.' });
    expect(requests).toHaveLength(0);
  });
});
