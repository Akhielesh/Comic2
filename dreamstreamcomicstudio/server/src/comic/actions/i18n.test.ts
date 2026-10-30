// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComicDoc } from '../../../../shared/comic/doc.js';
import { editionProgress, editionReadiness, i18nOf, lineSourceHash, textSourceHash } from '../../../../shared/comic/i18n.js';
import { applyOps } from '../../../../shared/comic/ops.js';
import { AUTO_CORRECTED_NOTE } from '../../../../shared/comic/translationPlan.js';
import { DEFAULT_CAPS, type StudioCaps } from '../../../../shared/comic/capabilities.js';
import { startAction } from '../jobs.js';
import { KEYS, newSession, testContext } from '../orchestrator.fakes.js';
import { quoteTranslation } from '../i18n/index.js';
import { sixPageKidsDoc } from '../i18n/testing.js';
import { planTranslation, syncGlossaryOps } from '../../../../shared/comic/translationPlan.js';
import { actionHandlerFor } from './index.js';
import { I18N_ACTIONS, swapSourceOps } from './i18n.js';

beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

const lines = (doc: ComicDoc) => doc.pages.flatMap((p) => p.panels.flatMap((pn) => pn.lines));
function translated(doc = sixPageKidsDoc(), lang = 'te'): ComicDoc {
  let d = applyOps(doc, [{ op: 'edition', lang, patch: {} }]);
  const out: Record<string, { text: string; status: 'reviewed'; sourceHash: string; at: number }> = {};
  for (const l of lines(d)) out[l.id] = { text: `${lang}:${l.id}`, status: 'reviewed', sourceHash: lineSourceHash(l), at: 1 };
  d = applyOps(d, [{ op: 'translations', lang, lines: out }]);
  d = applyOps(d, [{ op: 'edition_text', lang, field: 'brief.title', value: { text: `${lang}:title`, status: 'reviewed', sourceHash: textSourceHash(d.brief.title), at: 1 } }]);
  return d;
}

describe('i18n actions registry', () => {
  it('registers translate (spend + estimate), swap_source_language and accept_translation_issue', () => {
    expect(I18N_ACTIONS.map((a) => [a.type, a.spend, !!a.estimate])).toEqual([
      ['translate', true, true],
      ['swap_source_language', false, false],
      ['accept_translation_issue', false, false]
    ]);
    for (const a of I18N_ACTIONS) expect(actionHandlerFor(a.type)).toBe(a);
  });
});

