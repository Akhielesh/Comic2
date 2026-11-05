// Admin "Usage budgets" panel (P1-LIMITS): dollars AND percent for admins, top-up / exempt / reset,
// honest errors, and rows that reflow to cards on phones.
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

const svc = vi.hoisted(() => ({ listUsageBudgets: vi.fn(), updateUsageBudget: vi.fn() }));
vi.mock('../../services/usageAllowance', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/usageAllowance')>()),
  ...svc
}));

import { UsageBudgetsPanel, buildBudgetUpdate, fmtBudgetUsd } from './UsageBudgetsPanel';

const row = (over: Record<string, unknown> = {}) => ({
  userId: '17933bae-dcc5-49b9-bcf5-9658e3953a84',
  email: 'surya@example.com',
  hasRow: true,
  exempt: false,
  allowPro: false,
  budgetUsd: 10,
  period: 'lifetime',
  periodStartedAt: null,
  spentUsd: 6.1,
  inflightUsd: 0.1,
  pctUsed: 62,
  pctLeft: 38,
  exhausted: false,
  note: null,
  updatedAt: null,
  lastUsedAt: '2026-10-21T10:00:00Z',
  admin: false,
  ...over
});

beforeEach(() => {
  svc.listUsageBudgets.mockReset().mockResolvedValue({
    defaultBudgetUsd: 10,
    defaultPeriod: 'lifetime',
    maxBudgetUsd: 1000,
    users: [row(), row({ userId: 'b03908b8-98c2-4ca8-8589-ae60f7756390', email: 'sakshi@example.com', spentUsd: 10, inflightUsd: 0, pctUsed: 100, pctLeft: 0, exhausted: true }), row({ userId: 'admin-1', email: 'owner@example.com', admin: true, spentUsd: 3, pctUsed: 0 })]
  });
  svc.updateUsageBudget.mockReset().mockResolvedValue({ success: true, userId: 'x' });
});

describe('UsageBudgetsPanel', () => {
  it('lists users with dollars and percent; admins are never limited', async () => {
    render(<UsageBudgetsPanel />);
    const list = await screen.findByRole('list');
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(3);
    expect(items[0]).toHaveTextContent('surya@example.com');
    expect(items[0]).toHaveTextContent('62% used');
    expect(items[0]).toHaveTextContent('$6.20 of $10');
    expect(items[1]).toHaveTextContent('Used up');
    expect(items[2]).toHaveTextContent('Admin · no limit');
    expect(items[2]).toHaveTextContent('not limited');
    // rows stack on phones (flex-col) and only go side by side from sm
    expect(items[0].className).toMatch(/flex-col/);
    expect(items[0].className).toMatch(/sm:flex-row/);
  });

  it('tops a user up without resetting what they used (only changed fields are sent)', async () => {
    render(<UsageBudgetsPanel />);
    fireEvent.click(await screen.findByRole('button', { name: /edit usage budget for surya@example.com/i }));
    fireEvent.change(screen.getByLabelText(/budget \(usd/i), { target: { value: '15' } });
    fireEvent.change(screen.getByLabelText(/note/i), { target: { value: 'beta top-up' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(svc.updateUsageBudget).toHaveBeenCalledWith('17933bae-dcc5-49b9-bcf5-9658e3953a84', { budgetUsd: 15, note: 'beta top-up' }));
    await waitFor(() => expect(svc.listUsageBudgets).toHaveBeenCalledTimes(2));
  });

  it('adds a tester by email and shows honest errors', async () => {
    svc.updateUsageBudget.mockRejectedValueOnce(new Error('No account with this email yet — they need to sign up first.'));
    render(<UsageBudgetsPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Add' }));
    fireEvent.change(screen.getByLabelText(/email or user id/i), { target: { value: 'new@example.com' } });
    const addButtons = screen.getAllByRole('button', { name: 'Add' });
    fireEvent.click(addButtons[addButtons.length - 1]);
    expect(await screen.findByRole('alert')).toHaveTextContent('No account with this email yet');
    expect(svc.updateUsageBudget).toHaveBeenCalledWith('new@example.com', { budgetUsd: 10, exempt: false, allowPro: false });
  });

  it('says so when the list cannot load', async () => {
    svc.listUsageBudgets.mockRejectedValueOnce(new Error('Request failed'));
    render(<UsageBudgetsPanel />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Request failed');
  });
});

describe('helpers', () => {
  it('formats admin dollars honestly', () => {
    expect(fmtBudgetUsd(10)).toBe('$10');
    expect(fmtBudgetUsd(6.2)).toBe('$6.20');
    expect(fmtBudgetUsd(0.0031)).toBe('$0.0031');
    expect(fmtBudgetUsd(0)).toBe('$0');
  });

  it('validates the draft', () => {
    const r = row() as never;
    expect(buildBudgetUpdate({ budgetUsd: '-1', exempt: false, allowPro: false, resetPeriod: false, note: '' }, r)).toMatch(/between/);
    expect(buildBudgetUpdate({ budgetUsd: '10', exempt: false, allowPro: false, resetPeriod: false, note: '' }, r)).toBe('Nothing changed.');
    expect(buildBudgetUpdate({ budgetUsd: '10', exempt: true, allowPro: false, resetPeriod: true, note: '' }, r)).toEqual({ exempt: true, resetPeriod: true });
  });
});
