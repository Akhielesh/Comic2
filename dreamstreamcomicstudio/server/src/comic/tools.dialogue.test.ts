// @vitest-environment node
// Wave 2 B-TOOL (agent-editor plan §3 B3, A3.1, A3.3, A4): dialogue_edit runs the deterministic dialogue engine
// (shared/comic/dialogue) behind the conflict guard; offer_next adds free say-chips; ask_user options carry pictures; the
// director's activity events say where it works. All free: no model call, no spend.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CAPS, type StudioCaps } from '../../../shared/comic/capabilities.js';
import { isPageStale, pageSpecHash, type ComicDoc, type NextStep, type Page } from '../../../shared/comic/doc.js';
import { STEER_LIMITS } from '../../../shared/comic/events.js';
import { newSession, plannedDoc, testContext, type TestContext } from './orchestrator.fakes.js';
import {
  OFFER_NEXT_MAX,
  activityWhere,
  buildDirectorTools,
  buildTurnToolset,
  confirmAnswerOf,
  createDirectorTurn,
  dialogueEditTool,
  offerNextTool,
  optionVisualOf,
  recentPageIdsOf,
  secondLineArgs,
  type DirectorTool,
  type DirectorTurn
} from './tools.js';
import { toolGroups } from './tools/index.js';

// The engine's follow-up chips, replaced per test (the chip filter's proof needs a chip the engine never makes today).
const engine = vi.hoisted(() => ({ followUps: undefined as NextStep[] | undefined }));
vi.mock('../../../shared/comic/dialogue/index.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../shared/comic/dialogue/index.js')>();
  return {
    ...real,
    compileDialogue: (...args: Parameters<typeof real.compileDialogue>) => {
      const run = real.compileDialogue(...args);
      return engine.followUps ? { ...run, followUps: engine.followUps } : run;
    }
  };
});

beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

const GUARD_ON: StudioCaps = { ...DEFAULT_CAPS, liveAgent: { queue: false, steer: false, conflicts: true } };

/** plannedDoc: MAYA speaks on page 1 panel 2 (ln_1_2) and page 2 panel 2 (ln_2_2); ARJUN on page 3 panel 2 (ln_3_2). */
const lineOf = (doc: ComicDoc, id: string) => doc.pages.flatMap((p) => p.panels.flatMap((pn) => pn.lines)).find((l) => l.id === id);

let ctx: TestContext;
let turn: DirectorTurn;
let tool: DirectorTool;
const setup = (opts: { doc?: ComicDoc; caps?: StudioCaps; focus?: DirectorTurn['focus']; userText?: string } = {}) => {
  ctx = testContext(newSession(opts.doc ?? plannedDoc()), opts.caps ? { caps: opts.caps } : {});
  turn = createDirectorTurn({ userText: opts.userText ?? 'x', startRev: ctx.session.doc.rev, ...(opts.focus ? { focus: opts.focus } : {}) });
  tool = dialogueEditTool(ctx, turn);
};

