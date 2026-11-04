import React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Palette, Star } from 'lucide-react';
import { Chip } from './Chip';
import { Badge, BADGE_BASE, BADGE_VARIANT, BADGE_VARIANTS } from './Badge';
import { StatusChip, STATUS_STATES } from './StatusChip';
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle, CARD, CARD_TITLE } from './Card';
import { SectionCard } from './SectionCard';
import { PageHeader, PAGE_TITLE } from './PageHeader';
import { MetricCard, METRIC_CARD, METRIC_VALUE } from './MetricCard';
import { EmptyState, EMPTY_FRAME } from './EmptyState';
import { LoadingState } from './LoadingState';
import { ErrorState } from './ErrorState';
import { Skeleton, SKELETON_SHAPE } from './Skeleton';
import { ErrorBoundary } from './ErrorBoundary';
import { STATE_TITLE } from './stateParts';
import {
  CHIP,
  CHIP_VARIANT,
  DANGER_FILL,
  OVERLINE,
  SECTION_CARD,
  SECTION_HEADER,
  SECTION_ICON_TILE,
  SECTION_TITLE,
  STATUS_CHIP,
  STATUS_CHIP_TONE,
  STATUS_DOT,
  STATUS_SURFACE,
  TEXT_2XL,
  TEXT_3XL,
  TONE_CHIP
} from './recipes';
import { expectClasses } from './ds.testkit';

describe('Chip, Badge, StatusChip', () => {
  it('Chip: the CHIP shape with each variant, a decorative icon, the label truncating', () => {
    for (const variant of Object.keys(CHIP_VARIANT) as Array<keyof typeof CHIP_VARIANT>) {
      const { unmount } = render(
        <Chip variant={variant} icon={<Star />}>
          {variant} chip
        </Chip>
      );
      const chip = screen.getByText(`${variant} chip`).closest('[data-slot="chip"]')!;
      expectClasses(chip, CHIP, CHIP_VARIANT[variant]);
      expect(chip.querySelector('svg')!.closest('[aria-hidden="true"]')).not.toBeNull();
      unmount();
    }
  });

  it.each(BADGE_VARIANTS)('Badge %s renders its Atlas variant', (variant) => {
    render(<Badge variant={variant}>{variant}</Badge>);
    const badge = screen.getByText(variant);
    expectClasses(badge, BADGE_BASE, BADGE_VARIANT[variant]);
    expect(badge).toHaveAttribute('data-variant', variant);
  });

  it('Badge variants map Atlas onto the tokens (status tints are TONE_CHIP, destructive the danger fill)', () => {
    expect(BADGE_VARIANT.success).toBe(TONE_CHIP.success);
    expect(BADGE_VARIANT.warning).toBe(TONE_CHIP.warning);
    expect(BADGE_VARIANT.destructive).toContain(DANGER_FILL);
    expect(BADGE_BASE.split(' ')).toEqual(expect.arrayContaining(['border', 'text-xs', 'font-medium', 'px-2', 'py-0.5']));
  });

  it.each(STATUS_STATES)('StatusChip %s: the tone surface and ink, the state dot, the words', (state) => {
    render(<StatusChip state={state}>{`State ${state}`}</StatusChip>);
    const chip = screen.getByText(`State ${state}`).closest('[data-slot="status-chip"]')!;
    expectClasses(chip, STATUS_CHIP, STATUS_CHIP_TONE[state]);
    expect(chip).toHaveAttribute('data-state', state);
    const dot = chip.querySelector('[data-slot="status-dot"]')!;
    expectClasses(dot, STATUS_DOT[state]);
    expect(dot).toHaveAttribute('aria-hidden', 'true');
  });

  it('StatusChip: an icon replaces the dot, still hidden from assistive tech', () => {
    render(
      <StatusChip state="error" icon={<Star />}>
        Needs a fix
      </StatusChip>
    );
    const chip = screen.getByText('Needs a fix').closest('[data-slot="status-chip"]')!;
    expect(chip.querySelector('[data-slot="status-dot"]')).toBeNull();
    expect(chip.querySelector('svg')!.closest('[aria-hidden="true"]')).not.toBeNull();
  });
});

