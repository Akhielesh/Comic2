// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { adapt, CameraHub, classifyPath, DC_RESTART_WAIT_MS, directAlert, encodingFor, FirstArrival, ICE_BATCH_MS, LADDER, newAdapt, orderCodecs, readEncStats, repeatsOpen, summarizeEnc, v6Net, ViewerLink, type DirectMsg, type EncSample, type OpenAlert } from './rtc';
import { HIDDEN_GRACE_MS } from './viewGate';
import type { MonRtc } from './protocol';
import { makeDevice, MemoryKeyStore, NurseryKeys } from './keys';
import { newNmk, wrapNmk } from '../../packages/monitor-core/src/sealed';
import { isSealedRtc, type SealedRtc } from '../../packages/monitor-core/src/wire';

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

  // Feature doc §7 C3: a host candidate alone is not "Home Wi-Fi".
  it('carrier IPv6: two phones on mobile data connect host-to-host across the internet — not Home Wi-Fi', () => {
    expect(classifyPath({ candidateType: 'host', address: '2a01:4b00:8000:1::23' }, { candidateType: 'host', address: '2607:fb90:a1b2:7::9' })).toBe('internet');
    // A global IPv6 host on one end, a private address on the other: across the internet.
    expect(classifyPath({ candidateType: 'host', address: '2a01:4b00:8000:1::23' }, { candidateType: 'host', address: '192.168.1.31' })).toBe('internet');
  });

  it('IPv6 on the same home network (one /64): Home Wi-Fi', () => {
    expect(classifyPath({ candidateType: 'host', address: '2001:db8:aa:1:1c2d::5' }, { candidateType: 'host', address: '2001:0db8:00aa:0001:9:8:7:6' })).toBe('lan');
    expect(v6Net('2001:db8:aa:1::5')).toBe('2001:db8:aa:1');
    expect(v6Net('[2001:db8:aa:1::5]')).toBe('2001:db8:aa:1');
    expect(v6Net('fe80::1')).toBeNull(); // link-local is private already
    expect(v6Net('192.168.1.2')).toBeNull();
  });

  it('a public IPv4 or a carrier-NAT (100.64/10) host candidate is not the home network', () => {
    expect(classifyPath({ candidateType: 'host', address: '81.2.3.4' }, { candidateType: 'host', address: '81.2.3.9' })).toBe('internet');
    expect(classifyPath({ candidateType: 'host', address: '100.72.1.4' }, { candidateType: 'host', address: '100.72.9.8' })).toBe('internet');
  });

  it('private kinds: RFC 1918, link-local, ULA, mDNS names', () => {
    for (const a of ['10.1.2.3', '172.20.0.4', '192.168.0.9', '169.254.3.3', 'fd00::1', 'fc12:3::4', 'fe80::9', 'feb0::1', '5f3a.local']) {
      expect(classifyPath({ candidateType: 'host', address: a }, { candidateType: 'prflx', address: '192.168.1.2' })).toBe('lan');
    }
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
    // ADR 0006 Phase 0: a TURN-relayed picture is capped at 400 kbit/s, 15 fps.
    expect(encodingFor({ ...hd, peers: 1, internetPeers: 1, path: 'relay' })).toEqual({ maxBitrate: 400_000, scaleResolutionDownBy: 2, maxFramerate: 15 });
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
  /** The data channel a viewer made (it counts what it sent). */
  dc: { label: string; readyState: string; onmessage: unknown; onopen: (() => void) | null; sent: string[]; send(m: string): void } | null = null;
  constructor(public config?: RTCConfiguration) {
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
  createDataChannel(label: string) {
    this.dc = { label, readyState: 'open', onmessage: null, onopen: null, sent: [], send(m: string) { this.sent.push(m); } };
    return this.dc;
  }
  async setRemoteDescription(d: { type: string; sdp: string }) {
    this.remote = d;
    // Like a browser: an offer waits for our answer; an answer ends our offer's wait.
    this.signalingState = d.type === 'offer' ? 'have-remote-offer' : 'stable';
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
    if ((d as { type?: string })?.type === 'offer') this.signalingState = 'have-local-offer';
    else if ((d as { type?: string })?.type === 'answer') this.signalingState = 'stable';
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
    // dcc: this camera takes the viewer's quality and screen state on the data channel;
    // ib: candidate batches; dcr: ICE restarts on the data channel.
    expect(sent.at(-1)).toEqual({ to: 's1', d: { sdp: { type: 'answer', sdp: 'a' }, pc: 'p1', dcc: 1, ib: 1, dcr: 1 } });
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

  it('a viewer that lost access (revoked, removed): its live call ends at once — a blip still keeps one', async () => {
    await hub.onSignal('s1', offer('p1', 'v1'), 'Grandma');
    await hub.onSignal('s2', offer('p2', 'v2'), 'Mom');
    FakePC.all.forEach((pc) => pc.connect('lan'));
    // A socket that just left (no why): the home Wi-Fi call carries on.
    hub.release('s1');
    expect(hub.isConnected('v1')).toBe(true);
    // The room says its device was revoked: the call ends, connected or not; the others stay.
    expect(hub.cut('s1')).toBe(1);
    expect(FakePC.all[0].connectionState).toBe('closed');
    expect(hub.isConnected('v1')).toBe(false);
    expect(hub.isConnected('v2')).toBe(true);
    expect(hub.count).toBe(1);
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
    expect(sent.at(-1)?.d).toEqual({ sdp: { type: 'answer', sdp: 'a' }, dcc: 1, ib: 1, dcr: 1 });
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

describe('direct-first and sound-only paths (feature doc §7 C3, C5, §4.7)', () => {
  let sent: { to: string; d: MonRtc }[];
  const videoTrack = { kind: 'video' } as unknown as MediaStreamTrack;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('window', globalThis);
    vi.stubGlobal('RTCPeerConnection', FakePC);
    vi.stubGlobal('MediaStream', class {});
    vi.stubGlobal('RTCRtpReceiver', { getCapabilities: () => ({ codecs: [{ mimeType: 'video/VP8' }] }) });
    FakePC.all = [];
    sent = [];
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const camera = () => new CameraHub((to, d) => sent.push({ to, d }), [], () => ({ video: videoTrack, audio: null }));
  /** A viewer calls; the camera answers; the call connects on `path`; its data channel opens on the camera. */
  const call = async (hub: CameraHub, n: number, path: 'lan' | 'internet') => {
    await hub.onSignal(`s${n}`, { sdp: { type: 'offer', sdp: 'o' }, pc: `p${n}`, vid: `v${n}` });
    const pc = FakePC.all.at(-1)!;
    const channel = { label: 'mon', onmessage: null as ((e: { data: string }) => void) | null };
    (pc.ondatachannel as (e: { channel: typeof channel }) => void)({ channel });
    pc.connect(path);
    await vi.advanceTimersByTimeAsync(1600);
    return { pc, say: (m: unknown) => channel.onmessage?.({ data: JSON.stringify(m) }), video: () => pc.transceivers[0].sender.track };
  };

  it('camera: a viewer whose screen is hidden loses the picture after the grace (sound stays), and gets it back at once', async () => {
    const hub = camera();
    const v = await call(hub, 0, 'lan');
    expect(v.video()).toBe(videoTrack);
    v.say({ t: 'vis', on: false });
    await vi.advanceTimersByTimeAsync(HIDDEN_GRACE_MS - 1000);
    expect(v.video()).toBe(videoTrack); // a glance away keeps it
    await vi.advanceTimersByTimeAsync(1000);
    expect(v.video()).toBeNull();
    v.say({ t: 'vis', on: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(v.video()).toBe(videoTrack);
    // Back before the grace ends: never taken away.
    v.say({ t: 'vis', on: false });
    await vi.advanceTimersByTimeAsync(5000);
    v.say({ t: 'vis', on: true });
    await vi.advanceTimersByTimeAsync(HIDDEN_GRACE_MS);
    expect(v.video()).toBe(videoTrack);
    hub.closeAll();
  });

  it('camera: quality from the data channel (no message through the room)', async () => {
    const hub = camera();
    const v = await call(hub, 0, 'lan');
    v.say({ t: 'q', q: 'audio' });
    await vi.advanceTimersByTimeAsync(0);
    expect(v.video()).toBeNull();
    v.say({ t: 'q', q: 'hd' });
    await vi.advanceTimersByTimeAsync(0);
    expect(v.video()).toBe(videoTrack);
    v.say({ t: 'q', q: 'bogus' });
    v.say('not json');
    await vi.advanceTimersByTimeAsync(0);
    expect(v.video()).toBe(videoTrack);
    hub.closeAll();
  });

  it('camera: relay data used up — a viewer through TURN gets sound only, the Home Wi-Fi one keeps the picture', async () => {
    const hub = camera();
    const home = await call(hub, 0, 'lan');
    const far = await call(hub, 1, 'internet');
    // The far viewer's call goes through a TURN relay.
    far.pc.stats = new Map<string, Record<string, unknown>>([
      ['t', { type: 'transport', id: 't', selectedCandidatePairId: 'cp' }],
      ['cp', { type: 'candidate-pair', id: 'cp', localCandidateId: 'l', remoteCandidateId: 'r' }],
      ['l', { type: 'local-candidate', id: 'l', candidateType: 'host', address: '192.168.1.2' }],
      ['r', { type: 'remote-candidate', id: 'r', candidateType: 'relay', address: '141.101.90.1' }],
    ]);
    await vi.advanceTimersByTimeAsync(5000); // the stats tick reads the new path
    await hub.setRelayDataOut(true);
    expect(far.video()).toBeNull();
    expect(home.video()).toBe(videoTrack);
    await hub.setRelayDataOut(false);
    expect(far.video()).toBe(videoTrack);
    hub.closeAll();
  });

  it('viewer: quality and screen state go on the data channel to a camera that takes them there', async () => {
    const link = new ViewerLink((to, d) => sent.push({ to, d }), [], 'v');
    await link.connect('cam1');
    const pc = FakePC.all[0];
    expect(pc.config).toMatchObject({ iceCandidatePoolSize: 1 });
    // A camera from before this change (no dcc): the room carries the quality, as before.
    expect(link.sendQuality('sd')).toBe(false);
    const pcId = sent.find((m) => m.d.sdp)!.d.pc;
    await link.onSignal('cam1', { sdp: { type: 'answer', sdp: 'a' }, pc: pcId, dcc: 1 });
    expect(link.sendQuality('audio')).toBe(true);
    link.setShown(false);
    link.setShown(false); // only on change
    link.setShown(true);
    expect(pc.dc!.sent.map((m) => JSON.parse(m))).toEqual([{ t: 'q', q: 'audio' }, { t: 'vis', on: false }, { t: 'vis', on: true }]);
    link.close();
  });

  it('viewer: a screen already hidden when the call starts says so once the channel opens', async () => {
    const link = new ViewerLink((to, d) => sent.push({ to, d }), [], 'v');
    link.setShown(false);
    await link.connect('cam1');
    const pc = FakePC.all[0];
    const pcId = sent.find((m) => m.d.sdp)!.d.pc;
    await link.onSignal('cam1', { sdp: { type: 'answer', sdp: 'a' }, pc: pcId, dcc: 1 });
    pc.dc!.onopen?.();
    expect(pc.dc!.sent.map((m) => JSON.parse(m))).toEqual([{ t: 'vis', on: false }]);
    link.close();
  });

  it('viewer: the network coming back restarts ICE at once (back onto the home Wi-Fi without waiting)', async () => {
    const listeners = new Map<string, () => void>();
    vi.stubGlobal('window', { ...globalThis, setTimeout, clearTimeout, setInterval, clearInterval, addEventListener: (t: string, f: () => void) => listeners.set(t, f), removeEventListener: (t: string) => listeners.delete(t) });
    const link = new ViewerLink((to, d) => sent.push({ to, d }), [], 'v');
    await link.connect('cam1');
    await link.onSignal('cam1', { sdp: { type: 'answer', sdp: 'a' }, pc: sent[0].d.pc }); // the call is set up (stable)
    FakePC.all[0].connect('lan');
    sent = [];
    listeners.get('online')!();
    await vi.advanceTimersByTimeAsync(0);
    expect(sent.filter((m) => m.d.sdp?.type === 'offer')).toHaveLength(1);
    link.close();
    expect(listeners.has('online')).toBe(false);
  });
});

/* ------------------------------------------------- ADR 0006 Phase 0 (WS-6) */

const NID = '7d0c2a8e-5b1f-4c3a-9e6d-1a2b3c4d5e6f';

/** A camera's and a viewer's keys for one nursery, holding the same epoch (as the room would hand them out). */
async function sharedKeys() {
  const camDev = await makeDevice();
  const viewDev = await makeDevice();
  const nmk = newNmk();
  const keysFor = async (dev: Awaited<ReturnType<typeof makeDevice>>) => {
    const k = new NurseryKeys({ nid: NID, device: dev, store: new MemoryKeyStore(), name: 'x', send: () => undefined });
    await k.onMessage({ t: 'key_wrap', devId: dev.devId, e: 1, blob: await wrapNmk(nmk, dev.ecdhPub, { nid: NID, e: 1, devId: dev.devId }) });
    return k;
  };
  return { camDev, viewDev, cam: await keysFor(camDev), view: await keysFor(viewDev) };
}

const until = async (ok: () => boolean, ms = 2000) => {
  const t0 = Date.now();
  while (!ok()) {
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
};

describe('sealed signaling (end to end through the room)', () => {
  let sent: { to: string; d: MonRtc | SealedRtc }[];
  beforeEach(() => {
    vi.stubGlobal('window', globalThis);
    vi.stubGlobal('RTCPeerConnection', FakePC);
    vi.stubGlobal('MediaStream', class {});
    vi.stubGlobal('RTCRtpReceiver', { getCapabilities: () => ({ codecs: [{ mimeType: 'video/VP8' }] }) });
    FakePC.all = [];
    sent = [];
  });
  afterEach(() => vi.unstubAllGlobals());

  it('camera holding the key: an unsealed offer is refused; a sealed one is answered sealed — no SDP or candidate the room can read', async () => {
    const k = await sharedKeys();
    const hub = new CameraHub((to, d) => sent.push({ to, d }), [], () => ({ video: null, audio: null }));
    hub.seal = k.cam;
    await hub.onSignal('s1', { sdp: { type: 'offer', sdp: 'o' }, pc: 'p1', vid: 'v1' });
    expect(FakePC.all).toHaveLength(0);
    expect(hub.refused).toBe(1);
    const offer = await k.view.seal(k.camDev.devId, { sdp: { type: 'offer', sdp: 'v=0 a=fingerprint:sha-256 AB' }, pc: 'p1', vid: 'v1', ib: 1 });
    await hub.onSignal('s1', offer!);
    expect(FakePC.all).toHaveLength(1);
    await until(() => sent.length === 1);
    expect(isSealedRtc(sent[0].d)).toBe(true);
    expect(JSON.stringify(sent)).not.toMatch(/sdp|candidate|answer/);
    const answer = await k.view.open(sent[0].d as SealedRtc);
    expect(answer!.d).toMatchObject({ sdp: { type: 'answer' }, pc: 'p1', dcc: 1, ib: 1, dcr: 1 });
    // Its candidates: one sealed batch for the window.
    const pc = FakePC.all[0];
    const cand = (c: string) => (pc.onicecandidate as unknown as (e: { candidate: { toJSON(): unknown } }) => void)({ candidate: { toJSON: () => ({ candidate: c }) } });
    cand('candidate:1 1 udp 1 192.168.1.9 5000 typ host');
    cand('candidate:2 1 udp 1 81.2.3.4 6000 typ srflx');
    await new Promise((r) => setTimeout(r, ICE_BATCH_MS + 20));
    await until(() => sent.length === 2);
    expect(JSON.stringify(sent[1])).not.toMatch(/candidate|192\.168/);
    expect((await k.view.open(sent[1].d as SealedRtc))!.d.ices).toHaveLength(2);
    // A sealed message that doesn't open (tampered) is refused too.
    const bad = offer as SealedRtc;
    await hub.onSignal('s1', { ...bad, ct: (bad.ct[0] === 'A' ? 'B' : 'A') + bad.ct.slice(1) });
    expect(hub.refused).toBe(2);
    hub.closeAll();
  });

  it('camera: a call sealed by a revoked device ends — by its device id, or when the key moves on without it', async () => {
    const k = await sharedKeys();
    const hub = new CameraHub((to, d) => sent.push({ to, d }), [], () => ({ video: null, audio: null }));
    hub.seal = k.cam;
    const call = async (sid: string, vid: string) => hub.onSignal(sid, (await k.view.seal(k.camDev.devId, { sdp: { type: 'offer', sdp: 'o' }, pc: 'p-' + vid, vid }))!);
    await call('s1', 'v1');
    FakePC.all[0].connect('lan');
    // Removed by device (the room names the device): ended though the socket id is a newer one.
    expect(hub.cut('another-socket', k.viewDev.devId)).toBe(1);
    expect(FakePC.all[0].connectionState).toBe('closed');
    await call('s1', 'v2');
    FakePC.all[1].connect('lan');
    // The room asks this camera for the next epoch, for everyone but that device: its call ends.
    expect(hub.keepOnly(new Set(['someone-else-entirely1']))).toBe(1);
    expect(FakePC.all[1].connectionState).toBe('closed');
    // A device that stays keeps its call.
    await call('s1', 'v3');
    FakePC.all[2].connect('lan');
    expect(hub.keepOnly(new Set([k.viewDev.devId]))).toBe(0);
    expect(hub.isConnected('v3')).toBe(true);
    await until(() => sent.length === 3); // the three sealed answers (none left in flight)
    hub.closeAll();
  });

  it('viewer: seals to a camera that seals; refuses its plain answer (the room’s, not the camera’s); takes an older camera’s as always', async () => {
    const k = await sharedKeys();
    const link = new ViewerLink((to, d) => sent.push({ to, d }), [], 'dev.tab');
    link.seal = k.view;
    link.camKey = () => k.camDev.devId;
    await link.connect('cam1');
    await until(() => sent.length === 1);
    expect(isSealedRtc(sent[0].d)).toBe(true);
    const offer = (await k.cam.open(sent[0].d as SealedRtc))!;
    expect(offer.from).toBe(k.viewDev.devId);
    expect(offer.d).toMatchObject({ sdp: { type: 'offer' }, vid: 'dev.tab', ov: 1, ib: 1, dcr: 1 });
    const pc = FakePC.all[0];
    await link.onSignal('cam1', { sdp: { type: 'answer', sdp: 'forged' }, pc: offer.d.pc });
    expect(pc.remote).toBeNull();
    expect(link.refused).toBe(1);
    await link.onSignal('cam1', (await k.cam.seal(k.viewDev.devId, { sdp: { type: 'answer', sdp: 'real' }, pc: offer.d.pc }))!);
    expect(pc.remote).toEqual({ type: 'answer', sdp: 'real' });
    link.close();

    // A camera that doesn't seal (an older app): plain, as always — even though we hold the key.
    sent = [];
    const old = new ViewerLink((to, d) => sent.push({ to, d }), [], 'dev.tab');
    old.seal = k.view;
    old.camKey = () => null;
    await old.connect('cam2');
    expect((sent[0].d as MonRtc).sdp?.type).toBe('offer');
    await old.onSignal('cam2', { sdp: { type: 'answer', sdp: 'a' }, pc: (sent[0].d as MonRtc).pc });
    expect(FakePC.all[1].remote).toEqual({ type: 'answer', sdp: 'a' });
    old.close();
  });
});

describe('never no picture because of a key: calls set up without it (nk / nok)', () => {
  let sent: { to: string; d: MonRtc | SealedRtc }[];
  beforeEach(() => {
    vi.stubGlobal('window', globalThis);
    vi.stubGlobal('RTCPeerConnection', FakePC);
    vi.stubGlobal('MediaStream', class {});
    vi.stubGlobal('RTCRtpReceiver', { getCapabilities: () => ({ codecs: [{ mimeType: 'video/VP8' }] }) });
    FakePC.all = [];
    sent = [];
  });
  afterEach(() => vi.unstubAllGlobals());

  it('viewer without the key, camera that seals: the call goes without it (nk), the camera takes it — and says so', async () => {
    const k = await sharedKeys();
    // The viewer: no key at all (a lost race, a storage that failed …).
    const link = new ViewerLink((to, d) => sent.push({ to, d }), [], 'dev.tab');
    link.camKey = () => k.camDev.devId;
    await link.connect('cam1');
    const offer = sent[0].d as MonRtc;
    expect(isSealedRtc(offer)).toBe(false);
    expect(offer).toMatchObject({ sdp: { type: 'offer' }, nk: 1 });
    // It can't open the camera's sealed server picture: it doesn't offer to watch it instead.
    expect(offer.ov).toBeUndefined();
    // The camera holds the key and takes it (a plain offer without nk it still refuses).
    const hub = new CameraHub((to, d) => sent.push({ to, d }), [], () => ({ video: null, audio: null }));
    hub.seal = k.cam;
    await hub.onSignal('s1', { ...offer, nk: undefined });
    expect(hub.refused).toBe(1);
    await hub.onSignal('s1', offer);
    expect(FakePC.all).toHaveLength(2);
    await until(() => sent.length === 2);
    const answer = sent[1].d as MonRtc;
    expect(isSealedRtc(answer)).toBe(false);
    expect(answer.sdp?.type).toBe('answer');
    // Its candidates (plain, the same call) follow it.
    await hub.onSignal('s1', { ices: [{ candidate: 'c1' }], pc: offer.pc, vid: offer.vid });
    expect(FakePC.all[1].candidates).toEqual([{ candidate: 'c1' }]);
    // The viewer takes the plain answer for the call it set up plain.
    await link.onSignal('cam1', answer);
    expect(FakePC.all[0].remote).toEqual({ type: 'answer', sdp: 'a' });
    FakePC.all[0].connect();
    FakePC.all[1].connect();
    expect(link.unsealed).toBe(true);
    expect(hub.unsealed).toBe(1);
    link.close();
    hub.closeAll();
  });

  it('camera: a plain offer never replaces a sealed call that is up; an app that never showed device keys is taken', async () => {
    const k = await sharedKeys();
    const hub = new CameraHub((to, d) => sent.push({ to, d }), [], () => ({ video: null, audio: null }));
    hub.seal = k.cam;
    await hub.onSignal('s1', (await k.view.seal(k.camDev.devId, { sdp: { type: 'offer', sdp: 'o' }, pc: 'p1', vid: 'v1' }))!);
    FakePC.all[0].connect();
    await hub.onSignal('s1', { sdp: { type: 'offer', sdp: 'room' }, pc: 'p2', vid: 'v1', nk: 1 });
    expect(FakePC.all).toHaveLength(1);
    expect(hub.isConnected('v1')).toBe(true);
    // A page from before end to end (no devId in the room's presence): its plain offer is taken.
    hub.plainOk = (sid) => sid === 'old-page';
    await hub.onSignal('old-page', { sdp: { type: 'offer', sdp: 'o' }, pc: 'p9', vid: 'old' });
    expect(FakePC.all).toHaveLength(2);
    await until(() => sent.length === 2);
    hub.closeAll();
  });

  it('camera without a current key: a sealed offer it can’t open gets `nok`, and the viewer calls again without the key', async () => {
    const k = await sharedKeys();
    // The camera holds epoch 1, but the viewer seals with epoch 2 (the camera missed the rotation).
    const nmk2 = newNmk();
    await k.view.onMessage({ t: 'key_wrap', devId: k.viewDev.devId, e: 2, blob: await wrapNmk(nmk2, k.viewDev.ecdhPub, { nid: NID, e: 2, devId: k.viewDev.devId }) });
    const toCam: (MonRtc | SealedRtc)[] = [];
    const toView: (MonRtc | SealedRtc)[] = [];
    const link = new ViewerLink((_to, d) => toCam.push(d), [], 'dev.tab');
    link.seal = k.view;
    link.camKey = () => k.camDev.devId;
    const hub = new CameraHub((_to, d) => toView.push(d), [], () => ({ video: null, audio: null }));
    hub.seal = k.cam;
    await link.connect('cam1');
    await until(() => toCam.length === 1);
    expect(isSealedRtc(toCam[0])).toBe(true);
    await hub.onSignal('s1', toCam[0]);
    expect(FakePC.all).toHaveLength(1); // the viewer's only: the camera couldn't open it
    expect(toView).toEqual([{ nok: 1 }]);
    // The viewer, its sealed call unanswered: calls again at once, without the key.
    await link.onSignal('cam1', toView[0]);
    await until(() => toCam.length >= 3);
    const again = toCam.find((d) => !isSealedRtc(d) && (d as MonRtc).sdp?.type === 'offer') as MonRtc;
    expect(again).toMatchObject({ nk: 1, ov: 1 });
    await hub.onSignal('s1', again);
    expect(FakePC.all).toHaveLength(3);
    // Another `nok` (the room's, say) for a call that isn't sealed changes nothing.
    await link.onSignal('cam1', { nok: 1 });
    expect(FakePC.all).toHaveLength(3);
    link.close();
    hub.closeAll();
  });
});

describe('sealed signals are handled in the order they arrived', () => {
  beforeEach(() => {
    vi.stubGlobal('window', globalThis);
    vi.stubGlobal('RTCPeerConnection', FakePC);
    vi.stubGlobal('MediaStream', class {});
    vi.stubGlobal('RTCRtpReceiver', { getCapabilities: () => ({ codecs: [{ mimeType: 'video/VP8' }] }) });
    FakePC.all = [];
  });
  afterEach(() => vi.unstubAllGlobals());

  /** A seal whose opens finish when the test says (WebCrypto may finish a later one first). */
  const slowSeal = (from: string) => {
    const waits: { go: () => void }[] = [];
    return {
      waits,
      holds: () => true,
      canSeal: () => true,
      seal: async () => null,
      open: (s: SealedRtc) =>
        new Promise<{ d: MonRtc; from: string }>((resolve) => {
          const d = JSON.parse(Buffer.from(s.ct, 'base64url').toString()) as MonRtc;
          waits.push({ go: () => resolve({ d, from }) });
        }),
    };
  };
  /** Shaped like a sealed signal (the stub seal "opens" it). */
  const wrap = (d: MonRtc): SealedRtc => ({ e: 1, iv: 'AAAAAAAAAAAAAAAA', ct: Buffer.from(JSON.stringify(d)).toString('base64url'), f: 'x'.repeat(22) });

  it('camera: candidates opened before their offer still wait for it (none dropped)', async () => {
    const hub = new CameraHub(() => undefined, [], () => ({ video: null, audio: null }));
    const seal = slowSeal('v'.repeat(22));
    hub.seal = seal;
    const a = hub.onSignal('s1', wrap({ sdp: { type: 'offer', sdp: 'o' }, pc: 'p1', vid: 'v1' }));
    const b = hub.onSignal('s1', wrap({ ices: [{ candidate: 'c1' }, { candidate: 'c2' }], pc: 'p1', vid: 'v1' }));
    await Promise.resolve();
    seal.waits[1].go(); // the candidates open first
    await new Promise((r) => setTimeout(r, 5));
    expect(FakePC.all).toHaveLength(0);
    seal.waits[0].go();
    await Promise.all([a, b]);
    expect(FakePC.all).toHaveLength(1);
    expect(FakePC.all[0].candidates).toEqual([{ candidate: 'c1' }, { candidate: 'c2' }]);
    hub.closeAll();
  });

  it('viewer: an answer opened after its candidates is still applied first', async () => {
    const sent: { to: string; d: MonRtc | SealedRtc }[] = [];
    const link = new ViewerLink((to, d) => sent.push({ to, d }), [], 'dev.tab');
    const seal = slowSeal('c'.repeat(22));
    link.seal = seal;
    link.camKey = () => null;
    await link.connect('cam1');
    const pcId = (sent[0].d as MonRtc).pc;
    const pc = FakePC.all[0];
    const order: string[] = [];
    const setRemote = pc.setRemoteDescription.bind(pc);
    pc.setRemoteDescription = async (d) => {
      order.push('answer');
      return setRemote(d);
    };
    const addIce = pc.addIceCandidate.bind(pc);
    pc.addIceCandidate = async (c) => {
      order.push('ice');
      return addIce(c);
    };
    const a = link.onSignal('cam1', wrap({ sdp: { type: 'answer', sdp: 'a' }, pc: pcId }));
    const b = link.onSignal('cam1', wrap({ ices: [{ candidate: 'c1' }], pc: pcId }));
    await Promise.resolve();
    seal.waits[1].go();
    await new Promise((r) => setTimeout(r, 5));
    seal.waits[0].go();
    await Promise.all([a, b]);
    expect(order).toEqual(['answer', 'ice']);
    link.close();
  });
});

describe('ICE candidate batching (75 ms) and ICE restarts on the data channel', () => {
  let sent: { to: string; d: MonRtc }[];
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('window', globalThis);
    vi.stubGlobal('RTCPeerConnection', FakePC);
    vi.stubGlobal('MediaStream', class {});
    vi.stubGlobal('RTCRtpReceiver', { getCapabilities: () => ({ codecs: [{ mimeType: 'video/VP8' }] }) });
    FakePC.all = [];
    sent = [];
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
  const cand = (pc: FakePC, c: string | null) =>
    (pc.onicecandidate as unknown as (e: { candidate: { toJSON(): unknown } | null }) => void)({ candidate: c ? { toJSON: () => ({ candidate: c }) } : null });

  it('camera: a viewer that takes batches gets one message per 75 ms window; an older one, one per candidate', async () => {
    const hub = new CameraHub((to, d) => sent.push({ to, d }), [], () => ({ video: null, audio: null }));
    await hub.onSignal('s1', { sdp: { type: 'offer', sdp: 'o' }, pc: 'p1', vid: 'v1', ib: 1 });
    await hub.onSignal('s2', { sdp: { type: 'offer', sdp: 'o' }, pc: 'p2', vid: 'v2' });
    sent = [];
    for (const pc of FakePC.all) {
      cand(pc, 'c1');
      cand(pc, 'c2');
      cand(pc, null);
    }
    expect(sent).toEqual([]);
    vi.advanceTimersByTime(ICE_BATCH_MS);
    expect(sent.filter((m) => m.to === 's1')).toEqual([{ to: 's1', d: { ices: [{ candidate: 'c1' }, { candidate: 'c2' }, null], pc: 'p1' } }]);
    expect(sent.filter((m) => m.to === 's2').map((m) => m.d.ice)).toEqual([{ candidate: 'c1' }, { candidate: 'c2' }, null]);
    // Batches it receives are all applied.
    await hub.onSignal('s1', { ices: [{ candidate: 'x' }, null, { candidate: 'y' }], pc: 'p1', vid: 'v1' });
    expect(FakePC.all[0].candidates).toEqual([{ candidate: 'x' }, { candidate: 'y' }]);
    hub.closeAll();
  });

  it('viewer: one per candidate until the camera says it takes batches, then one per window', async () => {
    const link = new ViewerLink((to, d) => sent.push({ to, d }), [], 'v');
    await link.connect('cam1');
    const pc = FakePC.all[0];
    const pcId = sent.find((m) => m.d.sdp)!.d.pc;
    sent = [];
    cand(pc, 'early1');
    cand(pc, 'early2');
    vi.advanceTimersByTime(ICE_BATCH_MS);
    expect(sent.map((m) => m.d.ice)).toEqual([{ candidate: 'early1' }, { candidate: 'early2' }]);
    await link.onSignal('cam1', { sdp: { type: 'answer', sdp: 'a' }, pc: pcId, dcc: 1, ib: 1, dcr: 1 });
    sent = [];
    cand(pc, 'late1');
    cand(pc, 'late2');
    vi.advanceTimersByTime(ICE_BATCH_MS);
    expect(sent).toHaveLength(1);
    expect(sent[0].d.ices).toEqual([{ candidate: 'late1' }, { candidate: 'late2' }]);
    link.close();
  });

  it('viewer: once the call is up, an ICE restart goes on the data channel (nothing through the room); no answer in time — through the room', async () => {
    const link = new ViewerLink((to, d) => sent.push({ to, d }), [], 'v');
    await link.connect('cam1');
    const pc = FakePC.all[0];
    const pcId = sent.find((m) => m.d.sdp)!.d.pc;
    await link.onSignal('cam1', { sdp: { type: 'answer', sdp: 'a' }, pc: pcId, dcc: 1, ib: 1, dcr: 1 });
    pc.connect('internet');
    sent = [];
    pc.signalingState = 'have-local-offer';
    // The camera's relay credential was renewed: it asks on the channel, and we restart on it.
    const say = (m: unknown) => (pc.dc!.onmessage as (e: { data: string }) => void)({ data: JSON.stringify(m) });
    say({ t: 'sig', d: { re: 1, pc: pcId } });
    await vi.advanceTimersByTimeAsync(0);
    const onDc = pc.dc!.sent.map((m) => JSON.parse(m)).filter((m) => m.t === 'sig');
    expect(onDc).toHaveLength(1);
    expect(onDc[0].d).toMatchObject({ sdp: { type: 'offer' }, pc: pcId, vid: 'v' });
    expect(sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(DC_RESTART_WAIT_MS);
    expect(sent.filter((m) => m.d.sdp?.type === 'offer')).toHaveLength(1);
    // The answer on the channel is taken.
    say({ t: 'sig', d: { sdp: { type: 'answer', sdp: 'restarted' }, pc: pcId } });
    await vi.advanceTimersByTimeAsync(0);
    expect(pc.remote).toEqual({ type: 'answer', sdp: 'restarted' });
    // An answer for another call on this channel is ignored.
    say({ t: 'sig', d: { sdp: { type: 'answer', sdp: 'other' }, pc: 'zzz' } });
    await vi.advanceTimersByTimeAsync(0);
    expect(pc.remote).toEqual({ type: 'answer', sdp: 'restarted' });
    link.close();
  });

  it('viewer: the same restart answered twice (on the channel and through the room) keeps the call — the second answer is a duplicate, not a failure', async () => {
    const link = new ViewerLink((to, d) => sent.push({ to, d }), [], 'v');
    const states: string[] = [];
    link.onState = (st) => states.push(st);
    await link.connect('cam1');
    const pc = FakePC.all[0];
    // A browser refuses an answer when no offer of ours waits for one.
    const apply = pc.setRemoteDescription.bind(pc);
    let applied = 0;
    pc.setRemoteDescription = async (d) => {
      if (d.type === 'answer' && pc.signalingState !== 'have-local-offer') throw new DOMException('Called in wrong state: stable', 'InvalidStateError');
      applied++;
      return apply(d);
    };
    const pcId = sent.find((m) => m.d.sdp)!.d.pc;
    await link.onSignal('cam1', { sdp: { type: 'answer', sdp: 'a' }, pc: pcId, dcc: 1, ib: 1, dcr: 1 });
    pc.connect('internet');
    const say = (m: unknown) => (pc.dc!.onmessage as (e: { data: string }) => void)({ data: JSON.stringify(m) });
    say({ t: 'sig', d: { re: 1, pc: pcId } });
    await vi.advanceTimersByTimeAsync(DC_RESTART_WAIT_MS); // no answer in time: the same offer through the room
    // Both reach the camera, and both are answered.
    say({ t: 'sig', d: { sdp: { type: 'answer', sdp: 'restarted' }, pc: pcId } });
    await vi.advanceTimersByTimeAsync(0);
    await link.onSignal('cam1', { sdp: { type: 'answer', sdp: 'restarted' }, pc: pcId });
    await vi.advanceTimersByTimeAsync(0);
    expect(applied).toBe(2); // the first answer, and the restart's first
    expect(link.state).toBe('connected');
    expect(states).not.toContain('failed');
    link.close();
  });

  it('camera: the same restart offer twice (channel, then the room) is answered again as it was — not negotiated twice', async () => {
    const hub = new CameraHub((to, d) => sent.push({ to, d }), [], () => ({ video: null, audio: null }));
    await hub.onSignal('s1', { sdp: { type: 'offer', sdp: 'o' }, pc: 'p1', vid: 'v1', dcr: 1, ib: 1 });
    const pc = FakePC.all[0];
    const channel = { label: 'mon', readyState: 'open', onmessage: null as ((e: { data: string }) => void) | null, sent: [] as string[], send(m: string) { this.sent.push(m); } };
    (pc.ondatachannel as (e: { channel: typeof channel }) => void)({ channel });
    pc.connect('internet');
    await vi.advanceTimersByTimeAsync(1600);
    let negotiations = 0;
    const apply = pc.setRemoteDescription.bind(pc);
    pc.setRemoteDescription = async (d) => {
      negotiations++;
      return apply(d);
    };
    sent = [];
    const restart = { sdp: { type: 'offer' as const, sdp: 'restart' }, pc: 'p1', vid: 'v1' };
    channel.onmessage?.({ data: JSON.stringify({ t: 'sig', d: restart }) });
    await vi.advanceTimersByTimeAsync(0);
    await hub.onSignal('s1', restart);
    await vi.advanceTimersByTimeAsync(0);
    expect(negotiations).toBe(1);
    // The second copy came through the room (the channel may be what's failing): answered there.
    expect(sent).toEqual([{ to: 's1', d: { sdp: { type: 'answer', sdp: 'a' }, dcc: 1, ib: 1, dcr: 1, pc: 'p1' } }]);
    hub.closeAll();
  });

  it('camera: a restart offered on its call’s channel is answered there — a new call on the channel is not taken', async () => {
    const hub = new CameraHub((to, d) => sent.push({ to, d }), [], () => ({ video: null, audio: null }));
    await hub.onSignal('s1', { sdp: { type: 'offer', sdp: 'o' }, pc: 'p1', vid: 'v1', dcr: 1, ib: 1 });
    const pc = FakePC.all[0];
    const channel = { label: 'mon', readyState: 'open', onmessage: null as ((e: { data: string }) => void) | null, sent: [] as string[], send(m: string) { this.sent.push(m); } };
    (pc.ondatachannel as (e: { channel: typeof channel }) => void)({ channel });
    pc.connect('internet');
    await vi.advanceTimersByTimeAsync(1600);
    sent = [];
    channel.onmessage?.({ data: JSON.stringify({ t: 'sig', d: { sdp: { type: 'offer', sdp: 'restart' }, pc: 'p1', vid: 'v1' } }) });
    await vi.advanceTimersByTimeAsync(0);
    expect(FakePC.all).toHaveLength(1);
    expect(pc.remote).toEqual({ type: 'offer', sdp: 'restart' });
    expect(channel.sent.map((m) => JSON.parse(m))).toEqual([{ t: 'sig', d: { sdp: { type: 'answer', sdp: 'a' }, dcc: 1, ib: 1, dcr: 1, pc: 'p1' } }]);
    expect(sent).toEqual([]);
    channel.onmessage?.({ data: JSON.stringify({ t: 'sig', d: { sdp: { type: 'offer', sdp: 'new call' }, pc: 'p9', vid: 'v1' } }) });
    await vi.advanceTimersByTimeAsync(0);
    expect(FakePC.all).toHaveLength(1);
    expect(pc.remote).toEqual({ type: 'offer', sdp: 'restart' });
    // The goodbye still goes through the room (the channel closes with the call).
    hub.closeAll(true);
    expect(sent.at(-1)).toEqual({ to: 's1', d: { bye: true, pc: 'p1' } });
  });
});

describe('alerts on first arrival (eid)', () => {
  it('whichever copy comes first alerts; the other folds in quietly; events without an eid always count', () => {
    const f = new FirstArrival();
    expect(f.direct('cam1:100')).toBe(true);
    expect(f.room('cam1:100')).toBe('quiet');
    expect(f.room('cam1:101')).toBe('raise');
    expect(f.direct('cam1:101')).toBe(false);
    expect(f.direct(undefined)).toBe(true);
    expect(f.direct(undefined)).toBe(true);
    expect(f.room(null)).toBe('raise');
    expect(f.room('not an eid')).toBe('raise');
  });

  const SOUNDS = new Set(['cry', 'cough']);
  const ev = (x: Partial<Extract<DirectMsg, { t: 'ev' }>>): DirectMsg => ({ t: 'ev', kind: 'vision', at: 1, dev: 'camA', ...x });
  const ctx = (arrival: FirstArrival, open: OpenAlert[] = [], now = 100_000) => ({ sounds: SOUNDS, arrival, roomUp: true, eidRoom: true, open, now });

  it('an event the direct copy doesn’t alert on (a cup, the remote, a pet) leaves the room’s copy free to sound', () => {
    const f = new FirstArrival();
    // A non-sharp object: the camera sends it on both paths with one eid; only the room alerts on it.
    expect(directAlert(ev({ kind: 'scene', type: 'object_near', label: 'remote', sharp: false, eid: 'camA:7' }), ctx(f))).toBeNull();
    expect(f.room('camA:7')).toBe('raise'); // the room's line sounds — not silenced by the direct copy
    // A sharp one alerts from here first, and the room's copy then folds in quietly.
    expect(directAlert(ev({ kind: 'scene', type: 'object_near', label: 'knife', sharp: true, eid: 'camA:8' }), ctx(f))).toEqual({ cat: 'object', quiet: false });
    expect(f.room('camA:8')).toBe('quiet');
    // A cry's end alerts nothing (and doesn't hide the room's line either).
    expect(directAlert(ev({ kind: 'sound', cat: 'cry', phase: 'end', eid: 'camA:9' }), ctx(f))).toBeNull();
    expect(f.room('camA:9')).toBe('raise');
  });

  it('a new hazard of the same kind always sounds — another zone, another camera, or after “I’m on it”; a genuine repeat folds in', () => {
    const f = new FirstArrival();
    const now = 100_000;
    const stove: OpenAlert = { cat: 'zone', at: now - 15_000, acked: null, ended: null, dev: 'camA', zone: 'stove' };
    // The same zone still sounding, a few seconds later: a repeat, folded in quietly.
    expect(directAlert(ev({ type: 'zone', zone: 'stove', name: 'Stove', eid: 'camA:20' }), ctx(f, [stove], now))).toEqual({ cat: 'zone', quiet: true });
    // Another zone on the same camera: sounds.
    expect(directAlert(ev({ type: 'zone', zone: 'window', name: 'Window', eid: 'camA:21' }), ctx(f, [stove], now))).toEqual({ cat: 'zone', quiet: false });
    // The parent tapped “I’m on it” for the stove: the stove again is new — sounds.
    expect(directAlert(ev({ type: 'zone', zone: 'stove', name: 'Stove', eid: 'camA:22' }), ctx(f, [{ ...stove, acked: 'Mom' }], now))).toEqual({ cat: 'zone', quiet: false });
    // A second camera's crib alert within 30 s of the first camera's: sounds.
    const cribA: OpenAlert = { cat: 'crib_out', at: now - 10_000, acked: 'Dad', ended: null, dev: 'camA' };
    expect(directAlert(ev({ type: 'crib_out', dev: 'camB', eid: 'camB:5' }), ctx(f, [cribA], now))).toEqual({ cat: 'crib_out', quiet: false });
    expect(directAlert(ev({ type: 'crib_out', dev: 'camB', eid: 'camB:6' }), ctx(f, [{ ...cribA, acked: null }], now))).toEqual({ cat: 'crib_out', quiet: false });
    // With the room down every direct alert sounds; without an eid room, the room's line raises it.
    expect(directAlert(ev({ type: 'zone', zone: 'stove', eid: 'camA:23' }), { ...ctx(f, [stove], now), roomUp: false })).toEqual({ cat: 'zone', quiet: false });
    expect(directAlert(ev({ type: 'zone', zone: 'stove', eid: 'camA:24' }), { ...ctx(f, [stove], now), eidRoom: false })).toBeNull();
    expect(repeatsOpen([stove], { cat: 'zone', dev: 'camA', zone: 'stove' }, now + 20_000)).toBe(false); // over 30 s
    // An alert the room's line raised knows its camera (not the zone): the same camera's cry again
    // is a repeat; a zone it can't place sounds rather than risk silencing a new one.
    const roomCry: OpenAlert = { cat: 'cry', at: now - 5000, acked: null, ended: null, dev: 'camA', zone: null };
    expect(directAlert(ev({ kind: 'sound', cat: 'cry', phase: 'start', eid: 'camA:30' }), ctx(f, [roomCry], now))).toEqual({ cat: 'cry', quiet: true });
    const roomZone: OpenAlert = { cat: 'zone', at: now - 5000, acked: null, ended: null, dev: 'camA', zone: null };
    expect(directAlert(ev({ type: 'zone', zone: 'stove', eid: 'camA:31' }), ctx(f, [roomZone], now))).toEqual({ cat: 'zone', quiet: false });
  });
});
