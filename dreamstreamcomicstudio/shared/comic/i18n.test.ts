import { describe, expect, it } from 'vitest';
import { makeSampleDoc } from '../../components/comicstudio/board/__fixtures__/sampleDoc';
import { editionViewDoc } from '../../components/comicstudio/mobile/editor/editorModel';
import { normalizeDoc, type ComicDoc, type LanguageEdition, type Line, type TranslationFailure } from './doc';
import { applyOps, type DocOp } from './ops';
import {
  editionProgress,
  editionReadiness,
  fallbackLineIds,
  i18nOf,
  lineSourceHash,
  localizeDoc,
  looseSourceHash,
  normalizeI18n,
  normalizeSource,
  publicI18n,
  textSourceHash,
  translationStatus
} from './i18n';

const lines = (doc: ComicDoc): Line[] => doc.pages.flatMap((p) => p.panels.flatMap((pn) => pn.lines));

/** Sample doc (overlay), Hindi edition with every line translated + reviewed. */
const translated = (status: 'machine' | 'reviewed' | 'edited' = 'reviewed'): ComicDoc => {
  const doc = normalizeDoc(makeSampleDoc());
  const ops: DocOp[] = [{ op: 'edition', lang: 'hi', patch: {} }];
  const map: Record<string, { text: string; status: typeof status; sourceHash: string; at: number }> = {};
  for (const l of lines(doc)) map[l.id] = { text: `HI:${l.text}`, status, sourceHash: lineSourceHash(l), at: 1 };
  ops.push({ op: 'translations', lang: 'hi', lines: map });
  return applyOps(doc, ops, 1);
};

describe('source hashes', () => {
  it('normalizeSource keeps NBSP / U+202F glued and collapses ASCII whitespace only', () => {
    expect(normalizeSource('  Hello \n  world  ')).toBe('Hello world');
    expect(normalizeSource('Oui !')).toBe('Oui !');
    expect(normalizeSource(' x ')).toBe(' x ');
    expect(normalizeSource('é')).toBe('é');
  });
  it('line hashes depend on kind, speaker, text and noTranslate; loose hash ignores punctuation/case', () => {
    const l: Line = { id: 'a', kind: 'speech', text: 'Boom', speakerId: 'c' };
    expect(lineSourceHash(l)).toBe(lineSourceHash({ ...l, text: '  Boom ' }));
    expect(lineSourceHash(l)).not.toBe(lineSourceHash({ ...l, kind: 'sfx' }));
    expect(lineSourceHash(l)).not.toBe(lineSourceHash({ ...l, noTranslate: true }));
    expect(textSourceHash('a b')).toBe(textSourceHash('a  b'));
    expect(looseSourceHash('Hello, World!')).toBe(looseSourceHash('hello world'));
    expect(looseSourceHash('Hello')).not.toBe(looseSourceHash('Help'));
  });
});

