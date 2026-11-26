/**
 * My comics' card (SH-B): one control per job and none inside another, the next step as a deep link that only opens a
 * place, Read only once a page is drawn, every older action in the ⋯ menu, a cover box sized before it loads, the
 * phone row, and no colour or price anywhere on it. Synthetic comics only.
 */
import React from 'react';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postcss from 'postcss';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComicState, Project } from '../../../types';
import type { StageFacts } from '../../../shared/comic/stage';
import { myComicCard, type CardStageRow } from './homeModel';
import { DUPLICATE_UNAVAILABLE_FOR_STUDIO, MY_COMIC_CARD, MY_COMIC_COVER, MyComicCard, MyComicCardPlaceholder, studioHref, type MyComicCardActions } from './MyComicCard';

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 10, 20, 12);

beforeEach(() => {
  // jsdom has no ResizeObserver; the menu's popper measures with it.
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const state = (patch: Record<string, unknown> = {}): ComicState =>
  ({
    step: 0, maxStepReached: 0, script: '', scenes: [], styleVariants: [], stylePrompt: '', styleCategory: '', styleAspectRatio: '2:3',
    imageResolution: '2K', characters: [], items: [], locations: [], layoutType: 'grid', panels: [], ...patch
  }) as ComicState;
const studio = (patch: Record<string, unknown> = {}, row: Partial<Project> = {}): Project => ({
  id: 's1', name: 'Spice Market', createdAt: NOW - 30 * HOUR, updatedAt: NOW - 2 * HOUR,
  state: state({ studioVersion: 4, studioPages: 12, studioRendered: 6, coverImageUrl: 'https://cdn.test/cover.webp', ...patch }), ...row
});
const classic = (patch: Record<string, unknown> = {}): Project => ({
  id: 'c1', name: 'Old Wizard Comic', createdAt: NOW - 30 * HOUR, updatedAt: NOW - 2 * HOUR, state: state({ pipelineMode: 'classic', ...patch })
});
const draw = (drawn: number, next: StageFacts['next'] = 'draw_rest'): StageFacts => ({
  v: 1, stage: 'draw', done: ['story', 'style', 'plan'], pages: 12, planned: 12, drawn, current: drawn, outOfDate: 0, drawing: 0, withheld: 0, failed: 0, looks: 0, paused: false, next
});

const actions = (): MyComicCardActions => ({
  open: vi.fn(), read: vi.fn(), startRename: vi.fn(), finishRename: vi.fn(), toggleFeatured: vi.fn(), details: vi.fn(), duplicate: vi.fn(), askDelete: vi.fn()
});

const renderCard = (project: Project, row?: CardStageRow, opts: { status?: 'loading' | 'settled'; renaming?: boolean; priority?: boolean } = {}) => {
  const a = actions();
  const model = myComicCard(project, row, opts.status ?? 'settled', NOW, 'en');
  const utils = render(<MyComicCard project={project} model={model} renaming={!!opts.renaming} priority={opts.priority} actions={a} />);
  const card = screen.getByRole('article', { name: project.name.trim() || 'Untitled comic' });
  return { ...utils, card, actions: a, model };
};

const flush = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));
const openMenu = async (card: HTMLElement, title: string) => {
  const trigger = within(card).getByRole('button', { name: `More for ${title}` });
  trigger.focus();
  fireEvent.keyDown(trigger, { key: 'Enter' });
  await flush();
  return screen.getByRole('menu');
};

const tokens = (el: Element): string[] => (el.getAttribute('class') ?? '').split(/\s+/).filter(Boolean);
const INTERACTIVE = 'a[href],button,input,select,textarea,[role="button"],[role="link"],[role="menuitem"],[tabindex]:not([tabindex="-1"])';

