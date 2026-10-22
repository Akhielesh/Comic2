import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mixMinusPlan } from './audioMixer';
import {
  DEFAULT_ICE_SERVERS,
  DISCONNECTED_GRACE_MS,
  GuestPeer,
  HostPeers,
  MAX_ICE_RESTARTS,
  PATH_RECHECK_MS,
  RELAY_GUEST_CAM_BPS,
  RELAY_GUEST_SCREEN_BPS,
  RELAY_RETURN_BPS,
  returnFeedEncoding,
  sanitizeIceServers,
  type ReturnFeed,
} from './rtc';

/* ---------------------------------------------------- minimal WebRTC fakes */

let seq = 0;
class FakeTrack {
  id = `t${++seq}`;
  constructor(public kind: 'audio' | 'video', private h = 720) {}
  getSettings() {
    return { height: this.h };
  }
}

class FakeStream {
  id = `s${++seq}`;
  constructor(private tracks: FakeTrack[] = []) {}
  getTracks() {
    return this.tracks;
  }
  getVideoTracks() {
    return this.tracks.filter((t) => t.kind === 'video');
  }
  getAudioTracks() {
    return this.tracks.filter((t) => t.kind === 'audio');
  }
}

class FakeSender {
  params: { encodings: Record<string, unknown>[] } = { encodings: [{}] };
  constructor(public track: FakeTrack) {}
  getParameters() {
    return structuredClone(this.params);
  }
  async setParameters(p: { encodings: Record<string, unknown>[] }) {
    this.params = p;
  }
  async replaceTrack(t: FakeTrack) {
    this.track = t;
  }
}

