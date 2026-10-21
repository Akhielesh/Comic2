import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEmptyDoc, emptyRender, type AssetRef } from '../../../shared/comic/doc.js';
import { JOB_TIMINGS } from './jobs.js';
import { newSession, plannedDoc, testContext, type TestContext } from './orchestrator.fakes.js';
import { buildDirectorTools, createDirectorTurn, type DirectorTool, type DirectorTurn } from './tools.js';
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

const setup = (doc = plannedDoc(), attachments: AssetRef[] = []) => {
  ctx = testContext(newSession(doc));
  turn = createDirectorTurn({ attachments, userText: 'the user message' });
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
    expect(await call('update_brief', { title: '  Night  Market ', genre: 'noir', themes: ['trust', ''] })).toBe('Brief updated: title, genre, themes.');
    expect(ctx.session.doc.brief).toMatchObject({ title: 'Night Market', genre: 'noir', themes: ['trust'] });
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
    expect(out).toContain('Saved MAYA (lead) with 1 reference image');
    expect(out).toContain("sheet is now out of date");
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
    expect(turn.cards.map((c) => c.type)).toEqual(['plan']);
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
});

describe('spend tools', () => {
  it('render_pages refuses without a plan', async () => {
    const doc = plannedDoc();
    doc.pages = [];
    doc.planStatus = 'none';
    setup(doc);
    expect(await call('render_pages', {})).toMatch(/^Refused: there is no page plan yet/);
  });

  it('render_pages is gate-aware and collects the gate card', async () => {
    const doc = plannedDoc();
    doc.settings.confirm = 'always';
    setup(doc);
    const out = await call('render_pages', { pages: [1, 2] });
    expect(out).toMatch(/^Waiting for the user to approve ~\$\d+\.\d\d \(2 pages \+ 2 character sheets on Nano Banana 2\.1\)\.$/);
    expect(turn.cards.map((c) => c.type)).toEqual(['gate']);
    expect(ctx.session.doc.gate?.action).toEqual({ type: 'render_pages', pageIds: ['pg_1', 'pg_2'], force: true });
    expect(ctx.imagesFake.calls).toHaveLength(0);
  });

  it('render_pages under the confirm threshold starts drawing in the background', async () => {
    const out = await call('render_pages', {});
    expect(out).toMatch(/^Started drawing 3 pages \+ 2 character sheets/);
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
});
