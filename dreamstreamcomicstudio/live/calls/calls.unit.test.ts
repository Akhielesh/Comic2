// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { isMissed } from '../views/callsBadge';
import { candidateType, classifyFailure, encodingFor, failureText, hasTurnServer, joinedAfter, preferH264, rateQuality, videoBitrate } from './callMesh';
import { answerFromHash, callFailText, deriveActiveState, familyName, recentsOf, ringAsCall, withMe } from './callCenter';
import { badgeFor, familyMap, needsConfirm, recentPeople } from '../views/calls/people';
import { callErrorText, ctxText, type Call, type CallRecord } from './types';

const baseCall = (over: Partial<Call> = {}): Call => ({
  id: 'c1', from: { uid: 'mom', name: 'Alice', label: 'Mom' }, video: true, invited: ['gpa'], declined: [], at: 1, answeredAt: null,
  parts: [{ uid: 'mom', name: 'Alice', label: 'Mom', sid: 's-mom', at: 1, mic: true, cam: true }], ever: { mom: 'Alice' }, ended: null, ...over,
});

describe('where a call stands', () => {
  const st = (s: string) => ({ state: s as 'connecting' });
  it('placing it: calling until someone answers', () => {
    expect(deriveActiveState({ ended: null, id: null, call: null, outgoing: true }, [])).toBe('calling');
    expect(deriveActiveState({ ended: null, id: 'c1', call: baseCall(), outgoing: true }, [])).toBe('calling');
    expect(deriveActiveState({ ended: null, id: null, call: null, outgoing: false }, [])).toBe('starting');
  });
  it('answered: connecting → still connecting (slow) → connected, or failed when every connection did', () => {
    const answered = { ended: null, id: 'c1', call: baseCall({ answeredAt: 5 }), outgoing: true };
    expect(deriveActiveState(answered, [st('connecting')])).toBe('connecting');
    expect(deriveActiveState(answered, [st('slow')])).toBe('slow');
    expect(deriveActiveState(answered, [st('failed')])).toBe('failed');
    expect(deriveActiveState(answered, [st('failed'), st('connecting')])).toBe('slow');
    expect(deriveActiveState(answered, [st('failed'), st('connected')])).toBe('connected');
    expect(deriveActiveState({ ...answered, ended: { why: 'done' } }, [st('connected')])).toBe('ended');
  });
  it('explains a failed call in words, naming who', () => {
    expect(callFailText([{ state: 'failed', why: 'remote_blocked', label: 'Grandpa', name: 'Bob' }])).toBe('Grandpa’s network is blocking calls — they could try switching between Wi-Fi and mobile data.');
    expect(callFailText([{ state: 'failed', why: 'nat', label: null, name: 'Bob' }, { state: 'connecting', why: null, label: null, name: 'Cara' }])).toBeNull();
  });
});

describe('why a connection failed', () => {
  it('reads the candidate types each side found', () => {
    expect(classifyFailure(['host'], ['srflx'], false)).toBe('local_blocked');
    expect(classifyFailure([], [], false)).toBe('local_blocked');
    expect(classifyFailure(['host', 'srflx'], [], false)).toBe('unknown');
    expect(classifyFailure(['srflx'], ['host'], false)).toBe('remote_blocked');
    expect(classifyFailure(['host', 'srflx'], ['host', 'srflx'], false)).toBe('nat');
    expect(classifyFailure(['srflx', 'relay'], ['srflx'], true)).toBe('relay_failed');
    expect(classifyFailure(['relay'], ['prflx'], true)).toBe('relay_failed');
    expect(classifyFailure([], [], false, true)).toBe('no_relay');
  });
  it('says it plainly', () => {
    expect(failureText('local_blocked', 'Grandpa')).toMatch(/^Your network is blocking calls/);
    expect(failureText('nat', 'Grandpa')).toMatch(/^Can’t connect directly between your two networks/);
    expect(failureText('no_relay', 'Grandpa')).toMatch(/^Can’t connect directly/);
    expect(failureText('lost', 'Grandpa')).toBe('Lost the connection to Grandpa.');
    expect(failureText(null, 'Grandpa')).toBe('Grandpa’s phone isn’t responding.');
  });
  it('reads a candidate’s type from the object or its SDP line', () => {
    expect(candidateType({ type: 'relay' })).toBe('relay');
    expect(candidateType({ candidate: 'candidate:1 1 udp 2122 192.168.1.2 5000 typ host generation 0' })).toBe('host');
    expect(candidateType({ candidate: 'candidate:1 1 udp 1 1.2.3.4 5000 typ srflx raddr 0.0.0.0 rport 0' })).toBe('srflx');
  });
  it('knows a relay when it sees one', () => {
    expect(hasTurnServer([{ urls: ['stun:s:3478'] }])).toBe(false);
    expect(hasTurnServer([{ urls: ['stun:s:3478'] }, { urls: 'turns:t:443?transport=tcp' }])).toBe(true);
  });
});

