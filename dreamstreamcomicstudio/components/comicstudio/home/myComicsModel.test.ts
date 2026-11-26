// My comics' cards (SH-B), the model: each card's stage, status, next step and Read from the card row and the saved
// summary (never a full doc), older comics without a stage, classic comics, and the order (Needs you first). The stage
// rows here are written the way the server writes them on save (summarizeComicWork) and read the way the list reads
// them (comicActivityRow), so the test covers the whole path. Synthetic comics only.
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../services/supabase', () => ({ supabase: {}, isStoredSession: () => true }));

import type { ComicState, Project } from '../../../types';
import { createEmptyDoc, type AssetRef, type ComicDoc, type Page, type RenderState } from '../../../shared/comic/doc';
import { STAGE_UNKNOWN, type StageFacts, type StagePlace } from '../../../shared/comic/stage';
import { summarizeComicWork } from '../../../shared/comic/workspaceActivity';
import { comicActivityRow } from '../../../services/comicWorkspaceActivity';
import {
  STAGE_FILTERS,
  STAGE_PLACE_DESTINATION,
  matchesStageFilter,
  myComicCard,
  orderMyComics,
  type CardStageRow
} from './homeModel';
import { consumeTaskTarget, requestTaskTarget } from './workspaceTaskTarget';

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 10, 20, 12);
const AT = NOW - 2 * HOUR;

const baseState = (patch: Record<string, unknown> = {}): ComicState =>
  ({
    step: 0, maxStepReached: 0, script: '', scenes: [], styleVariants: [], stylePrompt: '', styleCategory: '', styleAspectRatio: '2:3',
    imageResolution: '2K', characters: [], items: [], locations: [], layoutType: 'grid', panels: [], ...patch
  }) as ComicState;

const studio = (id: string, patch: Record<string, unknown> = {}, row: Partial<Project> = {}): Project => ({
  id, name: `Comic ${id}`, createdAt: AT - 24 * HOUR, updatedAt: AT, state: baseState({ studioVersion: 4, studioPages: 12, studioRendered: 6, ...patch }), ...row
});
const classic = (id: string, patch: Record<string, unknown> = {}): Project => ({
  id, name: `Classic ${id}`, createdAt: AT - 24 * HOUR, updatedAt: AT, state: baseState({ pipelineMode: 'classic', ...patch })
});

// ── Docs, saved and read back as a list reads them ───────────────────────────
const picture = (extra: Partial<AssetRef> = {}): AssetRef => ({ path: 'u/p/pages/a.webp', source: 'generated', at: AT, ...extra });
const render = (status: RenderState['status'], asset?: AssetRef): RenderState => ({ status, history: [], ...(asset ? { asset } : {}), updatedAt: AT });
const page = (n: number, r: RenderState = render('none')): Page => ({
  id: `pg_${n}`, n, summary: '', layout: '', render: r, balloons: [],
  panels: [{ id: `pg_${n}_p0`, n: 1, size: 'medium', shot: 'medium', action: 'A beat', castIds: [], lines: [] }]
});
const comic = (patch: (doc: ComicDoc) => void = () => undefined): ComicDoc => {
  const doc = createEmptyDoc('c1', 'The Night Ferry', AT);
  patch(doc);
  return doc;
};
const drawing = (pages: number, drawn: number, patch: (doc: ComicDoc) => void = () => undefined) =>
  comic((doc) => {
    doc.brief.premise = 'A ferry that only runs after midnight.';
    doc.style = { ...doc.style, status: 'drafted', name: 'Ink wash', spec: 'Soft ink washes.' };
    doc.pages = Array.from({ length: pages }, (_, i) => page(i + 1, i < drawn ? render('ready', picture()) : render('none')));
    doc.planStatus = 'approved';
    patch(doc);
  });
