// @vitest-environment node
// Short-lived relay credentials on the client (live/rtcIce.ts): asking the room again when it
// says, and moving a relayed baby-monitor connection onto fresh credentials before the old
// ones lapse — so an all-night picture through a relay never drops at the 4-hour mark.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CameraHub, ViewerLink } from './monitor/rtc';
import type { MonRtc } from './monitor/protocol';
import { applyIce, ICE_ASK_MAX_MS, ICE_ASK_MIN_MS, IceClock, keepRelay, turnKey, turnRenewed } from './rtcIce';

const STUN: RTCIceServer[] = [{ urls: ['stun:stun.cloudflare.com:3478'] }];
const turn = (user: string): RTCIceServer[] => [...STUN, { urls: ['turn:turn.cloudflare.com:3478?transport=udp'], username: user, credential: 'c' }];

describe('turnKey / turnRenewed', () => {
  it('only relay entries count, and a new username is fresh credentials', () => {
    expect(turnKey(STUN)).toBe('');
    expect(turnKey(null)).toBe('');
    expect(turnKey(turn('a'))).toBe(turnKey(turn('a')));
    expect(turnRenewed(turn('a'), turn('a'))).toBe(false);
    expect(turnRenewed(turn('a'), turn('b'))).toBe(true);
    expect(turnRenewed(STUN, turn('a'))).toBe(true);
    // Losing TURN (a failed mint) is not "fresh credentials": nothing to move onto.
    expect(turnRenewed(turn('a'), STUN)).toBe(false);
  });
});

it('keepRelay: a STUN-only answer never takes away relay credentials we hold', () => {
  expect(keepRelay(turn('a'), STUN)).toEqual(turn('a'));
  expect(keepRelay(turn('a'), turn('b'))).toEqual(turn('b'));
  expect(keepRelay(STUN, turn('b'))).toEqual(turn('b'));
  expect(keepRelay([], STUN)).toEqual(STUN);
});

describe('IceClock', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('asks once when the room says, re-armed by every delivery', () => {
    const ask = vi.fn();
    const c = new IceClock(ask);
    c.arm(60_000);
    vi.advanceTimersByTime(59_999);
    expect(ask).not.toHaveBeenCalled();
    c.arm(120_000); // a fresh delivery moves the deadline
    vi.advanceTimersByTime(60_000);
    expect(ask).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60_000);
    expect(ask).toHaveBeenCalledTimes(1);
    expect(c.armed).toBe(false);
    vi.advanceTimersByTime(10 * 3600_000);
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it('schedules nothing without a time (STUN only, older rooms), and stops', () => {
    const ask = vi.fn();
    const c = new IceClock(ask);
    for (const v of [undefined, null, 0, -5, Number.NaN]) c.arm(v);
    expect(c.armed).toBe(false);
    c.arm(60_000);
    c.stop();
    vi.advanceTimersByTime(ICE_ASK_MAX_MS);
    expect(ask).not.toHaveBeenCalled();
  });

  it('never spins on a tiny delay, never waits past a credential’s life', () => {
    const ask = vi.fn();
    const c = new IceClock(ask);
    c.arm(1);
    vi.advanceTimersByTime(ICE_ASK_MIN_MS - 1);
    expect(ask).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(ask).toHaveBeenCalledTimes(1);
    c.arm(48 * 3600_000);
    vi.advanceTimersByTime(ICE_ASK_MAX_MS);
    expect(ask).toHaveBeenCalledTimes(2);
  });
});

it('applyIce points a connection at a fresh list and never throws', () => {
  const pc = { cfg: { iceServers: STUN, bundlePolicy: 'max-bundle' } as RTCConfiguration, getConfiguration() { return this.cfg; }, setConfiguration(c: RTCConfiguration) { this.cfg = c; } };
  applyIce(pc as unknown as RTCPeerConnection, turn('a'));
  expect(pc.cfg).toEqual({ iceServers: turn('a'), bundlePolicy: 'max-bundle' });
  applyIce({} as RTCPeerConnection, turn('a')); // an older browser
  applyIce({ getConfiguration: () => ({}), setConfiguration: () => { throw new Error('closed'); } } as unknown as RTCPeerConnection, turn('a'));
});

