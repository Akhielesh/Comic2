// @vitest-environment node
//
// house_comics.sql locks each house table and function away from the client roles in the statements right after the
// one that creates it. psql -f commits every statement on its own, so a table or function must never exist open, not
// even for the rest of an apply that stops part-way (Supabase grants new objects in public to anon and authenticated).
// The only grants live in house_comics_grants.sql, and they go to service_role alone. The privileges themselves are
// checked on a real Postgres by house_comics.test.sql; this pins the order, which that test cannot see.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SQL_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (name: string): string => readFileSync(join(SQL_DIR, name), 'utf8');

/** The top-level statements in order, without comments, split on `;` outside quotes and dollar quotes. */
function statements(sql: string): string[] {
  const out: string[] = [];
  let cur = '';
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    if (ch === '-' && sql[i + 1] === '-') {
      const end = sql.indexOf('\n', i);
      i = end < 0 ? sql.length : end;
      continue;
    }
    if (ch === "'") {
      const end = sql.indexOf("'", i + 1);
      const stop = end < 0 ? sql.length : end + 1;
      cur += sql.slice(i, stop);
      i = stop;
      continue;
    }
    if (ch === '$') {
      const tag = /^\$[A-Za-z_]*\$/.exec(sql.slice(i));
      if (tag) {
        const end = sql.indexOf(tag[0], i + tag[0].length);
        const stop = end < 0 ? sql.length : end + tag[0].length;
        cur += sql.slice(i, stop);
        i = stop;
        continue;
      }
    }
    if (ch === ';') {
      if (cur.trim()) out.push(cur.trim().replace(/\s+/g, ' '));
      cur = '';
      i += 1;
      continue;
    }
    cur += ch;
    i += 1;
  }
  if (cur.trim()) out.push(cur.trim().replace(/\s+/g, ' '));
  return out;
}

describe('house_comics.sql lockdown order', () => {
  const main = statements(read('house_comics.sql'));
  const grants = statements(read('house_comics_grants.sql'));

  it('splits the file into statements', () => {
    expect(main.some((s) => /^create or replace function public\.house_reserve\(/i.test(s))).toBe(true);
    expect(main.length).toBeGreaterThan(40);
  });

  it('locks every table in the two statements right after its CREATE TABLE', () => {
    const tables: string[] = [];
    main.forEach((s, i) => {
      const m = /^create table if not exists public\.(\w+) \(/i.exec(s);
      if (!m) return;
      tables.push(m[1]);
      expect(main[i + 1], `${m[1]}: RLS first`).toBe(`alter table public.${m[1]} enable row level security`);
      expect(main[i + 2], `${m[1]}: then every client privilege revoked`).toBe(`revoke all on table public.${m[1]} from public, anon, authenticated`);
    });
    expect(tables).toEqual(['house_config', 'house_runs', 'house_comics', 'house_spend']);
  });

  it('revokes every function from the clients in the statement right after it is created', () => {
    const fns: string[] = [];
    main.forEach((s, i) => {
      const m = /^create or replace function public\.(\w+)\(/i.exec(s);
      if (!m) return;
      fns.push(m[1]);
      expect(main[i + 1], `${m[1]}: revoked at once`).toMatch(new RegExp(`^revoke all on function public\\.${m[1]}\\(.*\\) from public, anon, authenticated$`));
    });
    expect(fns).toEqual([
      'house_payers_ok', 'house_touch_updated_at', 'house_expire_holds', 'house_cap_refusal', 'house_reserve', 'house_settle', 'house_release'
    ]);
  });

  it('grants nothing itself; the grants file grants only to service_role', () => {
    expect(main.filter((s) => /^grant\b/i.test(s))).toEqual([]);
    expect(main.filter((s) => /\bcreate policy\b|\bdisable row level security\b/i.test(s))).toEqual([]);
    expect(grants.length).toBeGreaterThan(0);
    for (const g of grants) expect(g).toMatch(/^grant (select, insert, update, delete on table|execute on function) .* to service_role$/);
  });
});
