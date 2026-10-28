#!/usr/bin/env node
// The psql harness: applies server/sql files to a throwaway local Postgres (with the Supabase
// stand-in in supabase_stub.sql) and runs *.test.sql files whose `assert`s are the tests.
//
//   node server/sql/tests/harness.mjs            # every *.test.sql in this folder
//   node server/sql/tests/harness.mjs foo.test.sql
//
// Needs the Postgres server binaries (initdb, pg_ctl, postgres, psql) — found on PATH, through
// `pg_config --bindir`, or under /usr/lib/postgresql/<version>/bin. Nothing listens on TCP: the
// server uses a Unix socket in its own temporary folder, and both are removed afterwards. When
// run as root, Postgres runs as the `postgres` user (it refuses to run as root).
//
// sqlHarness.test.ts runs this from vitest when Postgres is installed and skips it otherwise.

import { spawnSync } from 'node:child_process';
import { chmodSync, chownSync, existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SQL_DIR = resolve(HERE, '..');

/** The schema files every test needs, in apply order. live_security_v2.sql goes on twice: it must be idempotent. */
export const SCHEMA_FILES = [
  join(HERE, 'supabase_stub.sql'),
  join(SQL_DIR, 'live_accounts_and_monitor.sql'),
  join(SQL_DIR, 'live_security_v2.sql'),
  join(SQL_DIR, 'live_security_v2.sql'),
];

const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', ...opts });

/** Where initdb/pg_ctl/psql live, or null when Postgres isn't installed. */
export function findPgBin() {
  const has = (dir) => ['initdb', 'pg_ctl', 'postgres', 'psql'].every((b) => existsSync(join(dir, b)));
  const cfg = run('pg_config', ['--bindir']);
  if (cfg.status === 0 && cfg.stdout.trim() && has(cfg.stdout.trim())) return cfg.stdout.trim();
  const root = '/usr/lib/postgresql';
  if (existsSync(root)) {
    const versions = readdirSync(root)
      .filter((v) => /^\d+$/.test(v))
      .sort((a, b) => Number(b) - Number(a));
    for (const v of versions) if (has(join(root, v, 'bin'))) return join(root, v, 'bin');
  }
  const which = run('sh', ['-c', 'command -v initdb']);
  if (which.status === 0 && which.stdout.trim()) {
    const dir = dirname(which.stdout.trim());
    if (has(dir)) return dir;
  }
  return null;
}

/** The test files in this folder (or the ones named). */
export function testFiles(names = []) {
  if (names.length) return names.map((n) => (existsSync(n) ? resolve(n) : join(HERE, n)));
  return readdirSync(HERE)
    .filter((f) => f.endsWith('.test.sql'))
    .sort()
    .map((f) => join(HERE, f));
}

/**
 * Start a throwaway server, apply the schema, run each test file in a fresh database.
 * Returns { ok, skipped?, results: [{ file, ok, output }] }. `skipped` (with a reason) means
 * Postgres isn't installed or couldn't start here — not a test failure.
 */
export function runSqlHarness(files = testFiles(), opts = {}) {
  const bin = opts.bin ?? findPgBin();
  if (!bin) return { ok: true, skipped: 'Postgres server binaries not found', results: [] };
  const asRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  let pgUid = null;
  let pgGid = null;
  if (asRoot) {
    const idu = run('id', ['-u', 'postgres']);
    const idg = run('id', ['-g', 'postgres']);
    if (idu.status !== 0 || run('sh', ['-c', 'command -v runuser']).status !== 0) {
      return { ok: true, skipped: 'running as root without a postgres user (or runuser) to run the server as', results: [] };
    }
    pgUid = Number(idu.stdout.trim());
    pgGid = Number(idg.stdout.trim());
  }
  const as = (cmd, args) => (asRoot ? run('runuser', ['-u', 'postgres', '--', cmd, ...args]) : run(cmd, args));

  // A private folder for the data and the socket. As root, it must be one the postgres user can
  // reach (a TMPDIR inside a root-only folder isn't), so fall back to /tmp.
  const makeDir = (parent) => {
    const d = mkdtempSync(join(parent, 'ds-sqltest-'));
    if (!asRoot) return d;
    chownSync(d, pgUid, pgGid);
    chmodSync(d, 0o700);
    if (as('test', ['-w', d]).status === 0) return d;
    rmSync(d, { recursive: true, force: true });
    return null;
  };
  const dir = makeDir(opts.tmp ?? tmpdir()) ?? (asRoot ? makeDir('/tmp') : null);
  if (!dir) return { ok: true, skipped: 'no temporary folder the postgres user can write to', results: [] };
  const data = join(dir, 'data');
  const sock = dir;
  const port = String(opts.port ?? 54329);
  const results = [];
  let started = false;
  try {
    const init = as(join(bin, 'initdb'), ['-D', data, '-U', 'postgres', '-A', 'trust', '-E', 'UTF8', '--no-sync', '--no-instructions']);
    if (init.status !== 0) return { ok: true, skipped: `initdb failed: ${(init.stderr || init.stdout).trim().slice(0, 400)}`, results };
    const start = as(join(bin, 'pg_ctl'), [
      '-D', data, '-l', join(dir, 'log'), '-w', '-t', '30',
      '-o', `-k ${sock} -p ${port} -c listen_addresses= -c fsync=off -c synchronous_commit=off -c full_page_writes=off`,
      'start',
    ]);
    if (start.status !== 0) return { ok: true, skipped: `Postgres didn't start: ${(start.stderr || start.stdout).trim().slice(0, 400)}`, results };
    started = true;
    // The client runs as us (only the server refuses root), so it can read the SQL files.
    const psql = (db, args) => run(join(bin, 'psql'), ['-X', '-q', '-h', sock, '-p', port, '-U', 'postgres', '-d', db, '-v', 'ON_ERROR_STOP=1', ...args]);
    for (const [i, file] of files.entries()) {
      const db = `t${i}`;
      const made = psql('postgres', ['-c', `create database ${db}`]);
      if (made.status !== 0) {
        results.push({ file, ok: false, output: made.stderr });
        continue;
      }
      const res = psql(db, [...SCHEMA_FILES.flatMap((f) => ['-f', f]), '-f', file]);
      results.push({ file, ok: res.status === 0, output: `${res.stdout}${res.stderr}` });
    }
  } finally {
    if (started) as(join(bin, 'pg_ctl'), ['-D', data, '-m', 'immediate', '-w', 'stop']);
    rmSync(dir, { recursive: true, force: true });
  }
  return { ok: results.every((r) => r.ok), results };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const r = runSqlHarness(testFiles(process.argv.slice(2)));
  if (r.skipped) {
    console.log(`SQL harness skipped: ${r.skipped}`);
    process.exit(0);
  }
  for (const x of r.results) {
    console.log(`${x.ok ? 'PASS' : 'FAIL'} ${x.file.replace(`${SQL_DIR}/`, '')}`);
    if (!x.ok || process.env.SQL_HARNESS_VERBOSE) console.log(x.output);
  }
  process.exit(r.ok ? 0 : 1);
}
