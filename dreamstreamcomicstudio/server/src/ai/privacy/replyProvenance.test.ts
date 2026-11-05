// @vitest-environment node
// The server-side provenance of replies that carried connected-account content (finding C1a):
// a hash of the normalised reply text per user, written through `record_chat_connector_reply`
// (server/sql/chat_connector_replies.sql), looked up when the reply comes back as plain text.
// The database is a fake that records every call; it can also fail.
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Rpc = { fn: string; args: Record<string, unknown> };
type Query = { table: string; select: string; eq: [string, unknown][]; in: [string, unknown[]][]; gte: [string, unknown][]; limit?: number };
const db = vi.hoisted(() => ({
  rpcs: [] as Rpc[],
  queries: [] as Query[],
  rows: [] as { user_id: string; reply_hash: string }[],
  fail: false as false | 'throw' | 'error' | 'hang'
}));

vi.mock('../../services/supabase.js', () => ({
  getSupabaseAdmin: () => {
    if (db.fail === 'throw') throw new Error('no service role key');
    return {
      rpc: async (fn: string, args: Record<string, unknown>) => {
        db.rpcs.push({ fn, args });
        return db.fail === 'error' ? { error: { message: 'relation does not exist' } } : { error: null };
      },
      from: (table: string) => {
        const q: Query = { table, select: '', eq: [], in: [], gte: [] };
        db.queries.push(q);
        const chain = {
          select: (cols: string) => ((q.select = cols), chain),
          eq: (c: string, v: unknown) => (q.eq.push([c, v]), chain),
          in: (c: string, v: unknown[]) => (q.in.push([c, v]), chain),
          gte: (c: string, v: unknown) => (q.gte.push([c, v]), chain),
          limit: (n: number) => {
            q.limit = n;
            if (db.fail === 'hang') return new Promise(() => undefined);
            if (db.fail === 'error') return Promise.resolve({ data: null, error: { message: 'relation does not exist' } });
            const user = q.eq.find(([c]) => c === 'user_id')?.[1];
            const hashes = (q.in.find(([c]) => c === 'reply_hash')?.[1] || []) as string[];
            const data = db.rows.filter((r) => r.user_id === user && hashes.includes(r.reply_hash)).slice(0, n);
            return Promise.resolve({ data, error: null });
          }
        };
        return chain;
      }
    };
  }
}));

const {
  __resetConnectorReplyCacheForTests,
  assistantReplyHashes,
  CONNECTOR_REPLY_KEEP,
  CONNECTOR_REPLY_TABLE,
  CONNECTOR_REPLY_TTL_DAYS,
  connectorReplyHash,
  historyHasConnectorReply,
  recordConnectorReply
} = await import('./replyProvenance.js');

beforeEach(() => {
  db.rpcs = [];
  db.queries = [];
  db.rows = [];
  db.fail = false;
  __resetConnectorReplyCacheForTests();
});

const REPLY = 'Dana asked to move the launch to Friday.';
const historyWith = (reply: string) => [
  { role: 'user', content: 'Summarise my unread email' },
  { role: 'assistant', content: reply },
  { role: 'user', content: 'Tell me a joke' }
];

describe('the reply hash', () => {
  it('is a SHA-256 of the normalised text: whitespace and Unicode form do not matter; the text does', () => {
    const h = connectorReplyHash(REPLY);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(connectorReplyHash(`  Dana asked to move\n the launch   to Friday.\n`)).toBe(h);
    expect(connectorReplyHash('Café')).toBe(connectorReplyHash('Café'));
    expect(connectorReplyHash('Dana asked to move the launch to Monday.')).not.toBe(h);
    expect(connectorReplyHash('   ')).toBeNull();
    expect(connectorReplyHash(undefined)).toBeNull();
  });

  it('only assistant replies are looked up (text parts too), deduplicated', () => {
    const hashes = assistantReplyHashes([
      { role: 'user', content: REPLY },
      { role: 'assistant', content: REPLY },
      { role: 'assistant', content: [{ type: 'text', text: REPLY }] },
      { role: 'assistant', content: 'Other.' }
    ]);
    expect(hashes).toEqual([connectorReplyHash(REPLY), connectorReplyHash('Other.')]);
  });
});

describe('record and recognise', () => {
  it('records through the bounded SQL function (never the text), and recognises the reply in later history', async () => {
    await recordConnectorReply('user-1', REPLY);
    expect(db.rpcs).toEqual([
      {
        fn: 'record_chat_connector_reply',
        args: { p_user_id: 'user-1', p_reply_hash: connectorReplyHash(REPLY), p_keep: CONNECTOR_REPLY_KEEP, p_ttl_days: CONNECTOR_REPLY_TTL_DAYS }
      }
    ]);
    expect(JSON.stringify(db.rpcs)).not.toContain('Dana');
    // Same process: the cache answers at once, no query.
    expect(await historyHasConnectorReply('user-1', historyWith(REPLY))).toBe(true);
    expect(db.queries).toHaveLength(0);
  });

  it('after a restart (empty cache) the durable store answers, scoped to the user and the TTL', async () => {
    db.rows = [{ user_id: 'user-1', reply_hash: connectorReplyHash(REPLY)! }];
    expect(await historyHasConnectorReply('user-1', historyWith(REPLY))).toBe(true);
    const [q] = db.queries;
    expect(q.table).toBe(CONNECTOR_REPLY_TABLE);
    expect(q.eq).toEqual([['user_id', 'user-1']]);
    expect(q.in[0][1]).toEqual([connectorReplyHash(REPLY)]);
    expect(q.gte[0][0]).toBe('created_at');
    // Another user's identical text is not theirs.
    expect(await historyHasConnectorReply('user-2', historyWith(REPLY))).toBe(false);
    // A reply that was never marked is not recognised.
    expect(await historyHasConnectorReply('user-1', historyWith('Tides come from the moon.'))).toBe(false);
  });

  it('nothing to look up: no user, or no assistant reply — no query', async () => {
    expect(await historyHasConnectorReply(undefined, historyWith(REPLY))).toBe(false);
    expect(await historyHasConnectorReply('user-1', [{ role: 'user', content: REPLY }])).toBe(false);
    await recordConnectorReply(undefined, REPLY);
    await recordConnectorReply('user-1', '  ');
    expect(db.queries).toHaveLength(0);
    expect(db.rpcs).toHaveLength(0);
  });
});

describe('failure never blocks a chat', () => {
  it('a failed write is logged and still remembered in-process', async () => {
    db.fail = 'error';
    await expect(recordConnectorReply('user-1', REPLY)).resolves.toBeUndefined();
    expect(await historyHasConnectorReply('user-1', historyWith(REPLY))).toBe(true);
  });

  it('a database that is down or missing (or slow) answers from the cache: false for an unknown reply', async () => {
    for (const mode of ['throw', 'error'] as const) {
      db.fail = mode;
      expect(await historyHasConnectorReply('user-9', historyWith(REPLY))).toBe(false);
    }
    vi.useFakeTimers();
    try {
      db.fail = 'hang';
      const pending = historyHasConnectorReply('user-9', historyWith(REPLY));
      await vi.advanceTimersByTimeAsync(1_600);
      expect(await pending).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
