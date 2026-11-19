// @vitest-environment node
// upsertSubscriber (the waitlist store behind POST /api/newsletter/subscribe): a save that did not happen is never
// reported as one (supabase-js returns its errors instead of throwing, so each is read here and thrown, and the
// route answers 503), and a request for an address that is already on the list writes nothing to that row (rows
// are keyed by an email the caller supplies, so a stranger must not be able to replace what someone else wrote).
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Result = { data: unknown; error: { code?: string; message?: string } | null };
interface Op {
  kind: 'select' | 'insert' | 'update';
  payload?: unknown;
}

const db = {
  available: true,
  selectResult: { data: null, error: null } as Result,
  insertResult: { data: null, error: null } as Result,
  updateResult: { data: null, error: null } as Result,
  ops: [] as Op[]
};

vi.mock('./supabase.js', () => ({
  getSupabaseAdmin: () => {
    if (!db.available) throw new Error('SUPABASE_SERVICE_ROLE_KEY is not set');
    return {
      from: () => {
        const chain: Record<string, unknown> = {};
        let pending: Op | null = null;
        chain.select = () => {
          pending = { kind: 'select' };
          return chain;
        };
        for (const k of ['eq', 'limit']) chain[k] = () => chain;
        chain.maybeSingle = async () => {
          db.ops.push(pending ?? { kind: 'select' });
          return db.selectResult;
        };
        chain.insert = async (payload: unknown) => {
          db.ops.push({ kind: 'insert', payload });
          return db.insertResult;
        };
        chain.update = (payload: unknown) => {
          const op: Op = { kind: 'update', payload };
          return {
            eq: async () => {
              db.ops.push(op);
              return db.updateResult;
            }
          };
        };
        return chain;
      }
    };
  }
}));

const { upsertSubscriber } = await import('./emailStore.js');

const DOWN = { code: '57P01', message: 'terminating connection' };

beforeEach(() => {
  db.available = true;
  db.selectResult = { data: null, error: null };
  db.insertResult = { data: null, error: null };
  db.updateResult = { data: null, error: null };
  db.ops = [];
});

describe('upsertSubscriber never reports a save that did not happen', () => {
  it('rejects when the lookup fails, and writes nothing', async () => {
    db.selectResult = { data: null, error: DOWN };
    await expect(upsertSubscriber('someone@example.com', 'access', 't', {})).rejects.toThrow();
    expect(db.ops.filter((op) => op.kind !== 'select')).toEqual([]);
  });

  it('rejects when the insert fails', async () => {
    db.insertResult = { data: null, error: DOWN };
    await expect(upsertSubscriber('someone@example.com', 'access', 't', {})).rejects.toThrow();
  });

  it('rejects when the store is not configured (no service role)', async () => {
    db.available = false;
    await expect(upsertSubscriber('someone@example.com', 'updates', 't', {})).rejects.toThrow();
  });

  it('rejects when re-issuing a confirm token fails', async () => {
    db.selectResult = { data: { id: 'row-1', confirmed: false }, error: null };
    db.updateResult = { data: null, error: DOWN };
    await expect(upsertSubscriber('someone@example.com', 'updates', 't', {}, undefined, { reissueToken: true })).rejects.toThrow();
  });

  it('counts a unique violation on insert (two requests at once) as already on the list', async () => {
    db.insertResult = { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint' } };
    await expect(upsertSubscriber('someone@example.com', 'access', 't', {})).resolves.toEqual({ outcome: 'already_registered' });
    await expect(upsertSubscriber('someone@example.com', 'updates', 't', {})).resolves.toEqual({ outcome: 'already_registered' });
  });

  it('stores a new address once, with its answers', async () => {
    await expect(
      upsertSubscriber('Someone@Example.com', 'access', 't', { source: 'x' }, { productInterests: ['chat_studio'], feedback: 'hi' })
    ).resolves.toEqual({ outcome: 'new' });
    const inserts = db.ops.filter((op) => op.kind === 'insert');
    expect(inserts).toHaveLength(1);
    expect(inserts[0].payload).toMatchObject({ email: 'someone@example.com', kind: 'access', product_interests: ['chat_studio'], feedback: 'hi', confirmed: false });
  });
});

describe('an address already on the list: its row is left as it is', () => {
  it('access: another caller’s answers do not replace the stored ones', async () => {
    db.selectResult = { data: { id: 'row-1', confirmed: false }, error: null };
    await expect(
      upsertSubscriber('someone@example.com', 'access', 't', {}, { productInterests: ['stream_studio'], feedback: 'not theirs' })
    ).resolves.toEqual({ outcome: 'already_registered' });
    expect(db.ops.filter((op) => op.kind !== 'select')).toEqual([]);
  });

  it('updates, unconfirmed, emails off: no new token, so a confirm link sent earlier still works', async () => {
    db.selectResult = { data: { id: 'row-1', confirmed: false }, error: null };
    await expect(upsertSubscriber('someone@example.com', 'updates', 't', {}, { feedback: 'x' }, { reissueToken: false })).resolves.toEqual({
      outcome: 'already_registered'
    });
    expect(db.ops.filter((op) => op.kind !== 'select')).toEqual([]);
  });

  it('updates, unconfirmed, emails on: only a fresh confirm token is written (never the answers)', async () => {
    db.selectResult = { data: { id: 'row-1', confirmed: false }, error: null };
    await expect(upsertSubscriber('someone@example.com', 'updates', 'fresh', {}, { feedback: 'x' }, { reissueToken: true })).resolves.toEqual({
      outcome: 'pending'
    });
    const writes = db.ops.filter((op) => op.kind !== 'select');
    expect(writes).toHaveLength(1);
    expect(writes[0].payload).toMatchObject({ confirm_token: 'fresh' });
    expect(writes[0].payload).not.toHaveProperty('feedback');
    expect(writes[0].payload).not.toHaveProperty('product_interests');
  });

  it('updates, already confirmed: nothing is written', async () => {
    db.selectResult = { data: { id: 'row-1', confirmed: true }, error: null };
    await expect(upsertSubscriber('someone@example.com', 'updates', 't', {}, undefined, { reissueToken: true })).resolves.toEqual({
      outcome: 'already_confirmed'
    });
    expect(db.ops.filter((op) => op.kind !== 'select')).toEqual([]);
  });
});
