// @vitest-environment node
// Every comic knows its stage (SH-A): the boundaries from real doc fields, the progress and the one next step, and the
// stored summary reading the same words as the doc. Synthetic docs only.
import { describe, expect, it } from 'vitest';
import { createEmptyDoc, normalizeDoc, type AssetRef, type ComicDoc, type Page, type RenderState } from './doc';
import {
  COMIC_STAGES,
  STAGE_NEXT_KEYS,
  STAGE_PLACE,
  STAGE_UNKNOWN,
  comicStage,
  readStageFacts,
  stageFacts,
  stageSummaryOf,
  stageView,
  type StageFacts
} from './stage';
import { summarizeComicWork } from './workspaceActivity';
import { makeSampleDoc } from '../../components/comicstudio/board/__fixtures__/sampleDoc';

const NOW = 1_800_000_000_000;
const picture = (extra: Partial<AssetRef> = {}): AssetRef => ({ path: 'u/p/pages/a.webp', source: 'generated', at: NOW, ...extra });
const blocked = (): AssetRef => picture({ safety: { quarantined: true, at: NOW } });
const render = (status: RenderState['status'], asset?: AssetRef): RenderState => ({ status, history: [], ...(asset ? { asset } : {}), updatedAt: NOW });

const page = (n: number, r: RenderState = render('none'), panels = 1): Page => ({
  id: `pg_${n}`,
  n,
  summary: '',
  layout: '',
  panels: Array.from({ length: panels }, (_, i) => ({ id: `pg_${n}_p${i}`, n: i + 1, size: 'medium', shot: 'medium', action: 'A beat', castIds: [], lines: [] })),
  render: r,
  balloons: []
});

/** A comic with a story and a look, ready to plan. */
const withLook = (patch: (doc: ComicDoc) => void = () => undefined): ComicDoc => {
  const doc = createEmptyDoc('c1', 'The Night Ferry', NOW);
  doc.brief.premise = 'A ferry that only runs after midnight.';
  doc.style = { ...doc.style, status: 'drafted', name: 'Ink wash', spec: 'Soft ink washes, warm night light.' };
  patch(doc);
  return doc;
};

/** Planned pages, plan approved. */
const planned = (count: number, patch: (doc: ComicDoc) => void = () => undefined): ComicDoc =>
  withLook((doc) => {
    doc.pages = Array.from({ length: count }, (_, i) => page(i + 1));
    doc.planStatus = 'approved';
    patch(doc);
  });

const drawnPages = (doc: ComicDoc, count: number) => {
  for (const p of doc.pages.slice(0, count)) p.render = render('ready', picture());
};

const live = (doc: ComicDoc, publishedAt = NOW + 10) => {
  doc.publication = { visibility: 'unlisted', status: 'live', slug: 'night-ferry', publishedRev: 3, publishedAt, languages: ['en'] };
};

const roundTrip = (facts: StageFacts) => readStageFacts(JSON.parse(JSON.stringify(facts)));

