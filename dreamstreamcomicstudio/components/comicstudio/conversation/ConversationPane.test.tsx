import React from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';


import type { Msg } from '../../../shared/comic/doc';
import { ConversationPane } from './ConversationPane';
import { STARTERS } from './EmptyConversation';
import { makeFakeStudio, makeSampleDoc, resetUsageStatus, showDollarPrices } from './testing/fixtures';

// Dollar figures below are what admins / own-key users see; the governed wording has its own tests.
beforeEach(showDollarPrices);
afterEach(resetUsageStatus);

const msg = (id: string, role: Msg['role'], text: string, extra: Partial<Msg> = {}): Msg => ({ id, role, text, at: 1, ...extra });

describe('ConversationPane — empty state', () => {
  it('invites the first message with starters and the two other ways in', () => {
    const studio = makeFakeStudio();
    render(<ConversationPane studio={studio} />);
    expect(screen.getByRole('heading', { name: "What's your comic about?" })).toBeInTheDocument();
    for (const s of STARTERS) expect(screen.getByRole('button', { name: s.label })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Paste a script/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Add character photos/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: STARTERS[0].label }));
    expect(studio.send).toHaveBeenCalledWith(STARTERS[0].text);
  });

  it('a prefill starter fills the composer instead of sending', async () => {
    const studio = makeFakeStudio();
    render(<ConversationPane studio={studio} />);
    fireEvent.click(screen.getByRole('button', { name: 'Turn my script into a 6-page comic' }));
    expect(studio.send).not.toHaveBeenCalled();
    const box = screen.getByLabelText('Message the Comic Director') as HTMLTextAreaElement;
    expect(box.value).toMatch(/^Turn my script into a 6-page comic/);
    expect(box.placeholder).toMatch(/Paste your script/);
  });

  it('"Paste a script" focuses the composer with a hint', () => {
    render(<ConversationPane studio={makeFakeStudio()} />);
    fireEvent.click(screen.getByRole('button', { name: /Paste a script/ }));
    expect((screen.getByLabelText('Message the Comic Director') as HTMLTextAreaElement).placeholder).toMatch(/Paste your script or story/);
  });
});

describe('ConversationPane — messages', () => {
  const conversation: Msg[] = [
    msg('u1', 'user', 'A heist comic', { attachments: [{ path: 'u/x/maya.webp', source: 'upload', at: 1 }] }),
    msg('a1', 'assistant', 'Got it — **Maya** leads.', {
      cards: [{ type: 'notice', id: 'n1', tone: 'success', text: 'Captured the cast.' }],
      suggestions: ['Show me 3 styles', 'Plan the pages']
    })
  ];

  it('renders user bubbles, director replies with markdown, cards and suggestions', () => {
    const studio = makeFakeStudio({ doc: makeSampleDoc({ conversation }) });
    render(<ConversationPane studio={studio} />);
    const log = screen.getByRole('log');
    expect(within(log).getByText('A heist comic')).toBeInTheDocument();
    expect(within(log).getByRole('img', { name: 'Photo 1' })).toHaveAttribute('src', 'https://cdn.test/u/x/maya.webp');
    expect(within(log).getByText('Maya').tagName).toBe('STRONG');
    expect(within(log).getByText('Captured the cast.')).toBeInTheDocument();
    fireEvent.click(within(log).getByRole('button', { name: 'Show me 3 styles' }));
    expect(studio.send).toHaveBeenCalledWith('Show me 3 styles');
  });

  it('suggestions only show under the latest reply, and not while a turn runs', () => {
    const later = [...conversation, msg('u2', 'user', 'Make it funnier')];
    const { unmount } = render(<ConversationPane studio={makeFakeStudio({ doc: makeSampleDoc({ conversation: later }) })} />);
    expect(screen.queryByRole('group', { name: 'Suggestions' })).not.toBeInTheDocument();
    unmount();
    render(<ConversationPane studio={makeFakeStudio({ doc: makeSampleDoc({ conversation }), messageBusy: true, busy: true })} />);
    expect(screen.queryByRole('group', { name: 'Suggestions' })).not.toBeInTheDocument();
  });

  it('streams draft text with a caret, and shows a thinking row before text arrives', () => {
    const { unmount } = render(
      <ConversationPane studio={makeFakeStudio({ doc: makeSampleDoc({ conversation }), messageBusy: true, busy: true, drafts: { a2: 'Drawing up a plan' } })} />
    );
    expect(screen.getByText('Drawing up a plan')).toBeInTheDocument();
    unmount();
    render(
      <ConversationPane
        studio={makeFakeStudio({
          doc: makeSampleDoc({ conversation: [...conversation, msg('u2', 'user', 'Next')] }),
          messageBusy: true,
          busy: true
        })}
      />
    );
    expect(within(screen.getByRole('log')).getByText('Thinking…')).toBeInTheDocument();
  });

  it('shows the pending message immediately, and a failed one with retry / edit / discard', () => {
    const studio = makeFakeStudio({
      doc: makeSampleDoc({ conversation }),
      pendingMessage: { id: 'pm', text: 'Add a twist', attachments: [], at: 1, status: 'failed', error: 'Out of credit' }
    });
    render(<ConversationPane studio={studio} />);
    expect(screen.getByText('Add a twist')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Not sent — Out of credit');
    fireEvent.click(screen.getByRole('button', { name: /Retry/ }));
    expect(studio.retryPendingMessage).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /Edit/ }));
    expect((screen.getByLabelText('Message the Comic Director') as HTMLTextAreaElement).value).toBe('Add a twist');
    expect(studio.dismissPendingMessage).toHaveBeenCalled();
  });
});

