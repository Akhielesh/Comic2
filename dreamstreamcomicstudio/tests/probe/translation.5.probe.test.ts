// @vitest-environment node
// Probe: "Make the Telugu translation the original" (swap_source_language) promises "Every other
// translation stays current ($0)". Two things it does not keep:
//  (a) swapSourceOps renames every glossary term to its Telugu form (term 'మైలో', forms {en:'Milo', hi:…}),
//      but cast names stay 'Milo'; the next translate run seeds the glossary (syncGlossaryOps, run
//      first in runTranslation) and sees cur.term !== cast name → it patches the term back to 'Milo'
//      and CLEARS every language's form (en, hi, …). The forms the user paid for (and typed) are gone.
//  (b) swapSourceOps re-hashes the other editions' LINES to the new source but not their cover/brief
//      texts, so the Hindi title/logline are stale after the swap and the next "Translate missing"
//      quotes (and charges) their re-translation.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComicDoc } from '../../shared/comic/doc.js';
import { editionProgress, i18nOf, lineSourceHash, textSourceHash } from '../../shared/comic/i18n.js';
import { applyOps } from '../../shared/comic/ops.js';
import { planTranslation, syncGlossaryOps } from '../../shared/comic/translationPlan.js';
// jobs.js first: the server's entry imports it before the action modules (actions/i18n.test.ts does too);
// importing actions/i18n.js first trips the registry's import cycle ("list is not iterable").
import { JOB_TIMINGS } from '../../server/src/comic/jobs.js';
import { KEYS } from '../../server/src/comic/orchestrator.fakes.js';
import { quoteTranslation } from '../../server/src/comic/i18n/index.js';
import { sixPageKidsDoc } from '../../server/src/comic/i18n/testing.js';
import { swapSourceOps } from '../../server/src/comic/actions/i18n.js';

void JOB_TIMINGS;

beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

const lines = (doc: ComicDoc) => doc.pages.flatMap((p) => p.panels.flatMap((pn) => pn.lines));
function translated(doc: ComicDoc, lang: string, word: string): ComicDoc {
  let d = applyOps(doc, [{ op: 'edition', lang, patch: {} }]);
  const out: Record<string, { text: string; status: 'reviewed'; sourceHash: string; at: number }> = {};
  for (const l of lines(d)) out[l.id] = { text: `${word} ${l.id}`, status: 'reviewed', sourceHash: lineSourceHash(l), at: 1 };
  d = applyOps(d, [{ op: 'translations', lang, lines: out }]);
  d = applyOps(d, [
    { op: 'edition_text', lang, field: 'brief.title', value: { text: `${word} title`, status: 'reviewed', sourceHash: textSourceHash(d.brief.title), at: 1 } },
    { op: 'edition_text', lang, field: 'brief.logline', value: { text: `${word} logline`, status: 'reviewed', sourceHash: textSourceHash(d.brief.logline || ''), at: 1 } }
  ]);
  return d;
}

describe('swap_source_language and what the next translate run does to it', () => {
  it('keeps the glossary forms and the other editions current (no paid work)', () => {
    let doc = translated(translated(sixPageKidsDoc(), 'te', 'తెలుగు'), 'hi', 'हिन्दी');
    // The glossary as a first translate run seeds it (cast + title), with the forms the runs coined.
    doc = applyOps(doc, syncGlossaryOps(doc));
    doc = applyOps(doc, [
      { op: 'glossary_term', id: 'gl_c_c_milo', patch: { forms: { te: 'మైలో', hi: 'माइलो' } } },
      { op: 'glossary_term', id: 'gl_c_c_frog', patch: { forms: { te: 'కప్ప', hi: 'मेंढक' } } }
    ]);
    const swapped = applyOps(doc, swapSourceOps(doc, 'te'));
    expect(swapped.format.language).toBe('te');
    const milo = i18nOf(swapped).glossary.find((g) => g.id === 'gl_c_c_milo');
    // What the NEXT translate run (e.g. "Add Tamil", or "Translate missing" for Hindi) commits first.
    const reseed = syncGlossaryOps(swapped);
    const reseeded = applyOps(swapped, reseed);
    const miloAfter = i18nOf(reseeded).glossary.find((g) => g.id === 'gl_c_c_milo');
    const hi = editionProgress(swapped, 'hi');
    const hiPlan = planTranslation(swapped, 'hi');
    const hiQuote = quoteTranslation(swapped, KEYS, { languages: ['hi'] });
    process.stderr.write(`probe translation.5 ${JSON.stringify({ castName: swapped.cast[0].name, miloAfterSwap: milo, reseedOps: reseed, miloAfterReseed: miloAfter, hiProgress: hi, hiCoverTexts: hiPlan.coverTexts, hiQuoteUsd: hiQuote.estimate.usd, hiUpToDate: hiQuote.perLanguage[0].upToDate })}\n`);
    // (a) Expected: the seed is idempotent after a swap — the forms survive.
    expect(miloAfter?.forms).toMatchObject({ en: 'Milo', hi: 'माइलो' });
    // (b) Expected: "every other translation stays current ($0)".
    expect(hiPlan.coverTexts).toEqual([]);
    expect(hiQuote.estimate.usd).toBe(0);
  });
});
