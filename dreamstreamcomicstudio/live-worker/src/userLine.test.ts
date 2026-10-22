// @vitest-environment node
// A member's personal line: only they can claim it, only a claimed line
// rings, a blocked caller hears what anyone else would while nothing reaches
// the member, and — end to end with the call's room in between — two people
// who share no nursery can call each other.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const push = vi.hoisted(() => ({ sent: [] as { endpoint: string; data: Record<string, unknown>; opts: Record<string, unknown> }[] }));
vi.mock('./webpush', async (orig) => ({
  ...(await orig<typeof import('./webpush')>()),
  sendWebPush: async (sub: { endpoint: string }, data: Record<string, unknown>, _keys: unknown, opts: Record<string, unknown>) => {
    push.sent.push({ endpoint: sub.endpoint, data, opts });
    return 'sent';
  },
}));

import { userLineName, type RingingRec } from './directCalls';
import { Pair, World, type FakeWS, type Member } from './directTestKit';
import type { Call, CallRecord } from './familyCalls';
import { clearMemberCache } from './supabaseAuth';

const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const SUB = (n: number) => ({ endpoint: `https://fcm.googleapis.com/fcm/send/dev${n}`, keys: { p256dh: 'p', auth: 'a' } });
const NID = '11111111-2222-4333-8444-555555555555';

let w: World;
let alice: Member;
let sam: Member;
let gma: Member;

beforeEach(() => {
  vi.stubGlobal('WebSocketRequestResponsePair', Pair);
  push.sent = [];
  w = new World();
  vi.stubGlobal('fetch', w.fetch);
  alice = w.add({ uid: U(1), name: 'Alice', token: 'tok-alice', nurseries: [{ id: NID, name: 'Nursery', baby_name: 'Aria', people: [{ user_id: U(1), label: 'Mom' }, { user_id: U(3), label: 'Grandma' }] }] });
  sam = w.add({ uid: U(2), name: 'Sam', token: 'tok-sam' });
  gma = w.add({ uid: U(3), name: 'June', token: 'tok-gma', nurseries: [{ id: NID, name: 'Nursery', baby_name: 'Aria', people: [{ user_id: U(1), label: 'Mom' }, { user_id: U(3), label: 'Grandma' }] }] });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  clearMemberCache();
});

/** Ring a member's line as a call's room would. */
const ring = async (to: Member, from: Member, over: Record<string, unknown> = {}) => {
  const res = await w.lineOf(to.uid).obj.fetch(
    new Request('https://line.internal/x/ring', { method: 'POST', body: JSON.stringify({ id: 'abcdefabcdef0001', from: { uid: from.uid, name: from.name }, video: true, at: Date.now(), ticket: 'tkt', family: false, where: null, ...over }) }),
  );
  return (await res.json()) as { status: string; name?: string };
};
const start = (ws: FakeWS, m: Member, to: Member[], ref = 'r1', video = true) => w.say(m, ws, { t: 'dcall_start', to: to.map((x) => x.uid), video, ref, token: m.token });

describe('UserLine: claiming the line', () => {
  it('only the member it belongs to, signed in and a member, can open it', async () => {
    const h = w.lineOf(sam.uid).h;
    h.store.set('uid', sam.uid);
    const wrong = await w.app(sam, 'phone', 'tok-alice'); // Alice's (valid) token on Sam's line
    expect(wrong.closed).toBe(4003);
    expect(h.store.has('owner')).toBe(false);
    w.add({ uid: U(7), name: 'Nope', token: 'tok-nope', member: false });
    const nonMember = await w.app({ ...sam, token: 'tok-nope' }, 'phone');
    expect(nonMember.closed).toBe(4003);
    const expired = await w.app(sam, 'phone', 'tok-expired');
    expect(expired.closed).toBe(4001);
    const ok = await w.app(sam, 'phone');
    expect(ok.closed).toBeNull();
    expect(ok.last('hello')).toMatchObject({ you: { uid: sam.uid, name: 'Sam' }, vapid: 'BPUB', ringing: [], log: [], favs: [], blocked: [], prefs: { who: 'everyone' } });
    expect(h.store.get('owner')).toMatchObject({ uid: sam.uid, name: 'Sam', verifiedAt: expect.any(Number) });
  });

  it('works out the family after the hello, with the member’s own token', async () => {
    const ws = await w.app(alice, 'phone');
    expect(ws.sent[0].t).toBe('hello');
    expect(w.lineOf(alice.uid).h.store.get('family')).toMatchObject({ map: { [gma.uid]: { label: 'Grandma', where: 'Aria’s family' } } });
  });
});

