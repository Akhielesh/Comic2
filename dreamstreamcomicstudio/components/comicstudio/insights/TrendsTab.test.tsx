// Trends tab (models.md §4.4 / §4.6): only data we hold or fetch; T7 hidden below 5 users with the exact copy;
// no T3 line before the first price fetch; a failed load shows nothing invented.

import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';

const getMock = vi.hoisted(() => vi.fn());
vi.mock('../../../services/apiClient', () => ({ get: getMock }));

import { makeLakeComic } from '../../../shared/comic/__fixtures__/lakeComic';
import { DOLLAR_CONTEXT } from '../../../services/costDisplay';
import { costFormat } from '../conversation/cost';
import { NOT_ENOUGH_DATA_COPY, NO_OPENROUTER_PRICE_COPY, NO_UPTIME_COPY, PRICE_UNPUBLISHED_COPY } from './copy';
import { insightsMoney } from './insightsModel';
import { TrendsTab } from './TrendsTab';
import { __resetInsightsCacheForTests } from './useInsights';

const dollars = insightsMoney(costFormat(DOLLAR_CONTEXT));

const trends = (over: Record<string, unknown> = {}) => ({
  range: '30d',
  from: '2026-09-29T00:00:00Z',
  to: '2026-10-29T00:00:00Z',
  t2: { yours: [{ month: '2026-10', modelId: 'nano-banana-2.1', images: 15 }], platform: [], source: { yours: 'comic_image_calls (your calls)', platform: 'model_usage_monthly' } },
  t3: { trackingSince: null, changes: [], note: null },
  t4: { moves: [{ modelId: 'nano-banana-pro', board: 'lmarena_edit', from: { asOf: '2026-04-02', rank: 1, score: 1250 }, to: { asOf: '2026-10-20', rank: 3, score: 1230 }, delta: -2 }], trackingSince: '2026-04-02', asOf: '2026-10-20', source: 'LMArena leaderboard-dataset history we hold' },
  t5: { sinceDays: 30, models: [{ id: 'qwen/qwen-image-2.1-turbo', name: 'Qwen Image 2.1 Turbo', created: '2026-10-16T00:00:00Z' }], fetchedAt: '2026-10-29T11:00:00Z', stale: false },
  t6: { ours: [{ modelId: 'nano-banana-2.1', window: '24h', calls: 12, failed: 1, rateLimited: 1, scope: 'you' }], openrouter: [], source: { ours: 'comic_image_calls', openrouter: 'OpenRouter uptime_last_1d' } },
  t7: { available: false, copy: NOT_ENOUGH_DATA_COPY, sinceDays: 30 },
  ...over
});

const mount = async (pro = false) => {
  const utils = render(<TrendsTab doc={makeLakeComic()} money={dollars} pro={pro} />);
  await act(async () => {});
  return utils;
};

beforeEach(() => {
  getMock.mockReset();
  __resetInsightsCacheForTests();
});

describe('Trends tab', () => {
  it('T1 from the doc (sparkline in Easy, stacked bars by kind in Pro), T2–T7 from the trends route', async () => {
    getMock.mockResolvedValue(trends());
    const { unmount } = await mount(false);
    expect(screen.getByRole('img', { name: /^Spent on this comic over time: \$0\.7918 so far$/ })).toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Your images by model per month' })).toHaveTextContent('Oct 2026 · Nano Banana 2.1 · 15 images');
    expect(screen.getByRole('list', { name: 'Leaderboard movement' })).toHaveTextContent('Nano Banana Pro: #1 → #3 since April');
    expect(screen.getByRole('list', { name: 'Our reliability' })).toHaveTextContent('12 calls · 1 failed · 1 rate-limited');
    unmount();
    await mount(true);
    expect(screen.getByRole('img', { name: 'Spent on this comic over time, by kind' })).toBeInTheDocument();
    expect(within(screen.getByRole('list', { name: 'Legend' })).getByText('Pages')).toBeInTheDocument();
  });

  it('§4.6: T7 below 5 users is "Not enough data yet"; T3 shows no line before the first fetch; no uptime is the copy', async () => {
    getMock.mockResolvedValue(trends());
    const { container } = await mount();
    expect(screen.getByText(NOT_ENOUGH_DATA_COPY)).toBeInTheDocument();
    expect(screen.queryByText('Price changes')).toBeNull();
    expect(container.textContent).not.toMatch(/Tracking since/);
    expect(screen.getByRole('list', { name: 'OpenRouter uptime' })).toHaveTextContent(NO_UPTIME_COPY);
  });

  it('T3 after the first fetch: "Tracking since {date}" and the changes we recorded', async () => {
    getMock.mockResolvedValue(trends({ t3: { trackingSince: '2026-10-23', changes: [{ modelId: 'nano-banana-2.1', res: '4K', usd: 0.113, basis: 'vendor_table', at: '2026-10-25T00:00:00Z', note: null }], note: 'Tracking since 2026-10-23' } }));
    await mount();
    expect(screen.getByText('Tracking since 2026-10-23')).toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Price changes' })).toHaveTextContent('Oct 25, 2026 · Nano Banana 2.1 4K: $0.113');
  });

  it('T3: a change to "no price" reads as the exact §4.6 copy, never a number', async () => {
    getMock.mockResolvedValue(
      trends({
        t3: {
          trackingSince: '2026-10-23',
          changes: [
            { modelId: 'nano-banana-2.1', res: '4K', usd: null, basis: 'openrouter_endpoint', at: '2026-10-25T00:00:00Z', note: null },
            { modelId: 'nano-banana-pro', res: '1K', usd: null, basis: 'openrouter_endpoint', at: '2026-10-26T00:00:00Z', note: 'OpenRouter publishes no price' }
          ],
          note: 'Tracking since 2026-10-23'
        }
      })
    );
    await mount();
    const list = screen.getByRole('list', { name: 'Price changes' });
    expect(list).toHaveTextContent(`Oct 25, 2026 · Nano Banana 2.1 4K: ${PRICE_UNPUBLISHED_COPY}`);
    expect(list).toHaveTextContent(`Oct 26, 2026 · Nano Banana Pro 1K: ${NO_OPENROUTER_PRICE_COPY}`);
    expect(list.textContent).not.toMatch(/\$/);
  });

  it('a failed load shows nothing invented and offers Try again; the range is asked on demand', async () => {
    getMock.mockRejectedValueOnce(Object.assign(new Error('Server error'), { status: 500 }));
    await mount();
    expect(screen.getByText(/Trends couldn’t load right now/)).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Leaderboard movement' })).toBeNull();
    getMock.mockResolvedValue(trends({ range: '90d' }));
    fireEvent.click(screen.getByRole('radio', { name: 'Last 90 days' }));
    await act(async () => {});
    expect(getMock.mock.calls.map((c) => c[0])).toEqual(['/api/comic/models/trends?range=30d', '/api/comic/models/trends?range=90d']);
    expect(screen.getByRole('list', { name: 'Leaderboard movement' })).toBeInTheDocument();
  });
});
