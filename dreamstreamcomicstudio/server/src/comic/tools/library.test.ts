// @vitest-environment node
// Library tools + the use_preset action (contract §12.2): suggest_presets posts a free
// style_presets card ranked by rankPresets; use_preset drafts the preset's style for $0 (no image
// generation, ever), keeps the user's own "avoid" rules, clears an off-style board and marks the
// card picked. The group is gated to an empty or drafted style.
import { describe, expect, it } from 'vitest';
import type { Card, ComicDoc } from '../../../../shared/comic/doc.js';
import { getStylePreset, rankPresets } from '../../../../shared/comic/stylePresets.js';
import { newSession, opsOf, plannedDoc, testContext } from '../orchestrator.fakes.js';
import { createDirectorTurn } from '../tools.js';
import { ACTION_HANDLERS } from '../actions/index.js';
import { FREE_NOTE, __setPresetBoardLookup, mergedAvoid, pickCardOps, runUsePreset } from '../actions/library.js';
import { libraryToolGroup, parsePresetIds } from './library.js';

const kidsDoc = (): ComicDoc => {
  const doc = plannedDoc('lib-1');
  doc.brief = { ...doc.brief, genre: 'picture book', audience: 'kids 2–6' };
  doc.style = { status: 'empty', refs: [], options: [] };
  doc.format = { ...doc.format, kind: 'storybook', colorMode: 'color' };
  return doc;
};

const setup = (doc = kidsDoc()) => {
  const session = newSession(doc);
  const ctx = testContext(session);
  const turn = createDirectorTurn();
  const tools = Object.fromEntries(libraryToolGroup.tools(ctx, turn).map((t) => [t.spec.function.name, t]));
  return { session, ctx, turn, tools };
};

describe('library tool group', () => {
  it('is free, phase-gated to an empty or drafted style, and describes itself as FREE', () => {
    const { ctx, turn, tools } = setup();
    expect(libraryToolGroup.when!(ctx, turn)).toBe(true);
    expect(Object.keys(tools).sort()).toEqual(['suggest_presets', 'use_preset']);
    for (const t of Object.values(tools)) {
      expect(t.cost).toBe('free');
      expect(t.spec.function.description.startsWith('FREE — ')).toBe(true);
    }
    const locked = kidsDoc();
    locked.style = { ...locked.style, status: 'locked', spec: 'x' };
    const s = setup(locked);
    expect(libraryToolGroup.when!(s.ctx, s.turn)).toBe(false);
    expect(libraryToolGroup.promptRules!(kidsDoc())).toMatch(/suggest_presets/);
    expect(libraryToolGroup.summaryLines!(kidsDoc(), turn)[0]).toMatch(/Storybook watercolor/);
  });

  it('suggest_presets posts one style_presets card (ranked when no ids), spends nothing', async () => {
    const { tools, turn, ctx } = setup();
    const text = await tools.suggest_presets.execute({});
    const card = turn.cards.find((c) => c.type === 'style_presets') as Extract<Card, { type: 'style_presets' }>;
    expect(card.presetIds).toEqual(rankPresets(kidsDoc()).slice(0, 4));
    expect(card.presetIds[0]).toBe('watercolor-storybook');
    expect(text).toMatch(/Showing 4 styles/);
    // A second call replaces the card; ids are validated and capped.
    await tools.suggest_presets.execute({ presetIds: ['noir-ink', 'noir-ink', 'manga-screentone'], note: 'Moody\u0000 picks' });
    const cards = turn.cards.filter((c) => c.type === 'style_presets') as Extract<Card, { type: 'style_presets' }>[];
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ presetIds: ['noir-ink', 'manga-screentone'], note: 'Moody picks' });
    expect(await tools.suggest_presets.execute({ presetIds: ['tintin-ish'] })).toMatch(/^Error: Unknown preset tintin-ish/);
    expect(ctx.imagesFake.calls).toHaveLength(0);
    expect(parsePresetIds(kidsDoc(), Array.from({ length: 9 }, (_, i) => ['noir-ink', 'retro-pop', 'webtoon-cel', 'cozy-anime', 'dark-fantasy', 'cartoon-strip', 'indie-risograph', 'ligne-claire', 'modern-heroic'][i]))).toHaveLength(6);
  });

  it('use_preset drafts the style for free and never draws', async () => {
    const { tools, session, ctx } = setup();
    const text = await tools.use_preset.execute({ presetId: 'watercolor-storybook' });
    expect(text).toContain(FREE_NOTE);
    expect(session.doc.style).toMatchObject({ status: 'drafted', presetId: 'watercolor-storybook', name: 'Storybook watercolor' });
    expect(ctx.imagesFake.calls).toHaveLength(0);
    expect(await tools.use_preset.execute({ presetId: 'nope' })).toMatch(/^Error: Unknown preset/);
  });
});