describe('swap_source_language', () => {
  it('a complete edition becomes the source for free; the old source becomes a reviewed edition; others stay current', async () => {
    const doc = translated(translated(), 'hi');
    const session = newSession(doc);
    const ctx = testContext(session);
    const out = await startAction(ctx, { type: 'swap_source_language', lang: 'te' }, { confirmed: true, origin: 'user' });
    expect(out.outcome.status).toBe('done');
    const d = session.doc;
    expect(d.format.language).toBe('te');
    expect(d.brief.title).toBe('te:title');
    expect(lines(d).find((l) => l.id === 'l1')?.text).toBe('te:l1');
    expect(i18nOf(d).editions.te).toBeUndefined();
    expect(i18nOf(d).editions.en.lines.l1).toMatchObject({ text: 'Where did the moon go?', status: 'reviewed' });
    expect(i18nOf(d).editions.en.brief?.title?.text).toBe('Milo and the Moon');
    expect(editionReadiness(d, 'en').publishable).toBe(true);
    expect(editionProgress(d, 'hi')).toMatchObject({ missing: 0, stale: 0 });
    expect(d.spend.totalUsd).toBe(0);
    expect(d.conversation[d.conversation.length - 1].text).toContain("is now the comic's language");
  });

  it('an incomplete edition is refused with a quoted "translate missing" chip', async () => {
    const doc = applyOps(translated(), [{ op: 'line', pageId: 'pg_1', panelId: 'pn_1', id: 'l1', patch: { text: 'Where is the moon tonight?' } }]);
    const session = newSession(doc);
    const out = await startAction(testContext(session), { type: 'swap_source_language', lang: 'te' }, { confirmed: true, origin: 'user' });
    expect(out.outcome).toMatchObject({ status: 'blocked', code: 'NOT_READY' });
    const last = session.doc.conversation[session.doc.conversation.length - 1];
    expect(last.text).toContain('1 line out of date');
    expect(last.nextSteps?.[0]).toMatchObject({ label: 'Translate missing lines', action: { type: 'translate', languages: ['te'] } });
    expect(session.doc.format.language).toBe('en');
  });

  it('swapSourceOps renames glossary terms both ways', () => {
    let doc = translated();
    doc = applyOps(doc, [{ op: 'glossary_term', id: 'g_milo', patch: { term: 'Milo', forms: { te: 'మైలో' } } }]);
    const next = applyOps(doc, swapSourceOps(doc, 'te'));
    expect(i18nOf(next).glossary.find((g) => g.id === 'g_milo')).toMatchObject({ term: 'మైలో', forms: { en: 'Milo' } });
  });

  it("after a swap the next run's glossary seed is a no-op (every form kept) and the other editions' titles stay current ($0)", () => {
    let doc = translated(translated(), 'hi');
    for (const lang of ['te', 'hi']) doc = applyOps(doc, [{ op: 'edition_text', lang, field: 'brief.logline', value: { text: `${lang}:logline`, status: 'reviewed', sourceHash: textSourceHash(doc.brief.logline || ''), at: 1 } }]);
    // The glossary as the first run seeds it (cast + title), with the forms the runs coined / the author typed.
    doc = applyOps(doc, syncGlossaryOps(doc));
    doc = applyOps(doc, [
      { op: 'glossary_term', id: 'gl_c_c_milo', patch: { forms: { te: 'మైలో', hi: 'माइलो' } } },
      { op: 'glossary_term', id: 'gl_c_c_frog', patch: { forms: { te: 'కప్ప', hi: 'मेंढक' } } }
    ]);
    const swapped = applyOps(doc, swapSourceOps(doc, 'te'));
    expect(swapped.format.language).toBe('te');
    // The cast takes its Telugu names (the comic is written in Telugu now), so the term and the name agree…
    expect(swapped.cast.map((c) => c.name)).toEqual(['మైలో', 'కప్ప']);
    expect(i18nOf(swapped).glossary.find((g) => g.id === 'gl_c_c_milo')).toMatchObject({ term: 'మైలో', forms: { en: 'Milo', hi: 'माइलो' } });
    // …and the title term follows the swapped title even without a stored Telugu form.
    expect(i18nOf(swapped).glossary.find((g) => g.id === 'gl_title')).toMatchObject({ term: 'te:title', forms: { en: 'Milo and the Moon' } });
    // (a) What the next translate run commits first. Without the fix: {term:'Milo', forms:{hi:null,en:null}} — every form wiped.
    expect(syncGlossaryOps(swapped)).toEqual([]);
    // (b) The Hindi title and logline were re-hashed like the lines. Without the fix: coverTexts = ['brief.title','brief.logline'], usd > 0.
    expect(planTranslation(swapped, 'hi').coverTexts).toEqual([]);
    expect(quoteTranslation(swapped, KEYS, { languages: ['hi'] })).toMatchObject({ estimate: { usd: 0 }, perLanguage: [{ upToDate: true, usd: 0 }] });
    expect(editionReadiness(swapped, 'hi').publishable).toBe(true);
    // The old source's edition carries the old names as its forms and reads as reviewed.
    expect(editionReadiness(swapped, 'en').publishable).toBe(true);
  });

  it('the title term is what brief.title becomes: a stored form worded differently does not win, and no translated title means no rename', () => {
    let doc = translated(translated(), 'hi');
    doc = applyOps(doc, syncGlossaryOps(doc));
    // A Telugu form coined by a run or typed in the glossary drawer that is NOT the edition's title text.
    doc = applyOps(doc, [{ op: 'glossary_term', id: 'gl_title', patch: { forms: { te: 'మైలో చంద్రుడు', hi: 'माइलो और चाँद' } } }]);
    const swapped = applyOps(doc, swapSourceOps(doc, 'te'));
    expect(swapped.brief.title).toBe('te:title');
    expect(i18nOf(swapped).glossary.find((g) => g.id === 'gl_title')).toMatchObject({ term: 'te:title', forms: { en: 'Milo and the Moon', hi: 'माइलो और चाँद' } });
    // Without the fix the term took the stored form ('మైలో చంద్రుడు') and the next run emitted
    // {term:'te:title', forms:{hi:null, en:null}} — every title form wiped.
    expect(syncGlossaryOps(swapped)).toEqual([]);

    // The edition has a title form but no translated brief.title: the title stays, and so does the term.
    const untitled = applyOps(doc, [{ op: 'edition_text', lang: 'te', field: 'brief.title', value: null }]);
    const kept = applyOps(untitled, swapSourceOps(untitled, 'te'));
    expect(kept.brief.title).toBe('Milo and the Moon');
    expect(i18nOf(kept).glossary.find((g) => g.id === 'gl_title')).toMatchObject({ term: 'Milo and the Moon', forms: { te: 'మైలో చంద్రుడు', hi: 'माइलो और चाँद' } });
    expect(syncGlossaryOps(kept)).toEqual([]);
  });
});

