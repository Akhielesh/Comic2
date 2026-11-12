// Settings › Admin › Analytics › Contact (CONTACT-1): the Contact tab shows the messages panel and none of
// the analytics chrome — no day range (it does not apply), no overview Refresh (it would not reload the
// messages) and no telemetry banners — so there is exactly one Refresh, the panel's own.
import React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const analytics = vi.hoisted(() => ({
  getAnalyticsOverview: vi.fn(),
  listAnalyticsEvents: vi.fn(async () => ({ items: [] })),
  listAnalyticsFeedback: vi.fn(async () => ({ items: [] })),
  getSessionTimeline: vi.fn()
}));
vi.mock('../../services/adminAnalytics', () => analytics);

const contact = vi.hoisted(() => ({
  list: vi.fn(async () => ({
    items: [
      {
        id: '00000000-0000-4000-8000-000000000001',
        email: 'person1@example.com',
        message: 'Message number 1',
        created_at: '2026-11-12T09:00:00.000Z',
        handled_at: null
      }
    ],
    storageEnabled: true
  })),
  markHandled: vi.fn()
}));
vi.mock('../../services/adminContact', () => ({ contactMessagesApi: contact }));

import { AdminAnalytics } from './AdminAnalytics';
import type { AnalyticsOverview } from '../../services/adminAnalytics';

const overview = (storageEnabled: boolean): AnalyticsOverview => ({
  windowDays: 7,
  generatedAt: '2026-11-12T09:00:00.000Z',
  storageEnabled,
  totals: { events: 0, failures: 0, feedback: 0, likes: 0, dislikes: 0, distinctSessions: 0, distinctUsers: 0 },
  eventsBySeverity: {},
  eventsByType: {},
  eventsBySource: {},
  feedbackBySentiment: {},
  feedbackByCategory: {},
  topIssues: [],
  recentFailures: [],
  recentDislikes: [],
  chatPerformance: { turns: 0, avgLatencyMs: 0, p95LatencyMs: 0, emptyRate: 0, toolFailureRate: 0, topModels: [] }
});

beforeEach(() => {
  analytics.getAnalyticsOverview.mockReset();
  contact.list.mockClear();
});

describe('AdminAnalytics › Contact tab', () => {
  it('shows exactly one Refresh (the messages panel’s) and no day range or telemetry banner', async () => {
    analytics.getAnalyticsOverview.mockResolvedValue(overview(false));
    render(<AdminAnalytics />);
    // The analytics tabs keep their chrome: the day range, the overview Refresh and the persistence banner.
    expect(await screen.findByText(/Persistence is off/)).toBeInTheDocument();
    expect(screen.getByRole('combobox')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /Refresh/ })).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: 'contact' }));
    const panel = await screen.findByRole('region', { name: 'Contact messages' });
    await within(panel).findByRole('link', { name: /person1@example\.com/ });

    const refresh = screen.getAllByRole('button', { name: /Refresh/ });
    expect(refresh).toHaveLength(1);
    expect(panel).toContainElement(refresh[0]);
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.queryByText(/Persistence is off/)).toBeNull();

    // That one Refresh reloads the messages, not the overview.
    const overviewCalls = analytics.getAnalyticsOverview.mock.calls.length;
    fireEvent.click(refresh[0]);
    await within(panel).findByRole('link', { name: /person1@example\.com/ });
    expect(contact.list).toHaveBeenCalledTimes(2);
    expect(analytics.getAnalyticsOverview).toHaveBeenCalledTimes(overviewCalls);
  });

  it('hides the overview error on the Contact tab too', async () => {
    analytics.getAnalyticsOverview.mockRejectedValue(new Error('Overview failed to load'));
    render(<AdminAnalytics />);
    expect(await screen.findByText('Overview failed to load')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'contact' }));
    await screen.findByRole('region', { name: 'Contact messages' });
    expect(screen.queryByText('Overview failed to load')).toBeNull();
  });
});
