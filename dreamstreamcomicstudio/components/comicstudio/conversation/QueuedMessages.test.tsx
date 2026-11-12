// "Up next" (agent-editor plan §3 A1): edit, reorder, remove, Send now, and the words for every hold.

import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueuedMessages } from './QueuedMessages';
import { ConversationPane } from './ConversationPane';
import { makeFakeStudio } from './testing/fixtures';
import { FormFactorProvider, formFactorFor } from '../mobile/useFormFactor';
import { QUEUE_NOTE_MAX_CHARS, type QueuedNote } from '../messageQueue';
import type { ComicStudioController } from '../useStudio';

const DESKTOP = formFactorFor({ w: 1440, h: 900, coarse: false });
const PHONE = formFactorFor({ w: 360, h: 780, coarse: true });

const notes: QueuedNote[] = [
  { id: 'n1', text: 'make it rain', at: 1 },
  { id: 'n2', text: 'darker sky on this page', focus: { pageId: 'pg_2', lineIds: ['ln_1', 'ln_2'] }, at: 2 },
  { id: 'n3', text: 'add a cat', inboxPaths: ['u/x/inbox/cat.webp'], at: 3 }
];

const queueStudio = (over: Partial<ComicStudioController> = {}) =>
  makeFakeStudio({
    queue: notes,
    queueHold: null,
    turnLocked: true,
    messageBusy: true,
    editQueued: vi.fn(),
    moveQueued: vi.fn(),
    moveQueuedTo: vi.fn(),
    removeQueued: vi.fn(),
    clearQueue: vi.fn(),
    releaseQueue: vi.fn(),
    sendNow: vi.fn(async () => 'sent' as const),
    ...over
  });

const renderAt = (studio: ComicStudioController, ff = DESKTOP) =>
  render(
    <FormFactorProvider value={ff}>
      <QueuedMessages studio={studio} />
    </FormFactorProvider>
  );

afterEach(() => vi.restoreAllMocks());