const live = (doc: ComicDoc) => {
  doc.publication = { visibility: 'unlisted', status: 'live', slug: 'night-ferry', publishedRev: 3, publishedAt: AT + 10, languages: ['en'] };
};
const openGate = (doc: ComicDoc) => {
  doc.gate = { id: 'g1', action: { type: 'render_pages' }, title: 'Draw', summary: '', estimateUsd: 0.4, imageCount: 6, model: 'test-model', createdAt: AT, status: 'open', reason: 'plan_review' };
};
/** The row a list holds for a doc: its saved summary, through the JSON a database returns, read by comicActivityRow. */
const saved = (doc: ComicDoc): CardStageRow => {
  const row = comicActivityRow({ project_id: doc.id, activity: JSON.parse(JSON.stringify(summarizeComicWork(doc))) });
  return { ...(row.stage ? { stage: row.stage } : {}), attention: row.attention, working: row.working };
};
/** A look the Director drew that failed (a quota refusal, say). It stays failed after another look is picked. */
const failedLook = (doc: ComicDoc) => {
  doc.style.options = [...(doc.style.options ?? []), { id: 'so_fail', name: 'Failed look', spec: 'Bold inks.', render: { ...render('failed'), error: 'quota' } as RenderState }];
};
const card = (project: Project, row?: CardStageRow, status: 'loading' | 'settled' = 'settled') => myComicCard(project, row, status, NOW, 'en');

