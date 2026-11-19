// The "new answer" dot on Chat's list (notify SPEC §5.9, NF-3): the spinner while a chat answers, an ink dot (the
// existing unread look, with "(new answer)" for screen readers) once the answer lands while the person is elsewhere,
// and nothing once the chat is opened. The dot carries no hue.
import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { ChatSidebar } from './ChatSidebar';
import { createEmptySession, type ChatSession } from '../../services/chatStorage';

const chat = (title: string): ChatSession => ({ ...createEmptySession(), title, turns: [{ id: `t-${title}`, role: 'user', content: title, createdAt: 1 }] });
const noop = () => {};
const sidebar = (sessions: ChatSession[], activeId: string, generating: string[], unseen: string[]) => (
  <ChatSidebar
    sessions={sessions}
    projects={[]}
    activeId={activeId}
    generatingIds={new Set(generating)}
    unseenIds={new Set(unseen)}
    hasMemory={false}
    onSelect={noop}
    onNew={noop}
    onDelete={noop}
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
const row = (title: string) => screen.getByRole('button', { name: new RegExp(`^${title}`) });

afterEach(() => cleanup());

describe('the new-answer dot', () => {
  it('spinner while answering, the dot after, nothing once opened', () => {
    const [open, trip, recipes] = [chat('Open chat'), chat('Trip plan'), chat('Recipes')];
    const view = render(sidebar([open, trip, recipes], open.id, [trip.id], []));
    expect(row('Trip plan').querySelector('.animate-spin')).not.toBeNull();
    expect(row('Trip plan').querySelector('[data-chat-unseen]')).toBeNull();
    expect(row('Trip plan')).toHaveTextContent('(answering)');

    // The answer landed while the person was in another chat.
    view.rerender(sidebar([open, trip, recipes], open.id, [], [trip.id]));
    const t = row('Trip plan');
    expect(t.querySelector('.animate-spin')).toBeNull();
    expect(t.querySelector('[data-chat-unseen]')).not.toBeNull();
    expect(t).toHaveAccessibleName(/Trip plan.*\(new answer\)/);
    expect(row('Recipes').querySelector('[data-chat-unseen]')).toBeNull();

    // Opened: no dot (even before the set is cleared).
    view.rerender(sidebar([open, trip, recipes], trip.id, [], [trip.id]));
    expect(row('Trip plan').querySelector('[data-chat-unseen]')).toBeNull();
    expect(row('Trip plan')).not.toHaveTextContent('(new answer)');
  });

  it('the dot is ink, the existing unread look, with no hue, accent or spark', () => {
    const [open, trip] = [chat('Open chat'), chat('Trip plan')];
    render(sidebar([open, trip], open.id, [], [trip.id]));
    const dot = row('Trip plan').querySelector('[data-chat-unseen] span')!;
    expect(dot.className).toBe('block size-2 rounded-full bg-[var(--ds-ink)]');
    const all = row('Trip plan').querySelector('[data-chat-unseen]')!.outerHTML;
    expect(all).not.toMatch(/hue|accent|spark|art|ds-(success|warning|danger|info)|(red|amber|orange|blue|green)-\d/);
  });
});
