import { describe, expect, it } from 'vitest';
import { createEmptyDoc, emptyRender, type ComicDoc, type Line, type Page, type TextTranslation } from './doc';
import { editionProgress, editionReadiness, i18nOf, lineSourceHash, textSourceHash } from './i18n';
import { applyOps } from './ops';
import {
  AUTO_CORRECTED_NOTE,
  carryTrailingMark,
  editionTextSource,
  chunkTranslation,
  freeTranslationOps,
  glossaryRenameOps,
  localizePunctuation,
  planIsFree,
  planLineCount,
  planTranslation,
  replaceWholeToken,
  syncGlossaryOps,
  TRANSLATE_CHUNK_LINES,
  TRANSLATE_CHUNK_PAGES,
  translationBudget
} from './translationPlan';

const line = (id: string, text: string, patch: Partial<Line> = {}): Line => ({ id, kind: 'speech', speakerId: 'c_milo', text, ...patch });

/** Six pages, a few lines each: a duplicate, a punctuation line, a name-only line, an SFX, a noTranslate spell. */
function sixPages(): ComicDoc {
  const doc = createEmptyDoc('tp_six', 'Milo and the Moon', 1_792_670_000_000);
  doc.brief = { ...doc.brief, logline: 'A boy and his frog chase the moon.', audience: 'kids 4–8' };
  doc.cover = { ...doc.cover, title: 'Milo and the Moon' };
  doc.cast = [
    { id: 'c_milo', name: 'Milo', tier: 'lead', look: { summary: 'a boy' }, refs: [], sheet: emptyRender() },
    { id: 'c_frog', name: 'Frog', tier: 'support', kind: 'animal', look: { summary: 'a frog' }, refs: [], sheet: emptyRender() }
  ];
  const texts: Line[][] = [
    [line('l1', 'Where did the moon go?'), line('l2', 'Ribbit!', { speakerId: 'c_frog' })],
    [line('l3', 'Look, up there!'), line('l4', '...', { kind: 'caption', speakerId: undefined })],
    [line('l5', 'Ribbit!', { speakerId: 'c_frog' }), line('l6', 'SPLASH', { kind: 'sfx', speakerId: undefined })],
    [line('l7', 'Abracadoodle!', { noTranslate: true }), line('l8', 'MILO!', { speakerId: 'c_frog' })],
    [line('l9', 'We found it together.')],
    [line('l10', 'Goodnight, moon.'), line('l11', 'Goodnight, Milo.', { speakerId: 'c_frog' })]
  ];
  doc.pages = texts.map((lines, i): Page => ({
    id: `pg_${i + 1}`,
    n: i + 1,
    summary: `Beat ${i + 1}`,
    layout: 'Row 1: one wide panel.',
    panels: [{ id: `pn_${i + 1}`, n: 1, size: 'wide', shot: 'medium', action: 'Something happens.', castIds: ['c_milo'], lines }],
    render: emptyRender(),
    balloons: []
  }));
  return doc;
}

const lineOf = (doc: ComicDoc, id: string) => doc.pages.flatMap((p) => p.panels.flatMap((pn) => pn.lines)).find((l) => l.id === id)!;

/** Commit a translation for every queued line (what the translator + review would do). */
function translateAll(doc: ComicDoc, lang: string, status: TextTranslation['status'] = 'reviewed'): ComicDoc {
  const plan = planTranslation(doc, lang);
  let next = applyOps(doc, [{ op: 'edition', lang, patch: {} }]);
  next = applyOps(next, freeTranslationOps(next, plan));
  const lines: Record<string, TextTranslation> = {};
  for (const g of plan.toTranslate) for (const id of g.lineIds) lines[id] = { text: `[${lang}] ${lineOf(next, id).text}`, status, sourceHash: lineSourceHash(lineOf(next, id)), at: 1 };
  next = applyOps(next, [{ op: 'translations', lang, lines }]);
  for (const f of plan.coverTexts) next = applyOps(next, [{ op: 'edition_text', lang, field: f, value: { text: `[${lang}] title`, status, sourceHash: textSourceHash(editionTextSource(next, f)), at: 1 } }]);
  // duplicates of the fresh lines (deferred) are copied for free afterwards
  return applyOps(next, freeTranslationOps(next, planTranslation(next, lang)));
}

