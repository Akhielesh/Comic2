// @vitest-environment node
import initSqlJs, { type SqlJsStatic } from 'sql.js';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  GUEST_CAPS,
  GuestAccess,
  LINK_LOCK_MS,
  LOCK_MS,
  MAX_FAILS_IN_A_ROW,
  MAX_FAILS_TOTAL,
  MAX_GUESTS,
  generatePasscode,
  guestAckEnds,
  guestCan,
  guestCanBits,
  guestCaps,
  passcodeProblem,
  sameString,
  type RateLimiterLike,
} from './monitorGuests';

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
    expect(g.removeGuest(jo.guest.id, 3)).toMatchObject({ id: jo.guest.id, name: 'Jo', newLink: { pass: null } });
    expect(g.removeGuest(jo.guest.id, 3)).toBeNull();
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

  it('a pass is only issued on the link exactly as it was checked (the room may wait on Supabase in between)', async () => {
    const { sql, g } = make();
    const guests = () => Number(sql.exec('SELECT COUNT(*) AS n FROM mon_guests').toArray()[0].n);
    const checked = async (now: number) => {
      const c = await g.check({ code: g.activeShare(now)!.code, pass: PASS, name: 'Uncle Sam' }, now);
      if (!c.ok) throw new Error(c.reason);
      return c;
    };
    const { share } = await g.createShare({ pass: PASS, role: 'viewer', days: 1, by: 'Mom' }, 0);

    // A new passcode meanwhile ("sign out guests" or not): the old one gets nobody in.
    let c = await checked(10);
    await g.setPasscode(NEW, true, 20);
    expect(await g.issue(c, { name: c.name }, 30)).toEqual({ ok: false, reason: 'wrong' });
    c = await g.check({ code: share.code, pass: NEW, name: 'Uncle Sam' }, 40).then((r) => (r.ok ? r : Promise.reject(new Error(r.reason))));
    await g.setPasscode(PASS, false, 50);
    expect(await g.issue(c, { name: c.name }, 60)).toEqual({ ok: false, reason: 'wrong' });
    expect(guests()).toBe(0);

    // Turned off, or replaced by a new link, meanwhile.
    c = await checked(70);
    g.revokeShare(80);
    expect(await g.issue(c, { name: c.name }, 90)).toEqual({ ok: false, reason: 'off' });
    await g.createShare({ pass: PASS, role: 'caregiver', days: 1, by: 'Mom' }, 100);
    c = await checked(110);
    await g.createShare({ pass: PASS, role: 'caregiver', days: 1, by: 'Mom' }, 120);
    expect(await g.issue(c, { name: c.name }, 130)).toEqual({ ok: false, reason: 'off' });
    // Ended meanwhile.
    c = await checked(140);
    expect(await g.issue(c, { name: c.name }, 120 + 24 * 3600_000)).toEqual({ ok: false, reason: 'expired' });
    expect(guests()).toBe(0);

    // Nothing changed: in, with the link as it is now (an extension made meanwhile counts).
    c = await checked(150);
    g.extend(7, 160);
    const r = await g.issue(c, { name: c.name }, 170);
    if (!r.ok) throw new Error(r.reason);
    expect(r.guest.expires_at).toBe(120 + 8 * 24 * 3600_000);
    expect(await g.verify(r.token, 180)).not.toBeNull();
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

describe('GuestAccess: removing a guest changes the link (ADR 0006 F3)', () => {
  const NEW = 'cedar-heron-otter-17';

  it('the removed guest can’t rejoin with the link and passcode they have; everyone else keeps watching', async () => {
    const { g } = make();
    const { share } = await g.createShare({ pass: PASS, role: 'caregiver', days: 7, by: 'Mom' }, 0);
    const jo = await g.join({ code: share.code, pass: PASS, name: 'Jo' }, 1);
    const sam = await g.join({ code: share.code, pass: PASS, name: 'Sam' }, 2);
    if (!jo.ok || !sam.ok) throw new Error('join');
    g.addRequest({ uid: 'u-sam', account: 'Sam', name: 'Sam', guest_id: sam.guest.id }, 3);

    const r = g.removeGuest(jo.guest.id, 10);
    expect(r).toMatchObject({ id: jo.guest.id, name: 'Jo', newLink: { pass: null } });
    const info = g.info(11);
    expect(r!.newLink.code).toBe(info.code);
    expect(info.code).not.toBe(share.code);
    expect(info.code).toMatch(/^[A-Za-z0-9_-]{22}$/);
    // Same link otherwise: role, end date, passcode date, the other guest and their request.
    expect(info).toMatchObject({ on: true, role: 'caregiver', expires_at: share.expires_at, pass_at: 0 });
    expect(info.guests.map((x) => x.name)).toEqual(['Sam']);
    expect(info.requests.map((x) => x.uid)).toEqual(['u-sam']);
    expect(await g.verify(sam.token, 12)).not.toBeNull();
    expect(await g.verify(jo.token, 12)).toBeNull();

    // The old link is dead — for the removed guest and anyone they pass it to.
    expect(await g.join({ code: share.code, pass: PASS, name: 'Jo again' }, 13)).toEqual({ ok: false, reason: 'off' });
    // The parent's new link works with the passcode family already knows.
    expect((await g.join({ code: info.code!, pass: PASS, name: 'Grandpa' }, 14)).ok).toBe(true);
    // Turning the link off still signs everyone out, moved passes included.
    const out = g.revokeShare(20);
    expect(out).toHaveLength(2);
    expect(out).toContain(sam.guest.id);
    expect(await g.verify(sam.token, 21)).toBeNull();
  });

  it('can change the passcode too, with one made up for the parent to share', async () => {
    const { sql, g } = make();
    const { share } = await g.createShare({ pass: PASS, role: 'viewer', days: null, by: 'Mom' }, 0);
    const jo = await g.join({ code: share.code, pass: PASS, name: 'Jo' }, 1);
    const sam = await g.join({ code: share.code, pass: PASS, name: 'Sam' }, 2);
    if (!jo.ok || !sam.ok) throw new Error('join');
    const prep = await g.preparePasscode('auto', ['Aria', 'Maple room']);
    expect(passcodeProblem(prep.pass, ['Aria'])).toBeNull();
    expect(prep.pass).not.toMatch(/maple/);
    const r = g.removeGuest(jo.guest.id, 10, { pass: prep });
    expect(r!.newLink.pass).toBe(prep.pass);
    const code = g.info(11).code!;
    expect(g.info(11).pass_at).toBe(10);
    expect(await g.join({ code, pass: PASS, name: 'Jo' }, 12)).toMatchObject({ ok: false, reason: 'wrong' });
    expect((await g.join({ code, pass: prep.pass, name: 'Grandpa' }, 13)).ok).toBe(true);
    expect(await g.verify(sam.token, 14)).not.toBeNull();
    expect(JSON.stringify(sql.exec('SELECT * FROM mon_shares').toArray())).not.toContain(prep.pass);
    // A passcode the parent chose works the same way.
    const own = await g.preparePasscode(NEW);
    g.removeGuest(sam.guest.id, 20, { pass: own });
    expect((await g.join({ code: g.info(21).code!, pass: NEW, name: 'Kim' }, 22)).ok).toBe(true);
  });

  it('a join checked against the old link before a removal isn’t issued after it', async () => {
    const { g } = make();
    const { share } = await g.createShare({ pass: PASS, role: 'viewer', days: null, by: 'Mom' }, 0);
    const jo = await g.join({ code: share.code, pass: PASS, name: 'Jo' }, 1);
    if (!jo.ok) throw new Error('join');
    const c = await g.check({ code: share.code, pass: PASS, name: 'Jo again' }, 5);
    if (!c.ok) throw new Error(c.reason);
    g.removeGuest(jo.guest.id, 6);
    expect(await g.issue(c, { name: c.name }, 7)).toEqual({ ok: false, reason: 'off' });
  });

  it('nothing to rotate without a link', () => {
    const { g } = make();
    expect(g.rotateLink(0)).toBeNull();
    expect(g.removeGuest('nobody', 0)).toBeNull();
  });
});

describe('generatePasscode', () => {
  it('reads aloud, passes the passcode rules, avoids the baby’s name, and doesn’t repeat', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const p = generatePasscode(['Willow', 'Willow’s room']);
      expect(p).toMatch(/^[a-z]+-[a-z]+-[a-z]+-[a-z]+-\d{2}$/);
      expect(p).not.toContain('willow');
      expect(passcodeProblem(p, ['Willow'])).toBeNull();
      expect(new Set(p.split('-').slice(0, 4)).size).toBe(4);
      seen.add(p);
    }
    expect(seen.size).toBe(200);
  });
});

