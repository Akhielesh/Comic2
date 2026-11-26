// The studio's stage strip (SH-A): five ink-only steps that navigate, one status line with the next step, keyboard use,
// screen-reader names, and phone widths (360 and 320: one 44 px row, 16 px gutters, 44 px touch targets, the marks the one
// way into the stage map). Synthetic docs only.
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createEmptyDoc, type AssetRef, type ComicDoc, type Page, type RenderState } from '../../../shared/comic/doc';
import { FormFactorProvider, formFactorFor } from '../mobile/useFormFactor';
import type { FormFactor } from '../mobile/formFactor';
import { stageFacts } from '../../../shared/comic/stage';
import { pageProgress } from '../board/boardModel';
import { makeSampleDoc } from '../board/__fixtures__/sampleDoc';
import { StageStrip } from './StageStrip';

const NOW = 1_800_000_000_000;
const picture = (): AssetRef => ({ path: 'u/p/pages/a.webp', source: 'generated', at: NOW });
const render_ = (status: RenderState['status'], asset?: AssetRef): RenderState => ({ status, history: [], ...(asset ? { asset } : {}) });
const page = (n: number, r: RenderState = render_('none')): Page => ({
  id: `pg_${n}`,
  n,
  summary: '',
  layout: '',
  panels: [{ id: `pg_${n}_p1`, n: 1, size: 'medium', shot: 'medium', action: 'A beat', castIds: [], lines: [] }],
  render: r,
  balloons: []
});

/** Story and look set, 12 pages planned and approved, `drawn` of them drawn. */
const drawing = (drawn: number, pages = 12): ComicDoc => {
  const doc = createEmptyDoc('c1', 'The Night Ferry', NOW);
  doc.brief.premise = 'A ferry that only runs after midnight.';
  doc.style = { ...doc.style, status: 'drafted', name: 'Ink wash', spec: 'Soft ink washes.' };
  doc.pages = Array.from({ length: pages }, (_, i) => page(i + 1, i < drawn ? render_('ready', picture()) : render_('none')));
  doc.planStatus = 'approved';
  return doc;
};

const DESK = formFactorFor({ w: 1280, h: 800 });
const PHONE = formFactorFor({ w: 360, h: 740, coarse: true });
const SMALL_PHONE = formFactorFor({ w: 320, h: 568, coarse: true });

const mount = (doc: ComicDoc, ff: FormFactor = DESK, onGo = vi.fn(), behind?: boolean) => {
  const ui = (d: ComicDoc) => (
    <FormFactorProvider value={ff}>
      <StageStrip doc={d} onGo={onGo} behind={behind} />
    </FormFactorProvider>
  );
  const utils = render(ui(doc));
  return { ...utils, onGo, rerenderWith: (d: ComicDoc) => utils.rerender(ui(d)) };
};

const strip = () => screen.getByRole('navigation', { name: 'Comic stages' });
const steps = () => within(within(strip()).getByRole('list')).getAllByRole('button');

afterEach(cleanup);

