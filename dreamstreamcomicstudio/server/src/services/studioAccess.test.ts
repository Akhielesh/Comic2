import { beforeEach, describe, expect, it, vi } from 'vitest';

// loadAccountAccess reads through the service-role client and rbac; stand both in.
const rows = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
vi.mock('./supabase.js', () => ({
  getSupabaseAdmin: () => ({
    from: (table: string) => {
      const q = {
        select: () => q,
        eq: () => q,
        maybeSingle: async () => ({ data: rows.current[table] ?? null, error: null }),
        // product_access (a list) and monitor_members (a head count) are awaited directly.
        then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
          Promise.resolve(
            table === 'product_access'
              ? { data: rows.current.product_access ?? [], error: null }
              : { data: null, error: null, count: (rows.current.monitor_members as number | undefined) ?? 0 },
          ).then(resolve, reject),
      };
      return q;
    },
    rpc: async () => ({ data: false, error: null }),
  }),
}));
vi.mock('./rbac.js', () => ({
  resolveAccessProfile: async () => ({ isAdmin: Boolean(rows.current.admin), isModerator: false, isResearcher: false, bootstrapAdmin: false, roles: [] }),
}));

const { computeStudioAccess, loadAccountAccess } = await import('./studioAccess.js');
type AccessInputs = Parameters<typeof computeStudioAccess>[0];

const base: AccessInputs = { productRows: [], streamMember: true, streamGrandfathered: false, nurseries: 2 };
const status = (r: ReturnType<typeof computeStudioAccess>) => Object.fromEntries(r.studios.map((s) => [s.id, s.status]));

describe('studio access', () => {
  it('open beta (no grants on file): every studio, baby monitor with its nurseries', () => {
    const r = computeStudioAccess(base);
    expect(r.confined).toBe(false);
    expect(status(r)).toEqual({ comic_studio: 'open', chat_studio: 'open', stream_studio: 'open', baby_monitor: 'open' });
    expect(r.studios.find((s) => s.id === 'baby_monitor')?.detail).toBe('2 nurseries');
  });

  it('confined by an admin: exactly the granted studios; the rest say how to get them', () => {
    const r = computeStudioAccess({ ...base, productRows: [{ product: 'stream_studio', active: true }, { product: 'comic_studio', active: false }] });
    expect(r.confined).toBe(true);
    expect(status(r)).toMatchObject({ comic_studio: 'locked', chat_studio: 'locked', stream_studio: 'open', baby_monitor: 'open' });
    const comic = r.studios.find((s) => s.id === 'comic_studio')!;
    expect(comic.detail).toBe('Access was turned off for this account');
    expect(comic.action?.label).toBe('Ask an admin for access');
    expect(r.studios.find((s) => s.id === 'chat_studio')?.detail).toBe('Not part of your account yet');
  });

  it('Stream Studio not unlocked yet: one step (welcome code), and the monitor comes with it', () => {
    const r = computeStudioAccess({ ...base, streamMember: false, nurseries: 0 });
    expect(status(r)).toMatchObject({ stream_studio: 'needs_code', baby_monitor: 'needs_code' });
    expect(r.studios.find((s) => s.id === 'stream_studio')?.action?.label).toBe('Enter welcome code');
  });

  it('an early account is unlocked on its first Stream Studio visit', () => {
    const r = computeStudioAccess({ ...base, streamMember: false, streamGrandfathered: true, nurseries: 0 });
    expect(status(r)).toMatchObject({ stream_studio: 'open', baby_monitor: 'open' });
    expect(r.studios.find((s) => s.id === 'baby_monitor')?.action?.label).toBe('Set up a nursery');
  });

  it('Code Studio is retired: it never appears, and every status is open, one step or locked', () => {
    const variants: AccessInputs[] = [
      base,
      { ...base, streamMember: false },
      { ...base, productRows: [{ product: 'code_studio', active: true }] },
      { ...base, productRows: [{ product: 'comic_studio', active: false }] },
    ];
    for (const v of variants) {
      const r = computeStudioAccess(v);
      expect(r.studios.map((s) => s.id)).not.toContain('code_studio');
      for (const s of r.studios) expect(['open', 'needs_code', 'locked']).toContain(s.status);
    }
  });
});

describe('loadAccountAccess: one name for the account', () => {
  beforeEach(() => {
    rows.current = {};
  });
  const load = () => loadAccountAccess({ id: 'u1', email: 'ada@example.com' });

  it('prefers the Stream Studio name and also returns the @handle', async () => {
    rows.current = {
      live_profiles: { display_name: 'Mum' },
      profile_private: { first_name: 'Ada', last_name: 'Lovelace' },
      profiles: { username: 'ada_1', created_at: '2026-01-01T00:00:00Z' },
      admin: true,
    };
    const r = await load();
    expect(r.account).toMatchObject({ name: 'Mum', username: 'ada_1', since: '2026-01-01T00:00:00Z', admin: true });
    expect(r.studios.map((s) => s.id)).not.toContain('code_studio');
  });

  it('falls back to first + last (DreamStream profile), then the handle', async () => {
    rows.current = { profile_private: { first_name: 'Ada', last_name: 'Lovelace' }, profiles: { username: 'ada_1' } };
    expect((await load()).account.name).toBe('Ada Lovelace');
    rows.current = { profiles: { username: 'ada_1' } };
    expect((await load()).account).toMatchObject({ name: 'ada_1', username: 'ada_1' });
    rows.current = {};
    expect((await load()).account).toMatchObject({ name: null, username: null });
  });
});
