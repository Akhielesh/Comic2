/**
 * The notification bell on Atlas chrome (DS-2): an icon button with the unread count, the overlay panel,
 * Escape to close; it looks for new notifications every 30 s only while the tab is visible (Supabase, never
 * /api, never in a background tab) and catches up when the tab comes back.
 */
import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({ user: { id: 'u1' } }));
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => auth }));
vi.mock('../services/db', () => ({
  getNotifications: vi.fn(async () => []),
  markAllNotificationsRead: vi.fn(async () => undefined),
  markNotificationRead: vi.fn(async () => undefined)
}));

import { getNotifications } from '../services/db';
import { OVERLAY, Z } from './chat/studioDesign';
import { expectClasses } from './ds/ds.testkit';
import { NOTIFICATION_POLL_MS, NotificationBell } from './NotificationBell';
import type { AppNotification } from '../types';

const note = (over: Partial<AppNotification>): AppNotification => ({ id: 'n1', user_id: 'u1', type: 'like', is_read: false, created_at: new Date().toISOString(), ...over });
const loads = () => vi.mocked(getNotifications).mock.calls.length;
let visibility: DocumentVisibilityState = 'visible';

beforeEach(() => {
  visibility = 'visible';
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
  vi.mocked(getNotifications).mockReset();
  vi.mocked(getNotifications).mockResolvedValue([]);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const flush = async () => {
  await act(async () => {
    await Promise.resolve();
  });
};

describe('NotificationBell', () => {
  it('shows the unread count on the bell and says it', async () => {
    vi.mocked(getNotifications).mockResolvedValue([note({ id: 'a' }), note({ id: 'b' }), note({ id: 'c', is_read: true })]);
    render(<NotificationBell onNavigate={() => undefined} />);
    const bell = await screen.findByRole('button', { name: 'Notifications, 2 unread' });
    expect(bell.querySelector('[data-slot="bell-count"]')).toHaveTextContent('2');
    expect(bell).toHaveAttribute('data-slot', 'icon-button');
  });

  it('opens the overlay panel; Escape closes it and focuses the bell', async () => {
    vi.mocked(getNotifications).mockResolvedValue([note({ id: 'a', type: 'follow', actor: { username: 'mina' } })]);
    const onNavigate = vi.fn();
    render(<NotificationBell onNavigate={onNavigate} />);
    const bell = await screen.findByRole('button', { name: 'Notifications, 1 unread' });
    fireEvent.click(bell);
    const panel = screen.getByRole('region', { name: 'Notifications' });
    expectClasses(panel, OVERLAY, Z.popover);
    expect(bell).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('mina started following you')).toBeInTheDocument();
    act(() => {
      fireEvent.keyDown(document, { key: 'Escape' });
    });
    expect(screen.queryByRole('region', { name: 'Notifications' })).toBeNull();
    expect(bell).toHaveFocus();
  });

  it('polls every 30 s while visible, skips while hidden, and catches up when the tab comes back', async () => {
    vi.useFakeTimers();
    render(<NotificationBell onNavigate={() => undefined} />);
    await flush();
    expect(loads()).toBe(1);
    await act(async () => {
      vi.advanceTimersByTime(NOTIFICATION_POLL_MS);
    });
    expect(loads()).toBe(2);
    visibility = 'hidden';
    await act(async () => {
      vi.advanceTimersByTime(NOTIFICATION_POLL_MS * 3);
    });
    expect(loads()).toBe(2);
    visibility = 'visible';
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(loads()).toBe(3);
  });

  it('the empty panel says so calmly', async () => {
    render(<NotificationBell onNavigate={() => undefined} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Notifications' }));
    expect(screen.getByRole('status')).toHaveTextContent("You're all caught up.");
  });
});