describe('use_preset action', () => {
  it('is registered as a non-spend action', () => {
    expect(ACTION_HANDLERS.use_preset?.spend).toBe(false);
  });

  it('keeps user avoid rules, clears an off-style board, aligns colour mode, marks the card picked', async () => {
    const doc = kidsDoc();
    doc.style = {
      status: 'locked',
      presetId: 'retro-pop',
      name: 'Retro pop',
      spec: 'old',
      avoid: ['gradients', 'no gore'],
      refs: [],
      options: [],
      board: { path: 'u/user-1/p/lib-1/img/board.webp', source: 'generated', at: 1 }
    };
    doc.conversation = [
      ...doc.conversation,
      { id: 'm-presets', role: 'assistant', text: 'Pick a look', at: 1, cards: [{ type: 'style_presets', id: 'c1', presetIds: ['noir-ink', 'retro-pop'] }] }
    ];
    const session = newSession(doc);
    const ctx = testContext(session);
    const out = await runUsePreset(ctx, { type: 'use_preset', presetId: 'noir-ink' }, { confirmed: true });
    expect(out.outcome.status).toBe('done');
    const style = session.doc.style;
    expect(style.status).toBe('drafted');
    expect(style.board ?? null).toBeNull();
    expect(style.avoid).toEqual(['full color', 'soft airbrushing', 'cute proportions', 'no gore']);
    expect(session.doc.format.colorMode).toBe('bw');
    const card = session.doc.conversation.find((m) => m.id === 'm-presets')!.cards![0] as Extract<Card, { type: 'style_presets' }>;
    expect(card.picked).toBe('noir-ink');
    // A UI tap leaves a short confirmation in the conversation.
    expect(session.doc.conversation.at(-1)!.text).toContain('Noir ink');
    expect(opsOf(ctx.events).some((o) => o.op === 'style')).toBe(true);
    expect(ctx.imagesFake.calls).toHaveLength(0);
  });

  it('is idempotent for the current preset and honest for an unknown one', async () => {
    const doc = kidsDoc();
    const session = newSession(doc);
    const ctx = testContext(session);
    await runUsePreset(ctx, { type: 'use_preset', presetId: 'cartoon-strip' }, { confirmed: true });
    const rev = session.doc.conversation.length;
    const again = await runUsePreset(ctx, { type: 'use_preset', presetId: 'cartoon-strip' }, { confirmed: true });
    expect(again.outcome.message).toMatch(/already/);
    expect(session.doc.conversation.length).toBe(rev);
    const bad = await runUsePreset(ctx, { type: 'use_preset', presetId: 'x' }, { confirmed: true });
    expect(bad.outcome).toMatchObject({ status: 'blocked', code: 'BAD_REQUEST' });
  });

  it('withBoard stays off unless the flag is on (the lookup is never called)', async () => {
    let looked = 0;
    const prev = __setPresetBoardLookup(async () => {
      looked += 1;
      return null;
    });
    const session = newSession(kidsDoc());
    const out = await runUsePreset(testContext(session), { type: 'use_preset', presetId: 'noir-ink', withBoard: true }, { confirmed: true });
    expect(out.outcome.message).toMatch(/comparison only/);
    expect(looked).toBe(0);
    expect(session.doc.style.board).toBeFalsy();
    __setPresetBoardLookup(prev);
  });

  it('helpers: mergedAvoid drops the old preset’s rules; pickCardOps is a no-op without a card', () => {
    const doc = kidsDoc();
    doc.style = { ...doc.style, presetId: 'noir-ink', avoid: ['full color', 'my rule'] };
    expect(mergedAvoid(doc, { ...getStylePreset('retro-pop')!, avoid: ['neon'] })).toEqual(['neon', 'my rule']);
    expect(pickCardOps(kidsDoc(), 'noir-ink')).toEqual([]);
  });
});
