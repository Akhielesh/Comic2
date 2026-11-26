/**
 * My comics on a touch screen (AH-5, then SH-B). A comic card's Read / Open / Info row used to show only while the card
 * was hovered; a phone has no hover, so AH-5 kept that row always shown there, along the bottom of the cover, each
 * button at least 44 px.
 *
 * SH-B rebuilt the cards and removed the hover row altogether: every card shows its controls at all times, under its
 * words (the next step and Read), with the ⋯ menu beside the title, on every screen, mouse or finger. So nothing on a
 * card is ever invisible and still takes a tap, and every control is a 44 px target on a coarse pointer. A press on
 * the cover is a press on the card: it opens the comic, the one control its heading holds (as the Library's cards do).
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
import { fireEvent, render, screen, within } from '@testing-library/react';
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

import { ProjectDashboard } from './ProjectDashboard';

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

const tokens = (el: Element): string[] => (el.getAttribute('class') ?? '').split(/\s+/).filter(Boolean);

const renderDashboard = (projects: Project[]) => {
  const noop = vi.fn();
  const onOpenProject = vi.fn();
  const onReadProject = vi.fn();
  const utils = render(
    <ProjectDashboard
      projects={projects}
      onCreateProject={noop}
      onOpenProject={onOpenProject}
      onDeleteProject={noop}
      onDuplicateProject={noop}
      onReadProject={onReadProject}
      onUpdateProject={noop}
      onNavigate={noop}
    />
  );
  return { ...utils, onOpenProject, onReadProject };
};

/** Each card and every control it holds. */
const renderCards = (projects: Project[] = [studioProject, classicProject, blankStudioProject, generatingProject]) => {
  const view = renderDashboard(projects);
  const cards = projects.map((p) => {
    const card = screen.getByRole('heading', { name: p.name }).closest('article') as HTMLElement;
    return { name: p.name, card, controls: [...card.querySelectorAll<HTMLElement>('a[href],button')] };
  });
  return { ...view, cards };
};

/** The app folder (this file's parent's parent), where tailwind.config.cjs lives. */
const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const req = createRequire(path.join(APP_ROOT, 'package.json'));

const tailwindConfig = req(path.join(APP_ROOT, 'tailwind.config.cjs')) as { theme: { screens: Record<string, string | { raw: string }> } };

/** The CSS this app's Tailwind (its own config) builds for a class list, parsed back from the text a browser gets. */
const compile = async (classes: string[]): Promise<postcss.Root> => {
  const tailwind = req('tailwindcss') as (config: unknown) => postcss.AcceptedPlugin;
  const result = await postcss([tailwind({ ...tailwindConfig, content: [{ raw: `<div class="${classes.join(' ')}"></div>`, extension: 'html' }] })]).process('@tailwind utilities;', { from: undefined });
  return postcss.parse(result.css);
};

const squeeze = (text: string): string => text.replace(/\s+/g, '');

/** The app's own words for "a mouse": the `can-hover` screen, `(hover: hover) and (pointer: fine)`. */
const CAN_HOVER = (tailwindConfig.theme.screens['can-hover'] as { raw: string }).raw;
/** A coarse pointer (a finger): the `coarse` screen. */
const COARSE = (tailwindConfig.theme.screens.coarse as { raw: string }).raw;

/** Whether a rule sits inside the coarse-pointer media query. */
const isTouchMedia = (node: postcss.Node | undefined): boolean => {
  if (node?.type !== 'atrule') return false;
  const at = node as postcss.AtRule;
  return at.name === 'media' && squeeze(at.params) === squeeze(COARSE);
};

/** What a screen's main pointer reports to CSS. */
interface Pointer {
  hover: 'hover' | 'none';
  pointer: 'fine' | 'coarse' | 'none';
}

/**
 * Whether a media query matches a pointer. It reads the two shapes used here and no other: `(a: b) and (c: d)`, with
 * or without `not all and` in front.
 */
const mediaMatches = (params: string, device: Pointer): boolean => {
  const query = squeeze(params);
  if (!/^(notalland)?\([a-z-]+:[a-z]+\)(and\([a-z-]+:[a-z]+\))*$/.test(query)) throw new Error(`cannot read the media query "${params}"`);
  const every = [...query.matchAll(/\(([a-z-]+):([a-z]+)\)/g)].every(([, feature, value]) => (device as unknown as Record<string, string>)[feature] === value);
  return query.startsWith('notalland') ? !every : every;
};

interface BuiltRule {
  /** What the class declares, as { property: value }. */
  decls: Record<string, string>;
  /** Whether its rule sits inside the coarse-pointer media query (a finger). */
  touchOnly: boolean;
  /** The media query around its rule, or null when it applies everywhere. */
  media: string | null;
  /** The rule's place in the stylesheet: itself, or the media block around it. */
  top: postcss.ChildNode;
}

/** The rule Tailwind built for one class. */
const ruleFor = (root: postcss.Root, className: string): BuiltRule => {
  const found: BuiltRule[] = [];
  root.walkRules((rule) => {
    // A class written with `has-[>svg]:` builds `.class:has(>svg)`, and one with `before:` builds `.class::before`: the
    // rule for that class all the same.
    const selector = rule.selector.replace(/\\/g, '');
    if (selector !== `.${className}` && selector !== `.${className}:has(>svg)` && selector !== `.${className}::before`) return;
    const decls: Record<string, string> = {};
    rule.walkDecls((d) => {
      decls[d.prop] = d.value;
    });
    const media = rule.parent?.type === 'atrule' && (rule.parent as postcss.AtRule).name === 'media' ? (rule.parent as postcss.AtRule).params : null;
    found.push({ decls, touchOnly: isTouchMedia(rule.parent), media, top: (rule.parent?.type === 'root' ? rule : rule.parent) as postcss.ChildNode });
  });
  if (found.length !== 1) throw new Error(`Tailwind built ${found.length} rules for "${className}", expected 1`);
  return found[0];
};