describe('Card, SectionCard, PageHeader, MetricCard', () => {
  it('Card and its parts: the surface, a real heading, the action beside the title', () => {
    render(
      <Card data-testid="card">
        <CardHeader>
          <CardTitle>Cast</CardTitle>
          <CardDescription>Who appears in this comic.</CardDescription>
          <CardAction>
            <button type="button">Add</button>
          </CardAction>
        </CardHeader>
        <CardContent>Body</CardContent>
        <CardFooter>Footer</CardFooter>
      </Card>
    );
    expectClasses(screen.getByTestId('card'), CARD);
    const title = screen.getByRole('heading', { level: 3, name: 'Cast' });
    expectClasses(title, CARD_TITLE);
    expect(screen.getByText('Who appears in this comic.')).toHaveClass('text-[var(--ds-muted)]');
  });

  it('SectionCard with an icon: a section labelled by its h2, the icon tile, the aside beside the title', () => {
    render(
      <SectionCard title="Look and feel" description="Fonts, colours and the reader." icon={<Palette />} aside={<StatusChip state="healthy">Saved</StatusChip>} id="look">
        Settings body
      </SectionCard>
    );
    const section = screen.getByRole('region', { name: 'Look and feel' });
    expect(section).toHaveAttribute('id', 'look');
    expectClasses(section, SECTION_CARD, 'scroll-mt-36');
    const heading = within(section).getByRole('heading', { level: 2, name: 'Look and feel' });
    expectClasses(heading, SECTION_TITLE);
    expectClasses(section.querySelector('header')!, SECTION_HEADER);
    const tile = section.querySelector('header span[aria-hidden="true"]')!;
    expectClasses(tile, SECTION_ICON_TILE);
    expect(within(section).getByText('Saved')).toBeInTheDocument();
    expect(within(section).getByText('Settings body')).toBeInTheDocument();
  });

  it('SectionCard without an icon: still a labelled section on the card recipe', () => {
    render(<SectionCard title="Danger zone">Delete the comic</SectionCard>);
    expectClasses(screen.getByRole('region', { name: 'Danger zone' }), SECTION_CARD);
  });

  it('PageHeader: the overline eyebrow, one h1 at the 30 px step, a muted description, actions', () => {
    render(<PageHeader eyebrow="Library" title="Your comics" description="Everything you have started." actions={<button type="button">New comic</button>} />);
    const h1 = screen.getByRole('heading', { level: 1, name: 'Your comics' });
    expectClasses(h1, PAGE_TITLE, TEXT_3XL);
    expectClasses(screen.getByText('Library'), OVERLINE);
    expect(screen.getByRole('button', { name: 'New comic' })).toBeInTheDocument();
  });

  it('MetricCard: a description list (name → value), tabular figures at the 30 px step, the overline name', () => {
    render(<MetricCard title="Pages drawn" value="12" meta="of 24 planned" icon={<Star />} />);
    const term = screen.getByText('Pages drawn');
    expect(term.tagName).toBe('DT');
    expectClasses(term, OVERLINE);
    const value = screen.getByText('12');
    expect(value.tagName).toBe('DD');
    expectClasses(value, METRIC_VALUE, TEXT_3XL, 'tabular-nums');
    expectClasses(term.closest('[data-slot="metric-card"]')!, METRIC_CARD);
    expect(screen.getByText('of 24 planned').tagName).toBe('DD');
  });
});

