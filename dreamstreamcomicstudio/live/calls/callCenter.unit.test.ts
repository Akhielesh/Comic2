// The call store end to end with a fake line socket, a fake RTCPeerConnection
// and a camera that opens when the test says so: answering joins and offers
// without waiting for the camera, iPhone audio goes to the loudspeaker, a
// rejoin keeps your mute, a call that ended while you were away ends here too,
// and lines ping faster while they ring.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Call } from './types';

const h = vi.hoisted(() => ({
  sockets: [] as {
    nid: string;
    onMsg: (m: unknown) => void;
    onStatus: (s: string) => void;
    sent: Record<string, unknown>[];
    fast: boolean[];
    lastHeard: number;
  }[],
}));

vi.mock('../monitor/client', () => ({
  listNurseries: async () => ({ ok: true, nurseries: [{ id: '11111111-2222-4333-8444-555555555555', name: 'Nursery', baby_name: 'Aria' }] }),
  openMonitorSocket: (nid: string, _mode: string, onMsg: (m: unknown) => void, _bin: unknown, onStatus: (s: string) => void) => {
    const s = { nid, onMsg, onStatus, sent: [] as Record<string, unknown>[], fast: [] as boolean[], lastHeard: Date.now() };
    h.sockets.push(s);
    // Like the real one: 'connecting' is reported before the socket object is returned.
    onStatus('connecting');
    return {
      send: (m: Record<string, unknown>) => s.sent.push(m),
      sendBinary: () => true,
      bufferedAmount: () => 0,
      close: () => undefined,
      open: true,
      get lastHeard() {
        return s.lastHeard;
      },
      setFast: (on: boolean) => {
        if (s.fast.at(-1) !== on) s.fast.push(on);
      },
      probe: () => undefined,
      reconnect: () => undefined,
    };
  },
}));
vi.mock('../monitor/push', () => ({ currentSubscription: async () => null, localNotify: async () => undefined, subscribe: async () => ({ error: 'no' }) }));
vi.mock('../wakeLock', () => ({ ScreenWakeLock: class { enable = async () => undefined; disable = async () => undefined; } }));

const NID = '11111111-2222-4333-8444-555555555555';

class FakeTrack {
  enabled = true;
  stopped = false;
  constructor(public kind: string) {}
  stop() {
    this.stopped = true;
  }
}
class FakeStream {
  private t: FakeTrack[];
  constructor(t: FakeTrack[] = []) {
    this.t = [...t];
  }
  getTracks = () => [...this.t];
  getAudioTracks = () => this.t.filter((x) => x.kind === 'audio');
  getVideoTracks = () => this.t.filter((x) => x.kind === 'video');
  addTrack = (x: FakeTrack) => void this.t.push(x);
  removeTrack = (x: FakeTrack) => void (this.t = this.t.filter((y) => y !== x));
}
class FakePC {
  static all: FakePC[] = [];
  transceivers: { direction: string; currentDirection: null; receiver: { track: { kind: string } }; sender: { track: unknown; replaceTrack: (t: unknown) => Promise<void>; getParameters: () => { encodings: object[] }; setParameters: () => Promise<void> } }[] = [];
  localDescription: { type: string; sdp: string; toJSON: () => object } | null = null;
  remoteDescription: unknown = null;
  signalingState = 'stable';
  connectionState = 'new';
  onicecandidate = null;
  ontrack = null;
  onconnectionstatechange: (() => void) | null = null;
  constructor(public config: RTCConfiguration) {
    FakePC.all.push(this);
  }
  addTransceiver(kind: string) {
    const sender = { track: null as unknown, replaceTrack: async (t: unknown) => void (sender.track = t), getParameters: () => ({ encodings: [{}] }), setParameters: async () => undefined };
    this.transceivers.push({ direction: 'sendrecv', currentDirection: null, receiver: { track: { kind } }, sender });
  }
  getTransceivers = () => this.transceivers;
  getSenders = () => this.transceivers.map((t) => t.sender);
  createOffer = async () => ({ type: 'offer', sdp: 'offer' });
  createAnswer = async () => ({ type: 'answer', sdp: 'answer' });
  setLocalDescription = async (d: { type: string; sdp: string }) => {
    this.localDescription = { ...d, toJSON: () => ({ type: d.type, sdp: d.sdp }) };
    this.signalingState = d.type === 'offer' ? 'have-local-offer' : 'stable';
  };
  setRemoteDescription = async (d: unknown) => void (this.remoteDescription = d);
  addIceCandidate = async () => undefined;
  close = () => void (this.signalingState = 'closed');
  getConfiguration = () => this.config;
  setConfiguration = (c: RTCConfiguration) => void (this.config = c);
  getStats = async () => new Map();
  restartIce = () => undefined;
}

