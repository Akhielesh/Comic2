// @vitest-environment node
/**
 * Style art guard (stylepick SC-1). Every place a look is chosen paints its picture through one component,
 * components/comicstudio/library/LookArt.tsx, from static files named in library/lookSources.ts: the picture is
 * there on first paint, and a style surface never waits on (or wakes) the backend for the library index.
 *
 *  - the unused stock photos under public/assets/home/ stay deleted (nothing referenced them);
 *  - nothing on the comics host (components/comicshost/**) reaches the library index (`useComicLibrary`);
 *  - `stylePreviewId(` (the library id of a look's preview) is spelled only in LookArt, lookSources, the admin
 *    console and the library's own code, so no style surface goes back to the index for a look's picture;
 *  - LookArt and lookSources never import the index or LibraryImage (which reads it).
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { APP_ROOT, listScannedFiles, REAL_TREE_TIMEOUT } from './classLists';

const read = (rel: string) => readFileSync(path.join(APP_ROOT, rel), 'utf8');
/** Comments out, so a sentence that names a function never counts as a use. */
const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

/** Every client source root: what ships to the browser (tests excluded by the scan). */
const CLIENT_ROOTS = ['components', 'App.tsx', 'index.tsx', 'qa', 'services', 'hooks', 'contexts', 'lib'];

const LIB = 'components/comicstudio/library';
/** The only client files that may name a look's library preview id. */
const PREVIEW_ID_ALLOWED = [
  `${LIB}/LookArt.tsx`,
  `${LIB}/lookSources.ts`,
  `${LIB}/admin/LibraryConsole.tsx`,
  `${LIB}/LibraryImage.tsx`,
  `${LIB}/sampleArt.ts`,
  `${LIB}/index.ts`,
  `${LIB}/useComicLibrary.ts`
];

describe('style art guard', () => {
  it('the unused stock photos are gone: public/assets/home/ does not exist', () => {
    expect(existsSync(path.join(APP_ROOT, 'public/assets/home'))).toBe(false);
  });

  it(
    'nothing on the comics host reaches the library index',
    () => {
      const files = listScannedFiles({ roots: ['components/comicshost'] });
      expect(files.length).toBeGreaterThan(10);
      const offenders = files.filter((rel) => /useComicLibrary/.test(code(read(rel))));
      expect(offenders).toEqual([]);
    },
    REAL_TREE_TIMEOUT
  );

  it(
    'stylePreviewId( appears only in LookArt, lookSources, the admin console and the library code',
    () => {
      const files = listScannedFiles({ roots: CLIENT_ROOTS });
      expect(files.length).toBeGreaterThan(200);
      const users = files.filter((rel) => /\bstylePreviewId\s*\(/.test(code(read(rel))));
      expect(users.filter((rel) => !PREVIEW_ID_ALLOWED.includes(rel))).toEqual([]);
    },
    REAL_TREE_TIMEOUT
  );

  it('LookArt and lookSources read static files only: no library index, no LibraryImage', () => {
    for (const rel of [`${LIB}/LookArt.tsx`, `${LIB}/lookSources.ts`]) {
      const imports = [...code(read(rel)).matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
      expect(imports.length, rel).toBeGreaterThan(0);
      // The index hook, the image that reads it, or this folder's barrel (which re-exports both).
      expect(imports.filter((spec) => /useComicLibrary|LibraryImage|^\.\/?$|^\.\/index$/.test(spec)), rel).toEqual([]);
    }
  });

  it('the guard sees a use: a surface that names stylePreviewId( would be caught', () => {
    const sample = "import { stylePreviewId } from 'x';\nconst id = stylePreviewId(p.id);";
    expect(/\bstylePreviewId\s*\(/.test(code(sample))).toBe(true);
    expect(/\bstylePreviewId\s*\(/.test(code('// stylePreviewId(p.id) in a comment'))).toBe(false);
  });
});
