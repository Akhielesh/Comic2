// The picker host (header slot): every open_model_picker request opens the picker — including the payload the
// reliability OutageCard dispatches for "Try {model} instead" (`{ type: 'open_model_picker', suggest: modelId }`) —
// with the suggestion highlighted; a pick opens the confirm; only the confirm sends change_image_model. The feature
// module registers the host at the banner tier.

import React from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CAPS, type StudioCaps } from '../../../shared/comic/capabilities';
import type { Card, Msg } from '../../../shared/comic/doc';
import type { ModelHealth, OutageOption } from '../../../shared/comic/modelHealth';
import type { ModelCatalogRow } from '../../../shared/comic/modelCatalog';
import { makeFakeStudio, resetUsageStatus, showDollarPrices } from '../conversation/testing/fixtures';
import { OutageCard } from '../reliability/OutageCard';
import { __resetStatusStore, __setStatusFetcherForTests } from '../reliability/statusStore';
import { OPEN_MODEL_PICKER_REQUEST } from '../useStudio';
import { feature } from './index';
import { MODEL_PICKER_SLOT_ORDER, ModelPickerHost } from './ModelPickerHost';
import { OPEN_MODEL_PICKER_EVENT, requestOpenModelPicker } from './openPicker';
import { __resetModelCatalogForTests } from './useModelCatalog';
import { NOW, catalogRows, lakeDoc } from './testing/fixtures';

const PAID: StudioCaps = { ...DEFAULT_CAPS, plan: 'paid', modelOverride: true, qualityTiers: ['draft', 'standard', 'pro'] };

beforeEach(() => {
  __resetStatusStore();
  __setStatusFetcherForTests(async (ids) => ids.map((modelId): ModelHealth => ({ modelId, state: modelId === 'nano-banana-2.1' ? 'down' : 'ok', checkedAt: NOW, routes: [] })));
  __resetModelCatalogForTests({ catalog: (async () => catalogRows()) as (p?: string) => Promise<ModelCatalogRow[]> });
  showDollarPrices();
});
afterEach(() => {
  __setStatusFetcherForTests(null);
  resetUsageStatus();
});

const studioFor = () => {
  const studio = makeFakeStudio({ doc: lakeDoc(), caps: PAID, mode: 'easy' });
  // As useStudio does: the client action becomes the window request the host answers.
  studio.runClientAction = vi.fn((action) => {
    if (action.type === 'open_model_picker') requestOpenModelPicker({ suggest: action.suggest });
  });
  return studio;
};

describe('ModelPickerHost', () => {
  it('is registered as a banner-tier header slot and renders nothing until asked', () => {
    expect(feature.headerSlots?.map((s) => [s.id, s.order])).toEqual([['model-picker', MODEL_PICKER_SLOT_ORDER]]);
    expect(MODEL_PICKER_SLOT_ORDER).toBeGreaterThanOrEqual(1000);
    const { container } = render(<ModelPickerHost studio={studioFor()} />);
    expect(container.innerHTML).toBe('');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('useStudio raises the same event the host answers', () => {
    expect(OPEN_MODEL_PICKER_REQUEST).toBe(OPEN_MODEL_PICKER_EVENT);
  });

  it('the outage card’s "Try Nano Banana Pro instead" opens the picker with it highlighted; the pick goes through the confirm', async () => {
    const studio = studioFor();
    const switchPro: OutageOption = { kind: 'switch_model', modelId: 'nano-banana-pro', nickname: 'Nano Banana Pro', usdPerImage: 0.1747, consistency: 'same_family', redrawCount: 10, redrawUsd: 1.7667 };
    const card: Extract<Card, { type: 'model_outage' }> = {
      type: 'model_outage',
      id: 'out_1',
      modelId: 'nano-banana-2.1',
      options: [{ kind: 'wait_and_retry' }, switchPro],
      blockedAction: { type: 'render_pages', pageIds: ['pg_1'], quotedUsd: 0.05 },
      origin: 'preflight'
    };
    const msg: Msg = { id: 'm1', role: 'assistant', text: '', at: NOW };
    render(
      <>
        <OutageCard card={card} message={msg} studio={studio} />
        <ModelPickerHost studio={studio} />
      </>
    );
    await act(async () => undefined);
    fireEvent.click(screen.getByRole('button', { name: /Try Nano Banana Pro instead/ }));
    expect(studio.runClientAction).toHaveBeenCalledWith({ type: 'open_model_picker', suggest: 'nano-banana-pro' });
    await act(async () => undefined);
    const sheet = screen.getByRole('dialog', { name: 'Image model' });
    const pro = sheet.querySelector<HTMLElement>('li[data-model="nano-banana-pro"]')!;
    expect(pro).toHaveAttribute('data-suggested');
    expect(within(pro).getByText('Suggested')).toBeInTheDocument();
    // Nothing switched yet.
    expect(studio.act).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'change_image_model' }));

    fireEvent.click(within(pro).getByRole('button', { name: 'Nano Banana Pro' }));
    const confirm = screen.getByRole('alertdialog', { name: 'Switch this comic to Nano Banana Pro?' });
    expect(confirm).toHaveTextContent('character consistency can be affected');
    await act(async () => fireEvent.click(within(confirm).getByRole('button', { name: 'Switch to Nano Banana Pro' })));
    expect(studio.act).toHaveBeenCalledWith({ type: 'change_image_model', modelId: 'nano-banana-pro', redraw: 'none', quotedUsd: 0, ack: true });
    // Done: the confirm and the picker close (the notice lands in the conversation).
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.queryByRole('dialog', { name: 'Image model' })).toBeNull();
  });

  it('"Keep {Current}" closes only the confirm; the picker stays open', async () => {
    const studio = studioFor();
    render(<ModelPickerHost studio={studio} />);
    act(() => {
      requestOpenModelPicker();
    });
    await act(async () => undefined);
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Image model' })).getByRole('button', { name: 'Nano Banana Pro' }));
    fireEvent.click(screen.getByRole('button', { name: 'Keep Nano Banana 2.1' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.getByRole('dialog', { name: 'Image model' })).toBeInTheDocument();
    expect(studio.act).not.toHaveBeenCalled();
  });

  it('a suggestion that is not a registry model is dropped (chips come from the model)', async () => {
    render(<ModelPickerHost studio={studioFor()} />);
    act(() => {
      expect(requestOpenModelPicker({ suggest: 'definitely-not-a-model' })).toBe(true);
    });
    await act(async () => undefined);
    expect(document.querySelector('li[data-suggested]')).toBeNull();
  });
});
