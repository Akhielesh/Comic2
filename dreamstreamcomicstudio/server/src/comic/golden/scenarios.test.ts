// @vitest-environment node
// Director golden set (P1-DIRECTOR): the owner's real flows replayed with scripted model replies
// and fake images — no network, $0. Each scenario (./scenarios/*.json) checks that the director
// is never silent, understands non-human cast, steers named IP to an homage, and never spends
// on a finished book. The same set measures the tool surface: every tool a turn needs must be
// offered (tool-choice accuracy, no regression) and the median prompt may grow ≤ 15 % over the
// wave-0 baseline (measured on commit d785cac before this package).
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { castKindOf, type ComicDoc } from '../../../../shared/comic/doc.js';
import type { StudioAction } from '../../../../shared/comic/ops.js';
import { DIRECTOR_SYSTEM_PROMPT, runDirectorTurn, summarizeDocForDirector } from '../director.js';
import { JOB_TIMINGS, startAction } from '../jobs.js';
import { routeIntent } from '../intents.js';
import { newSession, scriptedLlm, testContext, type ScriptStep, type TestContext } from '../orchestrator.fakes.js';
import { buildTurnToolset, createDirectorTurn } from '../tools.js';
import { toolGroups } from '../tools/index.js';
import { GOLDEN_DOCS } from './fixtures.js';

interface ScenarioTurn {
  say?: string;
  action?: StudioAction;
  about?: string;
  routeIntent?: 'show_pages' | 'nothing_to_draw';
  expectTools?: string[];
  userContentIncludes?: string;
  userContentExcludes?: string;
  director?: Array<{ text?: string; toolCalls?: { name: string; args: unknown }[] }>;
  writer?: ScriptStep[];
  expect?: {
    replyStartsWith?: string;
    replyEndsWith?: string;
    replyIncludes?: string;
    cards?: string[];
    cast?: [string, string, number][];
    imageCalls?: number;
    newImageCalls?: number;
    newSpendUsd?: number;
    outcome?: string;
    nextSteps?: string[];
    gateReason?: string;
    ipNoted?: string[];
  };
}
interface Scenario { name: string; about: string; doc: string; turns: ScenarioTurn[] }

const dir = join(dirname(fileURLToPath(import.meta.url)), 'scenarios');
/** P1-DIRECTOR's scenarios (other packages add their own files here, e.g. kids-telugu.json). */
const OWN = ['lake-kids.json', 'shinchan-homage.json', 'generate-all-drawn.json'];
const scenarios: Scenario[] = readdirSync(dir)
  .filter((f) => OWN.includes(f))
  .sort()
  .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as Scenario);

/** Wave-0 baseline (core tools + system prompt + doc summary, 5 golden docs), d785cac. */
const BASELINE_MEDIAN_PROMPT_CHARS = 18_413;

const steps = (turn: ScenarioTurn): ScriptStep[] =>
  (turn.director || []).map((s, i) => ({
    text: s.text ?? '',
    ...(s.toolCalls?.length ? { toolCalls: s.toolCalls.map((c, k) => ({ id: `t${i}_${k}`, name: c.name, arguments: JSON.stringify(c.args) })) } : {})
  }));

/** Image spend only (the director's own text call is a few tenths of a cent and not "drawing"). */
const imageSpend = (doc: ComicDoc) => (['style', 'sheet', 'page', 'edit', 'cover'] as const).reduce((n, k) => n + (doc.spend.byKind[k] || 0), 0);

const lastAssistant = (doc: ComicDoc) => [...doc.conversation].reverse().find((m) => m.role === 'assistant');

