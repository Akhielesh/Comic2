// Comic Studio's alert moments (notify SPEC §5.2), computed from one rendered studio state to the next. Every fixture
// is built through the real studioReducer, so a reply that lands inside an `ops` event is seen with the doc it
// replied in (critique N-M5), and patch streams, Stop and a lost connection stay silent.
import { describe, expect, it } from 'vitest';
import type { StudioEvent } from '../../../shared/comic/events';
import type { DocOp } from '../../../shared/comic/ops';
import { emptyRender, type Card, type ComicDoc, type Gate, type Msg, type RenderState, type RenderTarget } from '../../../shared/comic/doc';
import { lineSourceHash } from '../../../shared/comic/i18n';
import { initialStudioState, studioReducer, type StreamKind, type StudioReducerAction, type StudioState } from '../studioReducer';
import { makeSampleDoc } from '../conversation/testing/fixtures';
import type { AlertDraft } from '../../../services/alerts/types';
import { createTransitionMemo, studioFrameOf, studioTransitions, type StudioAlertFrame } from './studioTransitions';

const T = 1_760_000_100_000;
const PROJECT = 'proj_1';

const baseDoc = (): ComicDoc => {
  const doc = makeSampleDoc();
  return {
    ...doc,
    rev: 5,
    style: { ...doc.style, status: 'locked', options: [] },
    pages: doc.pages.map((p) => ({ ...p, render: emptyRender() })),
    planStatus: 'approved',
    conversation: []
  };
};

/** One studio, rendered after every reducer action, with the alerts each render produced. */
class Studio {
  state: StudioState;
  prev: StudioAlertFrame | null = null;
  memo = createTransitionMemo();
  alerts: AlertDraft[] = [];
  rev: number;
  constructor(doc: ComicDoc = baseDoc()) {
    this.state = studioReducer(initialStudioState(), { type: 'load_success', doc, urls: {}, now: T });
    this.rev = doc.rev;
    this.render();
  }
  render() {
    const next = studioFrameOf(PROJECT, this.state);
    this.alerts.push(...studioTransitions(this.prev, next, this.memo, T));
    this.prev = next;
  }
  dispatch(...actions: StudioReducerAction[]) {
    for (const a of actions) {
      this.state = studioReducer(this.state, a);
      this.render();
    }
    return this;
  }
  start(id: string, kind: StreamKind = 'message', actionType?: string) {
    return this.dispatch({ type: 'stream_start', streamId: id, kind, ...(actionType ? { actionType } : {}), now: T });
  }
  event(id: string, event: StudioEvent) {
    return this.dispatch({ type: 'stream_event', streamId: id, event, now: T });
  }
  ops(id: string, ops: DocOp[], origin?: 'director' | 'job' | 'user') {
    this.rev += 1;
    return this.event(id, { type: 'ops', rev: this.rev, ops, ...(origin ? { origin } : {}) });
  }
  end(id: string, extra: { error?: string; code?: string; aborted?: boolean } = {}) {
    return this.dispatch({ type: 'stream_end', streamId: id, now: T, ...extra });
  }
  kinds() {
    return this.alerts.map((a) => a.kind);
  }
}

const userMsg = (id: string, text = 'Make it rain'): DocOp => ({ op: 'message', msg: { id, role: 'user', text, at: T } as Msg });
const reply = (id: string, cards?: Card[], text = 'Sure — here is the rain.'): DocOp => ({
  op: 'message',
  msg: { id, role: 'assistant', text, at: T, ...(cards ? { cards } : {}) } as Msg
});
const render = (target: RenderTarget, patch: Partial<RenderState>): DocOp => ({ op: 'render', target, patch });
const drawn = (id: string, path = `u/x/p/${id}.webp`): DocOp => render({ kind: 'page', id }, { status: 'ready', asset: { path, source: 'generated', at: T }, updatedAt: T });
const drawing = (id: string): DocOp => render({ kind: 'page', id }, { status: 'rendering', updatedAt: T });
const failed = (id: string, at = T): DocOp => render({ kind: 'page', id }, { status: 'failed', error: 'The model refused.', updatedAt: at });
const options: Card = { type: 'options', id: 'o1', question: 'Which ending?', choices: [{ id: 'a', label: 'Happy' }, { id: 'b', label: 'Sad' }] };
const gate: Gate = {
  id: 'g1',
  action: { type: 'render_pages', pageIds: ['pg_1'] } as Gate['action'],
  title: 'Draw 3 pages',
  summary: '3 pages',
  estimateUsd: 0.3,
  imageCount: 3,
  model: 'm',
  createdAt: T,
  status: 'open',
  reason: 'first_render'
};