describe('planTranslation — the software-first paths', () => {
  it('is empty for the source language and unknown tags', () => {
    const doc = sixPages();
    expect(planTranslation(doc, 'en')).toMatchObject({ calls: 0, toTranslate: [], freeLines: [] });
    expect(planTranslation(doc, 'xx')).toMatchObject({ calls: 0, toTranslate: [] });
    expect(planTranslation(doc, 'TE')).toMatchObject({ calls: 0 }); // canonical spelling only
  });

  it('a first plan: free lines are free, duplicates wait for their twin, the rest goes to one call', () => {
    const doc = sixPages();
    const plan = planTranslation(doc, 'te');
    const free = Object.fromEntries(plan.freeLines.map((f) => [f.lineId, f.reason]));
    expect(free).toEqual({ l4: 'punctuation', l7: 'no_translate' });
    expect(plan.deferred).toEqual([{ lineId: 'l5', sameAs: 'l2' }]);
    expect(plan.toTranslate.map((g) => g.pageId)).toEqual(['pg_1', 'pg_2', 'pg_3', 'pg_4', 'pg_5', 'pg_6']);
    expect(planLineCount(plan)).toBe(8);
    expect(plan.coverTexts).toEqual(['brief.title', 'brief.logline', 'cover.title']);
    expect(plan.calls).toBe(2); // 6 pages → two 3-page chunks (titles ride in the first)
    expect(plan.reviewCalls).toBe(1);
    expect(plan.tokens.input).toBeGreaterThan(1450);
    expect(plan.tokens.output).toBeGreaterThan(0);
    expect(plan.tokens.reviewInput).toBeGreaterThan(900);
    expect(planIsFree(plan)).toBe(false);
  });

  it('cache hit: after a commit the second plan has 0 lines, 0 calls and 0 tokens', () => {
    const done = translateAll(sixPages(), 'te');
    const again = planTranslation(done, 'te');
    expect(again).toMatchObject({ toTranslate: [], freeLines: [], calls: 0, coverTexts: [], tokens: { input: 0, output: 0, reviewInput: 0, reviewOutput: 0 } });
    expect(again.upToDate).toBe(11 - 0); // every non-empty line
    expect(planIsFree(again)).toBe(true);
    const p = editionProgress(done, 'te');
    expect(p).toMatchObject({ missing: 0, stale: 0, unreviewed: 0 });
    expect(editionReadiness(done, 'te').publishable).toBe(true);
  });

  it('miss: only the changed line is re-translated, with its old text available', () => {
    let doc = translateAll(sixPages(), 'te');
    doc = applyOps(doc, [{ op: 'line', pageId: 'pg_5', panelId: 'pn_5', id: 'l9', patch: { text: 'We found the moon together.' } }]);
    const plan = planTranslation(doc, 'te');
    expect(plan.toTranslate).toEqual([{ pageId: 'pg_5', lineIds: ['l9'] }]);
    expect(plan.calls).toBe(1);
    expect(plan.upToDate).toBe(10);
  });

  it('loose match: a punctuation/case-only change is carried over for free (trailing ? applied)', () => {
    let doc = translateAll(sixPages(), 'te');
    doc = applyOps(doc, [{ op: 'line', pageId: 'pg_6', panelId: 'pn_6', id: 'l10', patch: { text: 'goodnight, moon?' } }]);
    const plan = planTranslation(doc, 'te');
    expect(plan.freeLines).toEqual([{ lineId: 'l10', text: '[te] Goodnight, moon?', reason: 'loose_match' }]);
    expect(plan.calls).toBe(0);
    const next = applyOps(doc, freeTranslationOps(doc, plan));
    expect(i18nOf(next).editions.te.lines.l10).toMatchObject({ text: '[te] Goodnight, moon?', status: 'reviewed', sourceHash: lineSourceHash(lineOf(next, 'l10')) });
  });

  it('human edits are never overwritten (stale_edited) unless overwriteEdits; a punctuation change keeps them current', () => {
    let doc = translateAll(sixPages(), 'te');
    doc = applyOps(doc, [{ op: 'translation', lang: 'te', lineId: 'l1', patch: { text: 'మా చంద్రుడు ఎక్కడ?', status: 'edited' } }]);
    doc = applyOps(doc, [{ op: 'line', pageId: 'pg_1', panelId: 'pn_1', id: 'l1', patch: { text: 'Where did the big moon go?' } }]);
    const plan = planTranslation(doc, 'te');
    expect(plan.skippedEdited).toBe(1);
    expect(planLineCount(plan)).toBe(0);
    expect(planLineCount(planTranslation(doc, 'te', { overwriteEdits: true }))).toBe(1);
    // punctuation-only source change on an edited line → hash refreshed, author's text kept
    let doc2 = translateAll(sixPages(), 'te');
    doc2 = applyOps(doc2, [{ op: 'translation', lang: 'te', lineId: 'l3', patch: { text: 'అదిగో, పైన!', status: 'edited' } }]);
    doc2 = applyOps(doc2, [{ op: 'line', pageId: 'pg_2', panelId: 'pn_2', id: 'l3', patch: { text: 'Look, up there!!' } }]);
    const p2 = planTranslation(doc2, 'te');
    expect(p2.freeLines).toEqual([{ lineId: 'l3', text: 'అదిగో, పైన!', reason: 'loose_match' }]);
    const after = applyOps(doc2, freeTranslationOps(doc2, p2));
    expect(i18nOf(after).editions.te.lines.l3).toMatchObject({ text: 'అదిగో, పైన!', status: 'edited' });
  });

  it('duplicates reuse a current translation in the edition, inheriting its review and gloss', () => {
    let doc = sixPages();
    doc = applyOps(doc, [{ op: 'edition', lang: 'hi', patch: {} }]);
    doc = applyOps(doc, [{ op: 'translations', lang: 'hi', lines: { l2: { text: 'टर्र!', status: 'reviewed', gloss: 'Croak!', sourceHash: lineSourceHash(lineOf(doc, 'l2')), at: 1 } } }]);
    const plan = planTranslation(doc, 'hi');
    expect(plan.freeLines).toContainEqual({ lineId: 'l5', text: 'टर्र!', reason: 'duplicate' });
    const next = applyOps(doc, freeTranslationOps(doc, plan));
    expect(i18nOf(next).editions.hi.lines.l5).toMatchObject({ text: 'टर्र!', status: 'reviewed', gloss: 'Croak!' });
  });

  it('glossary-only lines use the form with localized punctuation', () => {
    let doc = sixPages();
    doc = applyOps(doc, syncGlossaryOps(doc));
    doc = applyOps(doc, [{ op: 'glossary_term', id: 'gl_c_c_milo', patch: { forms: { te: 'మైలో', ja: 'マイロ' } } }]);
    expect(planTranslation(doc, 'te').freeLines).toContainEqual({ lineId: 'l8', text: 'మైలో!', reason: 'glossary_only' });
    expect(planTranslation(doc, 'ja').freeLines).toContainEqual({ lineId: 'l8', text: 'マイロ！', reason: 'glossary_only' });
    expect(planTranslation(doc, 'ja').freeLines).toContainEqual({ lineId: 'l4', text: '…', reason: 'punctuation' });
  });

  it('force re-translates current lines but never edited ones; pageIds scopes the plan (no titles)', () => {
    let doc = translateAll(sixPages(), 'te');
    doc = applyOps(doc, [{ op: 'translation', lang: 'te', lineId: 'l9', patch: { text: 'కలిసి కనుక్కున్నాం.', status: 'edited' } }]);
    const forced = planTranslation(doc, 'te', { force: true });
    expect(forced.toTranslate.flatMap((g) => g.lineIds)).not.toContain('l9');
    expect(forced.skippedEdited).toBe(1);
    expect(planLineCount(forced)).toBeGreaterThan(5);
    const scoped = planTranslation(sixPages(), 'te', { pageIds: ['pg_2'] });
    expect(scoped.toTranslate).toEqual([{ pageId: 'pg_2', lineIds: ['l3'] }]);
    expect(scoped.coverTexts).toEqual([]);
  });

  it('machine lines that missed their review are re-reviewed only (review tokens, no translator call)', () => {
    const doc = translateAll(sixPages(), 'te', 'machine');
    const plan = planTranslation(doc, 'te');
    expect(plan.calls).toBe(0);
    expect(plan.toReview!.length).toBeGreaterThan(5);
    expect(plan.tokens.input).toBe(0);
    expect(plan.tokens.reviewInput).toBeGreaterThan(0);
    expect(planIsFree(plan)).toBe(false);
    // A line the review flagged MAJOR (no suggestion) was judged — it waits for the author, not for another
    // review: the plan for an edition whose only open work is such lines is free and up to date.
    const flagged = applyOps(translateAll(sixPages(), 'te'), [{ op: 'translation', lang: 'te', lineId: 'l1', patch: { status: 'machine', issue: { severity: 'major', note: 'Wrong meaning.' } } }]);
    expect(planTranslation(flagged, 'te').toReview).toEqual([]);
    expect(editionProgress(flagged, 'te')).toMatchObject({ unreviewed: 0, flagged: 1 });
    // …while a machine line with only a minor note is reviewed again (the same rule as editionProgress.unreviewed).
    const minor = applyOps(translateAll(sixPages(), 'te'), [{ op: 'translation', lang: 'te', lineId: 'l1', patch: { status: 'machine', issue: { severity: 'minor', note: 'Stiff.' } } }]);
    expect(planTranslation(minor, 'te').toReview).toEqual(['l1']);
    expect(editionProgress(minor, 'te').unreviewed).toBe(1);
  });

  it('token estimates are monotonic in lines and in the tokenFactor', () => {
    const doc = sixPages();
    const hi = planTranslation(doc, 'hi');
    const te = planTranslation(doc, 'te');
    expect(te.tokens.output).toBeGreaterThan(hi.tokens.output); // Telugu 3.2 vs Hindi 2.2
    expect(te.tokens.input).toBe(hi.tokens.input); // same source
    const fewer = planTranslation(doc, 'te', { pageIds: ['pg_1'] });
    expect(fewer.tokens.output).toBeLessThan(te.tokens.output);
    expect(fewer.tokens.reviewInput).toBeLessThan(te.tokens.reviewInput);
  });
});

