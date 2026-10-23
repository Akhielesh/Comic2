// @vitest-environment node
// The call mesh against a fake RTCPeerConnection, on fake timers: the connect
// watchdog and its reasons, connection ids, one-at-a-time signal handling,
// restarts and resends, what each copy of the video is encoded at, and the relay
// guardrails: capped video through a relay, fresh credentials before old ones lapse.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ANSWER_WAIT_MS, CallMesh, encodingFor, FAIL_MS, FAIL_TURN_MS, ICE_REFRESH_MS, MAX_SENDS, RELAY_GROUP_VIDEO_BPS, RELAY_VIDEO_BPS, SLOW_MS } from './callMesh';
import type { Call, CallPart, CallSignal } from './types';

/* ------------------------------------------------------------- fakes */

class FakeTrack {
  enabled = true;
  constructor(public kind: string, public id = Math.random().toString(36).slice(2)) {}
}

class FakeStream {
  private tracks: FakeTrack[];
  constructor(t: FakeTrack[] = []) {
    this.tracks = [...t];
  }
  getTracks() {
    return [...this.tracks];
  }
  getAudioTracks() {
    return this.tracks.filter((t) => t.kind === 'audio');
  }
  getVideoTracks() {
    return this.tracks.filter((t) => t.kind === 'video');
  }
  addTrack(t: FakeTrack) {
    this.tracks.push(t);
  }
  removeTrack(t: FakeTrack) {
    this.tracks = this.tracks.filter((x) => x !== t);
  }
}

class FakeSender {
  track: FakeTrack | null = null;
  params: { encodings: Record<string, unknown>[]; degradationPreference?: string } = { encodings: [{}] };
  replaceTrack(t: FakeTrack | null) {
    this.track = t;
    return Promise.resolve();
  }
  getParameters() {
    return JSON.parse(JSON.stringify(this.params));
  }
  setParameters(p: FakeSender['params']) {
    this.params = p;
    return Promise.resolve();
  }
}

class FakeTransceiver {
  currentDirection: string | null = null;
  sender = new FakeSender();
  receiver: { track: FakeTrack };
  codecs: { mimeType: string }[] | null = null;
  constructor(kind: string, public direction: string) {
    this.receiver = { track: new FakeTrack(kind) };
  }
  setCodecPreferences(c: { mimeType: string }[]) {
    this.codecs = c;
  }
}

const desc = (type: string, sdp: string) => ({ type, sdp, toJSON: () => ({ type, sdp }) });

