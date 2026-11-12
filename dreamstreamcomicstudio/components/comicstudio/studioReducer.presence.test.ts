// studioReducer — presence (agent-editor plan §3 A2 "Presence", wave 2 A4): where the director is working, from the
// `where` of an activity start. Set on that start, cleared on that activity's end, on its stream's done or error, when
// the stream closes, and on Stop. Events without `where` (every event today: B-TOOL adds it) change nothing.

import { describe, expect, it } from 'vitest';
import { STEER_LIMITS, type ActivityWhere, type StudioEvent } from '../../shared/comic/events';
import { makeSampleDoc } from './conversation/testing/fixtures';
import { initialStudioState, MAX_PRESENCE, presenceOf, presenceWhere, studioReducer, type StudioReducerAction, type StudioState } from './studioReducer';

const NOW = 1_760_000_000_000;
const run = (state: StudioState, ...actions: StudioReducerAction[]) => actions.reduce(studioReducer, state);
const loaded = () => run(initialStudioState(), { type: 'load_success', doc: makeSampleDoc(), now: NOW });
const open = (state: StudioState, streamId = 'm1', kind: 'message' | 'action' = 'message') => run(state, { type: 'stream_start', streamId, kind, now: NOW });
const ev = (streamId: string, event: StudioEvent, now = NOW + 10): StudioReducerAction => ({ type: 'stream_event', streamId, event, now });
const start = (id: string, label: string, where?: ActivityWhere, streamId = 'm1', now = NOW + 10) =>
  ev(streamId, { type: 'activity', id, label, phase: 'start', cost: 'free', ...(where ? { where } : {}) }, now);
const end = (id: string, label: string, streamId = 'm1') => ev(streamId, { type: 'activity', id, label, phase: 'end', ok: true, cost: 'free' });
const done = (streamId = 'm1') => ev(streamId, { type: 'done', rev: 5, spentUsd: 0 });
const BALLOON: ActivityWhere = { pageId: 'pg_2', lineIds: ['pg_2_l1'] };

