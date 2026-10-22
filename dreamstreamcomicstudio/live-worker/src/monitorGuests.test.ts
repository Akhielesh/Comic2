// @vitest-environment node
import initSqlJs, { type SqlJsStatic } from 'sql.js';
import { beforeAll, describe, expect, it } from 'vitest';
import { GuestAccess, LOCK_MS, MAX_FAILS_IN_A_ROW, MAX_FAILS_TOTAL, MAX_GUESTS, passcodeProblem, sameString } from './monitorGuests';

let SQL: SqlJsStatic;
beforeAll(async () => {
  SQL = await initSqlJs();
});

function sqlStorage() {
  const db = new SQL.Database();
  return {
    exec(q: string, ...b: unknown[]) {
      const st = db.prepare(q);
      try {
        st.bind(b.map((v) => (v === undefined ? null : v)) as never);
        const rows: Record<string, unknown>[] = [];
        while (st.step()) rows.push(st.getAsObject());
        return { toArray: () => rows };
      } finally {
        st.free();
      }
    },
    raw: db,
  };
}

const PASS = 'blue-otter-42';
/** Few PBKDF2 rounds keep the suite fast; production uses 100 000. */
const make = () => {
  const sql = sqlStorage();
  return { sql, g: new GuestAccess(sql, 1000) };
};

describe('passcodeProblem', () => {
  it('asks for something worth guessing', () => {
    expect(passcodeProblem('1234567')).toMatch(/8 characters/);
    expect(passcodeProblem('aaaaaaaaaa')).toMatch(/repeat/);
    expect(passcodeProblem('12345678')).toMatch(/too easy/);
    expect(passcodeProblem('password1')).toMatch(/too easy/);
    expect(passcodeProblem('abcdefghij')).toMatch(/too easy/);
    expect(passcodeProblem('lowercaseonly')).toBeNull(); // 12+ characters
    expect(passcodeProblem('shortone')).toMatch(/Mix letters/);
    expect(passcodeProblem('Aria2024!', ['Aria'])).toMatch(/baby/);
    expect(passcodeProblem(PASS, ['Aria', 'Nursery'])).toBeNull();
  });

  it('compares without an early exit', () => {
    expect(sameString('abc', 'abc')).toBe(true);
    expect(sameString('abc', 'abd')).toBe(false);
    expect(sameString('abc', 'abcd')).toBe(false);
  });
});

