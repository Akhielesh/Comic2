import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ShortcutsHelp } from './ShortcutsHelp';

describe('ShortcutsHelp', () => {
  it('renders nothing when closed', () => {
    render(<ShortcutsHelp open={false} onClose={vi.fn()} />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('lists shortcuts and closes on backdrop click', () => {
    const onClose = vi.fn();
    render(<ShortcutsHelp open onClose={onClose} />);
    expect(screen.getByRole('dialog', { name: /keyboard shortcuts/i })).toBeInTheDocument();
    expect(screen.getByText('Command palette')).toBeInTheDocument();
    expect(screen.getAllByText('Build & run').length).toBeGreaterThan(0);
    expect(screen.getByText(/auto-saves on Build/i)).toBeInTheDocument();
    // backdrop is the outermost div; click it to close
    fireEvent.click(screen.getByRole('dialog').parentElement as HTMLElement);
    expect(onClose).toHaveBeenCalled();
  });

  it('closes on Escape (from anywhere)', () => {
    const onClose = vi.fn();
    render(<ShortcutsHelp open onClose={onClose} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });
});