describe('status, progress, readiness', () => {
  it('derives missing / stale / stale_edited / not_needed', () => {
    let doc = translated();
    const l1 = lines(doc)[0];
    expect(translationStatus(doc, 'hi', l1)).toBe('reviewed');
    expect(translationStatus(doc, 'en', l1)).toBe('not_needed');
    expect(translationStatus(doc, 'te', l1)).toBe('missing');
    doc = applyOps(doc, [{ op: 'line', pageId: 'pg_1', panelId: 'pg_1_p1', id: l1.id, patch: { text: 'Old Delhi. After the rain.' } }]);
    expect(translationStatus(doc, 'hi', lines(doc)[0])).toBe('stale');
    doc = applyOps(doc, [{ op: 'translation', lang: 'hi', lineId: l1.id, patch: { status: 'edited' } }]);
    expect(translationStatus(doc, 'hi', lines(doc)[0])).toBe('stale_edited');
    doc = applyOps(doc, [{ op: 'line', pageId: 'pg_1', panelId: 'pg_1_p1', id: l1.id, patch: { noTranslate: true } }]);
    expect(translationStatus(doc, 'hi', lines(doc)[0])).toBe('not_needed');
  });

  it('reviewed + overlay ⇒ publishable; unreviewed or in_art ⇒ not; overflow is a warning', () => {
    expect(editionReadiness(translated(), 'hi')).toEqual({ publishable: true, issues: [] });
    const machine = editionReadiness(translated('machine'), 'hi');
    expect(machine.publishable).toBe(false);
    expect(machine.issues.map((i) => i.code)).toEqual(['unreviewed']);
    const inArt = applyOps(translated(), [{ op: 'format', patch: { lettering: 'in_art' } }]);
    const r = editionReadiness(inArt, 'hi');
    expect(r.publishable).toBe(false);
    expect(r.issues.find((i) => i.code === 'in_art_pages')).toMatchObject({ blocking: true, count: 6 });
    const overflow = editionReadiness(translated(), 'hi', ['pg_1_l1']);
    expect(overflow.publishable).toBe(true);
    expect(overflow.issues).toEqual([expect.objectContaining({ code: 'overflow', blocking: false })]);
    const major = applyOps(translated(), [{ op: 'translation', lang: 'hi', lineId: 'pg_1_l1', patch: { issue: { severity: 'major', note: 'wrong meaning' } } }]);
    expect(editionReadiness(major, 'hi').issues.map((i) => i.code)).toEqual(['major_issue']);
    expect(editionReadiness(translated(), 'te')).toMatchObject({ publishable: false, issues: [{ code: 'missing' }] });
    expect(editionReadiness(translated(), 'en').publishable).toBe(true); // the source is always publishable
    const p = editionProgress(translated('machine'), 'hi');
    expect(p).toMatchObject({ total: 30, done: 30, unreviewed: 30, missing: 0, coverTitle: 'missing' });
  });

  it('a machine line the review flagged MAJOR was judged: counted once (flagged), never also "waiting for review"', () => {
    const flag = { op: 'translation', lang: 'hi', lineId: 'pg_1_l1', patch: { status: 'machine', issue: { severity: 'major', note: 'Wrong meaning.' } } } as const;
    // Everything else reviewed: the only open work is the flagged line.
    const one = applyOps(translated(), [flag]);
    expect(editionProgress(one, 'hi')).toMatchObject({ unreviewed: 0, flagged: 1, done: 30 });
    // Without the fix: issues = ['unreviewed', 'major_issue'] — the same line listed twice.
    expect(editionReadiness(one, 'hi').issues.map((i) => [i.code, i.count])).toEqual([['major_issue', 1]]);
    // Among unreviewed lines, the flagged one still leaves the others waiting.
    const many = applyOps(translated('machine'), [flag]);
    expect(editionProgress(many, 'hi')).toMatchObject({ unreviewed: 29, flagged: 1 });
    expect(editionReadiness(many, 'hi').issues.map((i) => [i.code, i.count])).toEqual([['unreviewed', 29], ['major_issue', 1]]);
    // A minor flag on a machine line is still waiting for a reviewer's verdict.
    const minor = applyOps(translated(), [{ op: 'translation', lang: 'hi', lineId: 'pg_1_l1', patch: { status: 'machine', issue: { severity: 'minor', note: 'Stiff.' } } }]);
    expect(editionProgress(minor, 'hi')).toMatchObject({ unreviewed: 1, flagged: 1 });
  });
});

describe('localizeDoc', () => {
  it('returns the doc itself for the source language or a missing edition', () => {
    const doc = translated();
    expect(localizeDoc(doc, 'en')).toBe(doc);
    expect(localizeDoc(doc, 'te')).toBe(doc);
  });
  it('swaps text, marks fallbacks, applies balloon overrides and titles', () => {
    let doc = translated();
    doc = applyOps(doc, [
      { op: 'translation', lang: 'hi', lineId: 'pg_1_l3', patch: null },
      { op: 'edition_balloon', lang: 'hi', lineId: 'pg_1_l2', patch: { x: 0.33, fontScale: 0.85 } },
      { op: 'edition_text', lang: 'hi', field: 'cover.title', value: { text: 'केसर चोर', status: 'edited', sourceHash: '', at: 1 } },
      { op: 'edition_text', lang: 'hi', field: 'brief.logline', value: { text: 'एक चोर…', status: 'reviewed', sourceHash: '', at: 1 } }
    ]);
    const hi = localizeDoc(doc, 'hi');
    expect(hi.format.language).toBe('hi');
    expect(hi.format.readingDirection).toBe(doc.format.readingDirection);
    expect(lines(hi)[0].text).toBe('HI:Old Delhi. Before the heat.');
    expect(lines(hi).find((l) => l.id === 'pg_1_l3')).toMatchObject({ text: 'Thief!', lang: 'en' });
    expect(fallbackLineIds(hi)).toEqual(['pg_1_l3']);
    expect(hi.pages[0].balloons.find((b) => b.lineId === 'pg_1_l2')).toMatchObject({ x: 0.33, fontScale: 0.85, y: 0.5 });
    expect(hi.cover.title).toBe('केसर चोर');
    expect(hi.brief.logline).toBe('एक चोर…');
    expect(i18nOf(hi)).toEqual({ editions: {}, glossary: [] });
    expect(localizeDoc(hi, 'hi')).toBe(hi); // cannot be re-localized
  });
});

