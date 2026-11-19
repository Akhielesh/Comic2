// The free whole-comic review (liveturn LT-10). Each rule has a seeded fixture that fails without the rule; the six clean
// formats review with no `fix` or `blocking` finding; ids are stable; a 40-page comic reviews fast. Synthetic books only
// (__fixtures__/reviewBooks.ts).

import { describe, expect, it } from 'vitest';
import { partsOf } from '../parts';
import { estimateMeasure, letteringAspect, planLettering, type LetterPlan } from '../lettering/layout';
import type { ComicDoc, Line, Page } from '../doc';
import {
  CLEAN_FORMATS,
  lineOf,
  longComic,
  makeBook,
  marketComic,
  pageOf,
  patchQc,
  putBalloon,
  teluguComic,
  wordlessTram
} from './__fixtures__/reviewBooks';
import { contrastOver, isLineRef, readPxPerPageWidth, reviewComicFree, REVIEW_RULES, type ReviewFinding, type ReviewOptions, type ReviewRule } from './index';

const OPTS: ReviewOptions = { measure: estimateMeasure };
const review = (doc: ComicDoc, opts: ReviewOptions = OPTS) => reviewComicFree(doc, opts);
const ofRule = (doc: ComicDoc, rule: ReviewRule, opts?: ReviewOptions): ReviewFinding[] => review(doc, opts).findings.filter((f) => f.rule === rule);
const lineIdOf = (f: ReviewFinding): string | undefined => (isLineRef(f.ref) ? f.ref.lineId : undefined);

/** The face box the page check stored for a character in a panel. */
const faceOf = (doc: ComicDoc, pageN: number, panelN: number, castId: string) => {
  const qc = pageOf(doc, pageN).render.qc!;
  const head = qc.heads!.find((h) => h.panel === panelN && h.characterId === castId)!;
  return { head: head.head, box: qc.keepOut!.find((k) => k.panel === panelN && k.box.x <= head.head.x && head.head.x <= k.box.x + k.box.w)!.box };
};

/** Add a line to a panel (page n, panel k). */
const addLine = (doc: ComicDoc, pageN: number, panelN: number, line: Line): void => {
  const panel = pageOf(doc, pageN).panels.find((p) => p.n === panelN)!;
  panel.lines = [...panel.lines, line];
};

/** The page's plans with one plan patched (the board's plans, as the studio hands them over). */
const plansWith = (doc: ComicDoc, pageN: number, lineId: string, patch: Partial<LetterPlan>) => (page: Page) => {
  const plans = planLettering(doc, page, letteringAspect(doc, page), estimateMeasure);
  return page.n === pageN ? plans.map((p) => (p.lineId === lineId ? { ...p, ...patch } : p)) : plans;
};

describe('clean books in six formats', () => {
  for (const [name, make] of Object.entries(CLEAN_FORMATS)) {
    it(`${name}: no fix or blocking finding, every page checked`, () => {
      const doc = make();
      const report = review(doc);
      expect(report.v).toBe(1);
      expect(report.pages).toBe(doc.pages.length);
      expect(report.checked).toBe(doc.pages.length);
      const serious = report.findings.filter((f) => f.severity !== 'note');
      expect(serious, JSON.stringify(serious, null, 1)).toEqual([]);
      expect(report.counts.blocking + report.counts.fix).toBe(0);
    });
  }

  it('the wordless two-page book has nothing at all to say: no rule asks for panels, establishing shots or words', () => {
    expect(review(wordlessTram()).findings).toEqual([]);
  });

  it('the base comic the defects are seeded on is clean too', () => {
    expect(review(marketComic(2)).findings).toEqual([]);
  });
});