describe('GuestAccess', () => {
  it('stores no passcode or token in the clear', async () => {
    const { sql, g } = make();
    await g.createShare({ pass: PASS, role: 'viewer', days: 7, by: 'Mom' }, 1000);
    const share = g.activeShare(1000)!;
    const r = await g.join({ code: share.code, pass: PASS, name: 'Grandma Jo' }, 2000);
    expect(r.ok).toBe(true);
    const dump = JSON.stringify([sql.exec('SELECT * FROM mon_shares').toArray(), sql.exec('SELECT * FROM mon_guests').toArray()]);
    expect(dump).not.toContain(PASS);
    expect(dump).not.toContain((r as { token: string }).token);
  });

  it('lets a guest in with the link and passcode, then recognises their token', async () => {
    const { g } = make();
    const { share } = await g.createShare({ pass: PASS, role: 'caregiver', days: null, by: 'Mom' }, 1000);
    expect(share.code).toMatch(/^[A-Za-z0-9_-]{22}$/);
    const r = await g.join({ code: share.code, pass: PASS, name: '  Grandma <Jo>  ', dev: 'ipad' }, 2000);
    if (!r.ok) throw new Error(r.reason);
    expect(r.guest.name).toBe('Grandma Jo');
    expect(r.guest.role).toBe('caregiver');
    const v = await g.verify(r.token, 3000);
    expect(v?.id).toBe(r.guest.id);
    expect(v?.last_seen).toBe(3000);
    expect(await g.verify('nope', 3000)).toBeNull();
    expect(g.info(3000).guests.map((x) => x.name)).toEqual(['Grandma Jo']);
  });

  it('rejects a wrong link without revealing anything, and a wrong passcode with tries left', async () => {
    const { g } = make();
    const { share } = await g.createShare({ pass: PASS, role: 'viewer', days: 1, by: 'Mom' }, 1000);
    expect(await g.join({ code: 'x'.repeat(22), pass: PASS, name: 'A' }, 2000)).toEqual({ ok: false, reason: 'bad_link' });
    const w = await g.join({ code: share.code, pass: 'wrong-guess-1', name: 'A' }, 2000);
    expect(w).toEqual({ ok: false, reason: 'wrong', left: MAX_FAILS_IN_A_ROW - 1 });
    expect(await g.join({ code: share.code, pass: PASS, name: '' }, 2000)).toEqual({ ok: false, reason: 'name' });
  });

  it('locks the link after 5 wrong passcodes in a row, then lets the right one in after the lock', async () => {
    const { g } = make();
    const { share } = await g.createShare({ pass: PASS, role: 'viewer', days: null, by: 'Mom' }, 0);
    let last;
    for (let i = 0; i < MAX_FAILS_IN_A_ROW; i++) last = await g.join({ code: share.code, pass: `guess-${i}-xx`, name: 'X' }, 1000 + i);
    expect(last).toMatchObject({ ok: false, reason: 'locked' });
    // Even the right passcode waits out the lock.
    expect(await g.join({ code: share.code, pass: PASS, name: 'Jo' }, 2000)).toMatchObject({ ok: false, reason: 'locked' });
    expect(g.info(2000).locked_until).toBeGreaterThan(2000);
    expect((await g.join({ code: share.code, pass: PASS, name: 'Jo' }, 1000 + LOCK_MS + 10)).ok).toBe(true);
  });

  it('turns the link off after 20 wrong passcodes, signing everyone out', async () => {
    const { g } = make();
    const { share } = await g.createShare({ pass: PASS, role: 'viewer', days: null, by: 'Mom' }, 0);
    const ok = await g.join({ code: share.code, pass: PASS, name: 'Jo' }, 1);
    if (!ok.ok) throw new Error('join');
    let t = 10;
    let res;
    for (let i = 0; i < MAX_FAILS_TOTAL; i++) {
      res = await g.join({ code: share.code, pass: `guess-${i}-xx`, name: 'X' }, t);
      t += LOCK_MS + 1; // wait out each lock
    }
    expect(res).toEqual({ ok: false, reason: 'off', disabled: true });
    expect(g.activeShare(t)).toBeNull();
    expect(await g.verify(ok.token, t)).toBeNull();
    expect(await g.join({ code: share.code, pass: PASS, name: 'Jo' }, t)).toEqual({ ok: false, reason: 'off' });
  });

  it('a new link signs out the old one’s guests; removing one guest leaves the others', async () => {
    const { g } = make();
    const a = await g.createShare({ pass: PASS, role: 'viewer', days: null, by: 'Mom' }, 0);
    const jo = await g.join({ code: a.share.code, pass: PASS, name: 'Jo' }, 1);
    const sam = await g.join({ code: a.share.code, pass: PASS, name: 'Sam' }, 2);
    if (!jo.ok || !sam.ok) throw new Error('join');
    expect(g.removeGuest(jo.guest.id, 3)).toBe(true);
    expect(await g.verify(jo.token, 4)).toBeNull();
    expect(await g.verify(sam.token, 4)).not.toBeNull();
    const b = await g.createShare({ pass: 'another-pass-9', role: 'viewer', days: null, by: 'Mom' }, 5);
    expect(b.removed).toEqual([sam.guest.id]);
    expect(await g.verify(sam.token, 6)).toBeNull();
    expect(await g.join({ code: a.share.code, pass: PASS, name: 'Jo' }, 7)).toEqual({ ok: false, reason: 'off' });
  });

  it('expires with the link, and caps how many guests one link admits', async () => {
    const { g } = make();
    const day = 24 * 60 * 60_000;
    const { share } = await g.createShare({ pass: PASS, role: 'viewer', days: 1, by: 'Mom' }, 0);
    const toks: string[] = [];
    for (let i = 0; i < MAX_GUESTS; i++) {
      const r = await g.join({ code: share.code, pass: PASS, name: `G${i}` }, 10 + i);
      if (!r.ok) throw new Error(r.reason);
      toks.push(r.token);
    }
    expect(await g.join({ code: share.code, pass: PASS, name: 'One more' }, 100)).toEqual({ ok: false, reason: 'full' });
    expect(await g.verify(toks[0], day + 1)).toBeNull();
    expect(await g.join({ code: share.code, pass: PASS, name: 'Late' }, day + 1)).toEqual({ ok: false, reason: 'expired' });
    expect(g.info(day + 1).on).toBe(false);
  });

  it('slows down one address hammering the endpoint', async () => {
    const { g } = make();
    const { share } = await g.createShare({ pass: PASS, role: 'viewer', days: null, by: 'Mom' }, 0);
    let r;
    for (let i = 0; i < 13; i++) r = await g.join({ code: 'y'.repeat(22), pass: 'x', name: 'X', ip: '1.2.3.4' }, 100 + i);
    expect(r).toMatchObject({ ok: false, reason: 'slow_down' });
    // Another address is unaffected.
    expect((await g.join({ code: share.code, pass: PASS, name: 'Jo', ip: '5.6.7.8' }, 200)).ok).toBe(true);
  });

  it('tells parents how many guests a link admits', async () => {
    const { g } = make();
    expect(g.info(0)).toMatchObject({ on: false, max_guests: MAX_GUESTS, guests: [], requests: [], pass_at: null });
    await g.createShare({ pass: PASS, role: 'viewer', days: 7, by: 'Mom' }, 100);
    expect(g.info(200)).toMatchObject({ on: true, max_guests: MAX_GUESTS, pass_at: 100 });
  });
});