describe('a studio comic with a saved stage', () => {
  it('reads its stage, one status line and a next step that opens where the step is worked', () => {
    const model = card(studio('s'), saved(drawing(12, 6)));
    expect(model.kind).toBe('studio');
    expect(model.stage?.stage).toBe('draw');
    expect(model.stageWord).toBe('Drawing');
    expect(model.status).toBe('6 of 12 pages drawn · edited 2 hours ago');
    expect(model.next).toEqual({ label: 'Next: draw the rest', destination: 'pages', hint: 'Opens the comic’s Pages tab' });
    expect(model.needsYou).toBe(false);
    expect(model.canRead).toBe(true);
    expect(model.pending).toBe(false);
  });

  it('a new comic: Story, and the next step opens the conversation; nothing to read yet', () => {
    const model = card(studio('s', { studioPages: 0, studioRendered: 0 }), saved(comic()));
    expect(model.stageWord).toBe('Story');
    expect(model.status).toBe('No story yet · edited 2 hours ago');
    expect(model.next).toMatchObject({ label: 'Next: tell the Director your idea', destination: 'conversation' });
    expect(model.canRead).toBe(false);
  });

  it('an open approval needs the person: Needs you, and the next step is the estimate in the conversation', () => {
    const model = card(studio('s'), saved(drawing(12, 6, openGate)));
    expect(model.needsYou).toBe(true);
    expect(model.next).toMatchObject({ label: 'Next: review the estimate', destination: 'conversation' });
    // Still only a place to go: the card never carries an action, a price or the gate's model.
    expect(JSON.stringify(model)).not.toMatch(/\$|estimateUsd|test-model|render_pages/);
  });

  it('a question waiting on the person leads, except where the stage is already waiting (an approval)', () => {
    const asked = saved(drawing(12, 6));
    expect(card(studio('s'), { ...asked, attention: 'question' }).next).toMatchObject({ label: 'Next: answer the Director', destination: 'conversation' });
    const gate = saved(drawing(12, 6, openGate));
    expect(card(studio('s'), { ...gate, attention: 'question' }).next).toMatchObject({ label: 'Next: review the estimate' });
  });

  it('a redraw that failed over a standing picture leads with the problem; failed pages the stage already names keep its words', () => {
    // The page keeps its earlier picture, so the stage counts it drawn and is ready to publish; the summary says a render failed.
    const redrawFailed = saved(drawing(2, 2, (doc) => {
      doc.pages[1].render = { ...render('failed', picture()), error: 'timeout' } as RenderState;
    }));
    expect(redrawFailed.attention).toBe('render_failed');
    expect(redrawFailed.stage?.next).toBe('publish');
    const model = card(studio('s'), redrawFailed);
    expect(model.needsYou).toBe(true);
    expect(model.next).toMatchObject({ label: 'Next: review the drawing problem', destination: 'pages' });
    // A first draw that failed (no picture): the stage's own "Review 1 failed page".
    const firstFailed = saved(drawing(2, 1, (doc) => {
      doc.pages[1].render = render('failed');
    }));
    expect(card(studio('s'), firstFailed).next).toMatchObject({ label: 'Next: review 1 failed page', destination: 'pages' });
  });

  it('a failed look, cover or cast sheet never sends the card to the Pages tab: the stage keeps its own step', () => {
    // Published, every page current: Read stays the next step, whatever failed elsewhere.
    const published = saved(drawing(5, 5, (doc) => {
      live(doc);
      failedLook(doc);
    }));
    expect(published.attention).toBe('render_failed');
    const done = card(studio('s', { studioPages: 5, studioRendered: 5 }), published);
    expect(done.next).toBeNull();
    expect(done.canRead).toBe(true);
    // Still marked: something failed and the person may want to see it.
    expect(done.needsYou).toBe(true);
    // A new comic whose look failed: the story is still what comes next.
    const story = saved(comic(failedLook));
    expect(story.attention).toBe('render_failed');
    expect(story.stage?.stage).toBe('story');
    expect(card(studio('s', { studioPages: 0, studioRendered: 0 }), story).next).toMatchObject({ label: 'Next: tell the Director your idea', destination: 'conversation' });
    // Every look asked for failed: choosing a look (the Style tab) is still the step.
    const style = saved(comic((doc) => {
      doc.brief.premise = 'A ferry that only runs after midnight.';
      failedLook(doc);
    }));
    expect(card(studio('s', { studioPages: 0, studioRendered: 0 }), style).next).toMatchObject({ label: 'Next: choose a look', destination: 'style' });
    // A failed cover or cast sheet while drawing: the pages' own step.
    const cover = saved(drawing(12, 6, (doc) => {
      doc.cover.render = { ...render('failed'), error: 'timeout' } as RenderState;
    }));
    expect(cover.attention).toBe('render_failed');
    expect(card(studio('s'), cover).next).toMatchObject({ label: 'Next: draw the rest', destination: 'pages' });
  });

  it('a failed look beside a page redraw still running: nothing says the page failed, so the stage step stays', () => {
    const row = saved(drawing(2, 2, (doc) => {
      doc.pages[1].render = render('rendering', picture());
      failedLook(doc);
    }));
    expect(row).toMatchObject({ attention: 'render_failed', working: true });
    expect(card(studio('s'), row).next).toMatchObject({ label: 'Next: read and publish', destination: 'read' });
    // Without the working flag (a row that never said), the standing picture that is not ready reads as a failed redraw.
    expect(card(studio('s'), { ...row, working: undefined }).next).toMatchObject({ label: 'Next: review the drawing problem', destination: 'pages' });
  });

  it('a failed page while others still draw leads with the problem, on the Pages tab', () => {
    const row = saved(drawing(3, 1, (doc) => {
      doc.pages[1].render = render('failed');
      doc.pages[2].render = render('rendering');
    }));
    expect(row.stage?.next).toBe('watch_drawing');
    expect(card(studio('s'), row).next).toMatchObject({ label: 'Next: review the drawing problem', destination: 'pages' });
  });

  it('every page drawn and published: Published, and Read is the next step (no second button)', () => {
    const model = card(studio('s', { studioRendered: 12 }), saved(drawing(12, 12, live)));
    expect(model.stageWord).toBe('Published');
    expect(model.stage?.complete).toBe(true);
    expect(model.next).toBeNull();
    expect(model.canRead).toBe(true);
    expect(model.status).toBe('All 12 pages drawn · edited 2 hours ago');
  });

  it('ready to publish opens the Read tab; a paused publication and changes since publishing open the Share sheet', () => {
    expect(card(studio('s'), saved(drawing(4, 4))).next).toMatchObject({ label: 'Next: read and publish', destination: 'read' });
    const paused = saved(drawing(4, 4, (doc) => {
      live(doc);
      doc.publication!.status = 'suspended';
    }));
    expect(card(studio('s'), paused).stageWord).toBe('Publishing paused');
    expect(card(studio('s'), paused).next).toMatchObject({ label: 'Next: see why it is paused', destination: 'share' });
    const behind = saved(drawing(4, 4, (doc) => {
      live(doc);
      doc.publication!.publishedAt = AT - 10;
    }));
    expect(card(studio('s'), behind).next).toMatchObject({ label: 'Next: publish your changes', destination: 'share' });
  });

  it('a withheld picture never counts: no Read even when the listing row counts the page', () => {
    const withheld = saved(drawing(2, 0, (doc) => {
      doc.pages[0].render = render('ready', picture({ safety: { quarantined: true, at: AT } }));
    }));
    const model = card(studio('s', { studioPages: 2, studioRendered: 1 }), withheld);
    expect(withheld.stage?.drawn).toBe(0);
    expect(model.canRead).toBe(false);
  });

  it('every stage place opens somewhere the studio handles, by a link that round-trips', () => {
    const places = Object.keys(STAGE_PLACE_DESTINATION) as StagePlace[];
    expect(places.sort()).toEqual(['approval', 'composer', 'draft', 'pages', 'read', 'share', 'story', 'style']);
    for (const place of places) {
      requestTaskTarget('author', `comic-${place}`, STAGE_PLACE_DESTINATION[place]);
      expect(consumeTaskTarget('author', `comic-${place}`)).toBe(STAGE_PLACE_DESTINATION[place]);
    }
  });
});

