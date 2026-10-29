// @vitest-environment node
// Probe: the Languages tab's "Finish the review · free" button for an edition whose only remaining
// work is lines the review FLAGGED (status 'machine' + major issue, no suggestion). editionProgress
// counts them as `unreviewed`, so EditionRow (LanguagesTab.tsx:314-369) shows work > 0 and renders the
// button; but planTranslation excludes flagged lines from `toReview`, so the quote is $0/free and the
// run says "already up to date" — nothing changes. Expected: either the button is not offered (or
// opens the Review for the flagged lines), or the run re-reviews. Observed: a dead-end loop.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { editionProgress, editionReadiness, i18nOf } from '../../shared/comic/i18n.js';
import { planIsFree } from '../../shared/comic/translationPlan.js';
import { JOB_TIMINGS } from '../../server/src/comic/jobs.js';
import { quoteTranslation, resetTranslationCalibration, runTranslation } from '../../server/src/comic/i18n/index.js';
import { fakeLinguist, fakeTranslator, sixPageKidsDoc, times } from '../../server/src/comic/i18n/testing.js';
import { newSession, scriptedLlm, testContext } from '../../server/src/comic/orchestrator.fakes.js';

beforeEach(() => {
  JOB_TIMINGS.retryBackoffMs = 0;
  resetTranslationCalibration();
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

describe('"Finish the review" on an edition whose only open work is review-flagged lines', () => {
  it('offers a free button whose run changes nothing (unreviewed stays > 0)', async () => {
    const session = newSession(sixPageKidsDoc());
    // The linguist flags l1 as major WITHOUT a suggestion → status stays 'machine' with a major issue.
    const linguist = fakeLinguist((id) => (id === 'l1' ? { verdict: 'fix', severity: 'major', issue: 'Wrong meaning.', suggestion: '' } : undefined));
    const llm = scriptedLlm({ translator: times(4, fakeTranslator().step), linguist: times(2, linguist) });
    const ctx = testContext(session, { llm });
    const first = await runTranslation(ctx, { type: 'translate', languages: ['te'] }, { confirmed: true, origin: 'user' });
    await first.done;
    await ctx.settled();

    const p = editionProgress(session.doc, 'te');
    const r = editionReadiness(session.doc, 'te');
    expect(i18nOf(session.doc).editions.te.lines.l1).toMatchObject({ status: 'machine', issue: { severity: 'major' } });
    // What LanguagesTab reads for the row: work = missing + stale + unreviewed → the button shows
    // "Finish the review" (p.missing and p.stale are 0) with the quote's price.
    const work = p.missing + p.stale + p.unreviewed;
    const quote = quoteTranslation(session.doc, ctx.keys, { languages: ['te'] });
    const q = quote.perLanguage[0];

    // Tap the button: the same translate action, quoted price.
    const llm2 = scriptedLlm({ translator: times(4, fakeTranslator().step), linguist: times(2, fakeLinguist()) });
    const ctx2 = testContext(session, { llm: llm2 });
    const again = await runTranslation(ctx2, { type: 'translate', languages: ['te'], quotedUsd: q.usd }, { confirmed: true, origin: 'user' });
    await again.done;
    await ctx2.settled();
    const after = editionProgress(session.doc, 'te');

    process.stderr.write(
      `probe translation.1 ${JSON.stringify({ work, unreviewed: p.unreviewed, flagged: p.flagged, blocking: r.issues.filter((i) => i.blocking).map((i) => i.text), quote: q, planFree: quote.plans.every(planIsFree), rerunMessage: again.outcome.message, rerunLlmCalls: llm2.calls.length, afterUnreviewed: after.unreviewed })}\n`
    );
    expect(work).toBeGreaterThan(0); // the button IS rendered
    // Expected: a rendered "Finish the review" button does something — a priced review or no button.
    const buttonIsHonest = q.usd > 0 || q.lines > 0 || after.unreviewed === 0 || llm2.calls.length > 0;
    expect(buttonIsHonest).toBe(true);
  });
});
