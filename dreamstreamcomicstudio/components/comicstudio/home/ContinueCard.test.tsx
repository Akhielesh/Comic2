import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ComicState, Project } from '../../../types';

vi.mock('../../common/SmartImage', () => ({
  SmartImage: ({ src, alt, className, ...rest }: { src: string; alt: string; className?: string } & Record<string, unknown>) => (
    <img src={src} alt={alt} className={className} width={rest.width as number} height={rest.height as number} fetchPriority={rest.fetchPriority as 'high'} />
  )
}));

import { ContinueCard } from './ContinueCard';

const NOW = Date.UTC(2026, 10, 19, 12);

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

const renderCard = (p: Project = project()) => {
  const onOpen = vi.fn();
  const onRead = vi.fn();
  const utils = render(<ContinueCard project={p} now={NOW} locale="en" onOpen={onOpen} onRead={onRead} />);
  return { ...utils, onOpen, onRead };
};

describe('ContinueCard', () => {
  it('Continue opens the comic once, and so does a press anywhere on the card', () => {
    const { onOpen, onRead } = renderCard();
    fireEvent.click(screen.getByRole('button', { name: /^Continue/ }));
    expect(onOpen).toHaveBeenCalledExactlyOnceWith('studio-7');
    fireEvent.click(screen.getByText('3 of 10 pages · edited 2 hours ago'));
    expect(onOpen).toHaveBeenCalledTimes(2);
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
    expect(within(card).getByText('3 of 10 pages · edited 2 hours ago')).toBeInTheDocument();
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

  it('shows no price', () => {
    const { container } = renderCard();
    expect(container.textContent).not.toMatch(/\$|¢/);
  });
});
