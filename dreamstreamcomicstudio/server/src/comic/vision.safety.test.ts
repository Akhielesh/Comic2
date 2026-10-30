// @vitest-environment node
// P1-RENDER: the page QC call also rates the image (safety.md §3.3). The vision reply's `safety`
// block is folded by P1-SAFETY's verdictFromVision (missing ⇒ unchecked, never a pass), and every
// piece of text read off the art goes through the free word pre-filter before it is stored.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createEmptyDoc, emptyRender, type ComicDoc, type Line, type Page, type Panel } from '../../../shared/comic/doc.js';
import { SAFETY_CATEGORIES } from '../../../shared/comic/safety.js';
import type { LlmClient, LlmRequest, LlmResult } from './types.js';

const seams = vi.hoisted(() => ({
  verdictFromVision: vi.fn((_raw: unknown, _model?: string): unknown => undefined),
  prefilterText: vi.fn((_text: string, _rating: string) => ({ decision: 'clear' as 'clear' | 'ambiguous' | 'block', categories: [] as string[], ip: [] as string[] }))
}));
vi.mock('./safety/index.js', () => seams);

const { VISION_SCHEMA, analyzePageRender, prefilterFoundText } = await import('./vision.js');

const line = (id: string, kind: Line['kind'], text: string, speakerId?: string): Line => ({ id, kind, text, ...(speakerId ? { speakerId } : {}) });
const panel = (n: number, lines: Line[] = []): Panel => ({ id: `pn_${n}`, n, size: 'medium', shot: 'medium', action: `Action ${n}.`, castIds: ['maya'], lines });
const page = (panels: Panel[]): Page => ({
  id: 'pg_1',
  n: 1,
  summary: '',
  layout: '',
  panels,
  render: { ...emptyRender(), status: 'ready', asset: { path: 'pages/1.png', source: 'generated', at: 1, w: 1000, h: 1500 } },
  balloons: []
});
const doc = (patch: (d: ComicDoc) => void = () => undefined): ComicDoc => {
  const d = createEmptyDoc('doc_s', 'Test', 1);
  d.cast = [{ id: 'maya', name: 'Maya', tier: 'lead', look: { summary: 'Courier' }, refs: [], sheet: emptyRender() }];
  patch(d);
  return d;
};
const baseReply = {
  panels: [{ n: 1, box: { x: 0.02, y: 0.02, w: 0.96, h: 0.96 } }],
  issues: [],
  textFound: [] as string[],
  extraOrMissingCharacters: [],
  score: 0.92,
  balloons: [{ lineId: 'l1', x: 0.1, y: 0.1, w: 0.2, tailX: 0.3, tailY: 0.3 }],
  keepOut: [],
  heads: []
};
const fakeLlm = (reply: Record<string, unknown>) => {
  const calls: LlmRequest[] = [];
  const llm: LlmClient = {
    complete: async (req): Promise<LlmResult> => {
      calls.push(req);
      return { text: JSON.stringify(reply), json: reply, model: 'google/gemini-3.8-flash', byok: false, provider: 'openrouter' } as LlmResult;
    }
  };
  return { llm, calls };
};
const run = (reply: Record<string, unknown>, d = doc(), pg = page([panel(1, [line('l1', 'speech', 'Hi.', 'maya')])])) =>
  analyzePageRender({ doc: d, page: pg, dataUrl: 'data:image/png;base64,AAAA', llm: fakeLlm(reply).llm });

beforeEach(() => {
  seams.verdictFromVision.mockReset().mockImplementation(() => undefined);
  seams.prefilterText.mockReset().mockImplementation(() => ({ decision: 'clear', categories: [], ip: [] }));
});