describe('dialogue_edit', () => {
  it('a single match applies: one free, undoable director step, the engine\'s sentence, and its follow-up chips', async () => {
    setup();
    const rev = ctx.session.doc.rev;
    const out = await tool.execute({ action: 'set_kind', target: { speaker: 'Arjun' }, kind: 'shout' });
    expect(out).toMatch(/shout/i);
    expect(out).toMatch(/Free — undoable\.$/);
    expect(lineOf(ctx.session.doc, 'ln_3_2')).toMatchObject({ kind: 'shout', speakerId: 'c_arjun', text: 'Line on page 3' });
    // One commit, origin director (the client's undo stack takes it), with the engine's label.
    expect(ctx.session.doc.rev).toBe(rev + 1);
    const ops = ctx.events.filter((e) => e.type === 'ops');
    expect(ops.at(-1)).toMatchObject({ origin: 'director', label: expect.any(String) });
    // Follow-ups from the engine (plan §3 A4): free say-chips only, never an action.
    expect(turn.nextSteps.length).toBeGreaterThan(0);
    expect(turn.nextSteps.every((s) => !s.action && (!!s.say || !!s.client))).toBe(true);
    expect(turn.askedUser).toBe(false);
  });

  it('2 or more matches: an options card with a balloon picture per line, askedUser set, nothing changed', async () => {
    setup();
    const rev = ctx.session.doc.rev;
    const out = await tool.execute({ action: 'set_kind', target: { speaker: 'Maya' }, kind: 'whisper' });
    expect(out).toMatch(/^Asked: "Which line\?" with 2 choices \(each shows its balloon\)\. Nothing changed yet\./);
    expect(ctx.session.doc.rev).toBe(rev);
    expect(turn.askedUser).toBe(true);
    expect(turn.question).toBe('Which line?');
    const card = turn.cards.find((c) => c.type === 'options');
    expect(card).toMatchObject({ type: 'options', question: 'Which line?', allowCustom: true });
    const choices = card && card.type === 'options' ? card.choices : [];
    expect(choices.map((c) => c.visual)).toEqual([
      { kind: 'balloon', pageId: 'pg_1', lineId: 'ln_1_2' },
      { kind: 'balloon', pageId: 'pg_2', lineId: 'ln_2_2' }
    ]);
    expect(choices.every((c) => /^P\d · panel \d · MAYA: /.test(c.label) && !!c.reply)).toBe(true);
    // One question per turn, like ask_user.
    expect(await tool.execute({ action: 'set_kind', target: { speaker: 'Maya' }, kind: 'shout' })).toMatch(/^Error: You already asked/);
  });

  it('the selection wins: "make it a whisper" with a balloon selected changes that line only', async () => {
    setup({ focus: { pageId: 'pg_2', lineIds: ['ln_2_2'] } });
    await tool.execute({ action: 'set_kind', target: { selected: true }, kind: 'whisper' });
    expect(lineOf(ctx.session.doc, 'ln_2_2')?.kind).toBe('whisper');
    expect(lineOf(ctx.session.doc, 'ln_1_2')?.kind).toBe('speech');
  });

  it('a conflict: the creator\'s mid-turn edit of the same line wins, the result says "Conflict:" and turn.conflicts holds it', async () => {
    setup({ caps: GUARD_ON });
    ctx.session.commit([{ op: 'line', pageId: 'pg_3', panelId: 'pn_3_2', id: 'ln_3_2', patch: { text: 'Mine!' } }], { origin: 'user' });
    const out = await tool.execute({ action: 'edit_text', target: { line_ids: ['ln_3_2'] }, text: 'Theirs.' });
    expect(out).toMatch(/^Conflict: you changed page 3 · panel 2/);
    expect(out).toContain('("Mine!")');
    expect(lineOf(ctx.session.doc, 'ln_3_2')?.text).toBe('Mine!');
    expect(turn.conflicts).toHaveLength(1);
    expect(turn.conflicts![0]).toMatchObject({ where: { pageId: 'pg_3', lineId: 'ln_3_2' }, mine: 'Mine!' });
    expect(turn.conflicts![0].proposed).toEqual([{ op: 'line', pageId: 'pg_3', panelId: 'pn_3_2', id: 'ln_3_2', patch: { text: 'Theirs.' } }]);
  });

  it('the guard off: the same edit applies as before (no conflict bookkeeping)', async () => {
    setup();
    ctx.session.commit([{ op: 'line', pageId: 'pg_3', panelId: 'pn_3_2', id: 'ln_3_2', patch: { text: 'Mine!' } }], { origin: 'user' });
    await tool.execute({ action: 'edit_text', target: { line_ids: ['ln_3_2'] }, text: 'Theirs.' });
    expect(lineOf(ctx.session.doc, 'ln_3_2')?.text).toBe('Theirs.');
    expect(turn.conflicts ?? []).toEqual([]);
  });

  /** Four pages with a speech line each: above RESOLVE_LIMITS.confirmPages, so "every speech line" confirms first. */
  const fourPages = () => {
    const doc = plannedDoc();
    const extra: Page = JSON.parse(JSON.stringify(doc.pages[2]).replace(/_3(?=["_])/g, '_4'));
    extra.n = 4;
    doc.pages.push(extra);
    return doc;
  };
  const PLURAL = { action: 'set_kind', target: { kind: 'speech', all: true }, kind: 'whisper' };
  const allSpeech = () => ctx.session.doc.pages.every((p) => p.panels[1].lines[0].kind === 'speech');
  /** End the turn the way runDirectorTurn does (its reply with the cards), then the creator's next message. */
  const nextTurn = (said: string) => {
    ctx.session.commit([
      { op: 'message', msg: { id: `m_a${ctx.session.doc.rev}`, role: 'assistant', text: 'Asked.', at: 1, cards: turn.cards } },
      { op: 'message', msg: { id: `m_u${ctx.session.doc.rev}`, role: 'user', text: said, at: 2 } }
    ]);
    turn = createDirectorTurn({ userText: said, startRev: ctx.session.doc.rev });
    tool = dialogueEditTool(ctx, turn);
  };

  it('a big plural asks once to confirm; the re-call with confirmed:true after the creator\'s yes applies it', async () => {
    setup({ doc: fourPages() });
    const asked = await tool.execute(PLURAL);
    expect(asked).toMatch(/^Asked: "That changes 4 lines on 4 pages\. Go ahead\?/);
    const card = turn.cards.find((c) => c.type === 'options');
    expect(card && card.type === 'options' ? card.choices.map((c) => c.reply) : []).toContain('Yes, change all 4 of them.');
    expect(allSpeech()).toBe(true);
    // The next turn: the creator tapped "Yes, all 4" (its reply is the message).
    nextTurn('Yes, change all 4 of them.');
    expect(confirmAnswerOf(ctx, turn)).toBe(4);
    await tool.execute({ ...PLURAL, confirmed: true });
    expect(ctx.session.doc.pages.every((p) => p.panels[1].lines[0].kind === 'whisper')).toBe(true);
  });

  it('confirmed:true on a first call (or after any other answer) still asks "Go ahead?" and changes nothing', async () => {
    setup({ doc: fourPages() });
    const rev = ctx.session.doc.rev;
    expect(confirmAnswerOf(ctx, turn)).toBeUndefined();
    expect(await tool.execute({ ...PLURAL, confirmed: true })).toMatch(/^Asked: "That changes 4 lines on 4 pages\. Go ahead\?/);
    expect(ctx.session.doc.rev).toBe(rev);
    expect(allSpeech()).toBe(true);
    // The creator answered something else: still no skip.
    nextTurn('Only the first one');
    expect(confirmAnswerOf(ctx, turn)).toBeUndefined();
    expect(await tool.execute({ ...PLURAL, confirmed: true })).toMatch(/^Asked: "That changes 4 lines/);
    expect(allSpeech()).toBe(true);
  });

  it('a yes for a different count does not confirm this edit', async () => {
    setup({ doc: fourPages() });
    await tool.execute(PLURAL);
    nextTurn('Yes, change all 4 of them.');
    // The comic changed meanwhile: "every speech line" is now 5 lines, which the creator never saw.
    const extra: Page = JSON.parse(JSON.stringify(ctx.session.doc.pages[3]).replace(/_4(?=["_])/g, '_5'));
    extra.n = 5;
    ctx.session.commit([{ op: 'pages', pages: [...ctx.session.doc.pages, extra] }]);
    expect(await tool.execute({ ...PLURAL, confirmed: true })).toMatch(/^Asked: "That changes 5 lines/);
    expect(allSpeech()).toBe(true);
  });

  it('an unknown font is carried through: the engine asks with the nearest fonts and changes nothing', async () => {
    setup({ focus: { pageId: 'pg_3', lineIds: ['ln_3_2'] } });
    const rev = ctx.session.doc.rev;
    const out = await tool.execute({ action: 'restyle', target: { selected: true }, scope: 'line', style: { font: 'Comic Sans' } });
    expect(out).toMatch(/^Asked:/);
    expect(ctx.session.doc.rev).toBe(rev);
    const card = turn.cards.find((c) => c.type === 'options');
    expect(card && card.type === 'options' ? card.choices.map((c) => c.label).filter((l) => l.startsWith('Use ')).length : 0).toBeGreaterThan(0);
  });

  it('a style word converts with the lettering engine (size stays relative); a bad value is a fix-it error', async () => {
    setup({ focus: { pageId: 'pg_3', lineIds: ['ln_3_2'] } });
    await tool.execute({ action: 'restyle', target: { selected: true }, scope: 'line', style: { text_color: 'red', shape: 'cloud' } });
    expect(lineOf(ctx.session.doc, 'ln_3_2')?.style).toMatchObject({ textColor: expect.stringMatching(/^#/), shape: 'cloud' });
    expect(await tool.execute({ action: 'restyle', target: { selected: true }, scope: 'line', style: { shape: 'hexagon' } })).toMatch(/^Error: Unknown bubble shape/);
    expect(await tool.execute({ action: 'nope' })).toMatch(/^Error: Unknown action/);
  });

  it('is a core tool: offered every turn whatever the words (GROUP_HINTS cannot drop it)', () => {
    setup();
    const names = buildDirectorTools(ctx, createDirectorTurn({ userText: 'hello' })).map((t) => t.spec.function.name);
    expect(names).toContain('dialogue_edit');
    // offer_next is not core (it would cost every turn a group seat); it fills a seat the groups leave free.
    expect(names).not.toContain('offer_next');
    const set = buildTurnToolset(ctx, createDirectorTurn({ userText: 'hello' }), toolGroups());
    expect(set.tools.length).toBeLessThanOrEqual(30);
    expect(set.tools.at(-1)?.spec.function.name).toBe('offer_next');
    expect(set.activity.offer_next).toEqual(expect.any(String));
  });

  it('engine follow-ups never carry a spend action through dialogue_edit, on an apply or an ask', async () => {
    engine.followUps = [
      { label: 'Redraw it', action: { type: 'render_pages' } },
      { label: 'Make it a shout', say: 'Make it a shout' }
    ];
    try {
      setup({ focus: { pageId: 'pg_3', lineIds: ['ln_3_2'] } });
      await tool.execute({ action: 'set_kind', target: { selected: true }, kind: 'whisper' });
      expect(lineOf(ctx.session.doc, 'ln_3_2')?.kind).toBe('whisper');
      expect(turn.nextSteps).toContainEqual({ label: 'Make it a shout', say: 'Make it a shout' });
      expect(turn.nextSteps.some((s) => !!s.action)).toBe(false);
      setup();
      await tool.execute({ action: 'set_kind', target: { speaker: 'Maya' }, kind: 'whisper' });
      const card = turn.cards.find((c) => c.type === 'options');
      expect(card && card.type === 'options' ? card.choices.map((c) => c.label) : []).not.toContain('Redraw it');
      expect(turn.nextSteps.some((s) => !!s.action)).toBe(false);
    } finally {
      engine.followUps = undefined;
    }
  });

  it('a held add leaves no balloon behind and claims nothing (the creator reordered that panel mid-turn)', async () => {
    const doc = plannedDoc();
    doc.format = { ...doc.format, lettering: 'overlay' };
    doc.pages[0].panels[1].lines.push({ id: 'ln_x', kind: 'caption', text: 'Later.' });
    doc.pages[0].render = { ...doc.pages[0].render, status: 'ready', specHash: pageSpecHash(doc, doc.pages[0]), asset: { path: 'p1.png' } } as Page['render'];
    setup({ doc, caps: GUARD_ON });
    ctx.session.commit([{ op: 'line_move', pageId: 'pg_1', id: 'ln_x', toPanelId: 'pn_1_2', index: 0 }], { origin: 'user' });
    const out = await tool.execute({ action: 'add', target: { page: 1, panel: 2 }, kind: 'sfx', text: 'BOOM' });
    expect(out).toMatch(/^Conflict: you changed page 1 · panel 2 · a new line/);
    expect(out).not.toMatch(/Added|BOOM/);
    const d = ctx.session.doc;
    expect(d.pages[0].panels[1].lines.map((l) => l.id)).toEqual(['ln_x', 'ln_1_2']);
    const ids = new Set(d.pages[0].panels.flatMap((p) => p.lines.map((l) => l.id)));
    expect(d.pages[0].balloons.every((b) => ids.has(b.lineId))).toBe(true);
    expect(isPageStale(d, d.pages[0])).toBe(false);
    // "Use the director's" brings the balloon along with its line.
    expect(turn.conflicts).toHaveLength(1);
    expect(turn.conflicts![0].proposed.map((op) => op.op)).toEqual(['line', 'balloon']);
  });

  it('a swap is one move: a creator edit that holds one of its line moves holds all of it (half a swap scrambles the panel)', async () => {
    const make = () => {
      const doc = plannedDoc();
      doc.pages[0].panels[1].lines.push({ id: 'ln_b', kind: 'caption', text: 'Meanwhile.' }, { id: 'ln_c', kind: 'caption', text: 'Later.' });
      return doc;
    };
    const order = () => ctx.session.doc.pages[0].panels[1].lines.map((l) => l.id);
    // Swapping the first and the last of three lines moves ln_c to the front and ln_b after it (readingOrder.ts
    // lineOrderOps). The creator edited ln_b meanwhile, which holds its move: without the unit, ln_c alone would move
    // and the panel would read [ln_c, ln_1_2, ln_b], neither order.
    const mine = { op: 'line' as const, pageId: 'pg_1', panelId: 'pn_1_2', id: 'ln_b', patch: { text: 'Mine!' } };
    setup({ doc: make(), caps: GUARD_ON });
    ctx.session.commit([mine], { origin: 'user' });
    const out = await tool.execute({ action: 'swap', target: { line_ids: ['ln_1_2', 'ln_c'] } });
    expect(out).toMatch(/^Conflict:/);
    expect(order()).toEqual(['ln_1_2', 'ln_b', 'ln_c']);
    expect(turn.conflicts).toHaveLength(1);
    expect(turn.conflicts![0].proposed.filter((op) => op.op === 'line_move').length).toBeGreaterThan(1);
    // Guard off: the swap applies whole.
    setup({ doc: make() });
    ctx.session.commit([mine], { origin: 'user' });
    await tool.execute({ action: 'swap', target: { line_ids: ['ln_1_2', 'ln_c'] } });
    expect(order()).toEqual(['ln_c', 'ln_b', 'ln_1_2']);
  });

  it('a plural edit with one line held says what it did, never the whole', async () => {
    setup({ caps: GUARD_ON });
    ctx.session.commit([{ op: 'line', pageId: 'pg_1', panelId: 'pn_1_2', id: 'ln_1_2', patch: { text: 'Mine!' } }], { origin: 'user' });
    const out = await tool.execute({ action: 'set_kind', target: { speaker: 'Maya', all: true }, kind: 'whisper' });
    expect(out).toMatch(/^Did “.+” for 1 of the 2 lines; the rest waits for the creator\. Conflict: you changed page 1 · panel 2/);
    expect(lineOf(ctx.session.doc, 'ln_1_2')).toMatchObject({ kind: 'speech', text: 'Mine!' });
    expect(lineOf(ctx.session.doc, 'ln_2_2')?.kind).toBe('whisper');
  });

  it('second, the other line, is named in words: its [id], its speaker, or words from it', () => {
    const d = plannedDoc();
    expect(secondLineArgs(d, '[ln_2_2]')).toEqual({ line_ids: ['ln_2_2'] });
    expect(secondLineArgs(d, "Arjun's line")).toEqual({ speaker: 'Arjun' });
    expect(secondLineArgs(d, '“Line on page 2”')).toEqual({ text_contains: 'Line on page 2' });
    expect(secondLineArgs(d, { speaker: 'Maya' })).toEqual({ speaker: 'Maya' });
    expect(secondLineArgs(d, '  ')).toBeUndefined();
  });
});

describe('offer_next', () => {
  it('adds up to 2 free say-chips, never an action, and never ends the turn', async () => {
    setup();
    const offer = offerNextTool(ctx, turn);
    const out = await offer.execute({
      chips: [
        { label: 'Make it a shout', say: 'Make that line a shout', action: { type: 'render_pages' } },
        'Try another font',
        { label: 'Third one', say: 'x' }
      ]
    });
    expect(out).toBe('Offered "Make it a shout" and "Try another font" under your reply (free taps that send their words). Keep going, or answer now.');
    expect(turn.nextSteps).toEqual([
      { label: 'Make it a shout', say: 'Make that line a shout' },
      { label: 'Try another font', say: 'Try another font' }
    ]);
    expect(turn.nextSteps.some((s) => 'action' in s || 'client' in s)).toBe(false);
    expect(turn.askedUser).toBe(false);
    expect(turn.cards).toEqual([]);
    expect(OFFER_NEXT_MAX).toBe(2);
    expect(await offer.execute({ chips: ['More'] })).toMatch(/^Error: You already offered 2 chips/);
    expect(await offerNextTool(ctx, createDirectorTurn()).execute({ chips: [] })).toMatch(/^Error: Pass 1–2 chips/);
  });

  it('governed users never read dollars on a chip', async () => {
    // Not an admin, no own key, no "ungoverned" usage answer: usage terms, never dollars (costText.ts costViewFor).
    setup({ caps: { ...DEFAULT_CAPS, admin: false, byok: false } });
    await offerNextTool(ctx, turn).execute({ chips: [{ label: 'Draw page 2 ($0.40)', say: 'Draw page 2 for $0.40' }] });
    expect(JSON.stringify(turn.nextSteps)).not.toContain('$');
  });

  it('governed users never read cents on a chip either: the price aside goes, a priced chip is not offered', async () => {
    setup({ caps: { ...DEFAULT_CAPS, admin: false, byok: false } });
    await offerNextTool(ctx, turn).execute({ chips: [{ label: 'Redraw it (40¢)', say: 'Redraw page 2 (about 40 cents)' }, { label: 'Pay 40¢ more', say: 'go' }] });
    expect(turn.nextSteps).toEqual([{ label: 'Redraw it', say: 'Redraw page 2' }]);
    expect(JSON.stringify(turn.nextSteps)).not.toMatch(/¢|cents?\b/);
    // A dollar view (an admin) keeps the words as written.
    setup();
    await offerNextTool(ctx, turn).execute({ chips: [{ label: 'Redraw it (40¢)', say: 'Redraw page 2' }] });
    expect(turn.nextSteps).toEqual([{ label: 'Redraw it (40¢)', say: 'Redraw page 2' }]);
  });
});

describe('ask_user option pictures (plan §3 A3.3)', () => {
  it('balloon and spot visuals are checked against the doc; anything else is dropped', async () => {
    setup();
    const ask = buildDirectorTools(ctx, turn).find((t) => t.spec.function.name === 'ask_user')!;
    await ask.execute({
      question: 'Where should it go?',
      options: [
        { label: 'This one', visual: { kind: 'balloon', lineId: 'ln_2_2' } },
        { label: 'Top left of panel 1', visual: { kind: 'spot', page: 2, panel: 1, cell: 'top-left' } },
        { label: 'Top of the page', visual: { kind: 'spot', page: 2, cell: 'top' } },
        { label: 'Gone line', visual: { kind: 'balloon', lineId: 'ln_nope' } },
        { label: 'Bad cell', visual: { kind: 'spot', page: 2, cell: 'middle-ish' } }
      ]
    });
    const card = turn.cards.find((c) => c.type === 'options');
    expect(card && card.type === 'options' ? card.choices.map((c) => c.visual) : []).toEqual([
      { kind: 'balloon', pageId: 'pg_2', lineId: 'ln_2_2' },
      { kind: 'spot', pageId: 'pg_2', cell: 'top-left', frame: 'panel', panelN: 1 },
      { kind: 'spot', pageId: 'pg_2', cell: 'top', frame: 'page' },
      undefined,
      undefined
    ]);
    expect(optionVisualOf(ctx.session.doc, { kind: 'spot', page: 2, panel: 9, cell: 'top' })).toBeUndefined();
    expect(optionVisualOf(ctx.session.doc, 'balloon')).toBeUndefined();
  });
});

describe('presence: activityWhere (plan §3 A2 / A4)', () => {
  it('names the page and the balloons a call works on, capped at STEER_LIMITS.whereLines; nothing for other tools', () => {
    setup({ focus: { pageId: 'pg_2', lineIds: ['ln_2_2'] } });
    expect(activityWhere(ctx, turn, 'set_line', { page: 1, panel: 2, line: 1 })).toEqual({ pageId: 'pg_1', lineIds: ['ln_1_2'] });
    expect(activityWhere(ctx, turn, 'edit_panel_text', { page: 3, panel: 2, lines: [] })).toEqual({ pageId: 'pg_3', lineIds: ['ln_3_2'] });
    expect(activityWhere(ctx, turn, 'dialogue_edit', { action: 'set_kind', target: { selected: true }, kind: 'shout' })).toEqual({ pageId: 'pg_2', lineIds: ['ln_2_2'] });
    expect(activityWhere(ctx, turn, 'dialogue_edit', { action: 'add', target: { page: 3 }, kind: 'sfx', text: 'BOOM' })).toEqual({ pageId: 'pg_3' });
    expect(activityWhere(ctx, turn, 'arrange_balloons', { page: 2, action: 'nudge', dy: -0.02 })).toEqual({ pageId: 'pg_2', lineIds: ['ln_2_2'] });
    expect(activityWhere(ctx, turn, 'edit_page', { page: 3, instruction: 'night' })).toEqual({ pageId: 'pg_3' });
    expect(activityWhere(ctx, turn, 'update_brief', { title: 'x' })).toBeUndefined();
    expect(activityWhere(ctx, turn, 'set_line', { page: 99, panel: 1, line: 1 })).toBeUndefined();
    const ids = Array.from({ length: 30 }, (_, i) => `ln_${i}`);
    const doc = plannedDoc();
    doc.pages[0].panels[0].lines = ids.map((id) => ({ id, kind: 'caption', text: `Caption ${id}` }));
    setup({ doc });
    expect(activityWhere(ctx, turn, 'restyle_balloons', { target: { page: 1, line_ids: ids } })?.lineIds).toHaveLength(STEER_LIMITS.whereLines);
  });
});

describe('recentPageIdsOf (the resolver\'s "pages touched in the last two turns")', () => {
  it('reads the session ring back to the user message before the latest one', () => {
    setup();
    const msg = (id: string) => ({ op: 'message' as const, msg: { id, role: 'user' as const, text: id, at: 1 } });
    const touch = (page: string, panel: string, id: string) => ({ op: 'line' as const, pageId: page, panelId: panel, id, patch: { text: `edit ${page}` } });
    ctx.session.commit([msg('m1')]);
    ctx.session.commit([touch('pg_1', 'pn_1_2', 'ln_1_2')], { origin: 'director' });
    ctx.session.commit([msg('m2')]);
    ctx.session.commit([touch('pg_3', 'pn_3_2', 'ln_3_2')], { origin: 'user' });
    ctx.session.commit([msg('m3')]);
    ctx.session.commit([touch('pg_2', 'pn_2_2', 'ln_2_2')], { origin: 'director' });
    // The current turn (after m3) and the one before it (after m2); page 1 belongs to the turn before those.
    expect(recentPageIdsOf(ctx)).toEqual(['pg_2', 'pg_3']);
  });
});
