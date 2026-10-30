// @vitest-environment node
// Static guard for the Model Lab's two SQL files (A6 wave note 1). comic_model_lab.sql re-declares the runs table's
// check-id constraint on every re-run, so it must list the Pro pages A/B checks too: a list of D1–D4 only would fail
// to re-add the constraint once P1/P2 rows exist (and leave the table without it). Its daily reserve function must
// refuse an A/B check, which reserves only through comic_model_lab_reserve_ab under the A/B's own limit.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LAB_AB_CHECKS, LAB_CHECKS } from './lab.js';

const SQL_DIR = resolve(__dirname, '../../../sql');
const lab = readFileSync(resolve(SQL_DIR, 'comic_model_lab.sql'), 'utf8');
const proPages = readFileSync(resolve(SQL_DIR, 'comic_model_lab_pro_pages.sql'), 'utf8');

/** The ids in `check (check_id in (…))` of the runs table's check-id constraint. */
const checkIds = (sql: string): string[] => {
  const m = /add constraint comic_model_lab_runs_check_id_check\s+check \(check_id in \(([^)]*)\)\)/i.exec(sql);
  expect(m, 'the check-id constraint').not.toBeNull();
  return [...m![1].matchAll(/'([A-Z0-9]+)'/g)].map((x) => x[1]);
};

/** The body of a plpgsql function, from its `create function` to its closing `$$`. */
const fnBody = (sql: string, name: string): string => {
  const start = sql.search(new RegExp(`create (?:or replace )?function public\\.${name}\\(`, 'i'));
  expect(start, name).toBeGreaterThanOrEqual(0);
  const open = sql.indexOf('$$', start);
  return sql.slice(open + 2, sql.indexOf('$$', open + 2));
};

describe('Model Lab SQL: the A/B checks in both files', () => {
  it('comic_model_lab.sql allows every check the server runs (D1–D4, P1, P2), the same list as the A/B file', () => {
    const all = [...LAB_CHECKS.map((c) => c.id), ...LAB_AB_CHECKS];
    expect(checkIds(lab)).toEqual(all);
    expect(checkIds(proPages)).toEqual(checkIds(lab));
  });

  it('comic_model_lab_reserve refuses P1/P2 right after the quote check, before the lock or any insert', () => {
    const body = fnBody(lab, 'comic_model_lab_reserve');
    const quote = body.indexOf('the quote must be positive');
    const refuse = body.search(/if p_check in \('P1', 'P2'\) then\s+raise exception 'comic_model_lab_reserve: A\/B runs reserve through comic_model_lab_reserve_ab';/);
    expect(quote).toBeGreaterThan(0);
    expect(refuse).toBeGreaterThan(quote);
    expect(refuse).toBeLessThan(body.indexOf('pg_advisory_xact_lock'));
    expect(refuse).toBeLessThan(body.search(/insert into/i));
  });

  it('the A/B reserve function still takes only P1/P2', () => {
    expect(fnBody(proPages, 'comic_model_lab_reserve_ab')).toMatch(/only Pro pages A\/B checks \(P1, P2\) reserve here/);
  });
});
