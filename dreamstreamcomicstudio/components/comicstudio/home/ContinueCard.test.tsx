import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ComicState, Project } from '../../../types';

vi.mock('../../common/SmartImage', () => ({
  SmartImage: ({ src, alt, className, ...rest }: { src: string; alt: string; className?: string } & Record<string, unknown>) => (
    <img src={src} alt={alt} className={className} width={rest.width as number} height={rest.height as number} fetchPriority={rest.fetchPriority as 'high'} />
  )
}));

import { ContinueCard } from './ContinueCard';
import type { CardStageRow } from './homeModel';
import type { StageFacts } from '../../../shared/comic/stage';

const NOW = Date.UTC(2026, 10, 19, 12);
/** A card's status line as it reads (its parts are kept whole, so it is several elements; no-break spaces read as spaces). */
const statusOf = (el: ParentNode) => el.querySelector('[data-slot="card-status"]')?.textContent?.replace(/\s+/g, ' ');

const project = (patch: Record<string, unknown> = {}, row: Partial<Project> = {}): Project => ({
  id: 'studio-7',
  name: 'Harbour Lights',
  createdAt: NOW - 86_400_000,
  updatedAt: NOW - 2 * 3_600_000,
  state: {
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
    panels: [],
    studioVersion: 4,
    studioPages: 10,
    studioRendered: 3,
    coverImageUrl: '/assets/comic-sample/last-tram-page-1-480.webp',
    ...patch
  } as ComicState,
  ...row
});

const renderCard = (p: Project = project(), stage?: { row?: CardStageRow; status?: 'loading' | 'settled' }) => {
  const onOpen = vi.fn();
  const onRead = vi.fn();
  const utils = render(<ContinueCard project={p} now={NOW} locale="en" onOpen={onOpen} onRead={onRead} stageRow={stage?.row} stageStatus={stage?.status} />);
  return { ...utils, onOpen, onRead };
};

/** The saved stage of a comic drawing 3 of its 10 pages (as the server writes it on save). */
const drawing: StageFacts = { v: 1, stage: 'draw', done: ['story', 'style', 'plan'], pages: 10, planned: 10, drawn: 3, current: 3, outOfDate: 0, drawing: 0, withheld: 0, failed: 0, looks: 0, paused: false, next: 'draw_rest' };

