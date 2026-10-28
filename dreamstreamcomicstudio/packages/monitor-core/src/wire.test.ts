// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { CAN, ROLE_CAN, GUEST_CAN, glanceCan } from './glance';
import {
  ACT_ACTIONS,
  ACT_NEEDS,
  actAllowed,
  CAPS,
  CLOSE,
  CLOSE_ADVICE,
  closeFor,
  closeKind,
  hasCap,
  isSealedRtc,
  parseActRequest,
  parseCaps,
  parseDevHello,
  parseKeyInit,
  parseKeyRotate,
  parseKeyWrap,
  parseMembersRequest,
  parseReauth,
  parseView,
  ROUTES,
  rtcPolicy,
  type CloseKind,
} from './wire';

const UUID = '0b6a3c1e-8f2d-4a7b-9c11-2e3f4a5b6c7d';
const DEV = 'AbCdEfGhIjKlMnOpQrStUv';
const POINT = 'B' + 'A'.repeat(86);

describe('capabilities', () => {
  it('keeps the known ones, once, and ignores the rest', () => {
    expect(parseCaps(['view', 'reauth', 'view', 'teleport', 7])).toEqual(['view', 'reauth']);
    expect(parseCaps('view')).toEqual([]);
    expect(hasCap(['view'], 'view')).toBe(true);
    expect(hasCap(undefined, 'view')).toBe(false);
    expect(CAPS).toEqual(['reauth', 'view', 'eid', 'e2e1', 'glance1', 'stats5']);
  });
});

describe('close codes', () => {
  it('tells shared codes apart by reason, matching what the rooms send today', () => {
    // What MonitorRoom / CallRoom / UserLine already close with (monitorRoom.ts reject()/retire()).
    expect(closeKind(4001, 'auth')).toBe('auth');
    expect(closeKind(4001, 'auth timeout')).toBe('auth');
    expect(closeKind(4003, 'full')).toBe('full');
    expect(closeKind(4003, 'forbidden')).toBe('forbidden');
    expect(closeKind(4004, 'removed')).toBe('removed');
    expect(closeKind(4005, 'replaced')).toBe('replaced');
    expect(closeKind(4006, 'ended')).toBe('ended');
    expect(closeKind(4007, 'promoted')).toBe('promoted');
    expect(closeKind(4008, 'stale')).toBe('stale');
    expect(closeKind(4009, 'recheck')).toBe('recheck');
    // Phase 0 additions.
    expect(closeKind(4001, 'expired')).toBe('expired');
    expect(closeKind(4003, 'mfa_required')).toBe('mfa_required');
    expect(closeKind(4004, 'revoked')).toBe('revoked');
    expect(closeKind(4008, 'rate_limited')).toBe('rate_limited');
    expect(closeKind(1006, '')).toBe('other');
  });

  it('a role refusal is "forbidden" whatever its code: never "removed", which forgets the nursery', () => {
    // MonitorRoom.reject closes every refusal but auth and full with 4004: a viewer opening
    // camera mode, a guest trying it, a caregiver demoted to viewer while running the camera.
    expect(closeKind(4004, 'forbidden')).toBe('forbidden');
    expect(closeKind(4004, 'Forbidden')).toBe('forbidden');
    expect(CLOSE_ADVICE[closeKind(4004, 'forbidden')]).toBe('stop');
    // 4004 still means removed or revoked when it says so (or says nothing).
    expect(closeKind(4004, 'removed')).toBe('removed');
    expect(closeKind(4004, 'revoked')).toBe('revoked');
    expect(closeKind(4004, '')).toBe('removed');
    // A reason only counts on a room's own codes.
    expect(closeKind(1008, 'forbidden')).toBe('other');
  });

  it('round-trips every kind and advises each one', () => {
    const kinds = Object.keys(CLOSE_ADVICE).filter((k) => k !== 'other') as Exclude<CloseKind, 'other'>[];
    for (const k of kinds) {
      const { code, reason } = closeFor(k);
      expect(closeKind(code, reason)).toBe(k);
      expect(Object.values(CLOSE)).toContain(code);
    }
    expect(CLOSE_ADVICE.mfa_required).toBe('step_up');
    expect(CLOSE_ADVICE.removed).toBe('stop');
    expect(CLOSE_ADVICE.expired).toBe('refresh');
    expect(CLOSE_ADVICE.rate_limited).toBe('backoff');
  });
});