describe('localizeDoc: edition positions for software-placed lines (Telugu)', () => {
  /** Telugu edition over the sample doc. pg_1_l4 has no stored source balloon; page 2 has none at all. */
  const telugu = (balloons: Record<string, unknown>): ComicDoc => {
    const doc = normalizeDoc(makeSampleDoc());
    const l = (id: string) => lines(doc).find((x) => x.id === id)!;
    doc.i18n = {
      glossary: [],
      editions: {
        te: {
          lang: 'te',
          register: 'everyday',
          lines: {
            pg_1_l2: { text: 'ఇంకొక్కటే…', status: 'reviewed', sourceHash: lineSourceHash(l('pg_1_l2')), at: 1 },
            pg_1_l4: { text: 'నువ్వు నాకు వివరణ ఇవ్వాలి, మాయా.', status: 'reviewed', sourceHash: lineSourceHash(l('pg_1_l4')), at: 1 }
          },
          balloons: balloons as LanguageEdition['balloons']
        }
      }
    };
    return doc;
  };
  const balloonOf = (doc: ComicDoc, pageId: string, lineId: string) => doc.pages.find((p) => p.id === pageId)!.balloons.find((b) => b.lineId === lineId);

  it('appends the edition position of a line with no stored balloon as a full balloon, after the stored ones', () => {
    const doc = telugu({ pg_1_l2: { x: 0.1, y: 0.52 }, pg_1_l4: { x: 0.3, y: 0.62, w: 0.33, pinned: true, tailX: 0.4, tailY: 0.8, fontScale: 0.9 } });
    const before = JSON.stringify(doc);
    const te = localizeDoc(doc, 'te');
    expect(te.format.language).toBe('te');
    expect(lines(te).find((x) => x.id === 'pg_1_l4')!.text).toBe('నువ్వు నాకు వివరణ ఇవ్వాలి, మాయా.');
    // The stored balloon keeps the merge it always had; the software-placed line gets its Telugu position.
    expect(balloonOf(te, 'pg_1', 'pg_1_l2')).toMatchObject({ x: 0.1, y: 0.52, w: 0.22, tailX: 0.2, tailY: 0.7 });
    expect(balloonOf(te, 'pg_1', 'pg_1_l4')).toEqual({ lineId: 'pg_1_l4', x: 0.3, y: 0.62, w: 0.33, tailX: 0.4, tailY: 0.8, pinned: true, fontScale: 0.9 });
    expect(te.pages[0].balloons.map((b) => b.lineId)).toEqual(['pg_1_l1', 'pg_1_l2', 'pg_1_l3', 'pg_1_l5', 'pg_1_l4']);
    // Pure: the studio doc is untouched, and the other pages / languages are unaffected.
    expect(JSON.stringify(doc)).toBe(before);
    expect(te.pages[1].balloons).toEqual([]);
    expect(te.pages[4].balloons).toEqual(doc.pages[4].balloons);
    expect(localizeDoc(doc, 'en')).toBe(doc);
    expect(localizeDoc(doc, 'hi')).toBe(doc);
    expect(localizeDoc(te, 'te')).toBe(te);
  });

  it('a partial or broken position keeps the software placement; ghosts and other pages never gain a balloon', () => {
    const te = localizeDoc(
      telugu({
        pg_1_l4: { x: 0.3, y: 0.6 }, // no width: cannot draw a full balloon
        pg_2_l1: { x: 0.2, y: 0.2, w: 0 },
        pg_2_l2: { x: Number.NaN, y: 0.2, w: 0.3 },
        pg_2_l3: { x: 1.4, y: -0.2, w: 3, tailX: 0.5 }, // raw (un-normalized) data is clamped; a half tail is dropped
        ghost_line: { x: 0.1, y: 0.1, w: 0.2 }
      }),
      'te'
    );
    expect(balloonOf(te, 'pg_1', 'pg_1_l4')).toBeUndefined();
    expect(te.pages[1].balloons).toEqual([{ lineId: 'pg_2_l3', x: 1, y: 0, w: 1 }]);
    expect(te.pages.flatMap((p) => p.balloons).some((b) => b.lineId === 'ghost_line')).toBe(false);
  });

  it('old docs are unchanged: no software-placed override ⇒ the same balloons as before', () => {
    const doc = translated();
    const hi = localizeDoc(doc, 'hi');
    hi.pages.forEach((p, i) => expect(p.balloons).toEqual(doc.pages[i].balloons));
    // Only the stored-balloon merge, exactly as before.
    const moved = localizeDoc(applyOps(doc, [{ op: 'edition_balloon', lang: 'hi', lineId: 'pg_1_l1', patch: { x: 0.2 } }]), 'hi');
    expect(moved.pages[0].balloons).toEqual(doc.pages[0].balloons.map((b) => (b.lineId === 'pg_1_l1' ? { ...b, x: 0.2 } : b)));
  });

  it('a Telugu move made through the edition_balloon op reaches the reader, and the editor view draws the same page', () => {
    const doc = applyOps(telugu({}), [{ op: 'edition_balloon', lang: 'te', lineId: 'pg_1_l4', patch: { x: 0.3, y: 0.62, w: 0.33, pinned: true } }]);
    const te = localizeDoc(doc, 'te');
    expect(balloonOf(te, 'pg_1', 'pg_1_l4')).toEqual({ lineId: 'pg_1_l4', x: 0.3, y: 0.62, w: 0.33, pinned: true });
    expect(editionViewDoc(doc, 'te')).toEqual(te);
  });

  it('a published snapshot carries the override (publicI18n) and its reader draws it; one without stays as it was', () => {
    const doc = telugu({ pg_1_l4: { x: 0.3, y: 0.62, w: 0.33, pinned: true } });
    const snapshot: ComicDoc = { ...doc, i18n: publicI18n(i18nOf(doc), ['te']) };
    expect(balloonOf(localizeDoc(snapshot, 'te'), 'pg_1', 'pg_1_l4')).toEqual({ lineId: 'pg_1_l4', x: 0.3, y: 0.62, w: 0.33, pinned: true });
    const plain = telugu({});
    const plainSnapshot: ComicDoc = { ...plain, i18n: publicI18n(i18nOf(plain), ['te']) };
    expect(localizeDoc(plainSnapshot, 'te').pages.map((p) => p.balloons)).toEqual(plain.pages.map((p) => p.balloons));
  });
});