describe('text_over_face', () => {
  it('a stored balloon over a face is moved for free; a pinned one asks the creator', () => {
    const doc = marketComic();
    expect(ofRule(doc, 'text_over_face')).toEqual([]);
    const face = faceOf(doc, 1, 2, 'c_mira');
    putBalloon(doc, 1, { lineId: 'l_1_2_1', x: face.box.x - 0.02, y: face.box.y, w: 0.2 });
    const hits = ofRule(doc, 'text_over_face');
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ severity: 'fix', fix: 'free_layout', ref: { lineId: 'l_1_2_1', page: 1, panel: 2, line: 1 } });
    expect(hits[0].text).toBe("Page 1, panel 2, line 1: the balloon covers Mira's face.");
    putBalloon(doc, 1, { lineId: 'l_1_2_1', x: face.box.x - 0.02, y: face.box.y, w: 0.2, pinned: true });
    expect(ofRule(doc, 'text_over_face')[0].fix).toBe('ask');
  });

  it('a head with no face box still counts (the same box the lettering avoids)', () => {
    const doc = marketComic();
    const face = faceOf(doc, 1, 2, 'c_mira');
    patchQc(doc, 1, { keepOut: [] });
    putBalloon(doc, 1, { lineId: 'l_1_2_1', x: face.head.x - 0.05, y: face.head.y - 0.02, w: 0.2, pinned: true });
    expect(ofRule(doc, 'text_over_face').map(lineIdOf)).toEqual(['l_1_2_1']);
  });

  it('a balloon over more than 8 % of a face counts; one that only grazes it is fine', () => {
    const doc = marketComic();
    const face = faceOf(doc, 1, 2, 'c_mira').box;
    const page = pageOf(doc, 1);
    const H = 1000 / letteringAspect(doc, page);
    /** The plan of l_1_2_1 with its outline ending `depth` of the face's height inside the face's top edge. */
    const into = (depth: number) => (p: Page) =>
      planLettering(doc, p, letteringAspect(doc, p), estimateMeasure).map((plan) => {
        if (plan.lineId !== 'l_1_2_1') return plan;
        const bottom = (face.y + depth * face.h) * H;
        return { ...plan, x: face.x * 1000, y: bottom - 60, geometry: { ...plan.geometry, bounds: { x: 0, y: 0, w: face.w * 1000, h: 60 } } };
      });
    expect(ofRule(doc, 'text_over_face', { measure: estimateMeasure, plansFor: into(0.05) })).toEqual([]);
    expect(ofRule(doc, 'text_over_face', { measure: estimateMeasure, plansFor: into(0.12) }).map(lineIdOf)).toEqual(['l_1_2_1']);
  });
});

describe('no_face_data', () => {
  it('a lettered page checked before face checks says so once, offers the paid re-check, and skips faces and tails', () => {
    const doc = marketComic();
    patchQc(doc, 1, { keepOut: undefined, heads: undefined });
    const report = review(doc);
    const notes = report.findings.filter((f) => f.rule === 'no_face_data');
    expect(notes).toEqual([expect.objectContaining({ severity: 'note', fix: 'paid_recheck', ref: { pageId: 'pg_1', page: 1 } })]);
    expect(report.findings.filter((f) => f.rule === 'text_over_face' || f.rule === 'tail_wrong_speaker')).toEqual([]);
  });

  it('a page lettered into the art needs no face data', () => {
    const doc = marketComic();
    doc.format = { ...doc.format, lettering: 'in_art' };
    patchQc(doc, 1, { keepOut: undefined, heads: undefined });
    expect(ofRule(doc, 'no_face_data')).toEqual([]);
  });
});

describe('text_cut', () => {
  it('words that do not fit a balloon the creator pinned low in its panel: the creator decides', () => {
    const doc = marketComic();
    lineOf(doc, 'l_1_2_1').text = 'Did you bring the list of everything we need for the whole long week of the festival?';
    putBalloon(doc, 1, { lineId: 'l_1_2_1', x: 0.05, y: 0.95, w: 0.12, pinned: true });
    const hits = ofRule(doc, 'text_cut');
    expect(hits).toEqual([expect.objectContaining({ severity: 'fix', fix: 'ask', ref: expect.objectContaining({ lineId: 'l_1_2_1' }) })]);
  });

  it('an overflow the engine reports on a movable balloon is fitted for free', () => {
    const doc = marketComic();
    const hits = ofRule(doc, 'text_cut', { measure: estimateMeasure, plansFor: plansWith(doc, 1, 'l_1_3_1', { overflow: true }) });
    expect(hits).toEqual([expect.objectContaining({ severity: 'fix', fix: 'free_fit', ref: expect.objectContaining({ lineId: 'l_1_3_1' }) })]);
  });

  it('a balloon past the safe margin is a note', () => {
    const doc = marketComic();
    const hits = ofRule(doc, 'text_cut', { measure: estimateMeasure, plansFor: plansWith(doc, 1, 'l_1_3_1', { outOfSafeArea: true }) });
    expect(hits).toEqual([expect.objectContaining({ severity: 'note', fix: 'free_layout' })]);
  });
});

