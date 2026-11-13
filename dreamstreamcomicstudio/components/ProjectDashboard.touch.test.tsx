/**
 * My comics on a touch screen (AH-5). A comic card's Read / Open / Info row used to show only while the card was
 * hovered. A phone has no hover, so the row stayed at opacity 0 and its invisible buttons still took taps: a tap in
 * the middle of a cover opened the editor.
 *
 * Now, where nothing can hover (`@media (hover: none)`), the row is always shown, along the bottom of the cover, and
 * each button is at least 44 px. What a cover centres (the empty-cover marks, the Generating notice) moves up by the
 * row's height there, so the row never sits on it. With a mouse nothing changes: the row is hidden until the card is
 * hovered. It also shows when the keyboard reaches one of its buttons, so a focused button is never invisible.
 *
 * The page header is part of the same promise. Its title and its New comic button sat on one row that could not
 * wrap, so on a narrow phone the row was wider than the screen: the page scrolled sideways and the browser shrank it
 * to fit, which also shrinks every button on it. The button now drops under the title when the two do not fit.
 *
 * jsdom has no media queries, so two things are checked: the classes the card renders, and the CSS this app's own
 * Tailwind builds from exactly those classes.
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postcss from 'postcss';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ComicState, Project } from '../types';

vi.mock('./comicstudio/studioApi', () => ({ streamStudio: vi.fn() }));
vi.mock('./DataRescue', () => ({ DataRescue: () => null }));
vi.mock('./ReadinessChecklist', () => ({ ReadinessChecklist: () => null }));
vi.mock('./common/SmartImage', () => ({
  SmartImage: ({ src, alt, className }: { src: string; alt: string; className?: string }) => <img src={src} alt={alt} className={className} />
}));
vi.mock('./modals/ProjectInfoModal', () => ({ ProjectInfoModal: () => null }));
vi.mock('../services/supabase', async () => ({ supabase: (await import('../services/projectRows.testkit')).fakeSupabase.client }));

import { Button } from './Button';
import { ProjectDashboard } from './ProjectDashboard';

/** The variant that holds every touch-only class: a screen where nothing can hover. */
const TOUCH = '[@media(hover:none)]:';
/** The row as it was before AH-5, and as it must stay with a mouse: centred on a dimmed cover, shown on hover. */
const MOUSE_ROW = ['absolute', 'inset-0', 'bg-black/50', 'flex', 'items-center', 'justify-center', 'opacity-0', 'group-hover:opacity-100', 'transition-opacity', 'gap-2'];

const baseState = (): ComicState => ({
  step: 0,
  maxStepReached: 0,
  script: '',
  scenes: [],
  styleVariants: [],
  stylePrompt: '',
  styleCategory: '',
  styleAspectRatio: '2:3',
  imageResolution: '2K',
  characters: [],
  items: [],
  locations: [],
  layoutType: 'grid',
  panels: []
});

const NOW = Date.UTC(2026, 9, 21);

const studioProject: Project = {
  id: 'studio-1',
  name: 'Spice Market',
  createdAt: NOW,
  updatedAt: NOW,
  state: { ...baseState(), studioVersion: 4, studioPages: 6, studioRendered: 2, coverImageUrl: 'https://cdn.example/page1.webp' } as ComicState
};
const classicProject: Project = {
  id: 'classic-1',
  name: 'Old Wizard Comic',
  createdAt: NOW - 1000,
  updatedAt: NOW - 1000,
  state: { ...baseState(), pipelineMode: 'classic' }
};

const blankStudioProject: Project = {
  id: 'studio-2',
  name: 'Blank Slate',
  createdAt: NOW - 2000,
  updatedAt: NOW - 2000,
  state: { ...baseState(), studioVersion: 4, studioPages: 0, studioRendered: 0 } as ComicState
};
const generatingProject: Project = {
  id: 'classic-2',
  name: 'Still Generating',
  createdAt: NOW - 3000,
  updatedAt: NOW - 3000,
  state: { ...baseState(), pipelineMode: 'classic', generationStatus: { isActive: true, progress: 40, estimatedTimeRemaining: '2 min' } } as ComicState
};