describe('GuestAccess: a new passcode on the same link', () => {
  const NEW = 'cedar-heron-otter-17';

  it('keeps the link and its guests; only the new passcode works', async () => {
    const { sql, g } = make();
    const { share } = await g.createShare({ pass: PASS, role: 'viewer', days: 7, by: 'Mom' }, 0);
    const jo = await g.join({ code: share.code, pass: PASS, name: 'Jo' }, 10);
    if (!jo.ok) throw new Error(jo.reason);
    expect(await g.setPasscode(NEW, false, 100)).toEqual({ removed: [] });
    const after = g.info(100);
    expect(after.code).toBe(share.code);
    expect(after.pass_at).toBe(100);
    expect(await g.verify(jo.token, 110)).not.toBeNull();
    expect(await g.join({ code: share.code, pass: PASS, name: 'Sam' }, 120)).toMatchObject({ ok: false, reason: 'wrong' });
    expect((await g.join({ code: share.code, pass: NEW, name: 'Sam' }, 130)).ok).toBe(true);
    expect(JSON.stringify(sql.exec('SELECT * FROM mon_shares').toArray())).not.toContain(NEW);
  });

  it('can sign the current guests out, and clears a lock', async () => {
    const { g } = make();
    const { share } = await g.createShare({ pass: PASS, role: 'viewer', days: null, by: 'Mom' }, 0);
    const jo = await g.join({ code: share.code, pass: PASS, name: 'Jo' }, 1);
    if (!jo.ok) throw new Error(jo.reason);
    for (let i = 0; i < MAX_FAILS_IN_A_ROW; i++) await g.join({ code: share.code, pass: `guess-${i}-xx`, name: 'X' }, 10 + i);
    expect(g.info(20).locked_until).toBeGreaterThan(20);
    expect(await g.setPasscode(NEW, true, 30)).toEqual({ removed: [jo.guest.id] });
    expect(g.info(30).locked_until).toBeNull();
    expect(await g.verify(jo.token, 31)).toBeNull();
    expect((await g.join({ code: share.code, pass: NEW, name: 'Jo' }, 32)).ok).toBe(true);
  });

  it('does nothing without a link', async () => {
    const { g } = make();
    expect(await g.setPasscode(NEW, false, 0)).toBeNull();
  });
});

describe('GuestAccess: extending the link', () => {
  const day = 24 * 60 * 60_000;

  it('moves the link’s end and the guests’ passes with it', async () => {
    const { g } = make();
    const { share } = await g.createShare({ pass: PASS, role: 'viewer', days: 1, by: 'Mom' }, 0);
    const jo = await g.join({ code: share.code, pass: PASS, name: 'Jo' }, 1000);
    if (!jo.ok) throw new Error(jo.reason);
    expect(jo.guest.expires_at).toBe(day);
    expect(g.extend(7, day / 2)?.expires_at).toBe(8 * day);
    expect(g.info(day / 2).guests[0].expires_at).toBe(8 * day);
    // Still watching after the original day.
    expect(await g.verify(jo.token, 2 * day)).not.toBeNull();
    expect((await g.join({ code: share.code, pass: PASS, name: 'Sam' }, 2 * day)).ok).toBe(true);
  });

  it('never lets a pass run past 90 days from the join', async () => {
    const { g } = make();
    const { share } = await g.createShare({ pass: PASS, role: 'viewer', days: 30, by: 'Mom' }, 0);
    const jo = await g.join({ code: share.code, pass: PASS, name: 'Jo' }, 0);
    if (!jo.ok) throw new Error(jo.reason);
    g.extend(30, 25 * day);
    g.extend(30, 50 * day);
    g.extend(30, 80 * day);
    const info = g.info(80 * day);
    // Each extension adds to the link's current end: 30 → 60 → 90 → 120 days.
    expect(info.expires_at).toBe(120 * day);
    expect(info.guests[0].expires_at).toBe(90 * day);
    // "Until I turn it off" keeps the 90-day cap on passes too.
    expect(g.extend(null, 81 * day)?.expires_at).toBeNull();
    expect(g.info(81 * day).guests[0].expires_at).toBe(90 * day);
    expect(await g.verify(jo.token, 90 * day + 1)).toBeNull();
  });

  it('does nothing without a link', () => {
    const { g } = make();
    expect(g.extend(7, 0)).toBeNull();
  });
});