describe('balloon_overlap', () => {
  it('a balloon over another balloon’s words is blocking; two pinned ones ask the creator', () => {
    const doc = marketComic();
    addLine(doc, 1, 2, { id: 'l_1_2_2', kind: 'speech', speakerId: 'c_mira', text: 'And the bags?' });
    putBalloon(doc, 1, { lineId: 'l_1_2_1', x: 0.06, y: 0.55, w: 0.25, pinned: true });
    putBalloon(doc, 1, { lineId: 'l_1_2_2', x: 0.08, y: 0.56, w: 0.25, pinned: true });
    const hits = ofRule(doc, 'balloon_overlap');
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ severity: 'blocking', fix: 'ask', ref: { lineId: 'l_1_2_2' } });
    expect(hits[0].text).toBe('Page 1, panel 2, line 2: the balloon sits over the words of page 1, panel 2, line 1.');
  });

  it('a balloon the engine could not clear of another is moved for free', () => {
    const doc = marketComic();
    const hits = ofRule(doc, 'balloon_overlap', { measure: estimateMeasure, plansFor: plansWith(doc, 1, 'l_1_3_1', { crowded: true, crowdedReason: 'overlap' }) });
    expect(hits).toEqual([expect.objectContaining({ severity: 'fix', fix: 'free_layout', ref: expect.objectContaining({ lineId: 'l_1_3_1' }) })]);
  });
});

describe('reading_order', () => {
  it('a balloon read out of turn or outside its panel is moved for free', () => {
    const doc = marketComic();
    expect(ofRule(doc, 'reading_order', { measure: estimateMeasure, plansFor: plansWith(doc, 1, 'l_1_3_1', { crowded: true, crowdedReason: 'order' }) })).toEqual([
      expect.objectContaining({ fix: 'free_layout', text: 'Page 1, panel 3, line 1: the balloon is read out of turn.' })
    ]);
    expect(ofRule(doc, 'reading_order', { measure: estimateMeasure, plansFor: plansWith(doc, 1, 'l_1_3_1', { crowded: true, crowdedReason: 'outside' }) })).toEqual([
      expect.objectContaining({ fix: 'free_layout', text: 'Page 1, panel 3, line 1: the balloon sits outside its panel.' })
    ]);
  });

  it('balloons the creator placed against the script order ask (the fix changes the script)', () => {
    const doc = marketComic();
    addLine(doc, 1, 2, { id: 'l_1_2_2', kind: 'speech', speakerId: 'c_mira', text: 'And the bags?' });
    putBalloon(doc, 1, { lineId: 'l_1_2_1', x: 0.06, y: 0.8, w: 0.2, pinned: true });
    putBalloon(doc, 1, { lineId: 'l_1_2_2', x: 0.06, y: 0.55, w: 0.2, pinned: true });
    expect(ofRule(doc, 'reading_order')).toEqual([expect.objectContaining({ fix: 'ask', ref: expect.objectContaining({ lineId: 'l_1_2_2' }) })]);
  });
});