beforeEach(() => {
  JOB_TIMINGS.retryBackoffMs = 0;
  JOB_TIMINGS.turnLockWaitMs = 20;
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

describe('director golden scenarios', () => {
  it('ships the three P1-DIRECTOR scenarios', () => {
    expect(scenarios.map((s) => s.name).sort()).toEqual(['generate-all-drawn', 'lake-kids', 'shinchan-homage']);
  });

  for (const scenario of scenarios) {
    it(`${scenario.name}: ${scenario.about.slice(0, 80)}…`, async () => {
      const session = newSession(GOLDEN_DOCS[scenario.doc]());
      let ctx: TestContext | undefined;
      for (const [i, turn] of scenario.turns.entries()) {
        const label = `${scenario.name} turn ${i + 1}`;
        if (turn.action) {
          ctx = testContext(session, { images: ctx?.imagesFake });
          await (await startAction(ctx, turn.action, { confirmed: true, origin: 'user' })).done;
          await ctx.settled();
          continue;
        }
        const say = turn.say || '';
        if (turn.routeIntent) expect(routeIntent(session.doc, say)?.kind, label).toBe(turn.routeIntent);
        const llm = scriptedLlm({ director: steps(turn), ...(turn.writer ? { writer: [...turn.writer] } : {}) });
        const images = ctx?.imagesFake;
        ctx = testContext(session, { llm, ...(images ? { images } : {}) });
        const imagesBefore = ctx.imagesFake.calls.length;
        const spendBefore = imageSpend(session.doc);
        await runDirectorTurn(ctx, { text: say, attachments: [] });
        await ctx.settled();

        const director = llm.calls.filter((c) => c.role === 'director');
        const offered = director[0]?.tools?.map((t) => t.function.name) || [];
        for (const tool of turn.expectTools || []) expect(offered, `${label}: ${tool} offered`).toContain(tool);
        const userContent = JSON.stringify(director[0]?.messages[director[0].messages.length - 1]?.content ?? '');
        if (turn.userContentIncludes) expect(userContent, label).toContain(turn.userContentIncludes);
        if (turn.userContentExcludes) expect(userContent, label).not.toContain(turn.userContentExcludes);

        const reply = lastAssistant(session.doc)!;
        expect(reply.text.trim().length, `${label}: never silent`).toBeGreaterThan(0);
        const e = turn.expect || {};
        if (e.replyStartsWith) expect(reply.text.startsWith(e.replyStartsWith), `${label}: "${reply.text}"`).toBe(true);
        if (e.replyEndsWith) expect(reply.text.endsWith(e.replyEndsWith), `${label}: "${reply.text}"`).toBe(true);
        if (e.replyIncludes) expect(reply.text, label).toContain(e.replyIncludes);
        if (e.cards) expect((reply.cards || []).map((c) => c.type), label).toEqual(e.cards);
        if (e.cast) expect(session.doc.cast.map((c) => [c.name, castKindOf(c), c.count ?? 1]), label).toEqual(e.cast);
        if (e.imageCalls !== undefined) expect(ctx.imagesFake.calls.length, label).toBe(e.imageCalls);
        if (e.newImageCalls !== undefined) expect(ctx.imagesFake.calls.length - imagesBefore, label).toBe(e.newImageCalls);
        if (e.newSpendUsd !== undefined) expect(imageSpend(session.doc) - spendBefore, label).toBeCloseTo(e.newSpendUsd, 6);
        if (e.nextSteps) expect((reply.nextSteps || []).map((s) => s.label), label).toEqual(expect.arrayContaining(e.nextSteps));
        if (e.gateReason) expect(session.doc.gate, label).toMatchObject({ status: 'open', reason: e.gateReason });
        if (e.ipNoted) expect(session.doc.safety?.ipNoted, label).toEqual(e.ipNoted);
        if (e.outcome === 'nothing') expect(session.doc.gate?.status === 'open', `${label}: no gate for $0`).toBe(false);
      }
      // Never silent across the whole scenario.
      const silent = session.doc.conversation.filter((m) => m.role === 'assistant' && !m.text.trim() && !m.cards?.some((c) => c.type === 'renders'));
      expect(silent).toEqual([]);
    });
  }
});

describe('tool surface measured on the golden set', () => {
  it('tool-choice accuracy: every tool a golden turn needs is offered (100 %, no regression)', () => {
    let needed = 0;
    let offered = 0;
    for (const scenario of scenarios) {
      for (const turn of scenario.turns) {
        if (!turn.say) continue;
        const doc = GOLDEN_DOCS[scenario.doc]();
        const ctx = testContext(newSession(doc));
        const set = new Set(buildTurnToolset(ctx, createDirectorTurn({ userText: turn.say }), toolGroups()).tools.map((t) => t.spec.function.name));
        for (const tool of turn.expectTools || []) {
          needed += 1;
          if (set.has(tool)) offered += 1;
        }
      }
    }
    expect(needed).toBeGreaterThan(10);
    expect(offered / needed).toBe(1);
  });

  it(`the median prompt grows ≤ 15 % over the wave-0 baseline (${BASELINE_MEDIAN_PROMPT_CHARS} chars)`, () => {
    const sizes = Object.values(GOLDEN_DOCS)
      .map((make) => {
        const doc = make();
        const ctx = testContext(newSession(doc));
        const toolset = buildTurnToolset(ctx, createDirectorTurn({ userText: 'hello' }), []);
        const system = `${DIRECTOR_SYSTEM_PROMPT}\n\n${summarizeDocForDirector(doc, false, toolset.summaryLines, { userText: 'hello' })}`;
        return system.length + JSON.stringify(toolset.tools.map((t) => t.spec)).length;
      })
      .sort((a, b) => a - b);
    const median = sizes[Math.floor(sizes.length / 2)];
    expect(median / BASELINE_MEDIAN_PROMPT_CHARS).toBeLessThanOrEqual(1.15);
  });
});
