// @vitest-environment node
// Golden scenario golden/scenarios/style-looks.json (stylepick SC-0; liveturn PLAN-2 must keep it green): an ask to
// see drawn looks ends in an Approve card for N looks, even when the model first calls the free presets tool (it
// refuses toward propose_styles); a which-look question still gets the free presets card. The compiled system
// prompt carries rule 4's looks sentence. Scripted model replies and fake images only: no network, $0.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComicDoc } from '../../../../shared/comic/doc.js';
import { DIRECTOR_SYSTEM_PROMPT, runDirectorTurn } from '../director.js';
import { JOB_TIMINGS } from '../jobs.js';
import { newSession, scriptedLlm, testContext, type ScriptStep, type TestContext } from '../orchestrator.fakes.js';
import { GOLDEN_DOCS } from './fixtures.js';

interface Turn {
  say: string;
  expectTools?: string[];
  director?: Array<{ text?: string; toolCalls?: { name: string; args: unknown }[] }>;
  expect?: {
    toolResultIncludes?: string;
    gateReason?: string;
    gateAction?: Record<string, unknown>;
    gateTitle?: string;
    cards?: string[];
    noCards?: string[];
    newImageCalls?: number;
    newSpendUsd?: number;
  };
}
interface Scenario { name: string; about: string; doc: string; turns: Turn[] }

const file = join(dirname(fileURLToPath(import.meta.url)), 'scenarios', 'style-looks.json');
const scenario = JSON.parse(readFileSync(file, 'utf8')) as Scenario;

/** Rule 4's looks sentence (stylepick SC-0; liveturn PLAN-2 keeps it). Short on purpose: the system prompt's median size is
 *  capped (golden/scenarios.test.ts); the details live in the propose_styles description and the library group rule. */
const LOOKS_SENTENCE = 'A look: WHICH look → a FREE preset (set_style presetId, or suggest_presets/use_preset when offered); SEE or draw looks → propose_styles.';

const steps = (turn: Turn): ScriptStep[] =>
  (turn.director || []).map((s, i) => ({
    text: s.text ?? '',
    ...(s.toolCalls?.length ? { toolCalls: s.toolCalls.map((c, k) => ({ id: `t${i}_${k}`, name: c.name, arguments: JSON.stringify(c.args) })) } : {})
  }));

const imageSpend = (doc: ComicDoc) => (['style', 'sheet', 'page', 'edit', 'cover'] as const).reduce((n, k) => n + (doc.spend.byKind[k] || 0), 0);
const lastAssistant = (doc: ComicDoc) => [...doc.conversation].reverse().find((m) => m.role === 'assistant');

beforeEach(() => {
  JOB_TIMINGS.retryBackoffMs = 0;
  JOB_TIMINGS.turnLockWaitMs = 20;
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

describe(`golden: ${scenario.name}`, () => {
  it('is a well-formed scenario on a known fixture with an empty style and the default policy', () => {
    expect(scenario.name).toBe('style-looks');
    const doc = GOLDEN_DOCS[scenario.doc]();
    expect(doc.style.status).toBe('empty');
    expect(doc.settings.confirm).toBe('big');
    expect(scenario.turns.length).toBeGreaterThanOrEqual(3);
  });

  it('rule 4 carries the looks sentence once, and the old free-preset-first sentence is gone', () => {
    expect(DIRECTOR_SYSTEM_PROMPT.split(LOOKS_SENTENCE)).toHaveLength(2);
    expect(DIRECTOR_SYSTEM_PROMPT).not.toContain('before paid style tests');
  });

  it(scenario.about.slice(0, 120), async () => {
    const session = newSession(GOLDEN_DOCS[scenario.doc]());
    let ctx: TestContext | undefined;
    for (const [i, turn] of scenario.turns.entries()) {
      const label = `${scenario.name} turn ${i + 1}`;
      const llm = scriptedLlm({ director: steps(turn) });
      const images = ctx?.imagesFake;
      ctx = testContext(session, { llm, ...(images ? { images } : {}) });
      const imagesBefore = ctx.imagesFake.calls.length;
      const spendBefore = imageSpend(session.doc);
      await runDirectorTurn(ctx, { text: turn.say, attachments: [] });
      await ctx.settled();

      const director = llm.calls.filter((c) => c.role === 'director');
      const system = String(director[0]?.messages[0]?.content ?? '');
      expect(system, `${label}: compiled prompt`).toContain(LOOKS_SENTENCE);
      const offered = director[0]?.tools?.map((t) => t.function.name) || [];
      for (const tool of turn.expectTools || []) expect(offered, `${label}: ${tool} offered`).toContain(tool);

      const reply = lastAssistant(session.doc)!;
      expect(reply.text.trim().length, `${label}: never silent`).toBeGreaterThan(0);
      const cards = (reply.cards || []).map((c) => c.type);
      const e = turn.expect || {};
      if (e.toolResultIncludes) expect(JSON.stringify(director.map((c) => c.messages)), label).toContain(e.toolResultIncludes);
      if (e.gateReason) expect(session.doc.gate, label).toMatchObject({ status: 'open', reason: e.gateReason });
      if (e.gateAction) expect(session.doc.gate?.action, label).toMatchObject(e.gateAction);
      if (e.gateTitle) expect(session.doc.gate?.title, label).toBe(e.gateTitle);
      if (e.gateReason) expect(cards, `${label}: the Approve card rides the reply`).toContain('gate');
      if (e.cards) expect(cards, label).toEqual(e.cards);
      for (const type of e.noCards || []) expect(cards, label).not.toContain(type);
      if (e.newImageCalls !== undefined) expect(ctx.imagesFake.calls.length - imagesBefore, label).toBe(e.newImageCalls);
      if (e.newSpendUsd !== undefined) expect(imageSpend(session.doc) - spendBefore, label).toBeCloseTo(e.newSpendUsd, 6);
    }
    expect(session.doc.style.options, 'no look was drawn without Approve').toEqual([]);
  });
});
