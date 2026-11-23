// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EmailConsole } from './EmailConsole';
import { adminInviteByEmail, getEmailLog, type EmailLogRow } from '../../services/adminEmail';

vi.mock('../../services/adminEmail', () => ({
  listEmailTemplates: vi.fn(async () => ({ configured: true, templates: [] })),
  getEmailUsage: vi.fn(async () => ({ day: 0, month: 0 })),
  adminInviteByEmail: vi.fn(),
  getEmailLog: vi.fn()
}));

const attempt = '2026-11-23T10:00:00Z';
const image = '2026-11-23T10:02:00Z';
const acknowledgement = '2026-11-23T10:07:00Z';
const row: EmailLogRow = { id: 'one', to_email: 'creator@example.org', template: 'access-requested',
  kind: 'essential', status: 'sent', created_at: attempt, opened_at: null, acknowledged_at: null };

async function openActivity() {
  render(<EmailConsole />);
  fireEvent.click(screen.getByRole('button', { name: 'Activity log' }));
}

beforeEach(() => vi.mocked(getEmailLog).mockReset());
afterEach(cleanup);

describe('email activity receipts', () => {
  it('reports provider acceptance, distinct image and confirmation events, and skipped attempts', async () => {
    vi.mocked(getEmailLog).mockResolvedValue({ items: [
      { ...row, opened_at: image },
      { ...row, id: 'two', to_email: 'another@example.org', acknowledged_at: acknowledgement },
      { ...row, id: 'three', status: 'skipped', error: 'not_configured' }
    ] });
    await openActivity();
    const table = await screen.findByRole('table', { name: /Recent email requests/ });
    expect(screen.getByRole('status')).toHaveTextContent('3 logged requests · 2 provider accepted · 1 with an image request · 1 acknowledged via link');
    const [, first, second, third] = within(table).getAllByRole('row');
    expect(first.querySelector('time[datetime="' + image + '"]')).not.toBeNull();
    expect(within(first).getAllByRole('cell')[5]).toHaveTextContent('No record');
    expect(within(second).getAllByRole('cell')[4]).toHaveTextContent('No record');
    expect(second.querySelector('time[datetime="' + acknowledgement + '"]')).not.toBeNull();
    expect(within(third).getByText('Skipped')).toBeVisible();
    fireEvent.click(within(third).getByText('Details'));
    expect(within(third).getByText('not_configured')).toBeVisible();
    expect(screen.getByText(/Inbox delivery is unverified/)).toBeVisible();
  });

  it('labels acknowledgement availability correctly for older responses', async () => {
    const legacy = { ...row };
    delete legacy.acknowledged_at;
    vi.mocked(getEmailLog).mockResolvedValue({ items: [legacy] });
    await openActivity();
    expect(await screen.findByText('Unavailable')).toBeVisible();
    expect(screen.getByRole('status')).toHaveTextContent('Acknowledgement data unavailable');
  });

  it('keeps a newly created invitation available when the email transport skipped delivery', async () => {
    vi.mocked(adminInviteByEmail).mockResolvedValueOnce({ code: 'invite-token', inviteUrl: 'https://local.test/invite', email: row.to_email,
      ok: false, skipped: 'not_configured' });
    render(<EmailConsole />);
    fireEvent.click(screen.getByRole('button', { name: 'Invite by email' }));
    fireEvent.change(screen.getByRole('textbox', { name: "Friend's email" }), { target: { value: row.to_email } });
    fireEvent.click(screen.getByRole('button', { name: 'Create & send invite' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Email delivery was not confirmed (not_configured)');
    expect(screen.getByRole('button', { name: 'Copy invite link' })).toBeVisible();
    expect(screen.queryByText(/created & emailed/)).toBeNull();
  });

  it('distinguishes a failed lookup from a successfully empty log and permits retry', async () => {
    vi.mocked(getEmailLog).mockRejectedValueOnce(new Error('Email log unavailable')).mockResolvedValueOnce({ items: [] });
    await openActivity();
    expect(await screen.findByRole('alert')).toHaveTextContent('Email log unavailable');
    expect(screen.queryByText('No email activity yet.')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(await screen.findByText('No email activity yet.')).toBeVisible();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