describe('a Director turn', () => {
  it('that only talked: one reply alert when the reply lands, keyed by the reply’s message id', () => {
    const s = new Studio();
    s.start('m1').ops('m1', [userMsg('u1')]);
    expect(s.alerts).toEqual([]);
    s.ops('m1', [reply('a1')]);
    expect(s.alerts).toHaveLength(1);
    expect(s.alerts[0]).toMatchObject({ kind: 'reply', key: `comic:${PROJECT}:reply:a1`, target: { app: 'comic', id: PROJECT }, title: 'Rooftop Heist' });
    // The stream ends: nothing more for this turn.
    s.end('m1');
    expect(s.kinds()).toEqual(['reply']);
  });

  it('a reply dispatched inside an ops event is seen with the replied doc (a question in it wins)', () => {
    const s = new Studio();
    s.start('m1').ops('m1', [userMsg('u1'), reply('a1', [options])]);
    expect(s.alerts).toHaveLength(1);
    expect(s.alerts[0]).toMatchObject({ kind: 'question', key: `comic:${PROJECT}:needs:card:a1:o1` });
    s.end('m1');
    expect(s.alerts).toHaveLength(1);
  });

  it('a reply that starts renders gives nothing until the stream settles; then "6 drawn" once', () => {
    const doc = baseDoc();
    const six = { ...doc, pages: [1, 2, 3, 4, 5, 6].map((n) => ({ ...doc.pages[0], id: `pg_${n}`, n, render: emptyRender() })) };
    const s = new Studio(six);
    s.start('m1').ops('m1', [userMsg('u1'), drawing('pg_1')]);
    s.ops('m1', [reply('a1')]);
    expect(s.alerts).toEqual([]);
    for (let n = 1; n <= 6; n += 1) s.ops('m1', [drawn(`pg_${n}`)], 'job');
    expect(s.alerts).toEqual([]);
    s.end('m1');
    expect(s.alerts).toHaveLength(1);
    expect(s.alerts[0]).toMatchObject({ kind: 'drawn', count: 6, pictures: false });
  });

  it('5 drawn and 1 failed: "need a look"', () => {
    const doc = baseDoc();
    const six = { ...doc, pages: [1, 2, 3, 4, 5, 6].map((n) => ({ ...doc.pages[0], id: `pg_${n}`, n, render: emptyRender() })) };
    const s = new Studio(six);
    s.start('a1', 'action', 'approve_gate');
    for (let n = 1; n <= 5; n += 1) s.ops('a1', [drawn(`pg_${n}`)], 'job');
    s.ops('a1', [failed('pg_6')], 'job');
    s.end('a1');
    expect(s.alerts).toHaveLength(1);
    expect(s.alerts[0]).toMatchObject({ kind: 'drawn_issues', count: 5, failedCount: 1 });
  });

  it('a redraw of a page that was already drawn counts (its picture changed)', () => {
    const doc = baseDoc();
    doc.pages[0] = { ...doc.pages[0], render: { status: 'ready', history: [], asset: { path: 'u/x/p/old.webp', source: 'generated', at: T } } };
    const s = new Studio(doc);
    s.start('r1', 'action', 'render_pages').ops('r1', [drawing('pg_1')], 'job').ops('r1', [drawn('pg_1', 'u/x/p/new.webp')], 'job').end('r1');
    expect(s.alerts).toHaveLength(1);
    expect(s.alerts[0]).toMatchObject({ kind: 'drawn', count: 1 });
  });

  it('a cover or a cast sheet reads as "pictures"', () => {
    const s = new Studio();
    s.start('r1', 'action', 'render_cover').ops('r1', [render({ kind: 'cover' }, { status: 'ready', asset: { path: 'u/c.webp', source: 'generated', at: T } })], 'job').end('r1');
    expect(s.alerts[0]).toMatchObject({ kind: 'drawn', count: 1, pictures: true });
  });

  it('two streams settling on the same batch report it once', () => {
    const s = new Studio();
    s.start('m1').start('a1', 'action', 'approve_gate');
    s.ops('a1', [drawn('pg_1'), drawn('pg_2')], 'job');
    s.end('a1');
    s.end('m1');
    expect(s.kinds()).toEqual(['drawn']);
    expect(s.alerts[0].count).toBe(2);
  });

  it('an approval the turn opened is a needs-you, with its picture count', () => {
    const s = new Studio();
    s.start('m1').ops('m1', [userMsg('u1'), { op: 'gate', gate }, reply('a1', [{ type: 'gate', id: 'cg', gateId: 'g1' }])]);
    expect(s.alerts).toHaveLength(1);
    expect(s.alerts[0]).toMatchObject({ kind: 'approval', imageCount: 3, key: `comic:${PROJECT}:needs:gate:g1` });
    s.end('m1');
    expect(s.alerts).toHaveLength(1);
  });

  it('a question that was already open before the stream is not new at its settle', () => {
    const doc = baseDoc();
    doc.conversation = [{ id: 'u0', role: 'user', text: 'Hi', at: T }, { id: 'a0', role: 'assistant', text: 'Which?', at: T, cards: [options] }];
    const s = new Studio(doc);
    s.start('r1', 'action', 'render_pages').ops('r1', [drawn('pg_1')], 'job').end('r1');
    expect(s.kinds()).toEqual(['drawn']);
  });
});

