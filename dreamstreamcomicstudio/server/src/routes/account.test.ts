// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';

// A stand-in for the service-role client: records every write, never touches Supabase.
type Write = { table: string; op: string; row: Record<string, unknown>; opts?: unknown; eq?: [string, unknown] };
const fake = vi.hoisted(() => ({
  enabled: true,
  writes: [] as Write[],
  meta: [] as { id: string; attrs: { user_metadata: Record<string, unknown> } }[],
  ppError: null as { message: string } | null,
  lpError: null as { message: string } | null,
  metaError: null as { message: string } | null,
  /** Rows the live_profiles UPDATE matched — empty when the person has no Stream Studio membership. */
  lpRows: [{ user_id: 'user-1' }] as { user_id: string }[],
  /** The user_settings row the settings read finds (null: none), and a read error. */
  settingsRow: null as { encrypted_data: string; iv: string } | null,
  settingsError: null as { message: string } | null,
}));

vi.mock('../services/supabase.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/supabase.js')>()),
  getSupabaseCapabilityStatus: () => ({ storagePersistenceEnabled: fake.enabled }),
  getSupabaseAdmin: () => ({
    from: (table: string) => ({
      upsert: async (row: Record<string, unknown>, opts: unknown) => {
        fake.writes.push({ table, op: 'upsert', row, opts });
        return { error: fake.ppError };
      },
      update: (row: Record<string, unknown>) => {
        const w: Write = { table, op: 'update', row };
        fake.writes.push(w);
        return {
          eq: (col: string, val: unknown) => {
            w.eq = [col, val];
            return { select: async () => ({ data: fake.lpError ? null : fake.lpRows, error: fake.lpError }) };
          },
        };
      },
      insert: () => {
        throw new Error('the name route must never insert');
      },
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: fake.settingsRow, error: fake.settingsError }) }) }),
    }),
    auth: {
      admin: {
        updateUserById: async (id: string, attrs: { user_metadata: Record<string, unknown> }) => {
          fake.meta.push({ id, attrs });
          return { data: null, error: fake.metaError };
        },
      },
    },
  }),
}));

// The settings snapshot is encrypted under a key derived from this secret (server/src/lib/secureStore.ts).
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-secret';
const { accountRouter } = await import('./account.js');
const { encryptSecret } = await import('../lib/secureStore.js');

// Mirrors the production mount in server/src/index.ts:
//   app.use('/api/account', systemRateLimit, accountRouter)   (after requireAuth)
let signedIn = true;
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  if (signedIn) req.user = { id: 'user-1', email: 'someone@example.com' };
  next();
});
app.use('/api/account', accountRouter);

