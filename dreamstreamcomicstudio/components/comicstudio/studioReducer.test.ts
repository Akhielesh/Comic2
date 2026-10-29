import { describe, expect, it } from 'vitest';
import type { DocOp } from '../../shared/comic/ops';
import type { StudioEvent } from '../../shared/comic/events';
import type { Msg } from '../../shared/comic/doc';
import {
  URL_FALLBACK_TTL_MS,
  activeActivities,
  conversationEntries,
  deriveDoc,
  initialStudioState,
  isEchoOf,
  isMessageBusy,
  isTargetRendering,
  mayHaveDroppedClears,
  needsRefresh,
  renderingCount,
  renderingPageCount,
  signedUrlExpiry,
  studioReducer,
  tabForOps,
  urlIsFresh,
  visibleStreams,
  type StudioReducerAction,
  type StudioState
} from './studioReducer';
import { makeSampleDoc } from './conversation/testing/fixtures';

const T = 1_760_000_100_000;

const run = (state: StudioState, ...actions: StudioReducerAction[]) => actions.reduce(studioReducer, state);

const loaded = (rev = 5) => run(initialStudioState(), { type: 'load_success', doc: makeSampleDoc({ rev }), urls: {}, now: T });

const ev = (streamId: string, event: StudioEvent): StudioReducerAction => ({ type: 'stream_event', streamId, event, now: T });
const start = (streamId: string, kind: 'message' | 'action' | 'patch' = 'action'): StudioReducerAction => ({
  type: 'stream_start',
  streamId,
  kind,
  now: T
});
const end = (streamId: string, extra: { error?: string; aborted?: boolean } = {}): StudioReducerAction => ({
  type: 'stream_end',
  streamId,
  now: T,
  ...extra
});

const msg = (id: string, role: Msg['role'], text: string): Msg => ({ id, role, text, at: T });
const titleOp = (title: string): DocOp => ({ op: 'brief', patch: { title } });

