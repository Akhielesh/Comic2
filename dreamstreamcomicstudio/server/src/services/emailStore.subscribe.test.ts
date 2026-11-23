// @vitest-environment node
// upsertSubscriber (the waitlist store behind POST /api/newsletter/subscribe): a save that did not happen is never
// reported as one (supabase-js returns its errors instead of throwing, so each is read here and thrown, and the
// route answers 503), and a request for an address that is already on the list never replaces that row's answers
// (rows are keyed by an email the caller supplies, so a stranger must not be able to replace what someone else wrote).
// The one change a repeat may make to a register-interest row is a yes to updates where none was stored.
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Result = { data: unknown; error: { code?: string; message?: string } | null };
interface Op {
  kind: 'select' | 'insert' | 'update' | 'upsert';
  payload?: unknown;
}

const db = {
  available: true,
  selectResult: { data: null, error: null } as Result,
  insertResult: { data: null, error: null } as Result,
  updateResult: { data: null, error: null } as Result,
  filters: [] as unknown[][],
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
          pending ??= { kind: 'select' };
          return chain;
        };
        for (const k of ['eq', 'is', 'gte', 'limit']) chain[k] = (...args: unknown[]) => {
          db.filters.push([k, ...args]);
          return chain;
        };
        const result = () => {
          db.ops.push(pending ?? { kind: 'select' });
          return pending?.kind === 'update' ? db.updateResult : db.selectResult;
        };
        chain.maybeSingle = async () => result();
        chain.then = (resolve: (r: Result) => unknown) => resolve(result());
        chain.insert = async (payload: unknown) => {
          db.ops.push({ kind: 'insert', payload });
          return db.insertResult;
        };
        chain.upsert = async (payload: unknown) => {
          db.ops.push({ kind: 'upsert', payload });
          return db.insertResult;
        };
        chain.update = (payload: unknown) => {
          pending = { kind: 'update', payload };
          return chain;
        };
        return chain;
      }
    };
  }
}));

const { upsertSubscriber, confirmSubscriber, markUnsubscribed, hasConfirmedUpdates } = await import('./emailStore.js');

const DOWN = { code: '57P01', message: 'terminating connection' };
const WORDING = 'Keep me updated about Comic Studio news and new DreamStream studios.';
const YES = { updates: true, at: '2026-11-19T10:00:00.000Z', wording: WORDING };
const NO = { updates: false, at: '2026-11-18T10:00:00.000Z', wording: WORDING };
const EARLIER_YES = { updates: true, at: '2026-11-17T10:00:00.000Z', wording: WORDING };

beforeEach(() => {
  db.available = true;
  db.selectResult = { data: null, error: null };
  db.insertResult = { data: null, error: null };
  db.updateResult = { data: null, error: null };
  db.ops = [];
  db.filters = [];
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

  it('stores a new address once, with its answers (the note also in the feedback column)', async () => {
    await expect(upsertSubscriber('Someone@Example.com', 'access', 't', { source: 'x' }, { feedback: 'hi' })).resolves.toEqual({ outcome: 'new' });
    const inserts = db.ops.filter((op) => op.kind === 'insert');
    expect(inserts).toHaveLength(1);
    expect(inserts[0].payload).toMatchObject({ email: 'someone@example.com', kind: 'access', feedback: 'hi', confirmed: false });
    expect(inserts[0].payload).not.toHaveProperty('product_interests');
  });
});