describe('act', () => {
  it('accepts a well-formed request and normalises the id', () => {
    expect(parseActRequest({ a: 'ack', inc: 'i9', id: UUID.toUpperCase() })).toEqual({ a: 'ack', inc: 'i9', id: UUID });
    expect(parseActRequest({ a: 'ack', id: UUID })).toEqual({ a: 'ack', id: UUID });
    expect(parseActRequest({ a: 'duty_on', v: 12, id: UUID })).toEqual({ a: 'duty_on', v: 12, id: UUID });
    expect(parseActRequest({ a: 'soothe', v: { sound: 'rain', min: 30 }, id: UUID })?.v).toEqual({ sound: 'rain', min: 30 });
  });

  it('refuses what it cannot make idempotent or bound', () => {
    expect(parseActRequest({ a: 'ack', inc: 'i9' })).toBeNull(); // no id
    expect(parseActRequest({ a: 'ack', id: 'not-a-uuid' })).toBeNull();
    expect(parseActRequest({ a: 'nuke', id: UUID })).toBeNull();
    expect(parseActRequest({ a: 'resolve', id: UUID })).toBeNull(); // all clear must name the incident
    expect(parseActRequest({ a: 'ack', inc: 'x'.repeat(41), id: UUID })).toBeNull();
    expect(parseActRequest({ a: 'ack', inc: 'a b', id: UUID })).toBeNull();
    expect(parseActRequest({ a: 'duty_on', v: 48, id: UUID })).toBeNull();
    expect(parseActRequest({ a: 'soothe', v: 'x'.repeat(300), id: UUID })).toBeNull();
    expect(parseActRequest([])).toBeNull();
    expect(parseActRequest(null)).toBeNull();
  });

  it('gates every action by the same bit the glance shows', () => {
    for (const a of ACT_ACTIONS) expect(ACT_NEEDS[a]).toBeGreaterThan(0);
    const viewer = glanceCan({ role: 'viewer' });
    const careGuest = glanceCan({ role: 'caregiver', guest: true });
    for (const a of ACT_ACTIONS) {
      expect(actAllowed(viewer, a)).toBe(false);
      expect(actAllowed(ROLE_CAN.caregiver, a)).toBe(true);
    }
    expect(actAllowed(careGuest, 'ack')).toBe(true);
    expect(actAllowed(careGuest, 'soothe')).toBe(true);
    expect(actAllowed(careGuest, 'duty_on')).toBe(false);
    expect(GUEST_CAN.caregiver & CAN.duty).toBe(0);
  });
});

describe('members, re-auth, view', () => {
  it('members: an add or role change names the role; remove does not need one', () => {
    expect(parseMembersRequest({ op: 'remove', user: UUID })).toEqual({ op: 'remove', user: UUID });
    expect(parseMembersRequest({ op: 'add', user: UUID, role: 'caregiver', label: 'Nanny' })).toEqual({ op: 'add', user: UUID, role: 'caregiver', label: 'Nanny' });
    expect(parseMembersRequest({ op: 'add', user: UUID })).toBeNull();
    expect(parseMembersRequest({ op: 'role', user: UUID, role: 'owner' })).toBeNull();
    expect(parseMembersRequest({ op: 'remove', user: 'bob' })).toBeNull();
  });

  it('reauth and view', () => {
    expect(parseReauth({ t: 'reauth', token: 'ey.x.y' })).toEqual({ t: 'reauth', token: 'ey.x.y' });
    expect(parseReauth({ t: 'reauth', token: '' })).toBeNull();
    expect(parseReauth({ t: 'reauth' })).toBeNull();
    expect(parseView({ t: 'view', vis: false, dc: true, dev: 'cam-1' })).toEqual({ t: 'view', vis: false, dc: true, dev: 'cam-1' });
    expect(parseView({ t: 'view', vis: true })).toEqual({ t: 'view', vis: true, dc: false });
    expect(parseView({ t: 'view', vis: 'yes' })).toBeNull();
  });

  it('routes encode their ids', () => {
    expect(ROUTES.glance('n/1')).toBe('/api/monitor/n%2F1/glance');
    expect(ROUTES.act('abc')).toBe('/api/monitor/abc/act');
    expect(ROUTES.kick).toBe('/api/me/kick');
  });
});