describe('normalizeI18n / publicI18n', () => {
  it('drops legacy keys, the source language and non-registry tags', () => {
    const out = normalizeI18n(
      { published: ['hi'], editions: { hi: { lang: 'x', status: 'draft', lines: { a: { text: 'A', status: 'bogus' } }, register: 'nope' }, en: {}, 'te-IN': {} }, glossary: 'bad' },
      'en'
    );
    expect(out).toEqual({ editions: { hi: { lang: 'hi', lines: { a: { text: 'A', status: 'machine', sourceHash: '', at: 0 } }, balloons: {}, register: 'everyday' } }, glossary: [] });
    expect(normalizeI18n(undefined, 'en')).toEqual({ editions: {}, glossary: [] });
  });
  it('public projection strips review data', () => {
    const doc = applyOps(translated(), [
      { op: 'translation', lang: 'hi', lineId: 'pg_1_l1', patch: { gloss: 'g', model: 'm', issue: { severity: 'minor', note: 'n' } } },
      { op: 'glossary_term', id: 'g1', patch: { term: 'Maya' } },
      { op: 'edition', lang: 'te', patch: {} }
    ]);
    const pub = publicI18n(i18nOf(doc), ['hi']);
    expect(Object.keys(pub.editions)).toEqual(['hi']);
    expect(pub.glossary).toEqual([]);
    expect(pub.editions.hi.lines.pg_1_l1).toEqual({ text: 'HI:Old Delhi. Before the heat.', status: 'reviewed', sourceHash: '', at: 0 });
    expect('register' in pub.editions.hi).toBe(false);
  });
});

// ── STU-T0: failure records, readiness with addresses, old documents ─────────

/** Today's editionReadiness, verbatim (before STU-T0): the golden the problems-based one must reproduce. */
const legacyReadiness = (doc: ComicDoc, lang: string, overflowLineIds?: string[]) => {
  if (lang === doc.format.language) return { publishable: true, issues: [] as { code: string; count: number; blocking: boolean; text: string }[] };
  const issues: { code: string; count: number; blocking: boolean; text: string }[] = [];
  const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  const edition = i18nOf(doc).editions[lang];
  const p = editionProgress(doc, lang);
  if (!edition) {
    issues.push({ code: 'missing', count: Math.max(1, p.total), blocking: true, text: 'This language has not been added yet.' });
    return { publishable: false, issues };
  }
  const needs = (line: Line) => !!normalizeSource(line.text) && line.noTranslate !== true;
  if (p.missing) issues.push({ code: 'missing', count: p.missing, blocking: true, text: `${plural(p.missing, 'line')} not translated yet.` });
  const stale = p.stale + p.staleEdited;
  if (stale) issues.push({ code: 'stale', count: stale, blocking: true, text: `${plural(stale, 'line')} changed since translating.` });
  if (p.unreviewed) issues.push({ code: 'unreviewed', count: p.unreviewed, blocking: true, text: `${plural(p.unreviewed, 'line')} waiting for review.` });
  let major = 0;
  for (const line of lines(doc)) {
    const status = translationStatus(doc, lang, line);
    if ((status === 'machine' || status === 'reviewed' || status === 'edited') && edition.lines[line.id]?.issue?.severity === 'major') major += 1;
  }
  if (major) issues.push({ code: 'major_issue', count: major, blocking: true, text: `${plural(major, 'line')} flagged by the review.` });
  if (doc.format.lettering === 'in_art') {
    const pages = doc.pages.filter((pg) => pg.panels.some((panel) => panel.lines.some(needs))).length;
    if (pages) issues.push({ code: 'in_art_pages', count: pages, blocking: true, text: `${plural(pages, 'page')} have lettering painted into the art; translated editions need overlay lettering.` });
  }
  const overflow = (overflowLineIds || []).length;
  if (overflow) issues.push({ code: 'overflow', count: overflow, blocking: false, text: `${plural(overflow, 'balloon')} may be tight in this language.` });
  if (p.coverTitle === 'in_art_only') issues.push({ code: 'cover_in_art', count: 1, blocking: false, text: 'The cover title is painted in the source language.' });
  return { publishable: !issues.some((i) => i.blocking), issues };
};