describe('GuestAccess: guests who have an account', () => {
  it('lists them for parents until made a member, kept a guest, or removed', async () => {
    const { g } = make();
    const { share } = await g.createShare({ pass: PASS, role: 'caregiver', days: null, by: 'Mom' }, 0);
    const sam = await g.join({ code: share.code, pass: PASS, name: 'Sam' }, 1);
    const jo = await g.join({ code: share.code, pass: PASS, name: 'Jo' }, 2);
    if (!sam.ok || !jo.ok) throw new Error('join');
    g.addRequest({ uid: 'u-sam', account: 'Sam Smith', name: 'Sam', guest_id: sam.guest.id }, 3);
    const r = g.addRequest({ uid: 'u-jo', account: 'Jo Lee', name: 'Jo', guest_id: jo.guest.id }, 4);
    expect(g.info(5).requests).toEqual([
      expect.objectContaining({ uid: 'u-sam', account: 'Sam Smith', name: 'Sam', role: 'caregiver' }),
      expect.objectContaining({ uid: 'u-jo', account: 'Jo Lee', name: 'Jo' }),
    ]);
    // Supabase now lists Sam as a member.
    expect(g.resolveRequests(new Set(['u-parent', 'u-sam']), 6).map((x) => x.guest_id)).toEqual([sam.guest.id]);
    expect(g.info(7).requests.map((x) => x.uid)).toEqual(['u-jo']);
    expect(g.dismissRequest(r.id, 8)).toBe(true);
    expect(g.dismissRequest(r.id, 9)).toBe(false);
    expect(g.info(10).requests).toEqual([]);
  });

  it('keeps one open request per person, and drops it with the guest', async () => {
    const { g } = make();
    const { share } = await g.createShare({ pass: PASS, role: 'viewer', days: null, by: 'Mom' }, 0);
    const a = await g.join({ code: share.code, pass: PASS, name: 'Sam' }, 1);
    const b = await g.join({ code: share.code, pass: PASS, name: 'Sam (tablet)' }, 2);
    if (!a.ok || !b.ok) throw new Error('join');
    g.addRequest({ uid: 'u-sam', account: 'Sam', name: 'Sam', guest_id: a.guest.id }, 3);
    g.addRequest({ uid: 'u-sam', account: 'Sam', name: 'Sam (tablet)', guest_id: b.guest.id }, 4);
    expect(g.info(5).requests.map((x) => x.guest_id)).toEqual([b.guest.id]);
    g.removeGuest(b.guest.id, 6);
    expect(g.info(7).requests).toEqual([]);
  });
});

describe('GuestAccess storage upgrade', () => {
  it('adds the passcode-change column to a room made before it', async () => {
    const sql = sqlStorage();
    // The first release's table, with a link in it.
    sql.exec(`CREATE TABLE mon_shares (
      id TEXT PRIMARY KEY, code TEXT NOT NULL, pass_hash TEXT NOT NULL, salt TEXT NOT NULL, rounds INTEGER NOT NULL,
      role TEXT NOT NULL, created_at INTEGER NOT NULL, created_by TEXT NOT NULL, expires_at INTEGER, revoked_at INTEGER,
      fails INTEGER NOT NULL DEFAULT 0, total_fails INTEGER NOT NULL DEFAULT 0, locked_until INTEGER NOT NULL DEFAULT 0)`);
    sql.exec('INSERT INTO mon_shares VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)', 's1', 'c'.repeat(22), 'h', 'salt', 1000, 'viewer', 50, 'Mom', null, null, 0, 0, 0);
    const g = new GuestAccess(sql, 1000);
    expect(g.info(100)).toMatchObject({ on: true, pass_at: 50 });
    // Opening the room again is harmless.
    expect(() => new GuestAccess(sql, 1000)).not.toThrow();
    await g.setPasscode('cedar-heron-otter-17', false, 200);
    expect(g.info(300).pass_at).toBe(200);
  });
});