describe('accept_translation_issue', () => {
  it('"Use suggestion" applies it and clears the issue; "Looks right" marks reviewed; stale lines are refused', async () => {
    let doc = translated();
    const l1 = lines(doc)[0];
    doc = applyOps(doc, [
      { op: 'translation', lang: 'te', lineId: 'l1', patch: { status: 'reviewed', gloss: 'g', issue: { severity: 'minor', note: 'Stiff.', suggestion: 'చంద్రుడు ఎక్కడ?' } } },
      { op: 'translation', lang: 'te', lineId: 'l3', patch: { status: 'machine', issue: { severity: 'major', note: 'Wrong meaning.' } } },
      { op: 'translation', lang: 'te', lineId: 'l7', patch: { issue: { severity: 'minor', note: `${AUTO_CORRECTED_NOTE}: off`, suggestion: 'అసలు వాక్యం' } } }
    ]);
    expect(editionReadiness(doc, 'te').publishable).toBe(false);
    const session = newSession(doc);
    const ctx = testContext(session);
    await startAction(ctx, { type: 'accept_translation_issue', lang: 'te', lineId: 'l1', useSuggestion: true }, { confirmed: true, origin: 'user' });
    expect(i18nOf(session.doc).editions.te.lines.l1).toEqual({ text: 'చంద్రుడు ఎక్కడ?', status: 'reviewed', sourceHash: lineSourceHash(l1), at: expect.any(Number) });
    await startAction(ctx, { type: 'accept_translation_issue', lang: 'te', lineId: 'l3', useSuggestion: false }, { confirmed: true, origin: 'user' });
    expect(i18nOf(session.doc).editions.te.lines.l3).toMatchObject({ status: 'reviewed' });
    expect(i18nOf(session.doc).editions.te.lines.l3.issue).toBeUndefined();
    // reverting an auto-correction restores the original
    await startAction(ctx, { type: 'accept_translation_issue', lang: 'te', lineId: 'l7', useSuggestion: true }, { confirmed: true, origin: 'user' });
    expect(i18nOf(session.doc).editions.te.lines.l7.text).toBe('అసలు వాక్యం');
    expect(editionReadiness(session.doc, 'te').publishable).toBe(true);
    // no chat noise for inline review taps
    expect(session.doc.conversation).toHaveLength(doc.conversation.length);
    const stale = applyOps(session.doc, [{ op: 'line', pageId: 'pg_5', panelId: 'pn_5', id: 'l9', patch: { text: 'Found it!' } }]);
    const s2 = newSession(stale);
    const refused = await startAction(testContext(s2), { type: 'accept_translation_issue', lang: 'te', lineId: 'l9', useSuggestion: false }, { confirmed: true, origin: 'user' });
    expect(refused.outcome).toMatchObject({ status: 'blocked', code: 'CONFLICT' });
    const none = await startAction(testContext(s2), { type: 'accept_translation_issue', lang: 'te', lineId: 'l2', useSuggestion: true }, { confirmed: true, origin: 'user' });
    expect(none.outcome).toMatchObject({ status: 'blocked', code: 'NOT_FOUND' });
  });

  it('a stale_edited line: "Keep my wording" re-hashes the author\'s text for free (still theirs); a stale machine line is refused honestly', async () => {
    let doc = translated();
    doc = applyOps(doc, [{ op: 'translation', lang: 'te', lineId: 'l1', patch: { text: 'చంద్రుడు ఎటు పోయాడు?', status: 'edited' } }]);
    doc = applyOps(doc, [{ op: 'edition_text', lang: 'te', field: 'brief.title', value: { text: 'మైలో, చంద్రుడు', status: 'edited', sourceHash: textSourceHash(doc.brief.title), at: 1 } }]);
    // Real word changes to the originals (not punctuation): the edit is still right, but publishing is blocked.
    doc = applyOps(doc, [
      { op: 'line', pageId: 'pg_1', panelId: 'pn_1', id: 'l1', patch: { text: 'Where did our moon go?' } },
      { op: 'brief', patch: { title: 'Milo and the Big Moon' } }
    ]);
    expect(editionProgress(doc, 'te').staleEdited).toBe(1);
    expect(editionReadiness(doc, 'te').publishable).toBe(false);
    const session = newSession(doc);
    const ctx = testContext(session);
    const kept = await startAction(ctx, { type: 'accept_translation_issue', lang: 'te', lineId: 'l1', useSuggestion: false }, { confirmed: true, origin: 'user' });
    // Without the fix: blocked CONFLICT "translate it again first" — untrue, a run skips edited lines.
    expect(kept.outcome).toMatchObject({ status: 'done', message: 'Kept your wording for the changed line.' });
    const l1 = lines(session.doc).find((l) => l.id === 'l1')!;
    expect(i18nOf(session.doc).editions.te.lines.l1).toMatchObject({ text: 'చంద్రుడు ఎటు పోయాడు?', status: 'edited', sourceHash: lineSourceHash(l1) });
    const title = await startAction(ctx, { type: 'accept_translation_issue', lang: 'te', lineId: 'brief.title', useSuggestion: false }, { confirmed: true, origin: 'user' });
    expect(title.outcome.status).toBe('done');
    expect(i18nOf(session.doc).editions.te.brief?.title).toMatchObject({ text: 'మైలో, చంద్రుడు', status: 'edited', sourceHash: textSourceHash('Milo and the Big Moon') });
    expect(editionReadiness(session.doc, 'te').publishable).toBe(true);
    expect(session.doc.spend.totalUsd).toBe(0);
    expect(session.doc.conversation).toHaveLength(doc.conversation.length); // no chat noise
    // A stale MACHINE/reviewed line is still refused — naming the real way out, not "translate it again".
    const stale = applyOps(session.doc, [{ op: 'line', pageId: 'pg_5', panelId: 'pn_5', id: 'l9', patch: { text: 'Found it!' } }]);
    const refused = await startAction(testContext(newSession(stale)), { type: 'accept_translation_issue', lang: 'te', lineId: 'l9', useSuggestion: false }, { confirmed: true, origin: 'user' });
    expect(refused.outcome).toMatchObject({ status: 'blocked', code: 'CONFLICT' });
    expect(refused.outcome.message).toContain('"Translate missing" brings it up to date');
  });

  it('works for cover/brief texts too', async () => {
    let doc = translated();
    doc = applyOps(doc, [{ op: 'edition_text', lang: 'te', field: 'brief.title', value: { text: 'te:title', status: 'machine', sourceHash: textSourceHash(doc.brief.title), at: 1, issue: { severity: 'minor', note: 'n', suggestion: 'మైలో చంద్రుడు' } } }]);
    const session = newSession(doc);
    await startAction(testContext(session), { type: 'accept_translation_issue', lang: 'te', lineId: 'brief.title', useSuggestion: true }, { confirmed: true, origin: 'user' });
    expect(i18nOf(session.doc).editions.te.brief?.title).toMatchObject({ text: 'మైలో చంద్రుడు', status: 'reviewed' });
  });
});