describe('vision safety block (VISION_SCHEMA + rubric item 7 → verdictFromVision)', () => {
  it('schema: rating G/PG/PG-13/X, categories from SAFETY_CATEGORIES, notes', () => {
    const safety = (VISION_SCHEMA as { properties: Record<string, { properties: Record<string, { enum?: string[]; items?: { enum?: string[] } }> }> }).properties.safety;
    expect(safety.properties.rating.enum).toEqual(['G', 'PG', 'PG-13', 'X']);
    expect(safety.properties.categories.items?.enum).toEqual([...SAFETY_CATEGORIES]);
    expect(Object.keys(safety.properties).sort()).toEqual(['categories', 'notes', 'rating']);
  });

  it('a missing safety block stays unchecked (undefined) — never a pass, never a repair round', async () => {
    const out = await run(baseReply);
    expect(seams.verdictFromVision).toHaveBeenCalledWith(undefined, 'google/gemini-3.8-flash');
    expect(out.safety).toBeUndefined();
    expect('safety' in out).toBe(false);
  });

  it('the raw block is handed to verdictFromVision and its verdict is returned next to qc', async () => {
    const verdict = { assessed: 'PG-13', categories: ['violence'], notes: ['a sword fight'], by: 'qc', model: 'google/gemini-3.8-flash', at: 5 };
    seams.verdictFromVision.mockImplementation(() => verdict);
    const block = { rating: 'PG-13', categories: ['violence'], notes: ['a sword fight'] };
    const out = await run({ ...baseReply, safety: block });
    expect(seams.verdictFromVision).toHaveBeenCalledWith(block, 'google/gemini-3.8-flash');
    expect(out.safety).toEqual(verdict);
    expect(out.qc.score).toBe(0.92);
  });
});

describe('qc.textFound is pre-filtered ($0)', () => {
  it('blocked drawn text is dropped from qc.textFound, escalates the verdict to X and asks for a safer redraw', async () => {
    seams.prefilterText.mockImplementation((text: string) =>
      text.includes('SLUR') ? { decision: 'block', categories: ['hate'], ip: [] } : { decision: 'clear', categories: [], ip: [] }
    );
    seams.verdictFromVision.mockImplementation(() => ({ assessed: 'PG', categories: ['violence'], notes: ['a shove'], by: 'qc', at: 7 }));
    const inArt = doc((d) => (d.format.lettering = 'in_art'));
    const out = await run({ ...baseReply, textFound: ['Hi.', 'SLUR on the wall'], safety: { rating: 'PG', categories: ['violence'], notes: ['a shove'] } }, inArt);
    expect(out.qc.textFound).toEqual(['Hi.']);
    expect(JSON.stringify(out.qc)).not.toContain('SLUR');
    expect(out.qc.issues[0]).toBe('Some text drawn in the art breaks the content rules — redraw this page safer.');
    expect(out.qc.score).toBeLessThanOrEqual(0.4);
    expect(out.safety).toMatchObject({ assessed: 'X', categories: ['violence', 'hate'], notes: ['a shove', 'text drawn in the art breaks the content rules'], by: 'qc', at: 7 });
    // The rating passed to the filter is the doc's effective rating.
    expect(seams.prefilterText).toHaveBeenCalledWith('SLUR on the wall', 'PG-13');
  });

  it('without a vision verdict, blocked text still produces an X verdict; clean text changes nothing', async () => {
    seams.prefilterText.mockImplementation((text: string) =>
      text === 'BAD' ? { decision: 'block', categories: ['harassment'], ip: [] } : { decision: 'ambiguous', categories: ['language'], ip: [] }
    );
    const out = await run({ ...baseReply, textFound: ['BAD', 'darn it'] });
    expect(out.safety).toMatchObject({ assessed: 'X', categories: ['harassment'], by: 'qc', model: 'google/gemini-3.8-flash' });
    expect(out.qc.textFound).toEqual(['darn it']); // ambiguous is kept (the classifier decides later)

    seams.prefilterText.mockImplementation(() => ({ decision: 'clear', categories: [], ip: [] }));
    const clean = await run({ ...baseReply, textFound: [] });
    expect(clean.safety).toBeUndefined();
  });

  it('prefilterFoundText uses the kids ceiling for a kids comic', () => {
    const kids = doc((d) => (d.brief.audience = 'kids 8-10'));
    prefilterFoundText(kids, ['Boo!']);
    expect(seams.prefilterText).toHaveBeenCalledWith('Boo!', 'PG');
  });
});
