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
 *  - LookArt and lookSources never import the index or LibraryImage (which reads it);
 *  - every file that paints a look through LookArt (the Style tab, "Styles that fit", the composer Style panel, a
 *    question's options, the admin console, and any later one) imports neither LibraryImage, the index hook nor the
 *    library barrel (which re-exports both), so a style surface cannot go back to the index beside LookArt;
 *  - no client file outside the list above builds a look's library id another way (a `style.${…}` template or a
 *    'style.' + … concatenation), so the stylePreviewId( rule cannot be stepped around.
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
  `${LIB}/index.ts`,
  `${LIB}/useComicLibrary.ts`
];

/** The style surfaces SC-1 moved onto LookArt: each must still import it (the rule below never goes vacuous). */
const STYLE_SURFACES = [
  'components/comicstudio/board/StyleTab.tsx',
  `${LIB}/StylePresetsCard.tsx`,
  'components/comicstudio/conversation/panels/StylePanel.tsx',
  'components/comicstudio/conversation/cards/OptionsCard.tsx',
  `${LIB}/admin/LibraryConsole.tsx`
];

/** What a file imports (static and dynamic), relative specifiers resolved against the file: "components/…/LookArt". */
const importsOf = (rel: string, text: string): string[] =>
  [...code(text).matchAll(/\b(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)].map((m) =>
    m[1].startsWith('.') ? path.posix.normalize(path.posix.join(path.posix.dirname(rel), m[1])).replace(/\.(?:tsx?|jsx?)$/, '').replace(/\/$/, '') : m[1]
  );
const isLookArt = (target: string) => target === `${LIB}/LookArt`;
/** The library index hook, the image that reads it, or the library folder's barrel (which re-exports both). */
const isIndexReader = (target: string) => [`${LIB}/useComicLibrary`, `${LIB}/LibraryImage`, LIB, `${LIB}/index`].includes(target);
/** A look's library id spelled without stylePreviewId: `style.${…}` or 'style.' + … */
const SPELLED_PREVIEW_ID = /`style\.\$\{|['"]style\.['"]\s*\+/;

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

  it(
    'every file that paints looks through LookArt imports neither LibraryImage, the index hook nor the library barrel',
    () => {
      const files = listScannedFiles({ roots: CLIENT_ROOTS });
      const painters = files.filter((rel) => importsOf(rel, read(rel)).some(isLookArt));
      expect(painters).toEqual(expect.arrayContaining(STYLE_SURFACES));
      const offenders = painters.filter((rel) => importsOf(rel, read(rel)).some(isIndexReader));
      expect(offenders).toEqual([]);
    },
    REAL_TREE_TIMEOUT
  );

  it(
    "no client file outside the list builds a look's library id by hand (a style.${…} template or 'style.' + …)",
    () => {
      const files = listScannedFiles({ roots: CLIENT_ROOTS });
      const users = files.filter((rel) => SPELLED_PREVIEW_ID.test(code(read(rel))));
      expect(users.filter((rel) => !PREVIEW_ID_ALLOWED.includes(rel))).toEqual([]);
    },
    REAL_TREE_TIMEOUT
  );

  it('the new rules see a use: a surface going back to the index beside LookArt would be caught', () => {
    const board = [
      "import { LookArt } from '../library/LookArt';",
      "import { LibraryImage } from '../library/LibraryImage';",
      "import { useComicLibrary } from '../library/useComicLibrary';",
      "import { LibraryImage as L } from '../library';",
      "const Lazy = React.lazy(() => import('../library/index'));",
      "import { PresetThumb } from '../library/procedural/PresetThumb';",
      "// import { LibraryImage } from '../library/LibraryImage';"
    ].join('\n');
    const targets = importsOf('components/comicstudio/board/StyleTab.tsx', board);
    expect(targets.filter(isLookArt)).toEqual([`${LIB}/LookArt`]);
    expect(targets.filter(isIndexReader)).toEqual([`${LIB}/LibraryImage`, `${LIB}/useComicLibrary`, LIB, `${LIB}/index`]);
    // Inside the library folder, the barrel is './index' or './'.
    expect(importsOf(`${LIB}/StylePresetsCard.tsx`, "import { LibraryImage } from './';\nimport x from './index';").filter(isIndexReader)).toEqual([LIB, `${LIB}/index`]);
    expect(importsOf(`${LIB}/StylePresetsCard.tsx`, "import { LookArt } from './LookArt';").filter(isIndexReader)).toEqual([]);
    expect(SPELLED_PREVIEW_ID.test(code('<LibraryImage id={`style.${p.id}`} fallback={x} />'))).toBe(true);
    expect(SPELLED_PREVIEW_ID.test(code("const id = 'style.' + preset.id;"))).toBe(true);
    expect(SPELLED_PREVIEW_ID.test(code('const id = "style." +preset.id;'))).toBe(true);
    expect(SPELLED_PREVIEW_ID.test(code('// `style.${p.id}` in a comment'))).toBe(false);
    expect(SPELLED_PREVIEW_ID.test(code("const cls = 'style.css';"))).toBe(false);
  });

  it('the guard sees a use: a surface that names stylePreviewId( would be caught', () => {
    const sample = "import { stylePreviewId } from 'x';\nconst id = stylePreviewId(p.id);";
    expect(/\bstylePreviewId\s*\(/.test(code(sample))).toBe(true);
    expect(/\bstylePreviewId\s*\(/.test(code('// stylePreviewId(p.id) in a comment'))).toBe(false);
  });
});