const failureOf = (doc: ComicDoc, lineId: string, reason: TranslationFailure['reason'] = 'unsafe'): TranslationFailure => ({
  reason,
  sourceHash: lineSourceHash(lines(doc).find((l) => l.id === lineId)!),
  attempts: 1,
  at: 7
});

/** One doc per readiness situation the app meets. */
const readinessCases = (): [string, ComicDoc, string, string[]?][] => {
  const t = translated();
  const machine = translated('machine');
  const flag = (doc: ComicDoc, id: string, severity: 'major' | 'minor' = 'major') =>
    applyOps(doc, [{ op: 'translation', lang: 'hi', lineId: id, patch: { status: 'machine', issue: { severity, note: 'Wrong meaning.' } } }]);
  const refused = applyOps(t, [{ op: 'translation', lang: 'hi', lineId: 'pg_2_l4', patch: null }]);
  i18nOf(refused).editions.hi.failures = { pg_2_l4: failureOf(refused, 'pg_2_l4') };
  const reviewFailed = applyOps(t, [{ op: 'translation', lang: 'hi', lineId: 'pg_3_l1', patch: { status: 'machine' } }]);
  i18nOf(reviewFailed).editions.hi.failures = { pg_3_l1: failureOf(reviewFailed, 'pg_3_l1', 'provider') };
  const mixed = applyOps(flag(flag(machine, 'pg_1_l1'), 'pg_6_l5', 'minor'), [
    { op: 'translation', lang: 'hi', lineId: 'pg_2_l1', patch: null },
    { op: 'translation', lang: 'hi', lineId: 'pg_2_l2', patch: null },
    { op: 'line', pageId: 'pg_4', panelId: 'pg_4_p3', id: 'pg_4_l4', patch: { text: 'You owe me, Maya.' } },
    { op: 'translation', lang: 'hi', lineId: 'pg_5_l3', patch: { status: 'edited' } },
    { op: 'line', pageId: 'pg_5', panelId: 'pg_5_p3', id: 'pg_5_l3', patch: { text: 'Stop, thief!' } },
    { op: 'translation', lang: 'hi', lineId: 'pg_6_l1', patch: { status: 'edited', issue: { severity: 'major', note: 'Off.' } } }
  ]);
  const inArt = applyOps(mixed, [{ op: 'format', patch: { lettering: 'in_art' } }]);
  const paintedCover = normalizeDoc(JSON.parse(JSON.stringify(t)));
  paintedCover.cover = { ...paintedCover.cover, lettering: 'in_art', render: { status: 'ready', history: [], asset: { path: 'u/proj/cover.png', w: 1000, h: 1500, source: 'generated', at: 1 } } };
  return [
    ['all reviewed', t, 'hi'],
    ['all machine', machine, 'hi'],
    ['one major among reviewed', flag(t, 'pg_1_l1'), 'hi'],
    ['one major among machine', flag(machine, 'pg_3_l2'), 'hi'],
    ['minor note on machine', flag(t, 'pg_1_l1', 'minor'), 'hi'],
    ['refused line', refused, 'hi'],
    ['failed review', reviewFailed, 'hi'],
    ['everything at once', mixed, 'hi'],
    ['in-art lettering', inArt, 'hi'],
    ['overflow warning', t, 'hi', ['pg_2_l2', 'pg_1_l4', 'ghost']],
    ['overflow on a mixed edition', mixed, 'hi', ['pg_6_l2']],
    ['painted cover', paintedCover, 'hi'],
    ['language not added', t, 'te'],
    ['source language', t, 'en'],
    ['empty doc, no edition', normalizeDoc({ id: 'empty' }), 'hi']
  ];
};

