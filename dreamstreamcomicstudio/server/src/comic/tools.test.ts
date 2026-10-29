import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { castNoun, createEmptyDoc, emptyRender, pageSpecHash, type AssetRef } from '../../../shared/comic/doc.js';
import { lakeDrawnDoc } from './golden/fixtures.js';
import { JOB_TIMINGS, startAction } from './jobs.js';
import { newSession, plannedDoc, testContext, type TestContext } from './orchestrator.fakes.js';
import { GROUP_HINTS, buildDirectorTools, buildTurnToolset, createDirectorTurn, type DirectorTool, type DirectorTurn } from './tools.js';
import type { ToolGroup } from './extensions.js';
import { analyzeSource, writePagePlan } from './writer.js';

vi.mock('./writer.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./writer.js')>();
  return { ...actual, analyzeSource: vi.fn(), writePagePlan: vi.fn() };
});
vi.mock('./vision.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./vision.js')>();
  return { ...actual, analyzePageRender: vi.fn(async () => Promise.reject(new Error('no vision in tests'))) };
});

const attachment = (n: number): AssetRef => ({ path: `u/user-1/p/proj-1/img/up-${n}.webp`, source: 'upload', at: n });

let ctx: TestContext;
let turn: DirectorTurn;
let tools: Map<string, DirectorTool>;
const call = (name: string, args: Record<string, unknown>) => tools.get(name)!.execute(args);

const setup = (doc = plannedDoc(), attachments: AssetRef[] = [], init: Partial<DirectorTurn> = {}) => {
  ctx = testContext(newSession(doc));
  turn = createDirectorTurn({ attachments, userText: 'the user message', ...init });
  tools = new Map(buildDirectorTools(ctx, turn).map((t) => [t.spec.function.name, t]));
};

beforeEach(() => {
  JOB_TIMINGS.retryBackoffMs = 0;
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  setup();
});
afterEach(() => {
  vi.mocked(analyzeSource).mockReset();
  vi.mocked(writePagePlan).mockReset();
  vi.restoreAllMocks();
});

describe('tool specs', () => {
  it('offers every documented tool with an object JSON schema', () => {
    const names = [...tools.keys()];
    expect(names).toEqual(
      expect.arrayContaining([
        'update_brief', 'add_notes', 'set_format', 'save_source', 'upsert_character', 'remove_character', 'upsert_place', 'remove_place',
        'set_style', 'propose_styles', 'render_character_sheets', 'plan_pages', 'revise_pages', 'edit_panel_text', 'render_pages',
        'edit_page', 'render_cover', 'set_settings', 'ask_user', 'read_pages'
      ])
    );
    for (const t of tools.values()) {
      expect(t.spec.type).toBe('function');
      expect(t.spec.function.parameters).toMatchObject({ type: 'object' });
      expect(t.spec.function.description.length).toBeLessThan(400);
    }
  });

  it('never throws on garbage arguments', async () => {
    for (const t of tools.values()) {
      const out = await t.execute(null as never);
      expect(typeof out).toBe('string');
    }
  });
});

describe('story tools', () => {
  it('update_brief + add_notes', async () => {
    expect(await call('update_brief', {})).toMatch(/^Error: /);
    // An automatic lettering preset follows the comic for free (noir genre → the noir preset), said in the result.
    expect(await call('update_brief', { title: '  Night  Market ', genre: 'noir', themes: ['trust', ''] })).toBe(
      'Brief updated: title, genre, themes. Lettering now uses the noir preset to fit (free; it was on automatic).'
    );
    expect(ctx.session.doc.brief).toMatchObject({ title: 'Night Market', genre: 'noir', themes: ['trust'] });
    expect(ctx.session.doc.letterStyle).toMatchObject({ presetId: 'noir', auto: true });
    // A preset the user picked (auto off) is never switched.
    ctx.session.commit([{ op: 'letter_style', patch: { presetId: 'classic', auto: null } }]);
    expect(await call('update_brief', { genre: 'noir detective' })).toBe('Brief updated: genre.');
    expect(ctx.session.doc.letterStyle?.presetId).toBe('classic');
    expect(await call('add_notes', { notes: ['no gore', 'ends on a cliffhanger'] })).toBe('Noted (2 notes total).');
  });

  it('set_format validates enums and numbers', async () => {
    expect(await call('set_format', { kind: 'novel' })).toMatch(/^Error: Invalid format: kind/);
    const out = await call('set_format', { kind: 'manga', pageCount: '12', panelsPerPage: '5', readingDirection: 'rtl' });
    expect(out).toContain('manga, 12 pages');
    expect(ctx.session.doc.format).toMatchObject({ kind: 'manga', pageCount: 12, panelsPerPage: 5, readingDirection: 'rtl' });
    await call('set_format', { panelsPerPage: 'auto', pageCount: 500 });
    expect(ctx.session.doc.format).toMatchObject({ panelsPerPage: 'auto', pageCount: 40 });
  });
});

