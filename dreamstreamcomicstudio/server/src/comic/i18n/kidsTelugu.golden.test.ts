// @vitest-environment node
// Golden scenario golden/scenarios/kids-telugu.json (P1-I18N): the director translates a kids comic
// into Telugu (writer-class translator + linguist review with gloss), the edition is publishable, the
// comic is then made natively Telugu for free, and a rerun makes no model call. Scripted model
// replies only — no network, $0.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComicDoc } from '../../../../shared/comic/doc.js';
import { editionReadiness, i18nOf } from '../../../../shared/comic/i18n.js';
import type { StudioAction } from '../../../../shared/comic/ops.js';
import { runDirectorTurn } from '../director.js';
import { GOLDEN_DOCS } from '../golden/fixtures.js';
import { JOB_TIMINGS, startAction } from '../jobs.js';
import { newSession, scriptedLlm, testContext, type ScriptStep } from '../orchestrator.fakes.js';
import { buildTurnToolset, createDirectorTurn } from '../tools.js';
import { toolGroups } from '../tools/index.js';
import { resetTranslationCalibration } from './index.js';

interface Turn {
  say?: string;
  action?: StudioAction;
  expectTools?: string[];
  director?: Array<{ text?: string; toolCalls?: { name: string; args: unknown }[] }>;
  translator?: Partial<{ json: unknown }>[];
  linguist?: Partial<{ json: unknown }>[];
  expect?: {
    replyIncludes?: string;
    completionIncludes?: string;
    publishable?: string[];
    glosses?: Record<string, string>;
    calls?: { translator?: number; linguist?: number };
    spendKind?: string;
    language?: string;
    lineText?: Record<string, string>;
    newSpendUsd?: number;
  };
}
interface Scenario { name: string; about: string; doc: string; turns: Turn[] }

const file = join(dirname(fileURLToPath(import.meta.url)), '..', 'golden', 'scenarios', 'kids-telugu.json');
const scenario = JSON.parse(readFileSync(file, 'utf8')) as Scenario;

const directorSteps = (turn: Turn): ScriptStep[] =>
  (turn.director || []).map((s, i) => ({
    text: s.text ?? '',
    ...(s.toolCalls?.length ? { toolCalls: s.toolCalls.map((c, k) => ({ id: `t${i}_${k}`, name: c.name, arguments: JSON.stringify(c.args) })) } : {})
  }));

const lineById = (doc: ComicDoc, id: string) => doc.pages.flatMap((p) => p.panels.flatMap((pn) => pn.lines)).find((l) => l.id === id);

beforeEach(() => {
  JOB_TIMINGS.retryBackoffMs = 0;
  JOB_TIMINGS.turnLockWaitMs = 20;
  resetTranslationCalibration();
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

describe(`golden: ${scenario.name}`, () => {
  it('is a well-formed scenario on a known fixture', () => {
    expect(scenario.name).toBe('kids-telugu');
    expect(GOLDEN_DOCS[scenario.doc]).toBeTypeOf('function');
    expect(scenario.turns.length).toBeGreaterThanOrEqual(3);
  });

  it(scenario.about.slice(0, 120), async () => {
    const session = newSession(GOLDEN_DOCS[scenario.doc]());
    for (const [i, turn] of scenario.turns.entries()) {
      const label = `${scenario.name} turn ${i + 1}`;
      const llm = scriptedLlm({
        director: directorSteps(turn),
        translator: [...(turn.translator || [])] as ScriptStep[],
        linguist: [...(turn.linguist || [])] as ScriptStep[]
      });
      const ctx = testContext(session, { llm });
      const spendBefore = session.doc.spend.totalUsd;
      const before = session.doc.conversation.length;
      if (turn.action) {
        await (await startAction(ctx, turn.action, { confirmed: true, origin: 'user' })).done;
      } else {
        if (turn.expectTools?.length) {
          const offered = new Set(buildTurnToolset(ctx, createDirectorTurn({ userText: turn.say || '' }), toolGroups()).tools.map((t) => t.spec.function.name));
          for (const tool of turn.expectTools) expect(offered.has(tool), `${label}: ${tool} offered`).toBe(true);
        }
        await runDirectorTurn(ctx, { text: turn.say || '', attachments: [] });
      }
      await ctx.settled();
      const e = turn.expect || {};
      const doc = session.doc;
      const fresh = doc.conversation.slice(before).filter((m) => m.role === 'assistant');
      expect(fresh.length, `${label}: never silent`).toBeGreaterThan(0);
      for (const m of fresh) expect(m.text.trim().length || m.cards?.length, `${label}: no empty message`).toBeTruthy();
      if (e.replyIncludes) expect(fresh.map((m) => m.text).join('\n'), label).toContain(e.replyIncludes);
      if (e.completionIncludes) expect(fresh[fresh.length - 1].text, label).toContain(e.completionIncludes);
      for (const lang of e.publishable || []) expect(editionReadiness(doc, lang), `${label}: ${lang}`).toMatchObject({ publishable: true });
      for (const [id, gloss] of Object.entries(e.glosses || {})) expect(i18nOf(doc).editions.te?.lines[id]?.gloss, label).toBe(gloss);
      if (e.calls?.translator !== undefined) expect(llm.calls.filter((c) => c.role === 'translator'), label).toHaveLength(e.calls.translator);
      if (e.calls?.linguist !== undefined) expect(llm.calls.filter((c) => c.role === 'linguist'), label).toHaveLength(e.calls.linguist);
      if (e.spendKind) expect(doc.spend.entries.some((s) => s.kind === e.spendKind), label).toBe(true);
      if (e.language) expect(doc.format.language, label).toBe(e.language);
      for (const [id, text] of Object.entries(e.lineText || {})) expect(lineById(doc, id)?.text, label).toBe(text);
      if (e.newSpendUsd !== undefined) expect(doc.spend.totalUsd - spendBefore, label).toBeCloseTo(e.newSpendUsd, 6);
    }
    // The appended completion message never replaced an older message.
    const ats = session.doc.conversation.map((m) => m.at);
    expect([...ats].sort((a, b) => a - b)).toEqual(ats);
  });
});