describe('editionReadiness from the problems list (STU-T0)', () => {
  it("golden: today's codes, counts, texts and blocking rules on every case", () => {
    for (const [name, doc, lang, overflow] of readinessCases()) {
      const now = editionReadiness(doc, lang, overflow);
      const strip = now.issues.map(({ code, count, blocking, text }) => ({ code, count, blocking, text }));
      expect({ publishable: now.publishable, issues: strip }, name).toEqual(legacyReadiness(doc, lang, overflow));
    }
  });

  it('literal texts stay exactly as the publish refusal and the tab show them', () => {
    const cases = Object.fromEntries(readinessCases().map(([name, doc, lang, o]) => [name, editionReadiness(doc, lang, o).issues.map((i) => i.text)]));
    expect(cases['one major among reviewed']).toEqual(['1 line flagged by the review.']);
    expect(cases['everything at once']).toEqual(['2 lines not translated yet.', '2 lines changed since translating.', '24 lines waiting for review.', '2 lines flagged by the review.']);
    expect(cases['language not added']).toEqual(['This language has not been added yet.']);
  });

  it('each line issue names its lines: refs (first 5, reading order) and where ("page N, panel M, line K")', () => {
    const [, mixed] = readinessCases().find(([n]) => n === 'everything at once')!;
    const r = editionReadiness(mixed, 'hi');
    const byCode = Object.fromEntries(r.issues.map((i) => [i.code, i]));
    expect(byCode.missing.refs?.map((x) => x.lineId)).toEqual(['pg_2_l1', 'pg_2_l2']);
    expect(byCode.missing.where).toBe('page 2, panel 1, line 1 and page 2, panel 2, line 1');
    expect(byCode.stale.where).toBe('page 4, panel 3, line 2 and page 5, panel 3, line 1');
    expect(byCode.major_issue.refs?.map((x) => x.lineId)).toEqual(['pg_1_l1', 'pg_6_l1']);
    expect(byCode.major_issue.where).toBe('page 1, panel 1, line 1 and page 6, panel 1, line 1');
    // 24 waiting lines: five refs, the address names three and counts the rest.
    expect(byCode.unreviewed.refs).toHaveLength(5);
    expect(byCode.unreviewed.refs?.[0]).toEqual({ lineId: 'pg_1_l2', pageId: 'pg_1', page: 1, panel: 2, line: 1, kind: 'whisper', speakerId: 'ch_maya' });
    expect(byCode.unreviewed.where).toBe('page 1, panel 2, line 1; page 1, panel 3, line 1; page 1, panel 3, line 2 and 21 more');
    // The text is still the text, word for word.
    expect(byCode.major_issue.text).toBe('2 lines flagged by the review.');
  });

  it('a refused line counts as not translated, and is addressed like any other', () => {
    const [, refused] = readinessCases().find(([n]) => n === 'refused line')!;
    const issue = editionReadiness(refused, 'hi').issues[0];
    expect(issue).toMatchObject({ code: 'missing', count: 1, text: '1 line not translated yet.', where: 'page 2, panel 3, line 2' });
  });

  it('overflow names its balloons in reading order (unknown ids dropped from the address, never from the count)', () => {
    const o = editionReadiness(translated(), 'hi', ['pg_2_l2', 'pg_1_l4', 'ghost']).issues[0];
    expect(o).toMatchObject({ code: 'overflow', count: 3, blocking: false, text: '3 balloons may be tight in this language.' });
    expect(o.refs?.map((x) => x.lineId)).toEqual(['pg_1_l4', 'pg_2_l2']);
    expect(o.where).toBe('page 1, panel 3, line 2 and page 2, panel 2, line 1');
  });

  it('page-wide and whole-language issues carry no address', () => {
    for (const [name, doc, lang] of readinessCases()) {
      for (const i of editionReadiness(doc, lang).issues) {
        if (i.code === 'in_art_pages' || i.code === 'cover_in_art' || (i.code === 'missing' && i.text.startsWith('This language'))) {
          expect(i.refs, name).toBeUndefined();
          expect(i.where, name).toBeUndefined();
        }
      }
    }
  });
});

