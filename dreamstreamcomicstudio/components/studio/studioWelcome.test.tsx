import React from 'react';
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { StudioWelcome } from './StudioWelcome';

beforeEach(() => {
  try { window.localStorage.clear(); } catch { /* ignore */ }
});

describe('StudioWelcome', () => {
  it('shows on first run and persists dismissal', () => {
    const { unmount } = render(<StudioWelcome />);
    expect(screen.getByText(/welcome to code studio/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /got it/i }));
    expect(screen.queryByText(/welcome to code studio/i)).not.toBeInTheDocument();
    expect(window.localStorage.getItem('studio.onboarded')).toBe('1');

    // a fresh mount stays dismissed
    unmount();
    render(<StudioWelcome />);
    expect(screen.queryByText(/welcome to code studio/i)).not.toBeInTheDocument();
  });
});