describe('StageStrip', () => {
  it('shows the five stages in flow order: done ones with a check, the current one by ink weight', () => {
    mount(drawing(6));
    expect(steps().map((b) => b.getAttribute('aria-label') ?? b.textContent)).toEqual(['Story, done', 'Style, done', 'Plan, done', 'Draw', 'Publish']);
    const current = steps().filter((b) => b.getAttribute('aria-current') === 'step');
    expect(current).toHaveLength(1);
    expect(current[0]).toHaveTextContent('Draw');
    expect(current[0].className).toContain('font-semibold');
    expect(current[0].className).toContain('text-[var(--ds-ink)]');
    expect(screen.getByRole('button', { name: 'Publish' }).className).toContain('text-[var(--ds-muted)]');
    for (const done of steps().slice(0, 3)) {
      expect(done.querySelector('svg')).not.toBeNull(); // the check
      expect(done.className).not.toContain('font-semibold');
    }
    expect(steps()[3].querySelector('svg')).toBeNull();
  });

  it('says where the comic stands and the next step in one line', () => {
    mount(drawing(6));
    const status = strip().querySelector('[data-stage-status]') as HTMLElement;
    expect(within(status).getByTitle('Drawing · 6 of 12 pages drawn')).toHaveTextContent('Drawing · 6 of 12 pages drawn');
    const next = within(status).getByRole('button', { name: 'Next: draw the rest' });
    // Read in order (the hidden hint aside), the line is "Drawing · 6 of 12 pages drawn · Next: draw the rest".
    const shown = [...status.children].filter((el) => !(el as HTMLElement).hidden).map((el) => el.textContent?.trim());
    expect(shown.join(' ')).toBe('Drawing · 6 of 12 pages drawn · Next: draw the rest');
    expect(next).toHaveAccessibleDescription('Opens the Pages tab');
  });

  it('each stage goes to where it is worked, and the next step goes to its place', () => {
    const { onGo } = mount(drawing(6));
    for (const [name, place] of [
      ['Story, done', 'story'],
      ['Style, done', 'style'],
      ['Plan, done', 'pages'],
      ['Draw', 'pages'],
      ['Publish', 'read']
    ] as const) {
      fireEvent.click(screen.getByRole('button', { name }));
      expect(onGo).toHaveBeenLastCalledWith(place);
    }
    fireEvent.click(screen.getByRole('button', { name: 'Next: draw the rest' }));
    expect(onGo).toHaveBeenLastCalledWith('pages');
    expect(onGo).toHaveBeenCalledTimes(6);
  });

  it('a new comic points at the composer; an open approval at the approval in the conversation, never at a spend', () => {
    const fresh = mount(createEmptyDoc('c0', 'Untitled comic', NOW));
    const next = screen.getByRole('button', { name: 'Next: tell the Director your idea' });
    expect(next).toHaveAccessibleDescription('Opens the message box');
    fireEvent.click(next);
    expect(fresh.onGo).toHaveBeenLastCalledWith('composer');
    cleanup();

    const doc = drawing(0);
    doc.gate = { id: 'g1', action: { type: 'render_pages' }, title: 'Draw', summary: '', estimateUsd: 0.4, imageCount: 12, model: 'm', createdAt: NOW, status: 'open', reason: 'policy' };
    const gated = mount(doc);
    const review = screen.getByRole('button', { name: 'Next: review the estimate' });
    expect(review).toHaveAccessibleDescription('Shows the approval in the conversation');
    fireEvent.click(review);
    expect(gated.onGo).toHaveBeenLastCalledWith('approval');
    expect(strip().textContent).not.toMatch(/\$|¢|\d+\s?%/);
  });

  it('a published comic the server says is behind asks to publish the changes, in the Share sheet', () => {
    const doc = drawing(4, 4);
    doc.publication = { visibility: 'unlisted', status: 'live', slug: 'night-ferry', publishedRev: 1, publishedAt: NOW + 1, languages: ['en'] };
    const { onGo } = mount(doc, DESK, vi.fn(), true);
    const next = screen.getByRole('button', { name: 'Next: publish your changes' });
    expect(next).toHaveAccessibleDescription('Opens the Share sheet');
    fireEvent.click(next);
    expect(onGo).toHaveBeenLastCalledWith('share');
    cleanup();
    mount(doc, DESK, vi.fn(), false);
    expect(screen.getByRole('button', { name: 'Next: read your comic' })).toBeTruthy();
  });

  it('counts pages the way the Board badge and the reader do: a withheld picture is never drawn, an out-of-date one is named', () => {
    const doc = drawing(12);
    doc.pages[2].render = render_('ready', { ...picture(), safety: { quarantined: true, at: NOW } });
    doc.pages[4].render = render_('stale', picture());
    for (const d of [doc, makeSampleDoc()]) expect(stageFacts(d).current).toBe(pageProgress(d).ready);
    mount(doc);
    expect(within(strip()).getByTitle('Drawing · 10 of 12 pages drawn · 1 out of date')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Next: review 1 withheld page' })).toBeTruthy();
  });

  it('keyboard: every step and the next step are native buttons in reading order; arrows, Home and End move along the steps', () => {
    mount(drawing(6));
    const buttons = within(strip()).getAllByRole('button');
    // The five steps, the next step, and the stage map (SH-C2) last.
    expect(buttons.map((b) => b.tagName)).toEqual(Array(7).fill('BUTTON'));
    expect(buttons[6]).toHaveAccessibleName('Stage map');
    for (const b of buttons) {
      expect(b).toHaveAttribute('type', 'button');
      expect(b.tabIndex).toBe(0);
      expect(b.className).toContain('focus-visible:outline');
    }
    const [story, style, , , publish] = steps();
    story.focus();
    fireEvent.keyDown(story, { key: 'ArrowRight' });
    expect(style).toHaveFocus();
    fireEvent.keyDown(style, { key: 'End' });
    expect(publish).toHaveFocus();
    fireEvent.keyDown(publish, { key: 'ArrowRight' });
    expect(publish).toHaveFocus();
    fireEvent.keyDown(publish, { key: 'Home' });
    expect(story).toHaveFocus();
    fireEvent.keyDown(story, { key: 'ArrowLeft' });
    expect(story).toHaveFocus();
  });

  it('tells a screen reader when the stage changes, not on every page drawn', () => {
    const { rerenderWith } = mount(drawing(6));
    const live = strip().querySelector('[aria-live="polite"]') as HTMLElement;
    expect(live.textContent).toBe('');
    rerenderWith(drawing(7));
    expect(live.textContent).toBe('');
    rerenderWith(drawing(12));
    expect(live.textContent).toBe('Ready to publish. Next: read and publish.');
  });

  it('uses no hue, spark, wash or art colour (ink only), at any width', () => {
    const doc = drawing(12);
    doc.publication = { visibility: 'unlisted', status: 'live', slug: 'night-ferry', publishedRev: 1, publishedAt: NOW + 1, languages: ['en'] };
    const ink = /hue|spark|accent|wash|--ds-art|studio-|success|warning|danger/;
    mount(doc);
    expect(strip().outerHTML).not.toMatch(ink);
    cleanup();
    mount(doc, PHONE);
    fireEvent.click(screen.getByRole('button', { name: /^Stages:/ }));
    expect(strip().outerHTML).not.toMatch(ink);
    expect(screen.getByRole('list', { name: 'Stage map' }).outerHTML).not.toMatch(ink);
  });

  it('desktop: one row, 12 px side padding to match the header', () => {
    mount(drawing(6));
    expect(strip()).toHaveAttribute('data-stage-strip', 'row');
    expect(strip().className).toContain('px-3');
  });

  it('phone 360: one 44 px row with 16 px gutters: the five stages as marks, and the status with its next step', () => {
    const { onGo } = mount(drawing(6), PHONE);
    expect(strip()).toHaveAttribute('data-stage-strip', 'compact');
    expect(strip().className).toContain('px-4');
    // One row only: no list of named stages until asked for.
    expect(within(strip()).queryByRole('list')).toBeNull();
    const toggle = screen.getByRole('button', { name: 'Stages: Draw, 3 of 5 done' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle.className).toContain('h-11');
    expect(toggle.className).toContain('min-w-11');
    expect([...toggle.querySelectorAll('[data-stage-mark]')].map((m) => m.getAttribute('data-stage-mark'))).toEqual(['done', 'done', 'done', 'current', 'upcoming']);
    // The status is one button: its words are its name (what you see is what a screen reader says), its place the description.
    const status = screen.getByRole('button', { name: 'Drawing · 6 of 12 pages drawn · Next: draw the rest' });
    expect(status.className).toContain('min-h-11');
    expect(status).toHaveAccessibleDescription('Opens the Pages tab');
    // It is the button's label, so it wraps rather than cut a word (the layout smoke counts a cut label as clutter).
    expect(status.innerHTML).not.toContain('truncate');
    fireEvent.click(status);
    expect(onGo).toHaveBeenLastCalledWith('pages');
  });

  it('phone 360: the marks are the one way into the stage map; choosing a stage goes there and closes it', async () => {
    const { onGo } = mount(drawing(6), PHONE);
    // One control for the stages: no second map button beside the marks, no row of named stages.
    expect(within(strip()).getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual([
      'Stages: Draw, 3 of 5 done',
      'Drawing · 6 of 12 pages drawn · Next: draw the rest'
    ]);
    const toggle = screen.getByRole('button', { name: /^Stages:/ });
    expect(toggle).toHaveAttribute('aria-haspopup', 'dialog');
    expect(toggle).toHaveAttribute('title', 'Stage map');
    toggle.focus();
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const sheet = screen.getByRole('dialog', { name: 'Stage map' });
    // Every stage by name, what is left in it, and a way there; it opens on the next step.
    expect(within(sheet).getAllByRole('listitem').map((li) => li.querySelector('p')?.textContent)).toEqual([
      'Story · Done',
      'Style · Done',
      'Plan · Done',
      'Draw · Now',
      'Publish · Next'
    ]);
    await waitFor(() => expect(within(sheet).getByRole('button', { name: 'Draw the rest' })).toHaveFocus());
    for (const b of within(sheet).getAllByRole('button', { name: /^(Open|Draw)/ })) expect(b.className).toContain('coarse:h-11');
    fireEvent.click(within(sheet).getByRole('button', { name: 'Open Style' }));
    expect(onGo).toHaveBeenLastCalledWith('style');
    expect(screen.queryByRole('dialog', { name: 'Stage map' })).toBeNull();
    expect(toggle).toHaveFocus();
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    // Escape closes it too, back on the marks.
    fireEvent.click(toggle);
    await waitFor(() => expect(within(screen.getByRole('dialog', { name: 'Stage map' })).getByRole('button', { name: 'Draw the rest' })).toHaveFocus());
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Stage map' })).toBeNull();
    expect(toggle).toHaveFocus();
    expect(onGo).toHaveBeenCalledTimes(1);
  });

  it('phone: the marks are drawn in the text colour (SVG), so the current stage keeps its dot in forced colours', () => {
    mount(drawing(6), PHONE);
    const marks = [...screen.getByRole('button', { name: /^Stages:/ }).querySelectorAll('[data-stage-mark]')];
    const [current, upcoming] = [marks[3], marks[4]];
    expect(current.querySelector('circle')).toHaveAttribute('fill', 'currentColor');
    expect(upcoming.querySelector('circle')).toHaveAttribute('fill', 'none');
    expect(upcoming.querySelector('circle')).toHaveAttribute('stroke', 'currentColor');
    // No mark relies on a background fill, which forced colours replace.
    for (const mark of marks) expect(mark.innerHTML).not.toMatch(/bg-\[/);
  });

  it('phone 320: the map names every stage, done ones included, with the current one as the step', () => {
    mount(drawing(12), SMALL_PHONE);
    fireEvent.click(screen.getByRole('button', { name: 'Stages: Publish, 4 of 5 done' }));
    const rows = within(screen.getByRole('list', { name: 'Stage map' })).getAllByRole('listitem');
    expect(rows.map((r) => r.querySelector('p')?.textContent)).toEqual(['Story · Done', 'Style · Done', 'Plan · Done', 'Draw · Done', 'Publish · Now']);
    expect(rows[4]).toHaveAttribute('aria-current', 'step');
    for (const row of rows) expect(row.querySelector('.sr-only')).toBeNull();
  });

  it('a book-posture foldable keeps the strip on the first screen', () => {
    const rect = (x: number, w: number) => ({ x, y: 0, width: w, height: 720, top: 0, left: x, right: x + w, bottom: 720, toJSON: () => ({}) }) as DOMRectReadOnly;
    const fold = formFactorFor({ w: 1100, h: 720, coarse: true, segments: { count: 2, axis: 'horizontal', rects: [rect(0, 540), rect(560, 540)], hinge: { start: 540, end: 560 } } });
    mount(drawing(6), fold);
    expect(strip()).toHaveAttribute('data-stage-strip', 'compact');
    expect(strip().style.maxWidth).toBe('534px');
  });
});
