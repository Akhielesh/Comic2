// @vitest-environment node
// resolve_conflict (agent-editor plan §3 A3.1, D3): 'theirs' re-sanitizes the held-back ops against the CURRENT doc and
// commits them with origin 'director' (undoable); a stale or too-big item is refused in plain words and stays open.

import { describe, expect, it } from 'vitest';
import { applyOps, type DocOp } from '../../../../shared/comic/ops.js';
import { DEFAULT_CAPS, type StudioCaps } from '../../../../shared/comic/capabilities.js';
import type { ComicDoc, ConflictCard, ConflictItem, Msg } from '../../../../shared/comic/doc.js';
import type { StudioEvent } from '../../../../shared/comic/events.js';
import { inverseOps } from '../../../../shared/comic/undo.js';
import { startAction } from '../jobs.js';
import { newSession, plannedDoc, testContext } from '../orchestrator.fakes.js';
import { CONFLICT_NOT_AVAILABLE, USE_THEIRS_LABEL, followOps } from './conflict.js';

const ON: StudioCaps = { ...DEFAULT_CAPS, liveAgent: { queue: false, steer: false, conflicts: true } };
const OFF: StudioCaps = { ...DEFAULT_CAPS, liveAgent: { queue: true, steer: false, conflicts: false } };

const text = (id: string, t: string, panelId = 'pn_1_2'): DocOp => ({ op: 'line', pageId: 'pg_1', panelId, id, patch: { text: t } });

const item = (id: string, lineId: string, proposed: DocOp[], extra: Partial<ConflictItem> = {}): ConflictItem => ({
  id,
  where: { pageId: 'pg_1', panelId: 'pn_1_2', lineId, label: `page 1 · panel 2 · line ${lineId === 'ln_a' ? 1 : 2}` },
  mine: 'Mine',
  theirs: 'Theirs',
  proposed,
  ...extra
});

/** Page 1 panel 2 holds ln_a "We have to go" (the creator's mid-turn edit) and ln_b; the director's reply carries the card. */
const setup = (items: ConflictItem[], caps: StudioCaps = ON) => {
  const doc: ComicDoc = plannedDoc();
  doc.pages[0].panels[1].lines = [
    { id: 'ln_a', kind: 'speech', speakerId: 'c_maya', text: 'We have to go' },
    { id: 'ln_b', kind: 'speech', speakerId: 'c_maya', text: 'Line B' }
  ];
  doc.pages[0].balloons = [{ lineId: 'ln_a', x: 0.1, y: 0.1, w: 0.2, pinned: true }];
  const card: ConflictCard = { type: 'conflict', id: 'card_cf', items };
  const reply: Msg = { id: 'msg_reply', role: 'assistant', text: 'Done.', at: 1, cards: [card] };
  doc.conversation = [...doc.conversation, reply];
  const session = newSession(doc);
  const ctx = testContext(session, { caps });
  const answer = (choice: 'mine' | 'theirs', itemIds = items.map((i) => i.id)) =>
    // A UI click, exactly as the route sends it (origin 'user', caps in the options).
    startAction(ctx, { type: 'resolve_conflict', cardId: 'card_cf', itemIds, choice }, { confirmed: false, origin: 'user', caps });
  const cardNow = () => session.doc.conversation.find((m) => m.id === 'msg_reply')!.cards!.find((c): c is ConflictCard => c.type === 'conflict')!;
  const lineText = (id: string) => session.doc.pages[0].panels.flatMap((p) => p.lines).find((l) => l.id === id)?.text;
  return { session, ctx, answer, cardNow, lineText, events: ctx.events as StudioEvent[] };
};