describe('failure records (STU-T0): stored per edition, never published', () => {
  const raw = (failures: unknown) => ({ editions: { hi: { lang: 'hi', lines: {}, balloons: {}, register: 'everyday', failures } }, glossary: [] });

  it('normalizeI18n keeps valid failures and drops malformed ones', () => {
    const out = normalizeI18n(
      raw({
        pg_1_l1: { reason: 'unsafe', sourceHash: 'abcd1234', attempts: 2, at: 100 },
        'cover.title': { reason: 'timeout', sourceHash: 'abcd1234', attempts: 1, at: 100 },
        a: { reason: 'provider', sourceHash: 'h', attempts: 1, at: 1, model: 'x', text: 'leak' },
        bad_reason: { reason: 'nope', sourceHash: 'h', attempts: 1, at: 1 },
        no_hash: { reason: 'empty', attempts: 1, at: 1 },
        empty_hash: { reason: 'empty', sourceHash: '', attempts: 1, at: 1 },
        zero: { reason: 'empty', sourceHash: 'h', attempts: 0, at: 1 },
        nan_at: { reason: 'empty', sourceHash: 'h', attempts: 1, at: Number.NaN },
        not_obj: 'unsafe',
        '': { reason: 'empty', sourceHash: 'h', attempts: 1, at: 1 }
      }),
      'en'
    );
    expect(out.editions.hi.failures).toEqual({
      pg_1_l1: { reason: 'unsafe', sourceHash: 'abcd1234', attempts: 2, at: 100 },
      'cover.title': { reason: 'timeout', sourceHash: 'abcd1234', attempts: 1, at: 100 },
      a: { reason: 'provider', sourceHash: 'h', attempts: 1, at: 1 } // no model name, no text
    });
  });

  it('attempts stay 1..9: a count above 9 is kept as 9 (a tenth refusal never turns the line into a plain missing one)', () => {
    const out = normalizeI18n(raw({ a: { reason: 'unsafe', sourceHash: 'h', attempts: 14, at: 1 }, b: { reason: 'unsafe', sourceHash: 'h', attempts: 2.7, at: 1 } }), 'en');
    expect(out.editions.hi.failures).toEqual({ a: { reason: 'unsafe', sourceHash: 'h', attempts: 9, at: 1 }, b: { reason: 'unsafe', sourceHash: 'h', attempts: 2, at: 1 } });
  });

  it('at most 2,000 entries: the 2,001st is dropped', () => {
    const many: Record<string, unknown> = {};
    for (let i = 0; i < 2001; i += 1) many[`l${i}`] = { reason: 'timeout', sourceHash: 'h', attempts: 1, at: i };
    const kept = normalizeI18n(raw(many), 'en').editions.hi.failures!;
    expect(Object.keys(kept)).toHaveLength(2000);
    expect(kept.l1999).toBeDefined();
    expect(kept.l2000).toBeUndefined();
  });

  it('an edition with no (or only malformed) failures has no failures key', () => {
    expect('failures' in normalizeI18n(raw({}), 'en').editions.hi).toBe(false);
    expect('failures' in normalizeI18n(raw({ x: { reason: 'nope' } }), 'en').editions.hi).toBe(false);
    expect('failures' in normalizeI18n(raw('nope'), 'en').editions.hi).toBe(false);
  });

  it('publicI18n never carries failures', () => {
    const doc = translated();
    i18nOf(doc).editions.hi.failures = { pg_1_l1: failureOf(doc, 'pg_1_l1') };
    const pub = publicI18n(i18nOf(doc), ['hi']);
    expect('failures' in pub.editions.hi).toBe(false);
    expect(JSON.stringify(pub)).not.toContain('failures');
  });
});