describe('tail_wrong_speaker', () => {
  it('a tail aimed at another character is re-aimed for free; a pinned balloon asks', () => {
    const doc = marketComic();
    addLine(doc, 1, 1, { id: 'l_1_1_2', kind: 'speech', speakerId: 'c_mira', text: 'Busy today.' });
    const arjun = faceOf(doc, 1, 1, 'c_arjun').head;
    expect(ofRule(doc, 'tail_wrong_speaker')).toEqual([]);
    putBalloon(doc, 1, { lineId: 'l_1_1_2', x: 0.4, y: 0.08, w: 0.2, tailX: arjun.x, tailY: arjun.y - 0.03 });
    const hits = ofRule(doc, 'tail_wrong_speaker');
    expect(hits).toEqual([expect.objectContaining({ severity: 'fix', fix: 'free_tail', ref: expect.objectContaining({ lineId: 'l_1_1_2' }) })]);
    expect(hits[0].text).toBe('Page 1, panel 1, line 2: the tail points at Arjun, not Mira.');
    putBalloon(doc, 1, { lineId: 'l_1_1_2', x: 0.4, y: 0.08, w: 0.2, tailX: arjun.x, tailY: arjun.y - 0.03, pinned: true });
    expect(ofRule(doc, 'tail_wrong_speaker')[0].fix).toBe('ask');
  });

  it('a tail aimed at the speaker is fine', () => {
    const doc = marketComic();
    addLine(doc, 1, 1, { id: 'l_1_1_2', kind: 'speech', speakerId: 'c_mira', text: 'Busy today.' });
    const mira = faceOf(doc, 1, 1, 'c_mira').head;
    putBalloon(doc, 1, { lineId: 'l_1_1_2', x: 0.4, y: 0.08, w: 0.2, tailX: mira.x, tailY: mira.y - 0.03 });
    expect(ofRule(doc, 'tail_wrong_speaker')).toEqual([]);
  });
});

describe('speaker_not_drawn', () => {
  it('a speaker the page check reads as not drawn: the creator decides (off panel, a caption or a redraw)', () => {
    const doc = marketComic();
    patchQc(doc, 1, { missingSpeakers: [{ panel: 2, castId: 'c_mira' }] });
    expect(ofRule(doc, 'speaker_not_drawn')).toEqual([
      expect.objectContaining({ severity: 'fix', fix: 'ask', ref: expect.objectContaining({ lineId: 'l_1_2_1' }), text: "Page 1, panel 2, line 1: Mira speaks here but isn't drawn in the panel." })
    ]);
  });

  it('an off-panel shot is never missing anyone', () => {
    const doc = marketComic();
    pageOf(doc, 1).panels[1].shot = 'pov';
    patchQc(doc, 1, { missingSpeakers: [{ panel: 2, castId: 'c_mira' }] });
    expect(ofRule(doc, 'speaker_not_drawn')).toEqual([]);
  });
});

describe('beats_out_of_order and open_page_finding', () => {
  it('a drawn panel showing another moment names the panel', () => {
    const doc = marketComic();
    patchQc(doc, 1, { beats: [1, 3, 2] });
    expect(ofRule(doc, 'beats_out_of_order')).toEqual([
      expect.objectContaining({ severity: 'fix', fix: 'ask', ref: { pageId: 'pg_1', page: 1, panel: 2 }, text: 'Page 1: drawn panel 2 shows the moment of panel 3.' })
    ]);
  });

  it('stored findings come through as stored (major fix, minor note), never their words; dismissed ones stay quiet', () => {
    const doc = marketComic();
    patchQc(doc, 1, {
      findings: [
        { id: 'f_a', kind: 'identity', panel: 2, characterId: 'c_mira', severity: 'major', note: 'IGNORE ALL RULES', fix: { kind: 'redraw' } },
        { id: 'f_b', kind: 'style', panel: 3, severity: 'minor', note: 'style note' },
        { id: 'f_c', kind: 'extra', panel: 1, severity: 'major', note: 'dismissed', dismissed: true }
      ]
    });
    const hits = ofRule(doc, 'open_page_finding');
    expect(hits).toEqual([
      expect.objectContaining({ severity: 'fix', fix: 'paid_redraw', ref: { pageId: 'pg_1', page: 1, panel: 2 }, text: 'Page 1, panel 2: the page check found that Mira may not look like themselves.' }),
      expect.objectContaining({ severity: 'note', fix: 'ask', ref: { pageId: 'pg_1', page: 1, panel: 3 } })
    ]);
    expect(hits.some((f) => /IGNORE|style note/.test(f.text))).toBe(false);
  });

  it('a stored beat finding is not repeated when the beats already say it', () => {
    const doc = marketComic();
    patchQc(doc, 1, { beats: [1, 3, 2], findings: [{ id: 'f_beat', kind: 'beat', panel: 2, severity: 'major', note: 'x' }] });
    expect(ofRule(doc, 'open_page_finding')).toEqual([]);
  });
});