/* ------------------------------------------------------- the baby monitor */

class FakeSender {
  track: unknown = null;
  params = { encodings: [{}] as Record<string, unknown>[] };
  async replaceTrack(t: unknown) {
    this.track = t;
  }
  getParameters() {
    return structuredClone(this.params);
  }
  async setParameters(p: FakeSender['params']) {
    this.params = p;
  }
}

class FakePC {
  static all: FakePC[] = [];
  connectionState = 'new';
  signalingState = 'stable';
  config: RTCConfiguration;
  transceivers: { direction: string; sender: FakeSender; receiver: { track: { kind: string } }; setCodecPreferences(): void }[] = [];
  localDescription: { toJSON(): unknown } | null = null;
  offers: { iceRestart?: boolean }[] = [];
  onconnectionstatechange: (() => void) | null = null;
  onicecandidate: unknown = null;
  ondatachannel: unknown = null;
  ontrack: unknown = null;
  stats: Map<string, Record<string, unknown>> = new Map();
  constructor(c: RTCConfiguration) {
    this.config = c;
    FakePC.all.push(this);
  }
  getConfiguration() {
    return this.config;
  }
  setConfiguration(c: RTCConfiguration) {
    this.config = c;
  }
  getTransceivers() {
    return this.transceivers;
  }
  addTransceiver(kind: string) {
    const t = { direction: 'sendrecv', sender: new FakeSender(), receiver: { track: { kind } }, setCodecPreferences() {} };
    this.transceivers.push(t);
    return t;
  }
  createDataChannel() {
    return { onmessage: null };
  }
  async setRemoteDescription(d: { type: string }) {
    if (d.type === 'offer' && !this.transceivers.length) {
      this.addTransceiver('video');
      this.addTransceiver('audio');
    }
  }
  async createAnswer() {
    return { type: 'answer', sdp: 'a' };
  }
  async createOffer(o: { iceRestart?: boolean } = {}) {
    this.offers.push(o);
    return { type: 'offer', sdp: o.iceRestart ? 'restart' : 'o' };
  }
  async setLocalDescription(d: unknown) {
    this.localDescription = { toJSON: () => d };
  }
  async addIceCandidate() {}
  async getStats() {
    return this.stats;
  }
  close() {
    this.connectionState = 'closed';
  }
  /** Connected over a relay (TURN) or across the internet directly. */
  connect(relay: boolean) {
    this.stats = new Map<string, Record<string, unknown>>([
      ['t', { type: 'transport', id: 't', selectedCandidatePairId: 'cp' }],
      ['cp', { type: 'candidate-pair', id: 'cp', localCandidateId: 'l', remoteCandidateId: 'r' }],
      ['l', { type: 'local-candidate', id: 'l', candidateType: relay ? 'relay' : 'srflx', address: '93.1.2.3' }],
      ['r', { type: 'remote-candidate', id: 'r', candidateType: 'srflx', address: '81.1.2.3' }],
    ]);
    this.connectionState = 'connected';
    this.onconnectionstatechange?.();
  }
}

const settle = async () => {
  for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(2000);
};

