// NurserySettings (ADR 0006 Phase 0, WS-6): parents see the devices that hold the family's key
// (with Revoke) and the nursery's security log — in rooms that list them — and export asks for
// the second sign-in step first.
import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../account', () => ({ accessToken: vi.fn(async () => 'tok'), supa: async () => null }));
vi.mock('../../monitor/keys', () => ({ deviceKeys: async () => ({ devId: 'MeMeMeMeMeMeMeMeMeMeMe' }) }));

import { noteNurseryCaps, registerStepUp } from '../../monitor/client';
import type { MonSettings, NurseryDevice } from '../../monitor/protocol';
import { NurserySettings, revokedText } from './NurserySettings';

const NID = '22222222-2222-4333-8444-555555555555';
const settings = { sensitivity: 'medium', cryRepeatMin: 3, cryEscalateMin: 5 } as MonSettings;
const NOW = Date.now();
const devices: NurseryDevice[] = [
  { devId: 'MeMeMeMeMeMeMeMeMeMeMe', name: 'Chrome on Mac', platform: 'web', who: 'Alice', added: NOW - 3 * 86_400_000, last_seen: NOW, keyed: true },
  { devId: 'CamCamCamCamCamCamCamC', name: 'Safari on iPhone', platform: 'web', who: 'Camera', added: NOW - 86_400_000, last_seen: NOW - 7200_000, keyed: true },
  { devId: 'OddOddOddOddOddOddOddO', name: 'Firefox on Windows', platform: 'web', who: 'Grandma Jo', added: NOW - 600_000, last_seen: null, keyed: false },
];

function query(answers: Record<string, (args: Record<string, unknown>) => unknown>) {
  const asked: { q: string; args: Record<string, unknown> }[] = [];
  return {
    asked,
    ask: async <T,>(q: string, args: Record<string, unknown> = {}): Promise<T | null> => {
      asked.push({ q, args });
      return (answers[q]?.(args) ?? null) as T | null;
    },
  };
}

const show = (q: ReturnType<typeof query>, push = vi.fn()) => {
  render(<NurserySettings nid={NID} nurseryName="Nursery" role="parent" settings={settings} send={vi.fn()} push={push} query={q} />);
  return push;
};

beforeEach(() => registerStepUp(null));
afterEach(() => {
  registerStepUp(null);
  noteNurseryCaps(NID, []);
  vi.unstubAllGlobals();
});

