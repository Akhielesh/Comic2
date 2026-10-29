// Model Lab client API: a run request always carries ack + the confirmed quote + the click id; answers are checked
// field by field (a pair never carries names before its vote, a quote-less item can never run); server refusals keep
// their code and honest copy; a lost answer reads as "safe to retry the same click".
import { beforeEach, describe, expect, it, vi } from 'vitest';

const post = vi.fn();
const get = vi.fn();
vi.mock('../../../../services/apiClient', async (orig) => ({ ...(await orig<typeof import('../../../../services/apiClient')>()), post: (...a: unknown[]) => post(...a), get: (...a: unknown[]) => get(...a) }));

const { ApiError } = await import('../../../../services/apiClient');
const { LabApiError, asBlindPair, asOverview, fetchLabOverview, formatLabUsd, newClickId, runLabCheck } = await import('./labApi');

beforeEach(() => {
  post.mockReset();
  get.mockReset();
});

describe('labApi', () => {
  it('runLabCheck always sends ack: true with the confirmed quote and the click id', async () => {
    post.mockResolvedValueOnce({ replayed: false, spentUsd: 0.1, remainingUsd: 1.9, run: { id: 'r', checkId: 'D4', itemId: 'x', status: 'ok', pair: { id: 'd4-sheet-1', label: 'Sheet 1' }, quotedUsd: 0.018, costUsd: 0.018 } });
    const out = await runLabCheck({ itemId: 'd4-x', idempotencyKey: 'lab-0123456789abcdef', quotedUsd: 0.018 });
    expect(post).toHaveBeenCalledWith('/api/comic/models/lab/runs', { itemId: 'd4-x', idempotencyKey: 'lab-0123456789abcdef', ack: true, quotedUsd: 0.018 });
    expect(out.run).toMatchObject({ checkId: 'D4', pair: { id: 'd4-sheet-1' } });
    expect(out.run).not.toHaveProperty('facts');
  });

  it('a pair never carries names before its vote, even if a server sent them', () => {
    const run = { id: 'r1', checkId: 'D4', status: 'ok', quotedUsd: 0.018, model: { id: 'qwen/qwen-image-2.1-turbo', nickname: 'Qwen 2.1 Turbo' }, facts: {} };
    const ready = asBlindPair({ id: 'd4-sheet-1', label: 'Sheet 1', state: 'ready', a: { slot: 'A', imageUrl: 'https://x.example/a.webp', run }, b: { slot: 'B', imageUrl: 'javascript:alert(1)' } });
    expect(ready).toEqual({ id: 'd4-sheet-1', label: 'Sheet 1', state: 'ready', a: { slot: 'A', imageUrl: 'https://x.example/a.webp' }, b: { slot: 'B' } });
    const voted = asBlindPair({ id: 'd4-sheet-1', label: 'Sheet 1', state: 'voted', pick: 'A', a: { slot: 'A', run }, b: { slot: 'B', run: { ...run, id: 'r2' } } });
    expect(voted?.a?.run?.model.nickname).toBe('Qwen 2.1 Turbo');
  });

  it('an item without a quote can never run; malformed checks and items are dropped', () => {
    const o = asOverview({
      capUsd: 2,
      spentUsd: 0,
      checks: [
        { id: 'D1', title: 'D1', items: [{ id: 'a', check: 'D1', title: 'A', canRun: true, quote: null }, { id: 'b', check: 'D1', title: 'B', canRun: true, quote: { usd: 0.1, basis: 'x' } }, { nope: true }] },
        { id: 'D9', items: [] }
      ],
      blind: [{ id: 'p', label: 'P', state: 'weird' }]
    });
    expect(o?.checks.map((c) => c.id)).toEqual(['D1']);
    expect(o?.checks[0].items.map((i) => [i.id, i.canRun])).toEqual([
      ['a', false],
      ['b', true]
    ]);
    expect(o?.blind).toEqual([]);
    expect(asOverview({ checks: [] })).toBeNull();
  });

  it('refusals keep their code and copy; an unreached server reads as safe to retry the same click', async () => {
    post.mockRejectedValueOnce(new ApiError("Today's lab budget can't cover this. Nothing was charged.", 409, { code: 'LAB_CAP_REACHED', spentUsd: 1.95 }));
    const err = await runLabCheck({ itemId: 'x', idempotencyKey: 'lab-0123456789abcdef', quotedUsd: 0.1 }).catch((e) => e);
    expect(err).toBeInstanceOf(LabApiError);
    expect(err).toMatchObject({ status: 409, code: 'LAB_CAP_REACHED', message: "Today's lab budget can't cover this. Nothing was charged.", unreached: false });
    post.mockRejectedValueOnce(new ApiError('network', 0));
    const lost = await runLabCheck({ itemId: 'x', idempotencyKey: 'lab-0123456789abcdef', quotedUsd: 0.1 }).catch((e) => e);
    expect(lost).toMatchObject({ status: 0, unreached: true });
    expect(lost.message).toMatch(/same click/);
    get.mockResolvedValueOnce({ junk: true });
    await expect(fetchLabOverview()).rejects.toMatchObject({ status: 502 });
  });

  it('click ids and money', () => {
    const a = newClickId();
    expect(a).toMatch(/^lab-[0-9a-f]{32}$/);
    expect(newClickId()).not.toBe(a);
    expect([formatLabUsd(2), formatLabUsd(0.113), formatLabUsd(0.0184), formatLabUsd(0), formatLabUsd(null)]).toEqual(['$2.00', '$0.113', '$0.0184', '$0', '—']);
  });
});