const tokens = (el: Element): string[] => el.className.split(/\s+/).filter(Boolean);

const renderDashboard = (projects: Project[]) => {
  const noop = vi.fn();
  return render(
    <ProjectDashboard
      projects={projects}
      onCreateProject={noop}
      onOpenProject={noop}
      onDeleteProject={noop}
      onDuplicateProject={noop}
      onReadProject={noop}
      onUpdateProject={noop}
      onNavigate={noop}
    />
  );
};

/** Each card's Read / Open (or Edit) / Info row and its three buttons. */
const renderRows = () => {
  renderDashboard([studioProject, classicProject]);
  return ['Spice Market', 'Old Wizard Comic'].map((name) => {
    const card = screen.getByRole('heading', { name }).closest('div.group') as HTMLElement;
    const row = within(card).getByRole('button', { name: /read/i }).parentElement as HTMLElement;
    const buttons = within(row).getAllByRole('button');
    return { name, row, buttons };
  });
};

/** The app folder (this file's parent's parent), where tailwind.config.cjs lives. */
const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const req = createRequire(path.join(APP_ROOT, 'package.json'));

/** The CSS this app's Tailwind (its own config) builds for a class list, parsed back from the text a browser gets. */
const compile = async (classes: string[]): Promise<postcss.Root> => {
  const tailwind = req('tailwindcss') as (config: unknown) => postcss.AcceptedPlugin;
  const config = req(path.join(APP_ROOT, 'tailwind.config.cjs'));
  const result = await postcss([tailwind({ ...config, content: [{ raw: `<div class="${classes.join(' ')}"></div>`, extension: 'html' }] })]).process('@tailwind utilities;', { from: undefined });
  return postcss.parse(result.css);
};

const isTouchMedia = (node: postcss.Node | undefined): boolean => {
  if (node?.type !== 'atrule') return false;
  const at = node as postcss.AtRule;
  return at.name === 'media' && at.params.replace(/\s+/g, '') === '(hover:none)';
};

interface BuiltRule {
  /** What the class declares, as { property: value }. */
  decls: Record<string, string>;
  /** Whether its rule sits inside `@media (hover: none)`. */
  touchOnly: boolean;
  /** The rule's place in the stylesheet: itself, or the media block around it. */
  top: postcss.ChildNode;
}

/** The rule Tailwind built for one class. */
const ruleFor = (root: postcss.Root, className: string): BuiltRule => {
  const found: BuiltRule[] = [];
  root.walkRules((rule) => {
    if (rule.selector.replace(/\\/g, '') !== `.${className}`) return;
    const decls: Record<string, string> = {};
    rule.walkDecls((d) => {
      decls[d.prop] = d.value;
    });
    found.push({ decls, touchOnly: isTouchMedia(rule.parent), top: (rule.parent?.type === 'root' ? rule : rule.parent) as postcss.ChildNode });
  });
  if (found.length !== 1) throw new Error(`Tailwind built ${found.length} rules for "${className}", expected 1`);
  return found[0];
};

/** The selectors, outside any media query, whose rule sets opacity to 1. */
const showsEverywhere = (root: postcss.Root): string[] => {
  const selectors: string[] = [];
  root.walkRules((rule) => {
    const shows = rule.nodes.some((n) => n.type === 'decl' && n.prop === 'opacity' && n.value === '1');
    if (shows && rule.parent?.type === 'root') selectors.push(rule.selector.replace(/\\/g, ''));
  });
  return selectors;
};

