// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The tick must never touch the database for real; record what it asks the repository to do.
const repo = vi.hoisted(() => ({
  setVentureStatus: vi.fn(async () => true),
  appendEvent: vi.fn(async () => undefined),
  recordSpend: vi.fn(async () => undefined),
  createCheckpoint: vi.fn(async () => undefined)
}));
vi.mock('./repository.js', () => repo);

const metrics = vi.hoisted(() => ({ incr: vi.fn() }));
vi.mock('../observability/metrics.js', () => metrics);

const { runVentureTick, BUILD_RETIRED_MESSAGE } = await import('./tickRunner.js');

beforeEach(() => {
  for (const fn of [...Object.values(repo), metrics.incr]) fn.mockClear();
});

describe('runVentureTick (build stage retired)', () => {
  it('pauses the venture once with build_retired and returns the retired outcome', async () => {
    const result = await runVentureTick('user-1', 'venture-1');
    expect(result).toEqual({ outcome: 'retired' });
    expect(repo.setVentureStatus).toHaveBeenCalledTimes(1);
    expect(repo.setVentureStatus).toHaveBeenCalledWith('user-1', 'venture-1', 'paused', 'build_retired');
  });

  it('logs exactly one warning event that explains why', async () => {
    await runVentureTick('user-1', 'venture-1');
    expect(repo.appendEvent).toHaveBeenCalledTimes(1);
    expect(repo.appendEvent).toHaveBeenCalledWith({
      ventureId: 'venture-1',
      userId: 'user-1',
      kind: 'venture.paused',
      level: 'warn',
      message: BUILD_RETIRED_MESSAGE,
      source: 'engine'
    });
    expect(BUILD_RETIRED_MESSAGE).toMatch(/ADR 0005/);
  });

  it('spends nothing and raises no checkpoints', async () => {
    await runVentureTick('user-1', 'venture-1');
    expect(repo.recordSpend).not.toHaveBeenCalled();
    expect(repo.createCheckpoint).not.toHaveBeenCalled();
    expect(metrics.incr).toHaveBeenCalledWith('venture_tick', { outcome: 'retired' });
  });
});
