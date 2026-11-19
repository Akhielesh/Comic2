// Q-SETTLE in the real pane: the agent's options are live only while they are the newest ask and nobody answered them.
// Driven by stored message sequences (and this tab's message on its way), so a reload shows the same.

import React from 'react';
import { render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Card, ComicDoc, Msg } from '../../../shared/comic/doc';
import { DEFAULT_CAPS } from '../../../shared/comic/capabilities';
import type { PendingUserMessage } from '../studioReducer';
import type { QueuedNote } from '../messageQueue';
import { ConversationPane } from './ConversationPane';
import { __resetEntrances } from './MessageItem';
import { makeFakeStudio, makeSampleDoc, resetUsageStatus, showDollarPrices } from './testing/fixtures';

beforeEach(() => {
  showDollarPrices();
  __resetEntrances();
});
afterEach(resetUsageStatus);

const CONTROLS = 'button:not([disabled]), input:not([disabled]), [role="radio"]';
const look: Card = {
  type: 'options',
  id: 'q_look',
  question: 'Which look for the heist?',
  allowCustom: true,
  choices: [
    { id: 'c1', label: 'Noir ink' },
    { id: 'c2', label: 'Crayon' }
  ]
};
const steps = [
  { label: 'Make it funnier', say: 'Make it funnier' },
  { label: 'Make the cover', action: { type: 'render_cover' as const, quotedUsd: 0.07 }, usd: 0.07 }
];
const asked: Msg[] = [
  { id: 'u0', role: 'user', text: 'A heist comic in Mumbai', at: 1 },
  { id: 'a1', role: 'assistant', text: 'Two looks came to mind.', at: 2, cards: [look], nextSteps: steps }
];
/** What the server posts after the creator taps "Make the cover": a progress message, no user message. */
const progress: Msg = {
  id: 'a2',
  role: 'assistant',
  text: 'Drawing the cover (≈$0.07).',
  at: 3,
  cards: [{ type: 'renders', id: 'r_cover', targets: [{ kind: 'cover' }], label: 'Drawing the cover' }]
};
const reload = (doc: ComicDoc): ComicDoc => JSON.parse(JSON.stringify(doc)) as ComicDoc;
const slot = (container: HTMLElement, id: string) => container.querySelector(`[data-card-slot="${id}"]`) as HTMLElement | null;
const sending = (text: string, extra: Partial<PendingUserMessage> = {}): PendingUserMessage =>
  ({ id: 'pm1', text, attachments: [], status: 'sending', at: 4, ...extra }) as PendingUserMessage;

describe('the options vanish once the conversation has moved on', () => {
  it('control: the newest ask shows its question and its chips', () => {
    const { container } = render(<ConversationPane studio={makeFakeStudio({ doc: makeSampleDoc({ conversation: asked }), caps: DEFAULT_CAPS })} />);
    expect(slot(container, 'q_look')!.querySelectorAll(CONTROLS).length).toBeGreaterThan(1);
    expect(screen.getByRole('group', { name: 'Next steps' })).toBeInTheDocument();
  });

  it('(c) a later assistant turn (the cover the creator asked for is drawing) takes the unanswered question away entirely, after a reload too', () => {
    const doc = makeSampleDoc({ conversation: [...asked, progress] });
    for (const d of [doc, reload(doc)]) {
      const { container, unmount } = render(<ConversationPane studio={makeFakeStudio({ doc: d, caps: DEFAULT_CAPS })} />);
      expect(slot(container, 'q_look')).toBeNull();
      expect(screen.queryByText('Which look for the heist?')).toBeNull();
      expect(screen.queryByText(/Not answered/)).toBeNull();
      // The reply's words stay; only the options went.
      expect(screen.getByText('Two looks came to mind.')).toBeInTheDocument();
      unmount();
    }
  });

  it('(b) a typed reply takes the question and the chips away at once, and they stay gone once it is committed', () => {
    const studio = makeFakeStudio({ doc: makeSampleDoc({ conversation: asked }), caps: DEFAULT_CAPS, pendingMessage: sending('Actually, a western') });
    const { container, rerender } = render(<ConversationPane studio={studio} />);
    expect(slot(container, 'q_look')).toBeNull();
    expect(screen.queryByRole('group', { name: 'Next steps' })).toBeNull();
    const committed = makeSampleDoc({ conversation: [...asked, { id: 'u1', role: 'user', text: 'Actually, a western', at: 4 }] });
    rerender(<ConversationPane studio={{ ...studio, doc: reload(committed), pendingMessage: null, messageBusy: true }} />);
    expect(slot(container, 'q_look')).toBeNull();
    expect(screen.queryByRole('group', { name: 'Next steps' })).toBeNull();
  });

  it('(b) with the live queue on (admins), the newest reply’s chips go as soon as the creator sends, while the director works', () => {
    const queueStudio = { caps: { ...DEFAULT_CAPS, admin: true }, queue: [] as QueuedNote[], turnLocked: true, busy: true };
    const sendingNow = makeFakeStudio({ doc: makeSampleDoc({ conversation: asked }), ...queueStudio, pendingMessage: sending('Make it funnier') });
    const a = render(<ConversationPane studio={sendingNow} />);
    expect(screen.queryByRole('group', { name: 'Next steps' })).toBeNull();
    a.unmount();
    const working = makeFakeStudio({
      doc: makeSampleDoc({ conversation: [...asked, { id: 'u1', role: 'user', text: 'Make it funnier', at: 4 }] }),
      ...queueStudio,
      messageBusy: true
    });
    render(<ConversationPane studio={working} />);
    expect(screen.queryByRole('group', { name: 'Next steps' })).toBeNull();
  });

  it('(a) a tapped choice reads one line of what was chosen, with nothing left to tap; after a reload too', () => {
    const answered = makeSampleDoc({
      conversation: [
        asked[0],
        { ...asked[1], cards: [{ ...look, answered: ['c1'] } as Card] },
        { id: 'u1', role: 'user', text: 'Noir ink', at: 4 }
      ]
    });
    for (const d of [answered, reload(answered)]) {
      const { container, unmount } = render(<ConversationPane studio={makeFakeStudio({ doc: d, caps: DEFAULT_CAPS })} />);
      const row = slot(container, 'q_look')!;
      expect(row.textContent).toBe('You picked Noir ink');
      expect(row.querySelectorAll(CONTROLS)).toHaveLength(0);
      unmount();
    }
  });

  it('an info-only notice after the question (a history notice) leaves the question live', () => {
    const notice: Msg = { id: 'a_n', role: 'assistant', text: 'Saved a version.', at: 3, cards: [{ type: 'notice', id: 'n_info', tone: 'info', text: 'Saved a version.' }] };
    const { container } = render(<ConversationPane studio={makeFakeStudio({ doc: makeSampleDoc({ conversation: [...asked, notice] }), caps: DEFAULT_CAPS })} />);
    expect(within(slot(container, 'q_look')!).getByRole('button', { name: /Noir ink/ })).toBeEnabled();
  });

  it('a reply that only asked, with no words of its own, leaves nothing behind once the chat moved on (never "Done — the board shows the latest")', () => {
    const wordless: Msg[] = [
      { id: 'u0', role: 'user', text: 'Start', at: 1 },
      { id: 'a1', role: 'assistant', text: '', at: 2, cards: [look] },
      { id: 'u1', role: 'user', text: 'make it rain', at: 3 }
    ];
    const { container } = render(<ConversationPane studio={makeFakeStudio({ doc: makeSampleDoc({ conversation: wordless }), caps: DEFAULT_CAPS })} />);
    expect(container.querySelectorAll('[data-role="assistant"]')).toHaveLength(0);
    expect(screen.queryByText(/the board shows the latest/)).toBeNull();
  });
});