describe('UserLine: being rung', () => {
  it('a line nobody claimed answers unavailable and writes nothing', async () => {
    expect(await ring(sam, alice)).toEqual({ status: 'unavailable' });
    expect(w.lineOf(sam.uid).h.store.size).toBe(0);
  });

  it('rings the open apps (with a ticket into the call) and phones that asked to be rung', async () => {
    const phone = await w.app(sam, 'phone');
    await w.say(sam, phone, { t: 'call_push', sub: SUB(1) });
    expect(await ring(sam, alice)).toEqual({ status: 'ringing', name: 'Sam' });
    expect(phone.last('dcall_ring')).toMatchObject({ ring: { id: 'abcdefabcdef0001', from: { uid: alice.uid, name: 'Alice' }, video: true, ticket: 'tkt', ctx: { family: false } } });
    expect(push.sent).toEqual([
      {
        endpoint: SUB(1).endpoint,
        data: expect.objectContaining({ kind: 'call', direct: true, call: 'abcdefabcdef0001', title: 'Alice', body: 'Video call · Stream Studio member · not in your family' }),
        opts: expect.objectContaining({ urgency: 'high', ttlSec: 45 }),
      },
    ]);
  });

  it('family reads as family — the member’s own label for the caller', async () => {
    const ws = await w.app(gma, 'phone');
    await ring(gma, alice);
    expect((ws.last('dcall_ring')!.ring as RingingRec).ctx).toEqual({ family: true, label: 'Mom', where: 'Aria’s family' });
  });

  it('a blocked caller gets the same answer — and nothing reaches the member, not even the history', async () => {
    const phone = await w.app(sam, 'phone');
    await w.say(sam, phone, { t: 'call_push', sub: SUB(1) });
    const before = await ring(sam, gma, { id: 'abcdefabcdef0002' });
    await w.say(sam, phone, { t: 'block', uid: alice.uid, name: 'Alice', on: true });
    phone.sent = [];
    push.sent = [];
    expect(await ring(sam, alice)).toEqual(before);
    expect(phone.msgs('dcall_ring')).toEqual([]);
    expect(push.sent).toEqual([]);
    const rec = { id: 'abcdefabcdef0001', from: { uid: alice.uid, name: 'Alice', label: null }, invited: [sam.uid], joined: [], video: true, at: 1, secs: 0, answered: false, why: 'no_answer' };
    await w.lineOf(sam.uid).obj.fetch(new Request('https://line.internal/x/log', { method: 'POST', body: JSON.stringify({ rec, missed: true }) }));
    expect(phone.msgs('call_log')).toEqual([]);
    expect(push.sent).toEqual([]);
  });

  it('“Only people in my nurseries”: outsiders are refused, family still rings', async () => {
    const phone = await w.app(gma, 'phone');
    await w.say(gma, phone, { t: 'prefs', who: 'family' });
    expect(await ring(gma, sam)).toEqual({ status: 'restricted' });
    expect(await ring(gma, alice, { id: 'abcdefabcdef0002' })).toMatchObject({ status: 'ringing' });
    expect(phone.msgs('dcall_ring')).toHaveLength(1);
  });

  it('someone outside the family ringing over and over is silenced after 3 an hour (answered the same)', async () => {
    const phone = await w.app(sam, 'phone');
    for (let i = 1; i <= 5; i++) expect(await ring(sam, alice, { id: `abcdefabcdef000${i}` })).toMatchObject({ status: 'ringing' });
    expect(phone.msgs('dcall_ring')).toHaveLength(3);
  });

  it('two declines in a day silence that caller too', async () => {
    const phone = await w.app(sam, 'phone');
    for (const id of ['abcdefabcdef0001', 'abcdefabcdef0002']) {
      await ring(sam, alice, { id });
      await w.say(sam, phone, { t: 'dcall_decline', id });
    }
    phone.sent = [];
    expect(await ring(sam, alice, { id: 'abcdefabcdef0003' })).toMatchObject({ status: 'ringing' });
    expect(phone.msgs('dcall_ring')).toEqual([]);
  });

  it('nothing to ring (no app open, no push): unavailable at once', async () => {
    const phone = await w.app(sam, 'phone');
    w.lineOf(sam.uid).h.drop(phone);
    expect(await ring(sam, alice)).toEqual({ status: 'unavailable' });
  });

  it('an app opened from the notification sees the ringing call, ticket included', async () => {
    const phone = await w.app(sam, 'phone');
    await ring(sam, alice);
    const fromPush = await w.app(sam, 'phone-2');
    expect((fromPush.last('hello')!.ringing as RingingRec[]).map((r) => [r.id, r.ticket])).toEqual([['abcdefabcdef0001', 'tkt']]);
    expect(phone.msgs('dcall_ring')).toHaveLength(1);
  });

  it('picked up elsewhere: every device stops ringing', async () => {
    const phone = await w.app(sam, 'phone');
    const laptop = await w.app(sam, 'laptop');
    await ring(sam, alice);
    await w.lineOf(sam.uid).obj.fetch(new Request('https://line.internal/x/update', { method: 'POST', body: JSON.stringify({ id: 'abcdefabcdef0001', stop: true }) }));
    expect(laptop.last('dcall_update')).toEqual({ t: 'dcall_update', id: 'abcdefabcdef0001', stop: true });
    expect(phone.last('dcall_update')).toBeTruthy();
    const later = await w.app(sam, 'tablet');
    expect(later.last('hello')!.ringing).toEqual([]);
  });
});

