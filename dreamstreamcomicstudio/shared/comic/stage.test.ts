// @vitest-environment node
// Every comic knows its stage (SH-A): the boundaries from real doc fields, the progress and the one next step, and the
// stored summary reading the same words as the doc. Synthetic docs only.
import { describe, expect, it } from 'vitest';
import { createEmptyDoc, normalizeDoc, type AssetRef, type Card, type ComicDoc, type Msg, type Page, type RenderState } from './doc';
import {
  COMIC_STAGES,
  STAGE_NEXT_KEYS,
  STAGE_PLACE,
  STAGE_UNKNOWN,
  comicStage,
  pageStanding,
  pictureStanding,
  publicationBehind,
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
    expect(view.line).toBe('Story · No story yet · Next: tell the Director your idea');
    expect(view.next.place).toBe('composer');
  });

  it('a comic with a look or a cast but no story says only the story is missing', () => {
    const doc = createEmptyDoc('c0', 'Untitled comic', NOW);
    doc.style = { ...doc.style, status: 'drafted', name: 'Noir', spec: 'Hard shadows' };
    const view = comicStage(doc);
    expect(view.stage).toBe('story');
    expect(view.steps.find((s) => s.stage === 'style')?.done).toBe(true);
    expect(view.progress).toBe('No story yet');
    expect(view.line).not.toMatch(/not started/i);
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

  it('the Director planning a draft says so and points at the draft in the conversation', () => {
    const doc = withLook((d) => (d.directorDraft = { status: 'planning', idea: 'A ferry' }));
    const view = comicStage(doc);
    expect(view.line).toBe('Planning · The Director is planning · Next: follow the Director');
    expect(view.next.place).toBe('draft');
  });

  it('while the Director plans, the next step waits at any stage: never "pick a look", which would void the plan', () => {
    // "Draft it for me" keeps a style that already has drawn looks (directorDraft.ts sets a look only when it is empty),
    // so the comic is still at Style while the writer runs; picking a look then changes the style the plan was written for.
    const doc = withLook((d) => {
      d.style = { status: 'drafted', refs: [], options: [{ id: 'so_1', name: 'A', spec: 'a', render: render('ready', picture()) }] };
      d.directorDraft = { status: 'planning', idea: 'A ferry' };
    });
    const view = comicStage(doc);
    expect(view.stage).toBe('style');
    expect(view.next).toEqual({ key: 'follow_planning', label: 'Follow the Director', place: 'draft' });
    expect(view.line).toBe('Style · The Director is planning · Next: follow the Director');
    expect(roundTrip(stageFacts(doc))).toEqual(stageFacts(doc));
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
    // Redrawing page 2: it still has its picture, so Draw stays done, but the step is the run, not publishing.
    doc.pages[1].render = render('rendering', picture());
    expect(comicStage(doc).stage).toBe('publish');
    expect(comicStage(doc).line).toBe('Ready to publish · 2 of 3 pages drawn · 1 redrawing · Next: watch the pages draw');
    // A first draw of a new page: drawing, not drawn. The redraw in flight is not counted current (the Board badge's 2 of 4).
    doc.pages.push(page(4, render('queued')));
    const view = comicStage(doc);
    expect(view.stage).toBe('draw');
    expect(stageFacts(doc)).toMatchObject({ drawn: 3, current: 2, drawing: 1, redrawing: 1 });
    expect(view.line).toBe('Drawing · 2 of 4 pages drawn · 1 redrawing · Next: watch the pages draw');
  });

  it('a reused or out-of-date picture is a picture: Draw is done, and the words say which page is out of date', () => {
    const doc = planned(2);
    doc.pages[0].render = { ...render('ready', picture()), origin: 'reused' };
    doc.pages[1].render = render('stale', picture());
    expect(comicStage(doc).stage).toBe('publish');
    // The board's count (1 of 2 ready) and the reader's words ("1 of 2 pages drawn · 1 out of date"), never "All 2".
    expect(comicStage(doc).line).toBe('Ready to publish · 1 of 2 pages drawn · 1 out of date · Next: read and publish');
    expect(stageFacts(doc)).toMatchObject({ drawn: 2, current: 1, outOfDate: 1 });
    // A ready picture whose script changed since it was drawn is out of date too (boardModel pageVisualStatus).
    doc.pages[1].render = { ...render('ready', picture()), specHash: 'an-older-script' };
    expect(stageFacts(doc)).toMatchObject({ drawn: 2, current: 1, outOfDate: 1 });
  });

  it('a redraw in flight keeps its picture for the stage but is not counted current, like the Board badge', () => {
    const doc = planned(3);
    drawnPages(doc, 3);
    doc.pages[2].render = render('rendering', picture());
    const view = comicStage(doc);
    expect(view.stage).toBe('publish');
    // The words say why one drawn page is not counted: it is being drawn again.
    expect(view.progress).toBe('2 of 3 pages drawn · 1 redrawing');
    expect(view.next.key).toBe('watch_drawing');
  });

  it('redraws running and failed over drawn pages are named, and lead the step even with every page drawn', () => {
    // A 12-page book: 8 current, 3 redrawing, 1 whose redraw failed (its earlier picture still stands).
    const doc = planned(12);
    drawnPages(doc, 12);
    for (const i of [3, 4, 5]) doc.pages[i].render = render(i === 3 ? 'queued' : 'rendering', picture());
    doc.pages[8].render = render('failed', picture());
    const facts = stageFacts(doc);
    expect(facts).toMatchObject({ stage: 'publish', drawn: 12, current: 8, redrawing: 3, redrawFailed: 1, drawing: 0, failed: 0 });
    expect(comicStage(doc).line).toBe('Ready to publish · 8 of 12 pages drawn · 3 redrawing · 1 redraw failed · Next: watch the pages draw');
    expect(roundTrip(facts)).toEqual(facts);
    // The runs settle: the failed redraw is the step, by its own name.
    for (const i of [3, 4, 5]) doc.pages[i].render = render('ready', picture());
    const settled = comicStage(doc);
    expect(settled.line).toBe('Ready to publish · 11 of 12 pages drawn · 1 redraw failed · Next: review 1 failed redraw');
    expect(settled.next.place).toBe('pages');
    expect(roundTrip(stageFacts(doc))).toEqual(stageFacts(doc));
    // A failed first draw beside it: both are failed pages.
    doc.pages.push(page(13, render('failed')));
    expect(comicStage(doc).next.label).toBe('Review 2 failed pages');
    // Published, a failed redraw still leads (never "Read your comic" over a page that did not redraw).
    const published = planned(2);
    drawnPages(published, 2);
    live(published);
    published.pages[1].render = { ...render('failed', picture()), updatedAt: 1 };
    expect(comicStage(published)).toMatchObject({ complete: true, next: { key: 'review_failed' } });
  });

  it('a summary written before the redraw counts reads them as none', () => {
    const doc = planned(3);
    drawnPages(doc, 3);
    const { redrawing: _r, redrawFailed: _f, ...older } = stageFacts(doc);
    expect(readStageFacts(JSON.parse(JSON.stringify(older)))).toMatchObject({ redrawing: 0, redrawFailed: 0, next: 'publish' });
    // But a stored redraw step needs its count, and Publish has no first draws to watch.
    expect(readStageFacts({ ...older, next: 'watch_drawing' })).toBeNull();
    expect(readStageFacts({ ...older, next: 'review_failed' })).toBeNull();
    expect(readStageFacts({ ...older, redrawing: 1, current: 2, next: 'watch_drawing' })).toMatchObject({ redrawing: 1 });
    expect(readStageFacts({ ...older, redrawing: 4 })).toBeNull(); // more than the drawn pages
    expect(readStageFacts({ ...older, redrawFailed: -1 })).toBeNull();
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
    expect(comicStage(doc).next).toEqual({ key: 'update_published', label: 'Publish your changes', place: 'share' });
  });

  it('the server’s own "behind" (lettering, text, languages) also asks to publish the changes; lists keep the render rule', () => {
    const doc = planned(4);
    drawnPages(doc, 4);
    live(doc);
    expect(publicationBehind(doc)).toBe(false);
    expect(comicStage(doc).next.key).toBe('read');
    expect(comicStage(doc, { behind: true }).next.key).toBe('update_published');
    expect(comicStage(doc, { behind: false }).next.key).toBe('read');
    // The render rule still holds when the view is older than a new picture.
    doc.cover.render = { ...render('ready', picture()), updatedAt: NOW + 100 };
    expect(comicStage(doc, { behind: false }).next.key).toBe('update_published');
    // The rule is for a live publication only (one rule with the Director's chip, jobs.ts).
    doc.publication!.status = 'suspended';
    expect(publicationBehind(doc)).toBe(false);
  });

  it('a paused publication says so and points at why, never at publishing (sharing is off while paused)', () => {
    const doc = planned(4);
    drawnPages(doc, 4);
    live(doc);
    doc.publication!.status = 'suspended';
    const view = comicStage(doc);
    expect(view.complete).toBe(false);
    expect(view.steps.find((s) => s.stage === 'publish')?.done).toBe(false);
    expect(view.line).toBe('Publishing paused · All 4 pages drawn · Next: see why it is paused');
    expect(view.next.place).toBe('share');
    expect(roundTrip(stageFacts(doc))).toEqual(stageFacts(doc));
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
    const view = comicStage(doc);
    expect(view.stage).toBe('plan');
    expect(view.line).toBe('Planning · 6 pages planned · Next: review the estimate');
    expect(view.next.place).toBe('approval');
    expect(view.line).not.toMatch(/\$|¢|cent/);
  });

  it('an interrupted draft is resumed only while it has no pages; with pages the stage’s own step leads', () => {
    const empty = withLook((d) => (d.directorDraft = { status: 'interrupted', idea: 'A ferry' }));
    expect(comicStage(empty).next).toEqual({ key: 'resume_draft', label: 'Resume the draft', place: 'draft' });
    // Stopped during the book offer, or "Your page plan changed": the plan is saved, so review it.
    const plannedDraft = planned(3, (d) => {
      d.planStatus = 'draft';
      d.directorDraft = { status: 'interrupted', idea: 'A ferry' };
    });
    expect(comicStage(plannedDraft).line).toBe('Planning · 3 pages planned · Next: review the plan');
    // Carried on by hand: drawn, then published. Nothing to resume, ever.
    const drawn = planned(3, (d) => (d.directorDraft = { status: 'interrupted', idea: 'A ferry' }));
    drawnPages(drawn, 3);
    expect(comicStage(drawn).line).toBe('Ready to publish · All 3 pages drawn · Next: read and publish');
    live(drawn);
    expect(comicStage(drawn).line).toBe('Published · All 3 pages drawn · Next: read your comic');
    for (const doc of [empty, plannedDraft, drawn]) expect(roundTrip(stageFacts(doc))).toEqual(stageFacts(doc));
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
    const places = new Set(['story', 'style', 'pages', 'read', 'approval', 'draft', 'composer', 'share']);
    for (const key of STAGE_NEXT_KEYS) {
      const facts: StageFacts = { v: 1, stage: 'draw', done: ['story', 'style', 'plan'], pages: 2, planned: 2, drawn: 1, current: 1, outOfDate: 0, drawing: 0, withheld: 1, failed: 1, looks: 1, paused: false, next: key };
      const next = stageView(facts).next;
      expect(places.has(next.place), key).toBe(true);
      expect(next).not.toHaveProperty('action');
    }
    expect(STAGE_PLACE).toEqual({ story: 'story', style: 'style', plan: 'pages', draw: 'pages', publish: 'read' });
  });
});

