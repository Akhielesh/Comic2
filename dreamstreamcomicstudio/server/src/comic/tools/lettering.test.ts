import { describe, expect, it } from 'vitest';
import { emptyRender, type ComicDoc } from '../../../../shared/comic/doc.js';
import { estimateMeasure, letteringSizer } from '../../../../shared/comic/lettering/layout.js';
import { safeAreaBox } from '../../../../shared/comic/lettering/place.js';
import { newSession, opsOf, plannedDoc, testContext, type TestContext } from '../orchestrator.fakes.js';
import { createDirectorTurn, type DirectorTurn } from '../tools.js';
import { toolGroupById } from './index.js';
import { balloonAtPosition, letteringToolGroup, styleArgsToPatch } from './lettering.js';
import { resolveLetterStyle } from '../../../../shared/comic/lettering/style.js';

const setup = (mutate?: (doc: ComicDoc) => void, turnInit: Partial<DirectorTurn> = {}) => {
  const doc = plannedDoc();
  mutate?.(doc);
  const ctx = testContext(newSession(doc));
  const turn = createDirectorTurn(turnInit);
  const tools = letteringToolGroup.tools(ctx, turn);
  const call = (name: string, args: Record<string, unknown>) => tools.find((t) => t.spec.function.name === name)!.execute(args);
  return { ctx, turn, tools, call };
};
const noSpend = (ctx: TestContext) => {
  expect(ctx.llmFake.calls).toHaveLength(0);
  expect(ctx.billingFake.reserves).toHaveLength(0);
  expect(ctx.imagesFake.calls ?? []).toHaveLength(0);
};

describe('lettering tool group', () => {
  it('is registered, phase-gated to overlay comics with pages, and offers three FREE tools', () => {
    expect(toolGroupById('lettering')).toBe(letteringToolGroup);
    const { ctx, tools } = setup();
    expect(letteringToolGroup.when!(ctx, createDirectorTurn())).toBe(true);
    expect(tools.map((t) => t.spec.function.name)).toEqual(['set_lettering_style', 'restyle_balloons', 'arrange_balloons']);
    for (const t of tools) {
      expect(t.cost).toBe('free');
      expect(t.spec.function.description.startsWith('FREE — ')).toBe(true);
    }
    const inArt = setup((d) => (d.format = { ...d.format, lettering: 'in_art' }));
    expect(letteringToolGroup.when!(inArt.ctx, createDirectorTurn())).toBe(false);
    const empty = setup((d) => (d.pages = []));
    expect(letteringToolGroup.when!(empty.ctx, createDirectorTurn())).toBe(false);
  });

  it('prompt rules + summary lines (preset, overrides, the user’s selection)', () => {
    const { ctx } = setup((d) => {
      d.letterStyle = { presetId: 'classic', auto: true, kinds: { sfx: { font: 'ultra' } } };
      d.pages[0].panels[1].lines[0].style = { textColor: '#e63946' };
    });
    const doc = ctx.session.doc;
    expect(letteringToolGroup.promptRules!(doc)).toMatch(/FREE overlay edits/);
    const lines = letteringToolGroup.summaryLines!(doc, createDirectorTurn({ focus: { pageId: 'pg_1', lineIds: ['ln_1_2'] } }));
    expect(lines[0]).toMatch(/^Lettering: preset classic \(auto; noir fits this comic\)|^Lettering: preset classic \(auto\)/);
    expect(lines[0]).toMatch(/sfx font Ultra/);
    expect(lines[0]).toMatch(/1 balloon override/);
    expect(lines[1]).toMatch(/^The user has selected on page 1: \[ln_1_2\] “Line on page 1” \(speech, Maya\)/);
  });
});

