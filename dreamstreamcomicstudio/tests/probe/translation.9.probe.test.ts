// @vitest-environment node
// Probe: an author-edited translation whose SOURCE line later changed (derived status 'stale_edited').
// Readiness blocks publishing ("1 line changed since translating"), but nothing in the product can
// clear it for an Easy user:
//  - LanguagesTab EditionRow: work = missing + stale + unreviewed (staleEdited excluded) → no button;
//  - planTranslation path 2/7 skips edited lines (skippedEdited) → "Translate missing" would do nothing
//    (and the UI never sends overwriteEdits);
//  - TranslationReview commit(): `if (!v || v === saved) return` → re-saving the same wording is a no-op,
//    and "Mark reviewed" is only rendered for status 'machine'; accept_translation_issue refuses stale lines.
// The known-issues entry ("edit the line yourself or use Translate missing") does not cover this.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComicDoc } from '../../shared/comic/doc.js';
import { editionProgress, editionReadiness, i18nOf, lineSourceHash, translationStatus } from '../../shared/comic/i18n.js';
import { applyOps } from '../../shared/comic/ops.js';
import { planTranslation } from '../../shared/comic/translationPlan.js';
import { JOB_TIMINGS, startAction } from '../../server/src/comic/jobs.js';
import { KEYS, newSession, testContext } from '../../server/src/comic/orchestrator.fakes.js';
import { quoteTranslation } from '../../server/src/comic/i18n/index.js';
import { sixPageKidsDoc } from '../../server/src/comic/i18n/testing.js';

beforeEach(() => {
  JOB_TIMINGS.retryBackoffMs = 0;
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

const lines = (doc: ComicDoc) => doc.pages.flatMap((p) => p.panels.flatMap((pn) => pn.lines));

describe('a stale_edited line', () => {
  it('has a way back to "current" without changing the wording', async () => {
    let doc = applyOps(sixPageKidsDoc(), [{ op: 'edition', lang: 'te', patch: {} }]);
    const out: Record<string, { text: string; status: 'reviewed' | 'edited'; sourceHash: string; at: number }> = {};
    for (const l of lines(doc)) out[l.id] = { text: `తెలుగు ${l.id}`, status: 'reviewed', sourceHash: lineSourceHash(l), at: 1 };
    out.l1 = { text: 'చంద్రుడు ఎటు పోయాడు?', status: 'edited', sourceHash: lineSourceHash(lines(doc)[0]), at: 1 };
    doc = applyOps(doc, [{ op: 'translations', lang: 'te', lines: out }]);
    expect(editionReadiness(doc, 'te').publishable).toBe(true);
    // The author fixes the English line (a real word change, not punctuation): the edit is still right.
    doc = applyOps(doc, [{ op: 'line', pageId: 'pg_1', panelId: 'pn_1', id: 'l1', patch: { text: 'Where did our moon go?' } }]);
    const l1 = lines(doc)[0];
    const status = translationStatus(doc, 'te', l1);
    const p = editionProgress(doc, 'te');
    const r = editionReadiness(doc, 'te');
    const plan = planTranslation(doc, 'te');
    const quote = quoteTranslation(doc, KEYS, { languages: ['te'] });
    const rowWork = p.missing + p.stale + p.unreviewed; // LanguagesTab.tsx EditionRow

    // Every free action the UI exposes for a translated line:
    const session = newSession(doc);
    const accept = await startAction(testContext(session), { type: 'accept_translation_issue', lang: 'te', lineId: 'l1', useSuggestion: false }, { confirmed: true, origin: 'user' });
    const sameTextSave = 'చంద్రుడు ఎటు పోయాడు?' === i18nOf(doc).editions.te.lines.l1.text; // TranslationReview commit(): no-op when unchanged
    process.stderr.write(`probe translation.9 ${JSON.stringify({ status, progress: p, blocking: r.issues.filter((i) => i.blocking).map((i) => i.text), rowWork, plan: { toTranslate: plan.toTranslate, skippedEdited: plan.skippedEdited, free: plan.freeLines }, quote: quote.perLanguage[0], accept: accept.outcome, sameTextSaveIsNoop: sameTextSave })}\n`);
    expect(status).toBe('stale_edited');
    expect(r.publishable).toBe(false);
    // Expected: some free path refreshes the author's wording against the new source.
    const wayOut = rowWork > 0 || plan.freeLines.some((f) => f.lineId === 'l1') || accept.outcome.status === 'done';
    expect(wayOut).toBe(true);
  });
});