describe('older comics and an unanswered stage read', () => {
  it('saved before stages: "Open to see", the row’s own counts, and a plain Open', () => {
    const older = comicActivityRow({ project_id: 'p', activity: { v: 1, attention: null, working: false, finished: [] } });
    const model = card(studio('s', { studioPages: 10, studioRendered: 3 }), { attention: older.attention });
    expect(model.stage).toBeNull();
    expect(model.stageWord).toBe(STAGE_UNKNOWN);
    expect(model.status).toBe('3 of 10 pages drawn · edited 2 hours ago');
    expect(model.next).toEqual({ label: 'Open', destination: null, hint: 'Opens the comic in the studio' });
    expect(model.canRead).toBe(true);
  });

  it('saved before stages, with a render that failed: Needs you, and the comic opens as it was left (nothing says where)', () => {
    const model = card(studio('s'), { attention: 'render_failed' });
    expect(model.needsYou).toBe(true);
    expect(model.next).toEqual({ label: 'Next: review the drawing problem', destination: null, hint: 'Opens the comic in the studio' });
  });

  it('saved before summaries, with an approval waiting: still Needs you, from the activity data', () => {
    const pre = comicActivityRow({ project_id: 'p', gate: 'open' });
    const model = card(studio('s'), { attention: pre.attention });
    expect(model.stageWord).toBe(STAGE_UNKNOWN);
    expect(model.needsYou).toBe(true);
    expect(model.next).toMatchObject({ label: 'Next: review the estimate', destination: 'conversation' });
  });

  it('an unreadable stored stage reads unknown, never a guess', () => {
    const garbage = comicActivityRow({ project_id: 'p', activity: { v: 1, attention: null, working: false, finished: [], stage: { stage: 'publish' } } as never });
    expect(card(studio('s'), { attention: null, ...(garbage.stage ? { stage: garbage.stage } : {}) }).stageWord).toBe(STAGE_UNKNOWN);
  });

  it('while the read runs: a placeholder (no word), nothing ordered as needing the person; with no row after it: unknown', () => {
    const waiting = card(studio('s'), undefined, 'loading');
    expect(waiting.pending).toBe(true);
    expect(waiting.stageWord).toBe('');
    expect(waiting.needsYou).toBe(false);
    expect(card(studio('s'), undefined, 'settled').stageWord).toBe(STAGE_UNKNOWN);
    // A published comic without a stage still says so from its row, and a blank title reads Untitled comic.
    expect(card(studio('s', {}, { isPublic: true, name: '  ' })).status).toBe('Published · edited 2 hours ago');
    expect(card(studio('s', {}, { name: '  ' })).title).toBe('Untitled comic');
  });

  it('a row whose edit time cannot be read keeps its words and drops the time, never a wrong one or a crash', () => {
    expect(card(studio('s', {}, { updatedAt: Number.NaN }), saved(drawing(12, 6))).status).toBe('6 of 12 pages drawn');
    expect(card(classic('c', { step: 99 }))).toMatchObject({ status: 'Edited 2 hours ago' });
    expect(card({ ...classic('c', { step: 99 }), updatedAt: Number.NaN }).status).toBe('');
  });
});