const ringing = (over: Partial<Call> = {}): Call => ({
  id: 'c1', from: { uid: 'mom', name: 'Alice', label: 'Mom' }, video: true, invited: ['gpa'], declined: [], at: 1, answeredAt: null,
  parts: [{ uid: 'mom', name: 'Alice', label: 'Mom', sid: 's-mom', at: 1, mic: true, cam: true }], ever: { mom: 'Alice' }, ended: null, ...over,
});
const hello = (sid: string, calls: Call[] = []) => ({
  t: 'hello', you: { sid, uid: 'gpa', name: 'Bob', role: 'caregiver', label: 'Grandpa' }, nursery: { id: NID, name: 'Nursery', baby: 'Aria' },
  ice: [{ urls: ['stun:stun.example:3478'] }], vapid: null, calls, callLog: [],
});
const tick = () => new Promise((r) => setTimeout(r, 0));

let gum: { resolve: (s: FakeStream) => void; reject: (e: unknown) => void; calls: number };
const audioSession = { type: 'auto' };

async function setup() {
  vi.resetModules();
  const { callCenter } = await import('./callCenter');
  callCenter.start();
  for (let i = 0; i < 5 && !h.sockets.length; i++) await tick();
  const line = h.sockets.at(-1)!;
  line.onStatus('connected');
  line.onMsg(hello('s-gpa'));
  return { callCenter, line };
}