describe('ConversationPane — status', () => {
  it('shows the live activity line with collapsed extras and a Stop for jobs', () => {
    const studio = makeFakeStudio({
      busy: true,
      activity: [
        { id: 'x', label: 'Drawing page 1', phase: 'start', at: 1 },
        { id: 'y', label: 'Drawing page 2', phase: 'start', at: 2 },
        { id: 'z', label: 'Done thing', phase: 'end', ok: true, at: 3 }
      ]
    });
    render(<ConversationPane studio={studio} />);
    const line = screen.getByText('Drawing page 2…');
    expect(line).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '+1' }));
    expect(screen.getByText('Drawing page 1…')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^Stop$/ }));
    expect(studio.cancel).toHaveBeenCalled();
  });

  it('says when renders are still landing without a live stream', () => {
    render(<ConversationPane studio={makeFakeStudio({ renderingTotal: 2 })} />);
    expect(screen.getByText('2 images still drawing…')).toBeInTheDocument();
  });

  it('shows errors with resync and dismiss', () => {
    const studio = makeFakeStudio({ error: 'Connection lost — resyncing.' });
    render(<ConversationPane studio={studio} />);
    const alert = screen.getByRole('alert');
    fireEvent.click(within(alert).getByRole('button', { name: /Resync/ }));
    expect(studio.refresh).toHaveBeenCalled();
    fireEvent.click(within(alert).getByRole('button', { name: 'Dismiss' }));
    expect(studio.clearError).toHaveBeenCalled();
  });

  it('can show the board instead of messages while keeping the composer', () => {
    render(<ConversationPane studio={makeFakeStudio()} replaceList={<div>BOARD VIEW</div>} />);
    expect(screen.getByText('BOARD VIEW')).toBeInTheDocument();
    expect(screen.queryByRole('log')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Message the Comic Director')).toBeInTheDocument();
  });
});

describe('ConversationPane — layout (visualqa P2-1; mobile.md §3.9)', () => {
  it('an empty conversation starts at the top (the heading is never scrolled away on short phones)', () => {
    render(<ConversationPane studio={makeFakeStudio()} />);
    const log = screen.getByRole('log', { name: 'Messages' });
    expect((log.parentElement as HTMLElement).scrollTop).toBe(0);
    expect(screen.getByRole('heading', { name: "What's your comic about?" })).toBeInTheDocument();
  });

  it('pads the bottom safe area unless the phone tab bar owns it', () => {
    const { rerender } = render(<ConversationPane studio={makeFakeStudio()} />);
    const dock = document.querySelector('[data-composer-dock]') as HTMLElement;
    expect(dock.className).toContain('var(--sa-bottom-eff');
    rerender(<ConversationPane studio={makeFakeStudio()} insetBottom={false} />);
    expect((document.querySelector('[data-composer-dock]') as HTMLElement).className).not.toContain('var(--sa-bottom-eff');
  });

  it('older messages skip offscreen rendering (content-visibility) while the latest stay live', () => {
    const conversation = Array.from({ length: 9 }, (_, i) => msg(`m${i}`, i % 2 ? 'assistant' : 'user', `Message ${i}`));
    render(<ConversationPane studio={makeFakeStudio({ doc: makeSampleDoc({ conversation }) })} />);
    expect(document.querySelectorAll('.cv-auto').length).toBe(3);
  });
});