describe('guestCaps (least privilege)', () => {
  it('viewer guests watch, listen and get live alerts — nothing else', () => {
    expect([...guestCaps('viewer')]).toEqual(['live', 'listen', 'alerts']);
    for (const cap of ['talk', 'soothe', 'ack', 'log', 'history', 'tracker', 'reports'] as const) expect(guestCan('viewer', cap)).toBe(false);
  });

  it('caregiver guests can also talk, soothe, answer and log — but never see history or reports', () => {
    expect(GUEST_CAPS.caregiver).toEqual(['live', 'listen', 'alerts', 'talk', 'soothe', 'ack', 'log']);
    expect(guestCan('caregiver', 'history')).toBe(false);
    expect(guestCan('caregiver', 'reports')).toBe(false);
  });

  it('a guest’s “I’m on it” never ends a hazard that pages everyone', () => {
    expect(guestAckEnds('caregiver', 'duty')).toBe(true);
    expect(guestAckEnds('caregiver', 'everyone')).toBe(false);
    expect(guestAckEnds('viewer', 'duty')).toBe(false);
  });

  it('maps to the Glance `can` bits (no peek, no duty for guests)', () => {
    expect(guestCanBits('viewer')).toBe(4);
    expect(guestCanBits('caregiver')).toBe(1 | 2 | 4 | 8 | 64);
  });
});

