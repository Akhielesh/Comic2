// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { createEmptyDoc, emptyRender, type ComicDoc, type Page } from '../../../shared/comic/doc.js';
import { STYLE_PRESETS } from '../../../shared/comic/stylePresets.js';
import {
  PAGE_PLAN_SCHEMA,
  WRITER_SOURCE_LIMIT,
  analyzeSource,
  completeStructured,
  enforcePageCount,
  estimatePageCount,
  mergeRevisedPages,
  normalizePlan,
  parseJsonText,
  proposeStyleDirections,
  writePagePlan,
  writerSystemPrompt,
  writerUserMessage
} from './writer.js';
import { StudioError, type LlmClient, type LlmRequest, type LlmResult } from './types.js';

// ── Fakes & fixtures ─────────────────────────────────────────────────────────

type Reply = Partial<LlmResult> | Error;

const fakeLlm = (replies: Reply[]) => {
  const calls: LlmRequest[] = [];
  const llm: LlmClient = {
    complete: async (req) => {
      calls.push({ ...req, messages: [...req.messages] });
      const next = replies.shift();
      if (!next) throw new Error('unexpected extra LLM call');
      if (next instanceof Error) throw next;
      return { text: '', model: 'anthropic/claude-sonnet-5.5', byok: false, provider: 'openrouter', ...next };
    }
  };
  return { llm, calls };
};

const json = (value: unknown, costUsd?: number): Reply => ({ json: value, text: JSON.stringify(value), ...(costUsd !== undefined ? { costUsd } : {}) });

const baseDoc = (patch: (doc: ComicDoc) => void = () => undefined): ComicDoc => {
  const doc = createEmptyDoc('doc_w', 'Saffron Run', 1);
  doc.brief = { title: 'Saffron Run', logline: 'A courier races a stolen ledger across Mumbai.', genre: 'adventure', notes: ['ends on a cliffhanger'] };
  doc.format.pageCount = 2;
  doc.cast = [
    { id: 'ch_maya', name: 'Maya Rao', tier: 'lead', look: { summary: 'Wiry courier, red kurta' }, refs: [], sheet: emptyRender() },
    { id: 'ch_arjun', name: 'Arjun', tier: 'support', look: { summary: 'Spice merchant' }, refs: [], sheet: emptyRender() }
  ];
  doc.places = [{ id: 'pl_market', name: 'Spice Market', look: 'Covered alley', refs: [], sheet: emptyRender() }];
  patch(doc);
  return doc;
};

const rawPanel = (over: Record<string, unknown> = {}) => ({
  n: 1,
  size: 'medium',
  shot: 'medium',
  angle: '',
  action: 'Maya runs.',
  castIds: ['ch_maya'],
  placeId: '',
  mood: '',
  lines: [],
  ...over
});

const rawPage = (n: number, panels: Record<string, unknown>[], over: Record<string, unknown> = {}) => ({
  n,
  summary: `Summary ${n}`,
  layout: '',
  turnHook: `Hook ${n}`,
  panels,
  ...over
});

const plan = (pages: unknown[], newCast: unknown[] = []) => ({ pages, newCast });

// ── Schema & prompt ──────────────────────────────────────────────────────────

describe('PAGE_PLAN_SCHEMA', () => {
  it('is strict-mode compatible: every object lists all keys as required and forbids extras', () => {
    const walk = (node: unknown, path: string) => {
      if (!node || typeof node !== 'object') return;
      const n = node as Record<string, unknown>;
      if (n.type === 'object') {
        expect(n.additionalProperties, path).toBe(false);
        expect([...(n.required as string[])].sort(), path).toEqual(Object.keys(n.properties as object).sort());
        for (const [k, v] of Object.entries(n.properties as object)) walk(v, `${path}.${k}`);
      }
      if (n.type === 'array') walk(n.items, `${path}[]`);
    };
    walk(PAGE_PLAN_SCHEMA, 'plan');
  });
});

describe('writer prompts', () => {
  it('system prompt carries the craft rules with concrete numbers and the model character slots', () => {
    const prompt = writerSystemPrompt(baseDoc());
    for (const needle of [
      'turn-hook',
      'establishing',
      'never more than 2 panels in a row with the same shot type',
      'At most 1 splash',
      'At most 25 words per balloon, at most 3 balloons per panel, at most 210 words',
      '180° rule',
      'At most 4 recurring named characters',
      'Every speaker must be in that panel\'s castIds',
      'Never invent major plot beats',
      'Row 1: one wide panel. Row 2: two equal panels.',
      'Silent panels are good'
    ]) {
      expect(prompt).toContain(needle);
    }
    expect(prompt).toContain('Panels per page: usually 3 big panels (2–4)');
    expect(writerSystemPrompt(baseDoc((d) => (d.settings.quality = 'pro')))).toContain('At most 5 recurring named characters');
    expect(writerSystemPrompt(baseDoc((d) => (d.format.panelsPerPage = 4)))).toContain('exactly 4 on every page');
    const manga = writerSystemPrompt(baseDoc((d) => ((d.format.kind = 'manga'), (d.format.readingDirection = 'rtl'))));
    expect(manga).toContain('RIGHT-TO-LEFT');
    expect(writerSystemPrompt(baseDoc((d) => (d.format.lettering = 'in_art')))).toContain('At most 18 words per balloon');
  });

  it('user message: compact brief/format/cast/places, source with head+tail truncation, instructions, task', () => {
    const long = `BEGINNING ${'word '.repeat(20_000)} THE ENDING`;
    const doc = baseDoc((d) => (d.source.script = long));
    const msg = writerUserMessage(doc, { instructions: 'Make page 2 a splash.' });
    expect(msg).toContain('"title":"Saffron Run"');
    expect(msg).toContain('"notes":["ends on a cliffhanger"]');
    expect(msg).toContain('"id":"ch_maya","name":"Maya Rao","tier":"lead"');
    expect(msg).toContain('"id":"pl_market"');
    expect(msg).toContain('[truncated:');
    expect(msg).toContain('BEGINNING');
    expect(msg).toContain('THE ENDING');
    expect(msg.length).toBeLessThan(WRITER_SOURCE_LIMIT + 3_000);
    expect(msg).toContain("AUTHOR'S INSTRUCTIONS (binding)\nMake page 2 a splash.");
    expect(msg).toContain('TASK: Write the complete plan: exactly 2 pages, n = 1 to 2.');
    expect(msg).not.toContain('"logline":""');
  });
});

// ── writePagePlan ────────────────────────────────────────────────────────────