describe('background work and the newest ask (Q-SETTLE)', () => {
  it("a render's outcome landing after the question the director asked meanwhile leaves the question live", () => {
    // A run the creator started (1); they wrote (2); the director asked (3); the run's outcome lands (4), from a run
    // that started at 1 (Msg.runAt).
    const conv: Msg[] = [
      { ...progress, id: 'a0', at: 1, runAt: 1 },
      { id: 'u1', role: 'user', text: 'make the hero taller', at: 2 },
      { id: 'a1', role: 'assistant', text: 'Sure. One question first:', at: 3, cards: [look] },
      { id: 'a2', role: 'assistant', text: '8 pages drawn.', at: 4, runAt: 1, nextSteps: [{ label: 'Read it', client: { type: 'open_reader' }, usd: 0 }] }
    ];
    for (const d of [makeSampleDoc({ conversation: conv }), reload(makeSampleDoc({ conversation: conv }))]) {
      const { container, unmount } = render(<ConversationPane studio={makeFakeStudio({ doc: d, caps: DEFAULT_CAPS })} />);
      expect(within(slot(container, 'q_look')!).getByRole('button', { name: /Noir ink/ })).toBeEnabled();
      unmount();
    }
  });

  it('a reply that renders nothing takes no slot in the log, offscreen wrapper included', () => {
    // Twelve older exchanges, then the wordless question the chat moved past, then six more messages: the question's
    // reply is old enough to sit in a content-visibility wrapper, which must not be there at all.
    const filler: Msg[] = Array.from({ length: 12 }, (_, i) => ({ id: `f${i}`, role: i % 2 ? 'assistant' : 'user', text: `m${i}`, at: 10 + i }) as Msg);
    const wordless: Msg = { id: 'a_q', role: 'assistant', text: '', at: 30, cards: [look] };
    const tail: Msg[] = Array.from({ length: 8 }, (_, i) => ({ id: `t${i}`, role: i % 2 ? 'assistant' : 'user', text: `n${i}`, at: 40 + i }) as Msg);
    const { container } = render(<ConversationPane studio={makeFakeStudio({ doc: makeSampleDoc({ conversation: [...filler, wordless, ...tail] }), caps: DEFAULT_CAPS })} />);
    const log = screen.getByRole('log');
    const wrappers = [...log.querySelectorAll(':scope > .cv-auto')];
    expect(wrappers.length).toBeGreaterThan(0);
    expect(wrappers.filter((w) => !w.firstElementChild)).toHaveLength(0);
    expect(slot(container, 'q_look')).toBeNull();
  });
});
