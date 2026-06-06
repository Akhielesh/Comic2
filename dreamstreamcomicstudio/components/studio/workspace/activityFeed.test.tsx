import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ActivityFeed } from './ActivityFeed';
import { useStudioActivity } from './activityStore';

describe('ActivityFeed', () => {
  beforeEach(() => useStudioActivity.getState().reset());

  it('renders nothing when idle with no items', () => {
    const { container } = render(<ActivityFeed />);
    expect(container.firstChild).toBeNull();
  });

  it('shows a Retry button on failure and calls onRetry', () => {
    useStudioActivity.getState().begin();
    useStudioActivity.getState().finish('error', 'Generation failed.');
    const onRetry = vi.fn();
    render(<ActivityFeed onRetry={onRetry} />);
    fireEvent.click(screen.getByText('Retry'));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('does not show Retry on a successful run', () => {
    useStudioActivity.getState().begin();
    useStudioActivity.getState().finish('done', '✓ Built "X" — 2 files');
    render(<ActivityFeed onRetry={() => {}} />);
    expect(screen.queryByText('Retry')).toBeNull();
    expect(screen.getByText(/Built/)).toBeInTheDocument();
  });
});