describe('chunking, budget and punctuation', () => {
  it('chunks hold ≤ 40 lines and ≤ 3 pages, split on page boundaries', () => {
    const groups = Array.from({ length: 7 }, (_, i) => ({ pageId: `p${i}`, lineIds: Array.from({ length: 15 }, (_, k) => `p${i}_l${k}`) }));
    const chunks = chunkTranslation(groups);
    for (const c of chunks) {
      expect(c.reduce((n, g) => n + g.lineIds.length, 0)).toBeLessThanOrEqual(TRANSLATE_CHUNK_LINES);
      expect(c.length).toBeLessThanOrEqual(TRANSLATE_CHUNK_PAGES);
    }
    expect(chunks.flat().flatMap((g) => g.lineIds)).toHaveLength(105);
    // a page longer than one chunk is split
    expect(chunkTranslation([{ pageId: 'big', lineIds: Array.from({ length: 70 }, (_, k) => `b${k}`) }])).toHaveLength(2);
  });

  it('translationBudget: SFX ×1.3, pinned balloons are tighter, wide scripts get fewer graphemes, minimum 6', () => {
    const doc = sixPages();
    const page = doc.pages[0];
    const l = { ...page.panels[0].lines[0], text: 'Where did the moon go, my friend? Up there!' };
    const sfx: Line = { id: 's', kind: 'sfx', text: 'SPLASH' };
    expect(translationBudget(doc, page, sfx, 'te')).toBe(8);
    const free = translationBudget(doc, { ...page, balloons: [{ lineId: l.id, x: 0.1, y: 0.1, w: 0.3 }] }, l, 'es');
    const pinned = translationBudget(doc, { ...page, balloons: [{ lineId: l.id, x: 0.1, y: 0.1, w: 0.3, pinned: true }] }, l, 'es');
    expect(pinned).toBeLessThan(free);
    expect(translationBudget(doc, page, l, 'ja')).toBeLessThan(translationBudget(doc, page, l, 'es'));
    expect(translationBudget(doc, page, { ...l, text: 'Hi' }, 'ja')).toBeGreaterThanOrEqual(6);
  });

  it('punctuation localizes for CJK and Arabic script; trailing marks carry over', () => {
    expect(localizePunctuation('?!', 'ja')).toBe('？！');
    expect(localizePunctuation('...', 'zh-Hans')).toBe('…');
    expect(localizePunctuation('?', 'ar')).toBe('؟');
    expect(localizePunctuation('?!', 'es')).toBe('?!');
    expect(carryTrailingMark('చంద్రుడు ఎక్కడ!', 'Where!', 'Where?', 'te')).toBe('చంద్రుడు ఎక్కడ?');
    expect(carryTrailingMark('月はどこ！', 'Where!', 'Where?', 'ja')).toBe('月はどこ？');
    expect(AUTO_CORRECTED_NOTE).toMatch(/review/);
  });
});