describe('cast & places', () => {
  it('creates a character with a look summary, the first one as lead', async () => {
    setup(createEmptyDoc('proj-1'));
    const out = await call('upsert_character', { name: 'Maya', look: { age: '20s', gender: 'woman', hair: 'black bob', outfit: 'red scarf' } });
    expect(out).toBe('Saved MAYA (lead). Cast: MAYA.');
    const maya = ctx.session.doc.cast[0];
    expect(maya.look.summary).toBe('20s woman, black bob hair, red scarf');
    expect(await call('upsert_character', { name: 'Arjun', tier: 'support', look: { summary: 'bearded vendor' } })).toBe('Saved ARJUN (support). Cast: MAYA, ARJUN.');
  });

  it('updates by case-insensitive name, attaches images, and marks a ready sheet out of date', async () => {
    const doc = plannedDoc();
    doc.cast[0].sheet = { ...emptyRender(), status: 'ready', asset: { path: 's.webp', source: 'generated', at: 1 } };
    setup(doc, [attachment(1), attachment(2)]);
    const out = await call('upsert_character', { name: 'MAYA', look: { hair: 'long braid' }, attachmentRefs: [2] });
    expect(out).toContain('Saved MAYA (lead). Added 1 photo to MAYA.');
    expect(out).toContain("sheet is now out of date");
    expect(out).not.toContain('No sheet yet');
    const maya = ctx.session.doc.cast[0];
    expect(maya.look).toMatchObject({ summary: 'Young courier with a red scarf', hair: 'long braid' });
    expect(maya.refs.map((r) => r.path)).toEqual([attachment(2).path]);
    expect(maya.sheet.status).toBe('stale');
  });

  it('rejects bad attachment numbers, duplicate names and missing names', async () => {
    setup(plannedDoc(), [attachment(1)]);
    expect(await call('upsert_character', { name: 'Maya', attachmentRefs: [3] })).toBe('Error: There are only 1 image(s) attached to this message (use 1–1).');
    expect(await call('upsert_character', { name: 'Arjun', newName: 'maya' })).toMatch(/^Error: There is already a character named MAYA/);
    expect(await call('upsert_character', {})).toBe('Error: Pass the character name.');
    expect(await call('remove_character', { name: 'Ghost' })).toMatch(/^Error: No such character/);
    expect(await call('remove_character', { id: 'c_arjun' })).toBe('Removed ARJUN. Cast: MAYA.');
    expect(ctx.session.doc.pages[1].panels[0].castIds).toEqual(['c_maya']);
  });

  it('upsert_place / remove_place', async () => {
    expect(await call('upsert_place', { name: 'Rooftops', look: 'tin roofs at dusk' })).toBe('Saved place ROOFTOPS. Places: SPICE MARKET, ROOFTOPS.');
    expect(await call('upsert_place', { name: 'spice market', look: 'brighter' })).toContain('SPICE MARKET');
    expect(ctx.session.doc.places[0].look).toBe('brighter');
    expect(await call('remove_place', { name: 'Rooftops' })).toBe('Removed ROOFTOPS. Places: SPICE MARKET.');
  });
});

describe('style tools', () => {
  it('set_style with a preset copies it and syncs a b/w color mode', async () => {
    const out = await call('set_style', { presetId: 'noir-ink' });
    expect(out).toContain('Style: Noir ink (drafted); color mode set to bw.');
    expect(ctx.session.doc.style).toMatchObject({ status: 'drafted', presetId: 'noir-ink', name: 'Noir ink' });
    expect(ctx.session.doc.format.colorMode).toBe('bw');
  });

  it('custom spec clears an old board; lock locks; unknown preset errors', async () => {
    const doc = plannedDoc();
    doc.style.board = { path: 'board.webp', source: 'generated', at: 1 };
    setup(doc, [attachment(1)]);
    expect(await call('set_style', { presetId: 'nope' })).toMatch(/^Error: Unknown preset/);
    expect(await call('set_style', { name: 'Ink' })).toMatch(/^Error: A custom style needs a spec/);
    await call('set_style', { name: 'Ink wash', spec: 'Loose ink wash with grey tones and splattered texture', attachmentRefs: [1] });
    expect(ctx.session.doc.style).toMatchObject({ status: 'drafted', name: 'Ink wash', board: undefined, refs: [attachment(1)] });
    expect(await call('set_style', { lock: true })).toContain('(locked)');
  });

  it('propose_styles starts the render job (tracked) and returns the outcome', async () => {
    const out = await call('propose_styles', { directions: [{ name: 'A', spec: 'a spec' }, { name: 'B', spec: 'b spec' }] });
    expect(out).toMatch(/^Started drawing 2 style options/);
    await ctx.settled();
    expect(ctx.session.doc.style.options.map((o) => o.render.status)).toEqual(['ready', 'ready']);
  });
});

