// @vitest-environment node
// authz-data-5: no code derives admin (or a plan, or a moderator role) from an email literal. Anyone
// can sign up with the old test address, so it was a privilege escalation wherever it was trusted:
// the settings console, the diagnostics probe, the assistant's account summary and the last-admin
// guard's count. Admin comes only from the server (/api/admin/me, user_roles, the bootstrap list in
// server/src/services/rbac.ts). Tests may still use the address as a hostile fixture.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..');
const SOURCE_ROOTS = ['App.tsx', 'index.tsx', 'components', 'contexts', 'hooks', 'lib', 'services', 'shared', 'functions', 'server/src', 'live/src', 'api-proxy/src'];
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.git', 'coverage']);
const LITERAL = /admin@test\.com/i;

const sourceFiles = (path: string): string[] => {
  let st;
  try {
    st = statSync(path);
  } catch {
    return [];
  }
  if (st.isFile()) return /\.(ts|tsx|js|mjs|cjs)$/.test(path) && !/\.(test|spec)\.[a-z]+$/.test(path) ? [path] : [];
  return readdirSync(path)
    .filter((name) => !SKIP_DIRS.has(name))
    .flatMap((name) => sourceFiles(join(path, name)));
};

describe('admin is never derived from an email literal', () => {
  it('no source file (tests aside) contains the old admin test address', () => {
    const files = SOURCE_ROOTS.flatMap((p) => sourceFiles(join(ROOT, p)));
    expect(files.length).toBeGreaterThan(100); // the walk really covered the app
    const offenders = files.filter((f) => LITERAL.test(readFileSync(f, 'utf8'))).map((f) => relative(ROOT, f));
    expect(offenders).toEqual([]);
  });
});
