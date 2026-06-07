import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the heavy collaborators so the engine's orchestration is tested deterministically
// without network or a real model.
vi.mock('../autoRouter.js', () => ({
  pickTextModel: vi.fn(async () => 'free/worker'),
  TEXT_FALLBACK: 'fallback/model'
}));
vi.mock('../persona.js', () => ({ composePersona: (s: string) => s }));

const runChatMock = vi.fn();
vi.mock('../chat.js', () => ({ runChat: (...args: unknown[]) => runChatMock(...args) }));

const webSearchMock = vi.fn();
vi.mock('../tools/search.js', () => ({ webSearch: (...args: unknown[]) => webSearchMock(...args) }));

const fetchReadableMock = vi.fn();
vi.mock('./readable.js', () => ({ fetchReadable: (...args: unknown[]) => fetchReadableMock(...args) }));

import { runDeepResearch } from './deepResearch.js';

const base = { provider: 'openrouter' as const, apiKey: 'k', model: 'user/model' };

describe('runDeepResearch', () => {
  beforeEach(() => {
    runChatMock.mockReset();
    webSearchMock.mockReset();
    fetchReadableMock.mockReset();
    fetchReadableMock.mockResolvedValue(null); // default: snippet-only
  });

  it('plans sub-questions, gathers real sources, and synthesizes a grounded, cited brief', async () => {
    runChatMock
      .mockResolvedValueOnce({ text: '["What is X?","Latest on X?"]', usage: { totalTokens: 10 } }) // planner
      .mockResolvedValueOnce({ text: 'Bottom line. Finding [1][2].', model: 'user/model', usage: { totalTokens: 20 } }); // synth
    webSearchMock.mockImplementation(async (q: string) => ({
      results: [
        { title: `T1 ${q}`, url: 'https://a.com', snippet: 's1' },
        { title: `T2 ${q}`, url: 'https://b.com', snippet: 's2' }
      ],
      provider: 'duckduckgo',
      tried: ['duckduckgo'],
      status: 'ok'
    }));
    // The top source reads back full article text; it should be preferred over the snippet.
    fetchReadableMock.mockImplementation(async (url: string) =>
      url === 'https://a.com' ? 'FULL ARTICLE TEXT with the real numbers and detail.' : null
    );

    const res = await runDeepResearch({ ...base, topic: 'X', depth: 'standard' });

    expect(runChatMock).toHaveBeenCalledTimes(2); // plan + synth
    expect(webSearchMock).toHaveBeenCalledTimes(2); // one per planned question
    expect(fetchReadableMock).toHaveBeenCalled(); // standard depth reads top sources
    expect(res.text).toContain('Finding [1][2]');
    // Sources are deduped by url across questions → 2 unique, numbered/ordered.
    expect(res.citations).toEqual([
      { url: 'https://a.com', title: expect.stringContaining('T1') },
      { url: 'https://b.com', title: expect.stringContaining('T2') }
    ]);
    expect(res.trace.agents).toHaveLength(3); // 2 question steps + 1 "read sources" step
    expect(res.trace.agents.every((a) => a.status === 'done')).toBe(true);
    expect(res.toolEvents).toHaveLength(3); // 2 web_search + 1 read_url
    // The synthesis must be GROUNDED in the numbered evidence we pass it.
    const synthCall = runChatMock.mock.calls[1][0] as { messages: { content: string }[] };
    expect(synthCall.messages.at(-1)?.content).toContain('NUMBERED EVIDENCE');
    expect(synthCall.messages.at(-1)?.content).toContain('[1]');
    // The fetched full text must be what grounds synthesis (preferred over the snippet).
    expect(synthCall.messages.at(-1)?.content).toContain('FULL ARTICLE TEXT');
  });

  it('falls back to the bare topic when planning returns no usable questions', async () => {
    runChatMock
      .mockResolvedValueOnce({ text: 'not json at all', usage: {} })
      .mockResolvedValueOnce({ text: 'brief [1]', model: 'm', usage: {} });
    webSearchMock.mockResolvedValue({
      results: [{ title: 'T', url: 'https://a.com', snippet: 's' }],
      provider: 'ddg',
      tried: [],
      status: 'ok'
    });

    const res = await runDeepResearch({ ...base, topic: 'Solo Topic', depth: 'quick' });

    expect(webSearchMock).toHaveBeenCalledTimes(1);
    expect(webSearchMock).toHaveBeenCalledWith('Solo Topic', undefined, 5); // quick → perQuery 5
    expect(res.citations).toHaveLength(1);
  });

  it('returns an honest failure (no fabricated brief) when no sources are found', async () => {
    runChatMock.mockResolvedValueOnce({ text: '["Q1"]', usage: {} });
    webSearchMock.mockResolvedValue({ results: [], provider: 'none', tried: [], status: 'error' });

    const res = await runDeepResearch({ ...base, topic: 'Obscure thing', depth: 'quick' });

    // Synthesis is SKIPPED when there's nothing to ground on — only the planner ran.
    expect(runChatMock).toHaveBeenCalledTimes(1);
    expect(res.citations).toBeUndefined();
    expect(res.notices?.[0].level).toBe('error');
    expect(res.text.toLowerCase()).toContain("couldn't retrieve");
  });
});