describe('My comics on a touch screen: Read / Open / Info', () => {
  it('finds the three buttons on a studio card and on a classic card', () => {
    const [studio, classic] = renderRows();
    expect(studio.buttons.map((b) => b.textContent)).toEqual(['Read', 'Open', 'Info']);
    expect(classic.buttons.map((b) => b.textContent)).toEqual(['Read', 'Edit', 'Info']);
  });

  it('with a mouse the row is what it was: hidden, centred on the dimmed cover, shown when the card is hovered', () => {
    for (const { name, row } of renderRows()) {
      const mouse = tokens(row).filter((t) => !t.startsWith(TOUCH) && t !== 'focus-within:opacity-100');
      expect([...mouse].sort(), name).toEqual([...MOUSE_ROW].sort());
    }
  });

  it('with a mouse each button is the plain small Button: the card adds touch-only classes and nothing else', () => {
    const [studio] = renderRows();
    const plain = render(
      <div>
        <Button size="sm">Read</Button>
        <Button size="sm" variant="secondary">Open</Button>
        <Button size="sm" variant="outline">Info</Button>
      </div>
    );
    const reference = within(plain.container).getAllByRole('button');
    studio.buttons.forEach((button, i) => {
      expect(tokens(button).filter((t) => !t.startsWith(TOUCH)), button.textContent ?? '').toEqual(tokens(reference[i]));
    });
  });

  it('the row shows when the keyboard reaches one of its buttons', () => {
    for (const { name, row } of renderRows()) expect(tokens(row), name).toContain('focus-within:opacity-100');
  });

  it('on a touch screen the row is always shown, along the bottom of the cover', () => {
    for (const { name, row } of renderRows()) {
      expect(tokens(row), name).toContain(`${TOUCH}opacity-100`);
      expect(tokens(row), name).toContain(`${TOUCH}top-auto`);
    }
  });

  it('on a touch screen each button is a target of at least 44 px', () => {
    for (const { buttons } of renderRows()) {
      expect(buttons).toHaveLength(3);
      for (const button of buttons) {
        expect(tokens(button), button.textContent ?? '').toContain(`${TOUCH}min-h-[44px]`);
        expect(tokens(button), button.textContent ?? '').toContain(`${TOUCH}min-w-[44px]`);
      }
    }
  });

  it('on a touch screen what a cover centres sits above the row: the empty-cover marks and the Generating notice', async () => {
    renderDashboard([blankStudioProject, classicProject, generatingProject]);
    const notice = screen.getByText('Generating...').parentElement as HTMLElement;
    const centred = [screen.getByText('Nothing drawn yet').parentElement as HTMLElement, ...screen.getAllByText('?'), notice];
    expect(centred).toHaveLength(4);
    for (const el of centred) {
      expect(tokens(el), el.textContent ?? '').toContain(`${TOUCH}pb-16`);
      // Nothing else changed on them: with a mouse they are centred in the whole cover, as before.
      expect(tokens(el).filter((t) => t.startsWith(TOUCH))).toEqual([`${TOUCH}pb-16`]);
      expect(tokens(el)).toEqual(expect.arrayContaining(['flex', 'items-center', 'justify-center']));
    }

    // On the smallest phones the notice is short of room: its progress bar keeps its height instead of shrinking to 0.
    const bar = notice.children[1];
    expect(tokens(bar).filter((t) => t.startsWith(TOUCH))).toEqual([`${TOUCH}shrink-0`]);

    // The room kept under them (4rem = 64 px) covers the row's buttons (44 px) and the gap under them (0.5rem = 8 px).
    const row = within(notice.parentElement as HTMLElement).getByRole('button', { name: /read/i }).parentElement as HTMLElement;
    const root = await compile([...tokens(notice), ...tokens(bar), ...tokens(row), ...tokens(row.children[0])]);
    const room = ruleFor(root, `${TOUCH}pb-16`);
    expect(room).toMatchObject({ decls: { 'padding-bottom': '4rem' }, touchOnly: true });
    expect(ruleFor(root, `${TOUCH}min-h-[44px]`).decls).toEqual({ 'min-height': '44px' });
    expect(ruleFor(root, `${TOUCH}pb-2`).decls).toEqual({ 'padding-bottom': '0.5rem' });
    expect(ruleFor(root, `${TOUCH}shrink-0`)).toMatchObject({ decls: { 'flex-shrink': '0' }, touchOnly: true });
    // Later in the stylesheet than the Generating notice's own padding (p-4), so it wins there.
    expect(root.index(ruleFor(root, 'p-4').top)).toBeLessThan(root.index(room.top));
  });

  it("the app's Tailwind builds those classes into rules that apply only where nothing can hover, and win there", async () => {
    const [{ row, buttons }] = renderRows();
    const rowTouch = tokens(row).filter((t) => t.startsWith(TOUCH));
    const buttonTouch = tokens(buttons[0]).filter((t) => t.startsWith(TOUCH));
    const root = await compile([...tokens(row), ...tokens(buttons[0])]);

    // With a mouse: hidden, then shown by hover or by keyboard focus. These rules sit outside any media query.
    expect(ruleFor(root, 'opacity-0')).toMatchObject({ decls: { opacity: '0' }, touchOnly: false });
    expect(showsEverywhere(root)).toEqual(expect.arrayContaining(['.group:hover .group-hover:opacity-100', '.focus-within:opacity-100:focus-within']));

    // On a touch screen: shown, along the bottom edge (top: auto), with no dim over the whole cover.
    expect(rowTouch.length).toBeGreaterThan(0);
    const rowDecls: Record<string, string> = {};
    for (const cls of rowTouch) {
      const rule = ruleFor(root, cls);
      expect(rule.touchOnly, `${cls} applies only inside @media (hover: none)`).toBe(true);
      Object.assign(rowDecls, rule.decls);
    }
    expect(rowDecls).toMatchObject({ opacity: '1', top: 'auto', 'background-color': 'transparent' });

    // Each button: at least 44 by 44 px.
    expect(buttonTouch.length).toBeGreaterThan(0);
    const buttonDecls: Record<string, string> = {};
    for (const cls of buttonTouch) {
      const rule = ruleFor(root, cls);
      expect(rule.touchOnly, `${cls} applies only inside @media (hover: none)`).toBe(true);
      Object.assign(buttonDecls, rule.decls);
    }
    expect(buttonDecls).toMatchObject({ 'min-height': '44px', 'min-width': '44px' });

    // Same specificity as the mouse rules, so the touch rules must come later in the stylesheet to win.
    const order = (cls: string) => root.index(ruleFor(root, cls).top);
    const touchAt = order(`${TOUCH}opacity-100`);
    for (const base of ['opacity-0', 'inset-0', 'bg-black/50', 'px-4']) expect(order(base), base).toBeLessThan(touchAt);
  });
});

