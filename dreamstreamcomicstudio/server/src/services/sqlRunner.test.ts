// @vitest-environment node
import { afterEach, describe, it, expect } from 'vitest';
import { __setSqlLimitsForTests, __sqlRunnerLoad, refusedSql, runSql, SQL_ONE_AT_A_TIME_MESSAGE } from './sqlRunner.js';

const schema = 'CREATE TABLE users(id INTEGER, name TEXT, age INTEGER);' +
  'INSERT INTO users VALUES (1,"Ann",30),(2,"Bob",25),(3,"Cy",40);';

const INFINITE = 'WITH RECURSIVE r(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM r) SELECT count(*) FROM r';

afterEach(() => __setSqlLimitsForTests());

describe('runSql (sql.js sandbox)', () => {
  it('returns rows for a SELECT', async () => {
    const r = await runSql(schema, 'SELECT name FROM users WHERE age > 28 ORDER BY age');
    expect(r.error).toBeUndefined();
    expect(r.columns).toEqual(['name']);
    expect(r.rows).toEqual([['Ann'], ['Cy']]);
  });

  it('surfaces a SQL error message', async () => {
    const r = await runSql(schema, 'SELECT * FROM does_not_exist');
    expect(r.error).toMatch(/no such table/i);
  });

  it('reports affected rows for a non-SELECT statement', async () => {
    const r = await runSql(schema, 'UPDATE users SET age = age + 1 WHERE id = 1');
    expect(r.error).toBeUndefined();
    expect(r.rowCount).toBe(1);
  });

  it('rejects an empty query', async () => {
    const r = await runSql(schema, '   ');
    expect(r.error).toMatch(/write a sql/i);
  });

  it('is sandboxed per call (no state leaks between runs)', async () => {
    await runSql(schema, 'DELETE FROM users');
    const r = await runSql(schema, 'SELECT COUNT(*) AS n FROM users');
    expect(r.rows).toEqual([[3]]); // fresh DB each call — the DELETE did not persist
  });

  it('a SELECT with no matching rows is an empty table, not "OK — 3 row(s) affected" from the schema', async () => {
    const r = await runSql(schema, 'SELECT name FROM users WHERE age > 100');
    expect(r).toEqual({ columns: ['name'], rows: [], rowCount: 0, truncated: false });
  });

  it('keeps the first 500 rows, counts them all, and shows the final statement', async () => {
    const r = await runSql(schema, 'SELECT 1; WITH RECURSIVE r(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM r WHERE x < 1200) SELECT x FROM r');
    expect(r.columns).toEqual(['x']);
    expect(r.rows.length).toBe(500);
    expect(r.rows[499]).toEqual([500]);
    expect(r.rowCount).toBe(1200);
    expect(r.truncated).toBe(true);
  });

  it('cuts long strings and reports blobs by size', async () => {
    const r = await runSql('', "SELECT substr(replace(hex(x'00'), '00', 'ab'), 1, 2) AS s, x'0102' AS b, printf('%.200c', 'z') AS p");
    expect(r.error).toBeUndefined();
    expect(r.rows[0]).toEqual(['ab', '<blob 2 bytes>', 'z'.repeat(200)]);
    const long = await runSql('', "WITH RECURSIVE r(n, s) AS (SELECT 1, 'abcdefghij' UNION ALL SELECT n + 1, s || 'abcdefghij' FROM r WHERE n < 1100) SELECT s FROM r WHERE n = 1100");
    const cell = long.rows[0][0] as string;
    expect(cell.length).toBe(10_241); // 10 KB and an ellipsis
    expect(cell.endsWith('…')).toBe(true);
  });
});