describe('presence from activity.where', () => {
  it('is set from an activity start that carries where, and cleared on that activity’s end', () => {
    let s = open(loaded());
    expect(presenceOf(s)).toBeNull();
    s = run(s, start('act_1', 'Moving a balloon', BALLOON, 'm1', NOW + 42));
    expect(presenceOf(s)).toEqual({ pageId: 'pg_2', lineIds: ['pg_2_l1'], label: 'Moving a balloon', at: NOW + 42 });
    // The activity line itself is unchanged by presence.
    expect(s.activity.map((a) => a.label)).toEqual(['Moving a balloon']);
    s = run(s, end('act_1', 'Moving a balloon'));
    expect(presenceOf(s)).toBeNull();
    // The stream stays open (renders may follow): only that activity's end cleared it.
    expect(Object.keys(s.streams)).toEqual(['m1']);
  });

  it('another activity’s end leaves it alone', () => {
    let s = run(open(loaded()), start('act_1', 'Moving a balloon', BALLOON), start('job_1', 'Drawing page 3'));
    s = run(s, end('job_1', 'Drawing page 3'));
    expect(presenceOf(s)?.lineIds).toEqual(['pg_2_l1']);
  });

  it('is cleared on the stream’s done', () => {
    const s = run(open(loaded()), start('act_1', 'Moving a balloon', BALLOON), done());
    expect(presenceOf(s)).toBeNull();
  });

  it('is cleared on the stream’s error (the tool never sent its end)', () => {
    const s = run(open(loaded()), start('act_1', 'Moving a balloon', BALLOON), ev('m1', { type: 'error', code: 'INTERNAL', message: 'Something went wrong.' }));
    expect(presenceOf(s)).toBeNull();
    expect(s.error).toBe('Something went wrong.');
  });

  it('is cleared when the stream closes without a done (a dropped connection)', () => {
    const s = run(open(loaded()), start('act_1', 'Moving a balloon', BALLOON), { type: 'stream_end', streamId: 'm1', error: 'Network lost', now: NOW });
    expect(presenceOf(s)).toBeNull();
  });

  it('is cleared on Stop (cancel), before the streams close', () => {
    let s = run(open(loaded()), start('act_1', 'Moving a balloon', BALLOON));
    s = run(s, { type: 'cancel_start' });
    expect(presenceOf(s)).toBeNull();
    expect(s.cancelling).toBe(true);
    expect(Object.keys(s.streams)).toEqual(['m1']);
  });

  it('nothing changes when no event carries where (today: no server sends it)', () => {
    const before = run(open(loaded()), start('act_1', 'Moving a balloon'));
    expect(presenceOf(before)).toBeNull();
    expect(before.presence).toBeUndefined();
    const after = run(before, end('act_1', 'Moving a balloon'), done(), { type: 'stream_end', streamId: 'm1', now: NOW }, { type: 'cancel_start' });
    expect(after.presence).toBeUndefined();
    // A where that names nothing usable is the same as none.
    const empty = run(open(loaded()), start('a', 'Moving a balloon', {}), start('b', 'Moving a balloon', { lineIds: [] }));
    expect(empty.presence).toBeUndefined();
  });

  it('the same start delivered by two open streams stays until the stream still listening finishes', () => {
    // Every open stream receives every session event. A second message refused BUSY (another tab) also saw the start;
    // its error must not clear the presence of the turn that is still running on m1.
    let s = open(open(loaded(), 'm1'), 'm2');
    s = run(s, start('act_1', 'Moving a balloon', BALLOON, 'm1'), start('act_1', 'Moving a balloon', BALLOON, 'm2'));
    const shown = presenceOf(s);
    s = run(s, ev('m2', { type: 'error', code: 'BUSY', message: 'Still working.' }), { type: 'stream_end', streamId: 'm2', now: NOW });
    expect(presenceOf(s)).toBe(shown);
    s = run(s, done('m1'));
    expect(presenceOf(s)).toBeNull();
  });

  it('a stream that never saw the start does not clear it', () => {
    let s = run(open(loaded(), 'm1'), start('act_1', 'Moving a balloon', BALLOON, 'm1'));
    s = open(s, 'a1', 'action');
    s = run(s, done('a1'), { type: 'stream_end', streamId: 'a1', now: NOW });
    expect(presenceOf(s)?.pageId).toBe('pg_2');
  });

  it('shows the newest place; when that activity ends the earlier live one shows again', () => {
    let s = run(open(loaded()), start('act_1', 'Moving a balloon', BALLOON), start('act_2', 'Restyling balloons', { pageId: 'pg_1' }));
    expect(presenceOf(s)?.pageId).toBe('pg_1');
    s = run(s, end('act_2', 'Restyling balloons'));
    expect(presenceOf(s)?.pageId).toBe('pg_2');
  });

  it('keeps the same object while it lives (panes reading it do not re-render for nothing)', () => {
    let s = run(open(loaded()), start('act_1', 'Moving a balloon', BALLOON));
    const shown = presenceOf(s);
    s = run(s, ev('m1', { type: 'delta', msgId: 'a1', text: 'Moving it.' }), start('act_1', 'Moving a balloon', BALLOON), ev('m1', { type: 'urls', urls: {} }));
    expect(presenceOf(s)).toBe(shown);
  });

  it('a project switch starts with no presence', () => {
    const s = run(open(loaded()), start('act_1', 'Moving a balloon', BALLOON), { type: 'load_start' });
    expect(presenceOf(s)).toBeNull();
  });

  it(`keeps at most ${MAX_PRESENCE} live entries`, () => {
    let s = open(loaded());
    for (let i = 0; i < MAX_PRESENCE + 3; i += 1) s = run(s, start(`act_${i}`, 'Moving a balloon', { pageId: `pg_${i}` }));
    expect(s.presence).toHaveLength(MAX_PRESENCE);
    expect(presenceOf(s)?.pageId).toBe(`pg_${MAX_PRESENCE + 2}`);
  });
});

describe('presenceWhere (the bounds)', () => {
  it(`keeps at most STEER_LIMITS.whereLines (${STEER_LIMITS.whereLines}) distinct line ids`, () => {
    const ids = Array.from({ length: 50 }, (_, i) => `ln_${i % 30}`);
    const w = presenceWhere({ pageId: 'pg_1', lineIds: ids });
    expect(w?.lineIds).toHaveLength(STEER_LIMITS.whereLines);
    expect(new Set(w?.lineIds).size).toBe(STEER_LIMITS.whereLines);
    expect(w?.lineIds[0]).toBe('ln_0');
  });

  it('drops what is not an id and names nothing for an empty or malformed where', () => {
    expect(presenceWhere({ pageId: 7, lineIds: ['ok', '', 3, null, 'x'.repeat(200)] })).toEqual({ lineIds: ['ok'] });
    expect(presenceWhere({ pageId: 'pg_1' })).toEqual({ pageId: 'pg_1', lineIds: [] });
    expect(presenceWhere({})).toBeNull();
    expect(presenceWhere(null)).toBeNull();
    expect(presenceWhere('pg_1')).toBeNull();
    expect(presenceWhere({ lineIds: 'ln_1' })).toBeNull();
  });

  it('a start with more than the cap is stored bounded', () => {
    const lineIds = Array.from({ length: 40 }, (_, i) => `ln_${i}`);
    const s = run(open(loaded()), start('act_1', 'Restyling balloons', { pageId: 'pg_1', lineIds }));
    expect(presenceOf(s)?.lineIds).toEqual(lineIds.slice(0, STEER_LIMITS.whereLines));
  });
});
