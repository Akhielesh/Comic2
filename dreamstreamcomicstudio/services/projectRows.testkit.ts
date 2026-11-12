// Test kit (not a test): a small in-memory stand-in for the Supabase client's PostgREST tables, used by the
// EGRESS-DB tests. It applies a select's column list the way PostgREST does (`col`, `alias:col`,
// `alias:col->a->b`, `alias:col->>a`, `*`), so a test sees exactly the bytes a projection would ship, and it
// records every query (table, columns, filters, head/count) so a test can pin what was asked for.

export type Row = Record<string, unknown>;

export interface RecordedQuery {
  table: string;
  columns: string;
  filters: string[];
  head: boolean;
  count?: string;
  single: boolean;
}

export interface FakeSupabaseOptions {
  userId?: string | null;
  /** Plain columns the fake database does not have: selecting one fails with 42703, as PostgREST does. */
  missingColumns?: string[];
}

const splitTopLevel = (columns: string): string[] => {
  const out: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of columns) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) {
      out.push(current.trim());
      current = '';
    } else current += ch;
  }
  if (current.trim()) out.push(current.trim());
  return out;
};

const isPlainObject = (value: unknown): value is Row => typeof value === 'object' && value !== null && !Array.isArray(value);

/** One select item applied to a row: [result key, value, plain column it reads]. */
const evalItem = (row: Row, item: string): [string, unknown, string] => {
  const colon = item.indexOf(':');
  const alias = colon > 0 && !item.slice(0, colon).includes('-') ? item.slice(0, colon) : undefined;
  const expr = alias ? item.slice(colon + 1) : item;
  const parts = expr.split(/(->>|->)/);
  const column = parts[0];
  let value: unknown = row[column];
  let lastKey = column;
  for (let i = 1; i < parts.length; i += 2) {
    const op = parts[i];
    const key = parts[i + 1];
    lastKey = key;
    value = isPlainObject(value) && key in value ? value[key] : Array.isArray(value) && /^\d+$/.test(key) ? value[Number(key)] : null;
    if (value === undefined) value = null;
    if (op === '->>' && value !== null) value = typeof value === 'string' ? value : JSON.stringify(value);
  }
  return [alias ?? lastKey, value === undefined ? null : structuredClone(value), column];
};

/** A row as `select(columns)` returns it. */
export const projectRow = (row: Row, columns: string): Row => {
  const items = splitTopLevel(columns);
  if (items.length === 1 && items[0] === '*') return structuredClone(row);
  const out: Row = {};
  for (const item of items) {
    if (item === '*') Object.assign(out, structuredClone(row));
    else {
      const [key, value] = evalItem(row, item);
      out[key] = value;
    }
  }
  return out;
};

/** The plain columns a select reads (to fail on a missing one). */
export const columnsRead = (columns: string): string[] =>
  splitTopLevel(columns).filter((item) => item !== '*').map((item) => evalItem({}, item)[2]);

/** Bytes of the JSON a query result would ship (what Supabase egress counts, uncompressed). */
export const jsonBytes = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).length;

