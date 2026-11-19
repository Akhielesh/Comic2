// STU-T0: the one list of translation problems per language (kind, address, fix), and the one action behind
// "Fix automatically". Pure and free: no model, no clock, no network.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { makeSampleDoc } from '../../components/comicstudio/board/__fixtures__/sampleDoc';
import { normalizeDoc, type ComicDoc, type Line, type TextTranslation, type TranslationFailure } from './doc';
import { i18nOf, lineSourceHash, textSourceHash, translationStatus } from './i18n';
import { applyOps, type DocOp } from './ops';
import {
  CONTENT_CHECK_NOTES,
  fixPlanFor,
  I18N_FIX_STAGE,
  lineRefOf,
  translationProblems,
  whereText,
  type LineRef,
  type TranslationProblem
} from './translationProblems';

const here = dirname(fileURLToPath(import.meta.url));
const allLines = (doc: ComicDoc): Line[] => doc.pages.flatMap((p) => p.panels.flatMap((pn) => pn.lines));
const lineOf = (doc: ComicDoc, id: string): Line => allLines(doc).find((l) => l.id === id)!;

/** Sample doc (6 pages × 5 lines, overlay), Telugu edition with every line and the title reviewed. */
const reviewedTelugu = (): ComicDoc => {
  const doc = normalizeDoc(makeSampleDoc());
  const lines: Record<string, TextTranslation> = {};
  for (const l of allLines(doc)) lines[l.id] = { text: `TE:${l.text}`, status: 'reviewed', sourceHash: lineSourceHash(l), at: 1 };
  const ops: DocOp[] = [{ op: 'edition', lang: 'te', patch: {} }, { op: 'translations', lang: 'te', lines }];
  for (const field of ['brief.title', 'brief.logline'] as const) {
    const source = field === 'brief.title' ? doc.brief.title : doc.brief.logline;
    ops.push({ op: 'edition_text', lang: 'te', field, value: { text: `TE:${source}`, status: 'reviewed', sourceHash: textSourceHash(source), at: 1 } });
  }
  return applyOps(doc, ops, 1);
};

/** A failure record on the CURRENT source of a line (or with an explicit, older hash). */
const failure = (doc: ComicDoc, lineId: string, reason: TranslationFailure['reason'], sourceHash?: string): TranslationFailure => ({
  reason,
  sourceHash: sourceHash ?? lineSourceHash(lineOf(doc, lineId)),
  attempts: 1,
  at: 5
});

/** Every kind once, on its own line (page.panel.line of the sample: l1 = p1 line 1, l2 = p2 line 1, l3..l5 = p3 lines 1..3). */
const everyKind = (): ComicDoc => {
  let doc = reviewedTelugu();
  doc = applyOps(doc, [
    // missing: no translation, no failure
    { op: 'translation', lang: 'te', lineId: 'pg_1_l1', patch: null },
    // refused / timed out / provider error / empty: missing, with a failure on the current source
    { op: 'translation', lang: 'te', lineId: 'pg_1_l2', patch: null },
    { op: 'translation', lang: 'te', lineId: 'pg_1_l3', patch: null },
    { op: 'translation', lang: 'te', lineId: 'pg_1_l4', patch: null },
    { op: 'translation', lang: 'te', lineId: 'pg_1_l5', patch: null },
    // stale: the source changed after a reviewed translation
    { op: 'line', pageId: 'pg_2', panelId: 'pg_2_p1', id: 'pg_2_l1', patch: { text: 'Old Delhi. After the rain.' } },
    // stale_edited: the author's own words, and the source changed after them
    { op: 'translation', lang: 'te', lineId: 'pg_2_l2', patch: { text: 'ఇంకొక్కటే…', status: 'edited' } },
    { op: 'line', pageId: 'pg_2', panelId: 'pg_2_p2', id: 'pg_2_l2', patch: { text: 'Just one more tin…' } },
    // waiting: a machine line no reviewer judged
    { op: 'translation', lang: 'te', lineId: 'pg_3_l1', patch: { status: 'machine' } },
    // review_failed: a machine line whose review call failed (failure below)
    { op: 'translation', lang: 'te', lineId: 'pg_3_l2', patch: { status: 'machine' } },
    // flagged, fixable by another wording
    { op: 'translation', lang: 'te', lineId: 'pg_4_l1', patch: { status: 'machine', issue: { severity: 'major', note: 'Wrong meaning.' } } },
    // flagged by the content check: the creator decides
    { op: 'translation', lang: 'te', lineId: 'pg_4_l2', patch: { status: 'machine', issue: { severity: 'major', note: CONTENT_CHECK_NOTES[1] } } },
    // flagged on the author's own words: never re-translated over them
    { op: 'translation', lang: 'te', lineId: 'pg_4_l3', patch: { status: 'edited', issue: { severity: 'major', note: 'Wrong speaker gender.' } } },
    // a minor note on a reviewed line: never blocking
    { op: 'translation', lang: 'te', lineId: 'pg_5_l1', patch: { issue: { severity: 'minor', note: 'Could read more naturally.' } } },
    // the title is not translated yet
    { op: 'edition_text', lang: 'te', field: 'brief.logline', value: null }
  ]);
  const te = i18nOf(doc).editions.te;
  te.failures = {
    pg_1_l2: failure(doc, 'pg_1_l2', 'unsafe'),
    pg_1_l3: failure(doc, 'pg_1_l3', 'timeout'),
    pg_1_l4: failure(doc, 'pg_1_l4', 'provider'),
    pg_1_l5: failure(doc, 'pg_1_l5', 'empty'),
    pg_3_l2: failure(doc, 'pg_3_l2', 'provider')
  };
  return doc;
};