describe('resolve_conflict', () => {
  it("'theirs' re-sanitizes against the current doc and commits with origin director, undoable; the card shows the answer", async () => {
    const { session, answer, cardNow, lineText, events } = setup([item('cf_1', 'ln_a', [text('ln_a', 'Run!')])]);
    const before = session.doc;
    const started = await answer('theirs');
    expect(started.outcome).toEqual({ status: 'done', message: "Used the director's version. Undo brings yours back." });
    expect(lineText('ln_a')).toBe('Run!');
    const batch = events.find((e): e is Extract<StudioEvent, { type: 'ops' }> => e.type === 'ops' && e.origin === 'director');
    expect(batch).toMatchObject({ origin: 'director', label: USE_THEIRS_LABEL, ops: [text('ln_a', 'Run!')] });
    // The client's Undo (shared inverseOps against the doc before the batch) brings the creator's words back.
    expect(applyOps(session.doc, inverseOps(before, batch!.ops)).pages[0].panels[1].lines[0].text).toBe('We have to go');
    expect(cardNow().items[0].resolved).toBe('theirs');
    // Nothing else was said: the card itself shows the outcome.
    expect(session.doc.conversation.at(-1)!.id).toBe('msg_reply');
  });

  it('a stale op (its line deleted since) is refused honestly: nothing re-created, the item stays open', async () => {
    const { session, answer, cardNow, lineText } = setup([item('cf_1', 'ln_a', [text('ln_a', 'Run!')])]);
    session.commit([{ op: 'line', pageId: 'pg_1', panelId: 'pn_1_2', id: 'ln_a', patch: null }], { origin: 'user' });
    const started = await answer('theirs');
    expect(started.outcome.status).toBe('blocked');
    expect(started.outcome.message).toBe("Page 1 · panel 2 · line 1: it was removed since, so the director's version can't be applied. Nothing was changed there.");
    expect(lineText('ln_a')).toBeUndefined();
    expect(cardNow().items[0].resolved).toBeUndefined();
    expect(session.doc.conversation.at(-1)).toMatchObject({ role: 'assistant', text: started.outcome.message, cards: [{ type: 'notice', tone: 'info' }] });
  });

  it('a tooBig item is refused in plain words and never marked answered theirs; mine answers it', async () => {
    const { answer, cardNow } = setup([item('cf_1', 'ln_a', [], { tooBig: true })]);
    const theirs = await answer('theirs');
    expect(theirs.outcome).toMatchObject({ status: 'blocked', message: 'Page 1 · panel 2 · line 1: that change is too big to apply from here; Show me opens it.' });
    expect(cardNow().items[0].resolved).toBeUndefined();
    const mine = await answer('mine');
    expect(mine.outcome).toEqual({ status: 'done', message: 'Kept your version.' });
    expect(cardNow().items[0].resolved).toBe('mine');
  });

  it("'mine' keeps the creator's edit and changes nothing but the card", async () => {
    const { session, answer, cardNow, lineText } = setup([item('cf_1', 'ln_a', [text('ln_a', 'Run!')]), item('cf_2', 'ln_b', [text('ln_b', 'Go!')])]);
    const pages = session.doc.pages;
    const started = await answer('mine');
    expect(started.outcome).toEqual({ status: 'done', message: 'Kept your version of 2 things.' });
    expect(session.doc.pages).toBe(pages);
    expect(lineText('ln_a')).toBe('We have to go');
    expect(cardNow().items.map((i) => i.resolved)).toEqual(['mine', 'mine']);
    // Answering again changes nothing and says so.
    expect((await answer('theirs')).outcome).toEqual({ status: 'done', message: 'Those were already answered.' });
    expect(lineText('ln_a')).toBe('We have to go');
  });

  it('applies the items it can and refuses the rest in words, in one undoable commit', async () => {
    const { session, answer, cardNow, lineText } = setup([
      item('cf_1', 'ln_a', [text('ln_a', 'Run!')]),
      item('cf_2', 'ln_gone', [text('ln_gone', 'Ghost')], { where: { pageId: 'pg_1', lineId: 'ln_gone', label: 'page 1 · panel 2 · line 3' } })
    ]);
    const started = await answer('theirs');
    expect(started.outcome.status).toBe('done');
    expect(started.outcome.message).toContain("Used the director's version.");
    expect(started.outcome.message).toContain("Page 1 · panel 2 · line 3: it was removed since, so the director's version can't be applied.");
    expect(lineText('ln_a')).toBe('Run!');
    expect(lineText('ln_gone')).toBeUndefined();
    expect(cardNow().items.map((i) => i.resolved)).toEqual(['theirs', undefined]);
  });

  it('a server-only op stored on a card is never committed: the client sanitizer refuses it', async () => {
    const { session, answer, cardNow } = setup([item('cf_1', 'ln_a', [{ op: 'page_panels', id: 'pg_1', panels: [] }])]);
    const pages = session.doc.pages;
    const started = await answer('theirs');
    expect(started.outcome.status).toBe('blocked');
    expect(started.outcome.message).toMatch(/can't be applied \(.*can't be changed directly\)/);
    expect(session.doc.pages).toBe(pages);
    expect(cardNow().items[0].resolved).toBeUndefined();
  });

  it("the director's words follow a line the creator moved to another panel since", async () => {
    const { session, answer, lineText } = setup([item('cf_1', 'ln_a', [text('ln_a', 'Run!')])]);
    session.commit([{ op: 'line_move', pageId: 'pg_1', id: 'ln_a', toPanelId: 'pn_1_3' }], { origin: 'user' });
    expect((await answer('theirs')).outcome.status).toBe('done');
    expect(lineText('ln_a')).toBe('Run!');
    expect(session.doc.pages[0].panels[2].lines.map((l) => l.id)).toEqual(['ln_a']);
    expect(session.doc.pages[0].panels[1].lines.map((l) => l.id)).toEqual(['ln_b']);
  });

  it('unknown card or items: a plain refusal and nothing changes', async () => {
    const { session, ctx } = setup([item('cf_1', 'ln_a', [text('ln_a', 'Run!')])]);
    const pages = session.doc.pages;
    const missing = await startAction(ctx, { type: 'resolve_conflict', cardId: 'card_nope', itemIds: ['cf_1'], choice: 'theirs' }, { confirmed: false, caps: ON });
    expect(missing.outcome).toMatchObject({ status: 'blocked', message: 'That question is no longer in the conversation. Nothing was changed.' });
    const none = await startAction(ctx, { type: 'resolve_conflict', cardId: 'card_cf', itemIds: ['cf_x'], choice: 'theirs' }, { confirmed: false, caps: ON });
    expect(none.outcome).toMatchObject({ status: 'blocked', message: 'Nothing on that card matches your answer. Nothing was changed.' });
    await expect(startAction(ctx, { type: 'resolve_conflict', cardId: 'card_cf', itemIds: [], choice: 'theirs' }, { confirmed: false, caps: ON })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(session.doc.pages).toBe(pages);
  });

  it('with the conflict guard off it refuses NOT_AVAILABLE before anything runs', async () => {
    const { session, answer, cardNow } = setup([item('cf_1', 'ln_a', [text('ln_a', 'Run!')])], OFF);
    const pages = session.doc.pages;
    const started = await answer('theirs');
    expect(started.outcome).toMatchObject({ status: 'blocked', code: 'NOT_AVAILABLE', message: CONFLICT_NOT_AVAILABLE });
    expect(session.doc.pages).toBe(pages);
    expect(cardNow().items[0].resolved).toBeUndefined();
  });
});