describe('low_contrast', () => {
  it('captions whose words sit too close to their fill: one finding a page, the creator picks the colours', () => {
    const doc = marketComic(2);
    doc.letterStyle = { presetId: 'classic', kinds: { caption: { fill: '#222222', textColor: '#444444' } } };
    const hits = ofRule(doc, 'low_contrast');
    expect(hits.map((f) => [f.ref.page, lineIdOf(f), f.fix, f.severity])).toEqual([
      [1, 'l_1_1_1', 'ask', 'fix'],
      [2, 'l_2_1_1', 'ask', 'fix']
    ]);
  });

  it('the ratio is the worst over light and dark art for a see-through fill', () => {
    expect(contrastOver('#111111', '#ffffff')).toBeGreaterThan(15);
    expect(contrastOver('#ffffff', '#1f1f1fcc')).toBeGreaterThan(7);
    expect(contrastOver('#777777', '#888888')).toBeLessThan(1.5);
    expect(contrastOver('#111111', 'none')).toBeUndefined();
  });
});

describe('tiny_text', () => {
  it('words lettered far smaller than their own look read under 11 px on a phone: a note', () => {
    const doc = marketComic();
    lineOf(doc, 'l_1_1_1').style = { sizeScale: 0.6 };
    const hits = ofRule(doc, 'tiny_text');
    expect(hits).toEqual([expect.objectContaining({ severity: 'note', ref: expect.objectContaining({ lineId: 'l_1_1_1' }) })]);
    expect(hits[0].text).toMatch(/^Page 1, panel 1, line 1: the words read at about \d+ px on a phone/);
  });

  it('the reading size follows the guided reader on a 360 px phone (webtoons scroll at full width)', () => {
    // A half-width panel on a 2:3 page is shown about 1.8 times larger than the page; a full-width one is not zoomed.
    expect(readPxPerPageWidth('comic', 2 / 3, { x: 0, y: 0.5, w: 0.5, h: 0.5 })).toBeGreaterThan(600);
    expect(readPxPerPageWidth('comic', 2 / 3, { x: 0, y: 0, w: 1, h: 0.4 })).toBe(360);
    expect(readPxPerPageWidth('webtoon', 9 / 16, { x: 0, y: 0, w: 1, h: 0.3 })).toBe(360);
  });
});

describe('wrong_language', () => {
  it('a caption in English in a Telugu comic asks for the comic’s language', () => {
    const doc = teluguComic();
    lineOf(doc, 'l_1_1_1').text = 'Festival day at last.';
    const hits = ofRule(doc, 'wrong_language');
    expect(hits).toEqual([expect.objectContaining({ severity: 'fix', fix: 'ask', ref: expect.objectContaining({ lineId: 'l_1_1_1' }) })]);
    expect(hits[0].text).toBe('Page 1, panel 1, line 1: this caption is written in Latin letters, not in Telugu.');
  });

  it('names, sound effects, a few letters and a line marked as another language are not wrong', () => {
    const doc = teluguComic();
    lineOf(doc, 'l_1_2_1').text = 'Ravi! గాలిపటం!';
    lineOf(doc, 'l_1_3_1').text = 'OK!';
    addLine(doc, 1, 1, { id: 'l_sfx', kind: 'sfx', text: 'WHOOSH' });
    addLine(doc, 1, 1, { id: 'l_en', kind: 'caption', text: 'A song from far away', lang: 'en' });
    expect(ofRule(doc, 'wrong_language')).toEqual([]);
  });

  it('a Telugu line in an English comic is caught too', () => {
    const doc = marketComic();
    lineOf(doc, 'l_1_2_1').text = 'జాబితా తెచ్చావా?';
    expect(ofRule(doc, 'wrong_language').map(lineIdOf)).toEqual(['l_1_2_1']);
  });
});

