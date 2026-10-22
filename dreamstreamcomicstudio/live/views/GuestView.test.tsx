import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getEvent, openRoomSocket } from '../api';
import type { Nav } from '../nav';
import type { ServerMsg } from '../protocol';
import { GuestView } from './GuestView';

vi.mock('../api', () => ({
  getEvent: vi.fn(),
  openRoomSocket: vi.fn(),
}));

/* minimal media + WebRTC fakes */
class FakeTrack {
  enabled = true;
  constructor(public kind: string) {}
  stop() {}
  getSettings() {
    return {};
  }
}
class FakeStream {
  id = Math.random().toString(36).slice(2);
  private t = [new FakeTrack('video'), new FakeTrack('audio')];
  getTracks() {
    return this.t;
  }
  getVideoTracks() {
    return this.t.filter((x) => x.kind === 'video');
  }
  getAudioTracks() {
    return this.t.filter((x) => x.kind === 'audio');
  }
}
class FakePC {
  static all: FakePC[] = [];
  connectionState = 'new';
  signalingState = 'stable';
  closed = false;
  onnegotiationneeded = null;
  onicecandidate = null;
  onconnectionstatechange = null;
  ontrack = null;
  constructor(public config: RTCConfiguration) {
    FakePC.all.push(this);
  }
  addTrack() {
    return { getParameters: () => ({ encodings: [{}] }), setParameters: async () => undefined, replaceTrack: async () => undefined };
  }
  getSenders() {
    return [];
  }
  setConfiguration() {}
  getConfiguration() {
    return this.config;
  }
  restartIce() {}
  close() {
    this.closed = true;
  }
}

const nav = { viewer: vi.fn() } as unknown as Nav;
const meetingMeta = { id: 'ev1', title: 'Team sync', host: 'Akhil', kind: 'meeting', status: 'idle' };

let getUserMedia: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  FakePC.all = [];
  localStorage.clear();
  vi.stubGlobal('RTCPeerConnection', FakePC);
  vi.stubGlobal('MediaStream', FakeStream);
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  getUserMedia = vi.fn(async () => new FakeStream());
  Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia }, configurable: true });
  history.replaceState(null, '', '/live.html?e=ev1#/guest?g=gk&m=1');
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  history.replaceState(null, '', '/live.html');
});

describe('GuestView · meeting invites', () => {
  it('speaks "meeting" — join on camera with the host, no account', async () => {
    vi.mocked(getEvent).mockResolvedValue(meetingMeta as never);
    render(<GuestView eventId="ev1" guestKey="gk" nav={nav} push={vi.fn()} />);
    expect(await screen.findByRole('heading', { name: 'Join “Team sync”' })).toBeInTheDocument();
    expect(screen.getByText('You’ll join on camera with Akhil. No account needed.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Join meeting/ })).toBeInTheDocument();
  });

  it('turns a blocked camera into one clear fix and a Try again', async () => {
    vi.mocked(getEvent).mockResolvedValue(meetingMeta as never);
    getUserMedia.mockRejectedValueOnce(Object.assign(new Error('denied'), { name: 'NotAllowedError' }));
    render(<GuestView eventId="ev1" guestKey="gk" nav={nav} push={vi.fn()} />);
    expect(await screen.findByText(/Camera and mic are blocked for this site/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Join meeting/ })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: /Try again/ }));
    await waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByText(/blocked for this site/)).toBeNull());
    fireEvent.change(screen.getByLabelText('Your name'), { target: { value: 'Ann' } });
    expect(screen.getByRole('button', { name: /Join meeting/ })).toBeEnabled();
  });
});

describe('GuestView · reliable links', () => {
  it('links with the room’s ICE list and rebuilds when the host asks again', async () => {
    vi.mocked(getEvent).mockResolvedValue(meetingMeta as never);
    const sent: Record<string, unknown>[] = [];
    let onMsg: (m: ServerMsg) => void = () => undefined;
    vi.mocked(openRoomSocket).mockImplementation((_id, _p, handler) => {
      onMsg = handler;
      return { send: (m: Record<string, unknown>) => void sent.push(m), close: () => undefined };
    });
    render(<GuestView eventId="ev1" guestKey="gk" nav={nav} push={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Your name'), { target: { value: 'Ann' } });
    await waitFor(() => expect(screen.getByRole('button', { name: /Join meeting/ })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: /Join meeting/ }));

    act(() => onMsg({ t: 'hello', meta: meetingMeta as never, you: { sid: 's1', role: 'guest', name: 'Ann' }, chat: [] }));
    expect(sent).toContainEqual({ t: 'ice' });
    expect(FakePC.all).toHaveLength(0); // waits for the ICE list first

    const turn = [{ urls: ['turn:t.example:3478'], username: 'u', credential: 'c' }];
    act(() => onMsg({ t: 'ice', servers: turn }));
    expect(FakePC.all).toHaveLength(1);
    expect(FakePC.all[0].config.iceServers).toEqual(turn);
    expect(sent.filter((m) => m.t === 'rtc')).toEqual([{ t: 'rtc', d: { ready: true } }]);

    // The host's studio reloaded (or its camera came up late): it asks us to reconnect.
    act(() => onMsg({ t: 'rtc', from: 'host', d: { ready: true } }));
    expect(FakePC.all).toHaveLength(2);
    expect(FakePC.all[0].closed).toBe(true);
    expect(sent.filter((m) => m.t === 'rtc')).toHaveLength(2);
    expect(screen.getByText('Waiting for Akhil…')).toBeInTheDocument();
  });
});
