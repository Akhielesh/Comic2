// @vitest-environment node
// Probe (quote vs charge): the quote prices `plan.calls` translator calls (estimateTranslationTokens
// has no repair allowance), but translateChunk makes a SECOND call per chunk whenever any line fails
// validation (a glossary form not used verbatim, script share, empty line…). The repair call re-sends
// the whole conversation (system + user + first answer + repair request), so a chunk that needs a
// repair costs roughly twice what was quoted; the gate's 15 % stale tolerance is checked on the
// estimate only, never on the bill. Observed here with the fakes: translator calls = 2 × plan.calls.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { applyOps } from '../../shared/comic/ops.js';
import { JOB_TIMINGS } from '../../server/src/comic/jobs.js';
import { quoteTranslation, resetTranslationCalibration, runTranslation } from '../../server/src/comic/i18n/index.js';
import { fakeLinguist, fakeTranslator, requestedIds, sixPageKidsDoc, times } from '../../server/src/comic/i18n/testing.js';
import { newSession, scriptedLlm, testContext } from '../../server/src/comic/orchestrator.fakes.js';

beforeEach(() => {
  JOB_TIMINGS.retryBackoffMs = 0;
  resetTranslationCalibration();
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

describe('translator repair rounds are not in the quote', () => {
  it('charges the quoted number of translator calls', async () => {
    // A glossary form the author set ("Frog" → కప్ప) that the model's first answer does not use verbatim.
    const doc = applyOps(sixPageKidsDoc(), [{ op: 'glossary_term', id: 'gl_c_c_frog', patch: { term: 'Frog', kind: 'character', refId: 'c_frog', policy: 'transliterate', forms: { te: 'కప్ప' } } }]);
    const session = newSession(doc);
    const quote = quoteTranslation(doc, { openrouter: { key: 'sk-or-test', byok: false } }, { languages: ['te'] });
    const tr = fakeTranslator({
      // First answer of each chunk: l7 ("Hold on tight, Frog!") without the glossary form → repair round.
      text: (id, lang, attempt) => (id === 'l7' && lang === 'te' && attempt === 2 ? 'గట్టిగా పట్టుకో!' : id === 'l7' ? 'గట్టిగా పట్టుకో, కప్ప!' : undefined)
    });
    const ctx = testContext(session, { llm: scriptedLlm({ translator: times(6, tr.step), linguist: times(2, fakeLinguist()) }) });
    const started = await runTranslation(ctx, { type: 'translate', languages: ['te'] }, { confirmed: true, origin: 'user' });
    await started.done;
    await ctx.settled();
    const translatorCalls = ctx.llmFake.calls.filter((c) => c.role === 'translator');
    const repairs = translatorCalls.filter((c) => /can't be used yet/.test(String(c.messages[c.messages.length - 1]?.content)));
    const spend = session.doc.spend.entries.find((s) => s.kind === 'translate');
    process.stderr.write(
      `probe translation.7 ${JSON.stringify({ quotedCalls: quote.plans[0].calls, quotedUsd: quote.estimate.usd, translatorCalls: translatorCalls.length, repairCalls: repairs.length, repairRequested: repairs.map((r) => requestedIds(r)), promptCharsFirst: JSON.stringify(translatorCalls[0]?.messages).length, promptCharsRepair: JSON.stringify(repairs[0]?.messages).length, spendUsd: spend?.usd })}\n`
    );
    expect(translatorCalls.length).toBe(quote.plans[0].calls);
  });
});