describe('UserLine: the member’s lists and ringing', () => {
  it('favourites, blocks and “who can call me” sync to every device and survive into hello', async () => {
    const phone = await w.app(alice, 'phone');
    const laptop = await w.app(alice, 'laptop');
    await w.say(alice, phone, { t: 'fav', uid: sam.uid, name: 'Sam', on: true });
    await w.say(alice, phone, { t: 'block', uid: U(9), name: 'Pest', on: true });
    await w.say(alice, phone, { t: 'prefs', who: 'family' });
    expect(laptop.last('dcall_state')).toMatchObject({ favs: [{ uid: sam.uid, name: 'Sam' }], blocked: [{ uid: U(9), name: 'Pest' }], prefs: { who: 'family' } });
    await w.say(alice, phone, { t: 'fav', uid: alice.uid, name: 'Me', on: true }); // never yourself
    await w.say(alice, phone, { t: 'block', uid: 'not-a-member', name: 'x', on: true });
    const again = await w.app(alice, 'tablet');
    expect(again.last('hello')).toMatchObject({ favs: [{ uid: sam.uid }], blocked: [{ uid: U(9) }], prefs: { who: 'family' } });
    await w.say(alice, phone, { t: 'block', uid: U(9), name: 'Pest', on: false });
    expect(laptop.last('dcall_state')).toMatchObject({ blocked: [] });
  });

  it('“Ring this device”: real push services only; a device turns its own ringing off', async () => {
    const phone = await w.app(sam, 'phone');
    await w.say(sam, phone, { t: 'call_push', sub: { endpoint: 'https://evil.example/collect', keys: { p256dh: 'p', auth: 'a' } } });
    expect(phone.last('call_err')).toEqual({ t: 'call_err', error: 'push' });
    await w.say(sam, phone, { t: 'call_push', sub: SUB(1) });
    await w.say(sam, phone, { t: 'call_push', sub: SUB(2) });
    await w.say(sam, phone, { t: 'call_push_off', endpoint: SUB(1).endpoint });
    expect((w.lineOf(sam.uid).h.store.get('push') as { sub: { endpoint: string } }[]).map((r) => r.sub.endpoint)).toEqual([SUB(2).endpoint]);
  });
});

describe('UserLine: placing calls', () => {
  it('the caller’s limits: 8 calls in 10 minutes', async () => {
    const phone = await w.app(alice, 'phone');
    await w.app(sam, 'phone');
    for (let i = 0; i < 8; i++) await start(phone, alice, [sam], `r${i}`);
    expect(phone.msgs('dcall_started')).toHaveLength(8);
    await start(phone, alice, [sam], 'r9');
    expect(phone.last('call_err')).toEqual({ t: 'call_err', error: 'slow_down', ref: 'r9' });
  });

  it('a start repeated after a lost reply gets the same call, not a second one', async () => {
    const phone = await w.app(alice, 'phone');
    await w.app(sam, 'phone');
    await start(phone, alice, [sam], 'same');
    await start(phone, alice, [sam], 'same');
    const [a, b] = phone.msgs('dcall_started');
    expect(a).toEqual(b);
    expect(w.rooms.size).toBe(1);
  });

  it('someone who can’t be reached: the caller hears it at once, the callee gets a missed call', async () => {
    const phone = await w.app(alice, 'phone');
    const samPhone = await w.app(sam, 'phone');
    w.lineOf(sam.uid).h.drop(samPhone); // Sam's app closed, no push
    await start(phone, alice, [sam]);
    expect(phone.last('call_err')).toEqual({ t: 'call_err', error: 'unavailable', ref: 'r1' });
    const log = w.lineOf(sam.uid).h.store.get('log') as CallRecord[];
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ from: { uid: alice.uid }, answered: false });
    expect(w.lineOf(alice.uid).h.store.get('log')).toEqual([expect.objectContaining({ id: log[0].id })]);
  });

  it('family-only callee: the caller hears “restricted”', async () => {
    const phone = await w.app(alice, 'phone');
    const samPhone = await w.app(sam, 'phone');
    await w.say(sam, samPhone, { t: 'prefs', who: 'family' });
    await start(phone, alice, [sam]);
    expect(phone.last('call_err')).toMatchObject({ error: 'restricted' });
    expect(w.lineOf(sam.uid).h.store.get('log') ?? []).toEqual([]);
  });

  it('Decline & block: blocks the caller as the server named them', async () => {
    const phone = await w.app(alice, 'phone');
    const samPhone = await w.app(sam, 'phone');
    await start(phone, alice, [sam]);
    const id = phone.last('dcall_started')!.id as string;
    await w.say(sam, samPhone, { t: 'dcall_decline', id, block: true });
    expect(samPhone.last('dcall_state')).toMatchObject({ blocked: [{ uid: alice.uid, name: 'Alice' }] });
    // The call ended as declined: no missed call for Sam, and Alice's history says so.
    expect((w.lineOf(alice.uid).h.store.get('log') as CallRecord[])[0].why).toBe('declined');
  });
});