describe('runSql never blocks the server (abuse-ops-2)', () => {
  it('an infinite recursive CTE is stopped at the deadline while the main thread keeps ticking', async () => {
    __setSqlLimitsForTests({ deadlineMs: 400 });
    let ticks = 0;
    const timer = setInterval(() => (ticks += 1), 10);
    const started = Date.now();
    try {
      const r = await runSql(schema, INFINITE);
      expect(r.error).toMatch(/ran longer than 400 ms and was stopped/);
      expect(r.rows).toEqual([]);
    } finally {
      clearInterval(timer);
    }
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(5_000);
    // A blocked event loop would have ticked once or twice; a free one ticks every 10 ms.
    expect(ticks).toBeGreaterThan(Math.floor(400 / 10 / 3));
    // The next run starts clean (on the default deadline: 400 ms also covers a fresh isolate's
    // database setup, which a loaded CI runner can exceed).
    __setSqlLimitsForTests();
    expect((await runSql(schema, 'SELECT count(*) FROM users')).rows).toEqual([[3]]);
  });

  it('the default deadline is 2 s', async () => {
    const started = Date.now();
    const r = await runSql('', INFINITE);
    expect(r.error).toMatch(/ran longer than 2 s/);
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_900);
  }, 15_000);

  it('a schema is as untrusted as a query: an endless schema is stopped too', async () => {
    __setSqlLimitsForTests({ deadlineMs: 300 });
    const r = await runSql(`CREATE TABLE t AS ${INFINITE}`, 'SELECT 1');
    expect(r.error).toMatch(/was stopped/);
  });

  // Each memory test isolates its layer: the RSS watchdog reads the whole process, so on a loaded runner
  // it could stop a run first (also a correct outcome in production, but not the layer under test).
  const ONLY_SQLITE_LIMITS = { rssGrowthBytes: 1024 * 1024 * 1024, deadlineMs: 10_000 };

  it('memory: SQLite’s heap limit fails a runaway string cleanly (a string doubling past 32 MiB)', async () => {
    __setSqlLimitsForTests(ONLY_SQLITE_LIMITS);
    const r = await runSql('', "WITH RECURSIVE r(n, s) AS (SELECT 1, 'x' UNION ALL SELECT n + 1, s || s FROM r WHERE n < 40) SELECT max(length(s)) FROM r");
    expect(r.error).toMatch(/out of memory/i);
  }, 15_000);

  it('memory: a database that grows past its page cap stops with "full"', async () => {
    __setSqlLimitsForTests(ONLY_SQLITE_LIMITS);
    const r = await runSql('', "CREATE TABLE t AS WITH RECURSIVE r(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM r) SELECT x, printf('%.900c', 'x') AS pad FROM r");
    expect(r.error).toMatch(/full/i);
  }, 15_000);

  it('memory: the RSS watchdog kills a run that grows the process past its allowance', async () => {
    // Lift the page cap so only the watchdog can stop it; 1 MiB of growth is enough to trip it.
    __setSqlLimitsForTests({ maxPageCount: 1_000_000_000, rssGrowthBytes: 1024 * 1024, deadlineMs: 8_000 });
    const r = await runSql('', "CREATE TABLE t AS WITH RECURSIVE r(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM r) SELECT x, printf('%.900c', 'x') AS pad FROM r");
    expect(r.error).toMatch(/too much memory/);
  }, 15_000);

  it('one runs at a time; the rest wait their turn, and a flood is told the playground is busy', async () => {
    __setSqlLimitsForTests({ deadlineMs: 300 });
    const runs = Array.from({ length: 3 }, () => runSql('', INFINITE));
    await new Promise((r) => setTimeout(r, 20));
    expect(__sqlRunnerLoad()).toEqual({ running: 1, waiting: 2 });
    const flood = await Promise.all(Array.from({ length: 10 }, () => runSql('', 'SELECT 1')));
    expect(flood.filter((r) => /busy/.test(r.error || '')).length).toBe(4); // 8 may wait, the other 4 are refused
    const results = await Promise.all(runs);
    for (const r of results) expect(r.error).toMatch(/was stopped/);
    expect(__sqlRunnerLoad()).toEqual({ running: 0, waiting: 0 });
  }, 20_000);

  it('a caller holds one place at a time, so one account cannot fill the queue', async () => {
    __setSqlLimitsForTests({ deadlineMs: 300 });
    const first = runSql('', INFINITE, 'user:a');
    const again = await runSql('', 'SELECT 1', 'user:a');
    expect(again).toEqual({ columns: [], rows: [], rowCount: 0, truncated: false, error: SQL_ONE_AT_A_TIME_MESSAGE });
    // Someone else still gets in line behind it.
    const other = runSql('', 'SELECT 2', 'user:b');
    await new Promise((r) => setTimeout(r, 20));
    expect(__sqlRunnerLoad()).toEqual({ running: 1, waiting: 1 });
    expect((await first).error).toMatch(/was stopped/);
    // It ran (here on the short test deadline, so only "not refused" is certain).
    expect((await other).error ?? '').not.toMatch(/busy|still running/);
    // Once the run has ended, the same caller runs again.
    __setSqlLimitsForTests();
    expect((await runSql('', 'SELECT 3', 'user:a')).rows).toEqual([[3]]);
  }, 20_000);
});