describe('classic and Page Studio comics', () => {
  it('have no stage: their editor, their own step or count, and Edit', () => {
    const model = card(classic('c', { step: 2 }));
    expect(model.kind).toBe('classic');
    expect(model.stage).toBeNull();
    expect(model.stageWord).toBe('Classic editor');
    expect(model.status).toBe('Step: Style · edited 2 hours ago');
    expect(model.next).toEqual({ label: 'Edit', destination: null, hint: 'Opens the classic editor' });
    expect(model.canRead).toBe(false);
    expect(model.needsYou).toBe(false);
  });

  it('count drawn panels, and Read once one is drawn', () => {
    const model = card(classic('c', { step: 7, panels: [{ id: 'a', imageId: 'x' }, { id: 'b' }, { id: 'c', imageUrl: 'https://cdn.test/c.webp' }] }));
    expect(model.status).toBe('2 of 3 panels drawn · edited 2 hours ago');
    expect(model.canRead).toBe(true);
  });

  it('a build in progress shows its own progress and time left', () => {
    const model = card(classic('c', { generationStatus: { isActive: true, progress: 40, estimatedTimeRemaining: '2m', logs: [] } }));
    expect(model.building).toEqual({ progress: 40, remaining: '2m' });
    expect(model.status).toBe('Building · 40% · about 2m left · edited 2 hours ago');
  });

  it('a build that has not timed itself yet (or stopped) says only how far it is, never "about Calculating... left"', () => {
    for (const remaining of ['Calculating...', 'Done', 'Error', '0s', '', 'Stopped at panel 3']) {
      const model = card(classic('c', { generationStatus: { isActive: true, progress: 0, estimatedTimeRemaining: remaining, logs: [] } }));
      expect(model.status, remaining).toBe('Building · 0% · edited 2 hours ago');
      expect(model.building, remaining).toEqual({ progress: 0, remaining: '' });
    }
    for (const remaining of ['45s', '3m 12s', '1m 0s']) {
      expect(card(classic('c', { generationStatus: { isActive: true, progress: 10, estimatedTimeRemaining: remaining, logs: [] } })).status).toBe(`Building · 10% · about ${remaining} left · edited 2 hours ago`);
    }
  });

  it('Page Studio comics count pages', () => {
    const model = card(classic('p', { pipelineMode: 'pagestudio', pageStudio: { pages: [{ id: 'g1', imageId: 'i' }, { id: 'g2' }] } }));
    expect(model.kind).toBe('pagestudio');
    expect(model.stageWord).toBe('Page Studio');
    expect(model.status).toBe('1 of 2 pages drawn · edited 2 hours ago');
    expect(model.next).toMatchObject({ label: 'Edit', hint: 'Opens Page Studio' });
    expect(model.canRead).toBe(true);
  });
});

describe('orderMyComics', () => {
  const p = (id: string, updatedAt: number, createdAt = updatedAt, name = id): Project => ({ ...studio(id), name, updatedAt, createdAt });
  const list = [p('old', NOW - 5 * HOUR, NOW - 1, 'b'), p('waiting-old', NOW - 9 * HOUR, NOW - 3, 'd'), p('new', NOW - HOUR, NOW - 2, 'a'), p('waiting-new', NOW - 2 * HOUR, NOW - 4, 'c')];
  const waits = (project: Project) => project.id.startsWith('waiting');

  it('puts what needs the person first, then the most recent', () => {
    expect(orderMyComics(list, 'updated', waits).map((x) => x.id)).toEqual(['waiting-new', 'waiting-old', 'new', 'old']);
    expect(orderMyComics(list, 'updated', () => false).map((x) => x.id)).toEqual(['new', 'waiting-new', 'old', 'waiting-old']);
  });

  it('an explicit sort is exactly that, and equal comics keep their order', () => {
    expect(orderMyComics(list, 'created', waits).map((x) => x.id)).toEqual(['old', 'new', 'waiting-old', 'waiting-new']);
    expect(orderMyComics(list, 'az', waits).map((x) => x.name)).toEqual(['a', 'b', 'c', 'd']);
    expect(orderMyComics(list, 'za', waits).map((x) => x.name)).toEqual(['d', 'c', 'b', 'a']);
    const tie = [p('x', NOW), p('y', NOW), p('z', NOW)];
    expect(orderMyComics(tie, 'updated', () => false).map((x) => x.id)).toEqual(['x', 'y', 'z']);
    expect(orderMyComics(list, 'updated', waits)).not.toBe(list);
  });
});

describe('matchesStageFilter', () => {
  const facts = (doc: ComicDoc) => saved(doc).stage as StageFacts;
  it('matches the saved stage, keeps Published apart from ready to publish, and never matches a comic without one', () => {
    expect(STAGE_FILTERS).toEqual(['story', 'style', 'plan', 'draw', 'publish', 'published']);
    expect(matchesStageFilter(facts(drawing(12, 6)), 'draw')).toBe(true);
    expect(matchesStageFilter(facts(drawing(12, 6)), 'plan')).toBe(false);
    expect(matchesStageFilter(facts(drawing(4, 4)), 'publish')).toBe(true);
    expect(matchesStageFilter(facts(drawing(4, 4)), 'published')).toBe(false);
    expect(matchesStageFilter(facts(drawing(4, 4, live)), 'published')).toBe(true);
    expect(matchesStageFilter(facts(drawing(4, 4, live)), 'publish')).toBe(false);
    expect(matchesStageFilter(undefined, 'story')).toBe(false);
  });
});
