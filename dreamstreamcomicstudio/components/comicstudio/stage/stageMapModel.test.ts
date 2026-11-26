// @vitest-environment node
// The stage map's words (SH-C2): each stage done, now, next or later, what is left in it, and its one target, from the
// same facts as the strip. Targets only navigate. Synthetic facts only.
import { describe, expect, it } from 'vitest';
import { createEmptyDoc } from '../../../shared/comic/doc';
import { comicStage, stageFacts, type StageFacts } from '../../../shared/comic/stage';
import { stageMapRows } from './stageMapModel';

const facts = (extra: Partial<StageFacts>): StageFacts => ({
  v: 1,
  stage: 'story',
  done: [],
  pages: 0,
  planned: 0,
  drawn: 0,
  current: 0,
  outOfDate: 0,
  drawing: 0,
  withheld: 0,
  failed: 0,
  looks: 0,
  paused: false,
  next: 'tell_story',
  ...extra
});

const table = (f: StageFacts) => stageMapRows(f).map((r) => [r.label, r.stateWord, r.left, r.target.label, r.target.place]);

describe('the stage map', () => {
  it('a new comic: Story now (its next step), Style next, the rest later, each opening its tab', () => {
    expect(table(stageFacts(createEmptyDoc('c0', 'Untitled comic', 1)))).toEqual([
      ['Story', 'Now', 'No story yet', 'Tell the Director your idea', 'composer'],
      ['Style', 'Next', 'No look chosen yet', 'Open Style', 'style'],
      ['Plan', 'Later', 'No pages planned yet', 'Open Pages', 'pages'],
      ['Draw', 'Later', 'Nothing to draw yet', 'Open Pages', 'pages'],
      ['Publish', 'Later', 'Publish once the pages are drawn', 'Open Read', 'read']
    ]);
  });

  it('drawing: what is left counts pages to draw, drawing now, withheld, failed and out of date', () => {
    const f = facts({ stage: 'draw', done: ['story', 'style', 'plan'], pages: 12, planned: 12, drawn: 7, current: 6, outOfDate: 1, drawing: 2, withheld: 1, failed: 1, next: 'watch_drawing' });
    expect(table(f)).toEqual([
      ['Story', 'Done', 'Nothing left', 'Open Story', 'story'],
      ['Style', 'Done', 'Nothing left', 'Open Style', 'style'],
      ['Plan', 'Done', 'Nothing left', 'Open Pages', 'pages'],
      ['Draw', 'Now', '5 pages to draw · 2 drawing now · 1 withheld · 1 failed · 1 out of date', 'Watch the pages draw', 'pages'],
      ['Publish', 'Next', 'Publish once the pages are drawn', 'Open Read', 'read']
    ]);
    expect(stageMapRows(f)[3].sentence).toBe('Draw, now. 5 pages to draw, 2 drawing now, 1 withheld, 1 failed, 1 out of date.');
  });

  it('a hands-on comic that planned first: Style now with Plan already done, looks to compare', () => {
    const rows = stageMapRows(facts({ stage: 'style', done: ['story', 'plan'], pages: 4, planned: 4, looks: 3, next: 'pick_look' }));
    expect(rows.map((r) => [r.label, r.state, r.left])).toEqual([
      ['Story', 'done', 'Nothing left'],
      ['Style', 'current', '3 looks to compare'],
      ['Plan', 'done', 'Nothing left'],
      ['Draw', 'next', '4 pages to draw'],
      ['Publish', 'later', 'Publish once the pages are drawn']
    ]);
    expect(rows[1].target).toEqual({ label: 'Pick a look', place: 'style' });
  });

  it('planning part of the book, and a plan waiting for review', () => {
    expect(stageMapRows(facts({ stage: 'plan', done: ['story', 'style'], pages: 12, planned: 8, next: 'plan_rest' }))[2].left).toBe('4 pages to plan');
    expect(stageMapRows(facts({ stage: 'plan', done: ['story', 'style'], pages: 12, planned: 12, next: 'review_plan' }))[2]).toMatchObject({
      left: 'The plan is ready to review',
      target: { label: 'Review the plan', place: 'pages' }
    });
  });

  it('an open approval leads from the current stage, and only shows where it is', () => {
    const rows = stageMapRows(facts({ stage: 'style', done: ['story'], next: 'review_estimate' }));
    expect(rows[1].target).toEqual({ label: 'Review the estimate', place: 'approval' });
    for (const row of rows) expect(row.target).not.toHaveProperty('action');
  });

  it('ready to publish, and paused for review', () => {
    const ready = facts({ stage: 'publish', done: ['story', 'style', 'plan', 'draw'], pages: 3, planned: 3, drawn: 3, current: 3, next: 'publish' });
    expect(table(ready)[4]).toEqual(['Publish', 'Now', 'Ready to publish', 'Read and publish', 'read']);
    expect(table({ ...ready, paused: true, next: 'see_paused' })[4]).toEqual(['Publish', 'Now', 'Paused for review', 'See why it is paused', 'share']);
  });

  it('published: every stage done; the last says whether changes wait, and goes to them', () => {
    const done = facts({ stage: 'publish', done: ['story', 'style', 'plan', 'draw', 'publish'], pages: 3, planned: 3, drawn: 3, current: 2, outOfDate: 1, next: 'read' });
    expect(stageMapRows(done).map((r) => r.state)).toEqual(['done', 'done', 'done', 'done', 'done']);
    expect(table(done).slice(3)).toEqual([
      ['Draw', 'Done', '1 page out of date', 'Open Pages', 'pages'],
      ['Publish', 'Published', 'Nothing left', 'Read your comic', 'read']
    ]);
    expect(table({ ...done, next: 'update_published' })[4]).toEqual(['Publish', 'Published', 'Changes not published yet', 'Publish your changes', 'share']);
    // One row leads (the map opens on it): Publish's, the comic's next step, never the first done row.
    expect(stageMapRows(done).map((r) => r.leads)).toEqual([false, false, false, false, true]);
  });

  it('live with a new page to draw: Publish stays done and says the new work is not out yet', () => {
    const rows = stageMapRows(facts({ stage: 'draw', done: ['story', 'style', 'plan', 'publish'], pages: 4, planned: 4, drawn: 3, current: 3, next: 'draw_rest' }));
    expect(rows.map((r) => r.state)).toEqual(['done', 'done', 'done', 'current', 'done']);
    expect(rows[4].left).toBe('Live · new pages not published yet');
  });

  it('says what the strip says: the current row leads to the strip’s own next step', () => {
    const doc = createEmptyDoc('c1', 'Salt Road', 1);
    doc.brief.premise = 'A road along the salt flats.';
    const view = comicStage(doc);
    const rows = stageMapRows(stageFacts(doc));
    const current = rows.find((r) => r.state === 'current')!;
    expect(current.target).toEqual({ label: view.next.label, place: view.next.place });
    expect(rows.filter((r) => r.leads)).toEqual([current]);
  });
});