class FakePC {
  static all: FakePC[] = [];
  static log: string[] = [];
  /** Delay setRemoteDescription (ms of fake time) — to prove signals are handled in order. */
  static srdDelay = 0;
  n = FakePC.all.length;
  transceivers: FakeTransceiver[] = [];
  localDescription: ReturnType<typeof desc> | null = null;
  remoteDescription: { type: string; sdp: string } | null = null;
  signalingState = 'stable';
  connectionState = 'new';
  onicecandidate: ((e: { candidate: unknown }) => void) | null = null;
  ontrack: ((e: { track: FakeTrack }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  added: RTCIceCandidateInit[] = [];
  remoteSets = 0;
  restarts = 0;
  private offers = 0;
  constructor(public config: RTCConfiguration) {
    FakePC.all.push(this);
  }
  addTransceiver(kind: string, init: { direction: string }) {
    const t = new FakeTransceiver(kind, init.direction);
    this.transceivers.push(t);
    return t;
  }
  getTransceivers() {
    return this.transceivers;
  }
  getSenders() {
    return this.transceivers.map((t) => t.sender);
  }
  async createOffer(o?: { iceRestart?: boolean }) {
    this.offers += 1;
    return { type: 'offer', sdp: `offer-${this.n}-${this.offers}${o?.iceRestart ? '-restart' : ''}` };
  }
  async createAnswer() {
    return { type: 'answer', sdp: `answer-${this.n}-${this.remoteSets}` };
  }
  async setLocalDescription(d: { type: string; sdp?: string }) {
    if (d.type === 'rollback') {
      this.localDescription = null;
      this.signalingState = 'stable';
      return;
    }
    FakePC.log.push(`pc${this.n} sld ${d.sdp}`);
    this.localDescription = desc(d.type, d.sdp ?? '');
    this.signalingState = d.type === 'offer' ? 'have-local-offer' : 'stable';
  }
  async setRemoteDescription(d: { type: string; sdp: string }) {
    FakePC.log.push(`pc${this.n} srd ${d.sdp} start`);
    if (FakePC.srdDelay) await new Promise((r) => setTimeout(r, FakePC.srdDelay));
    FakePC.log.push(`pc${this.n} srd ${d.sdp} end`);
    this.remoteDescription = d;
    this.remoteSets += 1;
    if (d.type === 'offer') {
      if (!this.transceivers.length) {
        this.addTransceiver('audio', { direction: 'recvonly' });
        this.addTransceiver('video', { direction: 'recvonly' });
      }
      this.signalingState = 'have-remote-offer';
    } else this.signalingState = 'stable';
  }
  async addIceCandidate(c: RTCIceCandidateInit) {
    this.added.push(c);
  }
  restartIce() {
    this.restarts += 1;
  }
  close() {
    this.connectionState = 'closed';
    this.signalingState = 'closed';
  }
  getConfiguration() {
    return this.config;
  }
  setConfiguration(c: RTCConfiguration) {
    this.config = c;
  }
  /** What getStats reports (its selected candidate pair is the path). */
  stats: Map<string, Record<string, unknown>> | null = null;
  async getStats() {
    return this.stats ?? new Map();
  }
  /** The selected pair goes through a relay (TURN) or straight across the internet. */
  onPath(relay: boolean) {
    this.stats = new Map<string, Record<string, unknown>>([
      ['t', { type: 'transport', id: 't', selectedCandidatePairId: 'cp' }],
      ['cp', { type: 'candidate-pair', id: 'cp', localCandidateId: 'l', remoteCandidateId: 'r' }],
      ['l', { type: 'local-candidate', id: 'l', candidateType: 'srflx', address: '93.1.2.3' }],
      ['r', { type: 'remote-candidate', id: 'r', candidateType: relay ? 'relay' : 'srflx', address: '81.1.2.3' }],
    ]);
  }
  /* test helpers */
  setState(s: string) {
    this.connectionState = s;
    this.onconnectionstatechange?.();
  }
  candidate(type: string) {
    const c = { candidate: `candidate:1 1 udp 1 10.0.0.1 9 typ ${type}`, sdpMid: '0' };
    this.onicecandidate?.({ candidate: { ...c, type, toJSON: () => c } });
  }
}

/* ------------------------------------------------------------- setup */

const part = (uid: string, sid: string, at: number, extra: Partial<CallPart> = {}): CallPart => ({ uid, name: uid.toUpperCase(), label: null, sid, at, mic: true, cam: true, ...extra });
const callOf = (parts: CallPart[]): Call => ({
  id: 'c1', from: { uid: 'a', name: 'A', label: null }, video: true, invited: ['b', 'c', 'd'], declined: [], at: 0, answeredAt: 1, parts, ever: {}, ended: null,
});
const cand = (type: string) => ({ candidate: `candidate:2 1 udp 1 1.2.3.4 9 typ ${type}`, sdpMid: '0' });

function mesh(me: string, opts: { ice?: RTCIceServer[]; relayOnly?: boolean; iceMs?: number; refreshIce?: () => void; warm?: () => RTCPeerConnection | null } = {}) {
  const sent: { to: string; d: CallSignal & { cid?: string } }[] = [];
  const m = new CallMesh({
    me,
    ice: opts.ice ?? [{ urls: 'stun:stun.example:3478' }],
    relayOnly: opts.relayOnly,
    iceMs: opts.iceMs,
    refreshIce: opts.refreshIce,
    warm: opts.warm,
    local: () => ({ audio: new FakeTrack('audio') as unknown as MediaStreamTrack, video: new FakeTrack('video') as unknown as MediaStreamTrack }),
    signal: (to, d) => sent.push({ to, d: d as CallSignal & { cid?: string } }),
    onChange: () => undefined,
  });
  const offers = () => sent.filter((s) => 'sdp' in s.d && s.d.sdp.type === 'offer');
  return { m, sent, offers };
}

const flush = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('window', globalThis);
  vi.stubGlobal('RTCPeerConnection', FakePC);
  vi.stubGlobal('MediaStream', FakeStream);
  FakePC.all = [];
  FakePC.log = [];
  FakePC.srdDelay = 0;
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/* ------------------------------------------------------------- tests */

describe('connect watchdog', () => {
  it('“still connecting” at 8 s, then failed at 15 s with the reason: our network found no public address', async () => {
    const { m, offers } = mesh('b');
    m.sync(callOf([part('a', 'sa', 1), part('b', 'sb', 2)]), 'sb');
    await flush();
    expect(offers()).toHaveLength(1); // the later joiner offers
    expect(FakePC.all[0].config).toMatchObject({ bundlePolicy: 'max-bundle', iceCandidatePoolSize: 1 });
    FakePC.all[0].candidate('host');
    await vi.advanceTimersByTimeAsync(SLOW_MS);
    expect(m.views[0].state).toBe('slow');
    await vi.advanceTimersByTimeAsync(FAIL_MS - SLOW_MS);
    expect(m.views[0]).toMatchObject({ state: 'failed', why: 'local_blocked' });
    expect(m.outcome).toMatchObject({ ttc: null, fail: 'local_blocked', turn: false });
  });

  it('both sides public but no relay: the networks can’t reach each other directly', async () => {
    const { m, sent } = mesh('b');
    const call = callOf([part('a', 'sa', 1), part('b', 'sb', 2)]);
    m.sync(call, 'sb');
    await flush();
    const cid = sent[0].d.cid!;
    FakePC.all[0].candidate('srflx');
    await m.onSignal('sa', { sdp: { type: 'answer', sdp: 'ans' }, cid }, call);
    await m.onSignal('sa', { cand: cand('srflx'), cid }, call);
    await vi.advanceTimersByTimeAsync(FAIL_MS);
    expect(m.views[0]).toMatchObject({ state: 'failed', why: 'nat' });
  });

  it('they sent only local addresses: their network blocks it', async () => {
    const { m, sent } = mesh('b');
    const call = callOf([part('a', 'sa', 1), part('b', 'sb', 2)]);
    m.sync(call, 'sb');
    await flush();
    FakePC.all[0].candidate('srflx');
    await m.onSignal('sa', { cand: cand('host'), cid: sent[0].d.cid }, call);
    await vi.advanceTimersByTimeAsync(FAIL_MS);
    expect(m.views[0].why).toBe('remote_blocked');
  });

  it('gives a relay longer (20 s) and blames the relay when even that fails', async () => {
    const { m, sent } = mesh('b', { ice: [{ urls: ['stun:s:3478'] }, { urls: ['turn:t:3478?transport=udp'], username: 'u', credential: 'c' }] });
    const call = callOf([part('a', 'sa', 1), part('b', 'sb', 2)]);
    m.sync(call, 'sb');
    await flush();
    FakePC.all[0].candidate('relay');
    await m.onSignal('sa', { cand: cand('srflx'), cid: sent[0].d.cid }, call);
    await vi.advanceTimersByTimeAsync(FAIL_MS);
    expect(m.views[0].state).toBe('slow');
    await vi.advanceTimersByTimeAsync(FAIL_TURN_MS - FAIL_MS);
    expect(m.views[0]).toMatchObject({ state: 'failed', why: 'relay_failed' });
  });

  it('relay test mode without a relay says so', async () => {
    const { m } = mesh('b', { relayOnly: true });
    m.sync(callOf([part('a', 'sa', 1), part('b', 'sb', 2)]), 'sb');
    await flush();
    expect(FakePC.all[0].config.iceTransportPolicy).toBe('relay');
    await vi.advanceTimersByTimeAsync(FAIL_MS);
    expect(m.views[0].why).toBe('no_relay');
  });

  it('a late success still counts: failed → connected', async () => {
    const { m } = mesh('b');
    m.sync(callOf([part('a', 'sa', 1), part('b', 'sb', 2)]), 'sb');
    await vi.advanceTimersByTimeAsync(FAIL_MS);
    expect(m.views[0].state).toBe('failed');
    FakePC.all[0].setState('connected');
    await flush();
    expect(m.views[0]).toMatchObject({ state: 'connected', why: null });
    expect(m.connectedUids).toEqual(['a']);
  });
});

describe('connection ids', () => {
  it('the same cid restarts the connection; a new cid replaces it', async () => {
    const { m, sent } = mesh('a');
    const call = callOf([part('a', 'sa', 1), part('b', 'sb', 2)]);
    m.sync(call, 'sa'); // earlier joiner: gets ready and waits
    expect(FakePC.all).toHaveLength(1);
    await m.onSignal('sb', { sdp: { type: 'offer', sdp: 'o1' }, cid: 'X' }, call);
    expect(sent.at(-1)).toMatchObject({ to: 'sb', d: { sdp: { type: 'answer' }, cid: 'X' } });
    // ICE restart of the same connection: same RTCPeerConnection.
    await m.onSignal('sb', { sdp: { type: 'offer', sdp: 'o1-restart' }, cid: 'X' }, call);
    expect(FakePC.all).toHaveLength(1);
    expect(FakePC.all[0].remoteSets).toBe(2);
    // A new connection (they reloaded / rebuilt): the old one is closed, a new one answers.
    await m.onSignal('sb', { sdp: { type: 'offer', sdp: 'o2' }, cid: 'Y' }, call);
    expect(FakePC.all).toHaveLength(2);
    expect(FakePC.all[0].connectionState).toBe('closed');
    expect(sent.at(-1)).toMatchObject({ d: { sdp: { type: 'answer' }, cid: 'Y' } });
  });

  it('candidates that beat their offer are kept for it', async () => {
    const { m } = mesh('a');
    const call = callOf([part('a', 'sa', 1), part('b', 'sb', 2)]);
    m.sync(call, 'sa');
    await m.onSignal('sb', { cand: cand('srflx'), cid: 'X' }, call);
    await m.onSignal('sb', { sdp: { type: 'offer', sdp: 'o1' }, cid: 'X' }, call);
    expect(FakePC.all[0].added).toEqual([cand('srflx')]);
  });

  it('a resent offer (our answer was on its way) is answered again, not re-applied', async () => {
    const { m, sent } = mesh('a');
    const call = callOf([part('a', 'sa', 1), part('b', 'sb', 2)]);
    m.sync(call, 'sa');
    await m.onSignal('sb', { sdp: { type: 'offer', sdp: 'o1' }, cid: 'X' }, call);
    await m.onSignal('sb', { sdp: { type: 'offer', sdp: 'o1' }, cid: 'X' }, call);
    expect(FakePC.all[0].remoteSets).toBe(1);
    expect(sent.filter((s) => 'sdp' in s.d && s.d.sdp.type === 'answer')).toHaveLength(2);
  });

  it('handles one person’s signals strictly in order', async () => {
    FakePC.srdDelay = 50;
    const { m } = mesh('a');
    const call = callOf([part('a', 'sa', 1), part('b', 'sb', 2)]);
    m.sync(call, 'sa');
    void m.onSignal('sb', { sdp: { type: 'offer', sdp: 'o1' }, cid: 'X' }, call);
    void m.onSignal('sb', { sdp: { type: 'offer', sdp: 'o2' }, cid: 'X' }, call);
    await vi.advanceTimersByTimeAsync(200);
    expect(FakePC.log).toEqual(['pc0 srd o1 start', 'pc0 srd o1 end', 'pc0 sld answer-0-1', 'pc0 srd o2 start', 'pc0 srd o2 end', 'pc0 sld answer-0-2']);
  });

  it('both offered at once: the higher socket id’s offer stands', async () => {
    // We (sz) and they (sb) each started a new connection.
    const { m, sent } = mesh('a');
    const call = callOf([part('a', 'sz', 3), part('b', 'sb', 2)]);
    m.sync(call, 'sz');
    await flush();
    const mine = sent[0].d.cid;
    await m.onSignal('sb', { sdp: { type: 'offer', sdp: 'theirs' }, cid: 'THEIRS' }, call);
    expect(FakePC.all).toHaveLength(1);
    expect(FakePC.all[0].signalingState).toBe('have-local-offer');
    expect(mine).not.toBe('THEIRS');
    // Mirror image: the lower id gives way and answers theirs.
    const other = mesh('b');
    const call2 = callOf([part('a', 'sz', 1), part('b', 'sb', 3)]);
    other.m.sync(call2, 'sb');
    await flush();
    await other.m.onSignal('sz', { sdp: { type: 'offer', sdp: 'from-z' }, cid: 'Z' }, call2);
    expect(other.sent.at(-1)).toMatchObject({ to: 'sz', d: { sdp: { type: 'answer' }, cid: 'Z' } });
  });

  it('signals from older apps (no cid) still connect', async () => {
    const { m, sent } = mesh('a');
    const call = callOf([part('a', 'sa', 1), part('b', 'sb', 2)]);
    m.sync(call, 'sa');
    await m.onSignal('sb', { sdp: { type: 'offer', sdp: 'old' } }, call);
    await m.onSignal('sb', { cand: cand('srflx') }, call);
    expect(FakePC.all[0].added).toHaveLength(1);
    expect(sent.at(-1)?.d).toMatchObject({ sdp: { type: 'answer' }, cid: 'legacy' });
  });
});

describe('keeping the handshake moving', () => {
  it('resends an unanswered offer every 2 s — five times a minute at most', async () => {
    const { m, offers } = mesh('b');
    m.sync(callOf([part('a', 'sa', 1), part('b', 'sb', 2)]), 'sb');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(offers()).toHaveLength(MAX_SENDS);
    expect(new Set(offers().map((o) => ('sdp' in o.d ? o.d.sdp.sdp : '')))).toEqual(new Set(['offer-0-1'])); // the same offer, again
  });

  it('their app came back on a new connection: the pending offer goes to it at once', async () => {
    const { m, offers } = mesh('b');
    m.sync(callOf([part('a', 'sa', 1), part('b', 'sb', 2)]), 'sb');
    await vi.advanceTimersByTimeAsync(30_000);
    m.sync(callOf([part('a', 'sa2', 5), part('b', 'sb', 2)]), 'sb');
    await flush();
    expect(offers().at(-1)?.to).toBe('sa2');
  });

  it('a dropped connection is restarted after 3 s; the restart is resent until answered', async () => {
    const { m, sent, offers } = mesh('b');
    const call = callOf([part('a', 'sa', 1), part('b', 'sb', 2)]);
    m.sync(call, 'sb');
    await flush();
    const cid = sent[0].d.cid;
    await m.onSignal('sa', { sdp: { type: 'answer', sdp: 'ans' }, cid }, call);
    const pc = FakePC.all[0];
    pc.setState('connected');
    pc.setState('disconnected');
    expect(m.views[0].state).toBe('reconnecting');
    await vi.advanceTimersByTimeAsync(2000);
    expect(pc.restarts).toBe(0);
    await vi.advanceTimersByTimeAsync(2000);
    expect(pc.restarts).toBe(1);
    expect(offers().at(-1)).toMatchObject({ d: { sdp: { sdp: 'offer-0-2-restart' }, cid } });
    const n = offers().length;
    await vi.advanceTimersByTimeAsync(2100);
    expect(offers().length).toBe(n + 1); // resent (their line may have been down)
    await m.onSignal('sa', { sdp: { type: 'answer', sdp: 'ans2' }, cid }, call);
    pc.setState('connected');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(offers().length).toBe(n + 1);
    expect(m.views[0].state).toBe('connected');
  });

  it('the answering side asks the offerer to restart', async () => {
    const { m, sent } = mesh('a');
    const call = callOf([part('a', 'sa', 1), part('b', 'sb', 2)]);
    m.sync(call, 'sa');
    await m.onSignal('sb', { sdp: { type: 'offer', sdp: 'o1' }, cid: 'X' }, call);
    FakePC.all[0].setState('connected');
    FakePC.all[0].setState('failed');
    await flush();
    expect(sent.at(-1)).toEqual({ to: 'sb', d: { restart: true, cid: 'X' } });
  });

  it('the offerer restarts when asked', async () => {
    const { m, sent, offers } = mesh('b');
    const call = callOf([part('a', 'sa', 1), part('b', 'sb', 2)]);
    m.sync(call, 'sb');
    await flush();
    const cid = sent[0].d.cid;
    await m.onSignal('sa', { sdp: { type: 'answer', sdp: 'ans' }, cid }, call);
    FakePC.all[0].setState('connected');
    FakePC.all[0].setState('disconnected');
    await m.onSignal('sa', { restart: true, cid }, call);
    await flush();
    expect(offers().at(-1)?.d).toMatchObject({ sdp: { sdp: 'offer-0-2-restart' } });
  });

  it('we joined earlier but their offer never came: after 4 s we offer', async () => {
    const { m, offers } = mesh('a');
    m.sync(callOf([part('a', 'sa', 1), part('b', 'sb', 2)]), 'sa');
    await vi.advanceTimersByTimeAsync(ANSWER_WAIT_MS - 1000);
    expect(offers()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(offers()).toHaveLength(1);
    expect(offers()[0].to).toBe('sb');
  });

  it('“Try again” and a network change start failed connections over, offering a new one', async () => {
    const { m, offers } = mesh('b');
    m.sync(callOf([part('a', 'sa', 1), part('b', 'sb', 2)]), 'sb');
    await vi.advanceTimersByTimeAsync(FAIL_MS);
    expect(m.views[0].state).toBe('failed');
    const before = new Set(offers().map((o) => o.d.cid));
    m.retry();
    await flush();
    expect(FakePC.all).toHaveLength(2);
    expect(FakePC.all[0].connectionState).toBe('closed');
    expect(before.has(offers().at(-1)!.d.cid)).toBe(false);
    expect(m.views[0].state).toBe('connecting');
    await vi.advanceTimersByTimeAsync(FAIL_MS);
    m.kick();
    await flush();
    expect(FakePC.all).toHaveLength(3);
  });

  it('fresh relay credentials reach the live connections', () => {
    const { m } = mesh('b');
    m.sync(callOf([part('a', 'sa', 1), part('b', 'sb', 2)]), 'sb');
    const turn = [{ urls: 'turns:t:443?transport=tcp', username: 'u', credential: 'c' }];
    m.setIce(turn);
    expect(FakePC.all[0].config.iceServers).toEqual(turn);
    expect(m.relayOffered).toBe(true);
  });
});

describe('media', () => {
  const encodings = () => FakePC.all.map((pc) => pc.transceivers.find((t) => t.receiver.track.kind === 'video')!.sender.params);

  it('one other person: full resolution at 1.5 Mbps, keeping the frame rate', () => {
    const { m } = mesh('b');
    m.sync(callOf([part('a', 'sa', 1), part('b', 'sb', 2)]), 'sb');
    expect(encodings()[0]).toMatchObject({ encodings: [{ maxBitrate: 1_500_000, scaleResolutionDownBy: 1, maxFramerate: 30 }], degradationPreference: 'maintain-framerate' });
  });

  it('three others: each copy at 360p, 24 fps, 600 kbps', () => {
    const { m } = mesh('d');
    m.sync(callOf([part('a', 'sa', 1), part('b', 'sb', 2), part('c', 'sc', 3), part('d', 'sd', 4)]), 'sd');
    expect(FakePC.all).toHaveLength(3);
    for (const e of encodings()) expect(e.encodings[0]).toMatchObject({ maxBitrate: 600_000, scaleResolutionDownBy: 2, maxFramerate: 24 });
  });

  it('prefers H.264 when this phone can encode it', () => {
    vi.stubGlobal('RTCRtpReceiver', { getCapabilities: () => ({ codecs: [{ mimeType: 'video/VP8' }, { mimeType: 'video/H264', sdpFmtpLine: 'packetization-mode=0' }, { mimeType: 'video/H264', sdpFmtpLine: 'packetization-mode=1' }] }) });
    vi.stubGlobal('RTCRtpSender', { getCapabilities: () => ({ codecs: [{ mimeType: 'video/VP8' }, { mimeType: 'video/H264' }] }) });
    const { m } = mesh('b');
    m.sync(callOf([part('a', 'sa', 1), part('b', 'sb', 2)]), 'sb');
    const video = FakePC.all[0].transceivers.find((t) => t.receiver.track.kind === 'video')!;
    expect(video.codecs?.map((c) => `${c.mimeType} ${(c as { sdpFmtpLine?: string }).sdpFmtpLine ?? ''}`.trim())).toEqual([
      'video/H264 packetization-mode=1', 'video/H264 packetization-mode=0', 'video/VP8',
    ]);
  });

  it('keeps one stream per person: tracks swap inside it', async () => {
    const { m } = mesh('b');
    m.sync(callOf([part('a', 'sa', 1), part('b', 'sb', 2)]), 'sb');
    const stream = m.views[0].stream as unknown as FakeStream;
    const pc = FakePC.all[0];
    pc.ontrack?.({ track: new FakeTrack('audio') });
    pc.ontrack?.({ track: new FakeTrack('video') });
    const v2 = new FakeTrack('video');
    pc.ontrack?.({ track: v2 });
    expect(m.views[0].stream).toBe(stream);
    expect(stream.getVideoTracks()).toEqual([v2]);
    expect(stream.getTracks()).toHaveLength(2);
  });
});

/* -------------------------------------------------- relays (TURN, billed per GB) */

const turn = (user: string): RTCIceServer[] => [{ urls: 'stun:stun.example:3478' }, { urls: 'turn:turn.example:3478?transport=udp', username: user, credential: 'c' }];
const videoParams = (pc: FakePC) => pc.transceivers.find((t) => t.receiver.track.kind === 'video')!.sender.params.encodings[0];

describe('relays: capped video', () => {
  it('a relayed copy is ≤ 700 kbps one-to-one, ≤ 450 kbps in a group — ≤ 0.4 GB per relayed call-hour', () => {
    expect(encodingFor(1)).toMatchObject({ maxBitrate: 1_500_000 });
    expect(encodingFor(1, 0, true)).toMatchObject({ maxBitrate: RELAY_VIDEO_BPS, scaleResolutionDownBy: 1, maxFramerate: 30 });
    expect(encodingFor(2, 0, true).maxBitrate).toBe(RELAY_GROUP_VIDEO_BPS);
    expect(encodingFor(3, 0, true).maxBitrate).toBe(RELAY_GROUP_VIDEO_BPS);
    expect(encodingFor(2).maxBitrate).toBe(900_000);
    // What the relaying phone receives in a 1:1 hour: video + Opus (~64 kbps), plus ~8% RTP/TURN overhead.
    const gbPerHour = ((RELAY_VIDEO_BPS + 64_000) * 1.08 * 3600) / 8 / 1e9;
    expect(gbPerHour).toBeLessThanOrEqual(0.4);
  });

  it('caps only the connection whose path is relayed, and follows the path as it changes', async () => {
    const { m } = mesh('c');
    m.sync(callOf([part('a', 'sa', 1), part('b', 'sb', 2), part('c', 'sc', 3)]), 'sc');
    await flush();
    const [toA, toB] = FakePC.all;
    toA.onPath(true);
    toB.onPath(false);
    toA.setState('connected');
    toB.setState('connected');
    await flush();
    expect(videoParams(toA).maxBitrate).toBe(RELAY_GROUP_VIDEO_BPS);
    expect(videoParams(toB).maxBitrate).toBe(900_000);
    // An ICE restart moved B onto a relay, and A off it: the next stats read (3 s) follows.
    toB.onPath(true);
    toA.onPath(false);
    await vi.advanceTimersByTimeAsync(3000);
    expect(videoParams(toB).maxBitrate).toBe(RELAY_GROUP_VIDEO_BPS);
    expect(videoParams(toA).maxBitrate).toBe(900_000);
    expect(m.views.map((v) => v.path)).toEqual(['internet', 'relay']);
  });
});

describe('relays: fresh credentials before the old ones lapse', () => {
  it('asks the room when it says, re-armed by each delivery; without a time, after ICE_REFRESH_MS when there is a relay', async () => {
    const ask = vi.fn();
    const { m } = mesh('b', { ice: turn('u1'), iceMs: 60_000, refreshIce: ask });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(ask).toHaveBeenCalledTimes(1);
    m.setIce(turn('u2'), 2 * 3600_000);
    await vi.advanceTimersByTimeAsync(2 * 3600_000 - 1);
    expect(ask).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(ask).toHaveBeenCalledTimes(2);
    m.setIce(turn('u3'));
    await vi.advanceTimersByTimeAsync(ICE_REFRESH_MS);
    expect(ask).toHaveBeenCalledTimes(3);
    m.close();
    await vi.advanceTimersByTimeAsync(10 * 3600_000);
    expect(ask).toHaveBeenCalledTimes(3);

    const stunOnly = vi.fn();
    mesh('b', { refreshIce: stunOnly });
    await vi.advanceTimersByTimeAsync(10 * 3600_000);
    expect(stunOnly).not.toHaveBeenCalled();
  });

  it('the offerer restarts a relayed connection onto fresh credentials; a direct one waits for its next restart', async () => {
    const { m, offers } = mesh('c', { ice: turn('u1') });
    m.sync(callOf([part('a', 'sa', 1), part('b', 'sb', 2), part('c', 'sc', 3)]), 'sc');
    await flush();
    const [toA, toB] = FakePC.all;
    toA.onPath(true);
    toB.onPath(false);
    toA.setState('connected');
    toB.setState('connected');
    await flush();
    const before = offers().length;
    m.setIce(turn('u2'));
    await flush();
    expect(toA.config.iceServers).toEqual(turn('u2'));
    expect(toB.config.iceServers).toEqual(turn('u2'));
    const restarted = offers().slice(before);
    expect(restarted.map((o) => o.to)).toEqual(['sa']);
    expect('sdp' in restarted[0].d && restarted[0].d.sdp.sdp).toMatch(/-restart$/);
    // The same credentials again: nothing to move.
    m.setIce(turn('u2'));
    await flush();
    expect(offers().length).toBe(before + 1);
  });

  it('the answering side asks the offerer to restart; the offerer does, even though it is connected', async () => {
    const call = callOf([part('a', 'sa', 1), part('b', 'sb', 2)]);
    // A joined first, so B offers: A answers.
    const a = mesh('a', { ice: turn('a1') });
    a.m.sync(call, 'sa');
    await a.m.onSignal('sb', { sdp: { type: 'offer', sdp: 'x' }, cid: 'k1' }, call);
    const pcA = FakePC.all[0];
    pcA.onPath(true);
    pcA.setState('connected');
    await flush();
    a.m.setIce(turn('a2'));
    expect(a.sent.at(-1)).toEqual({ to: 'sb', d: { restart: true, renew: true, cid: 'k1' } });

    const b = mesh('b', { ice: turn('b1') });
    b.m.sync(call, 'sb');
    await flush();
    const pcB = FakePC.all[1];
    const cid = (b.offers()[0].d as { cid: string }).cid;
    await b.m.onSignal('sa', { sdp: { type: 'answer', sdp: 'y' }, cid }, call);
    pcB.setState('connected');
    await flush();
    const before = b.offers().length;
    // An ordinary restart request is ignored while connected (it's an older app's "help")…
    await b.m.onSignal('sa', { restart: true, cid }, call);
    expect(b.offers().length).toBe(before);
    // …a renewal is not; and one for some other connection is.
    await b.m.onSignal('sa', { restart: true, renew: true, cid: 'other' }, call);
    expect(b.offers().length).toBe(before);
    await b.m.onSignal('sa', { restart: true, renew: true, cid }, call);
    await flush();
    expect(b.offers().length).toBe(before + 1);
    expect(pcB.restarts).toBe(1);
  });

  it('a STUN-only answer keeps the relay credentials the call holds (they lapse on their own)', () => {
    const { m } = mesh('b', { ice: turn('u1') });
    m.sync(callOf([part('a', 'sa', 1), part('b', 'sb', 2)]), 'sb');
    m.setIce([{ urls: 'stun:stun.example:3478' }], 120_000);
    expect(FakePC.all[0].config.iceServers).toEqual(turn('u1'));
    expect(m.relayOffered).toBe(true);
  });

  it('a connection made while ringing with credentials since replaced gathers with the fresh ones', () => {
    const warm = new FakePC({ iceServers: turn('old'), bundlePolicy: 'max-bundle', iceCandidatePoolSize: 1 });
    const { m } = mesh('b', { ice: turn('new'), warm: () => warm as unknown as RTCPeerConnection });
    m.sync(callOf([part('a', 'sa', 1), part('b', 'sb', 2)]), 'sb');
    expect(FakePC.all).toEqual([warm]);
    expect(warm.config).toMatchObject({ iceServers: turn('new'), iceCandidatePoolSize: 1 });
  });

  // Regression (review of C6): picking up a family call offers at once with the joiner's own line
  // credentials (counted against the joiner); the call's own, counted against its caller, arrive
  // ~100-300 ms later in call_joined. setConfiguration alone never moves a gathering that already
  // happened, so the joiner's relay stayed on its own credentials for the whole call.
  it('credentials replaced before a connection is up: once it connects through a relay, it moves onto them — once', async () => {
    const call = callOf([part('a', 'sa', 1), part('b', 'sb', 2)]);
    const { m, offers } = mesh('b', { ice: turn('line') });
    m.sync(call, 'sb');
    await flush();
    const pc = FakePC.all[0];
    expect(offers()).toHaveLength(1);
    m.setIce(turn('caller'));
    await flush();
    expect(offers()).toHaveLength(1); // not up yet: nothing restarted mid-handshake
    const cid = (offers()[0].d as { cid: string }).cid;
    await m.onSignal('sa', { sdp: { type: 'answer', sdp: 'y' }, cid }, call);
    pc.onPath(true);
    pc.setState('connected');
    await flush();
    expect(offers()).toHaveLength(2);
    const moved = offers()[1].d;
    expect('sdp' in moved && moved.sdp.sdp).toMatch(/-restart$/);
    expect(pc.restarts).toBe(1);
    // Moved: later connects and path reads leave it alone.
    pc.setState('connected');
    await vi.advanceTimersByTimeAsync(9000);
    expect(offers()).toHaveLength(2);
  });

  it('a direct connection on replaced credentials is left alone — until its path turns to a relay', async () => {
    const call = callOf([part('a', 'sa', 1), part('b', 'sb', 2)]);
    const { m, offers } = mesh('b', { ice: turn('line') });
    m.sync(call, 'sb');
    await flush();
    const pc = FakePC.all[0];
    m.setIce(turn('caller'));
    const cid = (offers()[0].d as { cid: string }).cid;
    await m.onSignal('sa', { sdp: { type: 'answer', sdp: 'y' }, cid }, call);
    pc.onPath(false);
    pc.setState('connected');
    await vi.advanceTimersByTimeAsync(3000);
    expect(offers()).toHaveLength(1);
    pc.onPath(true);
    await vi.advanceTimersByTimeAsync(3000);
    expect(offers()).toHaveLength(2);
    const moved = offers()[1].d;
    expect('sdp' in moved && moved.sdp.sdp).toMatch(/-restart$/);
  });

  it('the answering side asks its offerer to move a connection that came up on replaced credentials — only once', async () => {
    const call = callOf([part('a', 'sa', 1), part('b', 'sb', 2)]);
    const { m, sent } = mesh('a', { ice: turn('line') });
    m.sync(call, 'sa');
    await m.onSignal('sb', { sdp: { type: 'offer', sdp: 'x' }, cid: 'k1' }, call);
    m.setIce(turn('caller'));
    const pc = FakePC.all[0];
    pc.onPath(true);
    pc.setState('connected');
    await flush();
    const asks = () => sent.filter((s) => 'restart' in s.d);
    expect(asks()).toEqual([{ to: 'sb', d: { restart: true, renew: true, cid: 'k1' } }]);
    // The offerer (an older app) didn't act on it: we don't keep asking.
    pc.setState('connected');
    await vi.advanceTimersByTimeAsync(9000);
    expect(asks()).toHaveLength(1);
    // It restarted after all: our answer gathers with the call's credentials, so nothing more to ask.
    await m.onSignal('sb', { sdp: { type: 'offer', sdp: 'x2' }, cid: 'k1' }, call);
    m.setIce(turn('caller'));
    await vi.advanceTimersByTimeAsync(3000);
    expect(asks()).toHaveLength(1);
  });
});
