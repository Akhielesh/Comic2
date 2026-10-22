// Wave-0 seams (P0-B): the three registries, the per-turn toolset merge and the jobs.ts
// dispatch. With every feature still a stub, the studio must behave exactly as before.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEmptyDoc, type ComicDoc } from '../../../shared/comic/doc.js';
import { CLIENT_PATCHABLE_OPS, NON_SPEND_ACTION_TYPES, SPEND_ACTION_TYPES, type DocOp } from '../../../shared/comic/ops.js';
import { ACTION_HANDLERS, CORE_ACTION_TYPES, actionHandlerFor } from './actions/index.js';
import { DIRECTOR_SYSTEM_PROMPT, runDirectorTurn, summarizeDocForDirector } from './director.js';
import {
  MAX_TOOLS_PER_TURN,
  TOOL_COST_PREFIX,
  ToolArgError,
  createKeyedRegistry,
  defineTool,
  notAvailableAction,
  withCostPrefix,
  type DirectorTool,
  type ToolGroup
} from './extensions.js';
import { JOB_TIMINGS, sanitizePatchOps, startAction } from './jobs.js';
import { newSession, opsOf, plannedDoc, scriptedLlm, testContext } from './orchestrator.fakes.js';
import { CORE_PATCH_OPS, OP_SANITIZERS, opSanitizerFor, patchScreens } from './sanitize/index.js';
import { buildDirectorTools, buildTurnToolset, createDirectorTurn, directorToolNames } from './tools.js';
import { TOOL_GROUPS, toolGroupById, toolGroups } from './tools/index.js';
import { StudioError } from './types.js';

