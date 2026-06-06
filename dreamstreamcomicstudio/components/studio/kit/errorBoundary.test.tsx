import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { StudioErrorBoundary } from './ErrorBoundary';

const Boom: React.FC<{ explode: boolean }> = ({ explode }) => {
  if (explode) throw new Error('kaboom detail');
  return <div>recovered child</div>;
};

describe('StudioErrorBoundary', () => {
  beforeEach(() => vi.spyOn(console, 'error').mockImplementation(() => {}));
  afterEach(() => vi.restoreAllMocks());

  it('renders children when there is no error', () => {
    render(
      <StudioErrorBoundary>
        <div>healthy</div>
      </StudioErrorBoundary>
    );
    expect(screen.getByText('healthy')).toBeInTheDocument();
  });

  it('shows the recoverable fallback when a child throws, and exposes the error detail', () => {
    render(
      <StudioErrorBoundary>
        <Boom explode />
      </StudioErrorBoundary>
    );
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByText('Something went wrong')).toBeInTheDocument();
    expect(screen.getByText('Try again')).toBeInTheDocument();
    // Error detail is collapsible.
    fireEvent.click(screen.getByText('Show details'));
    expect(screen.getByText('kaboom detail')).toBeInTheDocument();
  });

  it('"Try again" re-mounts the subtree (recovers when the child stops throwing)', () => {
    const { rerender } = render(
      <StudioErrorBoundary>
        <Boom explode />
      </StudioErrorBoundary>
    );
    expect(screen.getByRole('alert')).toBeInTheDocument();
    // Fix the underlying cause, then reset.
    rerender(
      <StudioErrorBoundary>
        <Boom explode={false} />
      </StudioErrorBoundary>
    );
    fireEvent.click(screen.getByText('Try again'));
    expect(screen.getByText('recovered child')).toBeInTheDocument();
  });
});
