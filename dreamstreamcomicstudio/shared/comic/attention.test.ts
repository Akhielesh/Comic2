// "Needs you" in one place (notify SPEC §5.1): an open approval gate first; then a question in any assistant message
// since the person's last message (an open options card with choices, an unresolved conflict, a publish confirm, a
// model-outage choice); then the page plan waiting for its OK (nothing drawing); then looks drawn and waiting to be
// picked. It reads no price and returns no text.
import { describe, expect, it } from 'vitest';
import { anyRenderBusy, needsYouOf } from './attention';
import { createEmptyDoc, emptyRender, type Card, type ComicDoc, type Gate, type Msg, type Page, type RenderState } from './doc';

const NOW = 1_760_000_000_000;
const ready = (path: string): RenderState => ({ status: 'ready', history: [], asset: { path, source: 'generated', at: NOW } });
const page = (id: string, n: number, render: RenderState = emptyRender()): Page => ({
  id,
  n,
  summary: `Page ${n}`,
  layout: 'One wide panel.',
  panels: [{ id: `${id}_p1`, n: 1, size: 'wide', shot: 'wide', action: 'A street', castIds: [], lines: [] }],
  render,
  balloons: []
});
const msg = (id: string, role: Msg['role'], cards?: Card[]): Msg => ({ id, role, text: role === 'user' ? 'Hi' : 'Here you go.', at: NOW, ...(cards ? { cards } : {}) });
const options = (id: string, answered?: string[]): Card => ({
  type: 'options',
  id,
  question: 'Which ending?',
  choices: [
    { id: 'a', label: 'Happy' },
    { id: 'b', label: 'Sad' }
  ],
  ...(answered ? { answered } : {})
});
const gate = (status: Gate['status'] = 'open'): Gate => ({
  id: 'g1',
  action: { type: 'render_pages', pageIds: ['pg_1'] } as Gate['action'],
  title: 'Draw 3 pages',
  summary: 'Three pages',
  estimateUsd: 0.42,
  imageCount: 3,
  model: 'm',
  createdAt: NOW,
  status,
  reason: 'first_render'
});
const doc = (over: Partial<ComicDoc> = {}): ComicDoc => ({ ...createEmptyDoc('p1', 'Spice Market', NOW), ...over });