describe('end to end: Alice calls Sam, who isn’t in any of her nurseries', () => {
  it('his phone and laptop ring, he answers on the phone, the laptop stops, the call connects, both keep it in their history', async () => {
    const alicePhone = await w.app(alice, 'alice-phone');
    const samPhone = await w.app(sam, 'sam-phone');
    const samLaptop = await w.app(sam, 'sam-laptop');

    // Alice taps Call on Sam (a search result).
    await start(alicePhone, alice, [sam], 'ref-1', true);
    const started = alicePhone.last('dcall_started')!;
    expect(started).toMatchObject({ ref: 'ref-1', id: expect.stringMatching(/^[0-9a-f]{16}$/), ticket: expect.any(String), status: 'ringing' });
    const id = started.id as string;

    // Both of Sam's devices ring — labelled as someone outside his family.
    for (const ws of [samPhone, samLaptop]) expect(ws.last('dcall_ring')).toMatchObject({ ring: { id, from: { uid: alice.uid, name: 'Alice' }, ctx: { family: false } } });
    const ticket = (samPhone.last('dcall_ring')!.ring as RingingRec).ticket;

    // Alice's app joins its call; Sam's devices pre-connect while it rings.
    const aliceIn = await w.enter(id, started.ticket as string, 'alice-phone');
    await w.in(id, aliceIn, { t: 'call_join', id, video: true, mic: true });
    const phoneIn = await w.enter(id, ticket, 'sam-phone');
    const laptopIn = await w.enter(id, ticket, 'sam-laptop');
    expect((laptopIn.last('hello')!.calls as Call[])[0]).toMatchObject({ id, invited: [sam.uid] });

    // Sam answers on his phone: the laptop stops ringing (from the room and from his line).
    await w.in(id, phoneIn, { t: 'call_join', id, video: true, mic: true });
    const answered = laptopIn.last('call')!.call as Call;
    expect(answered.parts.map((p) => p.uid)).toEqual([alice.uid, sam.uid]);
    expect(samLaptop.last('dcall_update')).toEqual({ t: 'dcall_update', id, stop: true });

    // The handshake flows between the two phones.
    await w.in(id, phoneIn, { t: 'call_rtc', id, to: 'c-alice-phone', d: { sdp: { type: 'offer', sdp: 'o' }, cid: 'k' } });
    await w.in(id, aliceIn, { t: 'call_rtc', id, to: 'c-sam-phone', d: { sdp: { type: 'answer', sdp: 'a' }, cid: 'k' } });
    expect(aliceIn.last('call_rtc')).toMatchObject({ from: 'c-sam-phone', d: { sdp: { type: 'offer' } } });
    expect(phoneIn.last('call_rtc')).toMatchObject({ from: 'c-alice-phone', d: { sdp: { type: 'answer' } } });
    expect(laptopIn.msgs('call_rtc')).toEqual([]);

    // Alice hangs up.
    await w.in(id, aliceIn, { t: 'call_leave', id });
    expect(phoneIn.last('call')!.call).toMatchObject({ ended: { why: 'done' } });
    const aliceLog = alicePhone.last('call_log')!.rec as CallRecord;
    const samLog = samLaptop.last('call_log')!.rec as CallRecord;
    expect(aliceLog).toMatchObject({ id, answered: true, from: { uid: alice.uid }, joined: [{ uid: alice.uid, name: 'Alice' }, { uid: sam.uid, name: 'Sam' }] });
    expect(samLog.id).toBe(id);
    expect(w.lineOf(sam.uid).h.store.get('log')).toHaveLength(1);
    expect(w.lineOf(alice.uid).h.store.get('log')).toHaveLength(1);
    // No missed call for an answered call.
    expect(push.sent.filter((p) => p.data.kind === 'call_missed')).toEqual([]);
    expect(w.lines.has(userLineName(sam.uid))).toBe(true);
  });
});