describe('ContinueCard', () => {
  it('Continue opens the comic once, and so does a press anywhere on the card', () => {
    const { onOpen, onRead } = renderCard();
    fireEvent.click(screen.getByRole('button', { name: /^Continue/ }));
    expect(onOpen).toHaveBeenCalledExactlyOnceWith('studio-7', null);
    expect(statusOf(document)).toBe('3 of 10 pages drawn · edited 2 hours ago');
    fireEvent.click(document.querySelector('[data-slot="card-status"]')!);
    expect(onOpen).toHaveBeenCalledTimes(2);
    expect(onOpen).toHaveBeenLastCalledWith('studio-7', null);
    expect(onRead).not.toHaveBeenCalled();
  });

  it('Read opens the reader without also opening the studio', () => {
    const { onOpen, onRead } = renderCard();
    fireEvent.click(screen.getByRole('button', { name: /Read/ }));
    expect(onRead).toHaveBeenCalledExactlyOnceWith('studio-7');
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('hides Read while nothing is drawn', () => {
    renderCard(project({ studioRendered: 0 }));
    expect(screen.queryByRole('button', { name: /Read/ })).toBeNull();
    expect(screen.getByRole('button', { name: /^Continue/ })).toBeInTheDocument();
  });

  it('has one accessible name, "Continue {title}"', () => {
    renderCard();
    const card = screen.getByRole('region', { name: 'Continue Harbour Lights' });
    expect(screen.getAllByRole('region')).toHaveLength(1);
    expect(within(card).getByRole('heading', { name: 'Harbour Lights' })).toBeInTheDocument();
    expect(statusOf(card)).toBe('3 of 10 pages drawn · edited 2 hours ago');
    // A comic saved before stages says so, instead of a guessed stage.
    expect(within(card).getByText('Open to see')).toBeInTheDocument();
  });

  it('names an untitled comic', () => {
    renderCard(project({}, { name: '  ' }));
    expect(screen.getByRole('region', { name: 'Continue Untitled comic' })).toBeInTheDocument();
  });

  it('paints the cover first, sized and framed from the top', () => {
    renderCard();
    const cover = screen.getByAltText('Harbour Lights cover');
    expect(cover).toHaveAttribute('src', '/assets/comic-sample/last-tram-page-1-480.webp');
    expect(cover).toHaveAttribute('fetchpriority', 'high');
    expect(cover).toHaveAttribute('width');
    expect(cover).toHaveAttribute('height');
    expect(cover.className).toContain('object-top');
  });

  it('carries no fill: no spark, accent or ink-primary button', () => {
    const { container } = renderCard();
    expect(container.querySelector('[data-variant="create"], [data-variant="default"]')).toBeNull();
    expect(container.innerHTML).not.toMatch(/spark|accent-fill|--ds-accent\)|bg-\[var\(--ds-accent/);
    for (const button of screen.getAllByRole('button')) {
      expect(['outline', 'ghost']).toContain(button.getAttribute('data-variant'));
    }
  });

  it('shows the comic’s stage and its next step, which opens the studio where the step is worked', () => {
    const { onOpen, container } = renderCard(project(), { row: { stage: drawing, attention: null } });
    const card = screen.getByRole('region', { name: 'Continue Harbour Lights' });
    expect(within(card).getByText('Drawing')).toBeInTheDocument();
    expect(within(card).getByText('Stage 4 of 5:')).toHaveClass('sr-only');
    expect(container.querySelectorAll('[data-stage-mark]')).toHaveLength(5);
    expect(statusOf(card)).toBe('3 of 10 pages drawn · edited 2 hours ago');
    const next = within(card).getByRole('link', { name: 'Next: draw the rest, Harbour Lights' });
    expect(next).toHaveAttribute('href', '/?view=studio&id=studio-7&task=pages');
    expect(next).toHaveAccessibleDescription('Opens the comic’s Pages tab');
    // An ink outline, like the buttons beside it: no fill.
    expect(next.className).toContain('bg-[var(--ds-raised)]');
    fireEvent.click(next);
    expect(onOpen).toHaveBeenCalledExactlyOnceWith('studio-7', 'pages');
    expect(within(card).queryByRole('button', { name: /^Continue/ })).toBeNull();
  });

  it('on a phone the buttons run under the cover and the words, so the next step keeps its words; beside the cover from 640 px', () => {
    renderCard(project(), { row: { stage: drawing, attention: null } });
    const card = screen.getByTestId('continue-card');
    expect(card.className).toContain('grid-cols-[5rem_minmax(0,1fr)]');
    expect(card.className).toContain('sm:grid-cols-[7rem_minmax(0,1fr)]');
    const actions = card.querySelector('[data-slot="continue-actions"]') as HTMLElement;
    expect(actions.className.split(' ')).toEqual(expect.arrayContaining(['col-span-2', 'sm:col-span-1', 'sm:col-start-2', 'flex-wrap']));
    expect(actions.contains(screen.getByRole('link', { name: /^Next:/ }))).toBe(true);
    expect(screen.getByRole('link', { name: /^Next:/ }).querySelector('[data-slot="button-label"]')).not.toHaveClass('truncate');
  });

  it('while the stage read runs, the stage line is a placeholder of the same height', () => {
    const { container } = renderCard(project(), { status: 'loading' });
    const line = container.querySelector('[data-slot="stage-line"]') as HTMLElement;
    expect(line.querySelector('[data-slot="skeleton"]')).not.toBeNull();
    expect(line.className).toContain('h-5');
    expect(line.textContent).toBe('');
  });

  it('shows no price', () => {
    const { container } = renderCard();
    expect(container.textContent).not.toMatch(/\$|¢/);
  });
});