describe('key messages', () => {
  const hello = { t: 'dev_hello', devId: DEV, sigPub: POINT, ecdhPub: POINT, name: '  Mom’s   iPhone ', platform: 'ios', ts: 1761100000000, sig: 'A'.repeat(86) };

  it('dev_hello: shape checked, name tidied, unknown platforms refused', () => {
    expect(parseDevHello(hello)).toMatchObject({ devId: DEV, name: 'Mom’s iPhone', platform: 'ios' });
    expect(parseDevHello({ ...hello, platform: 'fridge' })).toBeNull();
    expect(parseDevHello({ ...hello, devId: 'short' })).toBeNull();
    expect(parseDevHello({ ...hello, sigPub: 'A'.repeat(87) })).toBeNull(); // not an uncompressed point
    expect(parseDevHello({ ...hello, ts: undefined })).toBeNull();
    expect(parseDevHello({ ...hello, pushKey: { p256dh: 'abc', auth: 'def' } })?.pushKey).toEqual({ p256dh: 'abc', auth: 'def' });
  });

  it('wraps: epochs from 1, one wrap per device', () => {
    expect(parseKeyWrap({ t: 'key_wrap', devId: DEV, e: 3, blob: 'AQID' })).toEqual({ t: 'key_wrap', devId: DEV, e: 3, blob: 'AQID' });
    expect(parseKeyWrap({ t: 'key_wrap', devId: DEV, e: 0, blob: 'AQID' })).toBeNull();
    expect(parseKeyWrap({ t: 'key_wrap', devId: DEV, e: 1, blob: 'a+b' })).toBeNull();
    expect(parseKeyInit({ t: 'key_init', e: 1, wraps: [{ devId: DEV, blob: 'AQID' }] })).toBeTruthy();
    expect(parseKeyInit({ t: 'key_init', e: 2, wraps: [{ devId: DEV, blob: 'AQID' }] })).toBeNull();
    expect(parseKeyInit({ t: 'key_init', e: 1, wraps: [] })).toBeNull();
    expect(parseKeyRotate({ t: 'key_rotate', e: 2, wraps: [{ devId: DEV, blob: 'AQ' }, { devId: DEV, blob: 'Ag' }] })).toBeNull();
    expect(parseKeyRotate({ t: 'key_rotate', e: 2, devs: [] })).toBeNull(); // that's the room's request, not a holder's answer
  });

  it('sticky E2E: a key holder refuses unsealed signaling', () => {
    const sealed = { e: 1, iv: 'A'.repeat(16), ct: 'AAAA', f: DEV };
    const plain = { sdp: { type: 'offer', sdp: 'v=0' } };
    expect(isSealedRtc(sealed)).toBe(true);
    expect(rtcPolicy(true, sealed)).toBe('open');
    expect(rtcPolicy(true, plain)).toBe('refuse');
    expect(rtcPolicy(false, plain)).toBe('plain');
    expect(isSealedRtc({ ...sealed, iv: 'short' })).toBe(false);
    expect(isSealedRtc({ ...sealed, f: undefined })).toBe(false);
  });
});
