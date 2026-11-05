// @vitest-environment node
// Long-term memory and connected-account privacy: a free-model turn of a user with connected
// accounts gets the rest of their memory, never the rows distilled from connected content
// (`product = 'chat_studio_connected'`, ai/privacy/connectorData.ts CONNECTED_MEMORY_PRODUCT).
// Every retrieval path leaves those rows out when asked (`excludeConnected`):
//   - full-text search and the recency fallback filter in the query (`.neq('product', …)`);
//   - the vector path (match_user_memories has no product filter) asks for twice the rows and
//     filters after the fetch, falling back to the filtered recency query when nothing is left.
// Without the option nothing changes. Supabase and the embedding endpoint are fakes (no network).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CONNECTED_MEMORY_PRODUCT } from '../ai/privacy/connectorData.js';

type Row = { id: string; user_id: string; product: string; kind: string; content: string; updated_at: string };
const db = vi.hoisted(() => ({
  rows: [] as Row[],
  /** Every filter a user_memories query applied, per query. */
  queries: [] as { neq: [string, unknown][]; textSearch?: string; limit?: number }[],
  rpc: [] as { name: string; args: Record<string, unknown> }[],
  /** Rows written by rememberUserMemories. */
  upserts: [] as { product: string; content: string; embedding: number[] | null }[]
}));

vi.mock('./supabase.js', () => {
  const memoriesQuery = () => {
    const filters: { eq: [string, unknown][]; neq: [string, unknown][]; textSearch?: string; limit?: number } = { eq: [], neq: [] };
    db.queries.push(filters);
    const run = () => {
      let out = db.rows.filter(
        (r) =>
          filters.eq.every(([k, v]) => (r as Record<string, unknown>)[k] === v) &&
          filters.neq.every(([k, v]) => (r as Record<string, unknown>)[k] !== v) &&
          (!filters.textSearch || filters.textSearch.split(/\s+/).some((w) => r.content.toLowerCase().includes(w.toLowerCase())))
      );
      out = [...out].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
      return { data: out.slice(0, filters.limit ?? out.length), error: null };
    };
    const q: Record<string, unknown> = {
      select: () => q,
      eq: (k: string, v: unknown) => (filters.eq.push([k, v]), q),
      neq: (k: string, v: unknown) => (filters.neq.push([k, v]), q),
      textSearch: (_col: string, query: string) => ((filters.textSearch = query), q),
      order: () => q,
      limit: async (n: number) => ((filters.limit = n), run()),
      upsert: async (rows: { product: string; content: string; embedding: number[] | null }[]) => {
        db.upserts.push(...rows);
        return { error: null };
      }
    };
    return q;
  };
  const prefsQuery = () => {
    const q: Record<string, unknown> = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: { enabled: true }, error: null }) };
    return q;
  };
  return {
    getSupabaseAdmin: () => ({
      from: (table: string) => (table === 'user_memory_prefs' ? prefsQuery() : memoriesQuery()),
      // The vector search: the user's rows in "similarity" order (insertion order), p_limit of them.
      rpc: async (name: string, args: Record<string, unknown>) => {
        db.rpc.push({ name, args });
        const mine = db.rows.filter((r) => r.user_id === args.p_user_id);
        return { data: mine.slice(0, Number(args.p_limit)), error: null };
      }
    })
  };
});
vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  ASSISTANT_GEMINI_API_KEY: 'test-embedding-key'
}));

const embed = vi.hoisted(() => ({ ok: false }));
vi.stubGlobal(
  'fetch',
  vi.fn(async () =>
    embed.ok
      ? new Response(JSON.stringify({ embedding: { values: Array.from({ length: 768 }, (_, i) => (i === 0 ? 1 : 0)) } }), { status: 200 })
      : new Response('unavailable', { status: 503 })
  )
);

const { buildUserMemoryBlock, rememberUserMemories, retrieveUserMemories } = await import('./userMemory.js');

let seq = 0;
const row = (userId: string, product: string, content: string): Row => ({
  id: `m${seq}`,
  user_id: userId,
  product,
  kind: 'fact',
  content,
  updated_at: new Date(Date.UTC(2026, 0, 1, 0, 0, seq++)).toISOString()
});

const USER = 'user-1';
const CONNECTED_FACT = 'Planning the launch with Dana on Friday';
const PLAIN_FACT = 'Prefers short answers about the launch';

beforeEach(() => {
  db.rows = [];
  db.queries = [];
  db.rpc = [];
  db.upserts = [];
  embed.ok = false;
  delete process.env.CONNECTOR_PROVIDERS_CONFIRMED;
  vi.mocked(fetch).mockClear();
});