beforeEach(() => {
  h.sockets.length = 0;
  FakePC.all = [];
  audioSession.type = 'auto';
  vi.stubGlobal('RTCPeerConnection', FakePC);
  vi.stubGlobal('MediaStream', FakeStream);
  gum = { resolve: () => undefined, reject: () => undefined, calls: 0 };
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: {
      getUserMedia: () => {
        gum.calls += 1;
        return new Promise((resolve, reject) => {
          gum.resolve = resolve as (s: FakeStream) => void;
          gum.reject = reject;
        });
      },
    },
  });
  Object.defineProperty(navigator, 'audioSession', { configurable: true, value: audioSession });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('call center', () => {
  it('answering joins and offers at once — the camera slots in when it opens; the call uses the loudspeaker', async () => {
    const { callCenter, line } = await setup();
    line.onMsg({ t: 'call', call: ringing() });
    expect(callCenter.snapshot().ringing).toHaveLength(1);
    // A connection is made while it rings (candidates gathered before Accept).
    expect(FakePC.all).toHaveLength(1);
    expect(FakePC.all[0].config).toMatchObject({ bundlePolicy: 'max-bundle', iceCandidatePoolSize: 1 });
    expect(line.fast.at(-1)).toBe(true);

    const answered = callCenter.accept(NID, 'c1', true);
    for (let i = 0; i < 6; i++) await tick();
    // The camera hasn't opened, yet the join and the offer are already out — in that order.
    expect(gum.calls).toBe(1);
    const kinds = line.sent.map((m) => m.t);
    expect(kinds.slice(0, 2)).toEqual(['call_join', 'call_rtc']);
    expect(line.sent[0]).toEqual({ t: 'call_join', id: 'c1', video: true, mic: true });
    expect(line.sent[1]).toMatchObject({ to: 's-mom', d: { sdp: { type: 'offer' } } });
    expect(FakePC.all).toHaveLength(1); // the ringing-time connection was used
    expect(audioSession.type).toBe('play-and-record');
    expect(callCenter.snapshot().active?.state).toBe('connecting');

    const mic = new FakeTrack('audio');
    const cam = new FakeTrack('video');
    gum.resolve(new FakeStream([mic, cam]));
    expect(await answered).toBeNull();
    const senders = FakePC.all[0].transceivers.map((t) => t.sender.track);
    expect(senders).toEqual([mic, cam]);

    callCenter.hangup();
    expect(line.sent.at(-1)).toEqual({ t: 'call_leave', id: 'c1' });
    expect(audioSession.type).toBe('auto');
    expect(mic.stopped && cam.stopped).toBe(true);
    callCenter.stop();
  });

  it('a camera that can’t open keeps you in the call, shown muted with the camera off', async () => {
    const { callCenter, line } = await setup();
    line.onMsg({ t: 'call', call: ringing() });
    const answered = callCenter.accept(NID, 'c1', true);
    for (let i = 0; i < 4; i++) await tick();
    gum.reject(new DOMException('denied', 'NotAllowedError'));
    expect(await answered).toMatch(/Allow the camera and microphone/);
    expect(callCenter.snapshot().active).toMatchObject({ mic: false, cam: false });
    expect(line.sent.at(-1)).toEqual({ t: 'call_media', id: 'c1', mic: false, cam: false });
    callCenter.stop();
  });

  it('back on a new connection: rejoins with the mic as it was; a call that ended meanwhile ends here', async () => {
    const { callCenter, line } = await setup();
    line.onMsg({ t: 'call', call: ringing() });
    const answered = callCenter.accept(NID, 'c1', false);
    for (let i = 0; i < 4; i++) await tick();
    gum.resolve(new FakeStream([new FakeTrack('audio')]));
    await answered;
    const inCall = ringing({ answeredAt: 5, parts: [...ringing().parts, { uid: 'gpa', name: 'Bob', label: 'Grandpa', sid: 's-gpa', at: 5, mic: true, cam: false }] });
    line.onMsg({ t: 'call', call: inCall });
    await callCenter.toggleMic();
    expect(callCenter.snapshot().active?.mic).toBe(false);

    // The line blipped: the room still has the call, our old socket marked away.
    const away = { ...inCall, parts: inCall.parts.map((p) => (p.uid === 'gpa' ? { ...p, gone: 9 } : p)) };
    const n = line.sent.length;
    line.onMsg(hello('s-gpa-2', [away]));
    // The join goes first; the handshake that was still waiting is resent right behind it.
    expect(line.sent[n]).toEqual({ t: 'call_join', id: 'c1', video: false, mic: false });
    expect(line.sent.slice(n + 1).every((m) => m.t === 'call_rtc')).toBe(true);
    expect(callCenter.snapshot().active?.state).not.toBe('ended');

    // Another blip — and this time the call ended while we were away.
    line.onMsg(hello('s-gpa-3', []));
    expect(callCenter.snapshot().active).toMatchObject({ state: 'ended', ended: { text: 'Call ended' } });
    callCenter.stop();
  });

  it('vouches for someone whose app lost the room while their media still arrives — and only then', async () => {
    const { callCenter, line } = await setup();
    line.onMsg({ t: 'call', call: ringing() });
    const answered = callCenter.accept(NID, 'c1', false);
    for (let i = 0; i < 4; i++) await tick();
    gum.resolve(new FakeStream([new FakeTrack('audio')]));
    await answered;
    const gpaPart = { uid: 'gpa', name: 'Bob', label: 'Grandpa', sid: 's-gpa', at: 5, mic: true, cam: false };
    line.onMsg({ t: 'call', call: ringing({ answeredAt: 5, parts: [...ringing().parts, gpaPart] }) });
    const pc = FakePC.all[0];
    pc.connectionState = 'connected';
    pc.onconnectionstatechange?.();
    await tick();
    expect(callCenter.snapshot().active?.state).toBe('connected');
    expect(line.sent.some((m) => m.t === 'call_up')).toBe(false);
    // Mom's app lost the room; her video still reaches Grandpa.
    line.onMsg({ t: 'call', call: ringing({ answeredAt: 5, parts: [{ ...ringing().parts[0], gone: 9 }, gpaPart] }) });
    expect(line.sent.at(-1)).toEqual({ t: 'call_up', id: 'c1', uids: ['mom'] });
    callCenter.stop();
  });

  it('the call moved to another of our devices while this one was away', async () => {
    const { callCenter, line } = await setup();
    line.onMsg({ t: 'call', call: ringing() });
    const answered = callCenter.accept(NID, 'c1', false);
    for (let i = 0; i < 4; i++) await tick();
    gum.resolve(new FakeStream([new FakeTrack('audio')]));
    await answered;
    const ipad = ringing({ answeredAt: 5, parts: [...ringing().parts, { uid: 'gpa', name: 'Bob', label: 'Grandpa', sid: 's-gpa-ipad', at: 7, mic: true, cam: true }] });
    line.onMsg(hello('s-gpa-2', [ipad]));
    expect(callCenter.snapshot().active?.ended?.text).toBe('Continued on another device');
    callCenter.stop();
  });

  it('a call we placed whose start was lost with the old connection is placed again', async () => {
    const { callCenter, line } = await setup();
    const placed = callCenter.call(NID, [{ uid: 'mom', name: 'Mom' }], false);
    await tick();
    gum.resolve(new FakeStream([new FakeTrack('audio')]));
    expect(await placed).toBeNull();
    const start = line.sent.find((m) => m.t === 'call_start')!;
    line.onMsg(hello('s-gpa-2', []));
    expect(line.sent.at(-1)).toEqual({ t: 'call_start', to: ['mom'], video: false, ref: start.ref });
    callCenter.stop();
  });

  it('declining stops the fast pings and closes the ringing-time connection', async () => {
    const { callCenter, line } = await setup();
    line.onMsg({ t: 'call', call: ringing() });
    expect(line.fast.at(-1)).toBe(true);
    callCenter.decline(NID, 'c1');
    expect(line.fast.at(-1)).toBe(false);
    expect(FakePC.all[0].signalingState).toBe('closed');
    callCenter.stop();
  });
});
