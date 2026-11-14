import React, { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ChatProjectModal } from './ChatProjectModal';
import { ChatSidebar } from './ChatSidebar';
import type { ChatProject } from '../../services/chatStorage';
import { resetBackStack } from '../comicstudio/mobile/backStack';

afterEach(() => { cleanup(); resetBackStack(); });

function Harness({ project = null, onSave = vi.fn() }: { project?: ChatProject | null; onSave?: (...args: string[]) => void }) {
  const [open, setOpen] = useState(false);
  return <><button onClick={() => setOpen(true)}>Open project</button><button>Outside</button>{open && <ChatProjectModal project={project} onClose={() => setOpen(false)} onSave={(...args) => { onSave(...args); setOpen(false); }} />}</>;
}
function SidebarHarness() {
  const [project, setProject] = useState<ChatProject>({ id: 'p1', name: 'Work', icon: 'book', color: 'teal', createdAt: 1, updatedAt: 1 });
  const [editing, setEditing] = useState(false);
  const noop = () => {};
  return <>
    <ChatSidebar
      sessions={[]} projects={[project]} activeId={null} hasMemory={false}
      onSelect={noop} onNew={noop} onDelete={noop} onRename={noop} onMoveToProject={noop}
      onNewProject={noop} onEditProject={() => setEditing(true)} onDeleteProject={noop}
      onEditMemory={noop} onBack={noop} onOpenSearch={noop} onOpenLibrary={noop}
      onOpenDashboards={noop} onOpenGallery={noop} onOpenTools={noop}
    />
    {editing && <ChatProjectModal project={project} onClose={() => setEditing(false)} onSave={(name, icon, color) => {
      setProject({ ...project, name, icon, color });
      setEditing(false);
    }} />}
  </>;
}

const open = () => {
  const trigger = screen.getByRole('button', { name: 'Open project' });
  trigger.focus();
  fireEvent.click(trigger);
  return trigger;
};

describe('Chat project dialog', () => {
  it.each(['Escape', 'Save'] as const)('returns focus to the persistent sidebar project button after Edit and %s', async (action) => {
    render(<SidebarHarness />);
    const trigger = screen.getByRole('button', { name: 'Options for Work' });
    trigger.focus();
    fireEvent.click(trigger);
    const edit = screen.getByRole('button', { name: 'Edit' });
    edit.focus();
    fireEvent.click(edit);
    const dialog = screen.getByRole('dialog', { name: 'Edit project' });
    const input = within(dialog).getByRole('textbox', { name: 'Project name' });
    expect(input).toHaveFocus();
    expect(edit.isConnected).toBe(false);
    expect(within(dialog).getByRole('button', { name: 'book' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(dialog).getByRole('button', { name: 'teal' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.change(input, { target: { value: 'Updated work' } });
    if (action === 'Save') fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    else fireEvent.keyDown(input, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(trigger).toHaveAccessibleName(action === 'Save' ? 'Options for Updated work' : 'Options for Work');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });

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