describe('encoding and codecs', () => {
  it('360p per copy with two or more others, 24 fps with three; a busy CPU steps down further', () => {
    expect(encodingFor(1)).toEqual({ maxBitrate: 1_500_000, scaleResolutionDownBy: 1, maxFramerate: 30 });
    expect(encodingFor(2)).toEqual({ maxBitrate: 900_000, scaleResolutionDownBy: 2, maxFramerate: 30 });
    expect(encodingFor(3)).toEqual({ maxBitrate: 600_000, scaleResolutionDownBy: 2, maxFramerate: 24 });
    expect(encodingFor(1, 1).scaleResolutionDownBy).toBe(1.5);
    expect(encodingFor(1, 2)).toMatchObject({ scaleResolutionDownBy: 2, maxFramerate: 20 });
    expect(encodingFor(3, 2)).toMatchObject({ scaleResolutionDownBy: 4, maxFramerate: 20 });
  });
  it('puts H.264 first (packetization-mode 1 leading) and leaves the rest in order', () => {
    const vp8 = { mimeType: 'video/VP8' };
    const vp9 = { mimeType: 'video/VP9' };
    const h0 = { mimeType: 'video/H264', sdpFmtpLine: 'level-asymmetry-allowed=1;packetization-mode=0;profile-level-id=42e01f' };
    const h1 = { mimeType: 'video/H264', sdpFmtpLine: 'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f' };
    const rtx = { mimeType: 'video/rtx' };
    expect(preferH264([vp8, rtx, vp9, h0, h1])).toEqual([h1, h0, vp8, rtx, vp9]);
    const none = [vp8, vp9];
    expect(preferH264(none)).toBe(none);
  });
});

describe('answering', () => {
  it('builds the call as it will be once our join lands (we offer to everyone already in it)', () => {
    const c = withMe(baseCall({ answeredAt: null }), { uid: 'gpa', sid: 's-gpa', name: 'Bob', label: 'Grandpa' }, false);
    expect(c.parts.map((p) => p.uid)).toEqual(['mom', 'gpa']);
    expect(joinedAfter(c.parts[1], c.parts[0])).toBe(true);
    expect(c.parts[1]).toMatchObject({ cam: false, mic: true });
  });
  it('“Answer” on a notification opens the call with answer=1', () => {
    const nid = '11111111-2222-4333-8444-555555555555';
    expect(answerFromHash(`#/call/${nid}/abcdef0123456789?answer=1`)).toEqual({ nid, id: 'abcdef0123456789' });
    expect(answerFromHash(`#/call/${nid}/abcdef0123456789`)).toBeNull();
    expect(answerFromHash(`#/call/${nid}/abcdef0123456789?answer=0`)).toBeNull();
    expect(answerFromHash('#/calls?answer=1')).toBeNull();
  });
});