describe('needsYouOf', () => {
  it('nothing waits on an empty or missing doc', () => {
    expect(needsYouOf(null)).toBeNull();
    expect(needsYouOf(undefined)).toBeNull();
    expect(needsYouOf(doc())).toBeNull();
  });

  it('an open gate wins, with its picture count (never its price)', () => {
    const d = doc({
      gate: gate(),
      conversation: [msg('u1', 'user'), msg('a1', 'assistant', [{ type: 'gate', id: 'cg', gateId: 'g1' }, options('o1')])]
    });
    const n = needsYouOf(d);
    expect(n).toEqual({ why: 'approval', key: 'gate:g1', imageCount: 3 });
    expect(JSON.stringify(n)).not.toContain('0.42');
    expect(needsYouOf(doc({ gate: gate('approved') }))).toBeNull();
  });

  it('an open options card with choices is a question; answered or without choices it is not', () => {
    expect(needsYouOf(doc({ conversation: [msg('u1', 'user'), msg('a1', 'assistant', [options('o1')])] }))).toEqual({ why: 'question', key: 'card:a1:o1' });
    expect(needsYouOf(doc({ conversation: [msg('u1', 'user'), msg('a1', 'assistant', [options('o1', ['a'])])] }))).toBeNull();
    const noChoices: Card = { type: 'options', id: 'o2', question: 'Anything else?', choices: [] };
    expect(needsYouOf(doc({ conversation: [msg('u1', 'user'), msg('a1', 'assistant', [noChoices])] }))).toBeNull();
  });

  it('a question the agent has since moved on from no longer counts: the card has settled (options go once moved on)', () => {
    const later = { ...msg('a2', 'assistant'), at: NOW + 1000 };
    const d = doc({ conversation: [msg('u1', 'user'), msg('a1', 'assistant', [options('o1')]), later] });
    expect(needsYouOf(d)).toBeNull();
  });

  it('a question still counts when the only later message comes from work that was already running when it was asked', () => {
    const background = { ...msg('a2', 'assistant'), at: NOW + 1000, runAt: NOW - 5000 };
    const d = doc({ conversation: [msg('u1', 'user'), msg('a1', 'assistant', [options('o1')]), background] });
    expect(needsYouOf(d)).toEqual({ why: 'question', key: 'card:a1:o1' });
  });

  it('a card the person moved past (a later message of theirs) does not', () => {
    const d = doc({ conversation: [msg('a1', 'assistant', [options('o1')]), msg('u2', 'user'), msg('a2', 'assistant')] });
    expect(needsYouOf(d)).toBeNull();
  });

  it('an unresolved conflict card, a publish confirm and a model-outage choice are questions', () => {
    const conflict: Card = { type: 'conflict', id: 'cf', items: [{ id: 'i1', target: { kind: 'page', pageId: 'pg_1' }, mine: 'x', theirs: 'y' }] } as unknown as Card;
    expect(needsYouOf(doc({ conversation: [msg('u1', 'user'), msg('a1', 'assistant', [conflict])] }))).toEqual({ why: 'question', key: 'card:a1:cf' });
    const publish: Card = { type: 'publish', id: 'pb', mode: 'publish', status: 'pending' };
    expect(needsYouOf(doc({ conversation: [msg('u1', 'user'), msg('a1', 'assistant', [publish])] }))).toEqual({ why: 'question', key: 'card:a1:pb' });
    const done: Card = { type: 'publish', id: 'pb', mode: 'publish', status: 'done' };
    expect(needsYouOf(doc({ conversation: [msg('u1', 'user'), msg('a1', 'assistant', [done])] }))).toBeNull();
    const outage: Card = { type: 'model_outage', id: 'mo', modelId: 'm', options: [] };
    expect(needsYouOf(doc({ conversation: [msg('u1', 'user'), msg('a1', 'assistant', [outage])] }))).toEqual({ why: 'question', key: 'card:a1:mo' });
  });

  it('a credit card (a run stopped on an empty key, a step that did not fit) waits on the person until they move past it', () => {
    // Its own reason: it waits on a top-up or a key switch, not on an answer to the Director.
    const stopped: Card = { type: 'credit', id: 'cr', reason: 'stopped', payer: 'own_key', provider: 'openrouter', drawn: 2, notStarted: 4 };
    expect(needsYouOf(doc({ conversation: [msg('u1', 'user'), msg('a1', 'assistant', [stopped])] }))).toEqual({ why: 'credit', key: 'card:a1:cr' });
    const short: Card = { type: 'credit', id: 'cs', reason: 'short', payer: 'allowance', leftPct: 0.5, needPct: 4 };
    expect(needsYouOf(doc({ conversation: [msg('u1', 'user'), msg('a1', 'assistant', [short])] }))).toEqual({ why: 'credit', key: 'card:a1:cs' });
    // Moved past (a later message of theirs): nothing waits.
    expect(needsYouOf(doc({ conversation: [msg('a1', 'assistant', [stopped]), msg('u2', 'user'), msg('a2', 'assistant')] }))).toBeNull();
  });

  it('the page plan waiting for its OK; not while a render runs, not once approved, not without pages', () => {
    const conv = [msg('u1', 'user'), msg('a1', 'assistant', [{ type: 'plan', id: 'pl' }])];
    expect(needsYouOf(doc({ planStatus: 'draft', pages: [page('pg_1', 1)], conversation: conv }))).toEqual({ why: 'plan', key: 'plan:a1:pl' });
    expect(needsYouOf(doc({ planStatus: 'draft', pages: [page('pg_1', 1, { ...emptyRender(), status: 'rendering' })], conversation: conv }))).toBeNull();
    expect(needsYouOf(doc({ planStatus: 'approved', pages: [page('pg_1', 1)], conversation: conv }))).toBeNull();
    expect(needsYouOf(doc({ planStatus: 'draft', pages: [], conversation: conv }))).toBeNull();
    // A breakdown card counts too, unless it is a gate's own breakdown.
    const bd = [msg('u1', 'user'), msg('a1', 'assistant', [{ type: 'breakdown', id: 'bd' }])];
    expect(needsYouOf(doc({ planStatus: 'draft', pages: [page('pg_1', 1)], conversation: bd }))).toEqual({ why: 'plan', key: 'plan:a1:bd' });
    const gated = [msg('u1', 'user'), msg('a1', 'assistant', [{ type: 'breakdown', id: 'bd', gateId: 'gx' }])];
    expect(needsYouOf(doc({ planStatus: 'draft', pages: [page('pg_1', 1)], conversation: gated }))).toBeNull();
  });

  it('looks drawn and waiting to be picked; a locked style or nothing drawn is not', () => {
    const conv = [msg('u1', 'user'), msg('a1', 'assistant', [{ type: 'style_choice', id: 'sc' }])];
    const options2 = [
      { id: 'so1', name: 'Ink', spec: 'Ink', render: ready('u/so1.webp') },
      { id: 'so2', name: 'Pastel', spec: 'Pastel', render: { ...emptyRender(), status: 'rendering' as const } }
    ];
    const base = createEmptyDoc('p1', 'Spice Market', NOW);
    expect(needsYouOf(doc({ style: { ...base.style, status: 'drafted', options: options2 }, conversation: conv }))).toEqual({ why: 'style', key: 'style:a1:sc' });
    expect(needsYouOf(doc({ style: { ...base.style, status: 'locked', options: options2 }, conversation: conv }))).toBeNull();
    expect(needsYouOf(doc({ style: { ...base.style, status: 'drafted', options: [options2[1]] }, conversation: conv }))).toBeNull();
    const presets = [msg('u1', 'user'), msg('a1', 'assistant', [{ type: 'style_presets', id: 'sp', presetIds: ['noir-ink'] }])];
    expect(needsYouOf(doc({ conversation: presets }))).toEqual({ why: 'style', key: 'style:a1:sp' });
    const picked = [msg('u1', 'user'), msg('a1', 'assistant', [{ type: 'style_presets', id: 'sp', presetIds: ['noir-ink'], picked: 'noir-ink' }])];
    expect(needsYouOf(doc({ conversation: picked }))).toBeNull();
  });

  it('order: gate, then question, then plan, then style', () => {
    const cards: Card[] = [{ type: 'style_presets', id: 'sp', presetIds: ['noir-ink'] }, { type: 'plan', id: 'pl' }, options('o1')];
    const conv = [msg('u1', 'user'), msg('a1', 'assistant', cards)];
    const base = { planStatus: 'draft' as const, pages: [page('pg_1', 1)], conversation: conv };
    expect(needsYouOf(doc({ ...base, gate: gate() }))?.why).toBe('approval');
    expect(needsYouOf(doc(base))?.why).toBe('question');
    expect(needsYouOf(doc({ ...base, conversation: [msg('u1', 'user'), msg('a1', 'assistant', cards.slice(0, 2))] }))?.why).toBe('plan');
    expect(needsYouOf(doc({ ...base, conversation: [msg('u1', 'user'), msg('a1', 'assistant', cards.slice(0, 1))] }))?.why).toBe('style');
  });
});

