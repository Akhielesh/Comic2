// @vitest-environment node
// Probe: the Review tab promises "Edits are free and yours: a later translation never overwrites
// them", and the start message's card offers "Review" while the run is still going. A line the author
// edits WHILE the translation runs is (a) overwritten by the machine text of a later chunk
// (chunkOps → `translations` upserts unconditionally, i18n/translate.ts chunkOps) and (b) re-labelled /
// replaced by the linguist review (linguist.ts applyReview reads the CURRENT entry, never checks
// status 'edited' or that the reviewed text is still the stored text).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { i18nOf, lineSourceHash } from '../../shared/comic/i18n.js';
import { JOB_TIMINGS } from '../../server/src/comic/jobs.js';
import { resetTranslationCalibration, runTranslation } from '../../server/src/comic/i18n/index.js';
import { fakeLinguist, fakeTranslator, sixPageKidsDoc, times } from '../../server/src/comic/i18n/testing.js';
import { newSession, scriptedLlm, testContext } from '../../server/src/comic/orchestrator.fakes.js';
import type { LlmRequest } from '../../server/src/comic/types.js';

beforeEach(() => {
  JOB_TIMINGS.retryBackoffMs = 0;
  resetTranslationCalibration();
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

const lineOf = (doc: ReturnType<typeof sixPageKidsDoc>, id: string) => doc.pages.flatMap((p) => p.panels.flatMap((pn) => pn.lines)).find((l) => l.id === id)!;

describe('author edits made while a translation is running', () => {
  it('are kept as "edited" and never overwritten by the run', async () => {
    const doc = sixPageKidsDoc();
    const session = newSession(doc);
    const tr = fakeTranslator();
    let translatorCalls = 0;
    const edit = (id: string, text: string) =>
      session.commit([{ op: 'translation', lang: 'te', lineId: id, patch: { text, status: 'edited', sourceHash: lineSourceHash(lineOf(session.doc, id)), at: Date.now() } }], { origin: 'user', label: 'Edit translation' });
    const translator = (req: LlmRequest) => {
      translatorCalls += 1;
      // Chunk 1 (pages 1–3) is being translated: the author types a Telugu line for l9 (page 5, chunk 2).
      if (translatorCalls === 1) edit('l9', 'నా స్వంత అనువాదం తొమ్మిది');
      // Chunk 2 (pages 4–6) is being translated: the author rewrites l1 (committed as machine by chunk 1).
      if (translatorCalls === 2) edit('l1', 'నా స్వంత అనువాదం ఒకటి');
      return tr.step(req);
    };
    // The linguist (which runs after every chunk) reviews l1 and says "fix, major" with a suggestion.
    const linguist = fakeLinguist((id) => (id === 'l1' ? { verdict: 'fix', severity: 'major', issue: 'Meaning is off.', suggestion: 'చంద్రుడు ఎక్కడ?' } : undefined));
    const llm = scriptedLlm({ translator: times(4, translator), linguist: times(2, linguist) });
    const ctx = testContext(session, { llm });
    const started = await runTranslation(ctx, { type: 'translate', languages: ['te'] }, { confirmed: true, origin: 'user' });
    await started.done;
    await ctx.settled();

    const e = i18nOf(session.doc).editions.te;
    process.stderr.write(`probe translation.2 ${JSON.stringify({ translatorCalls, l9: e.lines.l9, l1: e.lines.l1, last: session.doc.conversation.at(-1)?.text })}\n`);
    // Expected: both author edits survive, as 'edited'.
    expect(e.lines.l9).toMatchObject({ text: 'నా స్వంత అనువాదం తొమ్మిది', status: 'edited' });
    expect(e.lines.l1).toMatchObject({ text: 'నా స్వంత అనువాదం ఒకటి', status: 'edited' });
  });
});