describe('MyComicCard: structure', () => {
  it('is an article named by its title, whose heading holds the one primary control, and no control holds another', () => {
    const { card } = renderCard(studio(), { stage: draw(6), attention: null });
    const heading = within(card).getByRole('heading', { level: 3, name: 'Spice Market' });
    const controls = heading.querySelectorAll(INTERACTIVE);
    expect(controls).toHaveLength(1);
    expect(controls[0]).toHaveAttribute('data-card-primary');
    expect(controls[0].tagName).toBe('BUTTON');
    for (const control of card.querySelectorAll(INTERACTIVE)) {
      expect(control.querySelector(INTERACTIVE), control.outerHTML.slice(0, 80)).toBeNull();
    }
    // In reading order: the title, the ⋯ menu, the next step, Read.
    expect(within(card).getAllByRole('button').map((b) => b.getAttribute('aria-label') ?? b.textContent)).toEqual(['Spice Market', 'More for Spice Market', 'Read Spice Market']);
    expect(within(card).getAllByRole('link')).toHaveLength(1);
  });

  it('a tap anywhere on the card opens the comic as it was left; its own controls never also open it', () => {
    const { card, actions: a } = renderCard(studio(), { stage: draw(6), attention: null });
    fireEvent.click(within(card).getByText('6 of 12 pages drawn · edited 2 hours ago'));
    expect(a.open).toHaveBeenCalledExactlyOnceWith('s1', null);
    fireEvent.click(within(card).getByRole('button', { name: 'Read Spice Market' }));
    expect(a.read).toHaveBeenCalledExactlyOnceWith('s1');
    fireEvent.click(within(card).getByRole('link', { name: /^Next:/ }));
    expect(a.open).toHaveBeenCalledTimes(2);
    expect(a.open).toHaveBeenLastCalledWith('s1', 'pages');
  });
});

describe('MyComicCard: stage, status and the next step', () => {
  it('shows the five stages as ink marks, the stage word, the status line and a next step that deep-links', () => {
    const { card } = renderCard(studio(), { stage: draw(6), attention: null });
    const line = card.querySelector('[data-slot="stage-line"]') as HTMLElement;
    expect([...line.querySelectorAll('[data-stage-mark]')].map((m) => m.getAttribute('data-stage-mark'))).toEqual(['done', 'done', 'done', 'current', 'upcoming']);
    expect(line).toHaveTextContent('Stage 4 of 5: Drawing');
    const status = within(card).getByText('6 of 12 pages drawn · edited 2 hours ago');
    expect(status).toHaveAttribute('title', '6 of 12 pages drawn · edited 2 hours ago');
    expect(tokens(status)).toEqual(expect.arrayContaining(['truncate', 'min-w-0']));
    const next = within(card).getByRole('link', { name: 'Next: draw the rest, Spice Market' });
    expect(next).toHaveAttribute('href', studioHref('s1', 'pages'));
    expect(studioHref('s1', 'pages')).toBe('/?view=studio&id=s1&task=pages');
    expect(next).toHaveAccessibleDescription('Opens the comic’s Pages tab');
  });

  it('a new tab or a modifier click follows the link; a plain click opens here and nothing starts', () => {
    const { card, actions: a } = renderCard(studio(), { stage: draw(6), attention: null });
    const next = within(card).getByRole('link', { name: /^Next:/ });
    const withCtrl = new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true });
    next.dispatchEvent(withCtrl);
    expect(withCtrl.defaultPrevented).toBe(false);
    expect(a.open).not.toHaveBeenCalled();
    const plain = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    next.dispatchEvent(plain);
    expect(plain.defaultPrevented).toBe(true);
    expect(a.open).toHaveBeenCalledExactlyOnceWith('s1', 'pages');
  });

  it('Needs you: an ink chip on the cover, and the next step is what waits', () => {
    const { card } = renderCard(studio(), { stage: draw(6, 'review_estimate'), attention: 'approval' });
    expect(card).toHaveAttribute('data-needs-you', 'true');
    const chip = within(card).getByText('Needs you');
    expect(tokens(chip)).toEqual(expect.arrayContaining(['text-[var(--ds-ink)]', 'bg-[var(--ds-raised)]']));
    expect(within(card).getByRole('link', { name: 'Next: review the estimate, Spice Market' })).toHaveAttribute('href', '/?view=studio&id=s1&task=conversation');
  });

  it('a finished comic: Read is the next step and the only button beside the menu', () => {
    const done: StageFacts = { ...draw(12, 'read'), stage: 'publish', done: ['story', 'style', 'plan', 'draw', 'publish'] };
    const { card } = renderCard(studio({ studioRendered: 12 }), { stage: done, attention: null });
    expect(within(card).queryByRole('link')).toBeNull();
    const read = within(card).getByRole('button', { name: 'Read Spice Market' });
    expect(read).toHaveAttribute('data-variant', 'outline');
    expect(within(card).getByText('Every stage done:')).toHaveClass('sr-only');
    expect(within(card).getByText('Published')).toBeInTheDocument();
  });

  it('no Read before a page is drawn', () => {
    const { card } = renderCard(studio({ studioRendered: 0 }), { stage: draw(0, 'draw_pages'), attention: null });
    expect(within(card).queryByRole('button', { name: /^Read/ })).toBeNull();
    expect(within(card).getByRole('link', { name: 'Next: draw the pages, Spice Market' })).toBeInTheDocument();
  });

  it('an older comic reads "Open to see" with its row counts and a plain Open; while the read runs, a placeholder', () => {
    const older = renderCard(studio({ studioPages: 10, studioRendered: 3 }), { attention: null });
    expect(within(older.card).getByText('Open to see')).toBeInTheDocument();
    expect(within(older.card).getByText('3 of 10 pages drawn · edited 2 hours ago')).toBeInTheDocument();
    const open = within(older.card).getByRole('link', { name: 'Open, Spice Market' });
    expect(open).toHaveAttribute('href', '/?view=studio&id=s1');
    fireEvent.click(open);
    expect(older.actions.open).toHaveBeenCalledExactlyOnceWith('s1', null);
    cleanup();
    const pending = renderCard(studio(), undefined, { status: 'loading' });
    const line = pending.card.querySelector('[data-slot="stage-line"]') as HTMLElement;
    expect(line.querySelector('[data-slot="skeleton"]')).not.toBeNull();
    expect(line.textContent).toBe('');
  });

  it('a classic comic: its editor, its step, Edit (a button: no studio URL), and a build’s progress', () => {
    const { card, actions: a } = renderCard(classic({ generationStatus: { isActive: true, progress: 40, estimatedTimeRemaining: '2m', logs: [] } }));
    expect(within(card).getByText('Classic editor')).toBeInTheDocument();
    expect(within(card).getByRole('progressbar', { name: 'Building' })).toHaveAttribute('aria-valuetext', '40%, about 2m left');
    expect(within(card).queryByRole('link')).toBeNull();
    fireEvent.click(within(card).getByRole('button', { name: 'Edit, Old Wizard Comic' }));
    expect(a.open).toHaveBeenCalledExactlyOnceWith('c1', null);
  });
});