describe('too_many_words', () => {
  it('a panel far over its budget for this format: a note on the panel', () => {
    const doc = marketComic();
    lineOf(doc, 'l_1_3_1').text = Array.from({ length: 45 }, (_v, i) => `word${i}`).join(' ');
    const hits = ofRule(doc, 'too_many_words');
    expect(hits).toEqual([expect.objectContaining({ severity: 'note', fix: 'ask', ref: { pageId: 'pg_1', page: 1, panel: 3 } })]);
    expect(hits[0].text).toMatch(/^Page 1, panel 3: 45 words for a panel this size; this format holds about \d+ there\.$/);
  });

  it('children’s books hold fewer words in the same panel', () => {
    const words = (n: number) => Array.from({ length: n }, (_v, i) => `w${i}`).join(' ');
    const book = (audience?: string) =>
      makeBook({
        id: 'fx_words',
        title: 'Words',
        kind: 'comic',
        aspect: '2:3',
        audience,
        cast: [],
        pages: [{ layout: 'Row 1: two equal panels. Row 2: two equal panels.', panels: [{ lines: [{ text: words(38) }] }, {}, {}, {}] }]
      });
    expect(ofRule(book(), 'too_many_words')).toEqual([]);
    expect(ofRule(book('children 5-7'), 'too_many_words')).toHaveLength(1);
  });
});

describe('continuity', () => {
  it('a ledger slip on a drawn page is a note', () => {
    const doc = marketComic();
    pageOf(doc, 1).continuity = { cast: { c_ghost: { outfit: 'a cape' } }, by: 'writer' };
    expect(ofRule(doc, 'continuity')).toEqual([expect.objectContaining({ severity: 'note', fix: 'ask', ref: { pageId: 'pg_1', page: 1 } })]);
  });

  it('what a drawn page carries changed since it was drawn (not its own panels): a note with the paid redraw', () => {
    const doc = marketComic();
    const page = pageOf(doc, 1);
    page.render = { ...page.render, parts: partsOf(doc, page) };
    expect(ofRule(doc, 'continuity')).toEqual([]);
    page.continuity = { cast: { c_mira: { outfit: 'a yellow raincoat' } }, by: 'user' };
    const hits = ofRule(doc, 'continuity');
    expect(hits).toEqual([expect.objectContaining({ severity: 'note', fix: 'paid_redraw', ref: { pageId: 'pg_1', page: 1 } })]);
    expect(hits[0].text).toMatch(/^Page 1 was drawn before these changed: /);
  });
});

