// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { adapt, CameraHub, classifyPath, encodingFor, LADDER, newAdapt, orderCodecs, readEncStats, summarizeEnc, ViewerLink, type EncSample } from './rtc';
import type { MonRtc } from './protocol';

describe('classifyPath', () => {
  it('home Wi-Fi: host candidates or private addresses on both ends', () => {
    expect(classifyPath({ candidateType: 'host', address: '192.168.1.20' }, { candidateType: 'host', address: '192.168.1.31' })).toBe('lan');
    // mDNS-hidden host candidate on the far end, learned as peer-reflexive with a private address.
    expect(classifyPath({ candidateType: 'host' }, { candidateType: 'prflx', address: '10.0.0.7' })).toBe('lan');
    expect(classifyPath({ candidateType: 'host', address: 'a1b2.local' }, { candidateType: 'host' })).toBe('lan');
    expect(classifyPath({ candidateType: 'host', address: 'fd12:3456::1' }, { candidateType: 'prflx', address: 'fe80::1' })).toBe('lan');
  });

  it('internet: a public (server-reflexive) address on either end', () => {
    expect(classifyPath({ candidateType: 'srflx', address: '81.2.3.4' }, { candidateType: 'srflx', address: '93.1.2.3' })).toBe('internet');
    expect(classifyPath({ candidateType: 'host', address: '192.168.1.20' }, { candidateType: 'prflx', address: '93.1.2.3' })).toBe('internet');
  });

  it('relay wins over everything', () => {
    expect(classifyPath({ candidateType: 'relay' }, { candidateType: 'host', address: '192.168.1.3' })).toBe('relay');
    expect(classifyPath({ candidateType: 'host' }, { candidateType: 'relay' })).toBe('relay');
  });
});

describe('encodingFor (the ladder)', () => {
  const hd = { quality: 'hd' as const, pressure: 0 };
  it('steps down as more viewers share the home upload', () => {
    const at = (n: number) => encodingFor({ ...hd, peers: n, internetPeers: n, path: 'internet' });
    expect(at(1)).toEqual({ maxBitrate: 1_600_000, scaleResolutionDownBy: 1, maxFramerate: 24 });
    expect(at(2)).toEqual({ maxBitrate: 1_100_000, scaleResolutionDownBy: 1, maxFramerate: 24 });
    expect(at(3)).toEqual({ maxBitrate: 800_000, scaleResolutionDownBy: 1.5, maxFramerate: 20 });
    expect(at(4)).toEqual({ maxBitrate: 500_000, scaleResolutionDownBy: 2, maxFramerate: 15 });
    expect(at(8)).toEqual({ maxBitrate: 500_000, scaleResolutionDownBy: 2, maxFramerate: 15 });
  });

  it('home Wi-Fi viewers are exempt from the upload budget (but not from the processor)', () => {
    expect(encodingFor({ ...hd, peers: 3, internetPeers: 2, path: 'lan' })).toEqual(LADDER[0]);
    expect(encodingFor({ ...hd, peers: 3, internetPeers: 2, path: 'internet' })).toEqual(LADDER[1]);
    // An unknown path counts as internet until it's known.
    expect(encodingFor({ ...hd, peers: 3, internetPeers: 3, path: null })).toEqual(LADDER[2]);
    // Many encoders at once: smaller pictures even at home.
    expect(encodingFor({ ...hd, peers: 5, internetPeers: 0, path: 'lan' })).toEqual(LADDER[2]);
  });

  it('a busy phone steps everyone down, to a floor', () => {
    expect(encodingFor({ ...hd, peers: 1, internetPeers: 1, path: 'internet', pressure: 1 })).toEqual(LADDER[1]);
    expect(encodingFor({ ...hd, peers: 4, internetPeers: 4, path: 'internet', pressure: 2 })).toEqual(LADDER[4]);
    expect(encodingFor({ ...hd, peers: 4, internetPeers: 4, path: 'internet', pressure: 9 })).toEqual(LADDER[4]);
  });

  it('caps a TURN relay path and the viewer’s Data saver choice', () => {
    expect(encodingFor({ ...hd, peers: 1, internetPeers: 1, path: 'relay' })).toEqual({ maxBitrate: 650_000, scaleResolutionDownBy: 2, maxFramerate: 20 });
    expect(encodingFor({ quality: 'sd', pressure: 0, peers: 1, internetPeers: 0, path: 'lan' })).toEqual({ maxBitrate: 450_000, scaleResolutionDownBy: 2, maxFramerate: 15 });
    expect(encodingFor({ quality: 'sd', pressure: 0, peers: 8, internetPeers: 8, path: 'internet' })).toEqual({ maxBitrate: 450_000, scaleResolutionDownBy: 2, maxFramerate: 15 });
  });

  it('trims a bandwidth-limited viewer, never below 300 kbps', () => {
    expect(encodingFor({ ...hd, peers: 1, internetPeers: 1, path: 'internet', bw: 0.75 }).maxBitrate).toBe(1_200_000);
    expect(encodingFor({ ...hd, peers: 1, internetPeers: 1, path: 'internet', bw: 0.2 }).maxBitrate).toBe(320_000);
    expect(encodingFor({ ...hd, peers: 4, internetPeers: 4, path: 'internet', bw: 0.2 }).maxBitrate).toBe(300_000);
  });
});

