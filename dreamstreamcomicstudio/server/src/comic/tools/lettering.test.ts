import { describe, expect, it } from 'vitest';
import type { ComicDoc } from '../../../../shared/comic/doc.js';
import { estimateMeasure, letteringAspect, letteringSizer, placementCoverOptions, planLettering, PLAN_W } from '../../../../shared/comic/lettering/layout.js';
import { p2ShapedDoc } from '../../../../shared/comic/lettering/__fixtures__/letterFit.js';
import { panelBoxesFor } from '../../../../shared/comic/pageGeometry.js';
import { PANEL_LIMITS } from '../../../../shared/comic/panelRules.js';
import { coverageOf, placeBalloonsWholeWords, safeAreaBox } from '../../../../shared/comic/lettering/place.js';
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

  it('counts only balloons that really changed; a more specific override is called out', async () => {
    const { ctx, call } = setup((d) => {
      d.letterStyle = { presetId: 'classic', kinds: { speech: { textColor: '#1d3557' } } };
      d.pages[0].panels[0].lines = [{ id: 'cap_x', kind: 'caption', text: 'Meanwhile…' }];
    });
    const res = await call('set_lettering_style', { style: { text_color: 'red' } });
    const speech = ctx.session.doc.pages.flatMap((p) => p.panels.flatMap((pn) => pn.lines)).filter((l) => l.kind === 'speech' && l.text.trim()).length;
    const all = ctx.session.doc.pages.flatMap((p) => p.panels.flatMap((pn) => pn.lines)).filter((l) => l.text.trim()).length;
    expect(all - speech).toBe(1);
    expect(res).toMatch(/1 balloon restyled/);
    expect(res).toMatch(new RegExp(`${speech} balloons? keeps? a more specific setting`));
    const again = await call('set_lettering_style', { style: { text_color: 'red' } });
    expect(again).toMatch(/0 balloons restyled/);
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
    ctx.session.commit([{ op: 'line_style', pageId: 'pg_1', lineIds: ['ln_1_2'], patch: { textColor: '#000000', italic: true } }], { origin: 'director', label: 't' });
    await call('restyle_balloons', { target: { page: 1 }, reset: true, style: { shape: 'burst' } });
    expect(ctx.session.doc.pages[0].panels[1].lines[0].style).toEqual({ shape: 'burst' });
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

  it('auto_layout saves under the comic’s coverage cap: a children’s book is held to 0.25 (A4 wave note 3)', async () => {
    const kids = p2ShapedDoc({ kids: true, panel6: 'one' });
    const { ctx, call } = setup((d) => Object.assign(d, kids.doc));
    const res = await call('arrange_balloons', { page: 2, action: 'auto_layout' });
    expect(res).toMatch(/^Re-lettered page 2: placed /);
    noSpend(ctx);
    const doc = ctx.session.doc;
    const page = doc.pages[0];
    const aspect = letteringAspect(doc, page);
    const sizer = letteringSizer(doc, page, aspect, estimateMeasure);
    const { fillFor } = placementCoverOptions(doc);
    const lines = new Map(page.panels.flatMap((p) => p.lines).map((l) => [l.id, l]));
    const panel5 = (balloons: typeof page.balloons) =>
      coverageOf(
        panelBoxesFor(doc, page)[4],
        balloons.map((b) => {
          const sz = sizer(lines.get(b.lineId)!, b.w);
          return { outline: { x: b.x + sz.bounds.x, y: b.y + sz.bounds.y, w: sz.bounds.w, h: sz.bounds.h }, fill: fillFor(lines.get(b.lineId)!) };
        })
      );
    expect(panel5(kids.page.balloons)).toBeGreaterThan(PANEL_LIMITS.coverCapKids + 0.01);
    expect(panel5(page.balloons)).toBeLessThanOrEqual(PANEL_LIMITS.coverCapKids + 1e-9);
    // Pinned balloons stay exactly as the user placed them.
    for (const b of kids.page.balloons.filter((x) => x.pinned)) expect(page.balloons.find((x) => x.lineId === b.lineId)).toEqual(b);
  });

  describe('starts from where the board draws a balloon the coverage cap moved (never its stored spot)', () => {
    /** p2ShapedDoc: panel 6's stored, unpinned ln_6a is drawn elsewhere by the cap (crowded, reason 'cover'). */
    const capMoved = () => {
      const p2 = p2ShapedDoc();
      const { ctx, call } = setup((d) => Object.assign(d, p2.doc));
      const doc = ctx.session.doc;
      const aspect = letteringAspect(doc, doc.pages[0]);
      const planOf = (d: ComicDoc) => planLettering(d, d.pages[0], aspect, estimateMeasure).find((p) => p.lineId === 'ln_6a')!;
      const before = planOf(doc);
      expect(before.crowdedReason).toBe('cover');
      const stored = doc.pages[0].balloons.find((b) => b.lineId === 'ln_6a')!;
      expect(Math.abs(before.y / (PLAN_W / aspect) - stored.y)).toBeGreaterThan(0.02);
      return { ctx, call, before, planOf, H: PLAN_W / aspect };
    };

    it('lock pins it where it is drawn: its planned spot does not move', async () => {
      const { ctx, call, before, planOf } = capMoved();
      const res = await call('arrange_balloons', { page: 2, action: 'lock', target: { line_ids: ['ln_6a'] } });
      expect(res).toMatch(/^Locked /);
      expect(opsOf(ctx.events).at(-1)).toMatchObject({ op: 'balloon', lineId: 'ln_6a', patch: { locked: true, pinned: true } });
      const after = planOf(ctx.session.doc);
      expect(after.x).toBeCloseTo(before.x, 1);
      expect(after.y).toBeCloseTo(before.y, 1);
      noSpend(ctx);
    });

    it('nudge moves it by exactly dx/dy from where it is drawn', async () => {
      const { ctx, call, before, planOf, H } = capMoved();
      await call('arrange_balloons', { page: 2, action: 'nudge', target: { line_ids: ['ln_6a'] }, dx: -0.01, dy: 0.005 });
      const after = planOf(ctx.session.doc);
      expect(after.x).toBeCloseTo(before.x - 0.01 * PLAN_W, 0);
      expect(after.y).toBeCloseTo(before.y + 0.005 * H, 0);
    });

    it('resize keeps it at its drawn spot (only the width changes, about its centre)', async () => {
      const { ctx, call, before, planOf } = capMoved();
      await call('arrange_balloons', { page: 2, action: 'resize', target: { line_ids: ['ln_6a'] }, width_scale: 1 });
      const after = planOf(ctx.session.doc);
      expect(after.x).toBeCloseTo(before.x, 0);
      expect(after.y).toBeCloseTo(before.y, 0);
    });
  });

  it('a software-placed line is nudged from where the board draws it (pageCtx, A4 wave note 3)', async () => {
    const kids = p2ShapedDoc({ kids: true, panel6: 'one' });
    kids.page.balloons = kids.page.balloons.filter((b) => b.lineId !== 'ln_5');
    const { ctx, call } = setup((d) => Object.assign(d, kids.doc));
    const doc = ctx.session.doc;
    const page = doc.pages[0];
    const aspect = letteringAspect(doc, page);
    const args = {
      page, boxes: panelBoxesFor(doc, page), aspect, rtl: false, plansFor: letteringSizer(doc, page, aspect, estimateMeasure),
      keepOut: page.render.qc?.keepOut, heads: page.render.qc?.heads, safeMargin: 0.03, existing: page.balloons, keep: 'all' as const, lang: doc.format.language
    };
    const plain = placeBalloonsWholeWords(args).balloons.find((b) => b.lineId === 'ln_5')!;
    // The board letters the line under the kids' cap (the render-time cap re-places it): that is where it is drawn.
    const H = PLAN_W / aspect;
    const drawn = planLettering(doc, page, aspect, estimateMeasure).find((p) => p.lineId === 'ln_5')!;
    expect([drawn.x / PLAN_W, drawn.y / H]).not.toEqual([plain.x, plain.y]);
    await call('arrange_balloons', { page: 2, action: 'nudge', target: { line_ids: ['ln_5'] }, dy: 0.01 });
    const op = opsOf(ctx.events).at(-1) as { op: string; lineId: string; patch: { x: number; y: number; w: number } };
    expect(op).toMatchObject({ op: 'balloon', lineId: 'ln_5' });
    expect(op.patch.x).toBeCloseTo(drawn.x / PLAN_W, 4);
    expect(op.patch.w).toBeCloseTo(drawn.w / PLAN_W, 4);
    expect(op.patch.y).toBeCloseTo(drawn.y / H + 0.01, 4);
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

  it('moving several balloons to one spot stacks them (outlines never overlap), inside the safe area', async () => {
    for (const position of ['bottom', 'center', 'top-left']) {
      const { ctx, call } = setup(richDoc);
      expect(await call('arrange_balloons', { page: 1, action: 'move', target: { panel: 3 }, position })).toMatch(/^Moved 2 balloons/);
      const doc = ctx.session.doc;
      const page = doc.pages[0];
      const sizer = letteringSizer(doc, page, 2 / 3, estimateMeasure);
      const safe = safeAreaBox(0.03, 2 / 3);
      const outlines = page.panels[2].lines.map((line) => {
        const b = page.balloons.find((x) => x.lineId === line.id)!;
        const s = sizer(line, b.w);
        return { x: b.x + s.bounds.x, y: b.y + s.bounds.y, w: s.bounds.w, h: s.bounds.h };
      });
      const [a, b] = outlines;
      const overlapY = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
      const overlapX = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
      expect(overlapX <= 0 || overlapY <= 0, position).toBe(true);
      for (const o of outlines) {
        expect(o.y).toBeGreaterThanOrEqual(safe.y - 1e-4);
        expect(o.y + o.h).toBeLessThanOrEqual(safe.y + safe.h + 1e-4);
      }
    }
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
    // Board convention (styleOps.linkOps): the later balloon links to the previous one.
    expect(ctx.session.doc.pages[0].balloons.find((b) => b.lineId === 'sp2')!.linkTo).toBe('sp1');
    expect(ctx.session.doc.pages[0].balloons.find((b) => b.lineId === 'sp1')!.linkTo).toBeUndefined();
    // Unlinking either end of a link removes it.
    expect(await call('arrange_balloons', { page: 1, action: 'unlink', target: { line_ids: ['sp1'] } })).toMatch(/^Unlinked 1 balloon/);
    expect(ctx.session.doc.pages[0].balloons.find((b) => b.lineId === 'sp2')!.linkTo).toBeUndefined();
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

  it('linking never creates a loop with an older link (contract: no cycles)', async () => {
    const { ctx, call } = setup((d) => {
      richDoc(d);
      d.pages[0].balloons = [
        { lineId: 'sp1', x: 0.6, y: 0.6, w: 0.2, pinned: true, linkTo: 'sp2' },
        { lineId: 'sp2', x: 0.6, y: 0.75, w: 0.2, pinned: true }
      ];
    });
    expect(await call('arrange_balloons', { page: 1, action: 'link', target: { panel: 3 } })).toMatch(/^Linked 2 balloons/);
    const page = ctx.session.doc.pages[0];
    expect(page.balloons.find((b) => b.lineId === 'sp2')!.linkTo).toBe('sp1');
    expect(page.balloons.find((b) => b.lineId === 'sp1')!.linkTo).toBeUndefined();
    noSpend(ctx);
  });

  it('a "re-check" request never starts a paid vision call from the tool (free layout + honest note)', async () => {
    const { ctx, call, tools } = setup(richDoc);
    const arrange = tools.find((t) => t.spec.function.name === 'arrange_balloons')!;
    expect(JSON.stringify(arrange.spec.function.parameters)).not.toMatch(/recheck/);
    const res = await call('arrange_balloons', { page: 1, action: 'auto_layout', recheck: true });
    expect(res).toMatch(/^Re-lettered page 1/);
    expect(res).toMatch(/stored analysis \(free\); a fresh AI re-read of the artwork is a separate paid step/);
    noSpend(ctx);
    expect(opsOf(ctx.events).map((o) => o.op)).toEqual(['balloons']); // the layout only: no render/QC writes
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