describe('an address already on the list: its row is left as it is', () => {
  it('access: another caller’s answers do not replace the stored ones', async () => {
    db.selectResult = { data: { id: 'row-1', confirmed: false }, error: null };
    await expect(
      upsertSubscriber('someone@example.com', 'access', 't', { answers: { v: 2, comment: 'not theirs' }, consent: NO }, { feedback: 'not theirs' })
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
    db.updateResult = { data: { id: 'row-1' }, error: null };
    await expect(upsertSubscriber('someone@example.com', 'updates', 'fresh', {}, { feedback: 'x' }, { reissueToken: true })).resolves.toEqual({
      outcome: 'pending'
    });
    const writes = db.ops.filter((op) => op.kind !== 'select');
    expect(writes).toHaveLength(1);
    expect(writes[0].payload).toMatchObject({ confirm_token: 'fresh' });
    expect(writes[0].payload).not.toHaveProperty('feedback');
    expect(writes[0].payload).not.toHaveProperty('product_interests');
  });

  it('updates: a ticked box never writes to a list-card row (it has no box)', async () => {
    db.selectResult = { data: { id: 'row-1', confirmed: false, metadata: {} }, error: null };
    await expect(upsertSubscriber('someone@example.com', 'updates', 't', { consent: YES }, undefined, { reissueToken: false })).resolves.toEqual({
      outcome: 'already_registered'
    });
    expect(db.ops.filter((op) => op.kind !== 'select')).toEqual([]);
  });

  it('updates, already confirmed: nothing is written', async () => {
    db.selectResult = { data: { id: 'row-1', confirmed: true }, error: null };
    await expect(upsertSubscriber('someone@example.com', 'updates', 't', {}, undefined, { reissueToken: true })).resolves.toEqual({
      outcome: 'already_confirmed'
    });
    expect(db.ops.filter((op) => op.kind !== 'select')).toEqual([]);
  });
});

describe('register interest, already on the list: a later yes to updates is recorded, nothing else', () => {
  const STORED = { source: 'landing', answers: { v: 2, makes: ['kids'], comment: 'First visit' } };

  it('a ticked box on a row with no yes stores the yes, keeping every other key of the stored metadata', async () => {
    for (const before of [STORED, { ...STORED, consent: NO }, { answers: { v: 1, studios: ['chat_studio'] } }, null]) {
      db.ops = [];
      db.selectResult = { data: { id: 'row-1', confirmed: false, metadata: before }, error: null };
      await expect(
        upsertSubscriber('someone@example.com', 'access', 't', { source: 'auth', answers: { v: 2, comment: 'Second visit' }, consent: YES }, { feedback: 'Second visit' })
      ).resolves.toEqual({ outcome: 'already_registered' });
      const writes = db.ops.filter((op) => op.kind !== 'select');
      expect(writes, JSON.stringify(before)).toEqual([{ kind: 'update', payload: { metadata: { ...(before ?? {}), consent: YES } } }]);
    }
  });

  it('answers, the note and the source are never part of that write', async () => {
    db.selectResult = { data: { id: 'row-1', confirmed: false, metadata: STORED }, error: null };
    await upsertSubscriber('someone@example.com', 'access', 't', { source: 'auth', answers: { v: 2, comment: 'Not theirs' }, consent: YES }, { feedback: 'Not theirs' });
    const [write] = db.ops.filter((op) => op.kind !== 'select');
    expect(Object.keys(write.payload as object)).toEqual(['metadata']);
    expect((write.payload as { metadata: Record<string, unknown> }).metadata.answers).toEqual(STORED.answers);
    expect((write.payload as { metadata: Record<string, unknown> }).metadata.source).toBe('landing');
  });

  it('a no never overwrites a stored yes, and a yes over a yes writes nothing', async () => {
    for (const incoming of [{ consent: NO }, {}, { consent: YES }, { consent: { updates: 'true' } }]) {
      db.ops = [];
      db.selectResult = { data: { id: 'row-1', confirmed: false, metadata: { ...STORED, consent: EARLIER_YES } }, error: null };
      await expect(upsertSubscriber('someone@example.com', 'access', 't', incoming)).resolves.toEqual({ outcome: 'already_registered' });
      expect(db.ops.filter((op) => op.kind !== 'select'), JSON.stringify(incoming)).toEqual([]);
    }
  });

  it('an unticked box (or none) writes nothing to a row with no yes', async () => {
    for (const incoming of [{ consent: NO }, {}, { consent: { updates: 1 } }]) {
      db.ops = [];
      db.selectResult = { data: { id: 'row-1', confirmed: false, metadata: STORED }, error: null };
      await upsertSubscriber('someone@example.com', 'access', 't', incoming);
      expect(db.ops.filter((op) => op.kind !== 'select'), JSON.stringify(incoming)).toEqual([]);
    }
  });

  it('a failed write of the yes throws (the route answers 503), like every other write', async () => {
    db.selectResult = { data: { id: 'row-1', confirmed: false, metadata: STORED }, error: null };
    db.updateResult = { data: null, error: DOWN };
    await expect(upsertSubscriber('someone@example.com', 'access', 't', { consent: YES })).rejects.toThrow();
  });
});

describe('double opt-in and unsubscribe', () => {
  it('reuses an unexpired pending link and never revives an unsubscribed row', async () => {
    const row = { id: 'r', confirmed: false, confirm_token: 'original', confirm_sent_at: new Date().toISOString(), mail_requested_at: new Date().toISOString() };
    db.selectResult.data = row;
    const subscribe = () => upsertSubscriber('a@example.com', 'updates', 'replacement', {}, {}, { reissueToken: true });
    await expect(subscribe()).resolves.toEqual({ outcome: 'pending', confirmToken: 'original' });
    db.selectResult.data = { ...row, unsubscribed_at: row.confirm_sent_at };
    await expect(subscribe()).resolves.toEqual({ outcome: 'already_registered' });
    expect(db.ops.every(op => op.kind === 'select')).toBe(true);
  });

  it('only sends a renewed link when the previous token and ownership state still match', async () => {
    db.selectResult.data = { id: 'r', confirmed: false, confirm_token: 'old', confirm_sent_at: '2000-01-01T00:00:00Z' };
    await expect(upsertSubscriber('a@example.com', 'updates', 'replacement', {}, {}, { reissueToken: true }))
      .resolves.toEqual({ outcome: 'already_registered' });
    expect(db.filters).toEqual(expect.arrayContaining([['eq', 'confirm_token', 'old'], ['eq', 'confirmed', false], ['is', 'unsubscribed_at', null]]));
  });

  it('consumes only a matching, unexpired, unused token, and reports whether it won the update', async () => {
    db.updateResult.data = { id: 'r' };
    await expect(confirmSubscriber('A@example.com', 'token')).resolves.toBe(true);
    expect(db.filters).toEqual(expect.arrayContaining([
      ['eq', 'email', 'a@example.com'], ['eq', 'kind', 'updates'], ['eq', 'confirmed', false],
      ['eq', 'confirm_token', 'token'], ['is', 'unsubscribed_at', null], ['gte', 'confirm_sent_at', expect.any(String)]
    ]));
    db.updateResult.data = null;
    await expect(confirmSubscriber('a@example.com', 'token')).resolves.toBe(false);
    db.updateResult.error = DOWN;
    await expect(confirmSubscriber('a@example.com', 'token')).rejects.toThrow('confirmation');
  });

  it('requires a durable suppression and unsubscribe update before success', async () => {
    db.insertResult.error = DOWN;
    await expect(markUnsubscribed('A@example.com')).rejects.toThrow('suppression');
    expect(db.ops.map(op => op.kind)).toEqual(['upsert']);
    db.insertResult.error = null;
    db.updateResult.error = DOWN;
    await expect(markUnsubscribed('A@example.com')).rejects.toThrow('unsubscribe');
    db.updateResult.error = null;
    await expect(markUnsubscribed('A@example.com')).resolves.toBeUndefined();
    expect(db.ops.at(-1)?.payload).toMatchObject({ confirm_token: null, unsubscribed_at: expect.any(String) });
  });
});

describe('campaign audience eligibility', () => {
  it('requires a confirmed updates row with no unsubscribe date for this exact recipient', async () => {
    db.selectResult = { data: { id: 'confirmed-row' }, error: null };
    expect(await hasConfirmedUpdates(' Reader@Example.com ')).toBe(true);
    expect(db.filters).toEqual([
      ['eq', 'email', 'reader@example.com'], ['eq', 'kind', 'updates'],
      ['eq', 'confirmed', true], ['is', 'unsubscribed_at', null]
    ]);
  });
  it('denies delivery when the row is absent or the database cannot verify consent', async () => {
    expect(await hasConfirmedUpdates('a@example.com')).toBe(false);
    db.selectResult = { data: { id: 'partial' }, error: DOWN };
    expect(await hasConfirmedUpdates('a@example.com')).toBe(false);
    db.available = false;
    expect(await hasConfirmedUpdates('a@example.com')).toBe(false);
  });
});