describe('plan tools', () => {
  it('plan_pages refuses with nothing to plan, else writes the plan and collects the plan card', async () => {
    setup(createEmptyDoc('proj-1'));
    expect(await call('plan_pages', {})).toMatch(/^Error: Nothing to plan yet/);
    setup();
    const fresh = plannedDoc().pages.map((p) => ({ ...p, summary: `Beat ${p.n}` }));
    vi.mocked(writePagePlan).mockResolvedValue({ pages: fresh, newCast: [], model: 'w' });
    const out = await call('plan_pages', { instructions: 'snappy' });
    expect(out).toMatch(/^Planned 3 pages: 1\. Beat 1 \(3 panels\)/);
    expect(turn.cards).toHaveLength(1);
    expect(['plan', 'breakdown']).toContain(turn.cards[0].type);
    expect(turn.plannedThisTurn).toBe(true);
  });

  it('caps paid writer runs per turn', async () => {
    const fresh = plannedDoc().pages.map((p) => ({ ...p, summary: `Beat ${p.n}` }));
    vi.mocked(writePagePlan).mockResolvedValue({ pages: fresh, newCast: [], model: 'w' });
    // Two writer runs are allowed in one turn…
    expect(await call('plan_pages', {})).toMatch(/^Planned 3 pages/);
    expect(await call('plan_pages', {})).toMatch(/^Planned 3 pages/);
    // …the third is refused so an over-eager (or injected) run can't spend the writer freely.
    expect(await call('plan_pages', {})).toMatch(/^Error: Already ran the writer twice this turn/);
    expect(turn.paidText).toBe(2);
  });

  it('stops paid writer runs once the comic is at its budget cap', async () => {
    const doc = plannedDoc();
    doc.settings = { ...doc.settings, budgetUsd: 1 };
    doc.spend = { ...doc.spend, totalUsd: 1 };
    setup(doc);
    expect(await call('plan_pages', {})).toMatch(/^Error: The comic is at its budget cap/);
  });

  it('a plan the budget cap blocks (spend in flight) is returned as blocked, never as planned', async () => {
    const doc = plannedDoc();
    doc.settings = { ...doc.settings, budgetUsd: 1 };
    doc.spend = { ...doc.spend, totalUsd: 0.99 };
    setup(doc);
    // A cover the user approved past the cap is still drawing: its hold counts as pending spend,
    // so the writer's own cap check (spent + pending ≥ budget) refuses while guardPaidText passes.
    let release!: () => void;
    const held = new Promise<undefined>((resolve) => (release = () => resolve(undefined)));
    ctx.imagesFake.behave = () => held;
    const started = await startAction(ctx, { type: 'render_cover' }, { confirmed: true, budgetApproved: true, origin: 'user' });
    expect(started.outcome.status).toBe('started');

    const planned = await call('plan_pages', {});
    expect(planned).toContain('at its budget cap');
    expect(planned).not.toContain('The user reviews the plan on the board');
    const revised = await call('revise_pages', { pages: [2], instructions: 'make it a splash' });
    expect(revised).toContain('at its budget cap');
    expect(turn.plannedThisTurn).toBe(false);
    expect(vi.mocked(writePagePlan)).not.toHaveBeenCalled();

    release();
    await ctx.settled();
  });

  it('a plan refused for drawn pages is not treated as planned', async () => {
    const doc = plannedDoc();
    doc.pages[0].render = { ...emptyRender(), status: 'ready', asset: { path: 'p1.webp', source: 'generated', at: 1 } };
    doc.format = { ...doc.format, pageCount: 5 };
    setup(doc);
    const out = await call('plan_pages', {});
    expect(out).toContain('revise_pages');
    expect(out).not.toContain('The user reviews the plan on the board');
    expect(turn.plannedThisTurn).toBe(false);
    expect(vi.mocked(writePagePlan)).not.toHaveBeenCalled();
  });

  it('revise_pages maps page numbers and validates them', async () => {
    expect(await call('revise_pages', { pages: [9], instructions: 'x' })).toBe('Error: No page 9 — the plan has 3 pages.');
    vi.mocked(writePagePlan).mockImplementation(async ({ doc, pageIds }) => ({
      pages: doc.pages.filter((p) => pageIds!.includes(p.id)).map((p) => ({ ...p, summary: 'Splash!' })),
      newCast: [],
      model: 'w'
    }));
    expect(await call('revise_pages', { pages: [2], instructions: 'make it a splash' })).toMatch(/^Revised 1 page: 2\. Splash!/);
    expect(vi.mocked(writePagePlan).mock.calls[0][0].pageIds).toEqual(['pg_2']);
  });

  it('read_pages shows panels and lines', async () => {
    const out = await call('read_pages', { pages: [2] });
    expect(out).toContain('PAGE 2: Page 2 beat');
    expect(out).toContain('Panel 2 (medium, medium): Action 2.2 | Cast: MAYA, ARJUN');
    expect(out).toContain('speech MAYA: "Line on page 2"');
  });

  it('edit_panel_text replaces every line and adds a missing speaker to the panel', async () => {
    const out = await call('edit_panel_text', {
      page: 3,
      panel: 2,
      lines: [
        { kind: 'speech', speaker: 'maya', text: 'Run!' },
        { kind: 'caption', text: 'Meanwhile…' }
      ]
    });
    expect(out).toBe('Page 3 panel 2 now has 2 lines. Added the speaker to the panel.');
    const panel = ctx.session.doc.pages[2].panels[1];
    expect(panel.lines.map((l) => [l.kind, l.speakerId, l.text])).toEqual([
      ['speech', 'c_maya', 'Run!'],
      ['caption', undefined, 'Meanwhile…']
    ]);
    expect(panel.castIds).toEqual(['c_arjun', 'c_maya']);
    expect(await call('edit_panel_text', { page: 3, panel: 2, lines: [{ kind: 'speech', speaker: 'Nobody', text: 'x' }] })).toMatch(/^Error: Unknown speaker/);
    expect(await call('edit_panel_text', { page: 3, panel: 9, lines: [] })).toBe('Error: Page 3 has panels 1–3.');
  });

  // P2-GATE L5 (gate review follow-up): what the director writes into the doc is cleaned where it
  // enters (sanitize/text.ts) like every client edit — no NUL or lone surrogate reaches the live doc
  // (jsonb rejects both), whole emoji / ZWJ / combining marks stay, and a clip never splits a pair.
  it('director text is jsonb-safe at the door: brief fields, balloon lines and the saved script', async () => {
    expect(await call('update_brief', { title: ' Spice\u0000 Run \uD83C', themes: ['\uDC00', 'home 🏁 ‍ గ్'] })).toMatch(/^Brief updated: title, themes\./);
    expect(ctx.session.doc.brief).toMatchObject({ title: 'Spice Run', themes: ['home 🏁 ‍ గ్'] });

    const out = await call('edit_panel_text', {
      page: 3,
      panel: 2,
      lines: [
        { kind: 'speech', speaker: 'maya', text: `${'y'.repeat(599)}🦊` },
        { kind: 'caption', text: 'Mean\u0000while… \uD83C' }
      ]
    });
    expect(out).toMatch(/^Page 3 panel 2 now has 2 lines/);
    expect(ctx.session.doc.pages[2].panels[1].lines.map((l) => l.text)).toEqual(['y'.repeat(599), 'Meanwhile…']);

    expect(await call('save_source', { text: 'A short\u0000 premise \uD83C about a heist 🦊.' })).toBe('Saved the source (7 words).');
    expect(ctx.session.doc.source.script).toBe('A short premise  about a heist 🦊.');
    expect(JSON.stringify(ctx.session.doc)).not.toMatch(/\\u0000|\\ud8[0-9a-f]{2}"|\\udc00/i);
  });
});

describe('spend tools', () => {
  it('render_pages refuses without a plan', async () => {
    const doc = plannedDoc();
    doc.pages = [];
    doc.planStatus = 'none';
    setup(doc);
    expect(await call('render_pages', {})).toMatch(/^Refused: there is no page plan yet/);
  });

  it('render_pages is gate-aware and collects the gate card (page numbers never force a redraw)', async () => {
    const doc = plannedDoc();
    doc.settings.confirm = 'always';
    setup(doc, [], { userText: 'draw pages 1 and 2', drawIntent: 'explicit' });
    const out = await call('render_pages', { pages: [1, 2] });
    expect(out).toMatch(/\$\d+\.\d\d/);
    expect(turn.gated).toBe(true);
    expect(turn.cards.map((c) => c.type)).toContain('gate');
    expect(ctx.session.doc.gate?.action).toMatchObject({ type: 'render_pages', pageIds: ['pg_1', 'pg_2'] });
    expect(ctx.session.doc.gate?.action).not.toHaveProperty('force');
    expect(ctx.imagesFake.calls).toHaveLength(0);
  });

  it('render_pages under the confirm threshold starts drawing in the background', async () => {
    setup(plannedDoc(), [], { userText: 'draw all the pages', drawIntent: 'explicit' });
    const out = await call('render_pages', {});
    expect(out).toMatch(/^Started drawing/);
    await ctx.settled();
    expect(ctx.session.doc.pages.every((p) => p.render.status === 'ready')).toBe(true);
  });

  it('edit_page requires a drawn page; render_character_sheets resolves names', async () => {
    expect(await call('edit_page', { page: 1, instruction: 'night' })).toMatch(/^Error: Page 1 isn't drawn yet/);
    expect(await call('render_character_sheets', { names: ['Ghost'] })).toMatch(/^Error: Unknown: Ghost/);
    expect(await call('render_character_sheets', { names: ['maya', 'Spice Market'] })).toMatch(/^Started drawing 1 character sheet \+ 1 location sheet/);
    await ctx.settled();
    expect(ctx.session.doc.cast[0].sheet.status).toBe('ready');
    expect(ctx.session.doc.places[0].sheet.status).toBe('ready');
  });

  it('render_cover stores the cover text before drawing', async () => {
    await call('render_cover', { title: 'SPICE RUN', tagline: 'Hot pursuit' });
    await ctx.settled();
    expect(ctx.session.doc.cover).toMatchObject({ title: 'SPICE RUN', tagline: 'Hot pursuit' });
    expect(ctx.imagesFake.calls[0].prompt).toContain('SPICE RUN');
  });

  it("gates on the turn's running total once small spends add up past the big threshold", async () => {
    const doc = plannedDoc();
    doc.settings = { ...doc.settings, confirm: 'big', bigSpendUsd: 0.1 };
    // Drawn pages so edit_page (one image, ~$0.07 standard) can run on each.
    for (const p of doc.pages) p.render = { ...emptyRender(), status: 'ready', asset: { path: `${p.id}.webp`, source: 'generated', at: 1 } };
    setup(doc, [], { userText: 'make it night on every page', drawIntent: 'explicit' });
    // One edit is under $0.10 → starts right away.
    expect(await call('edit_page', { page: 1, instruction: 'make it night' })).toMatch(/^Started drawing/);
    expect(turn.spentUsd).toBeGreaterThan(0);
    expect(turn.gated).toBe(false);
    // A second edit takes the turn's total over $0.10 → it waits for approval even though the
    // single call is still under the threshold.
    expect(await call('edit_page', { page: 2, instruction: 'make it night' })).toMatch(/^Waiting for the user to approve/);
    expect(turn.gated).toBe(true);
    // A third spend is refused outright while one approval from this turn is pending.
    expect(await call('edit_page', { page: 3, instruction: 'make it night' })).toMatch(/^Refused: a spend from this turn is already waiting/);
    await ctx.settled();
  });
});

describe('settings & ask_user', () => {
  it('set_settings validates and only ever tightens money controls', async () => {
    expect(await call('set_settings', { quality: 'ultra' })).toMatch(/^Error: Invalid settings: quality/);
    // Tightening is fine: lower tier, more confirmations, a (first) budget cap.
    expect(await call('set_settings', { quality: 'draft', budgetUsd: 5, confirm: 'always' })).toBe('Settings: draft quality; confirm always; budget $5.00.');
    expect(await call('set_settings', { budgetUsd: 2 })).toContain('budget $2.00');
    // Loosening is the user's call — refused, nothing changes (prompt-injection guard).
    for (const loosen of [{ quality: 'pro' }, { confirm: 'never' }, { budgetUsd: 0 }, { budgetUsd: 50 }, { bigSpendUsd: 1000 }]) {
      expect(await call('set_settings', loosen)).toMatch(/^Error: Only the user can change/);
    }
    expect(ctx.session.doc.settings).toMatchObject({ quality: 'draft', confirm: 'always', budgetUsd: 2 });
  });

  it('model lock: once the comic has an image, the director never changes the quality (model/resolution)', async () => {
    const doc = plannedDoc();
    doc.settings = { ...doc.settings, quality: 'pro' };
    doc.pages[0].render = { ...emptyRender(), status: 'ready', asset: { path: 'p1.webp', source: 'generated', at: 1 } };
    setup(doc);
    const out = await call('set_settings', { quality: 'standard' });
    expect(out).toMatch(/^Error: Locked comic: its images are drawn on .+ would switch to .+ tap the quality chip/);
    expect(ctx.session.doc.settings.quality).toBe('pro');
    // Other tightening still works on a locked comic.
    expect(await call('set_settings', { budgetUsd: 4 })).toContain('budget $4.00');
  });

  it('ask_user adds an options card once per turn', async () => {
    expect(await call('ask_user', { question: 'Tone?', options: ['Funny'] })).toBe('Error: Give 2–5 distinct options.');
    const out = await call('ask_user', { question: 'Which tone?', options: [{ label: 'Funny' }, { label: 'Tense', description: 'Thriller pacing' }, 'Cozy', 'funny'] });
    expect(out).toMatch(/^Asked/);
    expect(turn.askedUser).toBe(true);
    const card = turn.cards[0];
    expect(card).toMatchObject({ type: 'options', question: 'Which tone?', allowCustom: true });
    expect(card.type === 'options' && card.choices.map((c) => c.label)).toEqual(['Funny', 'Tense', 'Cozy']);
    expect(await call('ask_user', { question: 'Again?', options: ['a', 'b'] })).toMatch(/^Error: You already asked/);
  });
});

describe('save_source', () => {
  it('stores short material without a paid analysis', async () => {
    const out = await call('save_source', { text: 'A short premise about a heist.' });
    expect(out).toBe('Saved the source (6 words).');
    expect(ctx.session.doc.source.script).toBe('A short premise about a heist.');
    expect(analyzeSource).not.toHaveBeenCalled();
  });

  it('analyzes long material (from the message) and fills only what is missing', async () => {
    const long = 'PAGE 1\n' + 'Maya runs through the market. '.repeat(80);
    const doc = plannedDoc();
    doc.brief = { title: 'Untitled comic', notes: [], genre: 'adventure' };
    doc.planStatus = 'none';
    doc.pages = [];
    setup(doc);
    turn.userText = long;
    vi.mocked(analyzeSource).mockImplementation(async ({ llm }) => {
      await llm.complete({ role: 'writer', messages: [{ role: 'user', content: 'analyze' }] });
      return {
        brief: { title: 'Spice Run', genre: 'thriller', logline: 'A courier and a recipe.', notes: ['keep it PG'] },
        cast: [
          { name: 'maya', tier: 'lead', look: { summary: 'ignored', eyes: 'green' } },
          { name: 'Nani', tier: 'support', look: { summary: 'tiny fierce grandmother' } }
        ],
        places: [{ name: 'Harbor', look: 'cranes and fog' }],
        suggestedPageCount: 8,
        styleHint: 'warm ink and watercolor',
        model: 'writer-x'
      };
    });
    const out = await call('save_source', { useMessage: true });
    expect(out).toContain('Saved and read the source');
    expect(out).toContain('title “Spice Run”');
    expect(out).toContain('Cast: MAYA (lead), NANI (support).');
    expect(out).toContain('Places: HARBOR.');
    expect(out).toContain('page count set to 8');
    expect(out).toContain('Style hint from the text: warm ink and watercolor');
    const after = ctx.session.doc;
    expect(after.source.script).toBe(long.trim());
    expect(after.brief).toMatchObject({ title: 'Spice Run', genre: 'adventure', logline: 'A courier and a recipe.' });
    expect(after.brief.notes).toEqual(['keep it PG']);
    expect(after.cast.find((c) => c.id === 'c_maya')?.look).toMatchObject({ summary: 'Young courier with a red scarf', eyes: 'green' });
    expect(after.cast.find((c) => c.name === 'Nani')).toBeTruthy();
    expect(after.format.pageCount).toBe(8);
    expect(after.spend.entries[0]).toMatchObject({ kind: 'plan', label: 'Read the script' });
  });

  it('errors without any source', async () => {
    expect(await call('save_source', {})).toMatch(/^Error: No source text/);
  });

  it('does not let a message excerpt overwrite the full source the route saved this turn', async () => {
    const long = 'PAGE 1\n' + 'Maya runs through the spice market chasing a thief. '.repeat(120);
    const doc = plannedDoc();
    doc.source = { script: long.trim(), updatedAt: 1 };
    setup(doc);
    // The route saved the full paste to source.script and left only an excerpt in the message.
    turn.sourceSaved = true;
    turn.userText = `${long.slice(0, 400).trimEnd()}…\n\n[Pasted 720 words — saved as the source script. Call save_source (no text) to read it.]`;
    vi.mocked(analyzeSource).mockImplementation(async ({ llm }) => {
      await llm.complete({ role: 'writer', messages: [{ role: 'user', content: 'analyze' }] });
      return { brief: { logline: 'A courier and a thief.' }, cast: [], places: [], model: 'writer-x' };
    });
    // The model follows the old advice and calls with useMessage:true — the excerpt must be ignored.
    const out = await call('save_source', { useMessage: true });
    expect(out).toContain('Saved and read the source');
    // The full script is intact, and the analysis ran on it, not on the short excerpt.
    expect(ctx.session.doc.source.script).toBe(long.trim());
    expect(vi.mocked(analyzeSource).mock.calls[0][0].text).toBe(long.trim());
  });
});

// ── v5 (P1-DIRECTOR): honest spends, non-human cast, ids kept, free paths ────

const drawnLake = () => {
  const doc = lakeDrawnDoc();
  doc.settings = { ...doc.settings, confirm: 'big' };
  return doc;
};

describe('render_pages semantics (bug: re-render of a ready page)', () => {
  it('"generate all pages" on a drawn, current 1-page book → nothing, $0, no image call, breakdown + next steps', async () => {
    setup(drawnLake(), [], { userText: 'generate all pages', drawIntent: 'explicit' });
    const spentBefore = ctx.session.doc.spend.totalUsd;
    const out = await call('render_pages', { pages: [1] });
    expect(out).toMatch(/^Nothing to draw: Page 1 is already drawn and up to date — nothing was spent\./);
    expect(out).toContain("The cover isn't drawn yet");
    expect(turn.outcome).toBe('nothing');
    expect(turn.cards).toEqual([expect.objectContaining({ type: 'breakdown', view: 'status' })]);
    expect(turn.nextSteps.map((s) => s.label)).toEqual(expect.arrayContaining(['Read it', 'Make the cover', 'New take of page 1']));
    await ctx.settled();
    expect(ctx.imagesFake.calls).toHaveLength(0);
    expect(ctx.session.doc.spend.totalUsd).toBe(spentBefore);
    expect(ctx.session.doc.gate).toBeNull();
    // Without page numbers too.
    expect(await call('render_pages', {})).toMatch(/^Nothing to draw: every page/);
  });

  it('redraw:true without the user asking for another take is refused with an offer', async () => {
    setup(drawnLake(), [], { userText: 'generate all pages', drawIntent: 'explicit' });
    const out = await call('render_pages', { pages: [1], redraw: true });
    expect(out).toMatch(/^Not redrawn: Page 1 is already drawn and current, and the user didn't ask for a new take\. Offer: read it, make the cover, or a new take of page 1 \(≈ \$\d+\.\d\d\)\./);
    expect(ctx.session.doc.gate).toBeNull();
  });

  it('redraw:true with "another take" → a forced redraw that always waits for approval', async () => {
    setup(drawnLake(), [], { userText: 'give me another take of page 1', drawIntent: 'redraw' });
    const out = await call('render_pages', { pages: [1], redraw: true });
    expect(out).toMatch(/\$\d+\.\d\d/);
    expect(turn.gated).toBe(true);
    expect(ctx.session.doc.gate).toMatchObject({ status: 'open', reason: 'redraw', action: { type: 'render_pages', pageIds: ['pg_lake_1'], force: true } });
    expect(ctx.imagesFake.calls).toHaveLength(0);
  });

  it('include_cover on a drawn book draws only the missing cover', async () => {
    const doc = drawnLake();
    doc.settings.confirm = 'never';
    setup(doc, [], { userText: 'draw everything', drawIntent: 'explicit' });
    const out = await call('render_pages', { include_cover: true });
    expect(out).toMatch(/^Started drawing the cover/);
    await ctx.settled();
    expect(ctx.imagesFake.calls).toHaveLength(1);
    expect(ctx.session.doc.cover.render.status).toBe('ready');
  });

  it('never draws a plan written in the same turn, unless the user said to skip review', async () => {
    vi.mocked(writePagePlan).mockResolvedValue({ pages: plannedDoc().pages, newCast: [], model: 'w' });
    setup(plannedDoc(), [], { userText: 'plan and draw it', drawIntent: 'explicit' });
    await call('plan_pages', {});
    expect(await call('render_pages', {})).toMatch(/^Refused: the user hasn't seen this plan yet/);
    setup(plannedDoc(), [], { userText: 'plan it and just draw it now', drawIntent: 'explicit' });
    await call('plan_pages', {});
    expect(await call('render_pages', {})).toMatch(/^Started drawing/);
    await ctx.settled();
  });

  it('a spend on a turn with no draw intent only quotes (forced gate), even below the threshold', async () => {
    const doc = drawnLake();
    doc.cover.render = { ...emptyRender(), status: 'ready', asset: { path: 'cover.webp', source: 'generated', at: 1 } };
    setup(doc, [], { userText: 'the cover is bad it doesnt represent the baby picture', drawIntent: 'none' });
    const out = await call('edit_page', { page: 1, instruction: 'show the baby from the photo' });
    expect(out).toMatch(/\$0\.\d\d/);
    expect(turn.gated).toBe(true);
    expect(ctx.session.doc.gate).toMatchObject({ status: 'open', reason: 'no_intent' });
    await ctx.settled();
    expect(ctx.imagesFake.calls).toHaveLength(0);
  });
});

describe('render_cover free paths', () => {
  it('a title change on a drawn overlay cover is free; on a painted cover it is a quoted redraw', async () => {
    const doc = drawnLake();
    doc.cover = { ...doc.cover, lettering: 'overlay', render: { ...emptyRender(), status: 'ready', asset: { path: 'cover.webp', source: 'generated', at: 1 } } };
    setup(doc, [], { userText: 'rename the title to Duck Day', drawIntent: 'none' });
    expect(await call('render_cover', { title: 'Duck Day' })).toBe('Updated the cover text — free, it is lettered on top of the art (no redraw).');
    expect(ctx.session.doc.cover.title).toBe('Duck Day');
    expect(ctx.session.doc.gate).toBeNull();
    const painted = drawnLake();
    painted.cover = { ...painted.cover, render: { ...emptyRender(), status: 'ready', asset: { path: 'cover.webp', source: 'generated', at: 1 } } };
    setup(painted, [], { userText: 'rename the title to Duck Day', drawIntent: 'none' });
    await call('render_cover', { title: 'Duck Day' });
    expect(ctx.session.doc.gate).toMatchObject({ status: 'open', action: { type: 'render_cover' } });
  });

  it('textless is a one-time quoted re-render; a current cover with no change is $0', async () => {
    const doc = drawnLake();
    doc.cover = { ...doc.cover, render: { ...emptyRender(), status: 'ready', asset: { path: 'cover.webp', source: 'generated', at: 1 } } };
    setup(doc, [], { userText: 'make the cover textless so I can edit the title', drawIntent: 'explicit' });
    await call('render_cover', { textless: true });
    expect(ctx.session.doc.gate?.action).toMatchObject({ type: 'render_cover', textless: true });
    setup(doc, [], { userText: 'make the cover', drawIntent: 'explicit' });
    expect(await call('render_cover', {})).toMatch(/^Nothing to draw: the cover is already drawn and up to date/);
    expect(turn.outcome).toBe('nothing');
  });
});

describe('cast: non-humans and every photo kept', () => {
  it('upsert_character with kind/count/species/markings → "three Ducklings", a companion', async () => {
    setup(createEmptyDoc('proj-1'));
    await call('upsert_character', { name: 'The Baby', look: { summary: 'Toddler in a yellow sunhat' } });
    const out = await call('upsert_character', { name: 'Ducklings', kind: 'animal', count: 3, look: { summary: 'Fluffy yellow ducklings', species: 'mallard duckling', markings: 'orange beaks' } });
    expect(out).toMatch(/^Saved DUCKLINGS \(support, animal, ×3\)\./);
    const ducks = ctx.session.doc.cast.find((c) => c.name === 'Ducklings')!;
    expect(ducks).toMatchObject({ kind: 'animal', count: 3, tier: 'support', look: { species: 'mallard duckling', markings: 'orange beaks' } });
    expect(castNoun(ducks)).toBe('three Ducklings');
    expect(turn.captured).toContain('three Ducklings');
    // Back to one: count resets; a person never stores kind.
    await call('upsert_character', { name: 'Ducklings', count: 1 });
    expect(ctx.session.doc.cast.find((c) => c.name === 'Ducklings')!.count).toBe(1);
    expect(ctx.session.doc.cast[0].kind).toBeUndefined();
  });

  // P2-GATE L6: species / markings from the director go through sanitizeLook's cleaning (NUL, C1 controls,
  // split surrogates — all of which Postgres jsonb or a reader would choke on), never a raw re-read.
  it('upsert_character stores CLEANED species / markings (no NUL, no C1 control, no lone surrogate)', async () => {
    setup(createEmptyDoc('proj-1'));
    const dirty = { summary: 'A small fox', species: 'red\u0000 fox\u0085 \uD83E', markings: '\uDC00white\u0007 tail tip' };
    await call('upsert_character', { name: 'Fox', kind: 'animal', look: dirty });
    const fox = ctx.session.doc.cast.find((c) => c.name === 'Fox')!;
    expect(fox.look.species).toBe('red fox');
    expect(fox.look.markings).toBe('white tail tip');
    // An edit of the existing character takes the same path.
    await call('upsert_character', { name: 'Fox', look: { species: 'arctic\u0000 fox 🦊', markings: 'none\u009F' } });
    const after = ctx.session.doc.cast.find((c) => c.name === 'Fox')!;
    expect(after.look.species).toBe('arctic fox 🦊'); // a whole emoji (a valid pair) stays
    expect(after.look.markings).toBe('none');
    expect(JSON.stringify(after.look)).not.toMatch(/\\u0000|\\u0085|\\u009f|\\ud83e(?!\\udd8a)/i);
  });

  it('source analysis stores cleaned species / markings for a new cast member', async () => {
    const doc = createEmptyDoc('proj-1');
    setup(doc);
    turn.userText = 'PAGE 1\n' + 'A fox runs through the snow. '.repeat(80);
    vi.mocked(analyzeSource).mockImplementation(async ({ llm }) => {
      await llm.complete({ role: 'writer', messages: [{ role: 'user', content: 'analyze' }] });
      return {
        brief: {},
        cast: [{ name: 'Fox', tier: 'lead', look: { summary: 'A small fox', species: 'red\u0000 fox\u0085', markings: 'white\u0000 tail \uD83E' } }],
        places: [],
        model: 'writer-x'
      } as unknown as Awaited<ReturnType<typeof analyzeSource>>;
    });
    await call('save_source', { useMessage: true });
    const fox = ctx.session.doc.cast.find((c) => c.name === 'Fox')!;
    expect(fox.look).toMatchObject({ summary: 'A small fox', species: 'red fox', markings: 'white tail' });
  });

  it('"these 5 photos are Maya" → 5 refs, main = #1, an honest message (no silent slice(-4))', async () => {
    const photos = [1, 2, 3, 4, 5].map(attachment);
    setup(plannedDoc(), photos, { userText: 'these 5 photos are Maya' });
    const out = await call('upsert_character', { name: 'Maya', attachmentRefs: [1, 2, 3, 4, 5] });
    expect(out).toContain('Added 5 photos to MAYA.');
    expect(out).toContain("offer to make MAYA's model sheet from these photos");
    expect(ctx.session.doc.cast[0].refs.map((r) => r.path)).toEqual(photos.map((p) => p.path));
    expect(ctx.session.doc.cast[0].sheet.status).toBe('none'); // never redrawn or staled by an upload
  });

  it('carried images continue the numbering', async () => {
    const carried = { ...attachment(9), addedBy: 'user' as const };
    setup(plannedDoc(), [attachment(1)], { images: [attachment(1), carried], userText: 'the second one is Arjun' });
    await call('upsert_character', { name: 'Arjun', attachmentRefs: [2] });
    expect(ctx.session.doc.cast[1].refs.map((r) => r.path)).toEqual([carried.path]);
    expect(await call('upsert_character', { name: 'Arjun', attachmentRefs: [3] })).toMatch(/only 2 image\(s\) available/);
  });

  it('plan_pages casts recurring animals the writer left uncast (free safety net)', async () => {
    const doc = createEmptyDoc('proj-1');
    doc.brief.premise = 'A baby plays by a lake with other animals';
    doc.cast = [{ id: 'c_baby', name: 'The Baby', tier: 'lead', look: { summary: 'Toddler' }, refs: [], sheet: emptyRender() }];
    setup(doc);
    const page = { ...plannedDoc().pages[0], id: 'pg_1' };
    page.panels = page.panels.map((p, i) => ({ ...p, castIds: ['c_baby'], action: ['The Baby waves at three ducklings.', 'The ducklings follow a frog.', 'A frog leaps; the ducklings cheer.'][i] }));
    vi.mocked(writePagePlan).mockResolvedValue({ pages: [page], newCast: [], model: 'w' });
    const out = await call('plan_pages', {});
    const names = ctx.session.doc.cast.map((c) => c.name);
    expect(names).toEqual(expect.arrayContaining(['Ducklings', 'Frog']));
    if (!/Also added to the cast/.test(out)) {
      // jobs.planPages ran castScan itself; the director's safety net found nothing left to add.
      expect(ctx.session.doc.cast.filter((c) => c.name === 'Ducklings')).toHaveLength(1);
    }
  });
});

describe('lettering edits keep ids, pins and translations', () => {
  const lakeWithText = () => {
    const doc = drawnLake();
    doc.i18n = { editions: { hi: { lang: 'hi', lines: { ln_l3: { text: 'अलविदा, दोस्तों!', status: 'reviewed', sourceHash: 'x', at: 1 } }, balloons: {}, register: 'everyday' } }, glossary: [] };
    return doc;
  };

  it('edit_panel_text keeps the id (pinned balloon + translation survive) when kind and speaker match', async () => {
    setup(lakeWithText(), [], { userText: 'change what the baby says' });
    const out = await call('edit_panel_text', { page: 1, panel: 3, lines: [{ kind: 'speech', speaker: 'The Baby', text: 'Bye bye, ducks!' }] });
    expect(out).toBe('Page 1 panel 3 now has 1 line (1 kept in place).');
    const page = ctx.session.doc.pages[0];
    expect(page.panels[2].lines).toEqual([{ id: 'ln_l3', kind: 'speech', speakerId: 'c_baby', text: 'Bye bye, ducks!' }]);
    expect(page.balloons).toEqual([{ lineId: 'ln_l3', x: 0.62, y: 0.7, w: 0.3, pinned: true }]);
    expect(ctx.session.doc.i18n!.editions.hi.lines.ln_l3).toBeDefined();
    // Overlay text edits never stale the drawn page.
    expect(page.render.specHash).toBe(pageSpecHash(ctx.session.doc, page));
  });

  it('new lines get new ids at the right position; changed kinds replace; style and position apply', async () => {
    setup(lakeWithText());
    await call('edit_panel_text', {
      page: 1,
      panel: 3,
      lines: [
        { kind: 'caption', text: 'Sunset at the lake.', position: 'top-left' },
        { kind: 'speech', speaker: 'The Baby', text: 'Bye-bye, friends!', style: { text_color: 'red', size: 'larger', shape: 'cloud' } }
      ]
    });
    const panel = ctx.session.doc.pages[0].panels[2];
    expect(panel.lines.map((l) => l.kind)).toEqual(['caption', 'speech']);
    expect(panel.lines[1].id).not.toBe('ln_l3'); // position 2 had no old line → new id
    // Parsed by the lettering engine (same words as restyle_balloons): "larger" = ×1.2 of the line's current size.
    expect(panel.lines[1].style).toMatchObject({ textColor: expect.stringMatching(/^#/), sizeScale: 1.2, shape: 'cloud' });
    const caption = ctx.session.doc.pages[0].balloons.find((b) => b.lineId === panel.lines[0].id);
    expect(caption).toMatchObject({ pinned: true });
    expect(caption!.x).toBeGreaterThanOrEqual(0);
    expect(caption!.y).toBeGreaterThanOrEqual(0);
    expect(caption!.x + caption!.w).toBeLessThanOrEqual(1);
    // The old line was deleted (its balloon and translation go with it).
    expect(ctx.session.doc.pages[0].balloons.some((b) => b.lineId === 'ln_l3')).toBe(false);
  });

  it('set_line changes one line in place (kind, speaker, text)', async () => {
    setup(lakeWithText());
    expect(await call('set_line', { page: 1, panel: 3, line: 1, kind: 'thought' })).toBe('Updated page 1 panel 3 line 1 (now thought). Free — no redraw needed.');
    const line = () => ctx.session.doc.pages[0].panels[2].lines[0];
    expect(line()).toMatchObject({ id: 'ln_l3', kind: 'thought', speakerId: 'c_baby' });
    await call('set_line', { page: 1, panel: 3, line: 1, kind: 'caption' });
    expect(line().kind).toBe('caption');
    expect(line().speakerId).toBeUndefined();
    expect(await call('set_line', { page: 1, panel: 3, line: 1, kind: 'shout' })).toMatch(/^Error: A shout line needs a speaker/);
    expect(await call('set_line', { page: 1, panel: 3, line: 1, kind: 'shout', speaker: 'Frog', text: 'Ribbit!' })).toMatch(/now shout/);
    expect(ctx.session.doc.pages[0].panels[2].castIds).toContain('c_frog');
    expect(await call('set_line', { page: 1, panel: 3, line: 4, text: 'x' })).toBe('Error: Page 1 panel 3 has lines 1–1.');
    expect(ctx.session.doc.pages[0].balloons[0].lineId).toBe('ln_l3');
  });
});

describe('set_format tells before staling', () => {
  it('reports what would go out of date (with the price) and only applies with confirm:true', async () => {
    setup(drawnLake());
    const out = await call('set_format', { pageAspect: '1:1' });
    expect(out).toMatch(/^Not changed yet: this makes 1 drawn page out of date \(redrawing ≈ \$\d+\.\d\d\)\./);
    expect(ctx.session.doc.format.pageAspect).toBe('4:5');
    const applied = await call('set_format', { pageAspect: '1:1', confirm: true });
    expect(applied).toMatch(/1 drawn page is now out of date/);
    expect(ctx.session.doc.format.pageAspect).toBe('1:1');
    // A change that stales nothing applies at once.
    expect(await call('set_format', { readingDirection: 'rtl' })).toMatch(/^Format: /);
  });
});

describe('per-turn tool trimming tuned on the golden set', () => {
  const fake = (name: string): DirectorTool => ({ spec: { type: 'function', function: { name, description: name, parameters: { type: 'object', properties: {} } } }, cost: 'free', execute: async () => 'ok' });
  const groups = (): ToolGroup[] => [
    { id: 'timeline', priority: 30, tools: () => ['move_page', 'insert_page', 'delete_page'].map(fake) },
    { id: 'lettering', priority: 50, tools: () => ['set_lettering_style', 'restyle_balloons', 'arrange_balloons'].map(fake) }
  ];

  it('keeps the group the user is talking about when the cap must drop one', () => {
    const doc = plannedDoc();
    const coreCount = buildDirectorTools(testContext(newSession(doc)), createDirectorTurn()).length;
    const max = coreCount + 3;
    const plain = buildTurnToolset(testContext(newSession(doc)), createDirectorTurn({ userText: 'next' }), groups(), { maxTools: max });
    expect(plain.groups).toEqual(['timeline']);
    const lettering = buildTurnToolset(testContext(newSession(doc)), createDirectorTurn({ userText: 'make all the shouts red' }), groups(), { maxTools: max });
    expect(lettering.groups).toEqual(['lettering']);
    expect(lettering.tools.map((t) => t.spec.function.name)).toContain('set_lettering_style');
    expect(GROUP_HINTS.refs!.test('these photos are Maya')).toBe(true);
    expect(GROUP_HINTS.i18n!.test('make it in Telugu')).toBe(true);
  });
});