describe('followOps', () => {
  it('rewrites a moved line to its panel now; refuses ops on a missing line', () => {
    const doc = plannedDoc();
    expect(followOps(doc, [text('ln_1_2', 'Hi', 'pn_1_1')])).toEqual({ ops: [text('ln_1_2', 'Hi', 'pn_1_2')] });
    expect(followOps(doc, [{ op: 'balloon', pageId: 'pg_1', lineId: 'ln_nope', patch: { x: 0.2 } }])).toHaveProperty('stale');
    expect(followOps(doc, [{ op: 'line_style', pageId: 'pg_1', lineIds: ['ln_1_2', 'ln_nope'], patch: { italic: true } }])).toHaveProperty('stale');
    // A new line the director wanted to add passes through (the sanitizer checks its panel).
    const add: DocOp = { op: 'line', pageId: 'pg_1', panelId: 'pn_1_1', id: 'ln_new', patch: { kind: 'caption', text: 'Later' }, index: 0 };
    expect(followOps(doc, [add])).toEqual({ ops: [add] });
    // Ops on the line the item itself adds follow it (its balloon, its look), never "removed since".
    const balloon: DocOp = { op: 'balloon', pageId: 'pg_1', lineId: 'ln_new', patch: { x: 0.2, y: 0.1 } };
    const look: DocOp = { op: 'line_style', pageId: 'pg_1', lineIds: ['ln_new'], patch: { italic: true } };
    expect(followOps(doc, [add, balloon, look])).toEqual({ ops: [add, balloon, look] });
    expect(followOps(doc, [balloon])).toHaveProperty('stale');
  });

  it("'theirs' on a new line the director wanted to add puts it in, with its balloon", async () => {
    const add: DocOp = { op: 'line', pageId: 'pg_1', panelId: 'pn_1_2', id: 'ln_new', patch: { id: 'ln_new', kind: 'caption', text: 'Later that day' }, index: 2 };
    const balloon: DocOp = { op: 'balloon', pageId: 'pg_1', lineId: 'ln_new', patch: { x: 0.6, y: 0.1, w: 0.3 } };
    const { session, answer, lineText } = setup([
      item('cf_1', 'ln_new', [add, balloon], { where: { pageId: 'pg_1', panelId: 'pn_1_2', lineId: 'ln_new', label: 'page 1 · panel 2 · a new line' } })
    ]);
    expect((await answer('theirs')).outcome).toEqual({ status: 'done', message: "Used the director's version. Undo brings yours back." });
    expect(lineText('ln_new')).toBe('Later that day');
    expect(session.doc.pages[0].panels[1].lines.map((l) => l.id)).toEqual(['ln_a', 'ln_b', 'ln_new']);
    expect(session.doc.pages[0].balloons.find((b) => b.lineId === 'ln_new')).toMatchObject({ x: 0.6, y: 0.1 });
  });
});
