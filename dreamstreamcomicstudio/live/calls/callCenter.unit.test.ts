// The call store end to end with a fake line socket, a fake RTCPeerConnection
// and a camera that opens when the test says so: answering joins and offers
// without waiting for the camera, iPhone audio goes to the loudspeaker, a
// rejoin keeps your mute, a call that ended while you were away ends here too,
// and lines ping faster while they ring. Direct calls (anyone on Stream
// Studio): your own line places and rings them, each call's room is just
// another line, and blocks / favourites / who-can-call sync through your line.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Call } from './types';

type FakeSock = {
  kind: 'nursery' | 'me' | 'room';
  nid: string;
  ticket?: string;
  onMsg: (m: unknown) => void;
  onStatus: (s: string) => void;
  sent: Record<string, unknown>[];
  fast: boolean[];
  lastHeard: number;
  closed: boolean;
};
const h = vi.hoisted(() => ({
  sockets: [] as FakeSock[],
  nurseries: [{ id: '11111111-2222-4333-8444-555555555555', name: 'Nursery', baby_name: 'Aria' }] as { id: string; name: string; baby_name: string | null }[],
  pushSub: null as Record<string, unknown> | null,
}));

vi.mock('../account', () => ({ accessToken: async () => 'tok' }));
vi.mock('../monitor/client', () => {
  const fake = (kind: FakeSock['kind'], nid: string, onMsg: (m: unknown) => void, onStatus: (s: string) => void, ticket?: string) => {
    const s: FakeSock = { kind, nid, ticket, onMsg, onStatus, sent: [], fast: [], lastHeard: Date.now(), closed: false };
    h.sockets.push(s);
    // Like the real one: 'connecting' is reported before the socket object is returned.
    onStatus('connecting');
    return {
      send: (m: Record<string, unknown>) => s.sent.push(m),
      sendBinary: () => true,
      bufferedAmount: () => 0,
      close: () => void (s.closed = true),
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
  };
  return {
    listNurseries: async () => ({ ok: true, nurseries: h.nurseries }),
    openMonitorSocket: (nid: string, _mode: string, onMsg: (m: unknown) => void, _bin: unknown, onStatus: (s: string) => void) => fake('nursery', nid, onMsg, onStatus),
    openUserLineSocket: (uid: string, onMsg: (m: unknown) => void, onStatus: (s: string) => void) => fake('me', uid, onMsg, onStatus),
    openCallRoomSocket: (id: string, ticket: string, onMsg: (m: unknown) => void, onStatus: (s: string) => void) => fake('room', id, onMsg, onStatus, ticket),
  };
});
vi.mock('../monitor/push', () => ({ currentSubscription: async () => null, localNotify: async () => undefined, subscribe: async () => h.pushSub ?? { error: 'no' } }));
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
  h.nurseries = [{ id: NID, name: 'Nursery', baby_name: 'Aria' }];
  h.pushSub = null;
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

describe('direct calls', () => {
  const ME = '00000000-0000-4000-8000-0000000000a1';
  const SAM = '00000000-0000-4000-8000-000000000005';
  const ID = '0123456789abcdef';
  const sock = (kind: FakeSock['kind']) => h.sockets.filter((x) => x.kind === kind).at(-1)!;
  const meHello = (over: Record<string, unknown> = {}) => ({ t: 'hello', you: { sid: 'u1', uid: ME, name: 'Alice' }, vapid: 'BPUB', ringing: [], log: [], favs: [], blocked: [], prefs: { who: 'everyone' }, ...over });
  const roomHello = (sid: string, calls: Call[]) => ({ t: 'hello', you: { sid, uid: ME, name: 'Alice', role: 'member', label: null }, nursery: { id: 'direct', name: 'Stream Studio', baby: null }, ice: [{ urls: ['stun:s:3478'] }], vapid: null, calls, callLog: [] });
  const ring = (over: Record<string, unknown> = {}) => ({ id: ID, from: { uid: SAM, name: 'Sam' }, video: true, at: Date.now(), ticket: 'tk', ctx: { family: false, label: null, where: null }, ...over });
  const samCall = (over: Partial<Call> = {}): Call => ({
    id: ID, from: { uid: SAM, name: 'Sam', label: null }, video: true, invited: [ME], declined: [], at: Date.now(), answeredAt: null,
    parts: [{ uid: SAM, name: 'Sam', label: null, sid: 's-sam', at: 1, mic: true, cam: true }], ever: { [SAM]: 'Sam' }, ended: null, ...over,
  });

  async function setupDirect() {
    vi.resetModules();
    const { callCenter } = await import('./callCenter');
    callCenter.start(ME);
    for (let i = 0; i < 5 && !h.sockets.some((x) => x.kind === 'nursery'); i++) await tick();
    const me = sock('me');
    me.onStatus('connected');
    me.onMsg(meHello());
    return { callCenter, me };
  }

  it('placing one: your line starts it, its room is joined with the ticket, and it runs like a family call', async () => {
    const { callCenter, me } = await setupDirect();
    expect(me.nid).toBe(ME);
    const placed = callCenter.callUser([{ uid: SAM, name: 'Sam' }], false);
    await tick();
    gum.resolve(new FakeStream([new FakeTrack('audio')]));
    expect(await placed).toBeNull();
    const start = me.sent.find((m) => m.t === 'dcall_start')!;
    expect(start).toMatchObject({ to: [SAM], video: false, token: 'tok', ref: expect.any(String) });
    expect(callCenter.snapshot().active).toMatchObject({ state: 'calling', nursery: 'Stream Studio', asked: [{ uid: SAM, name: 'Sam' }] });

    me.onMsg({ t: 'dcall_started', ref: start.ref, id: ID, ticket: 'tkt', status: 'ringing' });
    const room = sock('room');
    expect(room).toMatchObject({ nid: ID, ticket: 'tkt' });
    expect(callCenter.snapshot().active?.nid).toBe(`d:${ID}`);
    // The call's room isn't a nursery.
    expect(callCenter.snapshot().lines.map((l) => l.nid)).toEqual([NID]);

    room.onStatus('connected');
    const pending = samCall({ from: { uid: ME, name: 'Alice', label: null }, invited: [SAM], parts: [{ uid: ME, name: 'Alice', label: null, sid: 'pending', at: 1, mic: true, cam: false, gone: 1 }], ever: { [ME]: 'Alice' } });
    room.onMsg(roomHello('s-me', [pending]));
    expect(room.sent[0]).toEqual({ t: 'call_join', id: ID, video: false, mic: true });

    callCenter.hangup();
    expect(room.sent.at(-1)).toEqual({ t: 'call_leave', id: ID });
    expect(room.closed).toBe(true);
    callCenter.stop();
  });

  it('someone who can’t be reached: says so at once, by name', async () => {
    const { callCenter, me } = await setupDirect();
    const placed = callCenter.callUser([{ uid: SAM, name: 'Sam' }], false);
    await tick();
    gum.resolve(new FakeStream([new FakeTrack('audio')]));
    await placed;
    const ref = me.sent.find((m) => m.t === 'dcall_start')!.ref;
    me.onMsg({ t: 'call_err', error: 'unavailable', ref });
    expect(callCenter.snapshot().active).toMatchObject({ state: 'ended', ended: { why: 'error', text: expect.stringMatching(/^Sam can’t be reached right now/) } });
    callCenter.stop();
  });

  it('a direct call rings at once — marked as not your family — and its room connects while it rings', async () => {
    const { callCenter, me } = await setupDirect();
    me.onMsg({ t: 'dcall_ring', ring: ring() });
    const [r] = callCenter.snapshot().ringing;
    expect(r).toMatchObject({ nid: `d:${ID}`, nursery: 'Stream Studio member · not in your family', direct: { family: false }, call: { id: ID, from: { uid: SAM, name: 'Sam' } } });
    const room = sock('room');
    expect(room).toMatchObject({ nid: ID, ticket: 'tk' });
    expect(me.fast.at(-1)).toBe(true); // your line answers fast while it rings

    // Answer (voice first): joins through the call's room.
    room.onStatus('connected');
    room.onMsg(roomHello('s-me', [samCall()]));
    const answered = callCenter.accept(`d:${ID}`, ID, false);
    for (let i = 0; i < 6; i++) await tick();
    expect(room.sent[0]).toEqual({ t: 'call_join', id: ID, video: false, mic: true });
    // Your line says "stop ringing" (you picked up here): the call goes on.
    me.onMsg({ t: 'dcall_update', id: ID, stop: true });
    expect(room.closed).toBe(false);
    expect(callCenter.snapshot().active?.state).not.toBe('ended');
    gum.resolve(new FakeStream([new FakeTrack('audio')]));
    await answered;
    room.onMsg({ t: 'call', call: samCall({ ended: { at: 2, why: 'done' } }) });
    expect(callCenter.snapshot().active?.state).toBe('ended');
    expect(room.closed).toBe(true);
    callCenter.stop();
  });

  it('picked up on another of your devices: the ring stops and the room closes', async () => {
    const { callCenter, me } = await setupDirect();
    me.onMsg({ t: 'dcall_ring', ring: ring() });
    const room = sock('room');
    me.onMsg({ t: 'dcall_update', id: ID, stop: true });
    expect(callCenter.snapshot().ringing).toEqual([]);
    expect(room.closed).toBe(true);
    callCenter.stop();
  });

  it('Decline & block: declined through your line, the caller blocked, the room closed', async () => {
    const { callCenter, me } = await setupDirect();
    me.onMsg({ t: 'dcall_ring', ring: ring() });
    const room = sock('room');
    callCenter.decline(`d:${ID}`, ID, true);
    expect(me.sent.at(-1)).toEqual({ t: 'dcall_decline', id: ID, block: true });
    expect(room.sent.at(-1)).toEqual({ t: 'call_decline', id: ID });
    expect(room.closed).toBe(true);
    expect(callCenter.snapshot().ringing).toEqual([]);
    expect(callCenter.snapshot().blocked.map((b) => b.uid)).toEqual([SAM]);
    callCenter.stop();
  });

  it('an app opened from the notification: the hello lists the ringing call — ticket and all', async () => {
    const { callCenter, me } = await setupDirect();
    me.onMsg(meHello({ ringing: [ring({ ticket: 'from-push' })] }));
    expect(callCenter.snapshot().ringing.map((r) => r.call.id)).toEqual([ID]);
    expect(sock('room').ticket).toBe('from-push');
    callCenter.stop();
  });

  it('checking for new nurseries never closes a direct call’s room', async () => {
    const { callCenter, me } = await setupDirect();
    me.onMsg({ t: 'dcall_ring', ring: ring() });
    await callCenter.refresh();
    expect(sock('room').closed).toBe(false);
    callCenter.stop();
  });

  it('“Ring this device” works with no nursery at all: the key comes from your own line', async () => {
    h.nurseries = [];
    h.pushSub = { endpoint: 'https://fcm.googleapis.com/x', keys: { p256dh: 'p', auth: 'a' } };
    const { callCenter, me } = await setupDirect();
    expect(await callCenter.enableRinging()).toEqual({ ok: true });
    expect(me.sent.at(-1)).toEqual({ t: 'call_push', sub: h.pushSub });
    localStorage.removeItem('ds-call-ring');
    callCenter.stop();
  });

  it('favourites, blocks and who can call you come from your line and go back to it', async () => {
    const { callCenter, me } = await setupDirect();
    me.onMsg(meHello({ favs: [{ uid: SAM, name: 'Sam', at: 1 }], prefs: { who: 'family' } }));
    expect(callCenter.snapshot()).toMatchObject({ favs: [{ uid: SAM }], who: 'family', directReady: true });
    callCenter.setFav({ uid: SAM, name: 'Sam' }, false);
    callCenter.setWho('everyone');
    callCenter.setBlocked({ uid: SAM, name: 'Sam' }, true);
    expect(me.sent.slice(-3)).toEqual([
      { t: 'fav', uid: SAM, name: 'Sam', on: false },
      { t: 'prefs', who: 'everyone' },
      { t: 'block', uid: SAM, name: 'Sam', on: true },
    ]);
    // Another device changed them: this one follows.
    me.onMsg({ t: 'dcall_state', favs: [], blocked: [], prefs: { who: 'family' } });
    expect(callCenter.snapshot()).toMatchObject({ favs: [], blocked: [], who: 'family' });
    callCenter.stop();
  });

  it('a device that becomes the nursery camera closes your line too (it must never ring)', async () => {
    const { callCenter, me } = await setupDirect();
    callCenter.setSuspended(true);
    expect(me.closed).toBe(true);
    expect(callCenter.snapshot().directReady).toBe(false);
    callCenter.setSuspended(false);
    expect(sock('me')).not.toBe(me);
    callCenter.stop();
  });
});
