// @vitest-environment node
// The public listing rule (services/publicListing.ts): only current Comic Studio publications that passed the
// publish check are listed; older comics are hidden from lists (not changed), and the rule is the same in the
// database query and on the client.
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { LEGACY_PUBLIC_LISTING, filterPublicListing, isCurrentStudioListing, isPubliclyListed } from './publicListing';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
/** Client source files (no tests, no server, no build output). */
const clientSources = (): string[] => {
  const out: string[] = ['App.tsx'];
  for (const dir of ['components', 'services', 'hooks', 'contexts', 'lib']) {
    for (const entry of readdirSync(path.join(ROOT, dir), { recursive: true }) as string[]) {
      if (/\.(ts|tsx)$/.test(entry) && !/\.(test|spec)\.tsx?$|testkit|\.d\.ts$/.test(entry)) out.push(path.join(dir, entry));
    }
  }
  return out;
};

const SLUG = 'AbCdEfGhIjKlMnOpQ';
const published = (extra: Record<string, unknown> = {}, state: Record<string, unknown> = {}) => ({
  is_public: true,
  content_rating: 'PG',
  state: { studioVersion: 4, shareSlug: SLUG, ...state },
  ...extra
});

/** A query builder that records the PostgREST filters it is given. */
const recorder = () => {
  const filters: string[] = [];
  const q = {
    eq: (c: string, v: unknown) => { filters.push(`${c}=eq.${String(v)}`); return q; },
    not: (c: string, op: string, v: unknown) => { filters.push(`${c}=not.${op}.${String(v)}`); return q; },
    in: (c: string, vs: readonly unknown[]) => { filters.push(`${c}=in.(${vs.join(',')})`); return q; }
  };
  return { q, filters };
};

describe('the public listing rule', () => {
  it('lists no older comics while the legacy switch is off', () => {
    expect(LEGACY_PUBLIC_LISTING).toBe(false);
  });

  it('lists a public, unheld, rated current-studio publication', () => {
    for (const rating of ['G', 'PG', 'PG-13']) expect(isPubliclyListed(published({ content_rating: rating }))).toBe(true);
    expect(isPubliclyListed(published({ is_forced_private: false }))).toBe(true);
    expect(isPubliclyListed(published({ is_forced_private: null }))).toBe(true);
  });

  it('hides an older comic: no studio marker, no share slug, no rating', () => {
    const classic = { is_public: true, content_rating: null, state: { coverImageUrl: 'https://cdn.test/c.png', panels: [] } };
    expect(isPubliclyListed(classic)).toBe(false);
    // ...and still lists it when the switch is turned back on.
    expect(isPubliclyListed(classic, true)).toBe(true);
  });

  it('needs every part of the marker', () => {
    expect(isPubliclyListed(published({}, { studioVersion: 3 }))).toBe(false);
    expect(isPubliclyListed(published({}, { studioVersion: '4' }))).toBe(false);
    expect(isPubliclyListed(published({}, { shareSlug: undefined }))).toBe(false);
    expect(isPubliclyListed(published({}, { shareSlug: 'short' }))).toBe(false);
    // The rating is the part a client cannot write (a database trigger keeps it server-set): an older comic
    // that copied the studio keys into its own state is still hidden.
    expect(isPubliclyListed(published({ content_rating: null }))).toBe(false);
    expect(isPubliclyListed(published({ content_rating: 'pg' }))).toBe(false);
    expect(isPubliclyListed(published({ content_rating: 'R' }))).toBe(false);
  });

  it('keeps private and held comics out, in both modes', () => {
    for (const legacy of [false, true]) {
      expect(isPubliclyListed(published({ is_public: false }), legacy)).toBe(false);
      expect(isPubliclyListed(published({ is_forced_private: true }), legacy)).toBe(false);
      expect(isPubliclyListed(null, legacy)).toBe(false);
    }
  });

  it('reads a malformed state as not listed', () => {
    expect(isCurrentStudioListing({ is_public: true, content_rating: 'G', state: null })).toBe(false);
    expect(isCurrentStudioListing({ is_public: true, content_rating: 'G', state: [] })).toBe(false);
    expect(isCurrentStudioListing({ is_public: true, content_rating: 'G', state: 'x' })).toBe(false);
  });
});

describe('the listing rule in the query', () => {
  it('asks the database for the same rule, so hidden comics are never downloaded', () => {
    const { q, filters } = recorder();
    expect(filterPublicListing(q)).toBe(q);
    expect(filters).toEqual([
      'is_public=eq.true',
      'is_forced_private=not.is.true',
      'state->>studioVersion=eq.4',
      'state->>shareSlug=not.is.null',
      'content_rating=in.(G,PG,PG-13)'
    ]);
  });

  it('with the switch on, keeps only the old public and unheld filters', () => {
    const { q, filters } = recorder();
    filterPublicListing(q, true);
    expect(filters).toEqual(['is_public=eq.true', 'is_forced_private=not.is.true']);
  });
});

describe('every public list uses the rule', () => {
  // A query that asks for public projects on its own would list (or count) the hidden older comics again.
  // Allowed: the rule itself; getPublicProject (a lookup by id behind a direct link, not a list); and
  // services/stats.ts, which no screen uses today and must adopt filterPublicListing before one does.
  const ALLOWED: Record<string, number> = { 'services/publicListing.ts': 1, 'services/db.ts': 1, 'services/stats.ts': 2 };

  it('no other client file asks for public projects directly', () => {
    const found: Record<string, number> = {};
    for (const file of clientSources()) {
      const hits = readFileSync(path.join(ROOT, file), 'utf8').match(/\.eq\(\s*['"]is_public['"]\s*,\s*true\s*\)/g);
      if (hits) found[file.split(path.sep).join('/')] = hits.length;
    }
    expect(found).toEqual(ALLOWED);
  });

  it('the one public projects query in services/db.ts is the lookup by id', () => {
    const db = readFileSync(path.join(ROOT, 'services/db.ts'), 'utf8');
    const at = db.search(/\.eq\(\s*['"]is_public['"]\s*,\s*true\s*\)/);
    const fn = db.lastIndexOf('export const ', at);
    expect(db.slice(fn, fn + 40)).toMatch(/^export const getPublicProject = /);
  });

  it('the Library and a public profile go through the rule', () => {
    expect(readFileSync(path.join(ROOT, 'components/PublicGallery.tsx'), 'utf8')).toMatch(/filterPublicListing\(supabase\.from\('projects'\)/);
    expect(readFileSync(path.join(ROOT, 'services/db.ts'), 'utf8')).toMatch(/getPublicProjectsByUser[\s\S]{0,400}filterPublicListing\(supabase/);
  });
});
