/**
 * The app's root boundary on the DS (DS-2): a render crash shows the DS error state on the canvas with
 * Reload and the "Helpful?" vote, reports the crash, and never puts the error's message on screen.
 */
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../services/telemetry', () => ({ captureEvent: vi.fn() }));
vi.mock('../feedback/FeedbackButtons', () => ({ FeedbackButtons: () => <span data-testid="feedback-buttons" /> }));

import { captureEvent } from '../../services/telemetry';
import { ErrorBoundary } from './ErrorBoundary';

const Boom: React.FC = () => {
  throw new Error('secret stack detail');
};
const classesIn = (root: Element): string[] => [root, ...root.querySelectorAll('*')].flatMap((el) => (el.getAttribute('class') ?? '').split(/\s+/)).filter(Boolean);

beforeEach(() => vi.spyOn(console, 'error').mockImplementation(() => undefined));
afterEach(() => vi.restoreAllMocks());

describe('ErrorBoundary (the app root)', () => {
  it('renders its children when nothing breaks', () => {
    render(
      <ErrorBoundary>
        <p>the app</p>
      </ErrorBoundary>
    );
    expect(screen.getByText('the app')).toBeInTheDocument();
  });

  it('shows the DS error state on the canvas, reports the crash, and keeps the message off the screen', () => {
    const reload = vi.fn();
    vi.spyOn(window, 'location', 'get').mockReturnValue({ ...window.location, reload } as Location);
    const { container } = render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>
    );
    const alert = screen.getByRole('alert');
    expect(alert).toHaveAttribute('data-slot', 'error-state');
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('Something went wrong');
    expect(container.querySelector('[data-slot="app-crash"]')!.className).toContain('bg-[var(--ds-canvas)]');
    expect(screen.queryByText(/secret stack detail/)).toBeNull();
    expect(screen.getByTestId('feedback-buttons')).toBeInTheDocument();
    expect(captureEvent).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'app_crash', severity: 'critical', message: 'secret stack detail' }));
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    expect(reload).toHaveBeenCalledTimes(1);
    expect(classesIn(container).filter((c) => /border-black|shadow-comic|font-comic|font-display|text-red-|bg-gray-/.test(c))).toEqual([]);
  });
});
