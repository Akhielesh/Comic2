// @vitest-environment node
// Static guard for server/sql/comic_history.sql (versions plan §3.2, §12; H1), the services/*.sql.test.ts pattern.
// It runs everywhere (no Postgres needed); server/sql/tests/comic_history.test.sql checks the behaviour on a real one.
//   * idempotent: every create is guarded (if not exists / or replace / drop-then-create / pg_constraint check), and
//     nothing destructive runs at the top level;
//   * every function pins its search_path; SECURITY DEFINER is used by exactly the service-role RPCs;
//   * execute is revoked from public, anon and authenticated on every function, granted only to service_role, and
//     only for the RPCs; internal helpers and triggers are revoked from service_role too; no client grant anywhere;
//   * the tables: RLS on, no policies, client privileges revoked, the service role may only read;
//   * collect_active_image_paths() is the LIVE definition (comic_security_guard_2026_10.sql §3a) plus exactly one
//     comic_version_chunks branch, with the guard run at the end and the storage-sweep rule in the header;
//   * the public share RPCs never reference the history tables; the harness test is discovered.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-ignore — a plain .mjs script with no type declarations (an error under some configs, none under others)
import { testFiles } from '../../../sql/tests/harness.mjs';

const SQL_DIR = resolve(__dirname, '../../../sql');
const sql = readFileSync(resolve(SQL_DIR, 'comic_history.sql'), 'utf8');
const live = readFileSync(resolve(SQL_DIR, 'comic_security_guard_2026_10.sql'), 'utf8');
const publications = readFileSync(resolve(SQL_DIR, 'comic_publications.sql'), 'utf8');

/** The service-role RPCs (and the guard a storage sweep calls). */
const RPCS = [
  'comic_history_put',
  'comic_history_label',
  'comic_history_delete',
  'comic_history_forget_path',
  'comic_history_set_head',
  'comic_history_alternative_create',
  'comic_history_alternative_update',
  'comic_history_alternative_remove'
];
const SERVICE_EXECUTE = [...RPCS, 'comic_history_assert_gc_roots', 'collect_active_image_paths'];
const TABLES = ['comic_alternatives', 'comic_versions', 'comic_version_chunks'];

/** The SQL with comments and dollar-quoted bodies blanked (top-level statements only). */
const topLevel = (text: string): string =>
  text
    .replace(/\$\$[\s\S]*?\$\$/g, '$$ $$')
    .split('\n')
    .map((l) => l.replace(/--.*$/, ''))
    .join('\n');
const top = topLevel(sql);
const squash = (s: string) => s.replace(/\s+/g, ' ').trim();

interface Fn {
  name: string;
  /** Argument types only, as Postgres prints them in a signature: `uuid, uuid, jsonb`. */
  signature: string;
  /** From `create` to `as $$` (language, volatility, security, set …). */
  header: string;
  body: string;
}

/** Every function the file defines. */
const functions = (text: string): Fn[] => {
  const out: Fn[] = [];
  const re = /create\s+(or\s+replace\s+)?function\s+public\.(\w+)\s*\(([\s\S]*?)\)\s*returns\b([\s\S]*?)\bas\s+\$\$([\s\S]*?)\$\$/gi;
  for (const m of text.matchAll(re)) {
    expect(m[1], `${m[2]} must be "create or replace"`).toBeTruthy();
    const args = m[3]
      .split(',')
      .map((a) => a.trim())
      .filter(Boolean)
      .map((a) => a.split(/\s+/)[1]);
    out.push({ name: m[2], signature: args.join(', '), header: m[4], body: m[5] });
  }
  return out;
};
const fns = functions(sql);
const byName = new Map(fns.map((f) => [f.name, f]));

