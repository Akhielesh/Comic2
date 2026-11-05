// Test kit: an in-memory `chat_sync` table behind a Supabase-shaped client, for chatSync / chatStorage
// tests. It honours the column list of each select, the `eq` / `in` filters, `order('key')` and
// `range`, and records every select and upsert, so a test can tell a manifest read (`key, updated_at`)
// from a body read (a select that names `data`). Rows given without `key` / `updated_at` derive them
// from their data, as chatSync.push writes them. Not imported by app code.

export interface FakeChatSyncRow {
  user_id: string;
  kind: string;
  data: Record<string, unknown>;
  key?: string;
  updated_at?: string;
}

export interface FakeChatSyncCloud {
  /** The signed-in user per Supabase (whose token the requests ride on). */
  user: string | null;
  /** Like PostgREST max-rows: no answer holds more rows than this (unset: no cap). */
  maxRows?: number;
  rows: FakeChatSyncRow[];
  upserts: { key: string; user_id: string; kind: string; data: Record<string, unknown>; updated_at?: string }[];
  /** Every select: the column list asked for and how many rows came back. */
  selects: { columns: string; rows: number }[];
}

export const createFakeChatSyncCloud = (): FakeChatSyncCloud => ({ user: null, rows: [], upserts: [], selects: [] });

export const rowKey = (r: FakeChatSyncRow): string => r.key ?? `${r.kind}:${String(r.data.id)}`;
export const rowUpdatedAt = (r: FakeChatSyncRow): string =>
  r.updated_at ?? new Date(Number(r.data.updatedAt) || 0).toISOString();

/** True for a select that downloads row bodies. */
export const isBodySelect = (columns: string): boolean => columns.split(',').some((c) => c.trim() === 'data');

const project = (r: FakeChatSyncRow, columns: string): Record<string, unknown> => {
  const full: Record<string, unknown> = { key: rowKey(r), user_id: r.user_id, kind: r.kind, data: r.data, updated_at: rowUpdatedAt(r) };
  const out: Record<string, unknown> = {};
  for (const c of columns.split(',').map((x) => x.trim()).filter(Boolean)) out[c] = full[c];
  return out;
};

const query = (cloud: FakeChatSyncCloud, columns: string, opts?: { count?: string }) => {
  const eqs: [string, unknown][] = [];
  let inFilter: [string, unknown[]] | null = null;
  let ordered = false;
  let range: [number, number] | null = null;
  const run = () => {
    let rows = cloud.rows.filter((r) =>
      eqs.every(([col, v]) => (col === 'key' ? rowKey(r) : (r as unknown as Record<string, unknown>)[col]) === v)
    );
    if (inFilter) {
      const [col, values] = inFilter;
      rows = rows.filter((r) => values.includes(col === 'key' ? rowKey(r) : (r as unknown as Record<string, unknown>)[col]));
    }
    if (ordered) rows = [...rows].sort((a, b) => (rowKey(a) < rowKey(b) ? -1 : rowKey(a) > rowKey(b) ? 1 : 0));
    const count = rows.length;
    if (range) rows = rows.slice(range[0], range[1] + 1);
    if (cloud.maxRows !== undefined) rows = rows.slice(0, cloud.maxRows);
    cloud.selects.push({ columns, rows: rows.length });
    return { data: rows.map((r) => project(r, columns)), error: null, ...(opts?.count ? { count } : {}) };
  };
  const builder = {
    eq(col: string, v: unknown) {
      eqs.push([col, v]);
      return builder;
    },
    in(col: string, values: unknown[]) {
      inFilter = [col, values];
      return builder;
    },
    order() {
      ordered = true;
      return builder;
    },
    range(from: number, to: number) {
      range = [from, to];
      return builder;
    },
    then<T>(resolve: (v: ReturnType<typeof run>) => T, reject?: (e: unknown) => T) {
      try {
        return Promise.resolve(resolve(run()));
      } catch (e) {
        return reject ? Promise.resolve(reject(e)) : Promise.reject(e);
      }
    }
  };
  return builder;
};

/** A Supabase-shaped client over `cloud` (only what chatSync uses). */
export const makeFakeChatSyncSupabase = (cloud: FakeChatSyncCloud) => ({
  auth: { getUser: async () => ({ data: { user: cloud.user ? { id: cloud.user } : null } }) },
  from: () => ({
    select: (columns: string, opts?: { count?: string }) => query(cloud, columns, opts),
    upsert: async (row: FakeChatSyncCloud['upserts'][number]) => {
      cloud.upserts.push(row);
      cloud.rows = [...cloud.rows.filter((r) => rowKey(r) !== row.key), { ...row }];
      return { error: null };
    },
    delete: () => ({
      eq: (_c: string, key: string) => ({
        eq: async (_c2: string, uid: string) => {
          cloud.rows = cloud.rows.filter((r) => !(rowKey(r) === key && r.user_id === uid));
          return { error: null };
        }
      })
    })
  })
});