describe('call mesh rules', () => {
  it('the one who joined later offers (ties broken by socket id) — never both', () => {
    expect(joinedAfter({ at: 2, sid: 'a' }, { at: 1, sid: 'z' })).toBe(true);
    expect(joinedAfter({ at: 1, sid: 'z' }, { at: 2, sid: 'a' })).toBe(false);
    const x = { at: 5, sid: 'b' };
    const y = { at: 5, sid: 'a' };
    expect(joinedAfter(x, y)).not.toBe(joinedAfter(y, x));
  });
  it('shares the uplink between everyone you send to', () => {
    expect(videoBitrate(1)).toBe(1_500_000);
    expect(videoBitrate(2)).toBe(900_000);
    expect(videoBitrate(3)).toBe(600_000);
  });
  it('rates the connection from loss and round-trip time', () => {
    expect(rateQuality(0.5, 0.05)).toBe('good');
    expect(rateQuality(4, 0.05)).toBe('fair');
    expect(rateQuality(1, 0.4)).toBe('fair');
    expect(rateQuality(12, 0.05)).toBe('poor');
    expect(rateQuality(0, 0.9)).toBe('poor');
  });
});

describe('call history', () => {
  const rec = (over: Partial<CallRecord>): CallRecord => ({
    id: 'c', from: { uid: 'mom', name: 'Alice', label: 'Mom' }, invited: ['gpa'], joined: [{ uid: 'mom', name: 'Alice' }],
    video: true, at: 1, secs: 0, answered: false, why: 'no_answer', ...over,
  });
  it('a missed call: rung, never picked up on any device, not declined', () => {
    expect(isMissed(rec({}), 'gpa')).toBe(true);
    expect(isMissed(rec({ why: 'cancelled' }), 'gpa')).toBe(true);
    expect(isMissed(rec({ why: 'declined' }), 'gpa')).toBe(false);
    expect(isMissed(rec({ answered: true, why: 'done', joined: [{ uid: 'mom', name: 'Alice' }, { uid: 'gpa', name: 'Bob' }] }), 'gpa')).toBe(false);
    expect(isMissed(rec({}), 'mom')).toBe(false); // your own call isn't "missed"
    expect(isMissed(rec({}), null)).toBe(false);
  });
  it('names a nursery by its baby', () => {
    expect(familyName({ name: 'Nursery', baby: 'Aria' })).toBe('Aria’s family');
    expect(familyName({ name: 'Grandma’s house', baby: null })).toBe('Grandma’s house');
    expect(familyName(null)).toBe('Family');
  });
});

