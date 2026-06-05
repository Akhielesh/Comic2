import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { EmptyState } from './EmptyState';

describe('EmptyState', () => {
  it('renders the art, title, description and action', () => {
    render(
      <EmptyState art={<svg data-testid="art" />} title="Nothing here" description="Make something">
        <button>Go</button>
      </EmptyState>
    );
    expect(screen.getByTestId('art')).toBeInTheDocument();
    expect(screen.getByText('Nothing here')).toBeInTheDocument();
    expect(screen.getByText('Make something')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Go' })).toBeInTheDocument();
  });
});