describe('Nursery security (parents)', () => {
  it('an older room (no capability): no Security section — nothing asked', () => {
    noteNurseryCaps(NID, []);
    const q = query({});
    show(q);
    expect(screen.queryByText('Security')).toBeNull();
    expect(q.asked.filter((a) => a.q !== 'usage')).toEqual([]);
  });

  it('devices that hold the key: this one marked (no Revoke), others removable after the second step', async () => {
    noteNurseryCaps(NID, ['reauth', 'e2e1']);
    let list = devices;
    const q = query({ devices: () => ({ devices: list }), dev_revoke: () => ({ ok: true }) });
    const asked: string[] = [];
    registerStepUp(async (why) => {
      asked.push(why);
      return true;
    });
    const push = show(q);
    await waitFor(() => expect(screen.getByText('Chrome on Mac (this device)')).toBeTruthy());
    expect(screen.getByText(/Grandma Jo · Browser · added 10 min ago · waiting for the key/)).toBeTruthy();
    expect(screen.getAllByRole('button', { name: /Revoke/ })).toHaveLength(2);
    fireEvent.click(screen.getAllByRole('button', { name: /Revoke/ })[1]);
    list = devices.slice(0, 2);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Remove' })));
    expect(asked).toEqual(['Removing Firefox on Windows from the nursery']);
    expect(q.asked.find((a) => a.q === 'dev_revoke')?.args).toEqual({ devId: 'OddOddOddOddOddOddOddO' });
    // The room didn't say it told the camera: never claimed disconnected — and how to end a live view.
    expect(push).toHaveBeenCalledWith(expect.stringMatching(/Firefox on Windows removed.*signed out.*key is being changed.*restart the camera/), expect.anything());
    expect(push.mock.calls[0][0]).not.toMatch(/disconnected/);
    await waitFor(() => expect(screen.queryByText(/Firefox on Windows/)).toBeNull());
  });

  it('Revoke: “disconnected” only when the room says the camera was told to end its live view', () => {
    expect(revokedText('Old iPad', true)).toMatch(/^Old iPad removed — it’s disconnected/);
    expect(revokedText('Old iPad', false)).not.toMatch(/disconnected/);
  });

  it('a cancelled second step removes nothing', async () => {
    noteNurseryCaps(NID, ['reauth', 'e2e1']);
    const q = query({ devices: () => ({ devices }) });
    registerStepUp(async () => false);
    show(q);
    await waitFor(() => expect(screen.getAllByRole('button', { name: /Revoke/ })).toHaveLength(2));
    fireEvent.click(screen.getAllByRole('button', { name: /Revoke/ })[0]);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Remove' })));
    expect(q.asked.some((a) => a.q === 'dev_revoke')).toBe(false);
  });

  it('the security log: the room’s `security` events, newest first as the room sends them', async () => {
    noteNurseryCaps(NID, ['reauth', 'e2e1']);
    const q = query({
      devices: () => ({ devices }),
      events: () => ({ rows: [{ id: 'e1', at: NOW - 120_000, kind: 'security', msg: 'New device: Firefox on Windows (Grandma Jo)' }, { id: 'e2', at: NOW - 7200_000, kind: 'security', msg: 'Bob was removed', by: 'Alice' }] }),
    });
    show(q);
    fireEvent.click(await screen.findByRole('radio', { name: 'Security log' }));
    await waitFor(() => expect(screen.getByText('New device: Firefox on Windows (Grandma Jo)')).toBeTruthy());
    expect(screen.getByText('2 h ago · Alice')).toBeTruthy();
    expect(q.asked.find((a) => a.q === 'events')?.args).toEqual({ kinds: ['security'], limit: 50 });
  });

  it('a room with sign-in rules but no keys yet: the log alone; a failed load can be retried', async () => {
    noteNurseryCaps(NID, ['reauth']);
    let fail = true;
    const q = query({ events: () => (fail ? null : { rows: [] }) });
    show(q);
    await waitFor(() => expect(screen.getByText('Couldn’t load it.')).toBeTruthy());
    expect(screen.queryByRole('radio', { name: 'Devices' })).toBeNull();
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: /Try again/ }));
    await waitFor(() => expect(screen.getByText(/Nothing yet/)).toBeTruthy());
  });
});

describe('export asks for the second sign-in step', () => {
  it('asked before the download; a refusal for want of it asks again and retries once', async () => {
    noteNurseryCaps(NID, []);
    const calls: string[] = [];
    let refuse = true;
    vi.stubGlobal('fetch', async (url: string) => {
      calls.push(url);
      if (refuse) {
        refuse = false;
        return new Response(JSON.stringify({ error: 'mfa_required' }), { status: 403 });
      }
      return new Response('a,b\n1,2', { status: 200 });
    });
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:x', revokeObjectURL: () => undefined }));
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    let asks = 0;
    registerStepUp(async () => {
      asks += 1;
      return true;
    });
    const push = show(query({}));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: /Activity log/ })));
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(asks).toBe(2);
    await waitFor(() => expect(push).toHaveBeenCalledWith(expect.stringMatching(/^Downloaded/), expect.anything()));
    expect(click).toHaveBeenCalledTimes(1);
    click.mockRestore();
  });

  it('cancelled: nothing is downloaded', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => (calls.push(url), new Response('')));
    registerStepUp(async () => false);
    show(query({}));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: /Activity log/ })));
    expect(calls).toEqual([]);
  });
});
