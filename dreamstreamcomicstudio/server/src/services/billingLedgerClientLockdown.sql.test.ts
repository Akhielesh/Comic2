// @vitest-environment node
// Gate finding S5: the billing ledger tables hold per-call provider dollars, and governed users must
// never read dollars. server/sql/billing_ledger_client_lockdown.sql removes every direct client path
// to them (policies AND table privileges), keeps the server's service role, and scrubs the stored
// publish-gate cost from publication rows. There is no database in CI, so this pins the migration's
// statements statically (it was also applied to a scratch Postgres 16 with Supabase-like roles:
// `authenticated` read its own provider_cost_usd before and got "permission denied" after, while
// service_role and the SECURITY DEFINER usage_budget_* functions kept working, and a second apply
// was a no-op). It also pins the precondition that made the revoke safe: no client, Pages function
// or Worker reads these tables directly.
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SQL_DIR = path.join(APP_ROOT, 'server/sql');
const LOCKDOWN = path.join(SQL_DIR, 'billing_ledger_client_lockdown.sql');

const LEDGER_TABLES = ['generation_cost_events', 'usage_daily_rollups', 'token_ledger_entries'] as const;

/** The executable SQL: `--` comments removed, whitespace collapsed, lower-cased. */
const executableSql = (raw: string): string =>
  raw
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join(' ')
    .replace(/\s+/g, ' ')
    .toLowerCase();

const read = (file: string) => readFileSync(file, 'utf8');
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

describe('billing_ledger_client_lockdown.sql (S5)', () => {
  it('exists', () => {
    expect(existsSync(LOCKDOWN)).toBe(true);
  });

  const sql = existsSync(LOCKDOWN) ? executableSql(read(LOCKDOWN)) : '';

  it.each(LEDGER_TABLES)('%s: guarded, its client policy dropped, every client privilege revoked, service role kept', (t) => {
    const guard = `if to_regclass('public.${t}') is not null then`;
    const start = sql.indexOf(guard);
    expect(start, `missing to_regclass guard for ${t}`).toBeGreaterThanOrEqual(0);
    const block = sql.slice(start, sql.indexOf('end if;', start));
    expect(block).toContain(`drop policy if exists ${t}_read_own on public.${t};`);
    expect(block).toContain(`alter table public.${t} enable row level security;`);
    expect(block).toMatch(new RegExp(`revoke all on table public\\.${esc(t)} from public, anon, authenticated;`));
    expect(block).toContain(`grant select, insert, update, delete on table public.${t} to service_role;`);
  });

  it('never re-opens a client path: no policy is created and nothing is granted to a client role', () => {
    expect(sql).not.toMatch(/create policy/);
    expect(sql).not.toMatch(/grant [^;]* to [^;]*\b(anon|authenticated|public)\b/);
    // Every drop is idempotent.
    for (const m of sql.matchAll(/drop policy (?!if exists)/g)) throw new Error(`non-idempotent drop at ${m.index}`);
  });

  it('leaves token_wallets alone (the client reads its token columns in services/db.ts)', () => {
    expect(sql).not.toContain('token_wallets');
  });

  it('scrubs the server-only publish-gate cost from existing publication rows, guarded and targeted', () => {
    const guard = "if to_regclass('public.comic_publications') is not null then";
    const start = sql.indexOf(guard);
    expect(start).toBeGreaterThanOrEqual(0);
    const block = sql.slice(start, sql.indexOf('end if;', start));
    expect(block).toContain("update public.comic_publications set safety = safety - 'costusd' where safety ? 'costusd';");
  });

  it('drops the policies by the exact names token_billing_foundation.sql creates', () => {
    const foundation = executableSql(read(path.join(SQL_DIR, 'token_billing_foundation.sql')));
    for (const t of LEDGER_TABLES) {
      expect(foundation, `${t}_read_own drifted`).toContain(`create policy ${t}_read_own on public.${t}`);
    }
  });
});

// The precondition for the revoke: nothing outside the server reads these tables with a user's
// session. A new direct client read would get "permission denied" in production — read through a
// server route instead (the server uses the service role).
describe('no client, Pages function or Worker reads the billing ledger tables directly', () => {
  const CLIENT_ROOTS = [
    'components',
    'contexts',
    'hooks',
    'lib',
    'live',
    'services',
    'shared',
    'functions',
    'comics-edge',
    'api-proxy',
    'data-egress',
    'email-worker',
    'live-worker',
    'App.tsx',
    'index.tsx',
    'apiTypes.ts',
    'types.ts'
  ];
  const SKIP_DIRS = new Set(['node_modules', 'dist', '.wrangler', 'coverage']);
  const SOURCE = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
  const TEST = /\.(test|spec)\.[cm]?[jt]sx?$/;

  const walk = (entry: string, out: string[]) => {
    if (!existsSync(entry)) return;
    const st = statSync(entry);
    if (st.isFile()) {
      if (SOURCE.test(entry) && !TEST.test(entry)) out.push(entry);
      return;
    }
    for (const name of readdirSync(entry)) {
      if (SKIP_DIRS.has(name)) continue;
      walk(path.join(entry, name), out);
    }
  };

  it('scans a real client tree', () => {
    const files: string[] = [];
    walk(path.join(APP_ROOT, 'services'), files);
    expect(files.some((f) => f.endsWith(`${path.sep}db.ts`))).toBe(true);
  });

  let sources: Array<{ file: string; text: string }> | null = null;
  const clientSources = () => {
    if (!sources) {
      const files: string[] = [];
      for (const root of CLIENT_ROOTS) walk(path.join(APP_ROOT, root), files);
      sources = files.map((file) => ({ file: path.relative(APP_ROOT, file), text: read(file) }));
    }
    return sources;
  };

  it.each(LEDGER_TABLES)('%s is not referenced by client or edge code', (table) => {
    const all = clientSources();
    expect(all.length).toBeGreaterThan(50);
    expect(all.filter((s) => s.text.includes(table)).map((s) => s.file)).toEqual([]);
  });
});
