import React from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { vi } from 'vitest';
import { labelInName } from '../mobile/testing/labelInName';
import { ActivityLine, activityCost, savedSince } from './ActivityLine';
import { makeFakeStudio, makeSampleDoc, resetUsageStatus, showDollarPrices } from './testing/fixtures';
import type { ActivityItem } from '../types';

// Dollar figures below are what admins / own-key users see; the governed wording has its own tests.
beforeEach(showDollarPrices);
afterEach(resetUsageStatus);

const item = (id: string, label: string, cost?: 'free' | 'text' | 'image'): ActivityItem =>
  ({ id, label, phase: 'start', at: 1, ...(cost ? { cost } : {}) }) as ActivityItem;

describe('ActivityLine', () => {
  it('with the board out of sight, the status itself opens it ("Drawing page 3… View") — one row, its name says what it shows', () => {
    const onView = vi.fn();
    render(<ActivityLine studio={makeFakeStudio({ busy: true, activity: [item('a', 'Drawing page 3', 'image')] })} onView={onView} />);
    const view = screen.getByRole('button', { name: 'Drawing page 3… View the pages' });
    expect(view.closest('[role="status"]')).not.toBeNull();
    expect(labelInName(view).ok).toBe(true);
    fireEvent.click(view);
    expect(onView).toHaveBeenCalledTimes(1);
    // Touch: a real 44 px target.
    expect(view.className).toContain('coarse:min-h-[44px]');
  });

  it('is hidden when nothing is happening', () => {
    const { container } = render(<ActivityLine studio={makeFakeStudio()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the latest step with its cost badge: Free when software does the work', () => {
    render(<ActivityLine studio={makeFakeStudio({ busy: true, activity: [item('a', 'Writing page 2', 'text'), item('b', 'Fitting page 1 to 4:5', 'free')] })} />);
    expect(screen.getByRole('status')).toHaveTextContent('Fitting page 1 to 4:5…');
    const badge = screen.getByText('Free');
    expect(badge.closest('[title]')).toHaveAttribute('title', 'Free — done by the editor, no AI cost');
    expect(screen.getByRole('button', { name: '+1' })).toHaveAttribute('title', '1 more step');
  });

  it('paid steps say so; older servers without a cost show no badge', () => {
    const { unmount } = render(<ActivityLine studio={makeFakeStudio({ busy: true, activity: [item('a', 'Drawing page 3', 'image')] })} />);
    expect(screen.getByText('Image')).toBeInTheDocument();
    unmount();
    render(<ActivityLine studio={makeFakeStudio({ busy: true, activity: [item('a', 'Drawing page 3')] })} />);
    expect(screen.queryByText('Image')).toBeNull();
    expect(screen.queryByText('Free')).toBeNull();
  });

  it('shows what software saved during the current run', () => {
    const idle = makeSampleDoc();
    idle.spend = { ...idle.spend, savedUsd: 0.1 };
    const studio = makeFakeStudio({ doc: idle });
    const { rerender } = render(<ActivityLine studio={studio} />);
    const running = makeSampleDoc();
    running.spend = { ...running.spend, savedUsd: 0.1655 };
    rerender(<ActivityLine studio={{ ...studio, doc: running, busy: true, activity: [item('a', 'Reusing page 1', 'free')] }} />);
    expect(screen.getByText(/Saved ≈\$0\.07/)).toHaveTextContent('done by software, no AI cost');
  });

  it('helpers', () => {
    expect(activityCost(item('a', 'x', 'free'))).toBe('free');
    expect(activityCost({ ...item('a', 'x'), cost: 'bogus' } as unknown as ActivityItem)).toBeUndefined();
    expect(savedSince(0.2, 0.1)).toBeCloseTo(0.1);
    expect(savedSince(0.1, 0.2)).toBe(0);
    expect(savedSince(undefined, undefined)).toBe(0);
  });
});
