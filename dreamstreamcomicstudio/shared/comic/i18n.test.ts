import { describe, expect, it } from 'vitest';
import { makeSampleDoc } from '../../components/comicstudio/board/__fixtures__/sampleDoc';
import { editionViewDoc } from '../../components/comicstudio/mobile/editor/editorModel';
import { normalizeDoc, type ComicDoc, type LanguageEdition, type Line } from './doc';
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
