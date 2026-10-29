// AdminConsole admin-section registry (contract §13.2): Comic Studio features append
// admin-only sections without editing the console.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';

vi.mock('../../services/billing', () => ({
  approveProjectRepublish: vi.fn(),
  forceProjectPrivate: vi.fn(),
  listAdminUsers: vi.fn(async () => ({ items: [] })),
  listModerationQueue: vi.fn(async () => ({ items: [] })),
  moderateUser: vi.fn(),
  updateAdminUserRole: vi.fn()
}));
vi.mock('../../services/adminEmail', () => ({
  getEmailUsage: vi.fn(async () => ({ configured: true })),
  listEmailTemplates: vi.fn(async () => ({ configured: true }))
}));
vi.mock('../../services/adminAnalytics', () => ({
  getAnalyticsOverview: vi.fn(async () => ({ storageEnabled: true, totals: { failures: 0 } }))
}));
vi.mock('../VerificationCenter', () => ({ VerificationCenter: () => null }));
vi.mock('./AdminAnalytics', () => ({ AdminAnalytics: () => null }));
vi.mock('./InviteManager', () => ({ InviteManager: () => null }));
vi.mock('./EmailConsole', () => ({ EmailConsole: () => null }));
vi.mock('./ProductAccessPanel', () => ({ ProductAccessPanel: () => null }));
vi.mock('./CostCentre', () => ({ CostCentre: () => null }));

vi.mock('../comicstudio/library/index', async () => {
  const { createElement } = await import('react');
  return {
    feature: {
      adminSections: [
        { id: 'comic-library', label: 'Comic library', icon: null, Component: () => createElement('div', null, 'Library builder console') },
        // A feature can never take over a built-in section.
        { id: 'users', label: 'Fake users', icon: null, Component: () => createElement('div', null, 'HIJACK') }
      ]
    }
  };
});

import { AdminConsole } from './AdminConsole';

beforeEach(() => {
  window.sessionStorage.clear();
  window.history.replaceState(null, '', '/');
});

const rail = () => within(screen.getByRole('tablist', { name: 'Admin console sections' }));

describe('AdminConsole feature sections', () => {
  it('appends registered sections for admins and renders the active one', async () => {
    render(<AdminConsole isAdmin isModerator={false} adminAccess={null} />);
    const labels = rail().getAllByRole('tab').map((t) => t.textContent);
    // Feature order: the library (mocked here) before the W-M reliability feature's Provider status.
    expect(labels.slice(-2)).toEqual(['Comic library', 'Provider status']);
    expect(labels).not.toContain('Fake users');

    fireEvent.click(rail().getByRole('tab', { name: 'Comic library' }));
    expect(await screen.findByText('Library builder console')).toBeInTheDocument();
    expect(screen.queryByText('HIJACK')).not.toBeInTheDocument();
  });

  it('hides feature sections from moderators', () => {
    render(<AdminConsole isAdmin={false} isModerator adminAccess={null} />);
    expect(rail().queryByRole('tab', { name: 'Comic library' })).not.toBeInTheDocument();
  });
});