describe('stage boundaries', () => {
  it('an empty comic is at Story, nothing done, and the next step opens the composer', () => {
    const view = comicStage(createEmptyDoc('c0', 'Untitled comic', NOW));
    expect(view.stage).toBe('story');
    expect(view.steps.map((s) => [s.stage, s.done, s.current])).toEqual([
      ['story', false, true],
      ['style', false, false],
      ['plan', false, false],
      ['draw', false, false],
      ['publish', false, false]
    ]);
    expect(view.line).toBe('Story · Not started · Next: tell the Director your idea');
    expect(view.next.place).toBe('composer');
  });

  it('the real flow orders Style before Plan', () => {
    expect(COMIC_STAGES).toEqual(['story', 'style', 'plan', 'draw', 'publish']);
  });

  it('a title alone is no story; a premise, a logline or a pasted script is', () => {
    const doc = createEmptyDoc('c0', 'A real title', NOW);
    expect(comicStage(doc).stage).toBe('story');
    for (const set of [(d: ComicDoc) => (d.brief.premise = 'A premise'), (d: ComicDoc) => (d.brief.logline = 'A logline'), (d: ComicDoc) => (d.source.script = 'PAGE ONE')]) {
      const next = createEmptyDoc('c0', 'Untitled comic', NOW);
      set(next);
      expect(comicStage(next).stage).toBe('style');
    }
    const blank = createEmptyDoc('c0', 'Untitled comic', NOW);
    blank.brief.premise = '   ';
    expect(comicStage(blank).stage).toBe('story');
  });

  it('a look is set by its spec (what drawing uses), not by a name, refs or undrawn options', () => {
    const doc = withLook((d) => (d.style = { status: 'drafted', name: 'Noir', refs: [], options: [] }));
    expect(comicStage(doc).stage).toBe('style');
    expect(comicStage(doc).line).toBe('Style · Not chosen yet · Next: choose a look');
    doc.style.spec = 'Hard shadows';
    expect(comicStage(doc).stage).toBe('plan');
  });

  it('drawn looks waiting to be picked read as looks to compare; a withheld look does not count', () => {
    const doc = withLook((d) => {
      d.style = {
        status: 'drafted',
        refs: [],
        options: [
          { id: 'so_1', name: 'A', spec: 'a', render: render('ready', picture()) },
          { id: 'so_2', name: 'B', spec: 'b', render: render('ready', picture()) },
          { id: 'so_3', name: 'C', spec: 'c', render: render('ready', blocked()) }
        ]
      };
    });
    const view = comicStage(doc);
    expect(view.stage).toBe('style');
    expect(view.line).toBe('Style · 2 looks to compare · Next: pick a look');
    expect(view.next.place).toBe('style');
  });

  it('Plan waits until pages exist, every page is planned and the plan is approved (or drawing began)', () => {
    const none = withLook();
    expect(comicStage(none).line).toBe('Planning · No pages planned yet · Next: plan the pages');
    expect(comicStage(none).next.place).toBe('pages');

    const draft = planned(12, (d) => (d.planStatus = 'draft'));
    expect(comicStage(draft).stage).toBe('plan');
    expect(comicStage(draft).line).toBe('Planning · 12 pages planned · Next: review the plan');

    const blank = planned(13, (d) => (d.pages[12] = page(13, render('none'), 0)));
    expect(comicStage(blank).stage).toBe('plan');
    expect(comicStage(blank).line).toBe('Planning · 12 of 13 pages planned · Next: plan the rest');

    expect(comicStage(planned(12)).stage).toBe('draw');
  });

  it('the Director planning a draft says so and points at the conversation', () => {
    const doc = withLook((d) => (d.directorDraft = { status: 'planning', idea: 'A ferry' }));
    const view = comicStage(doc);
    expect(view.line).toBe('Planning · The Director is planning · Next: follow the Director');
    expect(view.next.place).toBe('conversation');
  });

  it('a hands-on comic that planned before choosing a look reads Style, with Plan already ticked', () => {
    const doc = planned(4, (d) => (d.style = { status: 'empty', refs: [], options: [] }));
    const view = comicStage(doc);
    expect(view.stage).toBe('style');
    expect(view.steps.find((s) => s.stage === 'plan')?.done).toBe(true);
    expect(view.next.label).toBe('Choose a look');
  });

  it('Draw counts pages with a picture the owner can be served', () => {
    const doc = planned(12);
    drawnPages(doc, 6);
    const view = comicStage(doc);
    expect(view.stage).toBe('draw');
    expect(view.line).toBe('Drawing · 6 of 12 pages drawn · Next: draw the rest');
    expect(comicStage(planned(12)).line).toBe('Drawing · 0 of 12 pages drawn · Next: draw the pages');
  });

  it('a withheld picture is never drawn, and the next step is to review it', () => {
    const doc = planned(3);
    drawnPages(doc, 2);
    doc.pages[2].render = render('ready', blocked());
    const view = comicStage(doc);
    expect(view.stage).toBe('draw');
    expect(view.line).toBe('Drawing · 2 of 3 pages drawn · Next: review 1 withheld page');
    expect(stageFacts(doc).withheld).toBe(1);
    // A failed redraw over a withheld picture is still withheld, never failed-and-empty.
    doc.pages[2].render = render('failed', blocked());
    expect(stageFacts(doc)).toMatchObject({ withheld: 1, failed: 0 });
  });

  it('a page that failed with no picture is named in the next step', () => {
    const doc = planned(3);
    drawnPages(doc, 1);
    doc.pages[1].render = render('failed');
    doc.pages[2].render = render('failed');
    expect(comicStage(doc).line).toBe('Drawing · 1 of 3 pages drawn · Next: review 2 failed pages');
    doc.pages[2].render = render('ready', picture());
    expect(comicStage(doc).next.label).toBe('Review 1 failed page');
  });

  it('pages drawing for the first time point at the Pages tab; a redraw in flight keeps its picture', () => {
    const doc = planned(3);
    drawnPages(doc, 3);
    expect(comicStage(doc).stage).toBe('publish');
    // Redrawing page 2: it still has its picture, so the comic stays ready to publish.
    doc.pages[1].render = render('rendering', picture());
    expect(comicStage(doc).stage).toBe('publish');
    // A first draw of a new page: drawing, not drawn.
    doc.pages.push(page(4, render('queued')));
    const view = comicStage(doc);
    expect(view.stage).toBe('draw');
    expect(view.line).toBe('Drawing · 3 of 4 pages drawn · Next: watch the pages draw');
  });

  it('a reused or out-of-date picture is a picture: it counts as drawn', () => {
    const doc = planned(2);
    doc.pages[0].render = { ...render('ready', picture()), origin: 'reused' };
    doc.pages[1].render = render('stale', picture());
    expect(comicStage(doc).stage).toBe('publish');
  });

  it('a drawn comic is ready to publish; the next step opens Read', () => {
    const doc = planned(12);
    drawnPages(doc, 12);
    const view = comicStage(doc);
    expect(view.stage).toBe('publish');
    expect(view.complete).toBe(false);
    expect(view.line).toBe('Ready to publish · All 12 pages drawn · Next: read and publish');
    expect(view.next.place).toBe('read');
    const one = planned(1);
    drawnPages(one, 1);
    expect(comicStage(one).progress).toBe('1 page drawn');
  });

  it('a published comic is done; pictures drawn since ask to publish the changes', () => {
    const doc = planned(4);
    drawnPages(doc, 4);
    live(doc);
    const view = comicStage(doc);
    expect(view.complete).toBe(true);
    expect(view.steps.every((s) => s.done)).toBe(true);
    expect(view.line).toBe('Published · All 4 pages drawn · Next: read your comic');
    doc.pages[2].render = { ...render('ready', picture()), updatedAt: NOW + 100 };
    expect(comicStage(doc).next.label).toBe('Publish your changes');
    // A suspended publication is not published.
    doc.publication!.status = 'suspended';
    expect(comicStage(doc).complete).toBe(false);
  });

  it('a published comic with a new page to draw is back at Draw, with Publish still ticked', () => {
    const doc = planned(4);
    drawnPages(doc, 4);
    live(doc);
    doc.pages.push(page(5));
    const view = comicStage(doc);
    expect(view.stage).toBe('draw');
    expect(view.steps.find((s) => s.stage === 'publish')?.done).toBe(true);
    expect(view.line).toBe('Drawing · 4 of 5 pages drawn · Next: draw the rest');
  });

  it('an open approval and an interrupted draft come first in the next step; the stage never moves for them', () => {
    const doc = planned(6, (d) => (d.planStatus = 'draft'));
    doc.gate = { id: 'g1', action: { type: 'render_pages' }, title: 'Draw', summary: '', estimateUsd: 0.4, imageCount: 6, model: 'm', createdAt: NOW, status: 'open', reason: 'plan_review' };
    let view = comicStage(doc);
    expect(view.stage).toBe('plan');
    expect(view.line).toBe('Planning · 6 pages planned · Next: review the estimate');
    expect(view.next.place).toBe('conversation');
    expect(view.line).not.toMatch(/\$|¢|cent/);
    doc.gate = null;
    doc.directorDraft = { status: 'interrupted', idea: 'A ferry' };
    view = comicStage(doc);
    expect(view.next).toEqual({ key: 'resume_draft', label: 'Resume the draft', place: 'conversation' });
  });

  it('an older doc keeps working: pictures without an approved plan, no look spec, missing fields', () => {
    // Normalised from storage, an old doc without planStatus reads 'draft'; its pictures show the plan was used.
    const old = normalizeDoc({ id: 'old', brief: { title: 'Old comic', notes: [] }, pages: [page(1, render('ready', picture())), page(2, render('ready', picture()))] } as never);
    expect(old.planStatus).toBe('draft');
    expect(old.style.spec).toBeUndefined();
    const view = comicStage(old);
    expect(view.stage).toBe('publish');
    expect(view.steps.slice(0, 4).every((s) => s.done)).toBe(true);
    // A raw partial doc (fields missing entirely) never throws and never claims a stage it has not reached.
    expect(comicStage({ id: 'raw' } as unknown as ComicDoc).stage).toBe('story');
    expect(comicStage({ id: 'raw', pages: [{ id: 'p', n: 1 }] } as unknown as ComicDoc).stage).toBe('style');
  });

  it('the sample board doc reads its real mix of states', () => {
    // Page 1 drawn, 2 planned, 3 queued, 4 drawing, 5 out of date, 6 failed.
    const facts = stageFacts(makeSampleDoc());
    expect(facts).toMatchObject({ stage: 'draw', pages: 6, drawn: 2, drawing: 2, failed: 1, next: 'watch_drawing' });
  });

  it('the next step only navigates: every key has a place, none is an action', () => {
    const places = new Set(['story', 'style', 'pages', 'read', 'conversation', 'composer']);
    for (const key of STAGE_NEXT_KEYS) {
      const facts: StageFacts = { v: 1, stage: 'draw', done: ['story', 'style', 'plan'], pages: 2, planned: 2, drawn: 1, drawing: 0, withheld: 1, failed: 1, looks: 1, next: key };
      const next = stageView(facts).next;
      expect(places.has(next.place), key).toBe(true);
      expect(next).not.toHaveProperty('action');
    }
    expect(STAGE_PLACE).toEqual({ story: 'story', style: 'style', plan: 'pages', draw: 'pages', publish: 'read' });
  });
});

