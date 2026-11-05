// StudioComposer with the live queue (agent-editor plan §3 A1): Queue beside Stop while the director works, Enter
// queues into Up next, and a draft leaves the box only once it was sent or queued (G20).

import React, { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('../../../hooks/useDictation', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../../hooks/useDictation')>()), voiceInputSupported: () => false }));
vi.mock('../studioApi', async (importOriginal) => ({ ...(await importOriginal<typeof import('../studioApi')>()), deleteInboxRef: vi.fn(async () => undefined) }));

import { StudioComposer } from './StudioComposer';
import { QueuedMessages } from './QueuedMessages';
import { makeFakeStudio, resetUsageStatus, showDollarPrices } from './testing/fixtures';
import { FormFactorProvider, formFactorFor } from '../mobile/useFormFactor';
import type { QueuedNote } from '../messageQueue';
import type { ComicStudioController } from '../useStudio';
import type { SendOutcome } from '../types';

const DESKTOP = formFactorFor({ w: 1440, h: 900, coarse: false });
const PHONE = formFactorFor({ w: 360, h: 780, coarse: true });
const textarea = () => screen.getByLabelText('Message the Comic Director') as HTMLTextAreaElement;

/** A controller whose send() queues while the director works (as the live one does), rendered with its Up next. */
const QueueHarness: React.FC<{ busy?: boolean; outcome?: SendOutcome; spy: (text: string, opts?: unknown) => void; variant?: 'docked' | 'sheet'; onSent?: () => void }> = ({
  busy = true,
  outcome,
  spy,
  variant = 'docked',
  onSent
}) => {
  const [queue, setQueue] = useState<QueuedNote[]>([]);
  const studio: ComicStudioController = makeFakeStudio({
    messageBusy: busy,
    busy,
    turnLocked: busy,
    queue,
    queueHold: null,
    send: async (text: string, opts?: unknown) => {
      spy(text, opts);
      if (outcome) return outcome;
      if (!busy) return 'sent';
      setQueue((q) => [...q, { id: `n${q.length + 1}`, text: text.trim(), at: 1 }]);
      return 'queued';
    }
  });
  return (
    <FormFactorProvider value={variant === 'sheet' ? PHONE : DESKTOP}>
      <QueuedMessages studio={studio} />
      <StudioComposer studio={studio} variant={variant} onSent={onSent} />
    </FormFactorProvider>
  );
};

beforeEach(() => {
  window.localStorage.clear();
  showDollarPrices();
});
afterEach(() => {
  vi.restoreAllMocks();
  resetUsageStatus();
});

describe('StudioComposer — the live queue', () => {
  it('while the director works: the box stays open, Queue sits beside Stop, and says what it does', () => {
    const studio = makeFakeStudio({ messageBusy: true, busy: true, turnLocked: true, queue: [] });
    render(
      <FormFactorProvider value={DESKTOP}>
        <StudioComposer studio={studio} />
      </FormFactorProvider>
    );
    expect(textarea()).toBeEnabled();
    expect(textarea()).toHaveAttribute('placeholder', 'Add a note — it goes when the director finishes this step…');
    const queueBtn = screen.getByRole('button', { name: 'Queue' });
    expect(queueBtn).toHaveAttribute('title', 'Adds to Up next. The director reads it when it finishes this step');
    expect(queueBtn).toBeDisabled(); // nothing typed yet
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(studio.cancel).toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull();
  });

  it('Enter while busy queues the note: "Up next · 1" shows and the box clears', async () => {
    const spy = vi.fn();
    render(<QueueHarness spy={spy} />);
    fireEvent.change(textarea(), { target: { value: '  make it rain  ' } });
    fireEvent.keyDown(textarea(), { key: 'Enter' });
    expect(spy).toHaveBeenCalledWith('make it rain', []);
    await waitFor(() => expect(textarea().value).toBe(''));
    expect(screen.getByRole('heading', { name: 'Up next · 1' })).toBeInTheDocument();
    expect(screen.getByText('make it rain')).toBeInTheDocument();

    fireEvent.change(textarea(), { target: { value: 'add a cat' } });
    fireEvent.click(screen.getByRole('button', { name: 'Queue' }));
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Up next · 2' })).toBeInTheDocument());
    expect(textarea().value).toBe('');
  });

  it("keeps the draft when the outcome is 'refused' (the controller says why)", async () => {
    const spy = vi.fn();
    render(<QueueHarness spy={spy} outcome="refused" />);
    fireEvent.change(textarea(), { target: { value: 'the eleventh note' } });
    fireEvent.keyDown(textarea(), { key: 'Enter' });
    expect(spy).toHaveBeenCalled();
    // A queued note waits for the outcome before it leaves the box: no flash of an empty box.
    expect(textarea().value).toBe('the eleventh note');
    await act(async () => undefined);
    expect(textarea().value).toBe('the eleventh note');
    expect(screen.queryByRole('heading', { name: /Up next/ })).toBeNull();
  });

  it('a send that turns out refused after the box cleared brings the words back', async () => {
    const spy = vi.fn();
    render(<QueueHarness spy={spy} busy={false} outcome="refused" />);
    fireEvent.change(textarea(), { target: { value: 'hello there' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(textarea().value).toBe('hello there'));
  });

  it('the phone ask sheet stays open on a queued note and shows its Up next', async () => {
    const spy = vi.fn();
    const onSent = vi.fn();
    render(<QueueHarness spy={spy} variant="sheet" onSent={onSent} />);
    fireEvent.change(textarea(), { target: { value: 'darker sky' } });
    fireEvent.click(screen.getByRole('button', { name: 'Queue' }));
    await waitFor(() => expect(textarea().value).toBe(''));
    expect(onSent).not.toHaveBeenCalled();
    // The sheet's own composer lists the note (the conversation's Up next is a chip on phones).
    expect(screen.getAllByText('darker sky').length).toBeGreaterThan(0);
  });

  it('with the queue off nothing changes: Stop only, Enter does nothing, the draft stays', () => {
    const studio = makeFakeStudio({ messageBusy: true, busy: true });
    render(
      <FormFactorProvider value={DESKTOP}>
        <StudioComposer studio={studio} />
      </FormFactorProvider>
    );
    fireEvent.change(textarea(), { target: { value: 'hi' } });
    fireEvent.keyDown(textarea(), { key: 'Enter' });
    expect(studio.send).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Queue' })).toBeNull();
    expect(textarea().value).toBe('hi');
  });
});
