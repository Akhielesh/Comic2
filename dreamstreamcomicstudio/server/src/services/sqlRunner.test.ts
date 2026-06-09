// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { runSql } from './sqlRunner.js';

const schema = 'CREATE TABLE users(id INTEGER, name TEXT, age INTEGER);' +
  'INSERT INTO users VALUES (1,"Ann",30),(2,"Bob",25),(3,"Cy",40);';

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
});
