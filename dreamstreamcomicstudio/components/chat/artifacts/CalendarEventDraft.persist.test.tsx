// CHAT-0, bug B5: after a reload the Calendar card offered Confirm / Add all again, so an event could
// be written to the user's Google Calendar twice ("done" lived in component state). The outcome is
// now recorded on the chat turn (ChatTurn.artifactState) and the card reads it back; once the
// conversation moves on, a card collapses to one line with no controls (lead decision D3).
// A small harness stands in for the chat: it keeps the turn, applies `settle`, and remounts the
// card from what was recorded — exactly what a reload does from IndexedDB.
import React, { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { CalendarEventDraftArtifact, ChatArtifact } from '../../../apiTypes';
import type { ChatArtifactState } from '../../../services/chatStorage';

const calendar = vi.hoisted(() => ({ mutateEvent: vi.fn() }));
vi.mock('../../../services/calendarApi', () => calendar);

import { ArtifactTurnsContext, ChatArtifacts, type ArtifactTurnsValue } from './ChatArtifacts';
import { CalendarEventDraft } from './CalendarEventDraft';
import { __resetChatStreamsForTests } from '../../../services/chatStreams';

type Stored = { artifacts: ChatArtifact[]; artifactState?: Record<string, ChatArtifactState>; passed: boolean };

const single: CalendarEventDraftArtifact = {
  action: 'create',
  connectionId: 'conn-1',
  account: 'me@example.com',
  canWrite: true,
  event: { title: 'Coffee with Priya', start: '2026-11-07T15:00:00Z', end: '2026-11-07T15:30:00Z' }
};
const batch: CalendarEventDraftArtifact = {
  action: 'create',
  connectionId: 'conn-1',
  canWrite: true,
  event: { title: 'Flight' },
  events: [{ title: 'Flight' }, { title: 'Hotel' }, { title: 'Dinner' }, { title: 'Workshop' }]
};

/** The chat: holds the stored turn and records what the card settles, like AIChatPlatform. */
const ChatHarness: React.FC<{ store: { turn: Stored } }> = ({ store }) => {
  const [turn, setTurn] = useState(store.turn);
  const value: ArtifactTurnsValue = {
    turnFor: (artifacts) =>
      artifacts === turn.artifacts
        ? {
            sessionId: 's1',
            turnId: 't1',
            passed: turn.passed,
            busy: false,
            variant: 0,
            artifactState: turn.artifactState,
            settle: (key, state) => {
              const next = { ...(store.turn.artifactState || {}) };
              if (state) next[key] = state;
              else delete next[key];
              store.turn = { ...store.turn, artifactState: next };
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

const mount = (store: { turn: Stored }) => render(<ChatHarness store={store} />);
/** A reload: the view goes away and comes back from what was stored. */
const reload = (store: { turn: Stored }) => {
  cleanup();
  store.turn = JSON.parse(JSON.stringify(store.turn)) as Stored; // through storage, as IndexedDB does
  return mount(store);
};
const flush = async () => {
  for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); });
};

beforeEach(() => {
  __resetChatStreamsForTests();
  calendar.mutateEvent.mockReset().mockResolvedValue({ action: 'create', event: { htmlLink: 'https://calendar.google.com/event?eid=abc' } });
});
afterEach(() => cleanup());

describe('CalendarEventDraft never writes twice', () => {
  it('remount with artifactState done → no Confirm, the one-line outcome instead', () => {
    const store = { turn: { artifacts: [{ type: 'calendar_event_draft', data: single }], passed: false, artifactState: { '0:0': { status: 'done', at: 1, result: { htmlLink: 'https://calendar.google.com/x' } } } } as Stored };
    const { container } = mount(store);
    expect(screen.queryByRole('button', { name: /create/i })).toBeNull();
    expect(container.querySelectorAll('button')).toHaveLength(0);
    expect(container.querySelector('[data-settled="calendar_event_draft"]')?.textContent).toContain('Added to your calendar');
    expect(screen.getByRole('link', { name: /open/i }).getAttribute('href')).toBe('https://calendar.google.com/x');
  });

  it('Confirm records pending before the write and done after it; a reload never offers it again', async () => {
    const store = { turn: { artifacts: [{ type: 'calendar_event_draft', data: single }], passed: false } as Stored };
    let release!: (v: unknown) => void;
    calendar.mutateEvent.mockImplementationOnce(() => new Promise((r) => { release = r; }));
    mount(store);
    fireEvent.click(screen.getByRole('button', { name: /create/i }));
    expect(store.turn.artifactState?.['0:0']?.status).toBe('pending');
    // Mid-flight: the button is busy, a second click writes nothing.
    fireEvent.click(screen.getByRole('button', { name: /create/i }));
    await act(async () => { release({ action: 'create', event: { htmlLink: 'https://calendar.google.com/e1' } }); });
    await flush();
    expect(calendar.mutateEvent).toHaveBeenCalledTimes(1);
    expect(store.turn.artifactState?.['0:0']).toMatchObject({ status: 'done', result: { htmlLink: 'https://calendar.google.com/e1' } });

    const { container } = reload(store);
    expect(screen.queryByRole('button', { name: /create/i })).toBeNull();
    expect(container.textContent).toContain('Added to your calendar');
    expect(calendar.mutateEvent).toHaveBeenCalledTimes(1);
  });

  it('the view goes away mid-write: a remount shows it busy (no second write), then the outcome', async () => {
    const store = { turn: { artifacts: [{ type: 'calendar_event_draft', data: single }], passed: false } as Stored };
    let release!: (v: unknown) => void;
    calendar.mutateEvent.mockImplementationOnce(() => new Promise((r) => { release = r; }));
    mount(store);
    fireEvent.click(screen.getByRole('button', { name: /create/i }));
    cleanup(); // the user switched views; the request is still in flight

    mount(store);
    const btn = screen.getByRole('button', { name: /create/i }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    fireEvent.click(btn);
    await act(async () => { release({ action: 'create', event: {} }); });
    await flush();
    expect(calendar.mutateEvent).toHaveBeenCalledTimes(1);
    expect(store.turn.artifactState?.['0:0']?.status).toBe('done');
    const { container } = reload(store);
    expect(container.querySelectorAll('button')).toHaveLength(0);
  });

  it('a write whose answer never came back reads "may already be in your calendar" — never offered again', () => {
    const store = { turn: { artifacts: [{ type: 'calendar_event_draft', data: single }], passed: false, artifactState: { '0:0': { status: 'pending', at: 1 } } } as Stored };
    const { container } = mount(store);
    expect(container.querySelectorAll('button')).toHaveLength(0);
    expect(container.textContent).toMatch(/may already be in your calendar/i);
  });

  it('a failed write clears its pending mark: the card stays live and can be tried again', async () => {
    calendar.mutateEvent.mockRejectedValueOnce(new Error('Calendar said no.'));
    const store = { turn: { artifacts: [{ type: 'calendar_event_draft', data: single }], passed: false } as Stored };
    mount(store);
    fireEvent.click(screen.getByRole('button', { name: /create/i }));
    await flush();
    expect(store.turn.artifactState?.['0:0']).toBeUndefined();
    expect(screen.getByText('Calendar said no.')).toBeTruthy();
    expect((screen.getByRole('button', { name: /create/i }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('once the conversation moves on, an untouched card is one line with no controls (D3)', () => {
    const store = { turn: { artifacts: [{ type: 'calendar_event_draft', data: single }], passed: true } as Stored };
    const { container } = mount(store);
    expect(container.querySelectorAll('button, input, textarea')).toHaveLength(0);
    expect(container.textContent).toContain('Not added — you moved on');
  });

  it('batch: a reload restores each row; only the rows not yet added can be added', async () => {
    const store = {
      turn: { artifacts: [{ type: 'calendar_event_draft', data: batch }], passed: false, artifactState: { '0:0': { status: 'pending', at: 1, result: { rows: ['done', 'pending', 'idle', 'error'] } } } } as Stored
    };
    mount(store);
    expect(screen.queryByRole('button', { name: /add all/i })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /add the 2 left/i }));
    await flush();
    // Flight is added, Hotel may already be: neither is written again.
    expect(calendar.mutateEvent.mock.calls.map((c) => (c[2] as { title: string }).title)).toEqual(['Dinner', 'Workshop']);
    expect(store.turn.artifactState?.['0:0']?.result?.rows).toEqual(['done', 'pending', 'done', 'done']);

    const { container } = reload(store);
    expect(container.querySelectorAll('button')).toHaveLength(0); // nothing left that is safe to add
    expect(container.textContent).toMatch(/may already be in your calendar/i);
  });

  it('batch: every row added → settled line; the chat moved on mid-way → "Added 2 of 4 — you moved on"', async () => {
    const store = { turn: { artifacts: [{ type: 'calendar_event_draft', data: batch }], passed: false } as Stored };
    mount(store);
    fireEvent.click(screen.getByRole('button', { name: /add all 4/i }));
    await flush();
    expect(calendar.mutateEvent).toHaveBeenCalledTimes(4);
    expect(store.turn.artifactState?.['0:0']?.status).toBe('done');
    const { container } = reload(store);
    expect(container.querySelectorAll('button')).toHaveLength(0);
    expect(container.textContent).toContain('Added 4 events to your calendar');

    cleanup();
    const passed = { turn: { artifacts: [{ type: 'calendar_event_draft', data: batch }], passed: true, artifactState: { '0:0': { status: 'pending', at: 1, result: { rows: ['done', 'done', 'idle', 'idle'] } } } } as Stored };
    const { container: c2 } = mount(passed);
    expect(c2.querySelectorAll('button, input')).toHaveLength(0);
    expect(c2.textContent).toContain('Added 2 of 4 events — you moved on');
  });

  it('outside a chat (the Gallery) the card works as before: Confirm, then a local done line', async () => {
    const { container } = render(<CalendarEventDraft data={single} />);
    fireEvent.click(screen.getByRole('button', { name: /create/i }));
    await flush();
    expect(calendar.mutateEvent).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('Added to your calendar');
  });
});