describe('anyRenderBusy', () => {
  it('sees a queued or running render on any target', () => {
    expect(anyRenderBusy(null)).toBe(false);
    expect(anyRenderBusy(doc({ pages: [page('pg_1', 1, ready('u/1.webp'))] }))).toBe(false);
    expect(anyRenderBusy(doc({ pages: [page('pg_1', 1, { ...emptyRender(), status: 'queued' })] }))).toBe(true);
    const base = createEmptyDoc('p1', 'x', NOW);
    expect(anyRenderBusy(doc({ cover: { ...base.cover, render: { ...emptyRender(), status: 'rendering' } } }))).toBe(true);
    expect(
      anyRenderBusy(doc({ cast: [{ id: 'c1', name: 'Maya', tier: 'lead', look: { summary: 'x' }, refs: [], sheet: { ...emptyRender(), status: 'rendering' } }] }))
    ).toBe(true);
    expect(anyRenderBusy(doc({ places: [{ id: 'pl1', name: 'Docks', look: 'x', refs: [], sheet: { ...emptyRender(), status: 'queued' } }] }))).toBe(true);
    expect(
      anyRenderBusy(doc({ style: { ...base.style, options: [{ id: 'so', name: 'x', spec: 'x', render: { ...emptyRender(), status: 'rendering' } }] } }))
    ).toBe(true);
  });
});