describe('buildUserMemoryBlock(…, { excludeConnected })', () => {
  it('full-text path: the marked rows are filtered in the query and never reach the block', async () => {
    db.rows = [row(USER, CONNECTED_MEMORY_PRODUCT, CONNECTED_FACT), row(USER, 'chat_studio', PLAIN_FACT)];

    const block = await buildUserMemoryBlock(USER, 'launch', { excludeConnected: true });
    expect(block).toContain(PLAIN_FACT);
    expect(block).not.toContain(CONNECTED_FACT);
    expect(db.queries[0].textSearch).toBe('launch');
    expect(db.queries[0].neq).toEqual([['product', CONNECTED_MEMORY_PRODUCT]]);
  });

  it('without the option nothing changes: both rows, no product filter', async () => {
    db.rows = [row(USER, CONNECTED_MEMORY_PRODUCT, CONNECTED_FACT), row(USER, 'chat_studio', PLAIN_FACT)];

    const block = await buildUserMemoryBlock(USER, 'launch');
    expect(block).toContain(PLAIN_FACT);
    expect(block).toContain(CONNECTED_FACT);
    expect(db.queries.every((q) => q.neq.length === 0)).toBe(true);
  });

  it('recency fallback (no query text, or nothing matched): filtered too', async () => {
    db.rows = [row(USER, 'chat_studio', PLAIN_FACT), row(USER, CONNECTED_MEMORY_PRODUCT, CONNECTED_FACT)];

    const block = await buildUserMemoryBlock(USER, '', { excludeConnected: true });
    expect(block).toContain(PLAIN_FACT);
    expect(block).not.toContain(CONNECTED_FACT);
    expect(db.queries).toHaveLength(1);
    expect(db.queries[0].neq).toEqual([['product', CONNECTED_MEMORY_PRODUCT]]);

    // A query that matches only the marked row falls through to the (filtered) recency query.
    db.queries = [];
    const fallback = await buildUserMemoryBlock(USER, 'Dana', { excludeConnected: true });
    expect(fallback).toContain(PLAIN_FACT);
    expect(fallback).not.toContain(CONNECTED_FACT);
    expect(db.queries.map((q) => q.neq)).toEqual([[['product', CONNECTED_MEMORY_PRODUCT]], [['product', CONNECTED_MEMORY_PRODUCT]]]);
  });

  it('vector path: twice the rows are fetched and the marked ones dropped, so plain rows ranked behind them still come back', async () => {
    embed.ok = true;
    // The 8 most similar rows are all marked; 3 plain ones follow.
    for (let i = 0; i < 8; i += 1) db.rows.push(row(USER, CONNECTED_MEMORY_PRODUCT, `${CONNECTED_FACT} #${i}`));
    for (let i = 0; i < 3; i += 1) db.rows.push(row(USER, 'chat_studio', `${PLAIN_FACT} #${i}`));

    const rows = await retrieveUserMemories(USER, 'launch', { excludeConnected: true });
    expect(db.rpc).toHaveLength(1);
    expect(db.rpc[0].args.p_limit).toBe(16);
    expect(rows.map((r) => r.product)).toEqual(['chat_studio', 'chat_studio', 'chat_studio']);
    expect(db.queries).toHaveLength(0); // no recency fallback needed

    // Unchanged without the option: 8 rows asked for, the marked ones included.
    db.rpc = [];
    const all = await retrieveUserMemories(USER, 'launch');
    expect(db.rpc[0].args.p_limit).toBe(8);
    expect(all).toHaveLength(8);
    expect(all.every((r) => r.product === CONNECTED_MEMORY_PRODUCT)).toBe(true);
  });

  it('vector path with only marked rows in reach: falls back to the filtered recency query', async () => {
    embed.ok = true;
    for (let i = 0; i < 20; i += 1) db.rows.push(row(USER, CONNECTED_MEMORY_PRODUCT, `${CONNECTED_FACT} #${i}`));
    db.rows.push(row(USER, 'chat_studio', PLAIN_FACT));

    const block = await buildUserMemoryBlock(USER, 'launch', { excludeConnected: true });
    expect(block).toContain(PLAIN_FACT);
    expect(block).not.toContain(CONNECTED_FACT);
    expect(db.queries.at(-1)?.neq).toEqual([['product', CONNECTED_MEMORY_PRODUCT]]);
  });

  it('caps the vector result at the usual 8 rows even when 16 plain rows come back', async () => {
    embed.ok = true;
    for (let i = 0; i < 16; i += 1) db.rows.push(row(USER, 'chat_studio', `${PLAIN_FACT} #${i}`));
    const rows = await retrieveUserMemories(USER, 'launch', { excludeConnected: true });
    expect(rows).toHaveLength(8);
  });
});

describe('memory distilled from connected content and the platform Gemini embedding key', () => {
  it('is stored without an embedding (nothing sent to Gemini) until the owner confirms gemini; other memory is embedded as before', async () => {
    embed.ok = true;
    await rememberUserMemories(USER, CONNECTED_MEMORY_PRODUCT, null, [{ content: CONNECTED_FACT }]);
    expect(db.upserts[0]).toMatchObject({ product: CONNECTED_MEMORY_PRODUCT, embedding: null });
    expect(fetch).not.toHaveBeenCalled();

    await rememberUserMemories(USER, 'chat_studio', null, [{ content: PLAIN_FACT }]);
    expect(Array.isArray(db.upserts[1].embedding)).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);

    process.env.CONNECTOR_PROVIDERS_CONFIRMED = 'gemini';
    await rememberUserMemories(USER, CONNECTED_MEMORY_PRODUCT, null, [{ content: `${CONNECTED_FACT} (again)` }]);
    expect(Array.isArray(db.upserts[2].embedding)).toBe(true);
  });
});

describe('buildUserMemoryBlock reports a marked row in the block it returns', () => {
  it('report.connected is true only when a row distilled from connected content was included', async () => {
    db.rows = [row(USER, CONNECTED_MEMORY_PRODUCT, CONNECTED_FACT), row(USER, 'chat_studio', PLAIN_FACT)];
    const withMarked = { connected: false };
    expect(await buildUserMemoryBlock(USER, '', { report: withMarked })).toContain(CONNECTED_FACT);
    expect(withMarked.connected).toBe(true);

    const without = { connected: false };
    expect(await buildUserMemoryBlock(USER, '', { excludeConnected: true, report: without })).not.toContain(CONNECTED_FACT);
    expect(without.connected).toBe(false);
  });
});