const summary = (problems: TranslationProblem[]) => problems.map((p) => [p.ref.lineId, p.kind, p.fix, p.blocking]);

describe('translationProblems: every kind, with its place and its fix', () => {
  it('names each problem once, titles first, then page → panel → line', () => {
    const problems = translationProblems(everyKind(), 'te');
    expect(summary(problems)).toEqual([
      ['brief.logline', 'missing', 'translate', false],
      ['pg_1_l1', 'missing', 'translate', true],
      ['pg_1_l2', 'refused', 'creator', true],
      ['pg_1_l3', 'timed_out', 'smaller_parts', true],
      ['pg_1_l4', 'provider_failed', 'translate', true],
      ['pg_1_l5', 'provider_failed', 'translate', true],
      ['pg_2_l1', 'stale', 'translate', true],
      ['pg_2_l2', 'stale_edited', 'creator', true],
      ['pg_3_l1', 'waiting', 'finish_review', true],
      ['pg_3_l2', 'review_failed', 'finish_review', true],
      ['pg_4_l1', 'flagged', 'redo', true],
      ['pg_4_l2', 'flagged', 'creator', true],
      ['pg_4_l3', 'flagged', 'creator', true],
      ['pg_5_l1', 'note', null, false]
    ]);
    for (const p of problems) expect(p.lang).toBe('te');
  });

  it('every ref carries page, panel and line (1-based in the panel), kind and speaker; titles carry their field', () => {
    const problems = translationProblems(everyKind(), 'te');
    const byId = new Map(problems.map((p) => [p.ref.lineId, p.ref] as const));
    expect(byId.get('pg_1_l1')).toEqual({ lineId: 'pg_1_l1', pageId: 'pg_1', page: 1, panel: 1, line: 1, kind: 'caption' });
    expect(byId.get('pg_1_l4')).toEqual({ lineId: 'pg_1_l4', pageId: 'pg_1', page: 1, panel: 3, line: 2, kind: 'speech', speakerId: 'ch_arjun' });
    expect(byId.get('pg_4_l3')).toMatchObject({ page: 4, panel: 3, line: 1, kind: 'shout', speakerId: 'ch_vendor' });
    expect(byId.get('brief.logline')).toEqual({ lineId: 'brief.logline', pageId: '', page: 0, panel: 0, line: 0, kind: 'caption', field: 'brief.logline' });
  });

  it('carries the stored review note for flagged and note problems only, and the failure reason for failures', () => {
    const problems = translationProblems(everyKind(), 'te');
    const get = (id: string) => problems.find((p) => p.ref.lineId === id)!;
    expect(get('pg_4_l1').note).toBe('Wrong meaning.');
    expect(get('pg_5_l1').note).toBe('Could read more naturally.');
    expect(get('pg_3_l1').note).toBeUndefined();
    expect(get('pg_1_l2')).toMatchObject({ reason: 'unsafe' });
    expect(get('pg_1_l5')).toMatchObject({ kind: 'provider_failed', reason: 'empty' });
    expect(get('pg_1_l1').reason).toBeUndefined();
  });

  it('a failure recorded for an older source is ignored: the line is plainly missing (or stale) again', () => {
    let doc = everyKind();
    const te = i18nOf(doc).editions.te;
    te.failures = { ...te.failures, pg_1_l2: failure(doc, 'pg_1_l2', 'unsafe', 'feedf00d') };
    expect(translationProblems(doc, 'te').find((p) => p.ref.lineId === 'pg_1_l2')).toMatchObject({ kind: 'missing', fix: 'translate' });
    // A changed source makes the stored failure old too.
    doc = applyOps(everyKind(), [{ op: 'line', pageId: 'pg_1', panelId: 'pg_1_p3', id: 'pg_1_l3', patch: { text: 'Stop, thief!' } }]);
    expect(translationProblems(doc, 'te').find((p) => p.ref.lineId === 'pg_1_l3')).toMatchObject({ kind: 'missing', fix: 'translate' });
    // A failure on a line whose translation is current and reviewed is no problem at all.
    const ok = reviewedTelugu();
    i18nOf(ok).editions.te.failures = { pg_6_l1: failure(ok, 'pg_6_l1', 'timeout') };
    expect(translationProblems(ok, 'te')).toEqual([]);
  });

  it('a stale line whose new wording was refused is refused, never offered for a blind retry', () => {
    let doc = applyOps(reviewedTelugu(), [{ op: 'line', pageId: 'pg_2', panelId: 'pg_2_p1', id: 'pg_2_l1', patch: { text: 'Old Delhi. After the rain.' } }]);
    i18nOf(doc).editions.te.failures = { pg_2_l1: failure(doc, 'pg_2_l1', 'unsafe') };
    expect(translationProblems(doc, 'te')).toEqual([expect.objectContaining({ kind: 'refused', fix: 'creator', blocking: true })]);
    expect(fixPlanFor(translationProblems(doc, 'te'))).toBeNull();
    doc = applyOps(doc, [{ op: 'line', pageId: 'pg_2', panelId: 'pg_2_p1', id: 'pg_2_l1', patch: { text: 'Old Delhi. After the storm.' } }]);
    expect(translationProblems(doc, 'te')).toEqual([expect.objectContaining({ kind: 'stale', fix: 'translate' })]);
  });

  it('nothing for the source language, nothing for a ready language; a language not added yet is all missing', () => {
    expect(translationProblems(everyKind(), 'en')).toEqual([]);
    expect(translationProblems(reviewedTelugu(), 'te')).toEqual([]);
    const fresh = normalizeDoc(makeSampleDoc());
    const hi = translationProblems(fresh, 'hi');
    expect(hi.filter((p) => !p.ref.field)).toHaveLength(30);
    expect(hi.every((p) => p.kind === 'missing' && p.fix === 'translate')).toBe(true);
    expect(hi.filter((p) => p.ref.field).map((p) => p.ref.field)).toEqual(['brief.title', 'brief.logline']);
  });

  it('counts agree with the editor progress: lines with no words or marked keep-as-is are never problems', () => {
    let doc = everyKind();
    doc = applyOps(doc, [
      { op: 'line', pageId: 'pg_6', panelId: 'pg_6_p1', id: 'pg_6_l1', patch: { noTranslate: true } },
      { op: 'translation', lang: 'te', lineId: 'pg_6_l1', patch: null }
    ]);
    const lines = translationProblems(doc, 'te').filter((p) => !p.ref.field);
    for (const p of lines) expect(translationStatus(doc, 'te', lineOf(doc, p.ref.lineId))).not.toBe('not_needed');
    expect(lines.some((p) => p.ref.lineId === 'pg_6_l1')).toBe(false);
  });

  it('never carries translation text (or the source words) in any problem', () => {
    const doc = everyKind();
    const words = [
      ...allLines(doc).map((l) => l.text),
      ...Object.values(i18nOf(doc).editions.te.lines).map((t) => t.text),
      doc.brief.title,
      doc.brief.logline
    ].filter((w) => w.length > 3);
    for (const p of translationProblems(doc, 'te')) {
      const s = JSON.stringify(p);
      for (const w of words) expect(s.includes(w), `${p.ref.lineId} carries "${w}"`).toBe(false);
    }
  });

  it('reading order is the review screen order: pages by n, panels by n, lines in array order (not array order of pages)', () => {
    const doc = everyKind();
    // Pages and panels stored out of order, as an old doc or a reorder can leave them.
    doc.pages = [doc.pages[3], doc.pages[0], doc.pages[5], doc.pages[1], doc.pages[4], doc.pages[2]];
    doc.pages[1] = { ...doc.pages[1], panels: [doc.pages[1].panels[2], doc.pages[1].panels[0], doc.pages[1].panels[1]] };
    // The rows TranslationReview builds (components/comicstudio/i18n/TranslationReview.tsx): the same walk.
    const rows: string[] = [];
    for (const page of [...doc.pages].sort((a, b) => a.n - b.n))
      for (const panel of [...page.panels].sort((a, b) => a.n - b.n))
        for (const line of panel.lines) if (translationStatus(doc, 'te', line) !== 'not_needed') rows.push(line.id);
    const ids = translationProblems(doc, 'te')
      .filter((p) => !p.ref.field)
      .map((p) => p.ref.lineId);
    expect(ids).toEqual(rows.filter((id) => ids.includes(id)));
    expect(ids.slice(0, 5)).toEqual(['pg_1_l1', 'pg_1_l2', 'pg_1_l3', 'pg_1_l4', 'pg_1_l5']);
  });
});