describe('translate', () => {
  const lines = (doc: ComicDoc, count: number) =>
    Object.fromEntries(
      doc.pages
        .flatMap((p) => p.panels.flatMap((panel) => panel.lines))
        .slice(0, count)
        .map((l) => [l.id, { text: '¡Alto ahí!', status: 'machine', sourceHash: lineSourceHash(l), at: T }])
    );

  it('every requested edition complete: "Translation ready" with its language', () => {
    const doc = baseDoc();
    const s = new Studio(doc);
    s.start('t1', 'action', 'translate').ops('t1', [{ op: 'edition', lang: 'es', patch: {} }], 'job');
    s.ops('t1', [{ op: 'translations', lang: 'es', lines: lines(doc, 3) } as DocOp], 'job').end('t1');
    expect(s.alerts).toHaveLength(1);
    expect(s.alerts[0]).toMatchObject({ kind: 'translated', languages: ['es'] });
  });

  it('an edition left incomplete: "A translation needs a look"', () => {
    const doc = baseDoc();
    const s = new Studio(doc);
    s.start('t1', 'action', 'translate').ops('t1', [{ op: 'edition', lang: 'fr', patch: {} }], 'job');
    s.ops('t1', [{ op: 'translations', lang: 'fr', lines: lines(doc, 2) } as DocOp], 'job').end('t1');
    expect(s.alerts).toHaveLength(1);
    expect(s.alerts[0]).toMatchObject({ kind: 'translate_issues', languages: ['fr'] });
  });
});

describe('publish (the chat Publish card)', () => {
  const card = (status: 'running' | 'done' | 'failed'): Card => ({ type: 'publish', id: 'pb', mode: 'publish', status });

  it('done: "Your comic is live"; failed: "Couldn’t publish"', () => {
    const s = new Studio();
    s.start('m1').ops('m1', [userMsg('u1'), reply('a1', [card('running')])]);
    expect(s.alerts).toEqual([]); // a running publish is not a reply worth a chime yet (it is a live card)
    s.ops('m1', [{ op: 'message_patch', id: 'a1', patch: { cards: [card('done')] } }], 'job').end('m1');
    expect(s.kinds()).toEqual(['published']);
    expect(s.alerts[0].key).toBe(`comic:${PROJECT}:publish:pb:done`);

    const f = new Studio();
    f.start('m1').ops('m1', [userMsg('u1'), reply('a1', [card('running')])]);
    f.ops('m1', [{ op: 'message_patch', id: 'a1', patch: { cards: [card('failed')] } }], 'job').end('m1');
    expect(f.kinds()).toEqual(['publish_failed']);
  });
});

describe('what stays silent', () => {
  it('Stop: the stream ends while the studio is cancelling — nothing, even for pages drawn before it', () => {
    const s = new Studio();
    s.start('m1').ops('m1', [userMsg('u1'), drawing('pg_1')]);
    s.dispatch({ type: 'cancel_start' });
    s.ops('m1', [drawn('pg_1')], 'job');
    s.end('m1');
    expect(s.alerts).toEqual([]);
  });

  it('a Stop that could not reach the server aborts the streams locally: silent too', () => {
    const s = new Studio();
    s.start('a1', 'action', 'render_pages').ops('a1', [drawn('pg_1')], 'job');
    s.dispatch({ type: 'cancel_start' });
    s.end('a1', { aborted: true }).dispatch({ type: 'cancel_end' });
    expect(s.alerts).toEqual([]);
  });

  it('a lost connection is never alerted (the server may still finish the turn)', () => {
    const s = new Studio();
    s.start('m1').ops('m1', [userMsg('u1')]);
    s.end('m1', { error: 'Connection lost — the studio stopped responding. Resyncing your comic…' });
    expect(s.alerts).toEqual([]);
  });

  it('BUSY and CANCELLED are not failures; a server error inside the stream is', () => {
    const busy = new Studio();
    busy.start('m1').event('m1', { type: 'error', message: 'Another tab is working.', code: 'BUSY' }).end('m1');
    expect(busy.alerts).toEqual([]);
    const cancelled = new Studio();
    cancelled.start('m1').event('m1', { type: 'error', message: 'Stopped.', code: 'CANCELLED' }).end('m1');
    expect(cancelled.alerts).toEqual([]);
    const broke = new Studio();
    broke.start('m1').event('m1', { type: 'error', message: 'The studio hit a snag.' }).end('m1');
    expect(broke.kinds()).toEqual(['failed']);
    expect(broke.alerts[0].key).toBe(`comic:${PROJECT}:failed:m1`);
  });

  it('patch streams are ignored everywhere', () => {
    const s = new Studio();
    s.start('p1', 'patch').ops('p1', [drawn('pg_1')], 'user').end('p1', { error: 'Save failed', code: 'CONFLICT' });
    expect(s.alerts).toEqual([]);
  });

  it('a needs-you key alerts once per comic, however many streams see it', () => {
    const s = new Studio();
    s.start('m1').ops('m1', [userMsg('u1'), reply('a1', [options])]);
    s.start('a2', 'action', 'library_save').end('a2');
    s.end('m1');
    expect(s.kinds()).toEqual(['question']);
  });
});
