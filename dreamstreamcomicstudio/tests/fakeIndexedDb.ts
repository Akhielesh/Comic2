// A small in-memory IndexedDB for unit tests (jsdom ships none). Covers what services/chatStorage
// uses: open (with upgrade), object stores keyed by `keyPath`, createIndex (ignored), readonly /
// readwrite transactions, getAll / get / put / delete — with the browser's callback order
// (request.onsuccess, then transaction.oncomplete, both asynchronous). Values are structured-
// cloned in and out, like the real thing.

type Row = Record<string, unknown>;

class FakeRequest<T> {
  result!: T;
  error: unknown = null;
  onsuccess: (() => void) | null = null;
  onerror: (() => void) | null = null;
}

class FakeOpenRequest extends FakeRequest<FakeDb> {
  onupgradeneeded: (() => void) | null = null;
  onblocked: (() => void) | null = null;
}

class FakeStore {
  constructor(private readonly rows: Map<string, Row>, private readonly keyPath: string, private readonly tx: FakeTx) {}

  private request<T>(run: () => T): FakeRequest<T> {
    const req = new FakeRequest<T>();
    this.tx.pending++;
    queueMicrotask(() => {
      try {
        req.result = run();
        req.onsuccess?.();
      } catch (err) {
        req.error = err;
        req.onerror?.();
      }
      this.tx.settle();
    });
    return req;
  }

  getAll() {
    return this.request(() => [...this.rows.values()].map((r) => structuredClone(r)));
  }

  get(key: string) {
    return this.request(() => {
      const row = this.rows.get(key);
      return row ? structuredClone(row) : undefined;
    });
  }

  put(value: Row) {
    return this.request(() => {
      const key = String(value[this.keyPath]);
      this.rows.set(key, structuredClone(value));
      return key;
    });
  }

  delete(key: string) {
    return this.request(() => {
      this.rows.delete(key);
      return undefined;
    });
  }

  createIndex() {
    return {};
  }
}

class FakeTx {
  pending = 0;
  oncomplete: (() => void) | null = null;
  onerror: (() => void) | null = null;
  error: unknown = null;
  constructor(private readonly db: FakeDb, private readonly storeName: string) {}

  objectStore(name: string) {
    if (name !== this.storeName) throw new Error(`store ${name} not in this transaction`);
    return this.db.store(name, this);
  }

  settle() {
    this.pending--;
    if (this.pending === 0) queueMicrotask(() => this.oncomplete?.());
  }
}

class FakeDb {
  readonly stores = new Map<string, { keyPath: string; rows: Map<string, Row> }>();
  version = 0;

  objectStoreNames = {
    contains: (name: string) => this.stores.has(name),
  };

  createObjectStore(name: string, opts: { keyPath: string }) {
    this.stores.set(name, { keyPath: opts.keyPath, rows: new Map() });
    return { createIndex: () => ({}) };
  }

  store(name: string, tx: FakeTx) {
    const s = this.stores.get(name);
    if (!s) throw new Error(`no store ${name}`);
    return new FakeStore(s.rows, s.keyPath, tx);
  }

  transaction(name: string) {
    return new FakeTx(this, name);
  }

  close() {}
}

export interface FakeIndexedDb {
  open(name: string, version?: number): FakeOpenRequest;
  /** Every row of a store, as stored (for assertions). */
  rows(dbName: string, store: string): Row[];
  /** Write rows straight into a store (seeding data from "before"). */
  seed(dbName: string, store: string, rows: Row[]): void;
  reset(): void;
}

export function createFakeIndexedDb(): FakeIndexedDb {
  const dbs = new Map<string, FakeDb>();
  return {
    open(name: string, version = 1) {
      const req = new FakeOpenRequest();
      queueMicrotask(() => {
        let db = dbs.get(name);
        const isNew = !db;
        if (!db) {
          db = new FakeDb();
          dbs.set(name, db);
        }
        req.result = db;
        if (isNew || version > db.version) {
          db.version = version;
          req.onupgradeneeded?.();
        }
        req.onsuccess?.();
      });
      return req;
    },
    rows(dbName: string, store: string) {
      return [...(dbs.get(dbName)?.stores.get(store)?.rows.values() ?? [])].map((r) => structuredClone(r));
    },
    seed(dbName: string, store: string, rows: Row[]) {
      const db = dbs.get(dbName);
      const s = db?.stores.get(store);
      if (!s) throw new Error(`open ${dbName} first`);
      for (const r of rows) s.rows.set(String(r[s.keyPath]), structuredClone(r));
    },
    reset() {
      dbs.clear();
    },
  };
}
