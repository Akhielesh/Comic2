// @vitest-environment node
import { afterEach, describe, it, expect } from 'vitest';
import { __setSqlLimitsForTests, __sqlRunnerLoad, refusedSql, runSql } from './sqlRunner.js';

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
    // The next run starts clean.
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

  it('memory: SQLite’s heap limit fails a runaway string cleanly (a string doubling past 32 MiB)', async () => {
    const r = await runSql('', "WITH RECURSIVE r(n, s) AS (SELECT 1, 'x' UNION ALL SELECT n + 1, s || s FROM r WHERE n < 40) SELECT max(length(s)) FROM r");
    expect(r.error).toMatch(/out of memory/i);
  });

  it('memory: a database that grows past its page cap stops with "full"', async () => {
    const r = await runSql('', "CREATE TABLE t AS WITH RECURSIVE r(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM r) SELECT x, printf('%.900c', 'x') AS pad FROM r");
    expect(r.error).toMatch(/full/i);
  });

  it('memory: the RSS watchdog kills a run that grows the process past its allowance', async () => {
    // Lift the page cap so only the watchdog can stop it; 1 MiB of growth is enough to trip it.
    __setSqlLimitsForTests({ maxPageCount: 1_000_000_000, rssGrowthBytes: 1024 * 1024, deadlineMs: 8_000 });
    const r = await runSql('', "CREATE TABLE t AS WITH RECURSIVE r(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM r) SELECT x, printf('%.900c', 'x') AS pad FROM r");
    expect(r.error).toMatch(/too much memory/);
  }, 15_000);

  it('at most 2 run at once; the rest wait their turn, and a flood is told the playground is busy', async () => {
    __setSqlLimitsForTests({ deadlineMs: 300 });
    const runs = Array.from({ length: 4 }, () => runSql('', INFINITE));
    await new Promise((r) => setTimeout(r, 20));
    expect(__sqlRunnerLoad()).toEqual({ running: 2, waiting: 2 });
    const flood = await Promise.all(Array.from({ length: 20 }, () => runSql('', 'SELECT 1')));
    expect(flood.filter((r) => /busy/.test(r.error || '')).length).toBe(6); // 16 may wait, the other 6 are refused
    const results = await Promise.all(runs);
    for (const r of results) expect(r.error).toMatch(/was stopped/);
    expect(__sqlRunnerLoad()).toEqual({ running: 0, waiting: 0 });
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
    'pragma Hard_Heap_Limit = 0'
  ])('%s', async (q) => {
    const r = await runSql(schema, q);
    expect(r.error).toMatch(/isn’t available in this playground|aren’t available in this playground/);
    expect(r.rows).toEqual([]);
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
      'SELECT format(\'%d items\', 3)'
    ]) {
      expect([ok, refusedSql(ok)]).toEqual([ok, null]);
    }
  });
});
