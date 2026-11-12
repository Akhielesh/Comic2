// @vitest-environment node
/**
 * Static contract for Discover's anonymous listing (redesign DS-R2; owner decision R-D3; privacy on Discover, risk 6).
 * The SQL is ask-first: the lead applies server/sql/comic_discovery.sql after the security review, so this pins the
 * text that will be applied (modelled on publicationListingGuard.test.ts). The behaviour is proven on a throwaway
 * Postgres by server/sql/tests/comic_discovery.test.sql.
 *
 *  - both RPCs are SECURITY DEFINER with search_path = public, anon-executable, and the helper is not;
 *  - EVERY query that reads comic_publications keeps status = 'live', visibility = 'public' and the forced-private
 *    join (moderation holds), in the ranking and again where items are built;
 *  - the item builder is the allow-list; the byline (and the username search) only where show_creator is on;
 *  - the limit is clamped to 24, the search is cut to 60 characters and LIKE-escaped, unknown inputs fail closed;
 *  - no ranking score leaves the database: the keyset cursor is the slug alone;
 *  - every shelf's arguments (Kids-friendly is G/PG only, whatever the home's chips say);
 *  - comic_featured is service-only; the stats(day) index exists; the limits match the shared codec.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DISCOVER_KINDS,
  DISCOVER_LENGTHS,
  DISCOVER_LIMIT_MAX,
  DISCOVER_Q_MAX,
  DISCOVER_RATINGS,
  DISCOVER_SHELF_SIZE,
  DISCOVER_SORTS,
  DISCOVER_WEEK_DAYS,
  discoverListRpcArgs,
  discoverShelvesRpcArgs
} from '../../shared/comic/discovery';
import { kindLabelOf } from '../../server/src/comic/publication/snapshot';

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

const RAW = read('server/sql/comic_discovery.sql');
const SQL = sqlOf(RAW);

/** The definition of public.<name>(…): its header up to `as $$`, and its body up to the closing `$$;`. */
function fn(name: string): { header: string; body: string } {
  const start = SQL.indexOf(`create or replace function public.${name}(`);
  if (start < 0) return { header: '', body: '' };
  const open = SQL.indexOf('as $$', start);
  const close = SQL.indexOf('$$;', open + 5);
  return { header: SQL.slice(start, open + 5), body: SQL.slice(open + 5, close) };
}

/**
 * Every query over comic_publications in a body: from each `public.comic_publications c ` to the next one (or the end
 * of its statement). Each holds its own FROM/JOIN … WHERE, so a clause dropped from any one of them is caught.
 */
function publicationQueries(body: string): string[] {
  const needle = 'public.comic_publications c ';
  const starts: number[] = [];
  for (let i = body.indexOf(needle); i >= 0; i = body.indexOf(needle, i + needle.length)) starts.push(i);
  return starts.map((s, k) => {
    const statementEnd = body.indexOf(';', s);
    const next = k + 1 < starts.length ? starts[k + 1] : body.length;
    return body.slice(s, Math.min(next, statementEnd < 0 ? body.length : statementEnd));
  });
}

const LIST = fn('comic_discover_list');
const SHELVES = fn('comic_discover_shelves');
const KIND = fn('comic_discover_kind');

/**
 * Any reference to the publications table, whatever the alias, schema or quoting (`comic_publications x`,
 * `"comic_publications"`, `public.comic_publications`): not comic_publication_stats / _viewers, which are other tables.
 */
const PUBLICATIONS_REF = /\bcomic_publications\b(?!_)/g;
/** The references that are not reads of its rows: the precondition, its message and comic_featured's foreign key. */
const NON_QUERY_REFS = [
  "to_regclass('public.comic_publications')",
  "'apply comic_publications.sql before comic_discovery.sql'",
  'references public.comic_publications(id)'
];
/** A table the shelves must never read themselves, qualified or not. */
const SHELF_TABLE_RE = /\bcomic_publications\b(?!_)|\bcomic_publication_stats\b|\bcomic_featured\b|\bprojects\b|\bprofiles\b/;

