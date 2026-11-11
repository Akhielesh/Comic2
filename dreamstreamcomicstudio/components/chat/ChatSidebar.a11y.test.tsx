// CHAT-0 (nav N-8): chat rows were `div onClick` — unreachable by keyboard — and the sidebar's menus
// closed only on an outside mouse click. Rows are real buttons now (in the tab order, the open chat
// marked `aria-current`), and Escape closes every menu and hands focus back to its button.
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { ChatSidebar } from './ChatSidebar';
import { createChatProject, createEmptySession, type ChatSession } from '../../services/chatStorage';

const chat = (title: string, extra: Partial<ChatSession> = {}): ChatSession => ({
  ...createEmptySession(),
  title,
  turns: [{ id: `t-${title}`, role: 'user', content: title, createdAt: 1 }],
  ...extra
});

const setup = () => {
  const project = createChatProject('Work', 'folder', 'blue');
  const a = chat('Trip plan');
  const b = chat('Recipes');
  const c = chat('Quarterly notes', { projectId: project.id });
  const onSelect = vi.fn();
  const onDelete = vi.fn();
  const noop = () => {};
  render(
    <ChatSidebar
      sessions={[a, b, c]}
      projects={[project]}
      activeId={a.id}
      generatingIds={new Set([b.id])}
      hasMemory={false}
      onSelect={onSelect}
      onNew={noop}
      onDelete={onDelete}
      onRename={noop}
      onMoveToProject={noop}
      onNewProject={noop}
      onEditProject={noop}
      onDeleteProject={noop}
      onEditMemory={noop}
      onBack={noop}
      onOpenSearch={noop}
      onOpenLibrary={noop}
      onOpenDashboards={noop}
      onOpenGallery={noop}
      onOpenTools={noop}
    />
  );
  return { a, b, c, project, onSelect, onDelete };
};

afterEach(() => cleanup());

describe('ChatSidebar keyboard access', () => {
  it('chat rows are 44 px tall on coarse pointers, and the row button fills the row', () => {
    const { a } = setup();
    const row = screen.getByRole('button', { name: new RegExp(`^${a.title}`) });
    expect(row.className).toMatch(/\bself-stretch\b/);
    expect(row.parentElement?.className).toMatch(/(^|\s)coarse:min-h-11(\s|$)/);
  });

  it('Escape in the rename field cancels the rename and marks the key handled (the phone drawer stays)', () => {
    setup();
    fireEvent.click(screen.getByRole('button', { name: /options for trip plan/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
    const field = screen.getByDisplayValue('Trip plan');
    const ev = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    act(() => {
      field.dispatchEvent(ev);
    });
    expect(ev.defaultPrevented).toBe(true);
    expect(screen.queryByDisplayValue('Trip plan')).toBeNull();
  });

  it('every chat row is a button in the tab order; the open chat is marked current', () => {
    const { a, b, c, onSelect } = setup();
    for (const s of [a, b, c]) {
      const row = screen.getByRole('button', { name: new RegExp(`^${s.title}`) });
      expect(row.tagName).toBe('BUTTON');
      expect(row.getAttribute('tabindex')).not.toBe('-1');
      row.focus();
      expect(document.activeElement).toBe(row);
    }
    expect(screen.getByRole('button', { name: /^Trip plan/ }).getAttribute('aria-current')).toBe('true');
    expect(screen.getByRole('button', { name: /^Recipes/ }).getAttribute('aria-current')).toBeNull();
    // A generating chat says so to assistive tech too.
    expect(screen.getByRole('button', { name: /^Recipes/ }).textContent).toContain('(answering)');

    fireEvent.click(screen.getByRole('button', { name: /^Recipes/ }));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(b.id);
  });

  it('Escape closes a chat row menu and returns focus to its button', () => {
    setup();
    const trigger = screen.getByRole('button', { name: 'Options for Recipes' });
    fireEvent.click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('button', { name: /rename/i })).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('button', { name: /rename/i })).toBeNull();
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(trigger);
  });

  it('Escape closes the project menu and the account menu too, and marks the key handled', () => {
    const { project } = setup();
    const projectTrigger = screen.getByRole('button', { name: `Options for ${project.name}` });
    fireEvent.click(projectTrigger);
    const edit = screen.getByRole('button', { name: /^edit$/i });
    expect(edit).toBeTruthy();
    const ev = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    act(() => {
      document.dispatchEvent(ev);
    });
    expect(ev.defaultPrevented).toBe(true); // the phone drawer around the sidebar stays open
    expect(screen.queryByRole('button', { name: /^edit$/i })).toBeNull();
    expect(document.activeElement).toBe(projectTrigger);

    const account = screen.getByTitle('Account, theme & exit');
    fireEvent.click(account);
    expect(within(account.parentElement as HTMLElement).getByRole('button', { name: /back to app/i })).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('button', { name: /back to app/i })).toBeNull();
    expect(document.activeElement).toBe(account);
  });

  it('the project group header says whether it is expanded', () => {
    const { project } = setup();
    const header = screen.getByRole('button', { name: new RegExp(`^${project.name}`) });
    expect(header.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(header);
    expect(header.getAttribute('aria-expanded')).toBe('false');
  });

  it('renaming: Enter while an IME is composing picks a candidate and never commits the title', () => {
    const onRename = vi.fn();
    const project = createChatProject('Work', 'folder', 'blue');
    const a = chat('Trip plan');
    const noop = () => {};
    render(
      <ChatSidebar
        sessions={[a]} projects={[project]} activeId={a.id} hasMemory={false}
        onSelect={noop} onNew={noop} onDelete={noop} onRename={onRename} onMoveToProject={noop}
        onNewProject={noop} onEditProject={noop} onDeleteProject={noop} onEditMemory={noop} onBack={noop}
        onOpenSearch={noop} onOpenLibrary={noop} onOpenDashboards={noop} onOpenGallery={noop} onOpenTools={noop}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Options for Trip plan' }));
    fireEvent.click(screen.getByRole('button', { name: /rename/i }));
    const input = screen.getByDisplayValue('Trip plan');
    fireEvent.change(input, { target: { value: '旅行' } });
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 229 }); // Safari: isComposing false, keyCode 229
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    expect(onRename).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 13 });
    expect(onRename).toHaveBeenCalledWith(a.id, '旅行');
  });
});
