import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CommandPalette, type Command } from './CommandPalette';

const makeCommands = (): { commands: Command[]; build: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> } => {
  const build = vi.fn();
  const stop = vi.fn();
  return {
    build, stop,
    commands: [
      { id: 'build', label: 'Build & run', keywords: 'agent', run: build },
      { id: 'stop', label: 'Stop run', keywords: 'halt', run: stop },
    ],
  };
};

describe('CommandPalette', () => {
  it('renders nothing when closed', () => {
    const { commands } = makeCommands();
    render(<CommandPalette open={false} onClose={vi.fn()} commands={commands} />);
    expect(screen.queryByLabelText('Command palette')).not.toBeInTheDocument();
  });

  it('lists commands, filters by query, and runs on click', () => {
    const { commands, build, stop } = makeCommands();
    render(<CommandPalette open onClose={vi.fn()} commands={commands} />);
    expect(screen.getByText('Build & run')).toBeInTheDocument();
    expect(screen.getByText('Stop run')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Command'), { target: { value: 'halt' } });
    expect(screen.queryByText('Build & run')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('Stop run'));
    expect(stop).toHaveBeenCalledTimes(1);
    expect(build).not.toHaveBeenCalled();
  });

  it('closes on Escape', () => {
    const onClose = vi.fn();
    const { commands } = makeCommands();
    render(<CommandPalette open onClose={onClose} commands={commands} />);
    fireEvent.keyDown(screen.getByLabelText('Command palette'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('runs the selected command on Enter', () => {
    const { commands, build } = makeCommands();
    render(<CommandPalette open onClose={vi.fn()} commands={commands} />);
    fireEvent.keyDown(screen.getByLabelText('Command palette'), { key: 'Enter' });
    expect(build).toHaveBeenCalledTimes(1); // first command selected by default
  });
});