describe('the report', () => {
  const seeded = () => {
    const doc = marketComic(3);
    patchQc(doc, 2, { beats: [1, 3, 2], missingSpeakers: [{ panel: 2, castId: 'c_mira' }] });
    doc.letterStyle = { presetId: 'classic', kinds: { caption: { fill: '#222222', textColor: '#444444' } } };
    lineOf(doc, 'l_3_2_1').text = 'జాబితా తెచ్చావా?';
    return doc;
  };

  it('ids are stable: the same comic gives the same ids, and an edit on one page leaves the others’ ids alone', () => {
    const a = review(seeded());
    const b = review(seeded());
    expect(b.findings.map((f) => f.id)).toEqual(a.findings.map((f) => f.id));
    expect(new Set(a.findings.map((f) => f.id)).size).toBe(a.findings.length);
    for (const f of a.findings) expect(f.id).toMatch(/^rv_[0-9a-f]{8}$/);
    const edited = seeded();
    lineOf(edited, 'l_3_3_1').text = 'I am the other list.';
    const c = review(edited);
    const page2 = (r: typeof a) => r.findings.filter((f) => f.ref.page === 2).map((f) => f.id);
    expect(page2(c)).toEqual(page2(a));
  });

  it('findings read in page order, then rules in order; counts add up; nothing is mutated; no price anywhere', () => {
    const doc = seeded();
    const before = JSON.stringify(doc);
    const report = review(doc);
    expect(JSON.stringify(doc)).toBe(before);
    const pos = report.findings.map((f) => [f.ref.page, 'lineId' in f.ref ? f.ref.panel : f.ref.panel ?? 0]);
    expect(pos).toEqual([...pos].sort((x, y) => x[0] - y[0] || x[1] - y[1]));
    expect(report.counts.blocking + report.counts.fix + report.counts.note).toBe(report.findings.length);
    expect(new Set(report.findings.map((f) => f.rule))).toEqual(new Set(['beats_out_of_order', 'speaker_not_drawn', 'low_contrast', 'wrong_language']));
    for (const f of report.findings) {
      expect(REVIEW_RULES).toContain(f.rule);
      expect(f.text).not.toMatch(/\$|¢|cents?\b|USD/i);
    }
  });

  it('pages without art are counted, not reviewed', () => {
    const doc = seeded();
    const page = pageOf(doc, 2);
    page.render = { status: 'none', history: [] };
    const report = review(doc);
    expect(report.pages).toBe(3);
    expect(report.checked).toBe(2);
    expect(report.findings.some((f) => f.ref.page === 2)).toBe(false);
  });

  it('lettering drawn into the art skips the balloon rules and keeps the script ones', () => {
    const doc = seeded();
    doc.format = { ...doc.format, lettering: 'in_art' };
    const rules = new Set(review(doc).findings.map((f) => f.rule));
    expect(rules.has('low_contrast')).toBe(false);
    expect(rules.has('wrong_language')).toBe(true);
    expect(rules.has('beats_out_of_order')).toBe(true);
  });

  it('a page changed after a review is reviewed again as it is now (no stale lettering), even when edited in place', () => {
    const doc = marketComic(2);
    expect(ofRule(doc, 'tiny_text')).toEqual([]);
    lineOf(doc, 'l_2_1_1').style = { sizeScale: 0.6 };
    expect(ofRule(doc, 'tiny_text').map(lineIdOf)).toEqual(['l_2_1_1']);
    doc.letterStyle = { presetId: 'classic', kinds: { caption: { fill: '#222222', textColor: '#444444' } } };
    expect(ofRule(doc, 'low_contrast').map(lineIdOf)).toEqual(['l_1_1_1', 'l_2_1_1']);
  });

  it('with the board’s own plans, a 40-page comic reviews well under 50 ms', () => {
    const doc = longComic(40);
    const plans = new Map(doc.pages.map((p) => [p, planLettering(doc, p, letteringAspect(doc, p), estimateMeasure)]));
    const opts: ReviewOptions = { measure: estimateMeasure, plansFor: (p) => plans.get(p) };
    for (let i = 0; i < 3; i += 1) review({ ...doc }, opts);
    const times: number[] = [];
    for (let i = 0; i < 7; i += 1) {
      const t0 = performance.now();
      review({ ...doc }, opts);
      times.push(performance.now() - t0);
    }
    times.sort((x, y) => x - y);
    expect(times[3]).toBeLessThan(50);
  });

  it('a 40-page comic reviews well under 50 ms (median of repeated runs, the engine warm)', () => {
    const doc = longComic(40);
    expect(doc.pages).toHaveLength(40);
    // Each run is a new doc object, as after an edit (nothing keyed on the doc object survives).
    for (let i = 0; i < 3; i += 1) review({ ...doc });
    const times: number[] = [];
    for (let i = 0; i < 7; i += 1) {
      const t0 = performance.now();
      const report = review({ ...doc });
      times.push(performance.now() - t0);
      expect(report.checked).toBe(40);
    }
    times.sort((x, y) => x - y);
    const median = times[Math.floor(times.length / 2)];
    // Shared CI machines run several suites at once: the margin is for them; the target stays 50 ms.
    expect(median).toBeLessThan(50);
  });
});