describe('functions and statements that only exhaust the sandbox are refused up front', () => {
  it.each([
    'SELECT randomblob(1000000000)',
    'SELECT length(zeroblob(1000000000))',
    "SELECT printf('%.*c', 1000000000, 'x')",
    "SELECT printf('%999999999c', 'x')",
    "SELECT format('%.5000c', 'x')",
    "ATTACH DATABASE 'x.db' AS x",
    'VACUUM',
    'PRAGMA max_page_count = 1000000000',
    'PRAGMA temp_store = FILE',
    'pragma Hard_Heap_Limit = 0',
    // Spellings SQLite accepts: quoted names, comments between tokens, a schema prefix, a later statement.
    'SELECT length("randomblob"(1000000000))',
    'SELECT length([zeroblob] /* c */ (1000000000))',
    "PRAGMA 'max_page_count' = 1000000000",
    'PRAGMA main . "cache_size" = 1000000',
    "SELECT 1; attach ':memory:' AS x",
    'EXPLAIN QUERY PLAN VACUUM',
    "SELECT printf('%%%1000d', 1)",
    'SELECT printf("%.*c", 1000000000, \'x\')',
    // A zero-pad flag does not hide a big width or precision.
    "SELECT printf('%01000d', 1)",
    "SELECT printf('%.01000f', 1)",
    // SQLite reads U+FEFF where a token starts as space, so it hides nothing either (mid-text, where
    // runSql's trim() never reaches it).
    "SELECT 1; \ufeffATTACH ':memory:' AS x",
    'PRAGMA \ufeff max_page_count = 1000000',
    'SELECT randomblob \ufeff(9)',
    'SELECT 1; \ufeff VACUUM',
    // A Tcl-style parameter `$a(')` is one token to SQLite, so its quote does not hide what follows.
    "SELECT $a(') , length(randomblob(1000000000)) , $b(')",
    "SELECT :a(') ; VACUUM ; SELECT :b(')"
  ])('%s', async (q) => {
    const r = await runSql(schema, q);
    expect(r.error).toMatch(/isn’t available in this playground|aren’t available in this playground/);
    expect(r.rows).toEqual([]);
  });

  it('U+FEFF counts as space wherever a token starts, also at the very start (no trim() involved)', () => {
    for (const q of [
      '\ufeffVACUUM',
      "\ufeff\ufeffATTACH ':memory:' AS x",
      'PRAGMA main.\ufeffmax_page_count = 1000000',
      'SELECT length(\ufeffzeroblob /* c */\ufeff(9))',
      'SELECT 1;\ufeff\nDETACH x'
    ]) {
      expect([q, refusedSql(q)]).toEqual([q, expect.stringMatching(/isn’t available in this playground/)]);
    }
    // Inside a name it is part of the name, as in SQLite: `randomblob\ufeff` is no function SQLite has,
    // and `PRAGMA\ufeffmax_page_count` is one word, a syntax error.
    expect(refusedSql('SELECT randomblob\ufeff(9)')).toBeNull();
    expect(refusedSql('PRAGMA\ufeffmax_page_count = 1000000')).toBeNull();
  });

  it('in the schema too', async () => {
    expect((await runSql('CREATE TABLE t AS SELECT randomblob(100) AS b', 'SELECT 1')).error).toMatch(/RANDOMBLOB/);
  });

  it('leaves ordinary learner SQL alone', () => {
    for (const ok of [
      "SELECT * FROM users WHERE name LIKE '%2024%'",
      'SELECT attachments FROM mail',
      "SELECT printf('%5.2f', 3.14159)",
      'PRAGMA table_info(users)',
      'SELECT format(\'%d items\', 3)',
      // Words that are blocked only as calls, statements or pragma names: data, columns, comments.
      "INSERT INTO products VALUES (1, 'Robot Vacuum', 'Appliances', 299.0)",
      'INSERT INTO products VALUES (2, "Vacuum Sealer", "Kitchen", 49.0)',
      'CREATE TABLE settings(id INTEGER, page_size INTEGER, cache_size INTEGER)',
      'SELECT page_size, cache_size FROM settings',
      "INSERT INTO tasks VALUES (1, 'Attach the invoice'), (2, 'Detach the trailer')",
      'SELECT 1 -- randomblob(5) is not a call in a comment\n',
      "SELECT 'randomblob(1000000000)' AS note /* zeroblob(9) */",
      "SELECT printf('%.2f', price) FROM orders WHERE order_date LIKE '%2024%'",
      "SELECT printf('%d', id) FROM t WHERE id % 1000 = 0",
      "SELECT printf('%%1000 of them')",
      // A leading 0 is the zero-pad flag: these widths and precisions are under 1000.
      "SELECT printf('%0100d', 1)",
      "SELECT printf('%05d', 1)",
      "SELECT printf('%0999d', 1)",
      "SELECT printf('%.0999f', 1)",
      'PRAGMA page_count'
    ]) {
      expect([ok, refusedSql(ok)]).toEqual([ok, null]);
    }
  });

  it('zero-padded printf widths run', async () => {
    const r = await runSql('', "SELECT printf('%05d', 1), length(printf('%0100d', 1)), printf('%%%05d', 7)");
    expect(r.error).toBeUndefined();
    expect(r.rows).toEqual([['00001', 100, '%00007']]);
  });

  it('a lesson whose seed data says “Vacuum” runs (the schema is model-written)', async () => {
    const products =
      'CREATE TABLE products(id INTEGER, name TEXT, category TEXT, price REAL, page_size INTEGER);' +
      "INSERT INTO products VALUES (1,'Robot Vacuum','Appliances',299.0,20),(2,'Attach-a-Lens','Photo',19.0,10);";
    const r = await runSql(products, "SELECT name, printf('%.2f', price) AS p FROM products WHERE price > 100 AND name LIKE '%Vac%'");
    expect(r.error).toBeUndefined();
    expect(r.rows).toEqual([['Robot Vacuum', '299.00']]);
  });
});
