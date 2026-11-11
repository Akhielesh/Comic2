// @vitest-environment node
// Program 3 ST-A (styles C12): admin spend — library builds (kind 'library') and Model Lab calls ('lab_*') — is
// recorded in comic_image_calls under the admin's user_id but never shows in a user-facing model stat: not in the
// admin's own "your calls" (observed cost, reliability, monthly images) and not in the platform aggregate, even
// when enough admins ran it to clear the ≥ 5-user floor.
import { describe, expect, it } from 'vitest';
import { FAKE_BASE, FIXTURE_NOW, callRow, fakeOpenRouterFetch, memoryCatalogStore, memoryImageCalls } from './__fixtures__/catalogFakes.js';
import { createModelCatalog } from './catalog.js';
import { createQualitySource } from './quality.js';

const ADMIN = 'admin-a';
const catalogWith = (calls: ReturnType<typeof memoryImageCalls>) =>
  createModelCatalog({ fetch: fakeOpenRouterFetch(), store: memoryCatalogStore(), calls, baseUrl: FAKE_BASE, now: () => FIXTURE_NOW, quality: createQualitySource({ fetch: null }) });
const nb = <T extends { id: string }>(rows: T[]) => rows.find((r) => r.id === 'nano-banana-2.1')!;

/** Admin spend from six "admins" (so the platform RPC would show the groups) plus the admin's own library rows. */
const adminSpend = () => [
  ...Array.from({ length: 18 }, (_, i) => callRow({ at: FIXTURE_NOW - (i + 1) * 60_000, userId: `admin-${i % 6}`, kind: 'library', res: '1K', providerCostUsd: 0.9 })),
  ...Array.from({ length: 18 }, (_, i) => callRow({ at: FIXTURE_NOW - (i + 1) * 61_000, userId: `admin-${i % 6}`, kind: 'lab_page', res: '4K', providerCostUsd: 0.9 })),
  ...Array.from({ length: 4 }, (_, i) => callRow({ at: FIXTURE_NOW - (i + 1) * 62_000, userId: ADMIN, kind: 'library', res: '1K', outcome: i === 0 ? 'failed' : 'ok', httpStatus: i === 0 ? 429 : undefined, providerCostUsd: 0.9 }))
];

describe('catalog: admin spend never reaches user-facing model stats', () => {
  it("the admin's own library and lab calls are not their observed cost, reliability or monthly images", async () => {
    const own = [0.041, 0.043, 0.045].map((cost, i) => callRow({ at: FIXTURE_NOW - (i + 1) * 30_000, userId: ADMIN, providerCostUsd: cost }));
    const catalog = catalogWith(memoryImageCalls([...own, ...adminSpend()]));
    const row = nb(await catalog.rows({ userId: ADMIN }));
    expect(row.observed).toEqual([expect.objectContaining({ kind: 'page', res: '1K', n: 3, scope: 'you' })]);
    expect(row.reliability).toEqual({ windowH: 24, calls: 3, failed: 0, rateLimited: 0, scope: 'you' });
    const src = await catalog.priceSources(ADMIN);
    expect(src.observed.every((o) => o.kind === 'page')).toBe(true);
    const t = await catalog.trends('30d', { userId: ADMIN });
    expect(t.t2.yours).toEqual([{ month: '2026-10', modelId: 'nano-banana-2.1', images: 3 }]);
  });

  it('the platform aggregate drops library and lab groups even past the 5-user floor', async () => {
    const catalog = catalogWith(memoryImageCalls(adminSpend()));
    const viewer = nb(await catalog.rows({ userId: 'viewer' }));
    expect(viewer.observed).toEqual([]);
    expect(viewer.reliability).toBeUndefined();
    const t = await catalog.trends('30d', { userId: 'viewer' });
    expect(t.t7.available).toBe(false);
  });
});