let server: Server;
let base = '';
beforeAll(async () => {
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
beforeEach(() => {
  signedIn = true;
  Object.assign(fake, { enabled: true, writes: [], meta: [], ppError: null, lpError: null, metaError: null, lpRows: [{ user_id: 'user-1' }], settingsRow: null, settingsError: null });
});

const patch = (body: unknown) =>
  fetch(`${base}/api/account/name`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('PATCH /api/account/name', () => {
  it('writes the cleaned name everywhere it lives and says the Stream Studio name changed', async () => {
    const res = await patch({ name: '  Ada   Lovelace ' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, name: 'Ada Lovelace', stream: true });

    const [pp, lp] = fake.writes;
    expect(pp).toMatchObject({ table: 'profile_private', op: 'upsert', row: { id: 'user-1', first_name: 'Ada', last_name: 'Lovelace' }, opts: { onConflict: 'id' } });
    expect(lp).toMatchObject({ table: 'live_profiles', op: 'update', row: { display_name: 'Ada Lovelace' }, eq: ['user_id', 'user-1'] });
    expect(typeof lp.row.updated_at).toBe('string');
    expect(fake.meta).toEqual([{ id: 'user-1', attrs: { user_metadata: { display_name: 'Ada Lovelace', first_name: 'Ada', last_name: 'Lovelace' } } }]);
  });

  it('never creates a Stream Studio membership for someone without one', async () => {
    fake.lpRows = [];
    const res = await patch({ name: 'Ada' });
    expect(await res.json()).toEqual({ ok: true, name: 'Ada', stream: false });
    expect(fake.writes.map((w) => w.op)).toEqual(['upsert', 'update']);
    expect(fake.writes[0].row).toMatchObject({ first_name: 'Ada', last_name: null });
  });

  it('rejects an empty or non-text name without writing anything', async () => {
    for (const body of [{ name: '   ' }, { name: 42 }, {}]) {
      const res = await patch(body);
      expect(res.status).toBe(400);
      expect((await res.json()).error.message).toMatch(/1–40 characters/);
    }
    expect(fake.writes).toEqual([]);
    expect(fake.meta).toEqual([]);
  });

  it('caps a long name at 40 characters (the Stream Studio limit)', async () => {
    const res = await patch({ name: 'x'.repeat(80) });
    expect((await res.json()).name).toHaveLength(40);
  });

  it('requires a signed-in caller', async () => {
    signedIn = false;
    const res = await patch({ name: 'Ada' });
    expect(res.status).toBe(401);
    expect(fake.writes).toEqual([]);
  });

  it('says so when accounts storage is unavailable', async () => {
    fake.enabled = false;
    const res = await patch({ name: 'Ada' });
    expect(res.status).toBe(503);
    expect(fake.writes).toEqual([]);
  });

  it('stops before the other stores when a table write fails', async () => {
    fake.ppError = { message: 'permission denied' };
    const res = await patch({ name: 'Ada' });
    expect(res.status).toBe(500);
    expect((await res.json()).error.message).toMatch(/Couldn’t save your name/);
    expect(fake.writes).toHaveLength(1);
    expect(fake.meta).toEqual([]);
  });

  it('still saves when only the auth metadata update fails (it just seeds future defaults)', async () => {
    fake.metaError = { message: 'gotrue down' };
    const res = await patch({ name: 'Ada' });
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
  });
});

// The client (services/cloudSync.ts) seeds the account from the device only when the answer is
// `data: null` with NO reason. A row that exists but cannot be read must therefore never come
// back as a plain null — the device, just purged at sign-in, would overwrite it with nothing.
describe('GET /api/account/settings', () => {
  const getSettings = async () => {
    const res = await fetch(`${base}/api/account/settings`);
    return { status: res.status, body: (await res.json()) as { ok: boolean; data: unknown; reason?: string } };
  };

  it('no row: data null and no reason — the account has no snapshot yet', async () => {
    const { status, body } = await getSettings();
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true, data: null });
    expect('reason' in body).toBe(false);
  });

  it('a readable row comes back decrypted', async () => {
    const enc = encryptSecret(JSON.stringify({ version: 2, keys: [{ id: 'k1', key: 'sk-real' }] }))!;
    fake.settingsRow = { encrypted_data: enc.ciphertext, iv: enc.iv };
    const { body } = await getSettings();
    expect(body).toEqual({ ok: true, data: { version: 2, keys: [{ id: 'k1', key: 'sk-real' }] } });
  });

  it('a row neither scheme can decrypt (a rotated server secret, say) is reported unreadable, never absent', async () => {
    // 48 random bytes: not this server's ciphertext, not a legacy client blob — both GCM tags fail.
    fake.settingsRow = { encrypted_data: Buffer.alloc(48, 7).toString('base64'), iv: Buffer.alloc(12, 1).toString('base64') };
    const { status, body } = await getSettings();
    expect(status).toBe(200);
    // Without the fix: { ok: true, data: null } — the same answer as "no snapshot".
    expect(body).toEqual({ ok: true, data: null, reason: 'unreadable' });
  });

  it('a row whose plaintext is not JSON is unreadable too', async () => {
    const enc = encryptSecret('not json at all')!;
    fake.settingsRow = { encrypted_data: enc.ciphertext, iv: enc.iv };
    const { body } = await getSettings();
    expect(body).toEqual({ ok: true, data: null, reason: 'unreadable' });
  });

  it('a failed database read is a failed read, not an empty account', async () => {
    fake.settingsError = { message: 'connection reset' };
    const { body } = await getSettings();
    expect(body).toEqual({ ok: true, data: null, reason: 'read_failed' });
  });

  it('keeps saying storage_disabled when account storage is off', async () => {
    fake.enabled = false;
    const { body } = await getSettings();
    expect(body).toEqual({ ok: true, data: null, reason: 'storage_disabled' });
  });

  it('requires a signed-in caller', async () => {
    signedIn = false;
    expect((await getSettings()).status).toBe(401);
  });
});
