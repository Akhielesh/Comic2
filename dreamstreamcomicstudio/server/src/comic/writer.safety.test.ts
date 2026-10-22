// @vitest-environment node
// Post-plan pre-filter through the prefilterText seam (safety.md §3.2): text past the rating gets
// one repair round, and anything left is softened deterministically ($0).
import { describe, expect, it, vi } from 'vitest';
import { createEmptyDoc, emptyRender } from '../../../shared/comic/doc.js';
import { ratingProblems, softenPlanPages, writePagePlan } from './writer.js';
import type { LlmClient, LlmRequest, LlmResult } from './types.js';

vi.mock('./safety/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./safety/index.js')>();
  return {
    ...actual,
    prefilterText: (text: string) =>
      /\b(gore|blood)\b/i.test(text) ? { decision: 'block', categories: ['graphic_gore'], ip: [] } : { decision: 'clear', categories: [], ip: [] }
  };
});

const panel = (action: string, text = '') => ({ n: 1, size: 'wide', shot: 'wide', angle: '', action, castIds: ['ch_a'], placeId: '', mood: '', lines: text ? [{ kind: 'speech', speakerId: 'ch_a', text }] : [] });
const reply = (action: string, text = ''): Partial<LlmResult> => {
  const value = { pages: [{ n: 1, summary: 's', layout: '', turnHook: '', panels: [panel(action, text)] }], newCast: [] };
  return { json: value, text: JSON.stringify(value) };
};

const doc = () => {
  const d = createEmptyDoc('d', 'Night Shift', 1);
  d.format.pageCount = 1;
  d.cast = [{ id: 'ch_a', name: 'Asha', tier: 'lead', look: { summary: 'a guard' }, refs: [], sheet: emptyRender() }];
  return d;
};

const llmOf = (replies: Partial<LlmResult>[]) => {
  const calls: LlmRequest[] = [];
  const llm: LlmClient = {
    complete: async (req) => {
      calls.push(req);
      return { text: '', model: 'w', byok: false, provider: 'openrouter', ...replies.shift()! };
    }
  };
  return { llm, calls };
};

describe('post-plan pre-filter', () => {
  it('asks the writer once to fit the rating, then accepts the repaired plan', async () => {
    const { llm, calls } = llmOf([reply('Asha finds gore everywhere.'), reply('Asha finds the room in shadows.')]);
    const out = await writePagePlan({ doc: doc(), llm });
    expect(calls).toHaveLength(2);
    expect(String(calls[1].messages[calls[1].messages.length - 1].content)).toContain('goes past the PG-13 rating (graphic_gore)');
    expect(out.pages[0].panels[0].action).toBe('Asha finds the room in shadows.');
  });

  it('softens what is still past the rating after the repair (deterministic, $0)', async () => {
    const { llm } = llmOf([reply('Asha finds blood everywhere.', 'So much gore!'), reply('Asha finds blood everywhere.', 'So much gore!')]);
    const out = await writePagePlan({ doc: doc(), llm, rating: 'PG' });
    expect(out.pages[0].panels[0].action).toBe('Asha finds everywhere.');
    expect(out.pages[0].panels[0].lines[0].text).toBe('So much!');
  });

  it('ratingProblems / softenPlanPages leave clean pages untouched', () => {
    const pages = [{ id: 'p', n: 1, summary: '', layout: '', panels: [{ id: 'x', n: 1, size: 'wide' as const, shot: 'wide' as const, action: 'A calm night.', castIds: [], lines: [] }], render: emptyRender(), balloons: [] }];
    expect(ratingProblems(pages, 'PG-13')).toEqual([]);
    expect(softenPlanPages(pages, 'PG-13')[0]).toBe(pages[0]);
  });
});