describe('GuestAccess: per-guest lockout (ADR 0006 D6.2)', () => {
  const makeGuest = (limits?: ConstructorParameters<typeof GuestAccess>[1]) => {
    const sql = sqlStorage();
    return { sql, g: new GuestAccess(sql, { rounds: 1000, lockout: 'guest', ...(typeof limits === 'object' ? limits : {}) }) };
  };

  it('five wrong passcodes lock that joiner, not the link: family elsewhere still gets in', async () => {
    const { sql, g } = makeGuest();
    const { share } = await g.createShare({ pass: PASS, role: 'viewer', days: null, by: 'Mom' }, 0);
    let r;
    for (let i = 0; i < MAX_FAILS_IN_A_ROW; i++) r = await g.join({ code: share.code, pass: `guess-${i}-xx`, name: 'X', ip: '6.6.6.6' }, 10 + i);
    expect(r).toEqual({ ok: false, reason: 'locked', retryAt: 14 + LOCK_MS, scope: 'guest' });
    expect(await g.join({ code: share.code, pass: PASS, name: 'X', ip: '6.6.6.6' }, 20)).toEqual({ ok: false, reason: 'locked', retryAt: 14 + LOCK_MS, scope: 'guest' });
    expect((await g.join({ code: share.code, pass: PASS, name: 'Grandma', ip: '1.1.1.1' }, 21)).ok).toBe(true);
    expect(g.info(22)).toMatchObject({ lockout: 'guest', locked_out: 1, locked_until: null });
    // The lock lapses; a right passcode then clears their count.
    expect((await g.join({ code: share.code, pass: PASS, name: 'X', ip: '6.6.6.6' }, 15 + LOCK_MS)).ok).toBe(true);
    // No addresses are kept.
    expect(JSON.stringify(sql.exec('SELECT * FROM mon_guest_tries').toArray())).not.toContain('6.6.6.6');
  });

  it('wrong guesses from many addresses lock the link for an hour — never off, never signing anyone out', async () => {
    const { g } = makeGuest();
    const { share } = await g.createShare({ pass: PASS, role: 'viewer', days: null, by: 'Mom' }, 0);
    const jo = await g.join({ code: share.code, pass: PASS, name: 'Jo', ip: '1.1.1.1' }, 1);
    if (!jo.ok) throw new Error('join');
    let r;
    for (let i = 0; i < MAX_FAILS_TOTAL; i++) r = await g.join({ code: share.code, pass: `guess-${i}-xx`, name: 'X', ip: `10.0.${i}.1` }, 10 + i);
    expect(r).toEqual({ ok: false, reason: 'locked', retryAt: 29 + LINK_LOCK_MS, scope: 'link' });
    expect(await g.join({ code: share.code, pass: PASS, name: 'Sam', ip: '2.2.2.2' }, 40)).toMatchObject({ ok: false, reason: 'locked', scope: 'link' });
    expect(g.activeShare(40)).not.toBeNull();
    expect(await g.verify(jo.token, 41)).not.toBeNull();
    expect((await g.join({ code: share.code, pass: PASS, name: 'Sam', ip: '2.2.2.2' }, 30 + LINK_LOCK_MS)).ok).toBe(true);
  });

  it('without an address, falls back to the device id, then to one shared count', async () => {
    const { g } = makeGuest();
    const { share } = await g.createShare({ pass: PASS, role: 'viewer', days: null, by: 'Mom' }, 0);
    for (let i = 0; i < MAX_FAILS_IN_A_ROW; i++) await g.join({ code: share.code, pass: `guess-${i}-xx`, name: 'X', dev: 'tab-1' }, 10 + i);
    expect(await g.join({ code: share.code, pass: PASS, name: 'X', dev: 'tab-1' }, 20)).toMatchObject({ reason: 'locked', scope: 'guest' });
    expect((await g.join({ code: share.code, pass: PASS, name: 'Y', dev: 'tab-2' }, 21)).ok).toBe(true);
  });

  it('old counts are swept', async () => {
    const { sql, g } = makeGuest();
    const { share } = await g.createShare({ pass: PASS, role: 'viewer', days: null, by: 'Mom' }, 0);
    await g.join({ code: share.code, pass: 'guess-0-xx', name: 'X', ip: '6.6.6.6' }, 10);
    g.purge(10 + 2 * 24 * 3600_000);
    expect(sql.exec('SELECT COUNT(*) AS n FROM mon_guest_tries').toArray()[0].n).toBe(0);
  });
});