const jwtUrl = (expSeconds: number) => {
  const b64 = (o: object) => btoa(JSON.stringify(o)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  return `https://storage.test/object/sign/comic/a.webp?token=${b64({ alg: 'HS256' })}.${b64({ exp: expSeconds, url: 'a' })}.sig`;
};

describe('studioReducer — load', () => {
  it('starts loading and stores the loaded doc, urls and revision', () => {
    expect(initialStudioState().loading).toBe(true);
    const s = run(initialStudioState(), { type: 'load_success', doc: makeSampleDoc({ rev: 7 }), urls: { 'a.webp': 'data:image/png;base64,x' }, now: T });
    expect(s.loading).toBe(false);
    expect(s.doc?.rev).toBe(7);
    expect(s.base).toBe(s.doc);
    expect(s.behindRev).toBe(7);
    expect(s.urls['a.webp'].url).toBe('data:image/png;base64,x');
    expect(needsRefresh(s)).toBe(false);
  });

  it('records a fatal load error', () => {
    const s = run(initialStudioState(), { type: 'load_error', message: 'Nope' });
    expect(s.loading).toBe(false);
    expect(s.loadError).toBe('Nope');
    expect(s.doc).toBeNull();
  });

  it('load_start resets everything from a previous project', () => {
    const s = run(loaded(), start('s1'), { type: 'set_error', message: 'x' }, { type: 'load_start' });
    expect(s.doc).toBeNull();
    expect(s.streams).toEqual({});
    expect(s.error).toBeNull();
    expect(s.loading).toBe(true);
  });
});

describe('studioReducer — ops and revisions', () => {
  it('applies the next revision and bumps rev', () => {
    const s = run(loaded(5), start('s1'), ev('s1', { type: 'ops', rev: 6, ops: [titleOp('New title')] }));
    expect(s.doc?.brief.title).toBe('New title');
    expect(s.doc?.rev).toBe(6);
    expect(s.base?.rev).toBe(6);
    expect(s.lastOps?.rev).toBe(6);
  });

  it('ignores a batch it already applied (every open stream delivers every batch)', () => {
    const once = run(loaded(5), start('s1'), start('s2'), ev('s1', { type: 'ops', rev: 6, ops: [{ op: 'note_add', text: 'n1' }] }));
    const twice = run(once, ev('s2', { type: 'ops', rev: 6, ops: [{ op: 'note_add', text: 'n1' }] }));
    expect(twice).toBe(once);
    expect(twice.doc?.brief.notes).toEqual(['n1']);
  });

  it('a revision gap is not applied and marks the client behind (needsRefresh)', () => {
    const s = run(loaded(5), start('s1'), ev('s1', { type: 'ops', rev: 8, ops: [titleOp('Skipped')] }));
    expect(s.doc?.brief.title).toBe('Rooftop Heist');
    expect(s.doc?.rev).toBe(5);
    expect(s.behindRev).toBe(8);
    expect(needsRefresh(s)).toBe(true);
  });

  it('a gap filled by another stream clears the need to refresh', () => {
    let s = run(loaded(5), start('a'), start('b'), ev('b', { type: 'ops', rev: 7, ops: [titleOp('Seven')] }));
    expect(needsRefresh(s)).toBe(true);
    s = run(s, ev('a', { type: 'ops', rev: 6, ops: [titleOp('Six')] }), ev('a', { type: 'ops', rev: 7, ops: [titleOp('Seven')] }));
    expect(s.doc?.brief.title).toBe('Seven');
    expect(needsRefresh(s)).toBe(false);
  });

  it('hello ahead of us means we missed changes; hello behind us forces a hard refresh', () => {
    const ahead = run(loaded(5), start('s1'), ev('s1', { type: 'hello', rev: 9, turnId: 't' }));
    expect(ahead.behindRev).toBe(9);
    expect(needsRefresh(ahead)).toBe(true);
    const same = run(loaded(5), start('s1'), ev('s1', { type: 'hello', rev: 5, turnId: 't' }));
    expect(needsRefresh(same)).toBe(false);
    const behind = run(loaded(5), start('s1'), ev('s1', { type: 'hello', rev: 3, turnId: 't' }));
    expect(behind.hardRefresh).toBe(true);
    expect(needsRefresh(behind)).toBe(true);
  });

  it('done reports the final revision and the spend of the turn', () => {
    const s = run(loaded(5), start('s1'), ev('s1', { type: 'done', rev: 6, spentUsd: 0.13 }));
    expect(s.lastSpentUsd).toBe(0.13);
    expect(needsRefresh(s)).toBe(true); // we never saw rev 6
  });

  it('drops events from a stream it does not know (closed / previous project)', () => {
    const s0 = loaded(5);
    expect(run(s0, ev('ghost', { type: 'ops', rev: 6, ops: [titleOp('x')] }))).toBe(s0);
  });
});

describe('studioReducer — clears lost in transit', () => {
  it('flags render/style ops whose clear was dropped by JSON and resyncs once idle', () => {
    expect(mayHaveDroppedClears([{ op: 'render', target: { kind: 'page', id: 'p' }, patch: { status: 'queued' } }])).toBe(true);
    expect(mayHaveDroppedClears([{ op: 'render', target: { kind: 'page', id: 'p' }, patch: { status: 'queued', error: null as unknown as string } }])).toBe(false);
    expect(mayHaveDroppedClears([{ op: 'render', target: { kind: 'page', id: 'p' }, patch: { status: 'rendering' } }])).toBe(false);
    expect(mayHaveDroppedClears([{ op: 'style', patch: { status: 'locked', name: 'x' } }])).toBe(true);
    expect(mayHaveDroppedClears([{ op: 'style', patch: { status: 'drafted' } }])).toBe(false);

    let s = run(loaded(5), start('a'), ev('a', { type: 'ops', rev: 6, ops: [{ op: 'render', target: { kind: 'page', id: 'pg_3' }, patch: { status: 'queued' } }] }));
    expect(s.doc?.pages[2].render.error).toBeUndefined(); // fixture failed page had no error text
    expect(needsRefresh(s)).toBe(false); // still streaming
    s = run(s, end('a'));
    expect(needsRefresh(s)).toBe(true);
  });
});

describe('studioReducer — refresh', () => {
  it('takes a newer server doc and resets the behind marker', () => {
    const behind = run(loaded(5), start('s1'), ev('s1', { type: 'ops', rev: 9, ops: [] }), end('s1'));
    const s = run(behind, { type: 'refresh_start' }, { type: 'refresh_success', doc: makeSampleDoc({ rev: 9 }), now: T });
    expect(s.doc?.rev).toBe(9);
    expect(s.refreshing).toBe(false);
    expect(needsRefresh(s)).toBe(false);
  });

  it('never regresses to an older doc than the one streams already applied', () => {
    const s0 = run(loaded(5), start('s1'), ev('s1', { type: 'ops', rev: 6, ops: [titleOp('Fresh')] }));
    const s = run(s0, { type: 'refresh_success', doc: makeSampleDoc({ rev: 5 }), now: T });
    expect(s.doc?.brief.title).toBe('Fresh');
    expect(s.doc?.rev).toBe(6);
  });

  it('a hard refresh accepts the server doc even when its revision is lower', () => {
    const s0 = run(loaded(5), start('s1'), ev('s1', { type: 'hello', rev: 2, turnId: 't' }));
    const s = run(s0, { type: 'refresh_success', doc: makeSampleDoc({ rev: 2, brief: { title: 'Server', notes: [] } }), now: T });
    expect(s.doc?.rev).toBe(2);
    expect(s.doc?.brief.title).toBe('Server');
    expect(s.hardRefresh).toBe(false);
  });

  it('a failed retry of the first load keeps the fatal screen with the new reason', () => {
    const s = run(initialStudioState(), { type: 'load_error', message: 'first' }, { type: 'refresh_start' }, { type: 'refresh_error', message: 'second' });
    expect(s.loadError).toBe('second');
    expect(s.error).toBeNull();
    const withDoc = run(loaded(), { type: 'refresh_error', message: 'resync failed' });
    expect(withDoc.error).toBe('resync failed');
  });
});

describe('studioReducer — streaming text, activity and errors', () => {
  it('accumulates deltas into drafts and drops the draft when the message lands with text', () => {
    let s = run(loaded(5), start('m', 'message'), ev('m', { type: 'delta', msgId: 'a1', text: 'Hel' }), ev('m', { type: 'delta', msgId: 'a1', text: 'lo' }));
    expect(s.drafts.a1).toBe('Hello');
    s = run(s, ev('m', { type: 'ops', rev: 6, ops: [{ op: 'message', msg: msg('a1', 'assistant', '') }] }));
    expect(s.drafts.a1).toBe('Hello'); // placeholder without text keeps streaming
    s = run(s, ev('m', { type: 'ops', rev: 7, ops: [{ op: 'message_patch', id: 'a1', patch: { text: 'Hello there' } }] }));
    expect(s.drafts.a1).toBeUndefined();
    expect(s.doc?.conversation.find((m) => m.id === 'a1')?.text).toBe('Hello there');
  });

  it('tracks activity lines and clears them when the last stream ends', () => {
    let s = run(
      loaded(),
      start('a'),
      ev('a', { type: 'activity', id: 'x', label: 'Drawing page 1', phase: 'start' }),
      ev('a', { type: 'activity', id: 'y', label: 'Drawing page 2', phase: 'start' }),
      ev('a', { type: 'activity', id: 'x', label: 'Drawing page 1', phase: 'end', ok: true })
    );
    expect(activeActivities(s.activity).map((a) => a.id)).toEqual(['y']);
    expect(s.activity.find((a) => a.id === 'x')?.ok).toBe(true);
    s = run(s, start('b'), end('a'));
    expect(s.activity.map((a) => a.id)).toEqual(['y']); // finished lines pruned, live ones kept
    s = run(s, end('b'));
    expect(s.activity).toEqual([]);
    expect(s.drafts).toEqual({});
  });

  it('an end for an activity it never saw is ignored', () => {
    const s = run(loaded(), start('a'), ev('a', { type: 'activity', id: 'q', label: 'x', phase: 'end' }));
    expect(s.activity).toEqual([]);
  });

  it('error events surface as the current error and mark the stream', () => {
    const s = run(loaded(), start('a'), ev('a', { type: 'error', message: 'No key', code: 'NO_IMAGE_KEY' }));
    expect(s.error).toBe('No key');
    expect(s.streams.a.errored).toBe('No key');
  });

  it('a broken stream schedules a resync once every stream has settled', () => {
    let s = run(loaded(), start('a'), start('b'), end('a', { error: 'Connection lost' }));
    expect(s.error).toBe('Connection lost');
    expect(s.syncDue).toBe(true);
    expect(needsRefresh(s)).toBe(false); // b still open
    s = run(s, end('b'));
    expect(needsRefresh(s)).toBe(true);
  });

  it('a cancelled (aborted) stream is not an error', () => {
    const s = run(loaded(), start('a'), end('a', { aborted: true }));
    expect(s.error).toBeNull();
    expect(s.syncDue).toBe(false);
  });

  it('busy flags: patch streams are silent, message streams block the composer', () => {
    const s = run(loaded(), start('p', 'patch'));
    expect(visibleStreams(s)).toHaveLength(0);
    expect(isMessageBusy(s)).toBe(false);
    const m = run(s, start('m', 'message'));
    expect(visibleStreams(m)).toHaveLength(1);
    expect(isMessageBusy(m)).toBe(true);
  });

  it('the composer unlocks once the director reply lands while its stream keeps carrying render progress', () => {
    const earlier = { ...msg('a0', 'assistant', 'Which tone?'), cards: [{ type: 'options' as const, id: 'c0', question: 'Which tone?', choices: [{ id: 'o1', label: 'Funny' }, { id: 'o2', label: 'Tense' }] }] };
    let s = run(initialStudioState(), { type: 'load_success', doc: makeSampleDoc({ rev: 5, conversation: [earlier] }), urls: {}, now: T });
    s = run(s, start('m', 'message'), ev('m', { type: 'ops', rev: 6, ops: [{ op: 'message', msg: msg('u1', 'user', 'Funny') }] }));
    expect(isMessageBusy(s)).toBe(true);
    // An older message re-committed (the option answer recorded on its card) is not the reply…
    s = run(s, ev('m', { type: 'ops', rev: 7, ops: [{ op: 'message', msg: { ...earlier, cards: [{ ...earlier.cards[0], answered: ['o1'] }] } }] }));
    expect(isMessageBusy(s)).toBe(true);
    // …nor is a job's notice (origin 'job') that lands while the director is still working.
    s = run(s, ev('m', { type: 'ops', rev: 8, ops: [{ op: 'message', msg: msg('j1', 'assistant', 'Page 2 could not be drawn.') }], origin: 'job' }));
    expect(isMessageBusy(s)).toBe(true);
    // The director's reply: before the fix the composer stayed locked until the stream closed (every render done).
    s = run(s, ev('m', { type: 'ops', rev: 9, ops: [{ op: 'message', msg: msg('a1', 'assistant', 'On its way.') }] }));
    expect(isMessageBusy(s)).toBe(false);
    expect(s.streams.m.replied).toBe(true);
    expect(visibleStreams(s)).toHaveLength(1); // still open: live render progress
    expect(needsRefresh(s)).toBe(false);
    // A second message locks the composer again, and the first stream closing does not unlock it.
    s = run(s, start('m2', 'message'));
    expect(isMessageBusy(s)).toBe(true);
    s = run(s, end('m'));
    expect(isMessageBusy(s)).toBe(true);
    expect(s.streams.m2).toBeDefined();
    // Every open stream delivers every batch: the reply counts whichever stream brings it first.
    s = run(s, start('a', 'action'), ev('a', { type: 'ops', rev: 10, ops: [{ op: 'message', msg: msg('a2', 'assistant', 'Pages 1–2 are drawn.') }] }));
    expect(isMessageBusy(s)).toBe(false);
    expect(s.streams.a.replied).toBeUndefined();
  });

  it('cancelling clears once the last stream ends', () => {
    const s = run(loaded(), start('a'), { type: 'cancel_start' }, end('a'));
    expect(s.cancelling).toBe(false);
  });
});

describe('studioReducer — optimistic user message', () => {
  const pending = (streamId: string): StudioReducerAction => ({
    type: 'message_pending',
    message: { id: 'pm', text: 'A noir cat', attachments: [], at: T, status: 'sending', streamId }
  });

  it('shows immediately and is replaced by the server copy', () => {
    let s = run(loaded(5), pending('m'), start('m', 'message'));
    expect(s.pendingMessage?.text).toBe('A noir cat');
    s = run(s, ev('m', { type: 'ops', rev: 6, ops: [{ op: 'message', msg: msg('u1', 'user', 'A noir cat') }] }));
    expect(s.pendingMessage).toBeNull();
    expect(s.doc?.conversation.map((m) => m.id)).toEqual(['u1']);
  });

  it('an assistant message does not clear it', () => {
    const s = run(loaded(5), pending('m'), start('m', 'message'), ev('m', { type: 'ops', rev: 6, ops: [{ op: 'message', msg: msg('a1', 'assistant', 'Hi') }] }));
    expect(s.pendingMessage).not.toBeNull();
  });

  it('becomes "not sent" when the turn fails before the server recorded it', () => {
    const s = run(loaded(5), pending('m'), start('m', 'message'), ev('m', { type: 'error', message: 'Out of credit' }), end('m'));
    expect(s.pendingMessage?.status).toBe('failed');
    expect(s.pendingMessage?.error).toBe('Out of credit');
    expect(s.error).toBeNull(); // shown on the bubble, not twice
  });

  it('a transport failure fails it too, and a stop marks it stopped', () => {
    const failed = run(loaded(5), pending('m'), start('m', 'message'), end('m', { error: 'Connection lost' }));
    expect(failed.pendingMessage?.status).toBe('failed');
    const stopped = run(loaded(5), pending('m'), start('m', 'message'), end('m', { aborted: true }));
    expect(stopped.pendingMessage?.status).toBe('failed');
    expect(stopped.pendingMessage?.error).toMatch(/Stopped/);
  });

  it('is dropped when the turn ends cleanly', () => {
    const s = run(loaded(5), pending('m'), start('m', 'message'), ev('m', { type: 'done', rev: 5, spentUsd: 0 }), end('m'));
    expect(s.pendingMessage).toBeNull();
    const dismissed = run(loaded(5), pending('m'), { type: 'message_dismiss' });
    expect(dismissed.pendingMessage).toBeNull();
  });
});

describe('studioReducer — optimistic patches', () => {
  it('applies on top of the server doc and rolls back when rejected', () => {
    let s = run(loaded(5), { type: 'patch_local', patch: { id: 'p1', ops: [titleOp('Local')] }, now: T });
    expect(s.doc?.brief.title).toBe('Local');
    expect(s.base?.brief.title).toBe('Rooftop Heist');
    expect(s.doc?.rev).toBe(5);
    s = run(s, { type: 'patch_settled', ids: ['p1'], error: "Couldn't save", now: T });
    expect(s.doc?.brief.title).toBe('Rooftop Heist');
    expect(s.error).toBe("Couldn't save");
  });

  it('keeps the value once the server echo lands, and recognizes the echo', () => {
    let s = run(loaded(5), { type: 'patch_local', patch: { id: 'p1', ops: [titleOp('Local')] }, now: T }, start('p', 'patch'));
    s = run(s, ev('p', { type: 'ops', rev: 6, ops: [titleOp('Local')] }));
    expect(s.lastOps?.echo).toBe(true);
    s = run(s, end('p'), { type: 'patch_settled', ids: ['p1'], now: T });
    expect(s.doc?.brief.title).toBe('Local');
    expect(s.optimistic).toEqual([]);
  });

  it('later server ops still show under a pending patch', () => {
    let s = run(loaded(5), { type: 'patch_local', patch: { id: 'p1', ops: [{ op: 'format', patch: { pageCount: 12 } }] }, now: T }, start('a'));
    s = run(s, ev('a', { type: 'ops', rev: 6, ops: [titleOp('Server title')] }));
    expect(s.doc?.brief.title).toBe('Server title');
    expect(s.doc?.format.pageCount).toBe(12);
  });

  it('deriveDoc returns the base untouched without patches', () => {
    const doc = makeSampleDoc();
    expect(deriveDoc(doc, [])).toBe(doc);
    expect(deriveDoc(null, [])).toBeNull();
  });

  it('isEchoOf matches by op shape, not values', () => {
    expect(isEchoOf([{ op: 'character', id: 'c1', patch: { name: 'B' } }], [{ id: 'x', ops: [{ op: 'character', id: 'c1', patch: { name: 'b ' } }] }])).toBe(true);
    expect(isEchoOf([{ op: 'character', id: 'c2', patch: {} }], [{ id: 'x', ops: [{ op: 'character', id: 'c1', patch: {} }] }])).toBe(false);
    expect(isEchoOf([titleOp('x')], [])).toBe(false);
  });
});

describe('studioReducer — signed URLs', () => {
  it('reads the expiry from a Supabase signed URL token', () => {
    expect(signedUrlExpiry(jwtUrl(2_000_000_000), T)).toBe(2_000_000_000_000);
  });

  it('falls back to the server minimum validity, and never expires data/blob URLs', () => {
    expect(signedUrlExpiry('https://cdn.test/a.webp', T)).toBe(T + URL_FALLBACK_TTL_MS);
    expect(signedUrlExpiry('not a url', T)).toBe(T + URL_FALLBACK_TTL_MS);
    expect(signedUrlExpiry('data:image/png;base64,x', T)).toBe(Number.POSITIVE_INFINITY);
  });

  it('a URL is fresh until 5 minutes before it expires', () => {
    expect(urlIsFresh({ url: 'u', expiresAt: T + 6 * 60_000 }, T)).toBe(true);
    expect(urlIsFresh({ url: 'u', expiresAt: T + 4 * 60_000 }, T)).toBe(false);
    expect(urlIsFresh(undefined, T)).toBe(false);
  });

  it('merges urls events and invalidates on demand', () => {
    let s = run(loaded(), start('a'), ev('a', { type: 'urls', urls: { 'p/a.webp': 'https://cdn.test/a', bad: '' as unknown as string } }));
    expect(s.urls['p/a.webp'].url).toBe('https://cdn.test/a');
    expect(s.urls.bad).toBeUndefined();
    s = run(s, { type: 'urls_invalidate', paths: ['p/a.webp'] });
    expect(urlIsFresh(s.urls['p/a.webp'], T)).toBe(false);
    expect(s.urls['p/a.webp'].url).toBe('https://cdn.test/a'); // kept until re-signed
    const same = run(s, { type: 'urls_invalidate', paths: ['missing'] });
    expect(same).toBe(s);
  });
});

describe('studio helpers', () => {
  it('tabForOps follows the last meaningful op', () => {
    expect(tabForOps([{ op: 'character', id: 'c', patch: {} }])).toBe('cast');
    expect(tabForOps([{ op: 'place', id: 'p', patch: {} }])).toBe('cast');
    expect(tabForOps([{ op: 'style_option', id: 'o', patch: {} }])).toBe('style');
    expect(tabForOps([{ op: 'render', target: { kind: 'style_option', id: 'o' }, patch: {} }])).toBe('style');
    expect(tabForOps([{ op: 'render', target: { kind: 'page', id: 'p' }, patch: {} }])).toBe('pages');
    expect(tabForOps([{ op: 'render', target: { kind: 'sheet', id: 'c' }, patch: {} }])).toBe('cast');
    expect(tabForOps([{ op: 'pages', pages: [] }, { op: 'message', msg: msg('m', 'assistant', 'x') }])).toBe('pages');
    expect(tabForOps([{ op: 'brief', patch: {} }])).toBe('story');
    expect(tabForOps([{ op: 'spend', entry: { id: 's', at: T, kind: 'page', label: 'x', usd: 1, byok: false, estimated: false } }])).toBeNull();
    expect(tabForOps([{ op: 'format', patch: {} }, { op: 'settings', patch: {} }])).toBeNull();
  });

  it('rendering helpers count queued and drawing work', () => {
    const doc = makeSampleDoc();
    expect(renderingPageCount(doc)).toBe(0);
    expect(renderingCount(doc)).toBe(1); // style option b
    const busy = { ...doc, pages: doc.pages.map((p, i) => (i === 1 ? { ...p, render: { ...p.render, status: 'queued' as const } } : p)) };
    expect(renderingPageCount(busy)).toBe(1);
    expect(isTargetRendering(busy, { kind: 'page', id: 'pg_2' })).toBe(true);
    expect(isTargetRendering(busy, { kind: 'page', id: 'pg_1' })).toBe(false);
    expect(isTargetRendering(null, { kind: 'cover' })).toBe(false);
  });

  it('conversationEntries shows streaming drafts on and after committed messages', () => {
    const doc = makeSampleDoc({ conversation: [msg('u1', 'user', 'hi'), msg('a1', 'assistant', 'Hel')] });
    const entries = conversationEntries(doc, { a1: 'Hello', a2: 'Next' });
    expect(entries.map((e) => [e.msg.id, e.draft])).toEqual([
      ['u1', undefined],
      ['a1', 'Hello'],
      ['a2', 'Next']
    ]);
    // a committed message longer than its draft shows the committed text
    expect(conversationEntries(doc, { a1: 'He' })[1].draft).toBeUndefined();
  });
});
