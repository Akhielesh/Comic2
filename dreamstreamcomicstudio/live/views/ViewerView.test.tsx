import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getEvent, openRoomSocket, type RoomSocket } from '../api';
import type { Nav } from '../nav';
import type { EventMeta, ServerMsg } from '../protocol';
import { ViewerView } from './ViewerView';

vi.mock('../api', () => ({
  fetchSegment: vi.fn(),
  getEvent: vi.fn(),
  openRoomSocket: vi.fn(),
}));

const nav: Nav = {
  dashboard: vi.fn(),
  create: vi.fn(),
  settings: vi.fn(),
  studio: vi.fn(),
  viewer: vi.fn(),
  event: vi.fn(),
  summary: vi.fn(),
};

const meta: EventMeta = {
  id: 'evt-mobile-chat',
  title: 'Mobile launch rehearsal',
  host: 'Akhielesh',
  desc: 'Testing viewer chat on a phone.',
  cover: 0,
  access: 'open',
  quality: '720p',
  mime: '',
  segMs: 6000,
  status: 'idle',
  createdAt: Date.now(),
  scheduledAt: null,
  startedAt: null,
  endedAt: null,
  firstSeq: 1,
  latestSeq: 0,
  lastIngestAt: null,
  pinned: null,
  slowSec: 0,
  reactionsOn: true,
  maxViewers: 100,
  viewers: 1,
  rsvpCount: 0,
  rsvpNames: [],
};

const installMatchMedia = (matches: boolean) => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
};

describe('ViewerView mobile chat composer', () => {
  let onRoomMessage: ((msg: ServerMsg) => void) | null;
  let socketSend: ReturnType<typeof vi.fn<(msg: Record<string, unknown>) => void>>;

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    sessionStorage.clear();
    installMatchMedia(true);
    onRoomMessage = null;
    socketSend = vi.fn<(msg: Record<string, unknown>) => void>();
    vi.mocked(getEvent).mockResolvedValue(meta);
    vi.mocked(openRoomSocket).mockImplementation((_id, _params, onMsg) => {
      onRoomMessage = onMsg;
      return { send: socketSend, close: vi.fn<() => void>() } satisfies RoomSocket;
    });
  });

  it('sends a chat message when a touch user taps the mobile Send button', async () => {
    render(<ViewerView eventId={meta.id} nav={nav} push={vi.fn()} />);

    fireEvent.change(await screen.findByLabelText(/Enter your name to watch/i), {
      target: { value: 'Sam' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^Join$/i }));

    await waitFor(() => expect(openRoomSocket).toHaveBeenCalled());
    act(() => {
      onRoomMessage?.({
        t: 'hello',
        meta,
        you: { sid: 'viewer-1', role: 'viewer', name: 'Sam' },
        chat: [],
      });
    });

    const composer = await screen.findByPlaceholderText(/Say something/i);
    fireEvent.change(composer, { target: { value: 'Hello from mobile' } });
    fireEvent.click(screen.getByRole('button', { name: /^Send$/i }));

    expect(socketSend).toHaveBeenCalledWith({ t: 'chat', text: 'Hello from mobile' });
    expect(composer).toHaveValue('');
  });
});