describe('one page’s standing (the side panel’s parts tree reads it)', () => {
  it('every page reads one standing, and the standings add up to the stage’s own counts', () => {
    const doc = planned(9);
    doc.pages[0].render = render('ready', picture());
    doc.pages[1].render = render('stale', picture());
    doc.pages[2].render = { ...render('ready', picture()), specHash: 'drawn-from-an-older-script' };
    doc.pages[3].render = render('rendering', picture());
    doc.pages[4].render = render('failed', picture());
    doc.pages[5].render = render('queued');
    doc.pages[6].render = render('ready', blocked());
    doc.pages[7].render = render('failed');
    doc.pages[8] = { ...doc.pages[8], panels: [] };
    const standings = doc.pages.map((p) => pageStanding(doc, p));
    expect(standings).toEqual(['current', 'out_of_date', 'out_of_date', 'redrawing', 'redraw_failed', 'drawing', 'withheld', 'failed', 'empty']);
    const facts = stageFacts(doc);
    const count = (...kinds: string[]) => standings.filter((s) => kinds.includes(s)).length;
    expect(facts.current).toBe(count('current'));
    expect(facts.outOfDate).toBe(count('out_of_date'));
    expect(facts.drawn).toBe(count('current', 'out_of_date', 'redrawing', 'redraw_failed'));
    expect(facts.drawing).toBe(count('drawing'));
    expect(facts.withheld).toBe(count('withheld'));
    expect(facts.failed).toBe(count('failed'));
  });

  it('older pages read as far as their fields go: no render, no panels, a picture with no plan', () => {
    const doc = planned(1);
    const bare = { id: 'pg_old', n: 2 } as unknown as Page;
    expect(pageStanding(doc, bare)).toBe('empty');
    expect(pageStanding(doc, { ...bare, render: render('ready', picture()) } as Page)).toBe('current');
    expect(pictureStanding(undefined)).toBe('empty');
    expect(pictureStanding(render('none'), false, true)).toBe('planned');
    expect(pictureStanding(render('stale', picture()))).toBe('out_of_date');
  });
});