describe('comic_discovery.sql: the two anonymous RPCs', () => {
  it('names its migration, its apply order and that it is ask-first', () => {
    expect(RAW).toMatch(/apply_migration`, name `comic_discovery`/);
    expect(RAW).toMatch(/AFTER comic_publications\.sql and comic_hold_unlists_2026_10\.sql/);
    expect(RAW).toMatch(/ASK-FIRST/);
  });

  it('both are SECURITY DEFINER, stable, with search_path = public', () => {
    for (const f of [LIST, SHELVES]) {
      expect(f.header, 'defined').not.toBe('');
      expect(f.header).toMatch(/\) returns jsonb language plpgsql stable security definer set search_path = public as \$\$$/);
    }
  });

  it('are revoked from public and granted to the API roles only; the kind helper is never client-callable', () => {
    expect(SQL).toContain('revoke all on function public.comic_discover_list(text, text, text, text, text, text, boolean, integer, text) from public;');
    expect(SQL).toContain('revoke all on function public.comic_discover_shelves(text, text, text, text) from public;');
    expect(SQL).toContain('grant execute on function public.comic_discover_list(text, text, text, text, text, text, boolean, integer, text) to anon, authenticated, service_role;');
    expect(SQL).toContain('grant execute on function public.comic_discover_shelves(text, text, text, text) to anon, authenticated, service_role;');
    expect(SQL).toContain('revoke all on function public.comic_discover_kind(jsonb) from public, anon, authenticated;');
    expect(SQL).not.toMatch(/grant [a-z, ]+ on function public\.comic_discover_kind/);
    expect(KIND.header).toMatch(/returns text language sql immutable set search_path = public as \$\$$/);
  });

  it('take exactly the arguments the shared codec sends, in order', () => {
    const names = (header: string) => [...header.matchAll(/(p_[a-z_]+) [a-z]+ default/g)].map((m) => m[1]);
    expect(names(LIST.header)).toEqual(Object.keys(discoverListRpcArgs({ sort: 'trending', limit: DISCOVER_LIMIT_MAX })));
    expect(names(SHELVES.header)).toEqual(Object.keys(discoverShelvesRpcArgs({})));
  });
});

describe('only live PUBLIC, not-held comics: in every query that reads comic_publications', () => {
  const queries = publicationQueries(LIST.body);

  it('the list reads comic_publications twice: the ranking and the item builder', () => {
    expect(queries).toHaveLength(2);
  });

  for (const [i, label] of [[0, 'ranking'], [1, 'item builder']] as const) {
    it(`the ${label} keeps status = 'live', visibility = 'public' and the forced-private join`, () => {
      const q = queries[i];
      expect(q).toContain('join public.projects p on p.id = c.project_id');
      expect(q).toContain("c.status = 'live'");
      expect(q).toContain("c.visibility = 'public'");
      expect(q).toContain('coalesce(p.is_forced_private, false) = false');
    });
  }

  it('the featured picks go through the same query (featured is a sort of the list)', () => {
    expect(queries[0]).toContain('left join public.comic_featured f on f.publication_id = c.id');
    expect(queries[0]).toContain("(p_sort <> 'featured' or f.publication_id is not null)");
    expect(queries[0]).toContain('(f.starts_at is null or f.starts_at <= now()) and (f.ends_at is null or f.ends_at > now())');
  });

  it('the shelves never read a table themselves (qualified or not): every shelf is a comic_discover_list call', () => {
    expect(SHELVES.body).not.toMatch(SHELF_TABLE_RE);
    const calls = SHELVES.body.match(/public\.comic_discover_list\(/g) || [];
    expect(calls).toHaveLength(7);
    expect(SHELVES.body.match(new RegExp(`p_limit => ${DISCOVER_SHELF_SIZE}\\)`, 'g')) || []).toHaveLength(7);
  });

  it('every shelf passes exactly its arguments: Kids-friendly is G/PG only, whatever the home\'s chips are', () => {
    // Each shelf: its key, the condition that hides it, and the exact comic_discover_list call.
    const shelf = (key: string, when: string | null, args: string) =>
      `'${key}', ${when ? `case when ${when} then ` : ''}public.comic_discover_list(${args}, p_limit => ${DISCOVER_SHELF_SIZE}) -> 'items'${when ? ' end' : ''}`;
    const chips = 'p_rating => p_rating, p_lang => p_lang, p_kind => p_kind';
    const expected = [
      shelf('featured', null, `p_sort => 'featured', ${chips}`),
      shelf('trending', null, `p_sort => 'trending', ${chips}, p_week => true`),
      shelf('new', null, `p_sort => 'new', ${chips}, p_week => true`),
      shelf('kids', 'p_rating is null', "p_sort => 'most_read', p_rating => 'kids', p_lang => p_lang, p_kind => p_kind"),
      shelf('lang', 'p_lang is null and p_your_lang is not null', "p_sort => 'most_read', p_rating => p_rating, p_lang => p_your_lang, p_kind => p_kind"),
      shelf('webtoon', 'p_kind is null', "p_sort => 'most_read', p_rating => p_rating, p_lang => p_lang, p_kind => 'webtoon'"),
      shelf('manga', 'p_kind is null', "p_sort => 'most_read', p_rating => p_rating, p_lang => p_lang, p_kind => 'manga'")
    ];
    for (const e of expected) expect(SHELVES.body, e).toContain(e);
    expect(SHELVES.body).toContain("'kids', case when p_rating is null then public.comic_discover_list(p_sort => 'most_read', p_rating => 'kids',");
    // The kids shelf is the only one that sets its own rating.
    expect(SHELVES.body.match(/p_rating => '[a-z0-9-]+'/g)).toEqual(["p_rating => 'kids'"]);
  });

  it('nothing else in the file reads comic_publications, under any alias, schema or quoting', () => {
    let rest = SQL;
    for (const ref of NON_QUERY_REFS) {
      expect(rest.split(ref), ref).toHaveLength(2); // exactly once
      rest = rest.split(ref).join(' ');
    }
    // Every remaining reference is one of the queries checked above, in comic_discover_list.
    expect(rest.match(PUBLICATIONS_REF) || []).toHaveLength(queries.length);
    expect(LIST.body.match(PUBLICATIONS_REF) || []).toHaveLength(queries.length);
    expect(publicationQueries(SQL)).toHaveLength(queries.length);
  });
});

describe('the item builder is the allow-list', () => {
  const lines = RAW.split('\n');
  const from = lines.findIndex((l) => l.includes("'items', coalesce(jsonb_agg("));
  const to = lines.findIndex((l, i) => i > from && l.includes("'next', case"));
  const builder = lines.slice(from + 1, to);
  const builderSql = sqlOf(builder.join('\n'));

  it('builds exactly these keys', () => {
    expect(from).toBeGreaterThan(0);
    const keys = builder.map((l) => /^\s*'([A-Za-z0-9]+)',/.exec(l)?.[1]).filter(Boolean);
    expect(keys).toEqual([
      'slug', 'title', 'description', 'kind', 'pageCount', 'aspect', 'cover', 'rating', 'languages',
      'publishedAt', 'firstPublishedAt', 'likes', 'themeColor', 'creator', 'username', 'avatarUrl'
    ]);
    expect(builderSql).toContain("jsonb_build_object('w480', art.w480, 'w1080', art.w1080)");
    expect(SQL).toContain("jsonb_build_object('items', '[]'::jsonb, 'next', null)");
    expect(SQL).toContain("'next', case when max(r.rn) > v_limit then (array_agg(jsonb_build_object('slug', r.slug)) filter (where r.rn = v_limit))[1] end");
  });

  it('no ranking score leaves the function: not in an item, not in the cursor', () => {
    // n is the 7-day reads (trending), all-time reads (most_read) or the staff rank (featured); the stats table is
    // owner-only under RLS and the plan says "no view counts".
    const select = LIST.body.slice(LIST.body.indexOf('select jsonb_build_object('), LIST.body.indexOf('into v_out'));
    expect(select).not.toBe('');
    const outputs = select.replace(/order by r\.n desc, r\.slug desc/g, '').replace(/over \(order by ranked\.n desc, ranked\.slug desc\)/g, '');
    expect(outputs).not.toMatch(/\br\.n\b|\branked\.n\b|\bx\.n\b|\bb\.n\b/);
    for (const leak of ['views_count', 'uniques', 'score', 'f.rank', "'n'", "'rank'", "'views'", "'reads'"]) expect(select, leak).not.toContain(leak);
    expect(LIST.header).not.toContain('p_after_n');
    expect(LIST.body).not.toContain('p_after_n');
  });

  it('never the snapshot, safety data, an asset key or a user id', () => {
    for (const leak of ["'snapshot'", "'safety'", "'assetkey'", "'asset_key'", "'userid'", "'user_id'", 'c.user_id', 'c.asset_key', 'c.views_count']) {
      expect(builderSql, leak).not.toContain(leak);
    }
    // The snapshot is read only for the cover's copies, the safety data only for the rating, the asset key only to
    // keep the cover under the publication's own prefix, the user id only to find the profile.
    expect([...LIST.body.matchAll(/c\.snapshot [#-]>+ '[^']+'/g)].map((m) => m[0]).sort()).toEqual([
      "c.snapshot #> '{cover,render,asset}'",
      "c.snapshot #> '{pages,0,render,asset}'"
    ]);
    expect(LIST.body.match(/c\.safety ->> '([a-z]+)'/g)?.every((m) => m === "c.safety ->> 'rating'")).toBe(true);
    expect(LIST.body.match(/c\.asset_key/g)).toHaveLength(2);
    expect(LIST.body.match(/c\.asset_key/g)?.length).toBe(LIST.body.match(/'\^pub\/' \|\| c\.asset_key \|\| '\/\[a-za-z0-9\._-\]\{1,120\}\$'/g)?.length);
    expect(LIST.body.match(/c\.user_id/g)).toHaveLength(2);
    expect(LIST.body.match(/left join public\.profiles pr on pr\.id = c\.user_id/g)).toHaveLength(2);
  });

  it('the creator rule: a byline only when this publication shows its creator', () => {
    const creator = builderSql.indexOf("'creator', case when c.show_creator and pr.username ~ '^[a-za-z0-9_.-]{2,40}$' then jsonb_build_object( 'username', pr.username,");
    expect(creator).toBeGreaterThanOrEqual(0);
    // Every use of the profile in the whole function sits behind show_creator: the byline and the username search.
    for (const m of LIST.body.matchAll(/pr\.(username|avatar_url)/g)) {
      const before = LIST.body.slice(Math.max(0, m.index! - 400), m.index!);
      expect(before, `pr.${m[1]} at ${m.index}`).toMatch(/c\.show_creator/);
    }
    expect(LIST.body).toContain("(c.show_creator and pr.username ilike v_pattern escape '\\')");
  });

  it('an avatar only from our storage, and never one whose URL holds an id', () => {
    expect(builderSql).toContain("pr.avatar_url ~ '^https://[a-z0-9]{10,40}\\.supabase\\.co/storage/v1/object/public/[a-z0-9-]{3,63}/[a-za-z0-9._/-]+$'");
    expect(builderSql).toContain("pr.avatar_url !~* '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'");
    expect(builderSql).toContain('length(pr.avatar_url) <= 500');
  });
});

describe('inputs: the limit, the search, fail-closed filters', () => {
  it(`clamps the limit to 1..${DISCOVER_LIMIT_MAX} and fetches one more only to know there is a next page`, () => {
    expect(LIST.body).toContain(`v_limit integer := least(greatest(coalesce(p_limit, ${DISCOVER_LIMIT_MAX}), 1), ${DISCOVER_LIMIT_MAX});`);
    expect(LIST.body).toContain('limit v_limit + 1');
    expect(LIST.body).toContain('filter (where r.rn <= v_limit)');
    expect(LIST.header).toContain(`p_limit integer default ${DISCOVER_LIMIT_MAX}`);
  });

  it(`cuts the search to ${DISCOVER_Q_MAX} characters and escapes LIKE wildcards; every ILIKE uses the escaped pattern`, () => {
    expect(LIST.body).toContain(`v_pattern := nullif(btrim(left(coalesce(p_q, ''), ${DISCOVER_Q_MAX})), '');`);
    expect(LIST.body).toContain("v_pattern := '%' || replace(replace(replace(v_pattern, '\\', '\\\\'), '%', '\\%'), '_', '\\_') || '%';");
    const ilikes = LIST.body.match(/ ilike /g) || [];
    expect(ilikes.length).toBeGreaterThan(0);
    expect(LIST.body.match(/ ilike v_pattern escape '\\'/g)).toHaveLength(ilikes.length);
    expect(LIST.body).not.toMatch(/ like /);
  });

  it('an unknown sort, rating, kind, length, language or a malformed cursor returns an empty page, never an unfiltered one', () => {
    const guard = LIST.body.slice(0, LIST.body.indexOf("return jsonb_build_object('items', '[]'::jsonb, 'next', null);"));
    const list = (xs: readonly string[]) => xs.map((x) => `'${x.toLowerCase()}'`).join(', ');
    expect(guard).toContain(`p_sort is null or p_sort not in (${list([...DISCOVER_SORTS, 'featured'])})`);
    expect(guard).toContain(`(p_rating is not null and p_rating not in (${list(['kids', ...DISCOVER_RATINGS])}))`);
    expect(guard).toContain(`(p_kind is not null and p_kind not in (${list(DISCOVER_KINDS)}))`);
    expect(guard).toContain(`(p_length is not null and p_length not in (${list(Object.keys(DISCOVER_LENGTHS))}))`);
    expect(guard).toContain("(p_lang is not null and (length(p_lang) > 35 or p_lang !~ '^[a-za-z]{2,3}(-[a-za-z0-9]{2,8}){0,2}$'))");
    expect(guard).toContain("(p_after_slug is not null and p_after_slug !~ '^[a-za-z0-9]{17}$')");
  });

  it('kids-friendly is G or PG only (an unrated comic never counts)', () => {
    expect(LIST.body).toContain("(p_rating is null or (p_rating = 'kids' and c.safety ->> 'rating' in ('g', 'pg')) or c.safety ->> 'rating' = p_rating)");
  });

  it('the length bands and the 7-day window match the shared codec', () => {
    const { short, medium, long } = DISCOVER_LENGTHS;
    expect(LIST.body).toContain(`v_min_pages := case p_length when 'short' then ${short.min} when 'medium' then ${medium.min} when 'long' then ${long.min} end;`);
    expect(LIST.body).toContain(`v_max_pages := case p_length when 'short' then ${short.max} when 'medium' then ${medium.max} when 'long' then ${long.max} end;`);
    expect(LIST.body).toContain(`s.day >= current_date - ${DISCOVER_WEEK_DAYS - 1}`);
    expect(LIST.body).toContain(`>= now() - interval '${DISCOVER_WEEK_DAYS} days'`);
  });

  it('the keyset is (n, slug), descending, from the cursor slug\'s current score: the score itself is never sent', () => {
    expect(LIST.body).toContain(
      'from base x where p_after_slug is null or (x.n, x.slug) < ((select b.n from base b where b.slug = p_after_slug), p_after_slug) order by x.n desc, x.slug desc limit v_limit + 1'
    );
    // base is the one query that ranks; the page is cut from it, so a cursor slug outside it (held, filtered) is empty.
    expect(LIST.body).toContain('with base as materialized ( select c.id, c.slug, case p_sort');
    expect(LIST.body).toContain('ranked as materialized ( select x.id, x.slug, x.n from base x');
  });
});

describe('the kind helper reads the frozen card label written at publish', () => {
  it('maps every label the server writes back to its kind', () => {
    for (const kind of DISCOVER_KINDS) {
      if (kind === 'comic') continue;
      expect(KIND.body).toContain(`when '${kindLabelOf(kind).toLowerCase()}' then '${kind}'`);
    }
    expect(KIND.body).toContain("else 'comic'");
    expect(kindLabelOf('comic')).toBe('Comic');
  });
});

describe('comic_featured is service-only; the stats index; idempotence', () => {
  it('RLS on, no policy, no client grant, and the migration fails if a client could touch it', () => {
    expect(SQL).toContain('create table if not exists public.comic_featured (');
    expect(SQL).toContain('alter table public.comic_featured enable row level security;');
    expect(SQL).toContain('revoke all on public.comic_featured from anon, authenticated;');
    expect(SQL).not.toMatch(/create policy [^;]* on public\.comic_featured/);
    expect(SQL).not.toMatch(/grant [a-z, ]+ on (table )?public\.comic_featured to/);
    expect(SQL).toMatch(/if has_table_privilege\('anon', 'public\.comic_featured', 'select'\)[^;]*then raise exception 'comic_featured must be service-only';/);
  });

  it('indexes the stats by day (trending reads the last 7 days)', () => {
    expect(SQL).toContain('create index if not exists comic_publication_stats_day_idx on public.comic_publication_stats (day);');
  });

  it('every statement is idempotent', () => {
    expect(SQL).not.toMatch(/create table (?!if not exists)/);
    expect(SQL).not.toMatch(/create (unique )?index (?!if not exists)/);
    expect(SQL).not.toMatch(/create function /);
    expect(SQL).not.toMatch(/\b(drop table|truncate|delete from|update public\.)/);
    // The one drop is the earlier draft's score-bearing signature, so no ambiguous overload survives a re-apply.
    expect(SQL.match(/\bdrop function\b[^;]*;/g)).toEqual([
      'drop function if exists public.comic_discover_list(text, text, text, text, text, text, boolean, integer, bigint, text);'
    ]);
  });

  it('fails the migration without its prerequisites and checks its own result', () => {
    expect(SQL).toContain("raise exception 'apply comic_publications.sql before comic_discovery.sql';");
    expect(SQL).toMatch(/column_name = 'is_forced_private'\) then raise exception/);
    expect(SQL).toMatch(/column_name in \('username', 'avatar_url'\)\) <> 2 then raise exception/);
    expect(SQL).toContain("raise exception 'the discover rpcs must be security definer with search_path = public';");
    expect(SQL).toContain("raise exception 'comic_discover_kind is internal';");
  });
});

describe('the edge allow-lists the two RPCs', () => {
  it('functions/_shared/supabaseRpc.ts names them', () => {
    const rpc = read('functions/_shared/supabaseRpc.ts');
    expect(rpc).toMatch(/'comic_discover_list'/);
    expect(rpc).toMatch(/'comic_discover_shelves'/);
  });
});