describe('My comics on a phone: the header', () => {
  it('the New comic button drops under the title when the two do not fit side by side', async () => {
    renderDashboard([studioProject]);
    const title = screen.getByRole('heading', { level: 1, name: 'My comics' });
    const create = screen.getByRole('button', { name: /new comic/i });
    // The row that holds both: the nearest ancestor of the title that also holds the button.
    let header = title.parentElement as HTMLElement;
    while (!header.contains(create)) header = header.parentElement as HTMLElement;

    // As before on a wide screen: one row, title on the left, button on the right, centred on each other.
    expect(tokens(header)).toEqual(expect.arrayContaining(['flex', 'items-center', 'justify-between', 'mb-8']));
    // New: the row may wrap, with a gap between its two lines (and between its two halves).
    expect(tokens(header)).toEqual(expect.arrayContaining(['flex-wrap', 'gap-4']));
    expect([...tokens(header)].sort()).toEqual(['flex', 'flex-wrap', 'gap-4', 'items-center', 'justify-between', 'mb-8']);

    const root = await compile(tokens(header));
    expect(ruleFor(root, 'flex-wrap')).toMatchObject({ decls: { 'flex-wrap': 'wrap' }, touchOnly: false });
    expect(ruleFor(root, 'gap-4')).toMatchObject({ decls: { gap: '1rem' }, touchOnly: false });
  });
});