describe('MyComicCard: the ⋯ menu keeps every older action', () => {
  it('studio: Rename, Mark as featured, Details, Duplicate (disabled, with the reason) and Delete…', async () => {
    const { card, actions: a } = renderCard(studio(), { stage: draw(6), attention: null });
    const menu = await openMenu(card, 'Spice Market');
    const items = within(menu).getAllByRole('menuitem');
    expect(items.map((i) => i.getAttribute('aria-label') ?? i.textContent)).toEqual(['Rename', 'Mark as featured', 'Details', DUPLICATE_UNAVAILABLE_FOR_STUDIO, 'Delete…']);
    const duplicate = within(menu).getByRole('menuitem', { name: DUPLICATE_UNAVAILABLE_FOR_STUDIO });
    expect(duplicate).toHaveAttribute('aria-disabled', 'true');
    expect(duplicate).toHaveTextContent('Not yet for studio comics');
    fireEvent.click(duplicate);
    expect(a.duplicate).not.toHaveBeenCalled();
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Mark as featured' }));
    await flush();
    expect(a.toggleFeatured).toHaveBeenCalledExactlyOnceWith('s1');
    expect(screen.queryByRole('menu')).toBeNull();
    for (const [name, fn] of [['Rename', a.startRename], ['Details', a.details], ['Delete…', a.askDelete]] as const) {
      fireEvent.click(within(await openMenu(card, 'Spice Market')).getByRole('menuitem', { name }));
      await flush();
      expect(fn).toHaveBeenCalledExactlyOnceWith('s1');
    }
  });

  it('classic: Duplicate works; a featured comic shows its star and offers to unmark it', async () => {
    const { card, actions: a } = renderCard(classic({ isFeatured: true }));
    expect(within(card).getByRole('img', { name: 'Featured' })).toBeInTheDocument();
    const menu = await openMenu(card, 'Old Wizard Comic');
    expect(within(menu).getByRole('menuitem', { name: 'Unmark as featured' })).toBeInTheDocument();
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Duplicate' }));
    expect(a.duplicate).toHaveBeenCalledExactlyOnceWith('c1');
  });

  it('rename: the title becomes a field; Enter saves and focus comes back to the title', () => {
    const project = studio();
    const a = actions();
    const model = myComicCard(project, { stage: draw(6), attention: null }, 'settled', NOW, 'en');
    const view = render(<MyComicCard project={project} model={model} renaming actions={a} />);
    const field = screen.getByRole('textbox', { name: 'Comic title' });
    expect(field).toHaveFocus();
    fireEvent.change(field, { target: { value: 'The Spice Thief' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(a.finishRename).toHaveBeenCalledExactlyOnceWith('s1', 'The Spice Thief');
    view.rerender(<MyComicCard project={project} model={model} renaming={false} actions={a} />);
    expect(screen.getByRole('button', { name: 'Spice Market' })).toHaveFocus();
  });

  it('rename: Escape cancels; leaving the field saves and leaves focus where it went', () => {
    const project = studio();
    const a = actions();
    const model = myComicCard(project, undefined, 'settled', NOW, 'en');
    const view = render(<><MyComicCard project={project} model={model} renaming actions={a} /><button type="button">Elsewhere</button></>);
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Comic title' }), { key: 'Escape' });
    expect(a.finishRename).toHaveBeenCalledExactlyOnceWith('s1', null);
    view.rerender(<><MyComicCard project={project} model={model} renaming={false} actions={a} /><button type="button">Elsewhere</button></>);
    view.rerender(<><MyComicCard project={project} model={model} renaming actions={a} /><button type="button">Elsewhere</button></>);
    const field = screen.getByRole('textbox', { name: 'Comic title' });
    fireEvent.change(field, { target: { value: 'Kept' } });
    const elsewhere = screen.getByRole('button', { name: 'Elsewhere' });
    elsewhere.focus();
    fireEvent.blur(field);
    expect(a.finishRename).toHaveBeenLastCalledWith('s1', 'Kept');
    view.rerender(<><MyComicCard project={project} model={model} renaming={false} actions={a} /><button type="button">Elsewhere</button></>);
    expect(elsewhere).toHaveFocus();
  });
});

describe('MyComicCard: the cover', () => {
  it('is a box of fixed proportions before anything loads, its picture lazy and decorative', () => {
    const { card } = renderCard(studio(), { stage: draw(6), attention: null });
    const box = card.querySelector('[data-slot="my-comic-cover"]') as HTMLElement;
    expect(tokens(box)).toEqual(expect.arrayContaining(['aspect-[3/4]', 'sm:aspect-[4/3]', 'relative', 'overflow-hidden']));
    const img = box.querySelector('img') as HTMLImageElement;
    expect(img).toHaveAttribute('src', 'https://cdn.test/cover.webp');
    expect(img).toHaveAttribute('alt', '');
    expect(img).toHaveAttribute('loading', 'lazy');
    expect(img).toHaveAttribute('decoding', 'async');
    // Laid over the reserved box, framed from the top: it never changes the card's size.
    expect(tokens(img)).toEqual(expect.arrayContaining(['absolute', 'inset-0', 'object-cover', 'object-top']));
  });

  it('the first row loads at once; a failed picture falls back to the next one, then to a drawing', () => {
    const project = studio({ panels: [{ id: 'p', imageUrl: 'https://cdn.test/panel.webp' }] });
    const { card } = renderCard(project, { stage: draw(6), attention: null }, { priority: true });
    const first = card.querySelector('[data-slot="my-comic-cover"] img') as HTMLImageElement;
    expect(first).toHaveAttribute('loading', 'eager');
    expect(first).toHaveAttribute('fetchpriority', 'high');
    act(() => void fireEvent.error(first));
    const second = card.querySelector('[data-slot="my-comic-cover"] img') as HTMLImageElement;
    expect(second).toHaveAttribute('src', 'https://cdn.test/panel.webp');
    expect(second).toHaveAttribute('loading', 'lazy');
    act(() => void fireEvent.error(second));
    expect(card.querySelector('[data-slot="my-comic-cover"] img')).toBeNull();
    expect(card.querySelector('[data-slot="cover-empty"]')).not.toBeNull();
  });

  it('with no picture at all: the drawing in the same box', () => {
    const { card } = renderCard(studio({ coverImageUrl: undefined }), { stage: draw(0, 'draw_pages'), attention: null });
    expect(card.querySelector('[data-slot="my-comic-cover"] [data-slot="cover-empty"] svg')).not.toBeNull();
  });
});

describe('MyComicCard: no colour, no spark, no price', () => {
  it('reads ink and paper only: no hue, wash, spark, studio or art tint, no fill, no money', () => {
    const { container } = renderCard(studio(), { stage: draw(6, 'review_estimate'), attention: 'approval' });
    expect(container.innerHTML).not.toMatch(/--ds-(?:hue|wash|spark|studio|art-|chart-seq|chart-div)/);
    expect(container.querySelector('[data-variant="create"], [data-variant="default"]')).toBeNull();
    expect(container.textContent).not.toMatch(/\$|¢|USD|cents?\b/);
  });
});

/** The app folder, where tailwind.config.cjs lives. */
const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const req = createRequire(path.join(APP_ROOT, 'package.json'));
const tailwindConfig = req(path.join(APP_ROOT, 'tailwind.config.cjs'));
const compile = async (classes: string[]): Promise<postcss.Root> => {
  const tailwind = req('tailwindcss') as (config: unknown) => postcss.AcceptedPlugin;
  const result = await postcss([tailwind({ ...tailwindConfig, content: [{ raw: `<div class="${classes.join(' ')}"></div>`, extension: 'html' }] })]).process('@tailwind utilities;', { from: undefined });
  return postcss.parse(result.css);
};
const rule = (root: postcss.Root, cls: string) => {
  const found: Array<{ decls: Record<string, string>; media: string | null }> = [];
  root.walkRules((r) => {
    if (r.selector.replace(/\\2c /g, ',').replace(/\\/g, '') !== `.${cls}`) return;
    const decls: Record<string, string> = {};
    r.walkDecls((d) => void (decls[d.prop] = d.value));
    found.push({ decls, media: r.parent?.type === 'atrule' ? (r.parent as postcss.AtRule).params : null });
  });
  expect(found, cls).toHaveLength(1);
  return found[0];
};

describe('MyComicCard on a phone (360 px, 16 px gutters)', () => {
  it('is a row below 640 px (the cover in a 6 rem column, the buttons across both) and a column from 640 px', async () => {
    const { card } = renderCard(studio(), { stage: draw(6), attention: null });
    expect(tokens(card)).toEqual(expect.arrayContaining(MY_COMIC_CARD.split(' ')));
    const root = await compile([...MY_COMIC_CARD.split(' '), ...MY_COMIC_COVER.split(' '), 'col-span-2']);
    expect(rule(root, 'grid-cols-[6rem_minmax(0,1fr)]')).toEqual({ decls: { 'grid-template-columns': '6rem minmax(0,1fr)' }, media: null });
    expect(rule(root, 'sm:flex')).toEqual({ decls: { display: 'flex' }, media: '(min-width: 640px)' });
    expect(rule(root, 'sm:aspect-[4/3]').media).toBe('(min-width: 640px)');
    // The buttons span both columns of the row.
    expect(tokens(card.querySelector('[data-slot="card-actions"]')!)).toContain('col-span-2');
    // At 360 px the card is 328 px (16 px gutters): 12 px padding, a 96 px cover, a 12 px gap, 196 px of words.
    const inner = 360 - 2 * 16 - 2 - 2 * 12;
    expect(inner - 96 - 12).toBeGreaterThanOrEqual(180);
  });

  it('nothing can push the card wider than its column: every text clips or wraps, every flex child may shrink', () => {
    const { card } = renderCard(studio({}, { name: 'An Exceptionally Long Comic Title That Has To Clip Inside Its Card Without Pushing Anything' }), { stage: draw(6), attention: null });
    expect(tokens(card)).toEqual(expect.arrayContaining(['min-w-0', 'overflow-hidden']));
    const title = card.querySelector('[data-card-primary] [data-user-content]')!;
    expect(tokens(title)).toEqual(expect.arrayContaining(['line-clamp-2', '[overflow-wrap:anywhere]']));
    const next = within(card).getByRole('link', { name: /^Next:/ });
    expect(tokens(next)).toEqual(expect.arrayContaining(['min-w-0', 'flex-1']));
    expect(next.querySelector('[data-slot="button-label"]')).toHaveClass('truncate');
    expect(tokens(card.querySelector('[data-slot="card-actions"]')!)).toEqual(expect.arrayContaining(['flex-wrap', 'min-w-0']));
  });

  it('every control is a 44 px target on a coarse pointer', () => {
    const { card } = renderCard(studio(), { stage: draw(6), attention: null });
    for (const control of [within(card).getByRole('link', { name: /^Next:/ }), within(card).getByRole('button', { name: 'Read Spice Market' })]) {
      expect(tokens(control)).toContain('coarse:min-h-[var(--ds-density-touch)]');
    }
    expect(tokens(within(card).getByRole('button', { name: 'More for Spice Market' }))).toEqual(
      expect.arrayContaining(['coarse:min-h-[var(--ds-density-touch)]', 'coarse:min-w-[var(--ds-density-touch)]'])
    );
    // The title's own control reaches 44 px through its hit area.
    expect(tokens(within(card).getByRole('button', { name: 'Spice Market' }))).toEqual(expect.arrayContaining(["coarse:before:-inset-3"]));
  });

  it('the placeholder has the same footprint as a card', () => {
    const { container } = render(<MyComicCardPlaceholder />);
    const box = container.firstElementChild as HTMLElement;
    expect(box).toHaveAttribute('aria-hidden', 'true');
    expect(tokens(box)).toEqual(expect.arrayContaining(MY_COMIC_CARD.split(' ')));
    expect(tokens(box.querySelector('[data-slot="skeleton"]')!)).toEqual(expect.arrayContaining(['aspect-[3/4]', 'sm:aspect-[4/3]']));
  });
});
