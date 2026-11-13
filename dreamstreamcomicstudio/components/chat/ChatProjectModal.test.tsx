import React, { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ChatProjectModal } from './ChatProjectModal';
import type { ChatProject } from '../../services/chatStorage';
import { resetBackStack } from '../comicstudio/mobile/backStack';

afterEach(() => { cleanup(); resetBackStack(); });

function Harness({ project = null, onSave = vi.fn() }: { project?: ChatProject | null; onSave?: (...args: string[]) => void }) {
  const [open, setOpen] = useState(false);
  return <><button onClick={() => setOpen(true)}>Open project</button><button>Outside</button>{open && <ChatProjectModal project={project} onClose={() => setOpen(false)} onSave={(...args) => { onSave(...args); setOpen(false); }} />}</>;
}
const open = () => {
  const trigger = screen.getByRole('button', { name: 'Open project' });
  trigger.focus();
  fireEvent.click(trigger);
  return trigger;
};

describe('Chat project dialog', () => {
  it('creates a named project with the chosen icon and color, without accepting a blank name', async () => {
    const onSave = vi.fn();
    render(<Harness onSave={onSave} />);
    const trigger = open();
    const dialog = screen.getByRole('dialog', { name: 'New project' });
    expect(within(dialog).getByRole('textbox', { name: 'Project name' })).toHaveFocus();
    expect(within(dialog).getByRole('button', { name: 'Create' })).toBeDisabled();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '  Research  ' } });
    fireEvent.click(within(screen.getByRole('group', { name: 'Project icon' })).getByRole('button', { name: 'book' }));
    fireEvent.click(within(screen.getByRole('group', { name: 'Project color' })).getByRole('button', { name: 'green' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    expect(onSave).toHaveBeenCalledWith('Research', 'book', 'green');
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it('keeps existing project choices and saves edited text with Enter after composition ends', () => {
    const onSave = vi.fn();
    render(<Harness project={{ id: 'p1', name: 'Work', icon: 'rocket', color: 'teal', createdAt: 1, updatedAt: 1 }} onSave={onSave} />);
    open();
    expect(screen.getByRole('dialog', { name: 'Edit project' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'rocket' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'teal' })).toHaveAttribute('aria-pressed', 'true');
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: '旅行' } });
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 229 });
    expect(onSave).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 13 });
    expect(onSave).toHaveBeenCalledWith('旅行', 'rocket', 'teal');
  });

  it('Escape discards unsaved changes and returns focus to the exact opener', async () => {
    const onSave = vi.fn();
    render(<Harness onSave={onSave} />);
    const trigger = open();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Uncommitted' } });
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(onSave).not.toHaveBeenCalled();
    open();
    expect(screen.getByRole('textbox')).toHaveValue('');
  });
});