describe('the stored summary', () => {
  const docs: Array<[string, ComicDoc]> = [
    ['empty', createEmptyDoc('e', 'Untitled comic', NOW)],
    ['style', withLook((d) => (d.style = { status: 'empty', refs: [], options: [] }))],
    ['plan', planned(5, (d) => (d.planStatus = 'draft'))],
    ['draw', (() => { const d = planned(12); drawnPages(d, 6); return d; })()],
    ['withheld', (() => { const d = planned(2); drawnPages(d, 1); d.pages[1].render = render('ready', blocked()); return d; })()],
    ['publish', (() => { const d = planned(3); drawnPages(d, 3); return d; })()],
    ['published', (() => { const d = planned(3); drawnPages(d, 3); live(d); return d; })()],
    ['sample', makeSampleDoc()]
  ];

  it.each(docs)('round-trips through the saved summary and reads the same words (%s)', (_name, doc) => {
    const stored = JSON.parse(JSON.stringify(summarizeComicWork(doc))) as { stage?: unknown };
    const facts = readStageFacts(stored.stage);
    expect(facts).toEqual(stageFacts(doc));
    expect(stageView(facts!)).toEqual(comicStage(doc));
    expect(stageSummaryOf(stored.stage)).toBe(comicStage(doc).summary);
  });

  it('stores counts and keys only: no title, text, paths, prices or models', () => {
    const doc = planned(2);
    drawnPages(doc, 2);
    const stored = JSON.stringify(summarizeComicWork(doc).stage);
    expect(stored).not.toMatch(/Night Ferry|ferry|webp|pages\/|usd|price|model|Ink wash/i);
    expect(Object.keys(summarizeComicWork(doc).stage!).sort()).toEqual(['done', 'drawing', 'drawn', 'failed', 'looks', 'next', 'pages', 'planned', 'stage', 'v', 'withheld']);
  });

  it('a comic saved before stages, or an unreadable stage, reads "Open to see", never a guess', () => {
    expect(stageSummaryOf(undefined)).toBe(STAGE_UNKNOWN);
    expect(STAGE_UNKNOWN).toBe('Open to see');
    const good = stageFacts(planned(3));
    expect(roundTrip(good)).toEqual(good);
    const bad: unknown[] = [
      null,
      'draw',
      [],
      { ...good, v: 2 },
      { ...good, stage: 'colour' },
      { ...good, next: 'approve_and_draw' },
      { ...good, done: ['story', 'story', 'style'] },
      { ...good, done: ['story', 'plan'] }, // current stage would be style, not draw
      { ...good, pages: -1 },
      { ...good, drawn: 1.5 },
      { ...good, planned: 4 },
      { ...good, drawn: 3, done: ['story', 'style', 'plan'] }, // every page drawn but Draw not done
      { ...good, done: [...good.done, 'draw'], stage: 'publish', next: 'publish' }, // Draw done with no page drawn
      { ...good, next: 'read' }, // a Publish step at Draw
      { ...good, next: 'review_withheld' }, // nothing withheld
      { ...good, pages: 20_000 }
    ];
    for (const value of bad) {
      expect(readStageFacts(value), JSON.stringify(value)).toBeNull();
      expect(stageSummaryOf(value)).toBe(STAGE_UNKNOWN);
    }
  });

  it('a summary written by this server reads back for every reachable stage and next step', () => {
    for (const [, doc] of docs) expect(roundTrip(stageFacts(doc))).not.toBeNull();
  });
});