describe('failure records through ops (STU-T0)', () => {
  const failuresOf = (doc: ComicDoc) => i18nOf(doc).editions.hi.failures;

  it('a translations op with empty lines and failures records them; null deletes one; unknown ids are ignored', () => {
    let doc = translated();
    const f = failureOf(doc, 'pg_1_l1', 'timeout');
    doc = applyOps(doc, [{ op: 'translations', lang: 'hi', lines: {}, failures: { pg_1_l1: f, 'brief.title': { ...f, reason: 'timeout' }, ghost: f, constructor: f } }]);
    expect(failuresOf(doc)).toEqual({ pg_1_l1: f, 'brief.title': f });
    doc = applyOps(doc, [{ op: 'translations', lang: 'hi', lines: {}, failures: { pg_1_l1: null } }]);
    expect(failuresOf(doc)).toEqual({ 'brief.title': f });
    doc = applyOps(doc, [{ op: 'translations', lang: 'hi', lines: {}, failures: { 'brief.title': null } }]);
    expect(failuresOf(doc)).toBeUndefined();
    // Nothing to change: the translations stay exactly as they were.
    expect(i18nOf(applyOps(doc, [{ op: 'translations', lang: 'hi', lines: {}, failures: { ghost: f } }], 1))).toEqual(i18nOf(doc));
    expect(i18nOf(applyOps(doc, [{ op: 'translations', lang: 'hi', lines: {} }], 1))).toEqual(i18nOf(doc));
  });

  it('a translations op that writes a line clears that line’s failure (even one set in the same op)', () => {
    let doc = translated();
    const f1 = failureOf(doc, 'pg_1_l1');
    const f2 = failureOf(doc, 'pg_1_l2', 'provider');
    doc = applyOps(doc, [{ op: 'translations', lang: 'hi', lines: {}, failures: { pg_1_l1: f1, pg_1_l2: f2 } }]);
    const l1 = lines(doc)[0];
    doc = applyOps(doc, [{ op: 'translations', lang: 'hi', lines: { pg_1_l1: { text: 'नया', status: 'machine', sourceHash: lineSourceHash(l1), at: 9 } }, failures: { pg_1_l1: f1 } }]);
    expect(failuresOf(doc)).toEqual({ pg_1_l2: f2 });
  });

  it("the author's translation op clears that line's failure; edition_text clears a title's", () => {
    let doc = translated();
    const f = failureOf(doc, 'pg_1_l1');
    doc = applyOps(doc, [{ op: 'translations', lang: 'hi', lines: {}, failures: { pg_1_l1: f, pg_1_l2: f, 'brief.title': f } }]);
    doc = applyOps(doc, [{ op: 'translation', lang: 'hi', lineId: 'pg_1_l1', patch: { text: 'मेरे शब्द', status: 'edited' } }]);
    expect(Object.keys(failuresOf(doc)!).sort()).toEqual(['brief.title', 'pg_1_l2']);
    doc = applyOps(doc, [{ op: 'edition_text', lang: 'hi', field: 'brief.title', value: { text: 'केसर चोर', status: 'edited', sourceHash: '', at: 1 } }]);
    expect(Object.keys(failuresOf(doc)!)).toEqual(['pg_1_l2']);
    doc = applyOps(doc, [{ op: 'translation', lang: 'hi', lineId: 'pg_1_l2', patch: null }]);
    expect(failuresOf(doc)).toBeUndefined();
  });

  it('edition: null removes every failure with the edition; a register change keeps them', () => {
    let doc = translated();
    const f = failureOf(doc, 'pg_1_l1');
    doc = applyOps(doc, [{ op: 'translations', lang: 'hi', lines: {}, failures: { pg_1_l1: f } }]);
    doc = applyOps(doc, [{ op: 'edition', lang: 'hi', patch: { register: 'formal' } }]);
    expect(failuresOf(doc)).toEqual({ pg_1_l1: f });
    doc = applyOps(doc, [{ op: 'edition', lang: 'hi', patch: null }]);
    expect(i18nOf(doc).editions.hi).toBeUndefined();
    doc = applyOps(doc, [{ op: 'edition', lang: 'hi', patch: {} }]);
    expect(i18nOf(doc).editions.hi).toEqual({ lang: 'hi', lines: {}, balloons: {}, register: 'everyday' });
  });

  it('a failure round-trips through a save (JSON) and normalizeDoc', () => {
    let doc = translated();
    const f = failureOf(doc, 'pg_1_l1');
    doc = applyOps(doc, [{ op: 'translations', lang: 'hi', lines: {}, failures: { pg_1_l1: f } }]);
    const back = normalizeDoc(JSON.parse(JSON.stringify(doc)));
    expect(i18nOf(back).editions.hi.failures).toEqual({ pg_1_l1: f });
  });
});

describe('old documents (STU-T0): every new field is optional, nothing is added on load', () => {
  it('a stored comic with editions and no failures round-trips unchanged', () => {
    const stored = JSON.parse(JSON.stringify(translated('machine'))) as ComicDoc;
    // As stored before STU-T0: no failures anywhere.
    expect(JSON.stringify(stored)).not.toContain('failures');
    const loaded = normalizeDoc(stored);
    expect(JSON.stringify(loaded)).not.toContain('failures');
    expect(loaded.i18n).toEqual(stored.i18n);
    const again = normalizeDoc(JSON.parse(JSON.stringify(loaded)));
    expect(JSON.stringify(again)).toBe(JSON.stringify(loaded));
    expect(editionReadiness(loaded, 'hi').issues.map(({ code, count, blocking, text }) => ({ code, count, blocking, text }))).toEqual(legacyReadiness(stored, 'hi').issues);
  });

  it('an old open_tab chip and an old translate action keep their shape', () => {
    const chip = { label: 'Review translations', client: { type: 'open_tab', tab: 'languages' } } as const;
    const action = { type: 'translate', languages: ['hi'], quotedUsd: 0.01 } as const;
    expect(JSON.parse(JSON.stringify(chip))).toEqual(chip);
    expect(JSON.parse(JSON.stringify(action))).toEqual(action);
  });
});
