// @vitest-environment node
// A2 TURN (agent-editor plan §3 A2, §4 wave 1): the synchronous turn reservation (G19), the steer inbox, and the
// recent-commit ring the conflict guard (A3) reads.

import { describe, expect, it } from 'vitest';
import { STEER_LIMITS } from '../../../shared/comic/events.js';
import { createEmptyDoc } from '../../../shared/comic/doc.js';
import { newSession, plannedDoc } from './orchestrator.fakes.js';
import { RECENT_COMMITS_BYTES, RECENT_COMMITS_MAX, openSteerOf, recentCommitsOf, type SteerNote } from './session.js';

const note = (text: string, at = 1): SteerNote => ({ msgId: `msg_${text.replace(/\W/g, '')}`, text, at });

describe('reserveTurn (G19: the BUSY check and the reservation are one synchronous step)', () => {
  it('makes turnRunning true synchronously, refuses a second reservation, and releases once (idempotent)', () => {
    const session = newSession(plannedDoc());
    expect(session.turnRunning).toBe(false);
    const release = session.reserveTurn();
    expect(release).toBeTypeOf('function');
    // No await in between: the very next request sees the turn as running.
    expect(session.turnRunning).toBe(true);
    expect(session.reserveTurn()).toBeNull();
    release!();
    expect(session.turnRunning).toBe(false);
    // A second call of the same release never clears a newer reservation.
    const next = session.reserveTurn();
    expect(next).toBeTypeOf('function');
    release!();
    expect(session.turnRunning).toBe(true);
    next!();
    expect(session.turnRunning).toBe(false);
  });

  it('a reserved session is busy (never evicted) and is refused while the turn lock is held', async () => {
    const session = newSession(plannedDoc());
    const release = session.reserveTurn()!;
    expect(session.busy).toBe(true);
    expect(session.isIdle(Date.now() + 60 * 60_000)).toBe(false);
    release();
    expect(session.busy).toBe(false);
    let during: unknown = 'unset';
    await session.runExclusive(async () => {
      during = session.reserveTurn();
    });
    expect(during).toBeNull();
    expect(session.turnRunning).toBe(false);
  });

  it('the reservation lives through the turn lock: held across runExclusive, released after it', async () => {
    const session = newSession(plannedDoc());
    const release = session.reserveTurn()!;
    await session.runExclusive(async () => {
      expect(session.turnRunning).toBe(true);
    });
    expect(session.turnRunning).toBe(true);
    release();
    expect(session.turnRunning).toBe(false);
  });
});

describe('the steer inbox', () => {
  it('takes no note while no director turn has it open (NOT_RUNNING)', () => {
    const session = newSession(plannedDoc());
    expect(session.steerRefusal()).toBe('NOT_RUNNING');
    expect(session.pushSteer(note('red'))).toBe(false);
    expect(session.takeSteer()).toEqual([]);
  });

  it('holds at most STEER_LIMITS.inbox notes (then BUSY), drains oldest first, and frees room once drained', () => {
    const session = newSession(plannedDoc());
    const close = session.openSteer();
    expect(session.steerRefusal()).toBeNull();
    for (let i = 0; i < STEER_LIMITS.inbox; i += 1) expect(session.pushSteer(note(`n${i}`, i))).toBe(true);
    expect(session.steerRefusal()).toBe('BUSY');
    expect(session.pushSteer(note('overflow'))).toBe(false);
    expect(session.takeSteer().map((n) => n.text)).toEqual(['n0', 'n1', 'n2']);
    expect(session.takeSteer()).toEqual([]);
    expect(session.pushSteer(note('again'))).toBe(true);
    expect(close().map((n) => n.text)).toEqual(['again']);
  });

  it('close hands back the unread notes once, then the inbox is shut (NOT_RUNNING) and a stale close changes nothing', () => {
    const session = newSession(plannedDoc());
    const closeFirst = session.openSteer();
    session.pushSteer(note('late'));
    expect(closeFirst().map((n) => n.text)).toEqual(['late']);
    expect(closeFirst()).toEqual([]);
    expect(session.steerRefusal()).toBe('NOT_RUNNING');
    // A later turn's inbox is never shut by an earlier turn's close.
    const closeSecond = session.openSteer();
    closeFirst();
    expect(session.pushSteer(note('second turn'))).toBe(true);
    expect(closeSecond().map((n) => n.text)).toEqual(['second turn']);
  });

  it('holdSteerSeat: a note being screened holds a seat, so at most STEER_LIMITS.inbox are screened or waiting', () => {
    const session = newSession(createEmptyDoc('p'));
    expect(session.holdSteerSeat()).toBeNull(); // no turn reads the inbox
    expect(session.steerRefusal()).toBe('NOT_RUNNING');
    const close = session.openSteer();
    const seats = Array.from({ length: STEER_LIMITS.inbox }, () => session.holdSteerSeat());
    expect(seats.every((s) => typeof s === 'function')).toBe(true);
    // Every seat is taken by a screen in flight: a further note is BUSY before its own screen.
    expect(session.steerRefusal()).toBe('BUSY');
    expect(session.holdSteerSeat()).toBeNull();
    // A seat holder gives its seat back before it pushes, so its push always has room…
    seats[0]!();
    seats[0]!(); // idempotent
    expect(session.pushSteer(note('screened'))).toBe(true);
    expect(session.steerRefusal()).toBe('BUSY'); // 1 waiting + 2 being screened
    seats[1]!();
    seats[2]!();
    expect(session.steerRefusal()).toBeNull();
    // …and the inbox itself stays bounded however notes arrive.
    expect(session.pushSteer(note('b'))).toBe(true);
    expect(session.pushSteer(note('c'))).toBe(true);
    expect(session.pushSteer(note('d'))).toBe(false);
    expect(close().map((n) => n.text)).toEqual(['screened', 'b', 'c']);
  });

  it('pushSteer bounds only the inbox: a note pushed while others are screened still fits, and the screened one then meets BUSY', () => {
    const session = newSession(createEmptyDoc('p'));
    session.openSteer();
    const seat = session.holdSteerSeat()!;
    for (let i = 0; i < STEER_LIMITS.inbox; i += 1) expect(session.pushSteer(note(`direct ${i}`))).toBe(true);
    seat();
    expect(session.pushSteer(note('late'))).toBe(false);
    expect(session.steerRefusal()).toBe('BUSY');
  });

  it('openSteerOf opens a real session and is inert for a session double', () => {
    const session = newSession(plannedDoc());
    const close = openSteerOf(session);
    expect(session.pushSteer(note('x'))).toBe(true);
    expect(close()).toHaveLength(1);
    const double = { doc: session.doc } as never;
    expect(openSteerOf(double)()).toEqual([]);
  });
});