describe('comic_history.sql is idempotent and never destructive', () => {
  it('guards every create', () => {
    for (const m of top.matchAll(/create\s+(unique\s+)?(table|index)\s+(?!if not exists)(\S+)/gi)) throw new Error(`unguarded: ${m[0]}`);
    expect(top).toMatch(/create extension if not exists pgcrypto with schema extensions/);
    for (const t of TABLES) expect(top, t).toMatch(new RegExp(`create table if not exists public\\.${t} \\(`));
    // Triggers: dropped then created, one by one.
    const triggers = [...top.matchAll(/create trigger (\w+)\s+before (insert|update) on (public\.\w+)/gi)];
    expect(triggers.map((t) => t[1]).sort()).toEqual(['comic_version_chunks_immutable', 'comic_version_chunks_verify', 'comic_versions_guard']);
    for (const [, name, , table] of triggers) {
      const drop = top.indexOf(`drop trigger if exists ${name} on ${table};`);
      expect(drop, name).toBeGreaterThanOrEqual(0);
      expect(drop, name).toBeLessThan(top.indexOf(`create trigger ${name}`));
    }
    // Constraints added later sit behind a pg_constraint check (inside DO blocks: read the raw file).
    const adds = [...sql.matchAll(/add constraint (\w+)/gi)].map((m) => m[1]);
    expect(adds.sort()).toEqual(['comic_alternatives_from_version_fk', 'comic_alternatives_head_version_fk']);
    for (const c of adds) expect(sql, c).toMatch(new RegExp(`if not exists \\(select 1 from pg_constraint where conname = '${c}'\\)`));
    expect(top).not.toMatch(/\bcreate policy\b/i);
  });

  it('adds columns only behind "if not exists"; a removed line is marked, never deleted (V-3)', () => {
    for (const m of top.matchAll(/add\s+column\s+(?!if not exists)(\S+)/gi)) throw new Error(`unguarded: ${m[0]}`);
    expect(top).toMatch(/alter table public\.comic_alternatives add column if not exists removed_at timestamptz;/);
    const remove = squash(byName.get('comic_history_alternative_remove')!.body);
    expect(remove).not.toMatch(/delete from public\.comic_alternatives/i);
    expect(remove).toMatch(/set removed_at = now\(\), is_active = false, head_version_id = null/);
    // Every line lookup that a write trusts skips removed lines.
    for (const name of ['comic_history_put', 'comic_history_set_head', 'comic_history_alternative_update', 'comic_history_alternative_remove', 'comic_history_alternative_create']) {
      expect(squash(byName.get(name)!.body), name).toMatch(/removed_at is null/);
    }
  });

  it('runs nothing destructive at the top level (no drop table/column/function, truncate, delete or update)', () => {
    expect(top).not.toMatch(/\bdrop\s+(table|column|function|index|schema|extension)\b/i);
    expect(top).not.toMatch(/\btruncate\b/i);
    expect(top).not.toMatch(/^\s*(delete|update|insert)\b/im);
    expect(top).not.toMatch(/\bforce row level security\b/i); // the definer RPCs run as the owner
  });

  it('lz4 is guarded: only when the server lists it, and a failure is a notice, never an error', () => {
    const block = sql.slice(sql.indexOf("'lz4' = any (enumvals)") - 200, sql.indexOf('keeping the default compression') + 60);
    expect(block).toMatch(/if exists \(select 1 from pg_settings where name = 'default_toast_compression' and 'lz4' = any \(enumvals\)\)/);
    expect(block).toMatch(/set compression lz4/);
    expect(block).toMatch(/exception when others then\s+raise notice/);
  });
});

