// @vitest-environment node
/**
 * One name per thing (owner decision 2026-11-05, DS-R0):
 *  - the PUBLIC shelf of listed comics is the "Library" (StaticSiteHeader, PublicGallery, the comics landing);
 *  - the creator's own comics are "My comics" (dashboard heading, the studio's Back, the phone rail's Back);
 *  - publishing reads "Link only" or "Library + link" — never "public gallery" — and the board's image tab is "Assets".
 * The words are read from each file's syntax tree (TypeScript's parser), so comments and identifiers such
 * as `onBrowseGallery` or the `'gallery'` view id never count; console messages are not UI either.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

/** Every user-visible string in a file: JSX text, string literals and template text (not imports, not console.*). */
function uiText(rel: string): string[] {
  const source = readFileSync(path.join(ROOT, rel), 'utf8');
  const sf = ts.createSourceFile(rel, source, ts.ScriptTarget.Latest, true, rel.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const out: string[] = [];
  const isConsoleCall = (node: ts.Node): boolean =>
    ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === 'console';
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node) || isConsoleCall(node) || ts.isLiteralTypeNode(node)) return;
    if (ts.isJsxText(node)) {
      const text = node.text.replace(/\s+/g, ' ').trim();
      if (text) out.push(text);
    } else if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      out.push(node.text);
    } else if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      out.push(node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** A route or view id ('gallery', '/?view=gallery'), not words a person reads. */
const isAddress = (s: string): boolean => /^[a-z][a-z0-9_-]*$/.test(s) || /^[/?]/.test(s);

const SHARE = ['share/ShareSheet.tsx', 'share/PublishCard.tsx', 'share/PublishPanel.tsx', 'share/shareModel.ts'].map((f) => `components/comicstudio/${f}`);
const NAMED_FILES = [
  ...SHARE,
  'components/modals/ProjectInfoModal.tsx',
  'components/comicshost/ComicsLanding.tsx',
  'components/layout/StaticSiteHeader.tsx',
  'components/PublicGallery.tsx',
  'components/ProjectDashboard.tsx',
  'components/comicstudio/ComicStudio.tsx',
  'components/comicstudio/mobile/shell/NavigationRail.tsx',
  'components/comicstudio/timeline/index.ts',
  'components/SharedViewer.tsx',
  'components/comicstudio/reader/ReaderCoverCard.tsx'
];

describe('naming: Library, My comics, Link only / Library + link, Assets', () => {
  it('no "public gallery" wording, in any case, anywhere in the named files', () => {
    for (const file of NAMED_FILES) {
      const hits = uiText(file).filter((s) => /public\s+gallery/i.test(s));
      expect(hits, file).toEqual([]);
    }
  });

  it('the public shelf is the Library: no "Gallery" label on the landing or in the share flow, and the header and the shelf say Library', () => {
    // (ProjectInfoModal's "Mastery Gallery" is a different thing: the learning exercises, not public comics.)
    for (const file of [...SHARE, 'components/comicshost/ComicsLanding.tsx']) {
      const hits = uiText(file).filter((s) => /\bgallery\b/i.test(s) && !isAddress(s));
      expect(hits, file).toEqual([]);
    }
    const landing = uiText('components/comicshost/ComicsLanding.tsx');
    expect(landing).toContain('Library');
    expect(landing.some((s) => /Browse the Library/.test(s))).toBe(true);
    expect(uiText('components/PublicGallery.tsx')).toContain('Library');
    expect(uiText('components/layout/StaticSiteHeader.tsx').filter((s) => s === 'Library')).toHaveLength(2);
    expect(uiText('components/modals/ProjectInfoModal.tsx')).toContain('Visible in the Library');
  });

  it('the creator’s own comics are "My comics": dashboard heading, the studio Back (label and tooltip), the phone rail Back', () => {
    const dashboard = uiText('components/ProjectDashboard.tsx');
    expect(dashboard).toContain('My comics');
    expect(dashboard).not.toContain('My Comics');
    for (const file of ['components/comicstudio/ComicStudio.tsx', 'components/comicstudio/mobile/shell/NavigationRail.tsx']) {
      const text = uiText(file);
      expect(text.filter((s) => /your projects/i.test(s)), file).toEqual([]);
      expect(text, file).toContain('Back to My comics');
      expect(text, file).toContain('My comics');
    }
    // Both Backs in the studio (the header and the loading skeleton).
    expect(uiText('components/comicstudio/ComicStudio.tsx').filter((s) => s === 'Back to My comics')).toHaveLength(2);
    expect(uiText('components/comicshost/ComicsLanding.tsx')).toContain('My comics');
  });

  it('publishing reads "Link only" / "Library + link" in the sheet, the card and the status line', () => {
    const sheet = uiText('components/comicstudio/share/ShareSheet.tsx');
    expect(sheet).toEqual(expect.arrayContaining(['Link only', 'Library + link', 'List it in the Library?', 'See it in the Library']));
    expect(sheet.filter((s) => /Anyone with link|unlisted\b/i.test(s) && !isAddress(s))).toEqual([]);
    expect(uiText('components/comicstudio/share/PublishCard.tsx')).toEqual(expect.arrayContaining(['Library + link', 'Link only']));
    expect(uiText('components/comicstudio/share/shareModel.ts')).toEqual(
      expect.arrayContaining([
        'Published · In the Library + link',
        'Published · Link only',
        'Listed in the Library, and you get a link to share',
        'Anyone with the link can read it; it isn’t listed'
      ])
    );
    expect(uiText('components/comicstudio/share/PublishPanel.tsx')).toContain('It’s listed in the Library, and anyone with the link can read it.');
  });

  it('the board tab for every image in the comic is "Assets" (its id stays media)', () => {
    const text = uiText('components/comicstudio/timeline/index.ts');
    expect(text).toContain('Assets');
    expect(text).not.toContain('Media');
    expect(text).toContain('media');
  });
});