describe('orderCodecs', () => {
  const caps = [
    { mimeType: 'video/VP8' },
    { mimeType: 'video/rtx', sdpFmtpLine: 'apt=96' },
    { mimeType: 'video/VP9', sdpFmtpLine: 'profile-id=0' },
    { mimeType: 'video/H264', sdpFmtpLine: 'level-asymmetry-allowed=1;packetization-mode=0;profile-level-id=42e01f' },
    { mimeType: 'video/H264', sdpFmtpLine: 'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=640c1f' },
    { mimeType: 'video/H264', sdpFmtpLine: 'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f' },
    { mimeType: 'video/AV1' },
    { mimeType: 'video/red' },
    { mimeType: 'video/ulpfec' },
  ];

  it('H.264 (baseline, packetization-mode 1 first), then VP8, then the rest in order — keeping rtx/red/fec', () => {
    const out = orderCodecs(caps).map((c) => `${c.mimeType}${c.sdpFmtpLine?.includes('profile-level-id') ? ` ${/packetization-mode=(\d)/.exec(c.sdpFmtpLine)![1]}/${/profile-level-id=(\w{4})/.exec(c.sdpFmtpLine)![1]}` : ''}`);
    expect(out).toEqual(['video/H264 1/42e0', 'video/H264 1/640c', 'video/H264 0/42e0', 'video/VP8', 'video/rtx', 'video/VP9', 'video/AV1', 'video/red', 'video/ulpfec']);
    expect(orderCodecs(caps)).toHaveLength(caps.length);
  });

  it('a browser without H.264 keeps VP8 first', () => {
    expect(orderCodecs([{ mimeType: 'video/VP9' }, { mimeType: 'video/VP8' }]).map((c) => c.mimeType)).toEqual(['video/VP8', 'video/VP9']);
  });
});

