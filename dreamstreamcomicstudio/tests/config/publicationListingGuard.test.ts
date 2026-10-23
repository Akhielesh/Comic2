// @vitest-environment node
/**
 * Static contract for the projects-row guards that keep the PUBLIC gallery honest (gate F4, 2026-10).
 * The repo has no Postgres harness, so this pins the SQL text the lead applies; the runtime
 * behaviour (owner attacks reverted, service mirror free, holds unlisting, heals) was proven on a
 * scratch Postgres 16 and is re-checked by the PROD STEPS queries.
 *
 *  - S4 (server/sql/comic_publications.sql, projects_guard_publication_state): an owner can't
 *    re-skin a published, rated v4 listing — flip state.studioVersion, write cover_image_url or
 *    state covers/panels — and show unscanned art under the gate's G/PG badge (Kids-friendly).
 *  - S3 (server/sql/comic_hold_unlists_2026_10.sql): a moderation hold always unlists the comic
 *    (is_public = false), whoever writes the hold; rows already held-and-public are healed.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8');
/** Comments out, whitespace folded, lower case: the contract is about statements, not prose. */
const sqlOf = (text: string) =>
  text
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n')
    .replace(/\s+/g, ' ')
    .toLowerCase();

/** The body of one plpgsql function (between its `as $$` and the closing `$$;`); '' when it isn't defined. */
const functionBody = (sql: string, name: string): string => {
  const start = sql.indexOf(`create or replace function public.${name}()`);
  if (start < 0) return '';
  const open = sql.indexOf('as $$', start);
  const close = sql.indexOf('$$;', open + 5);
  return sql.slice(open + 5, close);
};

describe('comic_publications.sql: projects_guard_publication_state (S4)', () => {
  const sql = sqlOf(read('server/sql/comic_publications.sql'));
  const body = functionBody(sql, 'projects_guard_publication_state');
  const at = (needle: string) => {
    const i = body.indexOf(needle);
    expect(i, `guard contains: ${needle}`).toBeGreaterThanOrEqual(0);
    return i;
  };

  it('never pins the service role (the server mirror), and checks that first', () => {
    expect(at("if coalesce(auth.role(), 'service_role') = 'service_role' then return new; end if;")).toBeLessThan(at('new.cover_image_url := old.cover_image_url;'));
  });

  it('a cover_image_url-only write is no longer waved through by the early return', () => {
    at('if new.state is not distinct from old.state and new.name is not distinct from old.name and new.cover_image_url is not distinct from old.cover_image_url then return new; end if;');
  });

  it('v4 rows (comic_docs) never take a client cover_image_url', () => {
    expect(at('if not exists (select 1 from public.comic_docs d where d.project_id = old.id) then return new; end if;')).toBeLessThan(
      at('new.cover_image_url := old.cover_image_url;')
    );
  });

  it('a PUBLIC v4 listing is frozen whole: name and state stay the server mirror', () => {
    const branch = at('if coalesce(old.is_public, false) then new.name := old.name; new.state := old.state; return new; end if;');
    // The private pins come after the public branch has returned.
    expect(branch).toBeLessThan(at("new.state := (new.state - 'shareslug' - 'publiccover' - 'studioversion')"));
  });

  it('a PRIVATE v4 row keeps its share keys and v4 marker, and a non-object state never slips past the pins', () => {
    expect(at("if new.state is null or jsonb_typeof(new.state) <> 'object' then")).toBeLessThan(at("new.state := (new.state - 'shareslug'"));
    at("'shareslug', v_old -> 'shareslug'");
    at("'publiccover', v_old -> 'publiccover'");
    at("'studioversion', v_old -> 'studioversion'");
  });

  it('stays a SECURITY DEFINER BEFORE UPDATE trigger the client cannot call', () => {
    expect(sql).toMatch(/create or replace function public\.projects_guard_publication_state\(\) returns trigger language plpgsql security definer set search_path = public as \$\$/);
    expect(sql).toContain('revoke all on function public.projects_guard_publication_state() from public, anon, authenticated;');
    expect(sql).toContain('create trigger projects_guard_publication_state before update on public.projects for each row execute function public.projects_guard_publication_state();');
  });

  it('heals v4 rows written before the guard (studioVersion 4, no classic cover), only when comic_docs exists', () => {
    expect(sql).toMatch(
      /if to_regclass\('public\.comic_docs'\) is not null then update public\.projects p set state = jsonb_set\(p\.state, '\{studioversion\}', '4'::jsonb\), cover_image_url = null where exists \(select 1 from public\.comic_docs d where d\.project_id = p\.id\) and jsonb_typeof\(p\.state\) = 'object' and \(p\.state -> 'studioversion' is distinct from '4'::jsonb or p\.cover_image_url is not null\);/
    );
  });

  it('fails the migration when projects.cover_image_url is missing (the guard reads it on every client save)', () => {
    expect(sql).toMatch(/if not exists \(select 1 from information_schema\.columns where table_schema = 'public' and table_name = 'projects' and column_name = 'cover_image_url'\) then raise exception/);
  });
});

describe('comic_hold_unlists_2026_10.sql: a hold always unlists (S3)', () => {
  const raw = read('server/sql/comic_hold_unlists_2026_10.sql');
  const sql = sqlOf(raw);
  const body = functionBody(sql, 'projects_hold_unlists');

  it('names its migration and apply order', () => {
    expect(raw).toMatch(/apply_migration`, name `comic_hold_unlists_2026_10`/);
    expect(raw).toMatch(/AFTER comic_security_guard_2026_10\.sql and comic_publications\.sql/);
  });

  it('a hold turning ON (false → true) unlists the row in the same write; lifting never relists', () => {
    expect(body).toContain('if coalesce(new.is_forced_private, false) and not coalesce(old.is_forced_private, false) then new.is_public := false; end if; return new;');
    expect(body).not.toMatch(/is_public := true/);
  });

  it('is an idempotent BEFORE UPDATE OF is_forced_private trigger, guarded on the column, not callable by clients', () => {
    expect(sql).toContain('create or replace function public.projects_hold_unlists() returns trigger language plpgsql set search_path = public as $$');
    expect(sql).toContain('revoke all on function public.projects_hold_unlists() from public, anon, authenticated;');
    expect(sql).toContain("column_name = 'is_forced_private'");
    expect(sql).toContain("execute 'drop trigger if exists projects_hold_unlists on public.projects';");
    expect(sql).toContain(
      "execute 'create trigger projects_hold_unlists before update of is_forced_private on public.projects ' || 'for each row execute function public.projects_hold_unlists()';"
    );
  });

  it('heals rows already held AND public, then asserts none are left', () => {
    expect(sql).toContain("execute 'update public.projects set is_public = false where is_forced_private = true and is_public = true';");
    expect(sql).toMatch(/if exists \(select 1 from public\.projects where is_forced_private = true and is_public = true\) then raise exception/);
    expect(sql).toMatch(/t\.tgname = 'projects_hold_unlists' and not t\.tgisinternal\) then raise exception/);
  });
});