describe('lineRefOf and whereText', () => {
  it('lineRefOf finds a line on the live pages, a title field, or nothing', () => {
    const doc = normalizeDoc(makeSampleDoc());
    expect(lineRefOf(doc, 'pg_5_l5')).toEqual({ lineId: 'pg_5_l5', pageId: 'pg_5', page: 5, panel: 3, line: 3, kind: 'sfx' });
    expect(lineRefOf(doc, 'cover.title')).toMatchObject({ field: 'cover.title', page: 0 });
    expect(lineRefOf(doc, 'nope')).toBeUndefined();
    expect(lineRefOf(doc, 'constructor')).toBeUndefined();
  });

  it('names one place, two places, and folds the rest into a count (three or more are split by semicolons)', () => {
    const doc = normalizeDoc(makeSampleDoc());
    const ref = (id: string) => lineRefOf(doc, id) as LineRef;
    expect(whereText([ref('pg_4_l4')])).toBe('page 4, panel 3, line 2');
    expect(whereText([ref('pg_4_l4'), ref('pg_5_l1')])).toBe('page 4, panel 3, line 2 and page 5, panel 1, line 1');
    const five = ['pg_1_l1', 'pg_2_l2', 'pg_3_l3', 'pg_4_l4', 'pg_5_l5'].map(ref);
    expect(whereText(five)).toBe('page 1, panel 1, line 1; page 2, panel 2, line 1; page 3, panel 3, line 1 and 2 more');
    expect(whereText(five, 5)).toBe('page 1, panel 1, line 1; page 2, panel 2, line 1; page 3, panel 3, line 1; page 4, panel 3, line 2 and page 5, panel 3, line 3');
    expect(whereText(five, 1)).toBe('page 1, panel 1, line 1 and 4 more');
    expect(whereText([ref('brief.title'), ref('cover.tagline'), ref('pg_1_l1')])).toBe('the title; the cover tagline and page 1, panel 1, line 1');
    expect(whereText([ref('brief.title'), ref('brief.logline')])).toBe('the title and the logline');
    expect(whereText([])).toBe('');
  });
});

