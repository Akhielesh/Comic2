// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { CallBook, goneUntil, LINE_GRACE_MS, MAX_PARTS, missedBy, RING_MS, toRecord, VOUCH_CAP_MS, VOUCH_MS, type Call } from './familyCalls';

const mom = { uid: 'u-mom', name: 'Alice', label: 'Mom', sid: 's-mom' };
const grandma = { uid: 'u-gma', name: 'June', label: 'Grandma', sid: 's-gma' };
const grandpa = { uid: 'u-gpa', name: 'Bob', label: 'Grandpa', sid: 's-gpa' };
const dad = { uid: 'u-dad', name: 'Sam', label: 'Dad', sid: 's-dad' };
const T = 1_000_000;

const ok = (r: Call | { error: string }): Call => {
  if ('error' in r) throw new Error(r.error);
  return r;
};

describe('CallBook', () => {
  it('starts a call: the caller is in it, the people asked are rung', () => {
    const book = new CallBook();
    const call = ok(book.start(mom, ['u-gma', 'u-gpa', 'u-mom', 'u-gma'], true, 'c1', T));
    expect(call.invited).toEqual(['u-gma', 'u-gpa']);
    expect(call.parts.map((p) => p.sid)).toEqual(['s-mom']);
    expect(call.answeredAt).toBeNull();
    expect(book.forUser('u-gpa')).toEqual([call]);
    expect(book.nextDeadline()).toBe(T + RING_MS);
  });

  it('won’t call nobody, or start a second call from a device already in one', () => {
    const book = new CallBook();
    expect(book.start(mom, ['u-mom'], true, 'c0', T)).toEqual({ error: 'nobody' });
    ok(book.start(mom, ['u-gma'], true, 'c1', T));
    expect(book.start(mom, ['u-gpa'], true, 'c2', T)).toEqual({ error: 'busy' });
  });

  it('picking up connects; only the people asked may join; four at most', () => {
    const book = new CallBook();
    ok(book.start(mom, ['u-gma', 'u-gpa', 'u-dad', 'u-x'], true, 'c1', T));
    expect(book.join('c1', { uid: 'u-stranger', name: 'X', label: null, sid: 's-x' }, true, T)).toEqual({ error: 'not_invited' });
    const call = ok(book.join('c1', grandma, true, T + 4000));
    expect(call.answeredAt).toBe(T + 4000);
    ok(book.join('c1', grandpa, false, T + 5000));
    ok(book.join('c1', dad, true, T + 6000));
    expect(call.parts).toHaveLength(MAX_PARTS);
    expect(call.parts.find((p) => p.uid === 'u-gpa')?.cam).toBe(false);
    expect(book.join('c1', { uid: 'u-x', name: 'Y', label: null, sid: 's-y' }, true, T)).toEqual({ error: 'full' });
  });

  it('answering on a second device moves the call there', () => {
    const book = new CallBook();
    ok(book.start(mom, ['u-gma'], true, 'c1', T));
    ok(book.join('c1', grandma, true, T + 1000));
    const call = ok(book.join('c1', { ...grandma, sid: 's-gma-ipad' }, true, T + 2000));
    expect(call.parts.map((p) => p.sid)).toEqual(['s-mom', 's-gma-ipad']);
  });

  it('when everyone says no, the call ends — and nobody gets a "missed call"', () => {
    const book = new CallBook();
    ok(book.start(mom, ['u-gma', 'u-gpa'], true, 'c1', T));
    expect(book.decline('c1', 'u-gma', T + 1000)?.ended).toBeNull();
    const call = book.decline('c1', 'u-gpa', T + 2000)!;
    expect(call.ended).toEqual({ at: T + 2000, why: 'declined' });
    expect(missedBy(call)).toEqual([]);
    expect(book.sweep()).toEqual([call]);
    expect(book.get('c1')).toBeNull();
  });

  it('the caller hanging up before an answer is "cancelled"; those not asked to say no missed it', () => {
    const book = new CallBook();
    ok(book.start(mom, ['u-gma', 'u-gpa'], true, 'c1', T));
    book.decline('c1', 'u-gpa', T + 500);
    const [call] = book.leave('s-mom', T + 3000);
    expect(call.ended?.why).toBe('cancelled');
    expect(missedBy(call)).toEqual(['u-gma']);
  });

  it('rings for 45 s, then “no answer”', () => {
    const book = new CallBook();
    ok(book.start(mom, ['u-gma'], false, 'c1', T));
    expect(book.expire(T + RING_MS - 1)).toEqual([]);
    const [call] = book.expire(T + RING_MS);
    expect(call.ended?.why).toBe('no_answer');
    expect(missedBy(call)).toEqual(['u-gma']);
    expect(toRecord(call)).toMatchObject({ answered: false, secs: 0, why: 'no_answer', video: false, joined: [{ uid: 'u-mom', name: 'Alice' }] });
  });

  it('a two-person call ends when either hangs up; the history keeps who and how long', () => {
    const book = new CallBook();
    ok(book.start(mom, ['u-gma'], true, 'c1', T));
    ok(book.join('c1', grandma, true, T + 5000));
    const [call] = book.leave('s-gma', T + 5000 + 754_000);
    expect(call.ended?.why).toBe('done');
    expect(missedBy(call)).toEqual([]);
    expect(toRecord(call)).toMatchObject({ answered: true, secs: 754, joined: [{ uid: 'u-mom', name: 'Alice' }, { uid: 'u-gma', name: 'June' }] });
  });

  it('a group call goes on while two or more remain', () => {
    const book = new CallBook();
    ok(book.start(mom, ['u-gma', 'u-gpa'], true, 'c1', T));
    ok(book.join('c1', grandma, true, T + 1000));
    ok(book.join('c1', grandpa, true, T + 2000));
    const [call] = book.leave('s-mom', T + 60_000);
    expect(call.ended).toBeNull();
    expect(call.parts.map((p) => p.uid)).toEqual(['u-gma', 'u-gpa']);
  });

  it('a dropped connection gets a grace period to come back', () => {
    const book = new CallBook();
    ok(book.start(mom, ['u-gma'], true, 'c1', T));
    ok(book.join('c1', grandma, true, T + 1000));
    const [dropped] = book.drop('s-gma', T + 10_000);
    expect(dropped.ended).toBeNull();
    expect(dropped.parts.find((p) => p.uid === 'u-gma')?.gone).toBe(T + 10_000);
    expect(book.canRelay('c1', 's-mom', 's-gma')).toBe(false);
    expect(book.nextDeadline()).toBe(T + 10_000 + LINE_GRACE_MS);
    // Back on a new connection within the grace period: same call, new socket.
    const back = ok(book.join('c1', { ...grandma, sid: 's-gma-2' }, true, T + 15_000));
    expect(back.parts.map((p) => [p.sid, p.gone])).toEqual([['s-mom', undefined], ['s-gma-2', undefined]]);
    expect(book.expire(T + 60_000)).toEqual([]);
    // Gone for good this time.
    book.drop('s-gma-2', T + 70_000);
    const [ended] = book.expire(T + 70_000 + LINE_GRACE_MS);
    expect(ended.ended?.why).toBe('done');
  });

  it('relays signaling only between two devices in the same call', () => {
    const book = new CallBook();
    ok(book.start(mom, ['u-gma'], true, 'c1', T));
    ok(book.join('c1', grandma, true, T + 1000));
    ok(book.start(dad, ['u-gpa'], true, 'c2', T));
    expect(book.canRelay('c1', 's-mom', 's-gma')).toBe(true);
    expect(book.canRelay('c1', 's-dad', 's-gma')).toBe(false);
    expect(book.canRelay('c2', 's-dad', 's-mom')).toBe(false);
    expect(book.canRelay('c1', 's-mom', 's-mom')).toBe(false);
  });

  it('someone in the call can ring more people in', () => {
    const book = new CallBook();
    ok(book.start(mom, ['u-gma'], true, 'c1', T));
    ok(book.join('c1', grandma, true, T + 1000));
    expect(book.invite('c1', 's-stranger', ['u-gpa'])).toBeNull();
    const r = book.invite('c1', 's-gma', ['u-gpa', 'u-mom', 'u-gma'])!;
    expect(r.added).toEqual(['u-gpa']);
    expect(r.call.invited).toEqual(['u-gma', 'u-gpa']);
  });

  it('coming back on a new connection keeps the mic and camera as they were', () => {
    const book = new CallBook();
    ok(book.start(mom, ['u-gma'], true, 'c1', T));
    ok(book.join('c1', grandma, true, T + 1000));
    book.setMedia('c1', 's-gma', false, false);
    book.drop('s-gma', T + 5000);
    const back = ok(book.join('c1', { ...grandma, sid: 's-gma-2' }, false, T + 8000, false));
    expect(back.parts.find((p) => p.uid === 'u-gma')).toMatchObject({ sid: 's-gma-2', mic: false, cam: false });
    // A plain pick-up still starts unmuted.
    expect(ok(book.join('c1', { ...grandma, sid: 's-gma-3' }, true, T + 9000)).parts.find((p) => p.uid === 'u-gma')?.mic).toBe(true);
  });

  it('keeps a phone that lost the room in the call while the others still get its media', () => {
    const book = new CallBook();
    ok(book.start(mom, ['u-gma'], true, 'c1', T));
    ok(book.join('c1', grandma, true, T + 1000));
    book.drop('s-gma', T + 10_000);
    // Mom's phone still gets Grandma's video, and says so every 10 s.
    for (let t = T + 20_000; t <= T + 60_000; t += 10_000) expect(book.vouch('c1', 's-mom', ['u-gma'], t)).toBe(true);
    expect(book.expire(T + 10_000 + LINE_GRACE_MS + 30_000)).toEqual([]);
    expect(book.nextDeadline()).toBe(T + 60_000 + VOUCH_MS);
    // The media stopped too: 30 s after the last word for it, it's out.
    const [ended] = book.expire(T + 60_000 + VOUCH_MS);
    expect(ended.ended?.why).toBe('done');
  });

  it('vouching has limits: two minutes away at most, only from someone present, never for yourself', () => {
    const book = new CallBook();
    ok(book.start(mom, ['u-gma', 'u-gpa'], true, 'c1', T));
    ok(book.join('c1', grandma, true, T + 1000));
    ok(book.join('c1', grandpa, true, T + 1000));
    book.drop('s-gma', T + 10_000);
    book.drop('s-gpa', T + 10_000);
    expect(book.vouch('c1', 's-gpa', ['u-gma'], T + 12_000)).toBe(false); // Grandpa is away himself
    expect(book.vouch('c1', 's-mom', ['u-mom'], T + 12_000)).toBe(false);
    expect(book.vouch('c1', 's-stranger', ['u-gma'], T + 12_000)).toBe(false);
    for (let t = T + 12_000; t < T + 10_000 + VOUCH_CAP_MS; t += 10_000) book.vouch('c1', 's-mom', ['u-gma'], t);
    expect(book.vouch('c1', 's-mom', ['u-gma'], T + 10_000 + VOUCH_CAP_MS)).toBe(false);
    const gma = book.get('c1')!.parts.find((p) => p.uid === 'u-gma')!;
    expect(goneUntil(gma)).toBe(T + 10_000 + VOUCH_CAP_MS);
    // Grandpa, never vouched for, leaves after the usual grace; the call goes on with Mom + Grandma.
    const [c] = book.expire(T + 10_000 + LINE_GRACE_MS);
    expect(c.parts.map((p) => p.uid)).toEqual(['u-mom', 'u-gma']);
    expect(c.ended).toBeNull();
  });

  it('keeps how connecting went (sanitised) in the history', () => {
    const book = new CallBook();
    ok(book.start(mom, ['u-gma'], true, 'c1', T));
    ok(book.join('c1', grandma, true, T + 1000));
    expect(book.stat('c1', 'u-gma', { ttc: 1234.4, path: 'internet', fail: null, turn: false }, T + 2000)).toBe(true);
    expect(book.stat('c1', 'u-mom', { ttc: -5, path: 'mars' as never, fail: 'nat', turn: true }, T + 2000)).toBe(true);
    expect(book.stat('c1', 'u-stranger', { ttc: 1 }, T + 2000)).toBe(false);
    const [call] = book.leave('s-gma', T + 60_000);
    expect(toRecord(call).stats).toEqual([
      { uid: 'u-gma', ttc: 1234, path: 'internet', fail: null, turn: false },
      { uid: 'u-mom', ttc: 0, path: null, fail: 'nat', turn: true },
    ]);
  });

  it('round-trips through storage, dropping finished calls', () => {
    const book = new CallBook();
    ok(book.start(mom, ['u-gma'], true, 'c1', T));
    ok(book.start(dad, ['u-gpa'], true, 'c2', T));
    book.leave('s-dad', T + 1);
    const again = new CallBook(structuredClone(book.toJSON()));
    expect(again.get('c1')?.from.uid).toBe('u-mom');
    expect(again.get('c2')).toBeNull();
  });
});