describe('recentCommits (the ring A3 reads)', () => {
  it('records every commit with its rev, origin and ops, oldest first, and filters by rev', () => {
    const session = newSession(createEmptyDoc('proj-ring'));
    const start = session.doc.rev;
    session.commit([{ op: 'brief', patch: { title: 'A' } }], { origin: 'user' });
    session.commit([{ op: 'brief', patch: { title: 'B' } }], { origin: 'director', label: 'Rename' });
    session.commit([{ op: 'brief', patch: { title: 'C' } }]);
    const all = session.recentCommits(start);
    expect(all.map((c) => c.rev)).toEqual([start + 1, start + 2, start + 3]);
    expect(all.map((c) => c.origin)).toEqual(['user', 'director', undefined]);
    expect(all[0].ops).toEqual([{ op: 'brief', patch: { title: 'A' } }]);
    expect(typeof all[0].at).toBe('number');
    expect(session.recentCommits(start + 2).map((c) => c.rev)).toEqual([start + 3]);
    expect(session.recentCommits(start + 3)).toEqual([]);
    expect(recentCommitsOf(session, start + 1).map((c) => c.origin)).toEqual(['director', undefined]);
  });

  it('a refused commit (409 LIMIT) and an empty one leave the ring unchanged', () => {
    const session = newSession(createEmptyDoc('proj-ring'));
    session.commit([]);
    expect(session.recentCommits(-1)).toEqual([]);
    const huge = 'x'.repeat(7_000_000);
    expect(() => session.commit([{ op: 'brief', patch: { logline: huge } }], { origin: 'user' })).toThrow(/too large/);
    expect(session.recentCommits(-1)).toEqual([]);
  });

  it('is bounded by count: the last RECENT_COMMITS_MAX commits stay, and the gap is reported', () => {
    const session = newSession(createEmptyDoc('proj-ring'));
    const start = session.doc.rev;
    for (let i = 0; i < RECENT_COMMITS_MAX + 5; i += 1) session.commit([{ op: 'brief', patch: { title: `t${i}` } }], { origin: 'user' });
    const kept = session.recentCommits(start);
    expect(kept).toHaveLength(RECENT_COMMITS_MAX);
    expect(kept[0].rev).toBe(start + 6);
    expect(kept.at(-1)!.rev).toBe(session.doc.rev);
    // A turn that started before the oldest kept commit cannot see everything; a later one can.
    expect(session.recentCommitsComplete(start)).toBe(false);
    expect(session.recentCommitsComplete(start + 5)).toBe(true);
    expect(session.recentCommitsComplete(session.doc.rev)).toBe(true);
  });

  it('is bounded by size: big commits push the oldest out, and the newest is always kept', () => {
    const session = newSession(createEmptyDoc('proj-ring'));
    const start = session.doc.rev;
    const big = 'y'.repeat(Math.ceil(RECENT_COMMITS_BYTES / 3));
    for (let i = 0; i < 4; i += 1) session.commit([{ op: 'brief', patch: { title: 'T', logline: `${i}${big}` } }], { origin: 'user' });
    const kept = session.recentCommits(start);
    expect(kept.length).toBeLessThan(4);
    expect(kept.at(-1)!.rev).toBe(session.doc.rev);
    expect(JSON.stringify(kept.map((c) => c.ops)).length).toBeLessThanOrEqual(RECENT_COMMITS_BYTES + 200);
    expect(session.recentCommitsComplete(start)).toBe(false);
    // One commit bigger than the whole bound is still kept (alone): the guard always sees the latest edit.
    session.commit([{ op: 'brief', patch: { logline: 'z'.repeat(RECENT_COMMITS_BYTES + 10) } }], { origin: 'user' });
    expect(session.recentCommits(start).map((c) => c.rev)).toEqual([session.doc.rev]);
  });

  it('a fresh session misses nothing after its load rev, and never claims commits from before it was loaded', () => {
    const session = newSession(plannedDoc());
    expect(session.recentCommitsComplete(session.doc.rev)).toBe(true);
    // The commit that made the loaded rev happened in an earlier session: unknown, so not complete.
    expect(session.recentCommitsComplete(session.doc.rev - 1)).toBe(false);
  });
});
