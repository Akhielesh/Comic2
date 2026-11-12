// @vitest-environment node
// Wave 2 B-TOOL (agent-editor plan §3 B3, A3.1, A3.3, A4): dialogue_edit runs the deterministic dialogue engine
// (shared/comic/dialogue) behind the conflict guard; offer_next adds free say-chips; ask_user options carry pictures; the
// director's activity events say where it works. All free: no model call, no spend.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CAPS, type StudioCaps } from '../../../shared/comic/capabilities.js';
import type { ComicDoc, Page } from '../../../shared/comic/doc.js';
import { STEER_LIMITS } from '../../../shared/comic/events.js';
import { newSession, plannedDoc, testContext, type TestContext } from './orchestrator.fakes.js';
import {
  OFFER_NEXT_MAX,
  activityWhere,
  buildDirectorTools,
  createDirectorTurn,
  dialogueEditTool,
  offerNextTool,
  optionVisualOf,
  recentPageIdsOf,
  type DirectorTool,
  type DirectorTurn
} from './tools.js';

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

  it('a big plural asks once to confirm; only the re-call with confirmed:true applies it', async () => {
    const doc = plannedDoc();
    // Four pages with a speech line each: above RESOLVE_LIMITS.confirmPages, so "every speech line" confirms first.
    const extra: Page = JSON.parse(JSON.stringify(doc.pages[2]).replace(/_3(?=["_])/g, '_4'));
    extra.n = 4;
    doc.pages.push(extra);
    setup({ doc });
    const args = { action: 'set_kind', target: { kind: 'speech', all: true }, kind: 'whisper' };
    const asked = await tool.execute(args);
    expect(asked).toMatch(/^Asked: "That changes 4 lines on 4 pages\. Go ahead\?/);
    const card = turn.cards.find((c) => c.type === 'options');
    expect(card && card.type === 'options' ? card.choices.map((c) => c.reply) : []).toContain('Yes, change all 4 of them.');
    expect(ctx.session.doc.pages.every((p) => p.panels[1].lines[0].kind === 'speech')).toBe(true);
    // The next turn, after the creator's yes.
    setup({ doc: ctx.session.doc });
    await tool.execute({ ...args, confirmed: true });
    expect(ctx.session.doc.pages.every((p) => p.panels[1].lines[0].kind === 'whisper')).toBe(true);
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
    expect(names).toEqual(expect.arrayContaining(['dialogue_edit', 'offer_next']));
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