describe('writePagePlan', () => {
  it('normalizes: ids, cast by id or name, unknown names → newCast, speakers forced into cast, lines cleaned', async () => {
    const doc = baseDoc();
    const reply = plan([
      rawPage(1, [
        rawPanel({ castIds: ['MAYA RAO', 'ch_arjun', 'ch_ghost123'], placeId: 'Spice Market', shot: 'closeup', size: 'huge', angle: 'low angle', mood: 'tense' }),
        rawPanel({
          n: 2,
          castIds: ['maya'],
          action: 'The Vendor waves a mango at Maya, grinning toothlessly.',
          lines: [
            { kind: 'speech', speakerId: 'Vendor', text: '"Fresh mangoes!"' },
            { kind: 'speech', speakerId: 'Arjun', text: 'Arjun: Not now.' },
            { kind: 'caption', speakerId: 'ch_maya', text: 'Monday.' },
            { kind: 'speech', speakerId: 'ch_maya', text: '   ' }
          ]
        })
      ]),
      rawPage(2, [rawPanel({ castIds: ['the crowd', 'Maya'], lines: [{ kind: 'speech', speakerId: '', text: 'Run!' }] })])
    ]);
    const { llm, calls } = fakeLlm([json(reply, 0.031)]);
    const out = await writePagePlan({ doc, llm });
    expect(calls).toHaveLength(1);
    expect(calls[0].role).toBe('writer');
    expect(calls[0].jsonSchema).toMatchObject({ name: 'comic_page_plan', strict: true });
    expect(out.costUsd).toBeCloseTo(0.031);
    expect(out.model).toBe('anthropic/claude-sonnet-5.5');
    expect(out.pages).toHaveLength(2);

    const [p1, p2] = out.pages;
    expect(p1.id).toMatch(/^pg_/);
    expect(p1.render).toEqual(emptyRender());
    expect(p1.balloons).toEqual([]);
    expect(p1.layout).toBeTruthy();
    const first = p1.panels[0];
    expect(first.id).toMatch(/^pn_/);
    expect(first.castIds).toEqual(['ch_maya', 'ch_arjun']); // name match + id match, unknown id dropped
    expect(first).toMatchObject({ placeId: 'pl_market', shot: 'close_up', size: 'medium', angle: 'low angle', mood: 'tense' });

    const vendor = out.newCast.find((c) => c.name === 'Vendor')!;
    expect(vendor).toBeTruthy();
    expect(vendor.id).toMatch(/^ch_/);
    expect(vendor.tier).toBe('extra');
    expect(vendor.look.summary).toContain('The Vendor waves a mango');
    const second = p1.panels[1];
    // Speakers are forced into the panel cast; "maya" resolves by unique first name.
    expect(second.castIds).toEqual(expect.arrayContaining(['ch_maya', vendor.id, 'ch_arjun']));
    expect(second.lines.map((l) => [l.kind, l.speakerId, l.text])).toEqual([
      ['speech', vendor.id, 'Fresh mangoes!'],
      ['speech', 'ch_arjun', 'Not now.'],
      ['caption', undefined, 'Monday.']
    ]);
    expect(second.lines.every((l) => /^ln_/.test(l.id))).toBe(true);
    // Group words never become characters; a lone cast member is the speaker of an unattributed line.
    expect(p2.panels[0].castIds).toEqual(['ch_maya']);
    expect(p2.panels[0].lines[0].speakerId).toBe('ch_maya');
    expect(out.newCast.map((c) => c.name)).toEqual(['Vendor']);
  });

  it('never maps a different full name onto an existing character', async () => {
    const doc = baseDoc((d) => (d.format.pageCount = 1));
    const reply = plan([rawPage(1, [rawPanel({ castIds: ['Maya Smith', 'Arjun Mehta', 'Maya'] })])]);
    const out = await writePagePlan({ doc, llm: fakeLlm([json(reply)]).llm });
    const smith = out.newCast.find((c) => c.name === 'Maya Smith')!;
    expect(smith).toBeTruthy();
    // "Arjun Mehta" → the one-word cast name "Arjun"; "Maya" → "Maya Rao".
    expect(out.pages[0].panels[0].castIds).toEqual([smith.id, 'ch_arjun', 'ch_maya']);
  });

  it('promotes an unknown character who speaks in 3+ panels to support, and maps model newCast', async () => {
    const doc = baseDoc((d) => (d.format.pageCount = 1));
    const speak = (n: number) => rawPanel({ n, castIds: ['ch_maya'], lines: [{ kind: 'speech', speakerId: 'Inspector Kale', text: `Line ${n}` }] });
    const reply = plan(
      [rawPage(1, [speak(1), speak(2), speak(3), rawPanel({ n: 4, castIds: ['Arjun', 'Neha'] })])],
      [
        { name: 'Neha', role: 'sister', tier: 'support', look: { summary: '', age: '12', gender: 'girl', build: '', face: '', hair: 'two braids', eyes: '', skin: '', outfit: 'school uniform', palette: '', props: '', marks: '' }, personality: 'curious', voice: 'fast' },
        { name: 'Arjun', role: '', tier: 'extra', look: { summary: 'dup' }, personality: '', voice: '' },
        { name: 'Unused Person', role: '', tier: 'extra', look: { summary: 'never appears' }, personality: '', voice: '' }
      ]
    );
    const { llm } = fakeLlm([json(reply)]);
    const out = await writePagePlan({ doc, llm });
    const names = out.newCast.map((c) => c.name).sort();
    expect(names).toEqual(['Inspector Kale', 'Neha']);
    expect(out.newCast.find((c) => c.name === 'Inspector Kale')!.tier).toBe('support');
    const neha = out.newCast.find((c) => c.name === 'Neha')!;
    expect(neha).toMatchObject({ tier: 'support', role: 'sister', personality: 'curious', voice: 'fast' });
    expect(neha.look).toMatchObject({ summary: '12 girl, two braids, wearing school uniform', hair: 'two braids', outfit: 'school uniform' });
    expect(neha.look).not.toHaveProperty('eyes');
    expect(out.pages[0].panels[3].castIds).toEqual(['ch_arjun', neha.id]);
  });

  it("aligns panel sizes to the writer's blueprint, or synthesizes one when it doesn't fit", async () => {
    const doc = baseDoc((d) => (d.format.pageCount = 2));
    const reply = plan([
      rawPage(1, [rawPanel({ size: 'medium' }), rawPanel({ n: 2, size: 'wide' }), rawPanel({ n: 3, size: 'medium' })], {
        layout: 'Row 1: one wide panel. Row 2: two equal panels.'
      }),
      rawPage(2, [rawPanel({ size: 'wide' }), rawPanel({ n: 2 })], { layout: 'Row 1: three small panels.' })
    ]);
    const out = await writePagePlan({ doc, llm: fakeLlm([json(reply)]).llm });
    expect(out.pages[0].layout).toBe('Row 1: one wide panel. Row 2: two equal panels.');
    expect(out.pages[0].panels.map((p) => p.size)).toEqual(['wide', 'medium', 'medium']);
    expect(out.pages[1].layout).toBe('Row 1: one wide panel across the full width (panel 1). Row 2: one panel across the full width (panel 2).');
    expect(out.pages[1].panels.map((p) => p.size)).toEqual(['wide', 'medium']);
  });

  it('clamps panels per page (≤ 9) and lines per panel (≤ 4)', async () => {
    const doc = baseDoc((d) => (d.format.pageCount = 1));
    const lines = Array.from({ length: 6 }, (_, i) => ({ kind: 'speech', speakerId: 'ch_maya', text: `L${i}` }));
    const panels = Array.from({ length: 11 }, (_, i) => rawPanel({ n: i + 1, lines: i === 0 ? lines : [] }));
    // First reply has fixable problems → one repair; the repaired reply is identical, so it is used as-is.
    const { llm, calls } = fakeLlm([json(plan([rawPage(1, panels)])), json(plan([rawPage(1, panels)]))]);
    const out = await writePagePlan({ doc, llm });
    expect(calls).toHaveLength(2);
    expect(out.pages[0].panels).toHaveLength(9);
    expect(out.pages[0].panels[0].lines.map((l) => l.text)).toEqual(['L0', 'L1', 'L2', 'L3']);
    expect(out.pages[0].panels.map((p) => p.n)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('enforces the requested page count after the repair round (splitting dense pages)', async () => {
    const doc = baseDoc((d) => (d.format.pageCount = 3));
    const six = Array.from({ length: 6 }, (_, i) => rawPanel({ n: i + 1, action: `Beat ${i + 1}.` }));
    const short = json(plan([rawPage(1, six), rawPage(2, [rawPanel(), rawPanel({ n: 2 })])]));
    const { llm, calls } = fakeLlm([short, short]);
    const out = await writePagePlan({ doc, llm });
    expect(calls).toHaveLength(2);
    const repair = calls[1].messages;
    expect(repair[repair.length - 2].role).toBe('assistant');
    expect(String(repair[repair.length - 1].content)).toContain('Return exactly 3 pages (you returned 2).');
    expect(out.pages).toHaveLength(3);
    expect(out.pages.map((p) => p.n)).toEqual([1, 2, 3]);
    expect(out.pages[0].panels.map((p) => p.action)).toEqual(['Beat 1.', 'Beat 2.', 'Beat 3.']);
    expect(out.pages[1].panels.map((p) => p.action)).toEqual(['Beat 4.', 'Beat 5.', 'Beat 6.']);
    expect(out.pages[1].summary).toBe('Summary 1 (continued)');
    expect(new Set(out.pages.map((p) => p.id)).size).toBe(3);
    for (const p of out.pages) expect(p.panels.map((panel) => panel.n)).toEqual(p.panels.map((_, i) => i + 1));
  });

  it('repair path: invalid JSON first, then a valid reply; costs add up', async () => {
    const doc = baseDoc((d) => (d.format.pageCount = 1));
    const { llm, calls } = fakeLlm([
      { text: 'Sure! Here is your plan: {pages: oops', costUsd: 0.01 },
      json(plan([rawPage(1, [rawPanel()])]), 0.02)
    ]);
    const out = await writePagePlan({ doc, llm });
    expect(calls).toHaveLength(2);
    expect(calls[1].messages).toHaveLength(4);
    expect(calls[1].messages[2]).toMatchObject({ role: 'assistant', content: 'Sure! Here is your plan: {pages: oops' });
    expect(String(calls[1].messages[3].content)).toContain('not valid JSON');
    expect(out.costUsd).toBeCloseTo(0.03);
    expect(out.pages).toHaveLength(1);
  });

  it('accepts JSON wrapped in fences when the provider returns text only', async () => {
    const doc = baseDoc((d) => (d.format.pageCount = 1));
    const { llm, calls } = fakeLlm([{ text: '```json\n' + JSON.stringify(plan([rawPage(1, [rawPanel()])])) + '\n```' }]);
    const out = await writePagePlan({ doc, llm });
    expect(calls).toHaveLength(1);
    expect(out.pages[0].panels[0].action).toBe('Maya runs.');
  });

  it('throws PROVIDER_ERROR when the output is unusable after one repair', async () => {
    const doc = baseDoc();
    const { llm, calls } = fakeLlm([{ text: 'no json here' }, json({ pages: [rawPage(1, [])] })]);
    await expect(writePagePlan({ doc, llm })).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
    expect(calls).toHaveLength(2);
  });

  it('keeps transport errors (StudioError) and keeps a usable first reply when the repair call fails', async () => {
    const doc = baseDoc((d) => (d.format.pageCount = 2));
    const keyError = new StudioError('NO_TEXT_KEY', 'Connect a key.');
    await expect(writePagePlan({ doc, llm: fakeLlm([keyError]).llm })).rejects.toBe(keyError);

    const firstOnly = json(plan([rawPage(1, [rawPanel(), rawPanel({ n: 2 })])]));
    const { llm, calls } = fakeLlm([firstOnly, new Error('socket hang up')]);
    const out = await writePagePlan({ doc, llm });
    expect(calls).toHaveLength(2);
    expect(out.pages).toHaveLength(2); // 1 page split to reach the requested 2
  });

  it('wraps unknown errors as PROVIDER_ERROR and honors an aborted signal', async () => {
    const doc = baseDoc();
    await expect(writePagePlan({ doc, llm: fakeLlm([new Error('boom')]).llm })).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
    const controller = new AbortController();
    controller.abort();
    await expect(writePagePlan({ doc, llm: fakeLlm([]).llm, signal: controller.signal })).rejects.toMatchObject({ code: 'CANCELLED' });
  });

  it('revision: rewrites only the requested pages, with original ids/numbers and reused ids for unchanged lines', async () => {
    const doc = baseDoc((d) => {
      d.format.pageCount = 3;
      d.pages = [1, 2, 3].map(
        (n): Page => ({
          id: `pg_old${n}`,
          n,
          summary: `Old ${n}`,
          layout: 'Row 1: two equal panels.',
          panels: [
            { id: `pn_${n}a`, n: 1, size: 'medium', shot: 'wide', action: 'Old action', castIds: ['ch_maya'], lines: [{ id: `ln_${n}a`, kind: 'speech', speakerId: 'ch_maya', text: 'Keep me.' }] },
            { id: `pn_${n}b`, n: 2, size: 'medium', shot: 'medium', action: 'Old action 2', castIds: ['ch_arjun'], lines: [{ id: `ln_${n}b`, kind: 'speech', speakerId: 'ch_arjun', text: 'Change me.' }] }
          ],
          render: { status: 'ready', history: [], asset: { path: `pages/${n}.png`, source: 'generated', at: 1 } },
          balloons: [
            { lineId: `ln_${n}a`, x: 0.1, y: 0.1, w: 0.2 },
            { lineId: `ln_${n}b`, x: 0.5, y: 0.1, w: 0.2 }
          ]
        })
      );
    });
    const reply = plan([
      rawPage(2, [
        rawPanel({ action: 'Maya, angrier, jabs a finger.', lines: [{ kind: 'speech', speakerId: 'ch_maya', text: 'Keep me.' }] }),
        rawPanel({ n: 2, castIds: ['ch_arjun'], lines: [{ kind: 'shout', speakerId: 'ch_arjun', text: 'Something new!' }] }),
        rawPanel({ n: 3, castIds: [], action: 'Rain on the tin roof.' })
      ])
    ]);
    const { llm, calls } = fakeLlm([json(reply)]);
    const out = await writePagePlan({ doc, llm, pageIds: ['pg_old2'], instructions: 'Maya should be angrier' });
    const user = String(calls[0].messages[1].content);
    expect(user).toContain('FIXED PAGES');
    expect(user).toContain('Page 1 (2 panels; Maya Rao, Arjun): Old 1');
    expect(user).toContain('PAGES TO REWRITE');
    expect(user).toContain('Return exactly 1 page in "pages", each with its original n (2)');
    expect(out.pages).toHaveLength(1);
    const page = out.pages[0];
    expect(page).toMatchObject({ id: 'pg_old2', n: 2 });
    // Existing panels keep their ids; the new third panel gets a fresh one (compare exactly —
    // a random id can itself start with "pn_2…").
    expect(page.panels.slice(0, 2).map((p) => p.id)).toEqual(['pn_2a', 'pn_2b']);
    expect(['pn_2a', 'pn_2b']).not.toContain(page.panels[2].id);
    expect(page.panels[0].lines[0].id).toBe('ln_2a'); // unchanged line keeps its id
    expect(page.panels[1].lines[0].id).not.toBe('ln_2b');

    const merged = mergeRevisedPages(doc.pages, out.pages);
    expect(merged.map((p) => p.id)).toEqual(['pg_old1', 'pg_old2', 'pg_old3']);
    expect(merged[0]).toBe(doc.pages[0]);
    expect(merged[1].render).toBe(doc.pages[1].render); // render kept → shown stale via specHash
    expect(merged[1].balloons.map((b) => b.lineId)).toEqual(['ln_2a']);
    expect(merged[1].panels).toHaveLength(3);
  });

  it('revision: asks for a repair when a requested page is missing, and rejects unknown page ids', async () => {
    const doc = baseDoc((d) => {
      d.pages = [1, 2].map((n): Page => ({ id: `pg_${n}`, n, summary: '', layout: '', panels: [], render: emptyRender(), balloons: [] }));
    });
    // Wrong numbers and a count that doesn't match → repair.
    const { llm, calls } = fakeLlm([json(plan([rawPage(7, [rawPanel()]), rawPage(8, [rawPanel()])])), json(plan([rawPage(2, [rawPanel()])]))]);
    const out = await writePagePlan({ doc, llm, pageIds: ['pg_2'] });
    expect(calls).toHaveLength(2);
    expect(String(calls[1].messages[3].content)).toContain('Return the rewritten page 2');
    expect(out.pages.map((p) => p.id)).toEqual(['pg_2']);
    // One page back for one target with a wrong n: mapped by order, no repair needed.
    const single = fakeLlm([json(plan([rawPage(9, [rawPanel()])]))]);
    expect((await writePagePlan({ doc, llm: single.llm, pageIds: ['pg_1'] })).pages.map((p) => [p.id, p.n])).toEqual([['pg_1', 1]]);
    expect(single.calls).toHaveLength(1);
    await expect(writePagePlan({ doc, llm: fakeLlm([]).llm, pageIds: ['pg_nope'] })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
});

describe('writePagePlan — long plans', () => {
  /** An LLM that answers from the request (outline vs chunk) instead of a fixed queue. */
  const scriptedLlm = (respond: (req: LlmRequest, user: string) => unknown) => {
    const calls: LlmRequest[] = [];
    const llm: LlmClient = {
      complete: async (req) => {
        calls.push({ ...req, messages: [...req.messages] });
        const value = respond(req, String(req.messages[req.messages.length - 1].content));
        return { json: value, text: JSON.stringify(value), model: 'anthropic/claude-sonnet-5.5', byok: false, provider: 'openrouter', costUsd: 0.01 };
      }
    };
    return { llm, calls };
  };
  const kale = { name: 'Inspector Kale', role: 'detective', tier: 'support', look: { summary: 'Tall detective in a rain-dark trench coat' }, personality: '', voice: '' };

  it('outlines first, writes pages in chunks, shares new cast across chunks', async () => {
    const doc = baseDoc((d) => (d.format.pageCount = 12));
    const { llm, calls } = scriptedLlm((req, user) => {
      if (req.jsonSchema?.name === 'comic_page_outline') {
        return {
          pages: Array.from({ length: 12 }, (_, i) => ({ n: i + 1, summary: `Beat ${i + 1}`, turnHook: `Hook ${i + 1}`, characters: ['Maya Rao', 'Inspector Kale'], place: 'Spice Market' })),
          newCast: [kale]
        };
      }
      const m = /write pages (\d+)–(\d+)/.exec(user)!;
      const from = Number(m[1]);
      const to = Number(m[2]);
      return {
        pages: Array.from({ length: to - from + 1 }, (_, i) =>
          rawPage(from + i, [
            rawPanel({ action: `Page ${from + i} action.`, castIds: ['ch_maya', 'Inspector Kale'], lines: [{ kind: 'speech', speakerId: 'Inspector Kale', text: `Line ${from + i}` }] }),
            rawPanel({ n: 2, action: `Page ${from + i} reaction.` })
          ])
        ),
        newCast: [kale]
      };
    });
    const out = await writePagePlan({ doc, llm });
    expect(calls.map((c) => c.jsonSchema?.name)).toEqual(['comic_page_outline', 'comic_page_plan', 'comic_page_plan', 'comic_page_plan']);
    const chunkUser = String(calls[1].messages[1].content);
    expect(chunkUser).toContain('STORY OUTLINE (binding');
    expect(chunkUser).toContain('Page 12: Beat 12 Hook: Hook 12');
    expect(chunkUser).toContain('NEW CAST FROM THE OUTLINE');
    expect(out.pages).toHaveLength(12);
    expect(out.pages.map((p) => p.n)).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
    expect(out.pages.map((p) => p.panels[0].action)).toEqual(Array.from({ length: 12 }, (_, i) => `Page ${i + 1} action.`));
    expect(out.newCast).toHaveLength(1);
    expect(out.newCast[0]).toMatchObject({ name: 'Inspector Kale', tier: 'support', role: 'detective' });
    const kaleId = out.newCast[0].id;
    expect(out.pages.every((p) => p.panels[0].castIds.includes(kaleId))).toBe(true);
    expect(out.costUsd).toBeCloseTo(0.04);
  });

  it('rewrites many pages in chunks and keeps their ids', async () => {
    const doc = baseDoc((d) => {
      d.format.pageCount = 9;
      d.pages = Array.from({ length: 9 }, (_, i): Page => ({
        id: `pg_${i + 1}`,
        n: i + 1,
        summary: `Old ${i + 1}`,
        layout: '',
        panels: [{ id: `pn_${i + 1}`, n: 1, size: 'medium', shot: 'medium', action: 'Old', castIds: [], lines: [] }],
        render: emptyRender(),
        balloons: []
      }));
    });
    const { llm, calls } = scriptedLlm((_req, user) => {
      const nums = /Return exactly \d+ pages? in "pages", each with its original n \(([\d, ]+)\)/.exec(user)![1].split(', ').map(Number);
      return { pages: nums.map((n) => rawPage(n, [rawPanel({ action: `New ${n}` }), rawPanel({ n: 2, action: `After ${n}` })])), newCast: [] };
    });
    const ids = doc.pages.slice(1).map((p) => p.id); // pages 2–9
    const out = await writePagePlan({ doc, llm, pageIds: ids, instructions: 'Darker tone' });
    expect(calls).toHaveLength(2); // 5 + 3
    expect(out.pages.map((p) => p.id)).toEqual(ids);
    expect(out.pages.map((p) => p.panels[0].action)).toEqual(ids.map((_, i) => `New ${i + 2}`));
    expect(out.pages[0].panels[0].id).toBe('pn_2');
  });
});

describe('enforcePageCount', () => {
  const page = (n: number, panels: number, lines = 0): Page => ({
    id: `pg_${n}`,
    n,
    summary: `S${n}`,
    layout: '',
    turnHook: `H${n}`,
    panels: Array.from({ length: panels }, (_, i) => ({
      id: `pn_${n}_${i}`,
      n: i + 1,
      size: 'medium' as const,
      shot: 'medium' as const,
      action: `${n}.${i}`,
      castIds: [],
      lines: Array.from({ length: lines }, (_, k) => ({ id: `l${n}${i}${k}`, kind: 'caption' as const, text: 'x' }))
    })),
    render: emptyRender(),
    balloons: []
  });
  const doc = createEmptyDoc('d');

  it('merges the sparsest neighbors when there are too many pages', () => {
    const out = enforcePageCount([page(1, 4), page(2, 1), page(3, 2), page(4, 5)], 3, doc);
    expect(out.map((p) => p.panels.length)).toEqual([4, 3, 5]);
    expect(out[1].summary).toBe('S2 S3');
    expect(out[1].turnHook).toBe('H3');
    expect(out[1].layout).toContain('Row');
    expect(out.map((p) => p.n)).toEqual([1, 2, 3]);
  });

  it('never invents content: stops splitting when no page has 2+ panels', () => {
    expect(enforcePageCount([page(1, 1)], 3, doc)).toHaveLength(1);
  });

  it('drops the lightest middle page when nothing can merge', () => {
    const out = enforcePageCount([page(1, 6), page(2, 6, 0), page(3, 6, 2), page(4, 6)], 3, doc);
    expect(out.map((p) => p.id)).toEqual(['pg_1', 'pg_3', 'pg_4']);
  });
});

describe('normalizePlan', () => {
  it('rejects a reply without pages', () => {
    expect(normalizePlan({ nope: true }, { doc: baseDoc(), targets: null, pageCount: 2 }).value).toBeUndefined();
  });
});

// ── analyzeSource ────────────────────────────────────────────────────────────

describe('analyzeSource', () => {
  const look = (over: Record<string, string> = {}) => ({
    summary: '',
    age: '',
    gender: '',
    build: '',
    face: '',
    hair: '',
    eyes: '',
    skin: '',
    outfit: '',
    palette: '',
    props: '',
    marks: '',
    ...over
  });

  it('extracts brief, deduped cast with only stated look fields, places and a clamped page count', async () => {
    const reply = {
      brief: { title: 'The Lighthouse', logline: 'A keeper must save a ship.', premise: '', genre: 'drama', tone: '', audience: '', setting: 'Cornwall, 1890', themes: ['duty', ''], notes: [] },
      cast: [
        { name: 'Edith', role: 'keeper', tier: 'support', look: look({ age: 'elderly', gender: 'woman', outfit: 'oilskin coat' }), personality: 'stubborn', voice: 'terse' },
        { name: 'edith', role: '', tier: 'extra', look: look(), personality: '', voice: '' },
        { name: 'The Captain', role: '', tier: 'boss', look: look({ summary: 'Bearded captain' }), personality: '', voice: '' }
      ],
      places: [{ name: 'Lighthouse', look: 'White tower on black rocks' }, { name: 'lighthouse', look: '' }],
      suggestedPageCount: 99,
      styleHint: ''
    };
    const { llm, calls } = fakeLlm([json(reply, 0.004)]);
    const doc = baseDoc();
    const out = await analyzeSource({ doc, llm, text: 'Edith climbed the stairs. '.repeat(50) });
    expect(calls[0].role).toBe('writer');
    expect(calls[0].jsonSchema?.strict).toBe(true);
    expect(String(calls[0].messages[1].content)).toContain('ALREADY IN THE CAST: Maya Rao, Arjun');
    expect(out.brief).toEqual({ title: 'The Lighthouse', logline: 'A keeper must save a ship.', genre: 'drama', setting: 'Cornwall, 1890', themes: ['duty'] });
    expect(out.cast).toHaveLength(2);
    expect(out.cast[0]).toMatchObject({ name: 'Edith', tier: 'lead', role: 'keeper', personality: 'stubborn', voice: 'terse' });
    expect(out.cast[0].look).toEqual({ summary: 'elderly woman, wearing oilskin coat', age: 'elderly', gender: 'woman', outfit: 'oilskin coat' });
    expect(out.cast[1]).toMatchObject({ name: 'The Captain', tier: 'support', look: { summary: 'Bearded captain' } });
    expect(out.places).toEqual([{ name: 'Lighthouse', look: 'White tower on black rocks' }]);
    expect(out.suggestedPageCount).toBe(40);
    expect(out.styleHint).toBeUndefined();
    expect(out.costUsd).toBeCloseTo(0.004);
  });

  it("uses a comic script's own page breaks for the page count", async () => {
    const script = 'PAGE 1\nPANEL 1\nMaya runs.\n\nPAGE 2\nPANEL 1\nShe stops.\n\nPage Three\nThe end.';
    const reply = { brief: { title: 'X', logline: '', premise: '', genre: '', tone: '', audience: '', setting: '', themes: [], notes: [] }, cast: [], places: [], suggestedPageCount: 9, styleHint: 'manga' };
    const { llm, calls } = fakeLlm([json(reply)]);
    const out = await analyzeSource({ doc: baseDoc(), llm, text: script });
    expect(out.suggestedPageCount).toBe(3);
    expect(out.styleHint).toBe('manga');
    expect(String(calls[0].messages[1].content)).toContain('a comic script with 3 page breaks');
  });

  it('rejects empty text without calling the model', async () => {
    const { llm, calls } = fakeLlm([]);
    await expect(analyzeSource({ doc: baseDoc(), llm, text: '   ' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(calls).toHaveLength(0);
  });

  it('estimatePageCount scales with prose length and clamps', () => {
    expect(estimatePageCount('word '.repeat(1000))).toBe(5);
    expect(estimatePageCount('tiny')).toBe(1);
    expect(estimatePageCount('word '.repeat(100_000))).toBe(40);
  });
});

// ── proposeStyleDirections ───────────────────────────────────────────────────

describe('proposeStyleDirections', () => {
  const words = (seed: string, n = 40) => Array.from({ length: n }, (_, i) => `${seed}${i}`).join(' ');

  it('asks for distinct, concrete directions and repairs short or duplicate ones', async () => {
    const first = {
      options: [
        { name: 'Monsoon Ink', spec: words('ink') },
        { name: 'Too Short', spec: 'flat colors only' },
        { name: 'Monsoon Ink', spec: words('other') }
      ]
    };
    const second = {
      options: [
        { name: 'Monsoon Ink', spec: words('ink') },
        { name: 'Neon Bazaar', spec: words('neon') },
        { name: 'Paper Cut', spec: words('paper') }
      ]
    };
    const { llm, calls } = fakeLlm([json(first), json(second)]);
    const out = await proposeStyleDirections({ doc: baseDoc(), llm, count: 3 });
    expect(calls).toHaveLength(2);
    expect(String(calls[0].messages[0].content)).toContain('Propose 3 distinct art directions');
    expect(String(calls[0].messages[0].content)).toContain('Do not copy them');
    const repair = String(calls[1].messages[3].content);
    expect(repair).toContain('write at least 35 words');
    expect(repair).toContain('repeats a name');
    expect(out.options.map((o) => o.name)).toEqual(['Monsoon Ink', 'Neon Bazaar', 'Paper Cut']);
  });

  it('rejects near-duplicate specs and fills remaining slots with the best-fitting presets', async () => {
    const dup = { options: [{ name: 'A', spec: words('same') }, { name: 'B', spec: words('same') }] };
    const { llm } = fakeLlm([json(dup), json(dup)]);
    const doc = baseDoc((d) => {
      d.format.colorMode = 'bw';
      d.brief.genre = 'crime mystery';
    });
    const out = await proposeStyleDirections({ doc, llm, count: 3 });
    expect(out.options).toHaveLength(3);
    expect(out.options[0].name).toBe('A');
    const presetNames = STYLE_PRESETS.map((p) => p.name);
    expect(presetNames).toContain(out.options[1].name);
    expect(out.options[1].name).toBe('Noir ink'); // b/w crime story → noir first
  });

  it('rejects a verbatim copy of a preset', async () => {
    const noir = STYLE_PRESETS.find((p) => p.id === 'noir-ink')!;
    const first = { options: [{ name: 'Rain Noir', spec: noir.spec }, { name: 'Own', spec: words('own') }] };
    const second = { options: [{ name: 'Rain Noir', spec: words('rain') }, { name: 'Own', spec: words('own') }] };
    const { llm, calls } = fakeLlm([json(first), json(second)]);
    const out = await proposeStyleDirections({ doc: baseDoc(), llm, count: 2 });
    expect(String(calls[1].messages[3].content)).toContain('copies the "Noir ink" example');
    expect(out.options.map((o) => o.name)).toEqual(['Rain Noir', 'Own']);
  });

  it('throws when nothing usable comes back', async () => {
    const { llm } = fakeLlm([json({ options: [] }), json({ options: [{ name: 'x', spec: 'short' }] })]);
    await expect(proposeStyleDirections({ doc: baseDoc(), llm, count: 2 })).rejects.toBeInstanceOf(StudioError);
  });
});

// ── helpers ──────────────────────────────────────────────────────────────────

describe('parseJsonText / completeStructured', () => {
  it('parses fenced JSON, prose-wrapped JSON and trailing commas', () => {
    expect(parseJsonText('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseJsonText('Here you go: {"a":[1,2,],} thanks')).toEqual({ a: [1, 2] });
    expect(parseJsonText('nothing')).toBeUndefined();
  });

  it('passes temperature, maxTokens and the abort signal through', async () => {
    const controller = new AbortController();
    const { llm, calls } = fakeLlm([json({ ok: true })]);
    const out = await completeStructured({
      llm,
      role: 'vision',
      system: 's',
      user: 'u',
      schemaName: 'x',
      schema: { type: 'object' },
      validate: (j) => ({ value: j, problems: [] }),
      failure: 'f',
      temperature: 0.3,
      maxTokens: 100,
      signal: controller.signal
    });
    expect(out.value).toEqual({ ok: true });
    expect(calls[0]).toMatchObject({ role: 'vision', temperature: 0.3, maxTokens: 100, signal: controller.signal });
  });
});

// ── v5 (P1-DIRECTOR): non-human cast, content rating, native language ────────

describe('writer v5', () => {
  it('newCast keeps kind/count (animals as first-class cast) and the schema stays strict', async () => {
    const { llm } = fakeLlm([
      json(
        plan(
          [rawPage(1, [rawPanel({ castIds: ['ch_maya', 'Ducklings'], action: 'Maya feeds three ducklings.' }), rawPanel({ n: 2, castIds: ['Ducklings'], action: 'The ducklings paddle off.' })])],
          [{ name: 'Ducklings', role: 'companions', tier: 'support', kind: 'animal', count: 3, look: { summary: 'Three fluffy yellow ducklings', species: 'duckling', markings: 'orange beaks' }, personality: '', voice: '' }]
        )
      )
    ]);
    const out = await writePagePlan({ doc: baseDoc((d) => (d.format.pageCount = 1)), llm });
    expect(out.newCast).toHaveLength(1);
    expect(out.newCast[0]).toMatchObject({ name: 'Ducklings', kind: 'animal', count: 3, tier: 'support', look: { species: 'duckling', markings: 'orange beaks' } });
    expect(out.pages[0].panels[1].castIds).toEqual([out.newCast[0].id]);
    const props = (PAGE_PLAN_SCHEMA.properties.newCast as { items: { properties: Record<string, unknown> } }).items.properties;
    expect(Object.keys(props)).toEqual(expect.arrayContaining(['kind', 'count']));
  });

  it('system prompt: non-human cast rules and a CONTENT RATING section (kids → PG/G)', () => {
    const adult = writerSystemPrompt(baseDoc());
    expect(adult).toContain('people AND animals, creatures, robots, toys, vehicles and key props');
    expect(adult).toContain('CONTENT RATING (PG-13)');
    expect(adult).toContain('Intense action, horror and suspense are fine');
    expect(adult).toContain('Never: sexual content or nudity');
    expect(adult).toContain('original homages');
    const kids = writerSystemPrompt(baseDoc((d) => (d.brief.audience = 'kids 6–9')));
    expect(kids).toContain('CONTENT RATING (PG)');
    const little = writerSystemPrompt(baseDoc((d) => (d.brief.audience = 'toddlers')));
    expect(little).toContain('CONTENT RATING (G)');
    expect(little).toContain('Audience is little children');
    const adapted = writerSystemPrompt(baseDoc((d) => (d.safety = { source: { hash: 'h', categories: ['graphic_gore'], adaptNotes: ['page 3: graphic injury'], at: 1 } })));
    expect(adapted).toContain('ADAPTATION: the source has scenes beyond PG-13 (page 3: graphic injury)');
  });

  it('native language register and script-aware line lengths (i18n.md §8.8)', () => {
    const telugu = writerSystemPrompt(baseDoc((d) => (d.format.language = 'te')));
    expect(telugu).toContain('At most 18 words per balloon');
    expect(telugu).toContain('natural, everyday spoken Telugu');
    expect(telugu).toContain('not a translation from English');
    const japanese = writerSystemPrompt(baseDoc((d) => (d.format.language = 'ja')));
    expect(japanese).toContain('At most 40 characters per balloon');
    expect(writerSystemPrompt(baseDoc())).toContain('Write every line in English.');
    const kidsHindi = writerSystemPrompt(baseDoc((d) => ((d.format.language = 'hi'), (d.brief.audience = 'बच्चों के लिए'))));
    expect(kidsHindi).toContain('For children: short, simple, warm words');
  });

  it('user message lists non-human cast with kind and count', () => {
    const msg = writerUserMessage(
      baseDoc((d) => d.cast.push({ id: 'ch_ducks', name: 'Ducklings', tier: 'support', kind: 'animal', count: 3, look: { summary: 'Fluffy ducklings', species: 'duckling' }, refs: [], sheet: emptyRender() })),
      {}
    );
    expect(msg).toContain('"id":"ch_ducks","name":"Ducklings","tier":"support","kind":"animal","count":3');
    expect(msg).toContain('species: duckling');
  });

  it('analyzeSource keeps kind/count for recurring animals and props', async () => {
    const look = { summary: 'a red paper kite', age: '', gender: '', build: '', face: '', hair: '', eyes: '', skin: '', outfit: '', palette: '', props: '', marks: '', species: 'kite', markings: 'patched' };
    const reply = {
      brief: { title: 'Kite Day', logline: '', premise: '', genre: '', tone: '', audience: 'children', setting: '', themes: [], notes: [] },
      cast: [{ name: 'Red Kite', role: 'prop', tier: 'extra', kind: 'object', count: 1, look, personality: '', voice: '' }],
      places: [],
      suggestedPageCount: 2,
      styleHint: ''
    };
    const { llm } = fakeLlm([json(reply)]);
    const out = await analyzeSource({ doc: baseDoc(), llm, text: 'The red kite flew. '.repeat(40) });
    expect(out.cast[0]).toMatchObject({ name: 'Red Kite', kind: 'object', look: { species: 'kite', markings: 'patched' } });
    expect(out.cast[0].count).toBeUndefined();
  });
});

// ── Plan fit (A1): fewer, larger panels; words that fit their panels ─────────

describe('writer plan fit', () => {
  const WORDS = 'listen the carrier behind those flower stalls has no plates and nobody has unloaded anything since morning which means someone wants us watching it closely tonight'.split(' ');
  const words = (n: number, seed = 0) => Array.from({ length: n }, (_, i) => WORDS[(seed + i) % WORDS.length]).join(' ');
  const say = (who: string, n: number, seed = 0) => ({ kind: 'speech', speakerId: who, text: words(n, seed) });

  it('the system prompt carries the panel-count and word-budget lines', () => {
    const prompt = writerSystemPrompt(baseDoc());
    expect(prompt).toContain(
      'Panels per page: usually 3 big panels (2–4) — fewer, larger panels give the art and the words room; let the dialogue and the beats decide. Use 5 only for a fast, nearly silent sequence (12 words or fewer on the whole page). Never more than 5.'
    );
    expect(prompt).toContain(
      'Word budget by panel size (every balloon and caption in the panel together): a full-width row holds about 40 words, a half-width panel on a two-row page about 32, a half-width panel on a three-row page about 20, a third-width small panel about 11.'
    );
    expect(prompt).toContain('Small panels are silent or carry one line of 12 words or fewer; conversations go in wide or medium panels.');
    expect(prompt).toContain('pov and insert shots carry at most 1 line of 12 words or fewer.');
    expect(prompt).toContain('At most 1 splash (one dominant panel) per 4 pages, never on two pages in a row');
    expect(prompt).toContain('Open every scene (a new place or a jump in time) with an establishing panel in a full-width row.');
    expect(prompt).toContain('Begin each action with the one thing the panel must show');
    expect(prompt).toContain('except an off-panel voice in a pov, insert or establishing shot');
    expect(prompt).not.toContain('Never more than 7');
    const webtoon = writerSystemPrompt(baseDoc((d) => (d.format.kind = 'webtoon')));
    expect(webtoon).toContain('Panels per page: 2–5 (usually 3).');
    expect(webtoon).toContain('segment of 2–5 full-width panels');
    // Character-counted scripts get the same budgets in their own unit (lineLengthRule's ratio).
    const ja = writerSystemPrompt(baseDoc((d) => (d.format.language = 'ja')));
    expect(ja).toContain('a full-width row holds about 64 characters, a half-width panel on a two-row page about 51, a half-width panel on a three-row page about 32, a third-width small panel about 17.');
    expect(ja).toContain('Small panels are silent or carry one line of 19 characters or fewer');
  });

  it('the validator flags 6 panels on auto, 29 words in a 0.084 panel no layout can fit and a 2-line pov panel — in one repair round', async () => {
    const doc = baseDoc((d) => (d.format.pageCount = 1));
    const crowded = rawPage(
      1,
      [
        rawPanel({ n: 1, castIds: ['ch_maya', 'ch_arjun'], lines: [say('ch_maya', 20)] }),
        rawPanel({ n: 2, castIds: ['ch_maya', 'ch_arjun'], lines: [say('ch_arjun', 20, 3)] }),
        rawPanel({ n: 3, size: 'wide', shot: 'wide', castIds: ['ch_maya', 'ch_arjun'], lines: [say('ch_maya', 20, 6)] }),
        rawPanel({ n: 4, size: 'small', castIds: ['ch_maya'], lines: [say('ch_maya', 20, 9)] }),
        rawPanel({ n: 5, size: 'small', castIds: ['ch_arjun'], lines: [say('ch_arjun', 20, 12)] }),
        rawPanel({ n: 6, size: 'small', shot: 'pov', castIds: ['ch_maya'], lines: [say('ch_arjun', 15, 5), say('ch_maya', 14, 9)] })
      ],
      { layout: 'Row 1: two equal panels. Row 2: one wide panel. Row 3: three small panels.' }
    );
    const fixed = rawPage(1, [rawPanel({ n: 1, size: 'wide', shot: 'establishing' }), rawPanel({ n: 2 }), rawPanel({ n: 3 })], { layout: 'Row 1: one wide panel. Row 2: two equal panels.' });
    const { llm, calls } = fakeLlm([json(plan([crowded])), json(plan([fixed]))]);
    const out = await writePagePlan({ doc, llm });
    expect(calls).toHaveLength(2);
    const repair = String(calls[1].messages[calls[1].messages.length - 1].content);
    expect(repair).toContain('Page 1 has 6 panels; plan 2–4 big panels (usually 3).');
    expect(repair).toContain('Page 1, panel 6: 29 words in a small panel (8% of the page; it holds about 9 in 2 balloons) — give it a full-width row');
    expect(repair).toContain('Page 1, panel 6 is a point-of-view shot with 2 lines (29 words)');
    expect(out.pages[0].panels).toHaveLength(3);
    expect(out.notes).toBeUndefined();
  });

  it('the validator applies a layout that fits in code and names it, without a writer repair', async () => {
    const doc = baseDoc((d) => (d.format.pageCount = 1));
    const page = rawPage(
      1,
      [
        rawPanel({ n: 1, size: 'wide', shot: 'establishing' }),
        rawPanel({ n: 2, size: 'small', castIds: ['ch_maya', 'ch_arjun'], lines: [say('ch_maya', 14), say('ch_arjun', 14, 4)] }),
        rawPanel({ n: 3, size: 'small', shot: 'close_up' }),
        rawPanel({ n: 4, size: 'small', shot: 'close_up', castIds: ['ch_arjun'] })
      ],
      { layout: 'Row 1: one wide panel. Row 2: three small panels.' }
    );
    const { llm, calls } = fakeLlm([json(plan([page]))]);
    const out = await writePagePlan({ doc, llm });
    expect(calls).toHaveLength(1);
    const [p1] = out.pages;
    expect(p1.layout).not.toBe('Row 1: one wide panel. Row 2: three small panels.');
    expect(p1.layout.startsWith('Row 1: one wide panel.')).toBe(true); // the establishing panel keeps its full-width row
    expect(p1.panels[1].size).toBe('wide');
    expect(out.notes).toEqual(["Page 1's layout changed so the conversation fits: panel 2 now has a full-width row."]);
    // normalizePlan itself (the validator) applies the same fix and asks for no repair.
    const check = normalizePlan(plan([page]), { doc, targets: null, pageCount: 1 });
    expect(check.problems).toEqual([]);
    expect(check.value!.pages[0].layout).toBe(p1.layout);
  });

  it('a storybook set to 4 panels per page plans at most 3, with a note', async () => {
    const doc = baseDoc((d) => {
      d.format.kind = 'storybook';
      d.format.panelsPerPage = 4;
      d.format.pageCount = 1;
    });
    const prompt = writerSystemPrompt(doc);
    expect(prompt).toContain('Panels per page: exactly 3 on every page — a storybook page holds at most 3 large panels (the format asks for 4).');
    expect(prompt).not.toContain('exactly 4 on every page');
    const four = rawPage(1, [1, 2, 3, 4].map((n) => rawPanel({ n, size: n === 1 ? 'wide' : 'medium' })), { layout: 'Row 1: one wide panel. Row 2: three small panels.' });
    const three = rawPage(1, [1, 2, 3].map((n) => rawPanel({ n })));
    const { llm, calls } = fakeLlm([json(plan([four])), json(plan([three]))]);
    const out = await writePagePlan({ doc, llm });
    expect(calls).toHaveLength(2);
    expect(String(calls[1].messages[calls[1].messages.length - 1].content)).toContain('Page 1 has 4 panels; plan exactly 3 (storybook pages hold at most 3).');
    expect(out.pages.every((p) => p.panels.length <= 3)).toBe(true);
    expect(out.notes).toEqual([
      'Storybook pages hold at most 3 large panels, so new pages are planned with 3 (your format asks for 4). Pages already planned keep theirs.'
    ]);
  });

  it('a pov speaker is not pushed into castIds (heard off-panel), while a non-pov speaker still is', async () => {
    const doc = baseDoc((d) => (d.format.pageCount = 1));
    const reply = plan([
      rawPage(1, [
        rawPanel({ n: 1, shot: 'pov', castIds: ['ch_maya'], action: "From Maya's view, a cart waits.", lines: [{ kind: 'speech', speakerId: 'ch_arjun', text: 'Over there.' }] }),
        rawPanel({ n: 2, shot: 'medium', castIds: ['ch_maya'], lines: [{ kind: 'speech', speakerId: 'ch_arjun', text: 'Now run.' }] }),
        rawPanel({ n: 3, shot: 'insert', castIds: [], action: 'A ledger.', lines: [{ kind: 'whisper', speakerId: 'Vendor', text: 'Mine.' }] })
      ])
    ]);
    const out = await writePagePlan({ doc, llm: fakeLlm([json(reply)]).llm });
    const [pov, medium, insert] = out.pages[0].panels;
    expect(pov.castIds).toEqual(['ch_maya']);
    expect(pov.lines[0].speakerId).toBe('ch_arjun');
    expect(medium.castIds).toEqual(['ch_maya', 'ch_arjun']);
    const vendor = out.newCast.find((c) => c.name === 'Vendor')!;
    expect(vendor).toBeTruthy(); // an off-panel voice is still a character (kept in newCast)
    expect(insert.castIds).toEqual([]);
    expect(insert.lines[0].speakerId).toBe(vendor.id);
  });

  it('promotes an extra seen in 3 panels on 2 pages to support (it gets a sheet); a one-page walk-on stays an extra', async () => {
    const doc = baseDoc((d) => (d.format.pageCount = 2));
    const pip = { name: 'Pip', role: 'duckling', tier: 'extra', kind: 'animal', count: 1, look: { summary: 'A fluffy yellow duckling' }, personality: '', voice: '' };
    const crow = { name: 'Crow', role: '', tier: 'extra', kind: 'animal', count: 1, look: { summary: 'A black crow' }, personality: '', voice: '' };
    const reply = plan(
      [
        rawPage(1, [rawPanel({ n: 1, castIds: ['ch_maya', 'Pip'] }), rawPanel({ n: 2, castIds: ['ch_maya', 'Pip', 'Crow'] }), rawPanel({ n: 3, castIds: ['Crow'] })]),
        rawPage(2, [rawPanel({ n: 1, castIds: ['ch_maya', 'Pip'] }), rawPanel({ n: 2, castIds: ['ch_maya'] })])
      ],
      [pip, crow]
    );
    const out = await writePagePlan({ doc, llm: fakeLlm([json(reply)]).llm });
    expect(out.newCast.find((c) => c.name === 'Pip')!.tier).toBe('support');
    expect(out.newCast.find((c) => c.name === 'Crow')!.tier).toBe('extra');
  });
});