describe('prices are worded for the user (governed users never read dollars)', () => {
  const governed: StudioCaps = { ...DEFAULT_CAPS, usage: { governed: true, pctLeft: 90, exhausted: false, pctPerStandardPage: 5 } };
  const noEdition = () => sixPageKidsDoc();
  const lastMsg = (doc: ComicDoc) => doc.conversation[doc.conversation.length - 1];

  it('"Translate it first" quotes a share of the usage in the message, its card and the outcome', async () => {
    const session = newSession(noEdition());
    const out = await startAction(testContext(session, { caps: governed }), { type: 'swap_source_language', lang: 'te' }, { confirmed: true, origin: 'user' });
    expect(out.outcome).toMatchObject({ status: 'blocked', code: 'NOT_READY', message: expect.stringMatching(/Translate it first \((?:≈[\d.]+|<0\.1)% of your usage\)/) });
    const msg = lastMsg(session.doc);
    expect(msg.text).toMatch(/Translate it first \((?:≈[\d.]+|<0\.1)% of your usage\)/);
    expect(JSON.stringify(msg)).not.toMatch(/\$\d/);
    expect(msg.nextSteps?.[0]).toMatchObject({ label: 'Translate into Telugu', action: { type: 'translate', languages: ['te'] } });
  });

  it('caps on the action options win over the context (a director turn passes them explicitly)', async () => {
    const session = newSession(noEdition());
    const collected: string[] = [];
    const out = await startAction(testContext(session), { type: 'swap_source_language', lang: 'te' }, {
      confirmed: false,
      caps: governed,
      origin: 'director',
      collectCard: (c) => collected.push(c.type === 'notice' ? c.text : '')
    });
    expect(out.outcome.message).toMatch(/% of your usage/);
    expect(collected.join(' ')).toMatch(/% of your usage/);
    expect(collected.join(' ')).not.toMatch(/\$/);
  });

  it('an admin (or own key) still reads dollars; a free swap reads "free" for a governed user', async () => {
    const admin = newSession(noEdition());
    await startAction(testContext(admin, { caps: { ...governed, admin: true } }), { type: 'swap_source_language', lang: 'te' }, { confirmed: true, origin: 'user' });
    expect(lastMsg(admin.doc).text).toMatch(/Translate it first \(≈ \$\d/);
    const session = newSession(translated());
    await startAction(testContext(session, { caps: governed }), { type: 'swap_source_language', lang: 'te' }, { confirmed: true, origin: 'user' });
    expect(lastMsg(session.doc).text).toContain('Every other translation stays current (free).');
  });
});