export const createFakeSupabase = (options: FakeSupabaseOptions = {}) => {
  const state = {
    tables: {} as Record<string, Row[]>,
    queries: [] as RecordedQuery[],
    upserts: [] as Array<{ table: string; row: Row }>,
    inserts: [] as Array<{ table: string; row: Row }>,
    userId: options.userId === undefined ? 'user-1' : options.userId,
    missingColumns: new Set(options.missingColumns ?? []),
    /** Make the next query whose recorded shape matches fail with this error (once). */
    failures: [] as Array<{ when: (q: RecordedQuery) => boolean; error: Row }>,
    /** Hold queries matching this until released (to test races). */
    gates: [] as Array<{ when: (q: RecordedQuery) => boolean; release: Promise<void> }>,
    /** Columns whose filters the fake database records but does not apply (a server that missed a filter). */
    ignoredFilterColumns: new Set<string>()
  };

  const reset = () => {
    state.tables = {};
    state.queries = [];
    state.upserts = [];
    state.inserts = [];
    state.userId = options.userId === undefined ? 'user-1' : options.userId;
    state.missingColumns = new Set(options.missingColumns ?? []);
    state.failures = [];
    state.gates = [];
    state.ignoredFilterColumns = new Set();
  };

  const from = (table: string) => {
    const q: RecordedQuery = { table, columns: '*', filters: [], head: false, single: false };
    const predicates: Array<{ column: string; test: (row: Row) => boolean }> = [];
    let order: { column: string; ascending: boolean } | undefined;
    let range: [number, number] | undefined;
    let limit: number | undefined;
    let mode: 'select' | 'upsert' | 'insert' | 'delete' = 'select';
    let payload: Row | undefined;

    const run = async (): Promise<{ data: unknown; error: unknown; count?: number | null }> => {
      state.queries.push(q);
      for (const gate of state.gates) if (gate.when(q)) await gate.release;
      const failure = state.failures.findIndex((f) => f.when(q));
      if (failure >= 0) {
        const [{ error }] = state.failures.splice(failure, 1);
        return { data: null, error };
      }
      const rows = (state.tables[table] ??= []);
      if (mode === 'upsert' && payload) {
        state.upserts.push({ table, row: structuredClone(payload) });
        const at = rows.findIndex((r) => r.id === payload!.id);
        if (at >= 0) rows[at] = { ...rows[at], ...structuredClone(payload) };
        else rows.push(structuredClone(payload));
        return { data: null, error: null };
      }
      if (mode === 'insert' && payload) {
        state.inserts.push({ table, row: structuredClone(payload) });
        rows.push(structuredClone(payload));
        return { data: null, error: null };
      }
      if (mode === 'delete') {
        state.tables[table] = rows.filter((r) => !predicates.every(({ test }) => test(r)));
        return { data: null, error: null };
      }
      const missing = columnsRead(q.columns).find((c) => state.missingColumns.has(c));
      if (missing) return { data: null, error: { code: '42703', message: `column ${table}.${missing} does not exist` } };
      let matched = rows.filter((r) => predicates.every(({ column, test }) => state.ignoredFilterColumns.has(column) || test(r)));
      if (order) {
        const { column, ascending } = order;
        matched = [...matched].sort((a, b) => {
          const x = a[column] as string | number;
          const y = b[column] as string | number;
          return (x < y ? -1 : x > y ? 1 : 0) * (ascending ? 1 : -1);
        });
      }
      if (range) matched = matched.slice(range[0], range[1] + 1);
      if (limit !== undefined) matched = matched.slice(0, limit);
      if (q.head) return { data: null, error: null, count: matched.length };
      const data = matched.map((r) => projectRow(r, q.columns));
      if (q.single) {
        if (data.length !== 1) return { data: null, error: { code: 'PGRST116', message: 'not exactly one row' } };
        return { data: data[0], error: null };
      }
      return { data, error: null, ...(q.count ? { count: matched.length } : {}) };
    };

    const builder: Record<string, unknown> = {
      select: (columns = '*', opts?: { count?: string; head?: boolean }) => {
        q.columns = columns;
        q.head = !!opts?.head;
        q.count = opts?.count;
        return builder;
      },
      eq: (column: string, value: unknown) => {
        q.filters.push(`${column}=eq.${String(value)}`);
        predicates.push({ column, test: (r) => r[column] === value });
        return builder;
      },
      not: (column: string, op: string, value: unknown) => {
        q.filters.push(`${column}=not.${op}.${String(value)}`);
        predicates.push({ column, test: (r) => r[column] !== value });
        return builder;
      },
      in: (column: string, values: unknown[]) => {
        q.filters.push(`${column}=in.(${values.join(',')})`);
        predicates.push({ column, test: (r) => values.includes(r[column]) });
        return builder;
      },
      ilike: (column: string, pattern: string) => {
        q.filters.push(`${column}=ilike.${pattern}`);
        predicates.push({ column, test: (r) => String(r[column]).toLowerCase() === pattern.toLowerCase() });
        return builder;
      },
      gt: (column: string, value: unknown) => {
        q.filters.push(`${column}=gt.${String(value)}`);
        predicates.push({ column, test: (r) => (r[column] as string) > (value as string) });
        return builder;
      },
      order: (column: string, opts?: { ascending?: boolean }) => {
        order = { column, ascending: opts?.ascending ?? true };
        q.filters.push(`order=${column}.${order.ascending ? 'asc' : 'desc'}`);
        return builder;
      },
      range: (fromIndex: number, toIndex: number) => {
        range = [fromIndex, toIndex];
        q.filters.push(`range=${fromIndex}-${toIndex}`);
        return builder;
      },
      limit: (n: number) => {
        limit = n;
        q.filters.push(`limit=${n}`);
        return builder;
      },
      single: () => {
        q.single = true;
        return builder;
      },
      maybeSingle: () => {
        q.single = true;
        return builder;
      },
      upsert: (row: Row) => {
        mode = 'upsert';
        payload = row;
        q.columns = '';
        return builder;
      },
      insert: (row: Row) => {
        mode = 'insert';
        payload = row;
        q.columns = '';
        return builder;
      },
      delete: () => {
        mode = 'delete';
        q.columns = '';
        return builder;
      },
      then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => run().then(resolve, reject)
    };
    return builder;
  };

  const client = {
    auth: {
      getUser: async () => ({ data: { user: state.userId ? { id: state.userId } : null } }),
      getSession: async () => ({ data: { session: state.userId ? { user: { id: state.userId } } : null } })
    },
    from,
    storage: {
      from: (bucket: string) => ({
        getPublicUrl: (path: string) => ({ data: { publicUrl: `https://sb.test/storage/v1/object/public/${bucket}/${path}` } })
      })
    }
  };

  /** Queries on one table, optionally only selects (not writes). */
  const queriesOn = (table: string) => state.queries.filter((q) => q.table === table && q.columns !== '');

  return { state, reset, client, queriesOn };
};

/** The shared fake the EGRESS-DB tests mock `services/supabase` with (reset it in beforeEach). */
export const fakeSupabase = createFakeSupabase();
