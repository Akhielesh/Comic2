// @vitest-environment node
// Safety dependency wiring: holds take a suspended publication's pub/ copies down through the
// publication module (L11), and a swapped (fake) store can never drive real Storage deletes.
import { afterEach, describe, expect, it, vi } from 'vitest';

const removePublicationObjects = vi.hoisted(() => vi.fn(async (_projectId: string) => undefined));
vi.mock('../publication/index.js', () => ({ removePublicationObjects }));

const { configureSafety, resetSafety, safetyDeps } = await import('./deps.js');
const { fakeSafetyStore } = await import('./fakes.js');

afterEach(() => {
  resetSafety();
  removePublicationObjects.mockClear();
});

describe('safety deps: removePublicationObjects', () => {
  it('production wiring removes through publication/index.ts removePublicationObjects', async () => {
    resetSafety();
    await safetyDeps().removePublicationObjects('22222222-2222-4222-8222-222222222222');
    expect(removePublicationObjects).toHaveBeenCalledWith('22222222-2222-4222-8222-222222222222');
  });

  it('swapping the store alone makes the remover a no-op (a fake hold never deletes real objects)', async () => {
    configureSafety({ store: fakeSafetyStore() });
    await safetyDeps().removePublicationObjects('p');
    // A later patch that does not touch the store keeps the no-op.
    configureSafety({ now: () => 1 });
    await safetyDeps().removePublicationObjects('p');
    expect(removePublicationObjects).not.toHaveBeenCalled();
  });

  it('an explicit remover is used as given, with or without a store swap', async () => {
    const mine = vi.fn(async () => undefined);
    configureSafety({ store: fakeSafetyStore(), removePublicationObjects: mine });
    await safetyDeps().removePublicationObjects('a');
    configureSafety({ removePublicationObjects: mine });
    await safetyDeps().removePublicationObjects('b');
    expect(mine.mock.calls).toEqual([['a'], ['b']]);
    expect(removePublicationObjects).not.toHaveBeenCalled();
  });

  it('resetSafety brings the production remover back', async () => {
    configureSafety({ store: fakeSafetyStore() });
    resetSafety();
    await safetyDeps().removePublicationObjects('x');
    expect(removePublicationObjects).toHaveBeenCalledWith('x');
  });
});
