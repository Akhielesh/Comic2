// PreviewFrame coverage (S1.4): toolbar controls + device toggle.

import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { PreviewFrame } from './PreviewFrame';

describe('PreviewFrame', () => {
  it('renders the preview iframe and the device toggle, refresh + open-in-tab', () => {
    render(<PreviewFrame url="https://preview.example.dev" />);
    expect(screen.getByTitle('Live preview')).toBeInTheDocument();
    // three device options, desktop active by default
    expect(screen.getAllByRole('radio').length).toBe(3);
    expect(screen.getByRole('radio', { name: /Desktop/i })).toHaveAttribute('aria-checked', 'true');
    // open-in-new-tab links to the url
    expect(screen.getByTitle('Open in a new tab')).toHaveAttribute('href', 'https://preview.example.dev');
    expect(screen.getByTitle('Reload preview')).toBeInTheDocument();
  });

  it('switches the active device on click', () => {
    render(<PreviewFrame url="https://preview.example.dev" />);
    fireEvent.click(screen.getByRole('radio', { name: /Mobile/i }));
    expect(screen.getByRole('radio', { name: /Mobile/i })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: /Desktop/i })).toHaveAttribute('aria-checked', 'false');
  });
});
