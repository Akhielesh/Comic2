// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { isMissed } from '../views/callsBadge';
import { candidateType, classifyFailure, encodingFor, failureText, hasTurnServer, joinedAfter, preferH264, rateQuality, videoBitrate } from './callMesh';
import { answerFromHash, callFailText, deriveActiveState, familyName, withMe } from './callCenter';
import type { Call, CallRecord } from './types';

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
