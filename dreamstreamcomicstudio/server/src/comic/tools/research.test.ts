// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { newSession, plannedDoc, testContext } from '../orchestrator.fakes.js';
import { createDirectorTurn } from '../tools.js';
import { researchToolGroup } from './research.js';

const provider = vi.hoisted(() => ({ search: vi.fn(), unavailable: false }));
vi.mock('../research.js', () => ({
  searchComicResearch: async (query: string) => {
    if (provider.unavailable) throw new Error('Provider unavailable');
    return provider.search(query);
  }
}));

const article = { title: 'Kyōto Station', source: 'https://en.wikipedia.org/wiki/Kyoto_Station', description: 'Railway station' };
const image = {
  title: 'Station exterior', source: 'https://commons.wikimedia.org/wiki/File%3AStation.jpg',
  thumbnail: 'https://thumb.wikimedia.org/wikipedia/commons/thumb/9/99/Station.jpg/320px-Station.jpg',
  license: 'CC BY 4.0', credit: 'Photographer'
};
const results = { articles: [article], images: [image], incomplete: false };
const setup = () => {
  const ctx = testContext(newSession(plannedDoc()));
  const turn = createDirectorTurn();
  return { ctx, turn, tool: researchToolGroup.tools(ctx, turn)[0] };
};

beforeEach(() => {
  provider.search.mockReset();
  provider.unavailable = false;
});

describe('Director research cards', () => {
  it('posts selectable source data while preserving the compact model result', async () => {
    provider.search.mockReturnValue(results);
    const { ctx, turn, tool } = setup();
    const output = await tool.execute({ query: '  Kyoto\n station  ' });
    expect(provider.search).toHaveBeenCalledWith('Kyoto station');
    expect(turn.cards).toEqual([{ type: 'research', id: expect.any(String), query: 'Kyoto station', results }]);
    expect(JSON.parse(output)).toEqual({ sources: [article], imageSources: [{ title: image.title, source: image.source, license: image.license, credit: image.credit }], incomplete: false });
    expect(tool.cost).toBe('free');
    expect(ctx.imagesFake.calls).toHaveLength(0);
  });

  it('replaces same-query retries in the turn and preserves distinct searches', async () => {
    provider.search.mockReturnValue(results);
    const { turn, tool } = setup();
    await tool.execute({ query: 'Kyoto station' });
    const firstId = turn.cards[0].id;
    await tool.execute({ query: 'KYOTO station' });
    await tool.execute({ query: 'Kyoto palace' });
    expect(turn.cards).toHaveLength(2);
    expect(turn.cards).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: firstId, query: 'KYOTO station' }), expect.objectContaining({ query: 'Kyoto palace' })
    ]));
  });

  it('preserves valid empty and incomplete outcomes without inventing sources', async () => {
    provider.search.mockReturnValue({ articles: [], images: [], incomplete: true });
    const { turn, tool } = setup();
    expect(JSON.parse(await tool.execute({ query: 'Kyoto fixture' }))).toEqual({ sources: [], imageSources: [], incomplete: true });
    expect(turn.cards[0]).toMatchObject({ type: 'research', results: { articles: [], images: [], incomplete: true } });
  });

  it('rejects bad queries and keeps unavailable results out of stored cards', async () => {
    const { turn, tool } = setup();
    expect(await tool.execute({ query: 'x' })).toMatch(/^Error:/);
    expect(await tool.execute({ query: 'x'.repeat(121) })).toMatch(/^Error:/);
    expect(provider.search).not.toHaveBeenCalled();
    provider.unavailable = true;
    const output = await tool.execute({ query: 'Kyoto fixture' });
    expect(output).toBe('The research sources are temporarily unavailable.');
    expect(turn.cards).toEqual([]);
  });
});