describe('what waits on the person is the next step, whatever the stage', () => {
  const msg = (id: string, role: Msg['role'], cards?: Card[]): Msg => ({ id, role, text: role === 'user' ? 'Show me some looks' : 'Here you go.', at: NOW, ...(cards ? { cards } : {}) });
  /** A drafted look, then two looks drawn to compare it with (propose_styles after set_style), the choice still live. */
  const comparing = (patch: (doc: ComicDoc) => void = () => undefined): ComicDoc =>
    withLook((d) => {
      d.style.options = [
        { id: 'so_1', name: 'Ink wash', spec: 'a', render: render('ready', picture({ path: 'u/p/style/1.webp' })) },
        { id: 'so_2', name: 'Bold pop', spec: 'b', render: render('ready', picture({ path: 'u/p/style/2.webp' })) }
      ];
      d.conversation = [msg('u1', 'user'), msg('a1', 'assistant', [{ type: 'style_choice', id: 'sc' }])];
      patch(d);
    });

  it('looks drawn to compare over a drafted spec: the comic is choosing its look again, so Style is the stage', () => {
    const doc = comparing();
    const view = comicStage(doc);
    expect(view.stage).toBe('style');
    expect(view.line).toBe('Style · 2 looks to compare · Next: pick a look');
    expect(view.next.place).toBe('style');
    expect(roundTrip(stageFacts(doc))).toEqual(stageFacts(doc));
    // The panel's row and My comics' card read the same wait from the same summary.
    expect(summarizeComicWork(doc).attention).toBe('style');
    // Picked (the look locks) or moved past (a new message): the drafted spec stands again and the stage moves on.
    const locked = comparing((d) => (d.style.status = 'locked'));
    expect(comicStage(locked).line).toBe('Planning · No pages planned yet · Next: plan the pages');
    const moved = comparing((d) => d.conversation.push(msg('u2', 'user')));
    expect(comicStage(moved).stage).toBe('plan');
  });

  it('once a page is drawn the look it was drawn in stands, and the open choice still leads the step', () => {
    const doc = comparing((d) => {
      d.pages = [page(1), page(2)];
      d.planStatus = 'approved';
      drawnPages(d, 1);
    });
    const facts = stageFacts(doc);
    expect(facts).toMatchObject({ stage: 'draw', next: 'pick_look', looks: 2 });
    expect(comicStage(doc).line).toBe('Drawing · 1 of 2 pages drawn · Next: pick a look');
    expect(roundTrip(facts)).toEqual(facts);
  });

  it('a look suggested to pick (free presets) is the step; nothing drawn, so the drafted spec keeps Style done', () => {
    const doc = withLook((d) => (d.conversation = [msg('u1', 'user'), msg('a1', 'assistant', [{ type: 'style_presets', id: 'sp', presetIds: ['noir-ink'] }])]));
    const facts = stageFacts(doc);
    expect(facts).toMatchObject({ stage: 'plan', next: 'choose_look', looks: 0 });
    expect(comicStage(doc).line).toBe('Planning · No pages planned yet · Next: choose a look');
    expect(roundTrip(facts)).toEqual(facts);
  });

  it('a question from the Director: "Answer the Director", at the message box', () => {
    const question: Card = { type: 'options', id: 'o1', question: 'Which ending?', choices: [{ id: 'a', label: 'Happy' }, { id: 'b', label: 'Sad' }] };
    const doc = withLook((d) => (d.conversation = [msg('u1', 'user'), msg('a1', 'assistant', [question])]));
    const view = comicStage(doc);
    expect(view.line).toBe('Planning · No pages planned yet · Next: answer the Director');
    expect(view.next.place).toBe('composer');
    expect(roundTrip(stageFacts(doc))).toEqual(stageFacts(doc));
    // Answered: the stage's own step again.
    doc.conversation.push(msg('u2', 'user'));
    expect(comicStage(doc).next.key).toBe('plan_pages');
  });

  it('the page plan waiting for its OK leads in any stage', () => {
    const doc = withLook((d) => {
      d.style = { status: 'empty', refs: [], options: [] }; // planned before a look: the stage is Style
      d.pages = [page(1), page(2)];
      d.planStatus = 'draft';
      d.conversation = [msg('u1', 'user'), msg('a1', 'assistant', [{ type: 'plan', id: 'pl' }])];
    });
    const facts = stageFacts(doc);
    expect(facts).toMatchObject({ stage: 'style', next: 'review_plan' });
    expect(comicStage(doc).line).toBe('Style · Not chosen yet · Next: review the plan');
    expect(roundTrip(facts)).toEqual(facts);
  });

  it('an open approval still comes first', () => {
    const doc = comparing((d) => {
      d.gate = { id: 'g1', action: { type: 'render_style_options', count: 2 }, title: 'Draw 2 looks', summary: '', estimateUsd: 0.1, imageCount: 2, model: 'm', createdAt: NOW, status: 'open', reason: 'first_render' } as ComicDoc['gate'];
    });
    expect(stageFacts(doc).next).toBe('review_estimate');
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
    ['paused', (() => { const d = planned(3); drawnPages(d, 3); live(d); d.publication!.status = 'suspended'; return d; })()],
    ['out of date', (() => { const d = planned(2); drawnPages(d, 2); d.pages[1].render = render('stale', picture()); return d; })()],
    ['draft interrupted', withLook((d) => (d.directorDraft = { status: 'interrupted', idea: 'A ferry' }))],
    ['draft planning', withLook((d) => (d.directorDraft = { status: 'planning', idea: 'A ferry' }))],
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
    expect(Object.keys(summarizeComicWork(doc).stage!).sort()).toEqual(['current', 'done', 'drawing', 'drawn', 'failed', 'looks', 'next', 'outOfDate', 'pages', 'paused', 'planned', 'redrawFailed', 'redrawing', 'stage', 'v', 'withheld']);
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
      { ...good, pages: 20_000 },
      { ...good, current: 1 }, // more current pages than drawn ones
      { ...good, outOfDate: 1 },
      { ...good, paused: 'yes' },
      { ...good, paused: undefined },
      { ...good, next: 'resume_draft' }, // a draft with pages is never resumed
      { ...good, done: [...good.done, 'draw'], stage: 'publish', drawn: 3, current: 3, next: 'see_paused' }, // not paused
      { ...good, done: [...good.done, 'draw'], stage: 'publish', drawn: 3, current: 3, paused: true, next: 'publish' } // paused: never "publish"
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