describe('baby monitor: fresh relay credentials', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('window', globalThis);
    vi.stubGlobal('RTCPeerConnection', FakePC);
    vi.stubGlobal('MediaStream', class {});
    vi.stubGlobal('RTCRtpReceiver', { getCapabilities: () => ({ codecs: [{ mimeType: 'video/H264' }] }) });
    FakePC.all = [];
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('the viewer asks the room again when the hello says, and a relayed picture restarts onto the fresh credential', async () => {
    const sent: { to: string; d: MonRtc }[] = [];
    const link = new ViewerLink((to, d) => sent.push({ to, d }), [], 'v');
    const ask = vi.fn();
    link.onIceStale = ask;
    link.setIce(turn('night-1'), 3 * 3600_000);
    await link.connect('cam');
    const pc = FakePC.all[0];
    expect(pc.config.iceServers).toEqual(turn('night-1'));
    pc.connect(true);
    await settle();
    expect(link.path).toBe('relay');

    // Hours later the clock asks; the room's answer moves the live call onto the new credential.
    await vi.advanceTimersByTimeAsync(3 * 3600_000);
    expect(ask).toHaveBeenCalledTimes(1);
    link.setIce(turn('night-2'), 3 * 3600_000);
    await settle();
    expect(pc.config.iceServers).toEqual(turn('night-2'));
    expect(pc.offers.filter((o) => o.iceRestart)).toHaveLength(1);
    expect(sent.at(-1)!.d.sdp).toEqual({ type: 'offer', sdp: 'restart' });

    // The same credential again (a reconnect within minutes): no restart.
    link.setIce(turn('night-2'), 3 * 3600_000);
    await settle();
    expect(pc.offers.filter((o) => o.iceRestart)).toHaveLength(1);
    link.close();
    await vi.advanceTimersByTimeAsync(4 * 3600_000);
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it('a STUN-only answer (the TURN API failing for a moment) leaves a relayed picture on its credential, and asks again', async () => {
    const link = new ViewerLink(() => undefined, [], 'v');
    const ask = vi.fn();
    link.onIceStale = ask;
    link.setIce(turn('a'), 3 * 3600_000);
    await link.connect('cam');
    const pc = FakePC.all[0];
    pc.connect(true);
    await settle();
    link.setIce(STUN, 120_000);
    await settle();
    expect(pc.config.iceServers).toEqual(turn('a'));
    expect(pc.offers.filter((o) => o.iceRestart)).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(ask).toHaveBeenCalledTimes(1);
    link.close();
  });

  it('a direct picture only takes the new list for its next restart — no restart now', async () => {
    const link = new ViewerLink(() => undefined, [], 'v');
    link.setIce(turn('a'), 3 * 3600_000);
    await link.connect('cam');
    const pc = FakePC.all[0];
    pc.connect(false);
    await settle();
    link.setIce(turn('b'), 3 * 3600_000);
    await settle();
    expect(pc.config.iceServers).toEqual(turn('b'));
    expect(pc.offers.filter((o) => o.iceRestart)).toHaveLength(0);
    link.close();
  });

  it('the camera (which answers) asks a relayed viewer to restart; the viewer does', async () => {
    const sent: { to: string; d: MonRtc }[] = [];
    const hub = new CameraHub((to, d) => sent.push({ to, d }), turn('cam-1'), () => ({ video: { kind: 'video' } as unknown as MediaStreamTrack, audio: null }));
    const ask = vi.fn();
    hub.onIceStale = ask;
    hub.setIce(turn('cam-1'), 60_000);
    await hub.onSignal('s-relay', { sdp: { type: 'offer', sdp: 'o' }, pc: 'p1', vid: 'relayed' });
    await hub.onSignal('s-direct', { sdp: { type: 'offer', sdp: 'o' }, pc: 'p2', vid: 'direct' });
    FakePC.all[0].connect(true);
    FakePC.all[1].connect(false);
    await settle(); // the stats tick reads each path
    await vi.advanceTimersByTimeAsync(60_000);
    expect(ask).toHaveBeenCalled();
    sent.length = 0;
    hub.setIce(turn('cam-2'), 3 * 3600_000);
    expect(FakePC.all.map((p) => p.config.iceServers)).toEqual([turn('cam-2'), turn('cam-2')]);
    expect(sent).toEqual([{ to: 's-relay', d: { re: 1, pc: 'p1' } }]);
    hub.closeAll();

    // The viewer's side of it.
    const vsent: { to: string; d: MonRtc }[] = [];
    const link = new ViewerLink((to, d) => vsent.push({ to, d }), [], 'relayed');
    await link.connect('cam');
    const pc = FakePC.all.at(-1)!;
    pc.connect(true);
    const callId = vsent.find((m) => m.d.sdp)!.d.pc;
    await link.onSignal('cam', { re: 1, pc: callId });
    expect(pc.offers.filter((o) => o.iceRestart)).toHaveLength(1);
    link.close();
  });
});