describe('direct calls (anyone on Stream Studio)', () => {
  const NID = '11111111-2222-4333-8444-555555555555';
  const rec = (over: Partial<CallRecord>): CallRecord => ({
    id: 'c', from: { uid: 'sam', name: 'Sam', label: null }, invited: ['me'], joined: [{ uid: 'sam', name: 'Sam' }],
    video: true, at: 1, secs: 0, answered: false, why: 'no_answer', ...over,
  });
  const nurseries = [{ id: NID, name: 'Nursery', baby_name: 'Aria' }, { id: 'n2', name: 'Lake house', baby_name: null }];
  const people = {
    [NID]: [
      { user_id: 'me', display_name: 'Alice', role: 'parent' as const, label: 'Mom', is_owner: true, is_me: true },
      { user_id: 'gma', display_name: 'June', role: 'caregiver' as const, label: 'Grandma', is_owner: false, is_me: false },
    ],
    n2: [{ user_id: 'gma', display_name: 'June', role: 'viewer' as const, label: 'Nana', is_owner: false, is_me: false }],
  };

  it('“Answer” on a direct call’s notification: #/call/d/<call> → its room’s line', () => {
    expect(answerFromHash('#/call/d/0123456789abcdef?answer=1')).toEqual({ nid: 'd:0123456789abcdef', id: '0123456789abcdef' });
    expect(answerFromHash('#/call/d/0123456789abcdef')).toBeNull();
    expect(answerFromHash('#/call/x/0123456789abcdef?answer=1')).toBeNull();
  });

  it('recents: family and direct calls merged, newest first, each call once', () => {
    const family = [{ ...rec({ id: 'a', at: 5 }), nid: NID, nursery: 'Aria’s family' }, { ...rec({ id: 'b', at: 1 }), nid: NID, nursery: 'Aria’s family' }];
    const direct = [{ ...rec({ id: 'c', at: 3 }), nid: 'direct', nursery: 'Stream Studio' }, { ...rec({ id: 'a', at: 5 }), nid: 'direct', nursery: 'Stream Studio' }];
    expect(recentsOf([family, direct]).map((r) => `${r.id}:${r.nid}`)).toEqual(['a:direct', 'c:direct', 'b:' + NID]);
    expect(recentsOf([family, direct], 2)).toHaveLength(2);
  });

  it('a missed direct call counts like a family one', () => {
    expect(isMissed(rec({}), 'me')).toBe(true);
    expect(isMissed(rec({ why: 'declined' }), 'me')).toBe(false);
    expect(isMissed(rec({ answered: true, why: 'done', joined: [{ uid: 'sam', name: 'Sam' }, { uid: 'me', name: 'Alice' }] }), 'me')).toBe(false);
  });

  it('your family: everyone sharing a nursery (the first one wins), never you', () => {
    const fam = familyMap(nurseries, people);
    expect([...fam.keys()]).toEqual(['gma']);
    expect(fam.get('gma')).toMatchObject({ label: 'Grandma', nid: NID, where: 'Aria’s family' });
    expect(badgeFor('gma', fam)).toEqual({ family: true, text: 'In Aria’s family' });
    expect(badgeFor('sam', fam)).toEqual({ family: false, text: 'Stream Studio member' });
  });

  it('who a recent call was with, and who to ring back', () => {
    const names: Record<string, string> = { sam: 'Sam P.' };
    const nameOf = (u: string) => names[u] ?? null;
    // You called Sam and he never picked up: his name is remembered from when you called.
    expect(recentPeople(rec({ from: { uid: 'me', name: 'Alice', label: null }, invited: ['sam'], joined: [{ uid: 'me', name: 'Alice' }] }), 'me', nameOf)).toEqual({ names: ['Sam P.'], back: [{ uid: 'sam', name: 'Sam P.' }] });
    expect(recentPeople(rec({ from: { uid: 'me', name: 'Alice', label: null }, invited: ['zed'] }), 'me', nameOf).names).toEqual(['Someone']);
    expect(recentPeople(rec({}), 'me', () => null)).toEqual({ names: ['Sam'], back: [{ uid: 'sam', name: 'Sam' }] });
  });

  it('checks before a first call to someone outside your family', () => {
    const family = familyMap(nurseries, people);
    const base = { family, favs: [], log: [] as CallRecord[], me: 'me', confirmed: new Set<string>() };
    expect(needsConfirm('sam', base)).toBe(true);
    expect(needsConfirm('gma', base)).toBe(false);
    expect(needsConfirm('sam', { ...base, confirmed: new Set(['sam']) })).toBe(false);
    expect(needsConfirm('sam', { ...base, favs: [{ uid: 'sam', name: 'Sam', at: 1 }] })).toBe(false);
    expect(needsConfirm('sam', { ...base, log: [rec({})] })).toBe(false); // Sam called you before
    expect(needsConfirm('sam', { ...base, log: [rec({ from: { uid: 'me', name: 'Alice', label: null }, invited: ['sam'] })] })).toBe(false);
  });

  it('says why a direct call can’t go through, naming them', () => {
    expect(callErrorText('unavailable', 'Sam')).toMatch(/^Sam can’t be reached right now/);
    expect(callErrorText('restricted', 'Sam')).toBe('Sam only takes calls from people in their nurseries.');
    expect(callErrorText('slow_down')).toMatch(/wait a few minutes/);
    expect(callErrorText('busy', 'Sam')).toBe('You’re already in a call on this device.');
  });

  it('a direct ring is shown at once as a call for you, labelled from your family or as someone else', () => {
    const ring = { id: 'd1', from: { uid: 'sam', name: 'Sam' }, video: true, at: 9, ticket: 't', ctx: { family: false, label: null, where: null } };
    expect(ringAsCall(ring, 'me')).toMatchObject({ id: 'd1', from: { uid: 'sam', name: 'Sam', label: null }, invited: ['me'], parts: [], answeredAt: null, ended: null });
    expect(ctxText(ring.ctx)).toBe('Stream Studio member · not in your family');
    expect(ctxText({ family: true, label: 'Grandma', where: 'Aria’s family' })).toBe('Aria’s family');
  });
});