describe('QueuedMessages', () => {
  it('lists the notes in order under "Up next · 3", with what each is about', () => {
    renderAt(queueStudio());
    const block = screen.getByRole('region', { name: 'Up next, 3 notes' });
    expect(within(block).getByRole('heading', { name: 'Up next · 3' })).toBeInTheDocument();
    const items = within(screen.getByRole('list', { name: 'Queued notes' })).getAllByRole('listitem');
    expect(items.map((li) => li.querySelector('p')?.textContent)).toEqual(['make it rain', 'darker sky on this page', 'add a cat']);
    expect(items[1]).toHaveTextContent('Page 2 · 2 balloons');
    expect(items[2]).toHaveTextContent('1 photo');
    // Never silent: while the director works the queue says when the notes go.
    expect(within(block).getByRole('status')).toHaveTextContent('The director reads these when it finishes this step.');
  });

  it('renders nothing while the queue is off or empty', () => {
    const { container, rerender } = renderAt(makeFakeStudio());
    expect(container).toBeEmptyDOMElement();
    rerender(
      <FormFactorProvider value={DESKTOP}>
        <QueuedMessages studio={queueStudio({ queue: [] })} />
      </FormFactorProvider>
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('edits a note inline: Save writes it, Escape cancels', () => {
    const studio = queueStudio();
    renderAt(studio);
    fireEvent.click(screen.getByRole('button', { name: 'Edit note 2' }));
    const box = screen.getByRole('textbox', { name: 'Edit note 2' });
    expect(box).toHaveValue('darker sky on this page');
    fireEvent.change(box, { target: { value: '  much darker sky  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(studio.editQueued).toHaveBeenCalledWith('n2', 'much darker sky');
    expect(screen.queryByRole('textbox', { name: 'Edit note 2' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Edit note 1' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Edit note 1' }), { target: { value: 'never mind' } });
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Edit note 1' }), { key: 'Escape' });
    expect(studio.editQueued).toHaveBeenCalledTimes(1);
    // An empty edit cannot be saved (Remove is how a note goes).
    fireEvent.click(screen.getByRole('button', { name: 'Edit note 3' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Edit note 3' }), { target: { value: '   ' } });
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    // Enter saves with a mouse.
    fireEvent.change(screen.getByRole('textbox', { name: 'Edit note 3' }), { target: { value: 'add two cats' } });
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Edit note 3' }), { key: 'Enter' });
    expect(studio.editQueued).toHaveBeenLastCalledWith('n3', 'add two cats');
  });

  it('an edit too long to wait keeps the editor open and says so — never dropped without a word', () => {
    const studio = queueStudio();
    renderAt(studio);
    fireEvent.click(screen.getByRole('button', { name: 'Edit note 1' }));
    const box = screen.getByRole('textbox', { name: 'Edit note 1' });
    fireEvent.change(box, { target: { value: 'x'.repeat(QUEUE_NOTE_MAX_CHARS + 1) } });
    expect(screen.getByRole('alert')).toHaveTextContent('Too long to wait in Up next.');
    expect(box).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(studio.editQueued).not.toHaveBeenCalled();
    expect(screen.getByRole('textbox', { name: 'Edit note 1' })).toHaveValue('x'.repeat(QUEUE_NOTE_MAX_CHARS + 1));
    // Back within the bound, it saves.
    fireEvent.change(box, { target: { value: 'x'.repeat(QUEUE_NOTE_MAX_CHARS) } });
    expect(screen.queryByRole('alert')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(studio.editQueued).toHaveBeenCalledWith('n1', 'x'.repeat(QUEUE_NOTE_MAX_CHARS));
  });

  it('reorders with ↑ / ↓ (disabled at the ends) and by dragging with a mouse', () => {
    const studio = queueStudio();
    renderAt(studio);
    expect(screen.getByRole('button', { name: 'Move note 1 up' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Move note 3 down' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Move note 2 up' }));
    expect(studio.moveQueued).toHaveBeenCalledWith('n2', -1);
    fireEvent.click(screen.getByRole('button', { name: 'Move note 1 down' }));
    expect(studio.moveQueued).toHaveBeenCalledWith('n1', 1);

    const rows = within(screen.getByRole('list', { name: 'Queued notes' })).getAllByRole('listitem');
    expect(rows[2]).toHaveAttribute('draggable', 'true');
    fireEvent.dragStart(rows[2]);
    fireEvent.dragOver(rows[0]);
    fireEvent.drop(rows[0]);
    expect(studio.moveQueuedTo).toHaveBeenCalledWith('n3', 0);
  });

  it('removes a note', () => {
    const studio = queueStudio();
    renderAt(studio);
    fireEvent.click(screen.getByRole('button', { name: 'Remove note 3' }));
    expect(studio.removeQueued).toHaveBeenCalledWith('n3');
  });

  it('offers Send now on the first note only, and says so while the director stops first', async () => {
    const studio = queueStudio();
    const { rerender } = renderAt(studio);
    const buttons = screen.getAllByRole('button', { name: /Send now/ });
    expect(buttons).toHaveLength(1);
    expect(within(within(screen.getByRole('list', { name: 'Queued notes' })).getAllByRole('listitem')[0]).getByRole('button', { name: /Send now/ })).toBe(buttons[0]);
    fireEvent.click(buttons[0]);
    await waitFor(() => expect(studio.sendNow).toHaveBeenCalledWith('n1'));

    rerender(
      <FormFactorProvider value={DESKTOP}>
        <QueuedMessages studio={queueStudio({ queueSendingNow: 'n1', cancelling: true })} />
      </FormFactorProvider>
    );
    expect(screen.getByRole('button', { name: /Stopping, then sending/ })).toBeDisabled();
  });

  it('a steer refused NOT_RUNNING, BUSY or LIMIT goes next without a Stop: the button never says "Stopping"', () => {
    // useStudio.sendNow put the note first (queue_express) and did not stop the director (no cancel in flight).
    const { rerender } = renderAt(queueStudio({ queueSteers: true, queueSendingNow: 'n1', cancelling: false }));
    const waiting = screen.getByRole('button', { name: 'Goes next, after this step' });
    expect(waiting).toBeDisabled();
    expect(screen.queryByText(/Stopping/)).toBeNull();
    // The step ended on its own: the note is on its way.
    rerender(
      <FormFactorProvider value={DESKTOP}>
        <QueuedMessages studio={queueStudio({ queueSteers: true, queueSendingNow: 'n1', messageBusy: false, turnLocked: false })} />
      </FormFactorProvider>
    );
    expect(screen.getByRole('button', { name: 'Sending next…' })).toBeDisabled();
  });

  it("Send now's tooltip says what it will really do: steer, stop first, wait for the plan, or send", () => {
    const titleWith = (over: Partial<ComicStudioController>, list: QueuedNote[] = notes) => {
      const { unmount } = renderAt(queueStudio({ queue: list, ...over }));
      const title = screen.getByRole('button', { name: /Send now/ }).getAttribute('title');
      unmount();
      return title;
    };
    expect(titleWith({ queueSteers: true })).toBe('Adds it to what the director is doing now');
    // A steer carries text only: a note with photos stops the director first.
    expect(titleWith({ queueSteers: true }, [notes[2], notes[0]])).toBe('Send this note now — the director stops its current step first');
    expect(titleWith({ queueSteers: false })).toBe('Send this note now — the director stops its current step first');
    expect(titleWith({ messageBusy: false, turnLocked: true })).toBe('Sends it as soon as the plan is in');
    expect(titleWith({ messageBusy: false, turnLocked: false, queueHold: 'restored' })).toBe('Send this note now');
  });

  it('every hold has its words and its one tap out', () => {
    const question = queueStudio({ queueHold: 'question', turnLocked: false, messageBusy: false });
    const { rerender } = renderAt(question);
    expect(screen.getByRole('status')).toHaveTextContent('Answer the question above first, or');
    fireEvent.click(screen.getByRole('button', { name: 'Send anyway' }));
    expect(question.releaseQueue).toHaveBeenCalled();

    // An open spend gate reads the same as an unanswered question (plan §3 A1).
    const gate = queueStudio({ queueHold: 'gate', turnLocked: false, messageBusy: false });
    rerender(
      <FormFactorProvider value={DESKTOP}>
        <QueuedMessages studio={gate} />
      </FormFactorProvider>
    );
    expect(screen.getByRole('status')).toHaveTextContent('Answer the question above first, or');
    fireEvent.click(screen.getByRole('button', { name: 'Send anyway' }));
    expect(gate.releaseQueue).toHaveBeenCalled();

    const failed = queueStudio({ queueHold: 'failed', turnLocked: false, messageBusy: false });
    rerender(
      <FormFactorProvider value={DESKTOP}>
        <QueuedMessages studio={failed} />
      </FormFactorProvider>
    );
    expect(screen.getByRole('status')).toHaveTextContent('Your last message didn’t go. Try again or dismiss it first, or');
    fireEvent.click(screen.getByRole('button', { name: 'Send anyway' }));
    expect(failed.releaseQueue).toHaveBeenCalled();

    const stopped = queueStudio({ queueHold: 'stopped', turnLocked: false, messageBusy: false });
    rerender(
      <FormFactorProvider value={DESKTOP}>
        <QueuedMessages studio={stopped} />
      </FormFactorProvider>
    );
    expect(screen.getByRole('status')).toHaveTextContent('Stopped. 3 notes are waiting.');
    fireEvent.click(within(screen.getByRole('region')).getAllByRole('button', { name: 'Send now' })[0]);
    expect(stopped.releaseQueue).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Clear Up next' }));
    expect(stopped.clearQueue).toHaveBeenCalled();

    const elsewhere = queueStudio({ queueHold: 'elsewhere', queueRetriesLeft: false, turnLocked: false, messageBusy: false });
    rerender(
      <FormFactorProvider value={DESKTOP}>
        <QueuedMessages studio={elsewhere} />
      </FormFactorProvider>
    );
    expect(screen.getByRole('status')).toHaveTextContent('Still busy in another tab or on another device.');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(elsewhere.releaseQueue).toHaveBeenCalled();

    rerender(
      <FormFactorProvider value={DESKTOP}>
        <QueuedMessages studio={queueStudio({ queueHold: 'restored', turnLocked: false, messageBusy: false })} />
      </FormFactorProvider>
    );
    expect(screen.getByRole('status')).toHaveTextContent('3 notes were waiting.');
    expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument();
  });

  it('on a phone it is one "Up next · 3" chip that opens a sheet with the same controls (44 px targets)', () => {
    const studio = queueStudio();
    renderAt(studio, PHONE);
    expect(screen.queryByRole('list', { name: 'Queued notes' })).toBeNull();
    const chip = screen.getByRole('button', { name: /Up next · 3/ });
    expect(chip.className).toContain('coarse:min-h-11');
    fireEvent.click(chip);
    const sheet = screen.getByRole('dialog', { name: 'Up next' });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Remove note 2' }));
    expect(studio.removeQueued).toHaveBeenCalledWith('n2');
    for (const b of within(sheet).getAllByRole('button', { name: /note \d/ })) expect(b.className).toContain('coarse:h-11');
    // No drag on touch: the arrows do it.
    expect(within(within(sheet).getByRole('list', { name: 'Queued notes' })).getAllByRole('listitem')[0]).toHaveAttribute('draggable', 'false');
  });

  it('ConversationPane docks Up next under the activity line, above the composer', () => {
    render(
      <FormFactorProvider value={DESKTOP}>
        <ConversationPane studio={queueStudio({ activity: [{ id: 'a1', label: 'Drawing page 2', phase: 'start', at: 1 }] })} />
      </FormFactorProvider>
    );
    const upNext = screen.getByRole('region', { name: 'Up next, 3 notes' });
    const composer = screen.getByLabelText('Message the Comic Director');
    const activity = screen.getByText(/Drawing page 2/);
    expect(activity.compareDocumentPosition(upNext) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(upNext.compareDocumentPosition(composer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