describe('My comics on a touch screen: every control always shown, every one a 44 px target', () => {
  it('a card never hides a control: nothing waits for hover, nothing is invisible and still takes a tap', () => {
    const { cards } = renderCards();
    for (const { name, card, controls } of cards) {
      expect(controls.length, name).toBeGreaterThanOrEqual(3);
      // No control, nor anything around it, is see-through until hovered or focused.
      for (const control of controls) {
        for (let el: HTMLElement | null = control; el; el = el.parentElement) expect(tokens(el), `${name}: ${control.textContent}`).not.toContain('opacity-0');
      }
      for (const el of [card, ...card.querySelectorAll<HTMLElement>('*')]) {
        const hover = tokens(el).filter((t) => /(^|:)group-hover:|has-\[:focus-visible\]:opacity|:opacity-100$/.test(t));
        expect(hover, `${name}: ${el.tagName}`).toEqual([]);
      }
    }
  });

  it('a studio card shows its title, ⋯, the next step and Read; a classic card shows Edit; each says which comic', () => {
    const { cards } = renderCards([studioProject, classicProject]);
    const names = (controls: HTMLElement[]) => controls.map((c) => c.getAttribute('aria-label') ?? c.textContent);
    expect(names(cards[0].controls)).toEqual(['Spice Market', 'More for Spice Market', 'Open, Spice Market', 'Read Spice Market']);
    expect(names(cards[1].controls)).toEqual(['Old Wizard Comic', 'More for Old Wizard Comic', 'Edit, Old Wizard Comic']);
  });

  it('a press on the cover opens the comic once (the title’s control), never Read', () => {
    const { cards, onOpenProject, onReadProject } = renderCards([studioProject]);
    fireEvent.click(cards[0].card.querySelector('[data-slot="my-comic-cover"]') as HTMLElement);
    expect(onOpenProject).toHaveBeenCalledExactlyOnceWith('studio-1');
    expect(onReadProject).not.toHaveBeenCalled();
  });

  it("on a coarse pointer every control is at least 44 px, in rules the app's Tailwind builds for a finger only", async () => {
    const { cards } = renderCards([studioProject]);
    const { controls } = cards[0];
    const title = controls.find((c) => c.hasAttribute('data-card-primary'))!;
    const rest = controls.filter((c) => c !== title);
    const classes = [...new Set(controls.flatMap(tokens))];
    const root = await compile(classes);
    // Buttons and the next-step link: a 44 px minimum height (the ⋯ button: 44 by 44).
    for (const control of rest) expect(tokens(control), control.getAttribute('aria-label') ?? '').toContain('coarse:min-h-[var(--ds-density-touch)]');
    expect(tokens(rest[0])).toContain('coarse:min-w-[var(--ds-density-touch)]');
    const min = ruleFor(root, 'coarse:min-h-[var(--ds-density-touch)]');
    expect(min).toMatchObject({ decls: { 'min-height': 'var(--ds-density-touch)' }, touchOnly: true });
    expect(mediaMatches(min.media ?? '', { hover: 'none', pointer: 'coarse' })).toBe(true);
    expect(mediaMatches(min.media ?? '', { hover: 'hover', pointer: 'coarse' })).toBe(true);
    expect(mediaMatches(min.media ?? '', { hover: 'hover', pointer: 'fine' })).toBe(false);
    // The title's control reaches 44 px through a hit area 12 px past each edge of its (at least 20 px) line.
    const hit = ruleFor(root, 'coarse:before:-inset-3');
    expect(hit.touchOnly).toBe(true);
    expect(hit.decls).toMatchObject({ inset: '-0.75rem' });
    // A mouse keeps the plain small sizes: the 44 px rules are not in the mouse's media.
    expect(mediaMatches(CAN_HOVER, { hover: 'hover', pointer: 'fine' })).toBe(true);
  });

  it('on the narrowest phone (320 px) the buttons share the row and wrap rather than push past the card', () => {
    const { cards } = renderCards([studioProject]);
    const { card } = cards[0];
    const actions = card.querySelector('[data-slot="card-actions"]') as HTMLElement;
    expect(tokens(actions)).toEqual(expect.arrayContaining(['flex', 'flex-wrap', 'min-w-0', 'col-span-2']));
    const next = within(card).getByRole('link', { name: 'Open, Spice Market' });
    // The next step takes the rest of the row and may shrink; its words wrap inside it before it pushes, never cut.
    expect(tokens(next)).toEqual(expect.arrayContaining(['flex-1', 'min-w-0', 'h-auto']));
    expect(next.querySelector('[data-slot="button-label"]')).toHaveClass('whitespace-normal');
    expect(next.querySelector('[data-slot="button-label"]')).not.toHaveClass('truncate');
    // At 320 px the row is 262 px (16 px gutters, a 1 px edge, 12 px padding): Read (about 74 px) and an 8 px gap leave
    // the next step 180 px, past its 44 px floor.
    const row = 320 - 2 * 16 - 2 - 2 * 12;
    expect(row - 74 - 8).toBeGreaterThanOrEqual(44);
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
