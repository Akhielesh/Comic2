import React, { StrictMode } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../chat/DictationButton', () => ({ DictationButton: () => null }));
import { StudioComposer } from './StudioComposer';
import { makeFakeStudio } from './testing/fixtures';
import { setComposerDraftAccount } from '../../../services/composerDrafts';
import { clearOtherOpeningIdeas, prepareOpeningIdea } from '../openingIdea';
import type { MessageSendOptions } from '../useStudio';
const box = () => screen.getByRole('textbox', { name: 'Message the Comic Director' });
beforeEach(() => { setComposerDraftAccount(null); clearOtherOpeningIdeas(null); sessionStorage.clear(); setComposerDraftAccount('alice'); });

describe('Director draft continuity and opening handoff', () => {
  it('Start is attempted exactly once across StrictMode, unmount and reload-style remount; failure retains its words', async () => {
    const studio = makeFakeStudio({ confirmsMessages: true });
    const idea = { id: 'opening-once', text: 'A moon garden' };
    prepareOpeningIdea('alice', studio.doc!.id, idea);
    studio.send.mockImplementation(async (_text, options: MessageSendOptions) => { options.onAccepted?.(false); return 'refused'; });
    const view = render(<StrictMode><StudioComposer studio={studio} draftAccountId="alice" initialIdea={idea} /></StrictMode>);
    await act(async () => {});
    expect(studio.send).toHaveBeenCalledTimes(1);
    expect(studio.send).toHaveBeenCalledWith(idea.text, expect.objectContaining({ planningOnly: true }));
    expect(box()).toHaveValue(idea.text);
    view.unmount();
    render(<StudioComposer studio={studio} draftAccountId="alice" initialIdea={idea} />);
    expect(box()).toHaveValue(idea.text);
    expect(studio.send).toHaveBeenCalledTimes(1);
  });
  it('keeps the draft until server acknowledgement, then preserves concurrently typed text', async () => {
    const studio = makeFakeStudio({ confirmsMessages: true });
    let receipt: ((ok: boolean) => void) | undefined;
    studio.send.mockImplementation(async (_text, options: MessageSendOptions) => { receipt = options.onAccepted; return 'sent'; });
    const view = render(<StudioComposer studio={studio} draftAccountId="alice" />);
    fireEvent.change(box(), { target: { value: 'First message' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(box()).toHaveValue('First message');
    fireEvent.change(box(), { target: { value: 'Next message while waiting' } });
    act(() => receipt?.(true));
    expect(box()).toHaveValue('Next message while waiting');
    view.unmount();
    render(<StudioComposer studio={studio} draftAccountId="alice" />);
    expect(box()).toHaveValue('Next message while waiting');
  });
  it('clears a successful unchanged draft even after leaving the composer', async () => {
    const studio = makeFakeStudio({ confirmsMessages: true });
    let receipt: ((ok: boolean) => void) | undefined;
    studio.send.mockImplementation(async (_text, options: MessageSendOptions) => { receipt = options.onAccepted; return 'sent'; });
    const view = render(<StudioComposer studio={studio} draftAccountId="alice" />);
    fireEvent.change(box(), { target: { value: 'This is sent' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    view.unmount(); act(() => receipt?.(true));
    render(<StudioComposer studio={studio} draftAccountId="alice" />);
    expect(box()).toHaveValue('');
  });
  it('a refusal that arrives after navigation never erases the persisted draft', async () => {
    const studio = makeFakeStudio({ confirmsMessages: true });
    let finish!: (value: 'refused') => void;
    studio.send.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const view = render(<StudioComposer studio={studio} draftAccountId="alice" />);
    fireEvent.change(box(), { target: { value: 'Keep this through a late refusal' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    view.unmount(); await act(async () => finish('refused'));
    render(<StudioComposer studio={studio} draftAccountId="alice" />);
    expect(box()).toHaveValue('Keep this through a late refusal');
  });

});