describe('set_lettering_style', () => {
  it('switches the preset (free) and says what changed', async () => {
    const { ctx, call } = setup(undefined, { userText: 'use a kids storybook lettering' });
    const res = await call('set_lettering_style', { preset: 'storybook' });
    expect(res).toMatch(/Lettering is now \*Kids storybook\*/);
    expect(res).toMatch(/3 balloons restyled/);
    expect(res).toMatch(/Free — done by the editor/);
    expect(ctx.session.doc.letterStyle).toMatchObject({ presetId: 'storybook', auto: false });
    const ev = ctx.events.find((e) => e.type === 'ops');
    expect(ev).toMatchObject({ origin: 'director' });
    noSpend(ctx);
  });

  it('a director-chosen preset keeps auto when the user never asked about lettering', async () => {
    const { ctx, call } = setup((d) => (d.letterStyle = { presetId: 'classic', auto: true }), { userText: 'make it a cosy kids comic' });
    await call('set_lettering_style', { preset: 'storybook' });
    expect(ctx.session.doc.letterStyle).toMatchObject({ presetId: 'storybook', auto: true });
  });

  it('per-kind and per-speaker styles with friendly fonts and colour names', async () => {
    const { ctx, call } = setup();
    const res = await call('set_lettering_style', { scope: 'kind', kind: 'sfx', style: { font: 'impact', text_color: 'red', size: 'larger' } });
    expect(res).toMatch(/font Bangers, size ×1\.2, text red for sound-effect balloons/);
    expect(ctx.session.doc.letterStyle?.kinds?.sfx).toEqual({ font: 'bangers', sizeScale: 1.2, textColor: '#e63946' });
    await call('set_lettering_style', { speaker: 'maya', style: { shape: 'cloud', fill_color: '#ffeecc' } });
    expect(ctx.session.doc.letterStyle?.speakers?.c_maya).toEqual({ fill: '#ffeecc', shape: 'cloud' });
    const reset = await call('set_lettering_style', { scope: 'kind', kind: 'sfx', reset: true });
    expect(reset).toMatch(/Reset the custom lettering for sound-effect balloons/);
    expect(ctx.session.doc.letterStyle?.kinds?.sfx).toBeUndefined();
  });

  it('honest errors: unknown font / speaker / preset; a font without the comic’s script is called out', async () => {
    const { call } = setup((d) => (d.format = { ...d.format, language: 'te' }));
    expect(await call('set_lettering_style', { style: { font: 'wingdings' } })).toMatch(/^Error: I don't have a font called "wingdings". Choose one of: Comic Neue/);
    expect(await call('set_lettering_style', { speaker: 'Zed', style: { bold: true } })).toMatch(/^Error: scope "speaker" needs a cast member's name \(Maya, Arjun\)/);
    expect(await call('set_lettering_style', { preset: 'vaporwave' })).toMatch(/^Error: Unknown lettering preset/);
    expect(await call('set_lettering_style', { style: { text_color: 'blurple' } })).toMatch(/isn't a text colour I can use/);
    expect(await call('set_lettering_style', { style: { font: 'bangers' } })).toMatch(/Bangers has no letters for te/);
    expect(await call('set_lettering_style', {})).toMatch(/^Error: Give a preset/);
  });

  it('in-art comics get an explanation, not a silent no-op', async () => {
    const { ctx, call } = setup((d) => (d.format = { ...d.format, lettering: 'in_art' }));
    expect(await call('set_lettering_style', { preset: 'manga' })).toMatch(/painted into the artwork/);
    expect(opsOf(ctx.events)).toHaveLength(0);
  });
});

describe('restyle_balloons', () => {
  it('targets a speaker by name (case-insensitive) across pages and groups one op per page', async () => {
    const { ctx, call } = setup();
    const res = await call('restyle_balloons', { target: { speaker: 'MAYA' }, style: { text_color: 'navy', bold: false } });
    expect(res).toMatch(/^Restyled 2 of Maya's balloons on pages 1–2 \(regular weight, text navy\)\./);
    const ops = opsOf(ctx.events);
    expect(ops.map((o) => o.op)).toEqual(['line_style', 'line_style']);
    expect(ctx.session.doc.pages[0].panels[1].lines[0].style).toEqual({ weight: 400, textColor: '#1d3557' });
    noSpend(ctx);
  });

  it('nothing matched → says so and lists what exists (no ops)', async () => {
    const { ctx, call } = setup();
    const res = await call('restyle_balloons', { target: { kind: 'whisper', page: 1 }, style: { italic: true } });
    expect(res).toBe('No whisper balloons on page 1 matched — nothing was changed. page 1 has speech ×1.');
    const res2 = await call('restyle_balloons', { target: { speaker: 'Arjun', page: 1 }, style: { italic: true } });
    expect(res2).toMatch(/Arjun speaks on page 3/);
    expect(opsOf(ctx.events)).toHaveLength(0);
  });

  it('selected:true uses the turn focus; without a selection it asks', async () => {
    const withFocus = setup(undefined, { focus: { pageId: 'pg_2', lineIds: ['ln_2_2'] } });
    expect(await withFocus.call('restyle_balloons', { target: { selected: true }, style: { shape: 'burst' } })).toMatch(/^Restyled 1 balloon on page 2/);
    expect(withFocus.ctx.session.doc.pages[1].panels[1].lines[0].style).toEqual({ shape: 'burst' });
    const none = setup();
    expect(await none.call('restyle_balloons', { target: { selected: true }, style: { shape: 'burst' } })).toMatch(/Nothing is selected on the board/);
  });

  it('reset removes per-balloon overrides', async () => {
    const { ctx, call } = setup((d) => (d.pages[0].panels[1].lines[0].style = { textColor: '#000000' }));
    expect(await call('restyle_balloons', { target: { page: 1 }, reset: true })).toMatch(/back to the comic's lettering/);
    expect(ctx.session.doc.pages[0].panels[1].lines[0].style).toBeUndefined();
  });
});

describe('arrange_balloons', () => {
  const richDoc = (d: ComicDoc) => {
    d.pages[0].panels[0].lines = [{ id: 'cap1', kind: 'caption', text: 'The market at dawn.' }];
    d.pages[0].panels[2].lines = [
      { id: 'sp1', kind: 'speech', speakerId: 'c_maya', text: 'Wait for me!' },
      { id: 'sp2', kind: 'speech', speakerId: 'c_maya', text: 'I have the recipe.' }
    ];
    d.pages[0].balloons = [{ lineId: 'sp1', x: 0.6, y: 0.6, w: 0.2, pinned: true }];
  };

  it('auto_layout is free, keeps balloons the user placed, and reports what it did', async () => {
    const { ctx, call } = setup(richDoc);
    const res = await call('arrange_balloons', { page: 1, action: 'auto_layout' });
    expect(res).toMatch(/^Re-lettered page 1: placed 3 balloons around the art\. Kept 1 balloon you positioned\./);
    expect(res).toMatch(/Panel edges are estimated/);
    const page = ctx.session.doc.pages[0];
    expect(page.balloons.find((b) => b.lineId === 'sp1')).toEqual({ lineId: 'sp1', x: 0.6, y: 0.6, w: 0.2, pinned: true });
    expect(page.balloons.map((b) => b.lineId).sort()).toEqual(['cap1', 'ln_1_2', 'sp1', 'sp2']);
    noSpend(ctx);
    const all = await call('arrange_balloons', { page: 1, action: 'auto_layout', include_pinned: true });
    expect(all).toMatch(/placed 4 balloons/);
    expect(ctx.session.doc.pages[0].balloons.find((b) => b.lineId === 'sp1')!.pinned).toBeUndefined();
  });

  it('move puts a COMPLETE, pinned balloon in the panel corner inside the safe area', async () => {
    const { ctx, call } = setup(richDoc);
    const res = await call('arrange_balloons', { page: 1, action: 'move', target: { text_contains: 'recipe' }, position: 'top-right' });
    expect(res).toMatch(/^Moved the speech balloon “I have the recipe\.” to the top right of panel 3 on page 1/);
    const op = opsOf(ctx.events).at(-1)!;
    expect(op).toMatchObject({ op: 'balloon', lineId: 'sp2', patch: { pinned: true } });
    const patch = (op as { patch: { x: number; y: number; w: number } }).patch;
    for (const v of [patch.x, patch.y, patch.w]) expect(Number.isFinite(v)).toBe(true);
    const doc = ctx.session.doc;
    const page = doc.pages[0];
    const s = letteringSizer(doc, page, 2 / 3, estimateMeasure)(page.panels[2].lines[1], patch.w);
    const safe = safeAreaBox(0.03, 2 / 3);
    expect(patch.x + s.bounds.x + s.bounds.w).toBeLessThanOrEqual(safe.x + safe.w + 1e-4);
    expect(patch.y + s.bounds.y).toBeGreaterThanOrEqual(safe.y - 1e-4);
  });

  it('nudge clamps to the page; resize / front / lock / link behave; errors are actionable', async () => {
    const { ctx, call } = setup(richDoc);
    expect(await call('arrange_balloons', { page: 1, action: 'nudge', target: { line_ids: ['sp1'] } })).toMatch(/^Error: nudge needs dx/);
    expect(await call('arrange_balloons', { page: 1, action: 'nudge', target: { line_ids: ['sp1'] }, dx: 0.5 })).toMatch(/stopped at the page edge/);
    const sp1 = ctx.session.doc.pages[0].balloons.find((b) => b.lineId === 'sp1')!;
    expect(sp1.x + sp1.w).toBeLessThan(1);
    expect(await call('arrange_balloons', { page: 1, action: 'resize', target: { line_ids: ['sp1'] }, width_scale: 1.5 })).toMatch(/wider/);
    expect(await call('arrange_balloons', { page: 1, action: 'front', target: { line_ids: ['ln_1_2'] } })).toMatch(/to the front/);
    expect(await call('arrange_balloons', { page: 1, action: 'lock', target: { line_ids: ['sp2'] } })).toMatch(/^Locked/);
    expect(ctx.session.doc.pages[0].balloons.find((b) => b.lineId === 'sp2')).toMatchObject({ locked: true, pinned: true });
    expect(await call('arrange_balloons', { page: 1, action: 'link', target: { speaker: 'maya' } })).toMatch(/must be in the same panel/);
    expect(await call('arrange_balloons', { page: 1, action: 'link', target: { panel: 3 } })).toMatch(/^Linked 2 balloons in panel 3/);
    expect(ctx.session.doc.pages[0].balloons.find((b) => b.lineId === 'sp1')!.linkTo).toBe('sp2');
    expect(await call('arrange_balloons', { page: 1, action: 'unlink', target: { panel: 3 } })).toMatch(/^Unlinked 1 balloon/);
    expect(ctx.session.doc.pages[0].balloons.find((b) => b.lineId === 'sp1')!.linkTo).toBeUndefined();
    expect(await call('arrange_balloons', { page: 9, action: 'move' })).toMatch(/^Error: No page 9 — the comic has 3 pages/);
    expect(await call('arrange_balloons', { page: 1, action: 'move', position: 'top' })).toMatch(/^Error: Which balloon on page 1\?/);
    noSpend(ctx);
  });

  it('aim_tail: staged position when no face data; honest when the character is not in the panel', async () => {
    const { ctx, call } = setup(richDoc);
    const ok = await call('arrange_balloons', { page: 1, action: 'aim_tail', target: { line_ids: ['sp2'] }, tail_to: 'Maya' });
    expect(ok).toMatch(/^Pointed the tail at Maya on page 1 \(aimed where the page staged them/);
    const b = ctx.session.doc.pages[0].balloons.find((x) => x.lineId === 'sp2')!;
    expect(b.tailX).toBeGreaterThan(0);
    expect(b.tailY).toBeGreaterThan(b.y);
    const missing = await call('arrange_balloons', { page: 1, action: 'aim_tail', target: { line_ids: ['sp2'] }, tail_to: 'Arjun' });
    expect(missing).toMatch(/Arjun isn't in panel 3 \(.*\)|Arjun isn't in panel 3 on this page/);
  });

  it('recheck asks the vision path explicitly (only when requested)', async () => {
    const { call } = setup((d) => {
      richDoc(d);
      d.pages[0].render = emptyRender();
    });
    const res = await call('arrange_balloons', { page: 1, action: 'auto_layout', recheck: true });
    expect(res).toMatch(/vision model/);
  });
});

describe('helpers for core tools (edit_panel_text style/position)', () => {
  it('styleArgsToPatch maps natural args; balloonAtPosition returns a complete pinned balloon', () => {
    const doc = plannedDoc();
    const line = doc.pages[0].panels[1].lines[0];
    expect(styleArgsToPatch({ font: 'marker', text_color: 'gold', size: 'larger' }, resolveLetterStyle(doc, line))).toEqual({ font: 'permanent-marker', sizeScale: 1.2, textColor: '#ffc400' });
    expect(() => styleArgsToPatch({ shape: 'hexagon' }, resolveLetterStyle(doc, line))).toThrow(/Unknown bubble shape/);
    const b = balloonAtPosition(doc, doc.pages[0], line.id, 'bottom-left')!;
    expect(b).toMatchObject({ lineId: line.id, pinned: true });
    for (const v of [b.x, b.y, b.w]) expect(Number.isFinite(v)).toBe(true);
    expect(balloonAtPosition(doc, doc.pages[0], line.id, 'upstairs')).toBeUndefined();
    expect(balloonAtPosition(doc, doc.pages[0], 'nope', 'top')).toBeUndefined();
  });
});
