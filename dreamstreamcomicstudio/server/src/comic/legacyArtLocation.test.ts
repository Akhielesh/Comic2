import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import { legacyArtScope, migratedArtPaths } from './legacyArtLocation.js';

const owner = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const project = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const img = (id: string, file: string) => `u/${owner}/p/${id}/img/${file}`;
const one = img(project, 'old.webp');

describe('trusted project artwork locations', () => {
  it('admits only the existing project image namespace', () => {
    expect(legacyArtScope(one)).toEqual({ owner, project });
    for (const key of [
      'pub/A/image.webp',
      'library/v1/cover.webp',
      `u/${owner}/tmp/x.webp`,
      one.replace('/img/', '/ref/'),
      one.replace('/img/', '/IMG/'),
      one.replace(owner, owner.toUpperCase()),
      one.replace('old', '../other'),
      img(project, 'draft-v1-00000000-0000-4000-8000-000000000001_w480.webp')
    ])
      expect(legacyArtScope(key)).toBeUndefined();
  });
  it('coalesces in-flight reads and batches many images, caches active locations, and observes an immediate cutover', async () => {
    const keys = Array.from({ length: 80 }, (_, i) => img(project, `image-${i}.webp`));
    let rows: { project_id: string; owner_id: string }[] = [];
    const rpc = vi.fn(() => ({ abortSignal: async () => ({ data: rows, error: null }) }));
    const admin = () => client;
    const client = { rpc } as unknown as SupabaseClient;
    expect((await migratedArtPaths(admin, keys)).size).toBe(0);
    rows = [{ project_id: project, owner_id: owner }];
    const result = await Promise.all([
      migratedArtPaths(admin, keys),
      migratedArtPaths(admin, keys.slice(5)),
      migratedArtPaths(admin, keys.slice(3))
    ]);
    expect(result[0].size).toBe(80);
    expect(result[1].size).toBe(75);
    expect(rpc.mock.calls).toHaveLength(2);
    expect(rpc).toHaveBeenLastCalledWith('comic_private_art_scopes', { p_project_ids: [project] });
    expect((await migratedArtPaths(admin, keys)).size).toBe(80);
    expect(rpc).toHaveBeenCalledTimes(2);
    await expect(migratedArtPaths(admin, [one.replace(owner, project)])).rejects.toMatchObject({ status: 503 });
  });
  it('limits each database read to 128 distinct projects', async () => {
    const projects = Array.from({ length: 132 }, (_, n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`);
    const rpc = vi.fn((_name: string, { p_project_ids }: { p_project_ids: string[] }) => ({
      abortSignal: async () => ({ data: p_project_ids.map((project_id) => ({ project_id, owner_id: owner })), error: null })
    }));
    const client = { rpc } as unknown as SupabaseClient;
    expect(
      (
        await migratedArtPaths(
          () => client,
          projects.map((p) => img(p, 'art.webp'))
        )
      ).size
    ).toBe(132);
    expect(rpc.mock.calls.map(([, args]) => args.p_project_ids.length)).toEqual([128, 4]);
  });
  it('checks an expired positive location again and refuses an unverifiable result', async () => {
    vi.useFakeTimers();
    try {
      const responses = vi
        .fn()
        .mockResolvedValueOnce({ data: [{ project_id: project, owner_id: owner }], error: null })
        .mockResolvedValueOnce({ data: null, error: { code: '503' } });
      const client = { rpc: () => ({ abortSignal: responses }) } as unknown as SupabaseClient;
      expect(await migratedArtPaths(() => client, [one])).toEqual(new Set([one]));
      vi.advanceTimersByTime(60_001);
      await expect(migratedArtPaths(() => client, [one])).rejects.toMatchObject({ status: 503 });
      expect(responses).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
  it('refuses ambiguous database failures, unrelated rows or invalid owner metadata', async () => {
    for (const response of [
      { data: null, error: { code: '503' } },
      { data: {}, error: null },
      { data: [{ project_id: owner, owner_id: owner }], error: null },
      { data: [{ project_id: project, owner_id: 'no-owner' }], error: null }
    ]) {
      const admin = () => ({ rpc: () => ({ abortSignal: async () => response }) }) as unknown as SupabaseClient;
      await expect(migratedArtPaths(admin, [one])).rejects.toMatchObject({ status: 503 });
      expect(await migratedArtPaths(admin, ['library/v1/x.webp'])).toEqual(new Set());
    }
  });
});