describe('glossary', () => {
  it('syncGlossaryOps is idempotent; people transliterate, animals and titles translate; a rename clears old forms', () => {
    let doc = sixPages();
    const ops = syncGlossaryOps(doc);
    doc = applyOps(doc, ops);
    const g = i18nOf(doc).glossary;
    expect(g.find((t) => t.refId === 'c_milo')).toMatchObject({ term: 'Milo', policy: 'transliterate', kind: 'character' });
    expect(g.find((t) => t.refId === 'c_frog')).toMatchObject({ term: 'Frog', policy: 'translate' });
    expect(g.find((t) => t.kind === 'title')).toMatchObject({ term: 'Milo and the Moon', policy: 'translate' });
    expect(syncGlossaryOps(doc)).toEqual([]);
    doc = applyOps(doc, [{ op: 'glossary_term', id: 'gl_c_c_milo', patch: { forms: { te: 'మైలో' } } }]);
    doc = applyOps(doc, [{ op: 'character', id: 'c_milo', patch: { name: 'Mili' } }]);
    doc = applyOps(doc, syncGlossaryOps(doc));
    expect(i18nOf(doc).glossary.find((t) => t.id === 'gl_c_c_milo')).toMatchObject({ term: 'Mili', forms: {} });
  });

  it('glossaryRenameOps replaces whole tokens only and updates the form ($0)', () => {
    let doc = sixPages();
    doc = applyOps(doc, syncGlossaryOps(doc));
    doc = applyOps(doc, [{ op: 'edition', lang: 'te', patch: {} }]);
    const h = (id: string) => lineSourceHash(lineOf(doc, id));
    doc = applyOps(doc, [
      {
        op: 'translations',
        lang: 'te',
        lines: {
          l10: { text: 'శుభరాత్రి, మైలో.', status: 'reviewed', sourceHash: h('l10'), at: 1 },
          l11: { text: 'మైలోకి శుభరాత్రి.', status: 'reviewed', sourceHash: h('l11'), at: 1 }
        }
      }
    ]);
    const ops = glossaryRenameOps(doc, 'te', 'gl_c_c_milo', 'మైలో', 'మిలో');
    const next = applyOps(doc, ops);
    expect(i18nOf(next).editions.te.lines.l10.text).toBe('శుభరాత్రి, మిలో.');
    expect(i18nOf(next).editions.te.lines.l11.text).toBe('మైలోకి శుభరాత్రి.'); // inside a longer word: untouched
    expect(i18nOf(next).glossary.find((t) => t.id === 'gl_c_c_milo')?.forms.te).toBe('మిలో');
    expect(replaceWholeToken('Milo, Milokan and milo', 'Milo', 'Mo')).toBe('Mo, Milokan and milo');
  });
});

describe('freeTranslationOps', () => {
  it('creates the edition when missing and commits only the free lines', () => {
    const doc = sixPages();
    const plan = planTranslation(doc, 'ta');
    const ops = freeTranslationOps(doc, plan);
    expect(ops[0]).toEqual({ op: 'edition', lang: 'ta', patch: {} });
    const next = applyOps(doc, ops);
    expect(Object.keys(i18nOf(next).editions.ta.lines).sort()).toEqual(['l4', 'l7']);
    expect(i18nOf(next).editions.ta.lines.l4).toMatchObject({ status: 'reviewed', text: '…' });
    expect(freeTranslationOps(doc, { ...plan, freeLines: [] })).toEqual([]);
  });
});
