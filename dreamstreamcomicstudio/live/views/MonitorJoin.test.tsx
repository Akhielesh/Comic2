import React from 'react';
import { fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const NID = '11111111-2222-4333-8444-555555555555';
const h = vi.hoisted(() => ({
  account: { status: 'signed_out' } as Record<string, unknown>,
  nurseries: [] as { id: string; name: string }[],
}));
vi.mock('../account', () => ({ useAccount: () => h.account, accessToken: vi.fn(async () => 'tok-sam'), supa: async () => null }));
vi.mock('../monitor/client', async (orig) => ({
  ...(await orig<typeof import('../monitor/client')>()),
  listNurseries: vi.fn(async () => ({ ok: true, nurseries: h.nurseries })),
}));

import { loadGuest, saveGuest } from '../monitor/guest';
import type { Nav } from '../nav';
import { MonitorJoin } from './MonitorJoin';
import { useGuestPass } from './monitor/useGuestPass';

const nav = { monitorWatch: vi.fn() } as unknown as Nav & { monitorWatch: ReturnType<typeof vi.fn> };
const push = vi.fn();
const pass = { token: 't', name: 'Jo', role: 'viewer' as const, until: Date.now() + 1e9, nursery: { name: 'Nursery', baby: 'Aria' } };
const realUA = navigator.userAgent;

beforeEach(() => {
  h.account = { status: 'signed_out' };
  h.nurseries = [];
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  localStorage.clear();
  Object.defineProperty(navigator, 'userAgent', { value: realUA, configurable: true });
});

describe('MonitorJoin', () => {
  it('a member of the nursery goes straight to watching with their account (no guest pass)', async () => {
    h.account = { status: 'member', userId: 'u-me', name: 'Alice' };
    h.nurseries = [{ id: NID, name: 'Nursery' }];
    saveGuest(NID, pass); // a stale pass from before
    render(<MonitorJoin nid={NID} code={'c'.repeat(22)} nav={nav} push={push} />);
    await waitFor(() => expect(nav.monitorWatch).toHaveBeenCalledWith(NID));
    await waitFor(() => expect(push).toHaveBeenCalledWith('You’re already in Nursery — watching with your account', expect.anything()));
    expect(loadGuest(NID)).toBeNull();
  });

  it('signed in but not a member: sends their own token, and the room may say they’re a member after all', async () => {
    h.account = { status: 'member', userId: 'u-sam', name: 'Sam' };
    const fetch = vi.fn(async () => new Response(JSON.stringify({ ok: false, reason: 'member' }), { status: 409 }));
    vi.stubGlobal('fetch', fetch);
    render(<MonitorJoin nid={NID} code={'c'.repeat(22)} nav={nav} push={push} />);
    expect((screen.getByRole('textbox', { name: /Your name/ }) as HTMLInputElement).value).toBe('Sam');
    expect(screen.getByText(/the parents can make you a member/)).toBeTruthy();
    fireEvent.change(document.querySelector('input[type="password"]')!, { target: { value: 'blue-otter-42' } });
    fireEvent.click(screen.getByRole('button', { name: 'Join and watch' }));
    await waitFor(() => expect(nav.monitorWatch).toHaveBeenCalledWith(NID));
    const init = (fetch.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer tok-sam');
    expect(JSON.parse(String(init.body))).not.toHaveProperty('uid');
  });

  it('warns inside an in-app browser that the guest pass stays in that app', () => {
    Object.defineProperty(navigator, 'userAgent', { value: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) WhatsApp/2.23', configurable: true });
    render(<MonitorJoin nid={NID} code={'c'.repeat(22)} nav={nav} push={push} />);
    expect(screen.getByText(/You’re in WhatsApp’s built-in browser/)).toBeTruthy();
    expect(screen.getByText(/open this link there instead/)).toBeTruthy();
  });
});

describe('useGuestPass (watch screen)', () => {
  it('keeps a guest pass for guests, but clears it once the account is a member of the nursery', async () => {
    saveGuest(NID, pass);
    const guest = renderHook(() => useGuestPass(NID));
    expect(guest.result.current[0]?.name).toBe('Jo');

    h.account = { status: 'member', userId: 'u-jo' };
    h.nurseries = [{ id: 'some-other', name: 'Other' }];
    const notMember = renderHook(() => useGuestPass(NID));
    await new Promise((r) => setTimeout(r, 20));
    expect(notMember.result.current[0]?.name).toBe('Jo');

    h.nurseries = [{ id: NID, name: 'Nursery' }];
    const member = renderHook(() => useGuestPass(NID));
    await waitFor(() => expect(member.result.current[0]).toBeNull());
    expect(loadGuest(NID)).toBeNull();
  });
});
