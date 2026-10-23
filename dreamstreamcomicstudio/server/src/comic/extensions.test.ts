// The three registries, the per-turn toolset merge and the jobs.ts dispatch (P0-B seams), as wired
// after wave 1: every feature group, action and sanitizer is real now (P2-AMEND rewrote the wave-0
// "stub" assertions into checks of the real wiring; the merge rules are still tested with fakes).
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

/** The core tool surface (golden: order and names). v4's 20 tools + set_line (P1-DIRECTOR) = 21. */
const CORE_TOOL_NAMES = [
  'update_brief', 'add_notes', 'set_format', 'save_source', 'upsert_character', 'remove_character', 'upsert_place', 'remove_place',
  'set_style', 'propose_styles', 'render_character_sheets', 'plan_pages', 'revise_pages', 'read_pages', 'edit_panel_text', 'set_line',
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

  it('every feature group is real: its own non-core tools, each with an activity label, and well-formed rules/lines', () => {
    const turn = createDirectorTurn();
    const owner = new Map<string, string>();
    for (const doc of [plannedDoc(), createEmptyDoc('proj-1')]) {
      const ctx = testContext(newSession(doc));
      for (const g of toolGroups()) {
        const names = directorToolNames(g.tools(ctx, turn));
        for (const name of names) {
          expect(CORE_TOOL_NAMES, `${g.id} shadows core ${name}`).not.toContain(name);
          expect(owner.get(name) ?? g.id, `${name} is offered by two groups`).toBe(g.id);
          owner.set(name, g.id);
          expect(typeof g.activity?.[name], `${g.id}.${name} has no activity label`).toBe('string');
        }
        const rules = g.promptRules?.(ctx.session.doc);
        expect(rules === undefined || (typeof rules === 'string' && rules.trim().length > 0)).toBe(true);
        for (const line of g.summaryLines?.(ctx.session.doc, turn) ?? []) expect(typeof line === 'string' && line.length > 0 && !line.includes('\n')).toBe(true);
      }
    }
    // Every group contributes something on some doc (no stub left behind) — refs only when the turn carries photos.
    const contributing = new Set(owner.values());
    for (const id of ['safety', 'breakdown', 'lettering', 'timeline', 'publish', 'i18n', 'library', 'reader']) expect(contributing, id).toContain(id);
    expect(toolGroupById('refs')!.activity).toMatchObject({ attach_refs: expect.any(String) });
  });

  it('directors send core + the active groups, whole and in priority order, within MAX_TOOLS_PER_TURN', () => {
    for (const doc of [plannedDoc(), createEmptyDoc('proj-1')]) {
      const ctx = testContext(newSession(doc));
      const turn = createDirectorTurn();
      const set = buildTurnToolset(ctx, turn, toolGroups());
      const names = directorToolNames(set.tools);
      expect(names.slice(0, CORE_TOOL_NAMES.length)).toEqual(CORE_TOOL_NAMES);
      expect(directorToolNames(buildDirectorTools(ctx, turn))).toEqual(CORE_TOOL_NAMES);
      const priorities = set.groups.map((id) => toolGroupById(id)!.priority);
      expect([...priorities].sort((a, b) => a - b)).toEqual(priorities);
      const expected = [...CORE_TOOL_NAMES, ...set.groups.flatMap((id) => directorToolNames(toolGroupById(id)!.tools(ctx, turn)))];
      expect(names).toEqual(expected);
      expect(new Set(names).size).toBe(names.length);
      expect(names.length).toBeLessThanOrEqual(MAX_TOOLS_PER_TURN);
      // The always-on content-rating and breakdown groups are offered on every doc.
      expect(set.groups.slice(0, 2)).toEqual(['safety', 'breakdown']);
      expect(set.promptRules.length).toBe(set.groups.filter((id) => toolGroupById(id)!.promptRules?.(ctx.session.doc)).length);
      for (const tool of set.tools.slice(CORE_TOOL_NAMES.length)) expect(set.activity[tool.spec.function.name]).toEqual(expect.any(String));
    }
  });

  it('the wave-1 groups the director relies on: safety and breakdown always on, lettering on overlay comics', () => {
    const ctx = testContext(newSession(plannedDoc()));
    const turn = createDirectorTurn();
    const safety = toolGroupById('safety')!;
    expect(safety.priority).toBe(5);
    expect(directorToolNames(safety.tools(ctx, turn))).toEqual(['set_content_rating', 'request_safety_review']);
    expect(safety.summaryLines?.(ctx.session.doc, turn)).toEqual(['Rating: PG-13']);
    const breakdown = toolGroupById('breakdown')!;
    expect(breakdown.priority).toBe(10);
    const bdTools = breakdown.tools(ctx, turn);
    expect(directorToolNames(bdTools)).toEqual(['show_pages', 'quote']);
    for (const t of bdTools) expect(t.cost).toBe('free');
    expect(breakdown.promptRules?.(ctx.session.doc)).toMatch(/^BREAKDOWN/);
    expect(breakdown.summaryLines?.(ctx.session.doc, turn)).toEqual([expect.stringMatching(/^Breakdown: 3 pages, 0 drawn/)]);
    const lettering = toolGroupById('lettering')!;
    expect(directorToolNames(lettering.tools(ctx, turn))).toEqual(['set_lettering_style', 'restyle_balloons', 'arrange_balloons']);
    expect(lettering.summaryLines?.(ctx.session.doc, turn)[0]).toMatch(/^Lettering: preset classic/);
  });

  it('prefixes every core tool description with its cost class and records each tool cost', () => {
    const ctx = testContext(newSession(plannedDoc()));
    const tools = new Map(buildDirectorTools(ctx).map((t) => [t.spec.function.name, t]));
    for (const t of tools.values()) expect(t.spec.function.description.startsWith(TOOL_COST_PREFIX[t.cost]), t.spec.function.name).toBe(true);
    const costs = Object.fromEntries([...tools].map(([n, t]) => [n, t.cost]));
    expect(costs).toMatchObject({ render_pages: 'paid', edit_page: 'paid', render_cover: 'paid', propose_styles: 'paid', render_character_sheets: 'paid' });
    expect(costs).toMatchObject({ plan_pages: 'text', revise_pages: 'text', save_source: 'text', update_brief: 'free', ask_user: 'free', set_line: 'free' });
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
  it('sends the system prompt, then the active groups\' rules, then the doc summary — and exactly the merged toolset', async () => {
    const session = newSession(createEmptyDoc('proj-1'));
    const llm = scriptedLlm({ director: [{ text: 'Hi!' }] });
    const ctx = testContext(session, { llm });
    const expected = buildTurnToolset(ctx, createDirectorTurn(), toolGroups());
    await runDirectorTurn(ctx, { text: 'hello', attachments: [] });
    const system = llm.calls[0].messages[0].content as string;
    expect(expected.promptRules.length).toBeGreaterThan(0);
    expect(system.startsWith(`${DIRECTOR_SYSTEM_PROMPT}\n\n${expected.promptRules.join('\n')}\n\nDOC SUMMARY`)).toBe(true);
    expect(system).toContain('CONTENT RATING');
    for (const line of expected.summaryLines) expect(system).toContain(line);
    expect(llm.calls[0].tools!.map((t) => t.function.name)).toEqual(directorToolNames(expected.tools));
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

  it('dispatches a feature action to its real handler: fit_render on an undrawn page is refused honestly (NOT_READY), $0', async () => {
    const session = newSession(plannedDoc());
    const ctx = testContext(session);
    const started = await startAction(ctx, { type: 'fit_render', target: { kind: 'page', id: 'pg_1' } }, { confirmed: true });
    await started.done;
    expect(started.outcome).toMatchObject({ status: 'blocked', code: 'NOT_READY' });
    const last = session.doc.conversation.at(-1)!;
    expect(last.role).toBe('assistant');
    expect(last.text).toMatch(/isn.t drawn yet, so there is nothing to fit/);
    expect(last.cards?.[0]).toMatchObject({ type: 'notice', tone: 'info' });
    expect(session.doc.spend.totalUsd).toBe(0);
  });

  it('puts the handler\'s card into the director message when collecting cards (refusals and started spends)', async () => {
    const session = newSession(plannedDoc());
    const ctx = testContext(session);
    const cards: { type: string }[] = [];
    const before = session.doc.conversation.length;
    const refused = await startAction(ctx, { type: 'fit_render', target: { kind: 'page', id: 'pg_1' } }, { confirmed: false, collectCard: (c) => cards.push(c) });
    await refused.done;
    expect(refused.outcome.status).toBe('blocked');
    expect(cards).toEqual([expect.objectContaining({ type: 'notice' })]);
    expect(session.doc.conversation.length).toBe(before);
    // translate is a registered SPEND action: quoted, started (small spend, under the confirm threshold) and carded.
    const started = await startAction(ctx, { type: 'translate', languages: ['hi'] }, { confirmed: false, collectCard: (c) => cards.push(c) });
    expect(started.outcome).toMatchObject({ status: 'started', message: expect.stringMatching(/into Hindi/) });
    expect((started.outcome as { estimate?: { usd: number } }).estimate?.usd).toBeGreaterThan(0);
    expect(cards.at(-1)).toMatchObject({ type: 'translation', languages: ['hi'] });
    await started.done;
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

  it('feature ops go through their real sanitizers: clean input passes, bad input rejects the whole batch with 400', () => {
    const doc = plannedDoc();
    expect(sanitizePatchOps(doc, [{ op: 'letter_style', patch: { presetId: 'manga', bogus: 1 } as never }])).toEqual([{ op: 'letter_style', patch: { presetId: 'manga' } }]);
    // P2-AMEND: book blurb/credits may be cleared with null.
    expect(sanitizePatchOps(doc, [{ op: 'book', patch: { blurb: null, credits: null } }])).toEqual([{ op: 'book', patch: { blurb: null, credits: null } }]);
    let caught: unknown;
    try {
      sanitizePatchOps(doc, [{ op: 'brief', patch: { title: 'x' } }, { op: 'letter_style', patch: { presetId: 'nope' } }]);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(StudioError);
    expect(caught).toMatchObject({ code: 'BAD_REQUEST', status: 400 });
    // A ref the doc never had cannot be smuggled in by path.
    expect(() => sanitizePatchOps(doc, [{ op: 'ref_add', owner: { kind: 'style' }, ref: { path: 'u/other/evil.webp', source: 'upload', at: 1 } }])).toThrow(/isn't part of this comic/);
  });

  it('keeps rejecting server-only ops (plan_input_hash included) and still sanitizes the core ops identically', () => {
    const doc = plannedDoc();
    expect(() => sanitizePatchOps(doc, [{ op: 'render', target: { kind: 'cover' }, patch: {} }])).toThrow(/can't be changed directly/);
    expect(() => sanitizePatchOps(doc, [{ op: 'plan_input_hash', hash: 'x' }])).toThrow(/can't be changed directly/);
    expect(sanitizePatchOps(doc, [{ op: 'note_add', text: '  keep it cozy  ' }])).toEqual([{ op: 'note_add', text: 'keep it cozy' }]);
  });

  it('runs the whole-batch screens (the safety screen lets clean text through unchanged)', () => {
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