beforeEach(() => {
  JOB_TIMINGS.retryBackoffMs = 0;
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

/** The core tool surface as of v4 (golden: order and names). */
const CORE_TOOL_NAMES = [
  'update_brief', 'add_notes', 'set_format', 'save_source', 'upsert_character', 'remove_character', 'upsert_place', 'remove_place',
  'set_style', 'propose_styles', 'render_character_sheets', 'plan_pages', 'revise_pages', 'read_pages', 'edit_panel_text',
  'render_pages', 'edit_page', 'render_cover', 'set_settings', 'ask_user'
];

const fakeTool = (name: string, cost: DirectorTool['cost'] = 'free'): DirectorTool => defineTool(name, cost, `${name} tool`, { type: 'object', properties: {} }, () => `${name} ok`);
const group = (g: Partial<ToolGroup> & Pick<ToolGroup, 'id' | 'priority'>): ToolGroup => ({ tools: () => [], ...g });

describe('tool registry', () => {
  it('registers every feature group exactly once and never core', () => {
    const ids = toolGroups().map((g) => g.id);
    expect(ids.sort()).toEqual(['breakdown', 'i18n', 'lettering', 'library', 'publish', 'reader', 'refs', 'safety', 'timeline']);
    expect(TOOL_GROUPS).toBe(toolGroups());
    expect(toolGroupById('core')).toBeUndefined();
    expect(toolGroupById('constructor')).toBeUndefined();
    expect(toolGroupById('lettering')?.id).toBe('lettering');
  });

  it('wave-0 stub groups contribute no tools, rules or summary lines', () => {
    const ctx = testContext(newSession(plannedDoc()));
    const turn = createDirectorTurn();
    for (const g of toolGroups()) {
      expect(g.tools(ctx, turn)).toEqual([]);
      expect(g.promptRules?.(ctx.session.doc)).toBeUndefined();
      expect(g.summaryLines?.(ctx.session.doc, turn) ?? []).toEqual([]);
    }
  });

  it('directors build the identical (golden) tool list with the empty groups', () => {
    const ctx = testContext(newSession(plannedDoc()));
    const turn = createDirectorTurn();
    const set = buildTurnToolset(ctx, turn, toolGroups());
    expect(directorToolNames(set.tools)).toEqual(CORE_TOOL_NAMES);
    expect(directorToolNames(set.tools)).toEqual(directorToolNames(buildDirectorTools(ctx, turn)));
    expect(set.promptRules).toEqual([]);
    expect(set.summaryLines).toEqual([]);
    expect(set.activity).toEqual({});
  });

  it('keeps core tool descriptions verbatim in wave 0 and records each tool cost', () => {
    const ctx = testContext(newSession(plannedDoc()));
    const tools = new Map(buildDirectorTools(ctx).map((t) => [t.spec.function.name, t]));
    for (const t of tools.values()) for (const prefix of Object.values(TOOL_COST_PREFIX)) expect(t.spec.function.description.startsWith(prefix)).toBe(false);
    const costs = Object.fromEntries([...tools].map(([n, t]) => [n, t.cost]));
    expect(costs).toMatchObject({ render_pages: 'paid', edit_page: 'paid', render_cover: 'paid', propose_styles: 'paid', render_character_sheets: 'paid' });
    expect(costs).toMatchObject({ plan_pages: 'text', revise_pages: 'text', save_source: 'text', update_brief: 'free', ask_user: 'free' });
  });

  it('createDirectorTurn fills every v5 field with its documented default', () => {
    expect(createDirectorTurn()).toMatchObject({
      log: [],
      captured: [],
      drawIntent: 'none',
      plannedThisTurn: false,
      images: [],
      nextSteps: [],
      rating: 'PG-13'
    });
    expect(createDirectorTurn({ rating: 'G' }).rating).toBe('G');
  });
});

describe('buildTurnToolset (core + groups)', () => {
  const setup = () => ({ ctx: testContext(newSession(plannedDoc())), turn: createDirectorTurn() });

  it('adds active groups by priority, collects their rules, lines and activity labels', () => {
    const { ctx, turn } = setup();
    const set = buildTurnToolset(ctx, turn, [
      group({ id: 'reader', priority: 70, tools: () => [fakeTool('set_chapter')], promptRules: () => 'READER RULE', summaryLines: () => ['Reader: paper turn'] }),
      group({ id: 'breakdown', priority: 10, tools: () => [fakeTool('show_pages')], activity: { show_pages: 'Laying out the pages' } }),
      group({ id: 'publish', priority: 40, when: () => false, tools: () => [fakeTool('publish_comic')], promptRules: () => 'NEVER SHOWN' })
    ]);
    expect(directorToolNames(set.tools)).toEqual([...CORE_TOOL_NAMES, 'show_pages', 'set_chapter']);
    expect(set.groups).toEqual(['breakdown', 'reader']);
    expect(set.promptRules).toEqual(['READER RULE']);
    expect(set.summaryLines).toEqual(['Reader: paper turn']);
    expect(set.activity).toMatchObject({ show_pages: 'Laying out the pages' });
  });

  it('keeps groups whole: one that would pass MAX_TOOLS_PER_TURN is skipped, a smaller later one still fits', () => {
    const { ctx, turn } = setup();
    const room = MAX_TOOLS_PER_TURN - CORE_TOOL_NAMES.length;
    const set = buildTurnToolset(ctx, turn, [
      group({ id: 'timeline', priority: 30, tools: () => Array.from({ length: room + 1 }, (_, i) => fakeTool(`tl_${i}`)) }),
      group({ id: 'reader', priority: 70, tools: () => [fakeTool('set_reader_options')] })
    ]);
    expect(set.tools).toHaveLength(CORE_TOOL_NAMES.length + 1);
    expect(set.groups).toEqual(['reader']);
    expect(set.tools.length).toBeLessThanOrEqual(MAX_TOOLS_PER_TURN);
  });

  it('never lets a feature shadow a core tool, and survives a throwing group', () => {
    const { ctx, turn } = setup();
    const shadow = fakeTool('render_pages');
    const set = buildTurnToolset(ctx, turn, [
      group({ id: 'timeline', priority: 30, tools: () => [shadow, fakeTool('move_page')] }),
      group({ id: 'lettering', priority: 20, tools: () => { throw new Error('boom'); } }),
      group({ id: 'i18n', priority: 50, when: () => { throw new Error('gate boom'); } })
    ]);
    expect(set.tools.filter((t) => t.spec.function.name === 'render_pages')).toHaveLength(1);
    expect(set.tools.find((t) => t.spec.function.name === 'render_pages')).not.toBe(shadow);
    expect(directorToolNames(set.tools)).toContain('move_page');
    expect(set.groups).toEqual(['timeline']);
  });
});

describe('director with the registry', () => {
  it('sends exactly the v4 system prompt and doc summary when no group adds rules', async () => {
    const session = newSession(createEmptyDoc('proj-1'));
    const llm = scriptedLlm({ director: [{ text: 'Hi!' }] });
    await runDirectorTurn(testContext(session, { llm }), { text: 'hello', attachments: [] });
    const system = llm.calls[0].messages[0].content as string;
    expect(system.startsWith(`${DIRECTOR_SYSTEM_PROMPT}\n\nDOC SUMMARY`)).toBe(true);
    expect(llm.calls[0].tools!.map((t) => t.function.name)).toEqual(CORE_TOOL_NAMES);
  });

  it('summarizeDocForDirector is unchanged without extra lines and places extra lines before the money lines', () => {
    const doc = plannedDoc();
    expect(summarizeDocForDirector(doc, false, [])).toBe(summarizeDocForDirector(doc));
    const withLine = summarizeDocForDirector(doc, false, ['Published: unlisted · 1 edit behind']);
    expect(withLine.indexOf('Published: unlisted')).toBeGreaterThan(withLine.indexOf('Cover:'));
    expect(withLine.indexOf('Published: unlisted')).toBeLessThan(withLine.indexOf('Settings:'));
  });

  it('feature-merged toolset still executes core tools end to end', async () => {
    const session = newSession(createEmptyDoc('proj-1'));
    const llm = scriptedLlm({
      director: [
        { text: '', toolCalls: [{ id: 'c1', name: 'update_brief', arguments: JSON.stringify({ title: 'Spice Run' }) }] },
        { text: 'Saved.' }
      ]
    });
    await runDirectorTurn(testContext(session, { llm }), { text: 'Call it Spice Run', attachments: [] });
    expect(session.doc.brief.title).toBe('Spice Run');
  });
});

describe('action registry', () => {
  it('covers every StudioAction type exactly once: core in jobs.ts, the rest registered', () => {
    const all = new Set([...SPEND_ACTION_TYPES, ...NON_SPEND_ACTION_TYPES]);
    const registered = Object.keys(ACTION_HANDLERS);
    for (const type of all) expect(CORE_ACTION_TYPES.has(type) !== registered.includes(type)).toBe(true);
    for (const type of registered) expect(all.has(type)).toBe(true);
    for (const type of CORE_ACTION_TYPES) expect(all.has(type)).toBe(true);
    expect(ACTION_HANDLERS.translate.spend).toBe(true);
    for (const type of registered.filter((t) => t !== 'translate')) expect(ACTION_HANDLERS[type].spend).toBe(false);
  });

  it('is prototype-safe', () => {
    expect(actionHandlerFor('constructor')).toBeUndefined();
    expect(actionHandlerFor('__proto__')).toBeUndefined();
    expect(actionHandlerFor('render_pages')).toBeUndefined();
  });

  it('dispatches a feature action to its stub: blocked NOT_AVAILABLE with an honest notice', async () => {
    const session = newSession(plannedDoc());
    const ctx = testContext(session);
    const started = await startAction(ctx, { type: 'fit_render', target: { kind: 'page', id: 'pg_1' } }, { confirmed: true });
    await started.done;
    expect(started.outcome).toMatchObject({ status: 'blocked', code: 'NOT_AVAILABLE' });
    const last = session.doc.conversation.at(-1)!;
    expect(last.role).toBe('assistant');
    expect(last.text).toMatch(/isn't available yet/);
    expect(last.cards?.[0]).toMatchObject({ type: 'notice', tone: 'info' });
  });

  it('puts the stub notice into the director message when collecting cards', async () => {
    const session = newSession(plannedDoc());
    const ctx = testContext(session);
    const cards: unknown[] = [];
    const before = session.doc.conversation.length;
    const started = await startAction(ctx, { type: 'translate', languages: ['hi'] }, { confirmed: false, collectCard: (c) => cards.push(c) });
    expect(started.outcome.status).toBe('blocked');
    expect(cards).toEqual([expect.objectContaining({ type: 'notice' })]);
    expect(session.doc.conversation.length).toBe(before);
  });

  it('still runs core actions in jobs.ts (cancel, patch)', async () => {
    const ctx = testContext(newSession(plannedDoc()));
    const started = await startAction(ctx, { type: 'patch', ops: [{ op: 'brief', patch: { title: 'New' } }] }, { confirmed: false });
    expect(started.outcome).toEqual({ status: 'done', message: 'Saved 1 change.' });
    expect(ctx.session.doc.brief.title).toBe('New');
  });

  it('notAvailableAction keeps the action type and spend flag', () => {
    const h = notAvailableAction('use_preset');
    expect(h).toMatchObject({ type: 'use_preset', spend: false });
  });
});

describe('op sanitizer registry', () => {
  it('covers every client-patchable op exactly once: core in jobs.ts, the rest registered', () => {
    const registered = Object.keys(OP_SANITIZERS);
    for (const op of CLIENT_PATCHABLE_OPS) expect(CORE_PATCH_OPS.has(op) !== registered.includes(op)).toBe(true);
    for (const op of registered) expect(CLIENT_PATCHABLE_OPS.has(op as DocOp['op'])).toBe(true);
    expect(opSanitizerFor('constructor')).toBeUndefined();
    expect(opSanitizerFor('brief')).toBeUndefined();
  });

  it('rejects feature ops with 400 NOT_AVAILABLE until their owner lands (whole batch)', () => {
    const doc = plannedDoc();
    let caught: unknown;
    try {
      sanitizePatchOps(doc, [{ op: 'brief', patch: { title: 'x' } }, { op: 'letter_style', patch: { presetId: 'manga' } }]);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(StudioError);
    expect(caught).toMatchObject({ code: 'NOT_AVAILABLE', status: 400 });
  });

  it('keeps rejecting server-only ops and still sanitizes the core ops identically', () => {
    const doc = plannedDoc();
    expect(() => sanitizePatchOps(doc, [{ op: 'render', target: { kind: 'cover' }, patch: {} }])).toThrow(/can't be changed directly/);
    expect(sanitizePatchOps(doc, [{ op: 'note_add', text: '  keep it cozy  ' }])).toEqual([{ op: 'note_add', text: 'keep it cozy' }]);
  });

  it('runs the whole-batch screens (safety stub passes everything through)', () => {
    expect(patchScreens()).toHaveLength(1);
    const ops: DocOp[] = [{ op: 'note_add', text: 'hi' }];
    expect(patchScreens()[0](plannedDoc(), ops, { userId: 'u', caps: {} as never, rating: 'PG-13', now: 0 })).toBe(ops);
  });

  it('commits a patch with its origin on the ops event when the caller passes one', async () => {
    const session = newSession(plannedDoc());
    const ctx = testContext(session);
    await startAction(ctx, { type: 'patch', ops: [{ op: 'note_add', text: 'a' }] }, { confirmed: false, origin: 'user' });
    await startAction(ctx, { type: 'patch', ops: [{ op: 'note_add', text: 'b' }] }, { confirmed: false });
    const opsEvents = ctx.events.filter((e) => e.type === 'ops');
    expect(opsEvents[0]).toMatchObject({ origin: 'user' });
    expect('origin' in opsEvents[1]).toBe(false);
    expect(opsOf(ctx.events)).toHaveLength(2);
  });
});

describe('session.commit options', () => {
  it('adds origin/label to the ops event only when given', () => {
    const session = newSession(plannedDoc() as ComicDoc);
    const events: unknown[] = [];
    session.subscribe((e) => events.push(e));
    session.commit([{ op: 'note_add', text: 'x' }]);
    session.commit([{ op: 'note_add', text: 'y' }], { origin: 'director', label: 'Add a note' });
    expect(events[0]).toEqual({ type: 'ops', rev: expect.any(Number), ops: [{ op: 'note_add', text: 'x' }] });
    expect(events[1]).toMatchObject({ origin: 'director', label: 'Add a note' });
  });
});

describe('extension helpers', () => {
  it('prefixes descriptions by cost, idempotently', () => {
    expect(withCostPrefix('Draw pages.', 'paid')).toBe('PAID (quoted) — Draw pages.');
    expect(withCostPrefix(withCostPrefix('x', 'free'), 'free')).toBe('FREE — x');
    expect(defineTool('quote', 'free', 'Quote a spend.', {}, () => 'ok').spec.function.description).toBe('FREE — Quote a spend.');
    expect(defineTool('quote', 'text', 'Q.', {}, () => 'ok', { prefix: false }).spec.function.description).toBe('Q.');
  });

  it('defineTool turns thrown errors into model-facing sentences', async () => {
    const tool = defineTool('t', 'free', 'd', {}, (args) => {
      if (args.kind === 'arg') throw new ToolArgError('Pass the page.');
      if (args.kind === 'studio') throw new StudioError('LIMIT', 'Too many refs.', { status: 409 });
      throw new Error('secret internals');
    });
    expect(await tool.execute({ kind: 'arg' })).toBe('Error: Pass the page.');
    expect(await tool.execute({ kind: 'studio' })).toBe('Error: Too many refs.');
    expect(await tool.execute({ kind: 'x' })).toBe('Error: that did not work. Try again with simpler arguments.');
    expect(await tool.execute(null as never)).toMatch(/^Error/);
  });

  it('keyed registries refuse core keys and double registration', () => {
    expect(() => createKeyedRegistry({ what: 't', keyOf: (x: { k: string }) => x.k, reserved: new Set(['core']), lists: () => [[{ k: 'core' }]] })).toThrow(/core/);
    expect(() => createKeyedRegistry({ what: 't', keyOf: (x: { k: string }) => x.k, lists: () => [[{ k: 'a' }, { k: 'a' }]] })).toThrow(/twice/);
  });

  it('keyed registries finish filling lazily after an import-cycle ReferenceError', () => {
    let ready = false;
    const item = { k: 'late' };
    const reg = createKeyedRegistry({
      what: 't',
      keyOf: (x: { k: string }) => x.k,
      lists: () => {
        if (!ready) throw new ReferenceError('Cannot access before initialization');
        return [[item]];
      }
    });
    expect(Object.keys(reg.table)).toEqual([]);
    ready = true;
    expect(reg.get('late')).toBe(item);
    expect(reg.get('hasOwnProperty')).toBeUndefined();
  });
});
