// CHAT-0, bug B5: the clarifying-questions card kept "sent" in component state, so after a reload —
// or once the conversation had moved on — the form was live again and "Send answers" re-sent into
// the chat. Now a passed card is one line with no Send (lead decision D3), and sending records
// "sent" on the turn before the answers are posted.
import React, { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ChatArtifact, ClarifyArtifact } from '../../../apiTypes';
import type { ChatArtifactState } from '../../../services/chatStorage';
import { ArtifactTurnsContext, ChatArtifacts, type ArtifactTurnsValue } from './ChatArtifacts';

const clarify: ClarifyArtifact = {
  title: 'A few quick questions',
  questions: [
    { id: 'when', prompt: 'When are you going?', type: 'single', options: [{ label: 'Spring' }, { label: 'Autumn' }] },
    { id: 'who', prompt: 'Who is coming?', type: 'single', options: [{ label: 'Just me' }, { label: 'Family' }] }
  ]
};

type Stored = { artifacts: ChatArtifact[]; artifactState?: Record<string, ChatArtifactState>; passed: boolean; busy?: boolean };

const Harness: React.FC<{ store: { turn: Stored } }> = ({ store }) => {
  const [turn, setTurn] = useState(store.turn);
  const value: ArtifactTurnsValue = {
    turnFor: (artifacts) =>
      artifacts === turn.artifacts
        ? {
            sessionId: 's1',
            turnId: 't1',
            passed: turn.passed,
            busy: !!turn.busy,
            variant: 0,
            artifactState: turn.artifactState,
            settle: (key, state) => {
              store.turn = { ...store.turn, artifactState: { ...(store.turn.artifactState || {}), ...(state ? { [key]: state } : {}) } };
              setTurn(store.turn);
            }
          }
        : null
  };
  return (
    <ArtifactTurnsContext.Provider value={value}>
      <ChatArtifacts artifacts={turn.artifacts} />
    </ArtifactTurnsContext.Provider>
  );
};

afterEach(() => cleanup());

describe('ClarifyCard settles', () => {
  it('a passed Clarify has no Send — one line, no controls', () => {
    const { container } = render(<Harness store={{ turn: { artifacts: [{ type: 'clarify', data: clarify }], passed: true } }} />);
    expect(screen.queryByRole('button', { name: /send answers/i })).toBeNull();
    expect(container.querySelectorAll('button, input, textarea')).toHaveLength(0);
    expect(container.textContent).toContain('Not answered — you moved on');
  });

  it('sending records "sent" on the turn first, then posts the answers once; a reload shows the answered line', () => {
    const sent = vi.fn();
    window.addEventListener('dreamstream:send', sent);
    try {
      const store = { turn: { artifacts: [{ type: 'clarify', data: clarify }], passed: false } as Stored };
      const order: string[] = [];
      sent.mockImplementation(() => order.push(store.turn.artifactState?.['0:0']?.status ?? 'none'));
      render(<Harness store={store} />);
      fireEvent.click(screen.getByRole('button', { name: /spring/i }));
      fireEvent.click(screen.getByRole('button', { name: /family/i }));
      fireEvent.click(screen.getByRole('button', { name: /send answers/i }));
      expect(sent).toHaveBeenCalledTimes(1);
      expect(order).toEqual(['sent']); // recorded before the message went out
      expect(store.turn.artifactState?.['0:0']).toMatchObject({ status: 'sent', result: { answered: 2 } });

      cleanup();
      const { container } = render(<Harness store={{ turn: JSON.parse(JSON.stringify(store.turn)) as Stored }} />);
      expect(container.querySelectorAll('button, input, textarea')).toHaveLength(0);
      expect(container.textContent).toContain('You answered 2 questions');
      expect(sent).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener('dreamstream:send', sent);
    }
  });

  it('Send answers → the answered line takes the focus the Send button had (settle §5.8)', () => {
    const store = { turn: { artifacts: [{ type: 'clarify', data: clarify }], passed: false } as Stored };
    const { container } = render(<Harness store={store} />);
    fireEvent.click(screen.getByRole('button', { name: /spring/i }));
    const send = screen.getByRole('button', { name: /send answers/i });
    send.focus();
    fireEvent.click(send);
    const line = container.querySelector('[data-settled="clarify"]') as HTMLElement;
    expect(line?.textContent).toContain('You answered 1 question');
    expect(document.activeElement).toBe(line);
  });

  it('while the chat is answering, Send waits (the composer would drop it)', () => {
    render(<Harness store={{ turn: { artifacts: [{ type: 'clarify', data: clarify }], passed: false, busy: true } }} />);
    fireEvent.click(screen.getByRole('button', { name: /spring/i }));
    expect((screen.getByRole('button', { name: /send answers/i }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/when the answer above finishes/i)).toBeTruthy();
  });
});