describe('EmptyState, LoadingState, ErrorState, Skeleton', () => {
  it('EmptyState is a status: its title, why and the action that fills it', () => {
    const onClick = vi.fn();
    render(<EmptyState title="No comics yet" description="Start one from a single sentence." icon={<Star />} action={{ label: 'New comic', onClick }} />);
    const status = screen.getByRole('status');
    expectClasses(status, EMPTY_FRAME.panel);
    expectClasses(within(status).getByRole('heading', { level: 3, name: 'No comics yet' }), STATE_TITLE, TEXT_2XL);
    fireEvent.click(within(status).getByRole('button', { name: 'New comic' }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('EmptyState inline and bare variants', () => {
    const { rerender } = render(<EmptyState variant="inline" title="No pages match" description="Clear the filter to see every page." action={{ label: 'Clear filter', onClick: () => undefined }} />);
    expectClasses(screen.getByRole('status'), EMPTY_FRAME.inline);
    expect(screen.getByRole('button', { name: 'Clear filter' })).toHaveAttribute('data-size', 'sm');
    rerender(<EmptyState variant="bare" title="Nothing here" description="Yet." />);
    expectClasses(screen.getByRole('status'), EMPTY_FRAME.bare);
  });

  it('LoadingState is a status in words, its spinner hidden and still under reduced motion', () => {
    const { rerender } = render(<LoadingState title="Loading your comics…" />);
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('Loading your comics…');
    const spinner = status.querySelector('svg')!;
    expect(spinner.closest('[aria-hidden="true"]')).not.toBeNull();
    expect(spinner).toHaveClass('animate-spin', 'motion-reduce:animate-none');
    rerender(<LoadingState variant="inline" title="Saving…" />);
    expect(screen.getByRole('status')).toHaveTextContent('Saving…');
    expect(screen.getByRole('status').querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
  });

  it('ErrorState is an alert with the danger surface and a retry', () => {
    const onRetry = vi.fn();
    const { rerender } = render(<ErrorState title="Your comics didn’t load" description="Check your connection." onRetry={onRetry} />);
    const alert = screen.getByRole('alert');
    expectClasses(alert, STATUS_SURFACE.error);
    expect(within(alert).getByRole('heading', { name: 'Your comics didn’t load' })).toBeInTheDocument();
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    rerender(<ErrorState variant="inline" title="Not saved" />);
    expectClasses(screen.getByRole('alert'), STATUS_SURFACE.error);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('Skeleton is hidden from assistive tech, on the shimmer block, in three shapes', () => {
    render(
      <>
        <Skeleton data-testid="block" className="h-10 w-40" />
        <Skeleton data-testid="text" shape="text" />
        <Skeleton data-testid="circle" shape="circle" className="size-10" />
      </>
    );
    for (const shape of ['block', 'text', 'circle'] as const) {
      const el = screen.getByTestId(shape);
      expect(el).toHaveAttribute('aria-hidden', 'true');
      expectClasses(el, 'studio-shimmer', SKELETON_SHAPE[shape]);
    }
  });
});

describe('ErrorBoundary', () => {
  let explode = true;
  function Fragile() {
    if (explode) throw new Error('kaboom at /internal/path');
    return <p>Recovered content</p>;
  }

  it('shows the ErrorState fallback (never the error text), reports it, and Try again renders the children again', () => {
    explode = true;
    const onError = vi.fn();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(
      <ErrorBoundary onError={onError}>
        <Fragile />
      </ErrorBoundary>
    );
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Something went wrong');
    expect(alert).not.toHaveTextContent('kaboom');
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toBeInstanceOf(Error);
    explode = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(screen.getByText('Recovered content')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
    spy.mockRestore();
  });

  it('a custom fallback gets the error and reset; a change in resetKeys clears the error', () => {
    explode = true;
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { rerender } = render(
      <ErrorBoundary resetKeys={['comic-1']} fallback={({ error }) => <p>Custom: {error.name}</p>}>
        <Fragile />
      </ErrorBoundary>
    );
    expect(screen.getByText('Custom: Error')).toBeInTheDocument();
    explode = false;
    rerender(
      <ErrorBoundary resetKeys={['comic-2']} fallback={({ error }) => <p>Custom: {error.name}</p>}>
        <Fragile />
      </ErrorBoundary>
    );
    expect(screen.getByText('Recovered content')).toBeInTheDocument();
    spy.mockRestore();
  });
});
