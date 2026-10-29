// @vitest-environment node
// Probe: the "Mixed with English" (code_mixed) voice. The translator is told to write natural
// code-mixed Hindi (English words allowed, Devanagari script, 40 % script threshold in checkLine),
// but the linguist's system prompt (prompts.ts linguistSystemPrompt(doc, lang)) never receives the
// register: it says "the wrong script" is a MAJOR issue and asks for "natural spoken Hindi". A valid
// Hinglish line then gets a major verdict with a pure-Hindi suggestion, and applyReview auto-applies
// it ("Auto-corrected by review"), overriding the voice the author picked. The known-issues list only
// covers the EVERYDAY voice being flagged — this is the voice built for Hinglish.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { i18nOf } from '../../shared/comic/i18n.js';
import { applyOps } from '../../shared/comic/ops.js';
import { AUTO_CORRECTED_NOTE } from '../../shared/comic/translationPlan.js';
import { JOB_TIMINGS } from '../../server/src/comic/jobs.js';
import { resetTranslationCalibration, runTranslation } from '../../server/src/comic/i18n/index.js';
import { linguistSystemPrompt, translatorSystemPrompt } from '../../server/src/comic/i18n/prompts.js';
import { checkLine } from '../../server/src/comic/i18n/translate.js';
import { fakeLinguist, fakeTranslator, sixPageKidsDoc, times } from '../../server/src/comic/i18n/testing.js';
import { newSession, scriptedLlm, testContext } from '../../server/src/comic/orchestrator.fakes.js';

beforeEach(() => {
  JOB_TIMINGS.retryBackoffMs = 0;
  resetTranslationCalibration();
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

// Natural Hinglish for "Where did the moon go?" — Devanagari + an English word (6 of 9 \p{L} letters
// are Devanagari; vowel signs are marks and do not count, which is why "Moon कहाँ गया yaar?" would fail).
const HINGLISH = 'चाँद कहाँ गया, bro?';

describe('code_mixed register: translator vs linguist', () => {
  it('the linguist is told about the code-mixed voice, and a valid Hinglish line survives the review', async () => {
    const doc = applyOps(sixPageKidsDoc(), [{ op: 'edition', lang: 'hi', patch: { register: 'code_mixed' } }]);
    const edition = i18nOf(doc).editions.hi;
    // Software accepts the line under the code_mixed threshold (no problem).
    const check = checkLine('hi', 'code_mixed', { id: 'l1', source: 'Where did the moon go?', maxChars: 40, forms: [], keep: [] }, HINGLISH, 'PG', 'en');
    const trPrompt = translatorSystemPrompt(doc, 'hi', edition);
    const lnPrompt = linguistSystemPrompt(doc, 'hi');
    const linguistKnowsRegister = /code.?mix|mixed with english|english words/i.test(lnPrompt);
    process.stderr.write(`probe translation.6 ${JSON.stringify({ check, translatorMentionsCodeMixed: /code-mixed/i.test(trPrompt), linguistKnowsRegister, linguistWrongScriptIsMajor: /wrong script/i.test(lnPrompt) })}\n`);

    // Run it: the translator writes Hinglish for l1; the linguist, following ITS prompt, flags the
    // Latin words as the wrong script and offers pure Hindi.
    const session = newSession(doc);
    const tr = fakeTranslator({ text: (id, lang) => (id === 'l1' && lang === 'hi' ? HINGLISH : undefined) });
    const linguist = fakeLinguist((id) => (id === 'l1' ? { verdict: 'fix', severity: 'major', issue: 'Wrong script: English words in a Hindi line.', suggestion: 'चाँद कहाँ गया?' } : undefined));
    const ctx = testContext(session, { llm: scriptedLlm({ translator: times(4, tr.step), linguist: times(2, linguist) }) });
    const started = await runTranslation(ctx, { type: 'translate', languages: ['hi'] }, { confirmed: true, origin: 'user' });
    await started.done;
    await ctx.settled();
    const l1 = i18nOf(session.doc).editions.hi.lines.l1;
    process.stderr.write(`probe translation.6 run ${JSON.stringify({ l1, autoCorrected: !!l1.issue?.note.startsWith(AUTO_CORRECTED_NOTE) })}\n`);
    expect(check.problem).toBeUndefined();
    expect(linguistKnowsRegister).toBe(true);
    expect(l1.text).toBe(HINGLISH);
  });
});