describe('GuestAccess: rate-limit hook', () => {
  const limiter = (allow: (key: string) => boolean): RateLimiterLike & { keys: string[] } => {
    const keys: string[] = [];
    return { keys, limit: async ({ key }) => (keys.push(key), { success: allow(key) }) };
  };

  it('asks the address and nursery limiters before any passcode work', async () => {
    const sql = sqlStorage();
    const perAddress = limiter((k) => k !== 'ip:9.9.9.9');
    const perNursery = limiter(() => true);
    const g = new GuestAccess(sql, { rounds: 1000, limits: { perAddress, perNursery, nursery: 'n-1' } });
    const { share } = await g.createShare({ pass: PASS, role: 'viewer', days: null, by: 'Mom' }, 0);
    expect(await g.join({ code: share.code, pass: PASS, name: 'X', ip: '9.9.9.9' }, 1000)).toEqual({ ok: false, reason: 'slow_down', retryAt: 61_000 });
    expect((await g.join({ code: share.code, pass: PASS, name: 'Jo', ip: '1.1.1.1' }, 2000)).ok).toBe(true);
    expect(perAddress.keys).toEqual(['ip:9.9.9.9', 'ip:1.1.1.1']);
    expect(perNursery.keys).toEqual(['n:n-1', 'n:n-1']);
    // A refused attempt never reached the passcode counts.
    expect(g.activeShare(3000)!.total_fails).toBe(0);
  });

  it('a limiter that fails is ignored (the lockouts still stand)', async () => {
    const sql = sqlStorage();
    const g = new GuestAccess(sql, 1000);
    g.setLimits({ perAddress: { limit: async () => Promise.reject(new Error('binding down')) } });
    const { share } = await g.createShare({ pass: PASS, role: 'viewer', days: null, by: 'Mom' }, 0);
    expect((await g.join({ code: share.code, pass: PASS, name: 'Jo', ip: '1.1.1.1' }, 1)).ok).toBe(true);
  });
});
