// @vitest-environment node
// Lead decision D9 (S2b): every DreamStream surface sends people to ONE support mailbox, SUPPORT_EMAIL
// (components/legal/contacts.ts). A second address — an old contact@, or a mailbox on a domain we do not own such as
// support@dreamstream.com — sends user mail (bugs, billing) somewhere we may not read or control.
//
// Scans the app's source (tests aside) for every address on a DreamStream domain and every contact@ address. Allowed:
//   - SUPPORT_EMAIL itself (server code spells it by hand: it does not import components/; this pins those spellings);
//   - PRIVACY_EMAIL, in components/legal/contacts.ts only: the routed privacy mailbox's one declaration (production
//     added it with the Comics home release; it is for the legal pages' privacy requests, never a support contact).
//     Any other file that spells it by hand still fails here;
//   - components/ComicReader.tsx's footer (Atlas #263 owns that line; D9's exception);
//   - live/** (Stream Studio, left as it is until its owner confirms; D9's exception — not under these roots).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PRIVACY_EMAIL, SUPPORT_EMAIL } from '../../components/legal/contacts';

const ROOT = join(__dirname, '..', '..');
const SOURCE_ROOTS = ['App.tsx', 'index.tsx', 'components', 'contexts', 'hooks', 'services', 'shared', 'server/src'];
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.git', 'coverage', 'live']);
/** Files that may carry another address, each with its reason. */
const EXCEPTIONS: Record<string, string> = {
  'components/ComicReader.tsx': 'the reader footer contact line is Atlas #263’s (D9 exception)'
};
/** One more address a single file may carry: exactly this address, in exactly this file (its declaration). */
const DECLARED: Record<string, string> = {
  'components/legal/contacts.ts': PRIVACY_EMAIL
};
const ADDRESS = /[A-Za-z0-9._%+-]+@(?:dreamstream[A-Za-z0-9.-]*\.[a-z]{2,})/gi;
const CONTACT = /\bcontact@[A-Za-z0-9.-]+\.[a-z]{2,}/gi;

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

describe('one support mailbox on every surface (D9)', () => {
  it('SUPPORT_EMAIL is our own domain', () => {
    expect(SUPPORT_EMAIL).toBe('support@dreamstreamstudio.ai');
  });

  it('no source file (tests aside) names another DreamStream address or a contact@ mailbox', () => {
    const files = SOURCE_ROOTS.flatMap((p) => sourceFiles(join(ROOT, p)));
    expect(files.length).toBeGreaterThan(100); // the walk really covered the app
    const offenders: string[] = [];
    for (const file of files) {
      const rel = relative(ROOT, file).split('\\').join('/');
      if (EXCEPTIONS[rel]) continue;
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(ADDRESS)) {
        const address = m[0].toLowerCase();
        if (address !== SUPPORT_EMAIL && address !== DECLARED[rel]) offenders.push(`${rel}: ${m[0]}`);
      }
      for (const m of src.matchAll(CONTACT)) offenders.push(`${rel}: ${m[0]}`);
    }
    expect(offenders).toEqual([]);
  });

  it('the exceptions still exist (a stale entry would hide a regression elsewhere)', () => {
    for (const rel of Object.keys(EXCEPTIONS)) expect(statSync(join(ROOT, rel)).isFile(), rel).toBe(true);
    for (const rel of Object.keys(DECLARED)) expect(statSync(join(ROOT, rel)).isFile(), rel).toBe(true);
  });

  it('the privacy mailbox is declared once, on our own domain, and no other file spells it by hand', () => {
    expect(PRIVACY_EMAIL).toBe('privacy@dreamstreamstudio.ai');
    const files = SOURCE_ROOTS.flatMap((p) => sourceFiles(join(ROOT, p)));
    const spellers = files
      .map((file) => relative(ROOT, file).split('\\').join('/'))
      .filter((rel) => readFileSync(join(ROOT, rel), 'utf8').toLowerCase().includes(PRIVACY_EMAIL));
    expect(spellers).toEqual(['components/legal/contacts.ts']);
    // The declaration is one line (comments aside).
    const declarations = readFileSync(join(ROOT, 'components/legal/contacts.ts'), 'utf8')
      .split('\n')
      .filter((line) => !/^\s*(?:\/\*|\*|\/\/)/.test(line) && line.includes(PRIVACY_EMAIL));
    expect(declarations).toEqual([`export const PRIVACY_EMAIL = '${PRIVACY_EMAIL}';`]);
  });

  it('the server spells the mailbox exactly as SUPPORT_EMAIL (studio access "Ask an admin")', () => {
    const src = readFileSync(join(ROOT, 'server/src/services/studioAccess.ts'), 'utf8');
    expect(src).toContain(`'mailto:${SUPPORT_EMAIL}?subject=Studio%20access'`);
  });
});