describe('comic_history.sql functions', () => {
  it('defines the RPCs, helpers, triggers and the guard', () => {
    expect(fns.map((f) => f.name).sort()).toEqual(
      [
        ...RPCS,
        'collect_active_image_paths',
        'comic_history_assert_gc_roots',
        'comic_history_deletable',
        'comic_history_gc',
        'comic_history_lock',
        'comic_history_manifest_hashes',
        'comic_history_row_json',
        'comic_history_thin',
        'comic_version_chunks_immutable',
        'comic_version_chunks_verify',
        'comic_versions_guard'
      ].sort()
    );
  });

  it('pins search_path on every function; SECURITY DEFINER only on the service-role RPCs', () => {
    for (const f of fns) {
      expect(squash(f.header), f.name).toMatch(/\bset search_path = public\b/);
      expect(/security definer/i.test(f.header), f.name).toBe(RPCS.includes(f.name));
    }
  });

  it('revokes execute from public, anon and authenticated on every function, with its exact signature', () => {
    for (const f of fns) {
      const revoke = new RegExp(
        `revoke all on function public\\.${f.name}\\(${f.signature.replace(/[.()]/g, '\\$&')}\\) from public, anon, authenticated(, service_role)?;`
      );
      expect(top, `${f.name}(${f.signature})`).toMatch(revoke);
    }
  });

  it('grants execute only to service_role, and only on the RPCs; helpers and triggers to nobody', () => {
    const grants = [...top.matchAll(/grant\s+([\s\S]*?)\s+on\s+(function|table)\s+([\s\S]*?)\s+to\s+([\w, ]+);/gi)];
    for (const g of grants) expect(g[4].trim(), g[0]).toBe('service_role');
    const executed = grants.filter((g) => /^function$/i.test(g[2])).map((g) => /public\.(\w+)\(/.exec(g[3])![1]);
    expect(executed.sort()).toEqual([...SERVICE_EXECUTE].sort());
    for (const f of fns.filter((x) => !SERVICE_EXECUTE.includes(x.name))) {
      expect(top, f.name).toMatch(new RegExp(`revoke all on function public\\.${f.name}\\([^)]*\\) from public, anon, authenticated, service_role;`));
    }
    expect(top).not.toMatch(/\bto\s+(anon|authenticated|public)\b/i);
  });

  it('locks the tables down: RLS on, no client privilege, the service role reads only', () => {
    for (const t of TABLES) expect(top).toMatch(new RegExp(`alter table public\\.${t} enable row level security;`));
    const list = TABLES.map((t) => `public.${t}`).join(', ');
    expect(top).toContain(`revoke all on table ${list} from public, anon, authenticated;`);
    expect(top).toContain(`revoke all on table ${list} from service_role;`);
    expect(top).toContain(`grant select on table ${list} to service_role;`);
    // …and the post-apply block fails the migration if a client could still reach them.
    const post = sql.slice(sql.indexOf('8. Post-apply assertions'));
    expect(post).toMatch(/has_table_privilege\(r, t, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'\)/);
    expect(post).toMatch(/has_function_privilege\('anon', f, 'EXECUTE'\) or has_function_privilege\('authenticated', f, 'EXECUTE'\)/);
    expect(post).toMatch(/must have no policies/);
  });

  it('every RPC takes the per-comic lock and checks ownership first', () => {
    const lock = byName.get('comic_history_lock')!;
    expect(squash(lock.body)).toMatch(/pg_advisory_xact_lock\(hashtextextended\('comic_history:' \|\| p_project::text, 0\)\)/);
    expect(squash(lock.body)).toMatch(/from public\.projects p where p\.id = p_project and p\.user_id = p_user/);
    for (const name of RPCS) {
      const body = byName.get(name)!.body;
      const at = body.indexOf('perform public.comic_history_lock(p_project, p_user);');
      expect(at, name).toBeGreaterThan(0);
      // No table is touched before the lock.
      expect(body.slice(0, at), name).not.toMatch(/\b(from|update|insert into|delete from)\s+public\./i);
    }
  });

  it('the chunk trigger verifies sha256/128 with pgcrypto in extensions; the guards allow only the listed columns', () => {
    expect(squash(byName.get('comic_version_chunks_verify')!.body)).toContain("left(encode(extensions.digest(new.content, 'sha256'), 'hex'), 32) <> new.hash");
    expect(squash(byName.get('comic_version_chunks_immutable')!.body)).toContain("(to_jsonb(new) - 'paths') is distinct from (to_jsonb(old) - 'paths')");
    expect(squash(byName.get('comic_version_chunks_immutable')!.body)).toContain('<@');
    expect(squash(byName.get('comic_versions_guard')!.body)).toContain(
      "array['label', 'name', 'note', 'pinned', 'keep_until', 'alternative_id', 'published_rev', 'parent_id', 'undo_id']"
    );
  });
});

describe('GC roots: collect_active_image_paths()', () => {
  /** The live body (comic_security_guard_2026_10.sql §3a), whitespace-normalized. */
  const liveBody = (() => {
    const fn = functions(live).find((f) => f.name === 'collect_active_image_paths');
    expect(fn).toBeDefined();
    return { header: squash(fn!.header), body: squash(fn!.body) };
  })();
  const mine = byName.get('collect_active_image_paths')!;

  it('is the LIVE broad definition plus exactly one comic_version_chunks branch', () => {
    expect(squash(mine.header)).toBe(liveBody.header);
    const branch = /history_chunk_paths as \( select nullif\(btrim\(p\), ''\) as path from public\.comic_version_chunks c, unnest\(c\.paths\) p \)/;
    const body = squash(mine.body);
    expect(body).toMatch(branch);
    expect(body).toMatch(/ union all select path from history_chunk_paths \) combined where path is not null and path <> ''/);
    const without = body
      .replace(/, history_chunk_paths as \( select nullif\(btrim\(p\), ''\) as path from public\.comic_version_chunks c, unnest\(c\.paths\) p \)/, '')
      .replace(/ union all select path from history_chunk_paths/, '');
    expect(without).toBe(liveBody.body);
    expect((body.match(/comic_version_chunks/g) || []).length).toBe(1);
    expect((body.match(/strict \$\.\*\*/g) || []).length).toBe(3);
  });

  it('stays a service-role-only function, and the guard runs at the end of the file', () => {
    expect(top).toMatch(/revoke all on function public\.collect_active_image_paths\(\) from public, anon, authenticated;/);
    expect(top).toMatch(/grant execute on function public\.collect_active_image_paths\(\) to service_role;/);
    const guard = squash(byName.get('comic_history_assert_gc_roots')!.body);
    expect(guard).toMatch(/position\('comic_version_chunks' in v_def\) = 0 then raise exception/);
    expect(guard).toMatch(/narrower copy/);
    const post = sql.slice(sql.indexOf('8. Post-apply assertions'));
    expect(post).toMatch(/perform public\.comic_history_assert_gc_roots\(\);/);
  });

  it('tells every future storage sweep to call it immediately before deleting', () => {
    const header = squash(
      sql
        .slice(0, sql.indexOf('create extension'))
        .split('\n')
        .map((l) => l.replace(/^--\s?/, ''))
        .join('\n')
    );
    expect(header).toMatch(/any future storage sweep .* MUST call public\.collect_active_image_paths\(\) immediately before deleting objects/i);
    expect(header).toMatch(/BEFORE any server runs with COMIC_HISTORY=1/);
    expect(header).toMatch(/Builders never apply it/);
  });
});

describe('share links never reach history', () => {
  it('the public RPCs in comic_publications.sql never reference the history tables', () => {
    for (const name of ['comic_public_payload', 'comic_share_card', 'comic_share_card_by_project']) {
      const fn = functions(publications).find((f) => f.name === name);
      expect(fn, name).toBeDefined();
      expect(fn!.body, name).not.toMatch(/comic_version|comic_alternatives|comic_history/);
    }
  });

  it('the behaviour test is discovered by the psql harness', () => {
    const files = (testFiles() as string[]).map((f) => f.split('/').pop());
    expect(files).toContain('comic_history.test.sql');
    expect(readFileSync(resolve(SQL_DIR, 'tests/comic_history.test.sql'), 'utf8').trimEnd()).toMatch(/\\echo COMIC_HISTORY_OK$/);
  });
});