class FakePC {
  static all: FakePC[] = [];
  connectionState: RTCPeerConnectionState = 'new';
  signalingState = 'stable';
  remoteDescription: unknown = null;
  localDescription: unknown = null;
  senders: FakeSender[] = [];
  closed = false;
  restartIce = vi.fn();
  setConfiguration = vi.fn((c: RTCConfiguration) => {
    this.config = c;
  });
  onnegotiationneeded: (() => void) | null = null;
  onicecandidate: ((e: unknown) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  ontrack: ((e: unknown) => void) | null = null;
  constructor(public config: RTCConfiguration) {
    FakePC.all.push(this);
  }
  getConfiguration() {
    return this.config;
  }
  addTrack(track: FakeTrack) {
    const s = new FakeSender(track);
    this.senders.push(s);
    return s;
  }
  getSenders() {
    return this.senders;
  }
  removeTrack() {}
  async setLocalDescription() {}
  async setRemoteDescription(d: unknown) {
    this.remoteDescription = d;
  }
  async addIceCandidate() {}
  /** What getStats reports (its selected candidate pair is the link's path). */
  stats: Map<string, Record<string, unknown>> = new Map();
  async getStats() {
    return this.stats;
  }
  /** The selected pair goes through a relay (TURN) or straight across the internet. */
  onPath(relay: boolean) {
    this.stats = new Map<string, Record<string, unknown>>([
      ['t', { type: 'transport', id: 't', selectedCandidatePairId: 'cp' }],
      ['cp', { type: 'candidate-pair', id: 'cp', localCandidateId: 'l', remoteCandidateId: 'r' }],
      ['l', { type: 'local-candidate', id: 'l', candidateType: relay ? 'relay' : 'srflx', address: '93.1.2.3' }],
      ['r', { type: 'remote-candidate', id: 'r', candidateType: 'srflx', address: '81.1.2.3' }],
    ]);
  }
  close() {
    this.closed = true;
  }
  /** Drive a connection-state change the way the browser does. */
  go(state: RTCPeerConnectionState) {
    this.connectionState = state;
    this.onconnectionstatechange?.();
  }
}

beforeEach(() => {
  FakePC.all = [];
  vi.stubGlobal('RTCPeerConnection', FakePC);
  vi.stubGlobal('MediaStream', FakeStream);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const feedOf = () => {
  const video = new FakeTrack('video');
  const audio = new Map<string, FakeTrack>();
  const release = vi.fn((_sid: string) => undefined);
  const feed = {
    video: () => video as unknown as MediaStreamTrack,
    audioFor: vi.fn((sid: string) => {
      if (!audio.has(sid)) audio.set(sid, new FakeTrack('audio'));
      return audio.get(sid) as unknown as MediaStreamTrack;
    }),
    release,
  } satisfies ReturnFeed;
  return { feed, video, audio };
};

describe('HostPeers — guests see and hear each other', () => {
  it('sends each guest the shared program video plus its OWN mix-minus audio', () => {
    const { feed, video, audio } = feedOf();
    const hp = new HostPeers(() => undefined);
    hp.setReturnFeed(feed);
    void hp.onSignal('g1', 'Ann', { ready: true });
    void hp.onSignal('g2', 'Ben', { ready: true });
    expect(FakePC.all).toHaveLength(2);
    expect(feed.audioFor).toHaveBeenCalledWith('g1');
    expect(feed.audioFor).toHaveBeenCalledWith('g2');
    const [a, b] = FakePC.all;
    expect(a.senders.map((s) => s.track)).toEqual([video, audio.get('g1')]);
    expect(b.senders.map((s) => s.track)).toEqual([video, audio.get('g2')]);
  });

  it('caps every return video so four of them fit a home uplink', async () => {
    const { feed } = feedOf();
    const hp = new HostPeers(() => undefined);
    hp.setReturnFeed(feed);
    void hp.onSignal('g1', 'Ann', { ready: true });
    await Promise.resolve();
    expect(FakePC.all[0].senders[0].params.encodings[0]).toMatchObject({ maxBitrate: 1_200_000 });
    void hp.onSignal('g2', 'Ben', { ready: true });
    void hp.onSignal('g3', 'Cy', { ready: true });
    await Promise.resolve();
    for (const pc of FakePC.all) expect(pc.senders[0].params.encodings[0]).toMatchObject({ maxBitrate: 700_000 });
  });

  it('frees a guest’s mix when its link goes away', () => {
    const { feed } = feedOf();
    const hp = new HostPeers(() => undefined);
    hp.setReturnFeed(feed);
    void hp.onSignal('g1', 'Ann', { ready: true });
    void hp.onSignal('g1', 'Ann', { bye: true });
    expect(feed.release).toHaveBeenCalledWith('g1');
    expect(hp.guests()).toHaveLength(0);
  });
});

describe('HostPeers — a re-sent ready rebuilds the link', () => {
  it('closes the old peer connection and starts a fresh one for the same guest', () => {
    const hp = new HostPeers(() => undefined);
    void hp.onSignal('g1', 'Ann', { ready: true });
    void hp.onSignal('g1', 'Ann', { ready: true });
    expect(FakePC.all).toHaveLength(2);
    expect(FakePC.all[0].closed).toBe(true);
    expect(FakePC.all[1].closed).toBe(false);
    expect(hp.guests().map((g) => g.sid)).toEqual(['g1']);
    expect(hp.has('g1')).toBe(true);
  });
});

describe('ICE from the room', () => {
  it('starts links with the room’s list, or the STUN pair until it arrives', () => {
    const turn: RTCIceServer[] = [{ urls: ['turn:t.example:3478'], username: 'u', credential: 'c' }];
    new HostPeers(() => undefined, turn).ensure('g1', 'Ann');
    expect(FakePC.all[0].config.iceServers).toEqual(turn);
    new GuestPeer(() => undefined, new FakeStream([new FakeTrack('video')]) as unknown as MediaStream);
    expect(FakePC.all[1].config.iceServers).toEqual(DEFAULT_ICE_SERVERS);
  });

  it('hands late TURN credentials to links still connecting and re-gathers', () => {
    const hp = new HostPeers(() => undefined);
    hp.ensure('g1', 'Ann');
    const pc = FakePC.all[0];
    pc.remoteDescription = { type: 'offer' };
    pc.connectionState = 'connecting';
    const turn: RTCIceServer[] = [{ urls: ['turns:t.example:443'], username: 'u', credential: 'c' }];
    hp.setIceServers(turn);
    expect(pc.setConfiguration).toHaveBeenCalledWith(expect.objectContaining({ iceServers: turn }));
    expect(pc.restartIce).toHaveBeenCalledTimes(1);
    hp.ensure('g2', 'Ben');
    expect(FakePC.all[1].config.iceServers).toEqual(turn);
  });

  it('keeps only well-formed STUN/TURN entries', () => {
    expect(sanitizeIceServers('nope')).toBeNull();
    expect(sanitizeIceServers([{ urls: 'http://evil' }, null, 3])).toBeNull();
    expect(sanitizeIceServers([{ urls: ['stun:a:1', 'javascript:x'] }, { urls: 'turn:b:3478', username: 'u', credential: 'c' }])).toEqual([
      { urls: ['stun:a:1'] },
      { urls: ['turn:b:3478'], username: 'u', credential: 'c' },
    ]);
  });
});

describe('self-healing links', () => {
  it('restarts ICE at once when a link fails', () => {
    new HostPeers(() => undefined).ensure('g1', 'Ann');
    const pc = FakePC.all[0];
    pc.go('failed');
    expect(pc.restartIce).toHaveBeenCalledTimes(1);
  });

  it('gives a dropped link a short grace, then restarts — unless it recovered', () => {
    vi.useFakeTimers();
    new HostPeers(() => undefined).ensure('g1', 'Ann');
    const pc = FakePC.all[0];
    pc.go('disconnected');
    vi.advanceTimersByTime(DISCONNECTED_GRACE_MS - 1);
    expect(pc.restartIce).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2);
    expect(pc.restartIce).toHaveBeenCalledTimes(1);

    pc.go('connected');
    pc.go('disconnected');
    pc.go('connected'); // Wi-Fi handover healed by itself
    vi.advanceTimersByTime(DISCONNECTED_GRACE_MS * 2);
    expect(pc.restartIce).toHaveBeenCalledTimes(1);
  });

  it('gives up after a few tries so the UI can say so honestly', () => {
    new HostPeers(() => undefined).ensure('g1', 'Ann');
    const pc = FakePC.all[0];
    for (let i = 0; i < MAX_ICE_RESTARTS + 3; i++) pc.go('failed');
    expect(pc.restartIce).toHaveBeenCalledTimes(MAX_ICE_RESTARTS);
  });

  it('never restarts a closed link', () => {
    const hp = new HostPeers(() => undefined);
    hp.ensure('g1', 'Ann');
    const pc = FakePC.all[0];
    hp.close('g1');
    pc.go('failed');
    expect(pc.restartIce).not.toHaveBeenCalled();
  });
});

describe('return feed budget and mix-minus wiring', () => {
  it('shares the uplink between guests and scales the picture to ≤ 540 lines', () => {
    expect(returnFeedEncoding(1, 720)).toEqual({ maxBitrate: 1_200_000, scaleResolutionDownBy: 1.33 });
    expect(returnFeedEncoding(2, 1080)).toEqual({ maxBitrate: 900_000, scaleResolutionDownBy: 2 });
    expect(returnFeedEncoding(4, 480)).toEqual({ maxBitrate: 700_000, scaleResolutionDownBy: 1 });
  });

  it('feeds every guest everyone but themselves', () => {
    const plan = mixMinusPlan(['host', 'g1', 'g2', 'g3'], ['g1', 'g2', 'g3']);
    expect(plan.get('g1')).toEqual(['host', 'g2', 'g3']);
    expect(plan.get('g2')).toEqual(['host', 'g1', 'g3']);
    expect(plan.get('g3')).toEqual(['host', 'g1', 'g2']);
    // A guest whose audio hasn't arrived yet still hears the room.
    expect(mixMinusPlan(['host'], ['g9']).get('g9')).toEqual(['host']);
  });
});

/* ------------------------------------------------ relays (TURN, billed per GB) */

describe('relays: capped video, fresh credentials', () => {
  const turn = (user: string): RTCIceServer[] => [{ urls: ['stun:s:3478'] }, { urls: ['turn:t:3478'], username: user, credential: 'c' }];
  const settle = () => vi.advanceTimersByTimeAsync(0);

  it('a relayed return feed is ≤ 700 kbps whatever the guest count; direct ones keep their budget', () => {
    expect(returnFeedEncoding(1, 720, true).maxBitrate).toBe(RELAY_RETURN_BPS);
    expect(returnFeedEncoding(2, 720, true).maxBitrate).toBe(RELAY_RETURN_BPS);
    expect(returnFeedEncoding(4, 720, true).maxBitrate).toBe(700_000);
    expect(returnFeedEncoding(1, 1080, true).scaleResolutionDownBy).toBe(2);
    expect(returnFeedEncoding(1, 720).maxBitrate).toBe(1_200_000);
  });

  it('the host caps only the guests reached through a relay, and follows a path that changes', async () => {
    vi.useFakeTimers();
    const { feed } = feedOf();
    const hp = new HostPeers(() => undefined);
    hp.setReturnFeed(feed);
    hp.ensure('g1', 'Ann');
    hp.ensure('g2', 'Ben');
    const [ann, ben] = FakePC.all;
    ann.onPath(true);
    ben.onPath(false);
    ann.go('connected');
    ben.go('connected');
    await settle();
    expect(ann.senders[0].params.encodings[0].maxBitrate).toBe(RELAY_RETURN_BPS);
    expect(ben.senders[0].params.encodings[0].maxBitrate).toBe(900_000);
    ann.onPath(false);
    await vi.advanceTimersByTimeAsync(PATH_RECHECK_MS);
    expect(ann.senders[0].params.encodings[0].maxBitrate).toBe(900_000);
    hp.closeAll();
  });

  it('a guest on a relay sends its camera ≤ 600 kbps and its screen ≤ 1 Mbps — no cap of ours off it', async () => {
    vi.useFakeTimers();
    const g = new GuestPeer(() => undefined, new FakeStream([new FakeTrack('video'), new FakeTrack('audio')]) as unknown as MediaStream);
    const pc = FakePC.all[0];
    const cam = pc.senders.find((x) => x.track.kind === 'video')!;
    pc.onPath(true);
    pc.go('connected');
    await settle();
    expect(cam.params.encodings[0].maxBitrate).toBe(RELAY_GUEST_CAM_BPS);
    g.setScreen(new FakeStream([Object.assign(new FakeTrack('video'), { stop: () => undefined })]) as unknown as MediaStream);
    await settle();
    const screen = pc.senders.at(-1)!;
    expect(screen.params.encodings[0].maxBitrate).toBe(RELAY_GUEST_SCREEN_BPS);
    pc.onPath(false);
    await vi.advanceTimersByTimeAsync(PATH_RECHECK_MS);
    expect(cam.params.encodings[0]).not.toHaveProperty('maxBitrate');
    expect(screen.params.encodings[0]).not.toHaveProperty('maxBitrate');
    g.close();
  });

  it('fresh credentials restart a relayed link onto them; the same ones, or a direct link, wait for the next restart', async () => {
    vi.useFakeTimers();
    const hp = new HostPeers(() => undefined, turn('u1'));
    hp.ensure('g1', 'Ann');
    hp.ensure('g2', 'Ben');
    const [ann, ben] = FakePC.all;
    ann.remoteDescription = { type: 'answer' };
    ben.remoteDescription = { type: 'answer' };
    ann.onPath(true);
    ben.onPath(false);
    ann.go('connected');
    ben.go('connected');
    await settle();
    hp.setIceServers(turn('u2'));
    expect(ann.config.iceServers).toEqual(turn('u2'));
    expect(ben.config.iceServers).toEqual(turn('u2'));
    expect(ann.restartIce).toHaveBeenCalledTimes(1);
    expect(ben.restartIce).not.toHaveBeenCalled();
    hp.setIceServers(turn('u2'));
    expect(ann.restartIce).toHaveBeenCalledTimes(1);
    hp.closeAll();
  });
});