describe('encoder stats and adaptation', () => {
  const sample = (key: string, lim: EncSample['lim'], path: EncSample['path'] = 'internet', fps = 24): EncSample => ({ key, lim, fps, impl: 'MediaCodec', w: 1280, path });

  it('reads the video sender and the network path from a stats report', () => {
    const report = new Map<string, Record<string, unknown>>([
      ['o1', { type: 'outbound-rtp', id: 'o1', kind: 'audio' }],
      ['o2', { type: 'outbound-rtp', id: 'o2', kind: 'video', qualityLimitationReason: 'cpu', framesPerSecond: 11, encoderImplementation: 'libvpx', frameWidth: 640 }],
      ['t', { type: 'transport', id: 't', selectedCandidatePairId: 'p' }],
      ['p', { type: 'candidate-pair', id: 'p', localCandidateId: 'l', remoteCandidateId: 'r' }],
      ['l', { type: 'local-candidate', id: 'l', candidateType: 'host', address: '192.168.1.2' }],
      ['r', { type: 'remote-candidate', id: 'r', candidateType: 'srflx', address: '81.2.3.4' }],
    ]);
    expect(readEncStats(report as never)).toEqual({ lim: 'cpu', fps: 11, impl: 'libvpx', w: 640, path: 'internet' });
  });

  it('CPU-limited on two ticks → one rung down for everyone; 30 s calm → back up', () => {
    let s = newAdapt(0);
    let r = adapt(s, [sample('a', 'cpu'), sample('b', 'none')], 5000);
    expect(r.changed).toBe(false);
    r = adapt(r.s, [sample('a', 'cpu')], 10_000);
    expect(r).toMatchObject({ changed: true, s: { pressure: 1 } });
    s = r.s;
    r = adapt(s, [sample('a', 'none')], 30_000);
    expect(r.s.pressure).toBe(1);
    r = adapt(r.s, [sample('a', 'none')], 40_000);
    expect(r).toMatchObject({ changed: true, s: { pressure: 0 } });
  });

  it('never steps down more than two rungs for the processor', () => {
    let s = newAdapt(0);
    for (let t = 5000; t <= 60_000; t += 5000) s = adapt(s, [sample('a', 'cpu')], t).s;
    expect(s.pressure).toBe(2);
  });

  it('bandwidth-limited over the internet (twice in a row) trims that viewer only; home Wi-Fi is left alone', () => {
    const all = [sample('far', 'bandwidth'), sample('home', 'bandwidth', 'lan'), sample('ok', 'none')];
    // One reading is a new call ramping up: nothing yet.
    let r = adapt(newAdapt(0), all, 5000);
    expect(r.changed).toBe(false);
    expect(r.s.bw.far.f).toBe(1);
    r = adapt(r.s, all, 10_000);
    expect(r.changed).toBe(true);
    expect(r.s.bw.far.f).toBe(0.75);
    expect(r.s.bw.home.f).toBe(1);
    expect(r.s.bw.ok.f).toBe(1);
    // A clean reading in between restarts the count.
    r = adapt(r.s, [sample('far', 'none')], 15_000);
    r = adapt(r.s, [sample('far', 'bandwidth')], 20_000);
    expect(r.s.bw.far.f).toBe(0.75);
    r = adapt(r.s, [sample('far', 'none')], 30_000);
    expect(r.s.bw.far.f).toBe(0.75);
    r = adapt(r.s, [sample('far', 'none')], 41_000);
    expect(r.s.bw.far.f).toBe(1);
  });

  it('summarizes for the family: slowest fps, worst limit, largest picture', () => {
    expect(summarizeEnc([sample('a', 'none', 'lan', 24), { ...sample('b', 'cpu', 'internet', 9.6), w: 640 }], 1)).toEqual({ peers: 2, fps: 10, lim: 'cpu', impl: 'MediaCodec', w: 1280, p: 1 });
    expect(summarizeEnc([], 0)).toEqual({ peers: 0, fps: null, lim: null, impl: null, w: null, p: 0 });
  });
});

/* ------------------------------------------------ a fake RTCPeerConnection */