describe('fixPlanFor: the one action behind "Fix automatically"', () => {
  it('redoes flagged lines, translates the missing, finishes the review, in smaller parts after a time-out, and never retries a refused line', () => {
    const problems = translationProblems(everyKind(), 'te');
    const plan = fixPlanFor(problems)!;
    expect(plan.redo).toEqual(['pg_4_l1']);
    expect(plan.chunkLines).toBe(10);
    // A refused line is in the language: the plan names its scope so the refused line stays out of it.
    expect(plan.lineIds).toEqual(['brief.logline', 'pg_1_l1', 'pg_1_l3', 'pg_1_l4', 'pg_1_l5', 'pg_2_l1', 'pg_3_l1', 'pg_3_l2', 'pg_4_l1']);
    expect(plan.lineIds).not.toContain('pg_1_l2');
    // Creator-only problems (the author's words, the content check) are never in the action.
    for (const id of ['pg_2_l2', 'pg_4_l2', 'pg_4_l3', 'pg_5_l1']) {
      expect(plan.lineIds).not.toContain(id);
      expect(plan.redo).not.toContain(id);
    }
  });

  it('returns null when only refused lines (or other creator choices) remain', () => {
    let doc = reviewedTelugu();
    doc = applyOps(doc, [
      { op: 'translation', lang: 'te', lineId: 'pg_1_l2', patch: null },
      { op: 'translation', lang: 'te', lineId: 'pg_4_l3', patch: { status: 'edited', issue: { severity: 'major', note: 'Wrong speaker gender.' } } }
    ]);
    i18nOf(doc).editions.te.failures = { pg_1_l2: failure(doc, 'pg_1_l2', 'unsafe') };
    expect(translationProblems(doc, 'te').map((p) => p.kind)).toEqual(['refused', 'flagged']);
    expect(fixPlanFor(translationProblems(doc, 'te'))).toBeNull();
    expect(fixPlanFor([])).toBeNull();
  });

  it('non-blocking work alone (a title, a minor note) is no reason for a button', () => {
    const doc = applyOps(reviewedTelugu(), [
      { op: 'edition_text', lang: 'te', field: 'brief.title', value: null },
      { op: 'translation', lang: 'te', lineId: 'pg_1_l1', patch: { issue: { severity: 'minor', note: 'Stiff.' } } }
    ]);
    expect(translationProblems(doc, 'te').map((p) => p.kind)).toEqual(['missing', 'note']);
    expect(fixPlanFor(translationProblems(doc, 'te'))).toBeNull();
  });

  it('with nothing refused the action stays small: no scope, the whole-language plan does the same work', () => {
    const doc = applyOps(reviewedTelugu(), [
      { op: 'translation', lang: 'te', lineId: 'pg_1_l1', patch: null },
      { op: 'translation', lang: 'te', lineId: 'pg_2_l4', patch: { status: 'machine', issue: { severity: 'major', note: 'Wrong meaning.' } } },
      { op: 'translation', lang: 'te', lineId: 'pg_3_l4', patch: { status: 'machine' } }
    ]);
    expect(fixPlanFor(translationProblems(doc, 'te'))).toEqual({ redo: ['pg_2_l4'] });
    const onlyFlag = applyOps(reviewedTelugu(), [{ op: 'translation', lang: 'te', lineId: 'pg_2_l4', patch: { status: 'machine', issue: { severity: 'major', note: 'Wrong meaning.' } } }]);
    expect(fixPlanFor(translationProblems(onlyFlag, 'te'))).toEqual({ redo: ['pg_2_l4'] });
  });

  it('caps the scope and the redo list at 200 ids (DOC_LIMITS.translateLineIds), in reading order', () => {
    const ref = (i: number): LineRef => ({ lineId: `l${i}`, pageId: 'p', page: 1, panel: 1, line: i + 1, kind: 'speech' });
    const many: TranslationProblem[] = Array.from({ length: 250 }, (_, i) => ({ lang: 'te', kind: 'flagged', ref: ref(i), blocking: true, fix: 'redo' }));
    many.push({ lang: 'te', kind: 'refused', ref: ref(999), blocking: true, fix: 'creator' });
    const plan = fixPlanFor(many)!;
    expect(plan.redo).toHaveLength(200);
    expect(plan.lineIds).toHaveLength(200);
    expect(plan.redo[0]).toBe('l0');
    expect(plan.lineIds).not.toContain('l999');
  });

  it('only the first problem language is planned (one action per language)', () => {
    const hi = translationProblems(normalizeDoc(makeSampleDoc()), 'hi');
    const te = translationProblems(everyKind(), 'te');
    expect(fixPlanFor([...te, ...hi])).toEqual(fixPlanFor(te));
  });
});

describe('contract', () => {
  it('the stage flag defaults to all', () => {
    expect(I18N_FIX_STAGE).toBe('all');
  });

  it("the content-check notes are the translator's own words (server/src/comic/i18n/translate.ts)", () => {
    const src = readFileSync(join(here, '../../server/src/comic/i18n/translate.ts'), 'utf8');
    expect(CONTENT_CHECK_NOTES.length).toBeGreaterThan(0);
    for (const note of CONTENT_CHECK_NOTES) expect(src.includes(note), note).toBe(true);
  });
});
