import React from 'react';
import { render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Nav } from '../nav';
import type { StatsResponse } from '../protocol';

const api = vi.hoisted(() => ({ getStats: vi.fn() }));
vi.mock('../api', () => ({ getStats: api.getStats, recordingDownloadUrl: () => '#' }));

import { saveMeetingUse } from '../usage/ledger';
import { SummaryView } from './SummaryView';

/** The recap's Delivery block (feature doc §4.4, B5): exact where known, ≈ where estimated, our cost folded away. */

const MIN = 60_000;
const T0 = Date.UTC(2026, 9, 23, 18);
const nav = { dashboard: vi.fn(), studio: vi.fn() } as unknown as Nav;

function stats(over: Partial<StatsResponse['meta']> = {}, recordings: StatsResponse['recordings'] = []): StatsResponse {
  return {
    meta: {
      id: 'ev1', title: 'Party', host: 'Ada', desc: '', cover: 0, access: 'open', quality: '720p', mime: 'video/mp4', segMs: 6000,
      status: 'ended', createdAt: T0 - MIN, scheduledAt: null, startedAt: T0, endedAt: T0 + 62 * MIN, firstSeq: 0, latestSeq: 620,
      lastIngestAt: T0 + 62 * MIN, pinned: null, slowSec: 0, reactionsOn: true, maxViewers: 200, viewers: 0, rsvpCount: 0, rsvpNames: [],
      ...over,
    },
    stats: {
      peakViewers: 20, peakAt: T0 + 30 * MIN, chatTotal: 0, emojiTotal: 0, uniqueViewers: 25,
      curve: Array.from({ length: 124 }, (_, i) => ({ at: T0 + i * 30_000, n: 20 })),
      chatCurve: [],
      healthCurve: Array.from({ length: 124 }, (_, i) => ({ at: T0 + i * 30_000, up: 3e6, enc: 2_500_000, fail: 0 })),
    },
    log: [],
    topChatters: [],
    recordings,
  };
}

beforeEach(() => {
  localStorage.clear();
  api.getStats.mockReset();
});

describe('SummaryView — Delivery', () => {
  it('says who carried it, what it took (≈), and folds away what it cost us — never as a charge', async () => {
    api.getStats.mockResolvedValue(stats());
    render(<SummaryView eventId="ev1" hostKey="hk" nav={nav} push={vi.fn()} />);
    const head = await screen.findByRole('heading', { name: 'Delivery' });
    const card = head.closest('.delivery-card') as HTMLElement;
    expect(within(card).getByText('Through our servers · free for you')).toBeTruthy();
    expect(within(card).getByText('1 h 02 m · peak 20 viewers · ≈ 1.2 GB stored for 24 h · ≈ 23 GB delivered')).toBeTruthy();
    const cost = card.querySelector('details.usage-cost')!;
    expect(cost.hasAttribute('open')).toBe(false);
    // About a cent at list price for an hour to 20 viewers (feature doc §2.2 row 9).
    expect(cost.textContent).toMatch(/What this costs DreamStream \(est\.\)under \$0\.01 at list price/);
    expect(cost.textContent).toMatch(/You aren’t charged/);
    // The empty cloud-copy card points to the save sheet, not to a setting that uploads by itself.
    expect(screen.getByText(/No 7-day copy for this event\. Recordings save to Google Drive or this device — free/)).toBeTruthy();
  });

  it('a meeting this device hosted: its guests’ links, from this device', async () => {
    api.getStats.mockResolvedValue(stats({ kind: 'meeting', startedAt: null, endedAt: null, status: 'idle' }));
    saveMeetingUse('ev1', { ms: { lan: 0, direct: 45 * MIN, turn: 0, server: 0 }, turnBytes: 0, startedAt: 0 }, 3);
    render(<SummaryView eventId="ev1" hostKey="hk" nav={nav} push={vi.fn()} />);
    const card = (await screen.findByRole('heading', { name: 'Delivery' })).closest('.delivery-card') as HTMLElement;
    expect(card.textContent).toMatch(/3 guests · 45 min on camera · all direct · free · this device/);
    // Never on air: nothing through our servers to account for.
    expect(within(card).queryByText('Through our servers · free for you')).toBeNull();
    expect(card.querySelector('details.usage-cost')).toBeNull();
  });

  it('nothing to say (never on air, no meeting on this device): no Delivery card', async () => {
    api.getStats.mockResolvedValue(stats({ startedAt: null, endedAt: null, status: 'idle' }));
    render(<SummaryView eventId="ev1" hostKey="hk" nav={nav} push={vi.fn()} />);
    await screen.findByText('Party');
    expect(screen.queryByRole('heading', { name: 'Delivery' })).toBeNull();
  });
});