class FakeSender {
  track: unknown = null;
  params: { encodings: Record<string, unknown>[]; degradationPreference?: string } = { encodings: [{}] };
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

class FakeTransceiver {
  direction = 'sendrecv';
  sender = new FakeSender();
  receiver: { track: { kind: string } };
  prefs: unknown[] | null = null;
  constructor(kind: string) {
    this.receiver = { track: { kind } };
  }
  setCodecPreferences(c: unknown[]) {
    this.prefs = c;
  }
}

class FakePC {
  static all: FakePC[] = [];
  connectionState = 'new';
  signalingState = 'stable';
  remote: { type: string; sdp: string } | null = null;
  localDescription: { toJSON(): unknown } | null = null;
  transceivers: FakeTransceiver[] = [];
  candidates: unknown[] = [];
  onconnectionstatechange: (() => void) | null = null;
  onicecandidate: ((e: { candidate: null }) => void) | null = null;
  ondatachannel: unknown = null;
  ontrack: unknown = null;
  constructor() {
    FakePC.all.push(this);
  }
  getTransceivers() {
    return this.transceivers;
  }
  addTransceiver(kind: string) {
    const t = new FakeTransceiver(kind);
    this.transceivers.push(t);
    return t;
  }
  createDataChannel() {
    return { onmessage: null };
  }
  async setRemoteDescription(d: { type: string; sdp: string }) {
    this.remote = d;
    if (d.type === 'offer' && !this.transceivers.length) this.transceivers.push(new FakeTransceiver('video'), new FakeTransceiver('audio'));
  }
  async createAnswer() {
    return { type: 'answer', sdp: 'a' };
  }
  async createOffer() {
    return { type: 'offer', sdp: 'o' };
  }
  async setLocalDescription(d: unknown) {
    this.localDescription = { toJSON: () => d };
  }
  async addIceCandidate(c: unknown) {
    this.candidates.push(c);
  }
  /** What getStats reports (the selected candidate pair decides LAN vs internet). */
  stats: Map<string, Record<string, unknown>> | null = null;
  async getStats() {
    return this.stats ?? new Map();
  }
  close() {
    this.connectionState = 'closed';
    this.signalingState = 'closed';
  }
  connect(path?: 'lan' | 'internet') {
    if (path) this.stats = pathStats(path === 'lan');
    this.connectionState = 'connected';
    this.onconnectionstatechange?.();
  }
}

/** A stats report whose selected pair is on the home Wi-Fi or across the internet. */
function pathStats(lan: boolean): Map<string, Record<string, unknown>> {
  return new Map<string, Record<string, unknown>>([
    ['t', { type: 'transport', id: 't', selectedCandidatePairId: 'cp' }],
    ['cp', { type: 'candidate-pair', id: 'cp', localCandidateId: 'l', remoteCandidateId: 'r' }],
    ['l', { type: 'local-candidate', id: 'l', candidateType: 'host', address: '192.168.1.2' }],
    ['r', { type: 'remote-candidate', id: 'r', candidateType: lan ? 'host' : 'srflx', address: lan ? '192.168.1.9' : '93.1.2.3' }],
  ]);
}

describe('CameraHub: one connection per viewer session', () => {
  let sent: { to: string; d: MonRtc }[];
  let hub: CameraHub;
  const offer = (pc: string, vid = 'v1', extra: Partial<MonRtc> = {}): MonRtc => ({ sdp: { type: 'offer', sdp: 'o' }, pc, vid, ...extra });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('window', globalThis);
    vi.stubGlobal('RTCPeerConnection', FakePC);
    vi.stubGlobal('RTCRtpReceiver', { getCapabilities: () => ({ codecs: [{ mimeType: 'video/VP8' }, { mimeType: 'video/H264', sdpFmtpLine: 'packetization-mode=1;profile-level-id=42e01f' }] }) });
    FakePC.all = [];
    sent = [];
    hub = new CameraHub((to, d) => sent.push({ to, d }), [], () => ({ video: { kind: 'video' } as unknown as MediaStreamTrack, audio: null }));
  });
  afterEach(() => {
    hub.closeAll();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('answers on the call it was offered, preferring H.264, and caps the encoder', async () => {
    await hub.onSignal('s1', offer('p1'), 'Mom');
    expect(FakePC.all).toHaveLength(1);
    expect(sent.at(-1)).toEqual({ to: 's1', d: { sdp: { type: 'answer', sdp: 'a' }, pc: 'p1' } });
    const v = FakePC.all[0].transceivers[0];
    expect((v.prefs as { mimeType: string }[])[0].mimeType).toBe('video/H264');
    expect(v.sender.params.encodings[0]).toMatchObject({ maxBitrate: 1_600_000, scaleResolutionDownBy: 1, maxFramerate: 24 });
    expect(v.sender.params.degradationPreference).toBe('maintain-framerate');
  });

  it('an ICE restart (same call id) keeps the connection; a new call id gets a fresh one', async () => {
    await hub.onSignal('s1', offer('p1'));
    await hub.onSignal('s1', offer('p1'));
    expect(FakePC.all).toHaveLength(1);
    await hub.onSignal('s1', offer('p2'));
    expect(FakePC.all).toHaveLength(2);
    expect(FakePC.all[0].connectionState).toBe('closed');
  });

  it('follows the viewer to a new socket: same call, answers go to the new socket', async () => {
    await hub.onSignal('s1', offer('p1'));
    FakePC.all[0].connect();
    await hub.onSignal('s2', offer('p1'));
    expect(FakePC.all).toHaveLength(1);
    expect(sent.at(-1)?.to).toBe('s2');
    expect(hub.keyOf('s2')).toBe('v1');
    expect(hub.keyOf('s9', 'v1')).toBe('v1');
    // The room says the old socket left: the call is up, so it stays.
    hub.release('s1');
    hub.release('s2');
    expect(hub.isConnected('v1')).toBe(true);
  });

  it('ignores candidates and byes from an older call', async () => {
    await hub.onSignal('s1', offer('p1'));
    await hub.onSignal('s1', offer('p2'));
    const pc2 = FakePC.all[1];
    await hub.onSignal('s1', { ice: { candidate: 'old' }, pc: 'p1', vid: 'v1' });
    await hub.onSignal('s1', { ice: { candidate: 'new' }, pc: 'p2', vid: 'v1' });
    expect(pc2.candidates).toEqual([{ candidate: 'new' }]);
    await hub.onSignal('s1', { bye: true, pc: 'p1', vid: 'v1' });
    expect(pc2.connectionState).not.toBe('closed');
    await hub.onSignal('s1', { bye: true, pc: 'p2', vid: 'v1' });
    expect(pc2.connectionState).toBe('closed');
  });

  it('two tabs on one device are two viewers', async () => {
    await hub.onSignal('s1', offer('p1', 'dev.tabA'));
    await hub.onSignal('s2', offer('p9', 'dev.tabB'));
    expect(FakePC.all.filter((p) => p.connectionState !== 'closed')).toHaveLength(2);
  });

  it('older viewers (no call id) are keyed by their socket, as before', async () => {
    await hub.onSignal('s1', { sdp: { type: 'offer', sdp: 'o' } });
    await hub.onSignal('s1', { sdp: { type: 'offer', sdp: 'o' } });
    expect(FakePC.all).toHaveLength(1);
    expect(sent.at(-1)?.d).toEqual({ sdp: { type: 'answer', sdp: 'a' } });
    expect(hub.keyOf('s1')).toBe('s1');
  });

  it('starts a call at the quality the viewer asked for, and steps everyone down as viewers join', async () => {
    await hub.onSignal('s1', offer('p1', 'v1', { q: 'sd' }));
    expect(FakePC.all[0].transceivers[0].sender.params.encodings[0]).toMatchObject({ maxBitrate: 450_000, scaleResolutionDownBy: 2 });
    await hub.onSignal('s2', offer('p2', 'v2'));
    await hub.onSignal('s3', offer('p3', 'v3'));
    // Three viewers, path unknown (counted as internet).
    expect(FakePC.all[2].transceivers[0].sender.params.encodings[0]).toMatchObject({ maxBitrate: 800_000, scaleResolutionDownBy: 1.5, maxFramerate: 20 });
    expect(FakePC.all[1].transceivers[0].sender.params.encodings[0]).toMatchObject({ maxBitrate: 800_000 });
    hub.close('v3');
    await vi.waitFor(() => expect(FakePC.all[1].transceivers[0].sender.params.encodings[0]).toMatchObject({ maxBitrate: 1_100_000 }));
  });

  it('says goodbye to every viewer when the camera stops', async () => {
    await hub.onSignal('s1', offer('p1'));
    hub.closeAll(true);
    expect(sent.at(-1)).toEqual({ to: 's1', d: { bye: true, pc: 'p1' } });
  });
});

describe('CameraHub: the overflow tier (four direct viewers over the internet, the rest on the relay)', () => {
  let sent: { to: string; d: MonRtc }[];
  let hub: CameraHub;
  const offer = (n: number, extra: Partial<MonRtc> = { ov: 1 }): MonRtc => ({ sdp: { type: 'offer', sdp: 'o' }, pc: `p${n}`, vid: `v${n}`, ...extra });
  const videoOf = (n: number) => FakePC.all[n].transceivers[0].sender.track;
  const join = async (n: number, path: 'lan' | 'internet', extra?: Partial<MonRtc>) => {
    await hub.onSignal(`s${n}`, offer(n, extra));
    FakePC.all[FakePC.all.length - 1].connect(path);
    await vi.advanceTimersByTimeAsync(1600); // the path check after connecting
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('window', globalThis);
    vi.stubGlobal('RTCPeerConnection', FakePC);
    vi.stubGlobal('RTCRtpReceiver', { getCapabilities: () => ({ codecs: [{ mimeType: 'video/VP8' }] }) });
    FakePC.all = [];
    sent = [];
    hub = new CameraHub((to, d) => sent.push({ to, d }), [], () => ({ video: { kind: 'video' } as unknown as MediaStreamTrack, audio: null }));
  });
  afterEach(() => {
    hub.closeAll();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('a fifth viewer over the internet gets no video and is told the camera is full', async () => {
    for (let i = 0; i < 4; i++) await join(i, 'internet');
    expect(hub.internetSlots()).toBe(4);
    await hub.onSignal('s4', offer(4));
    expect(videoOf(4)).toBeNull(); // held while its path is unknown
    FakePC.all[4].connect('internet');
    await vi.advanceTimersByTimeAsync(1000);
    expect(sent.filter((m) => m.to === 's4' && m.d.bye)).toEqual([{ to: 's4', d: { bye: true, full: true, pc: 'p4' } }]);
    expect(FakePC.all[4].connectionState).toBe('closed');
    expect(hub.internetSlots()).toBe(4);
  });

  it('home Wi-Fi viewers are exempt: let in even when the slots are full, and they don’t take one', async () => {
    for (let i = 0; i < 4; i++) await join(i, 'lan');
    expect(hub.internetSlots()).toBe(0);
    for (let i = 4; i < 8; i++) await join(i, 'internet');
    expect(hub.internetSlots()).toBe(4);
    await hub.onSignal('s8', offer(8));
    expect(videoOf(8)).toBeNull();
    FakePC.all[8].connect('lan');
    await vi.advanceTimersByTimeAsync(1000);
    expect(videoOf(8)).toEqual({ kind: 'video' }); // on the home Wi-Fi: in it goes
    expect(sent.some((m) => m.to === 's8' && m.d.full)).toBe(false);
  });

  it('a viewer leaving frees a slot; older viewers (no ov) are never turned away', async () => {
    for (let i = 0; i < 4; i++) await join(i, 'internet');
    hub.close('v0');
    await join(4, 'internet');
    expect(videoOf(4)).toEqual({ kind: 'video' });
    await join(5, 'internet', {});
    expect(videoOf(5)).toEqual({ kind: 'video' });
    expect(sent.some((m) => m.d.full)).toBe(false);
  });

  it('audio-only viewers need no video slot', async () => {
    for (let i = 0; i < 4; i++) await join(i, 'internet');
    await join(4, 'internet', { ov: 1, q: 'audio' });
    expect(FakePC.all[4].connectionState).toBe('connected');
    expect(sent.some((m) => m.d.full)).toBe(false);
  });
});

describe('ViewerLink', () => {
  let sent: { to: string; d: MonRtc }[];
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('window', globalThis);
    vi.stubGlobal('RTCPeerConnection', FakePC);
    vi.stubGlobal('MediaStream', class {});
    vi.stubGlobal('RTCRtpReceiver', { getCapabilities: () => ({ codecs: [{ mimeType: 'video/VP8' }, { mimeType: 'video/H264' }] }) });
    FakePC.all = [];
    sent = [];
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('offers with a call id, its identity and quality, asking for H.264', async () => {
    const link = new ViewerLink((to, d) => sent.push({ to, d }), [], 'dev.tab');
    link.quality = 'sd';
    await link.connect('cam1');
    const o = sent.find((m) => m.d.sdp)!;
    expect(o.to).toBe('cam1');
    expect(o.d).toMatchObject({ vid: 'dev.tab', q: 'sd' });
    expect(o.d.pc).toMatch(/^\w+$/);
    expect((FakePC.all[0].transceivers[0].prefs as { mimeType: string }[])[0].mimeType).toBe('video/H264');
  });

  it('a reconnect says bye to the previous call first, and ignores its late answer', async () => {
    const link = new ViewerLink((to, d) => sent.push({ to, d }), [], 'dev.tab');
    await link.connect('cam1');
    const first = sent.find((m) => m.d.sdp)!.d.pc;
    sent = [];
    await link.connect('cam1');
    expect(sent[0].d).toEqual({ bye: true, pc: first, vid: 'dev.tab' });
    const second = sent.find((m) => m.d.sdp)!.d.pc;
    expect(second).not.toBe(first);
    await link.onSignal('cam1', { sdp: { type: 'answer', sdp: 'old' }, pc: first });
    expect(FakePC.all[1].remote).toBeNull();
    await link.onSignal('cam1', { sdp: { type: 'answer', sdp: 'new' }, pc: second });
    expect(FakePC.all[1].remote).toEqual({ type: 'answer', sdp: 'new' });
  });

  it('gives up on a silent network quickly but keeps the attempt: a late connect wins', async () => {
    const states: string[] = [];
    const link = new ViewerLink(() => undefined, [], 'v');
    link.onState = (s) => states.push(s);
    await link.connect('cam1');
    vi.advanceTimersByTime(10_000);
    expect(states).toEqual(['connecting', 'failed']);
    FakePC.all[0].connect();
    expect(link.state).toBe('connected');
  });

  it('the camera hanging up ends the call (closed, not failed)', async () => {
    const link = new ViewerLink((to, d) => sent.push({ to, d }), [], 'v');
    await link.connect('cam1');
    const pc = sent.find((m) => m.d.sdp)!.d.pc;
    await link.onSignal('cam1', { bye: true, pc });
    expect(link.state).toBe('closed');
    expect(link.full).toBe(false);
  });

  it('says it can watch the relay; a full camera sends it there at once (failed, full)', async () => {
    const states: string[] = [];
    const link = new ViewerLink((to, d) => sent.push({ to, d }), [], 'v');
    link.onState = (s) => states.push(s);
    await link.connect('cam1');
    const o = sent.find((m) => m.d.sdp)!.d;
    expect(o.ov).toBe(1);
    await link.onSignal('cam1', { bye: true, full: true, pc: o.pc });
    expect(states).toEqual(['connecting', 'failed']);
    expect(link.full).toBe(true);
    // No second 'failed' from the give-up timer.
    vi.advanceTimersByTime(20_000);
    expect(states).toEqual(['connecting', 'failed']);
    // The next attempt starts clean.
    await link.connect('cam1');
    expect(link.full).toBe(false);
  });
});
