// @vitest-environment node
//
// The renderers' inputs against W1.2's model checks (render FIX note 3; the deck half, including outlineToDeck's
// decks, is in pptx.test.ts): every RichDoc and DeckSpec fixture under fixtures/render is valid, and so is every
// RichDoc richdocFromMarkdown makes, from the Markdown fixtures and from input past each cap the converter splits or
// cuts at. markdown.test.ts checks the caps by hand; this holds the converter to the real checker, so a contract
// rule the hand checks miss (an id pattern, a repeated id, a run that is empty after cleaning) still fails here.
import { readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { RICHDOC_LIMITS } from '../../platform-core/src/contract/richdoc.js';
import { MODEL_LIMITS } from '../../platform-core/src/contract/schema.js';
import { checkDeckSpec } from '../../platform-core/src/models/deck/index.js';
import { checkRichDoc } from '../../platform-core/src/models/richdoc/index.js';
import { richdocFromMarkdown } from './markdown.js';
import { IMAGES, renderFixture, renderFixturePath, renderFixtureText } from './render.testkit.js';

/** The fixture files of one kind under fixtures/render (read from disk, so a new fixture is covered). */
const fixtures = (dir: string, ext: string): string[] =>
  readdirSync(renderFixturePath(dir))
    .filter((f) => f.endsWith(ext))
    .sort()
    .map((f) => `${dir}/${f}`);

/** checkRichDoc's errors (undefined when valid), so a failure prints the paths and codes. */
const richdocErrors = (doc: unknown) => checkRichDoc(doc).errors;

describe('fixtures under fixtures/render pass the model checks', () => {
  it('every RichDoc fixture passes checkRichDoc', () => {
    const files = fixtures('richdoc', '.json');
    expect(files).toContain('richdoc/script.json');
    for (const f of files) expect(richdocErrors(renderFixture(f)), f).toBeUndefined();
  });

  it('every deck fixture (or the deck inside a test-case file) passes checkDeckSpec', () => {
    const files = fixtures('deck', '.json');
    expect(files).toEqual(['deck/dark-4x3.json', 'deck/overlap.json']);
    for (const f of files) {
      const raw = renderFixture<{ v?: number; deck?: unknown }>(f);
      // overlap.json is a test case: {note, deck, expected, fixedChartRect}. Its deck overlaps, which is a render-time
      // refusal (overlapCheck), not a schema error.
      const deck = raw.v === 1 ? raw : raw.deck;
      expect(deck, f).toBeDefined();
      expect(checkDeckSpec(deck).errors, f).toBeUndefined();
    }
  });
});

describe('richdocFromMarkdown output passes checkRichDoc', () => {
  it('for every Markdown fixture, alone and together', () => {
    const files = fixtures('markdown', '.md');
    expect(files).toEqual(['markdown/gfm.md', 'markdown/hostile.md']);
    for (const f of files) expect(richdocErrors(richdocFromMarkdown(renderFixtureText(f))), f).toBeUndefined();
    expect(richdocErrors(richdocFromMarkdown(files.map(renderFixtureText).join('\n\n')))).toBeUndefined();
  });

  it('for input past every cap the converter splits or cuts at, and for degenerate input', () => {
    const L = RICHDOC_LIMITS;
    const wide = 15;
    const tableRows = 120;
    const table = [
      `| ${Array.from({ length: wide }, (_, i) => `C${i + 1}`).join(' | ')} |`,
      `|${Array.from({ length: wide }, () => '---').join('|')}|`,
      ...Array.from({ length: tableRows }, (_, r) => `| ${Array.from({ length: wide }, (_, c) => `r${r}c${c}`).join(' | ')} |`),
    ].join('\n');
    const emphasised = (n: number): string => Array.from({ length: n }, (_, i) => (i % 2 ? `**b${i}**` : `*i${i}*`)).join(' ');
    const cases: [string, string][] = [
      [`a table of ${tableRows} rows and ${wide} columns (over ${L.tableRows} rows and ${L.tableCols} columns)`, table],
      [`one paragraph over ${MODEL_LIMITS.runText} characters`, 'word '.repeat(3000).trim()],
      [`over ${L.blocksPerSection} blocks`, Array.from({ length: L.blocksPerSection + 500 }, (_, i) => `Paragraph ${i}.`).join('\n\n')],
      [`over ${L.listItems} list items`, Array.from({ length: L.listItems + 100 }, (_, i) => `- item ${i}`).join('\n')],
      [`over ${L.runsPerBlock} runs in one paragraph`, emphasised(L.runsPerBlock + 200)],
      [`over ${L.runsPerCell} runs in one table cell`, `| A | B |\n|---|---|\n| ${emphasised(L.runsPerCell + 50)} | x |`],
      [`a list nested deeper than indent ${MODEL_LIMITS.listIndentMax}`, Array.from({ length: 8 }, (_, i) => `${'  '.repeat(i)}- level ${i}`).join('\n')],
      ['an ordered list nested 8 deep', Array.from({ length: 8 }, (_, i) => `${'   '.repeat(i)}1. level ${i}`).join('\n')],
      ['headings h1 to h6', Array.from({ length: 6 }, (_, i) => `${'#'.repeat(i + 1)} H${i + 1}`).join('\n\n')],
      [`a title over ${L.title} characters`, `# ${'T'.repeat(L.title + 200)}`],
      [`an image alt over ${MODEL_LIMITS.alt} characters`, `![${'a'.repeat(MODEL_LIMITS.alt + 500)}](${IMAGES.png})`],
      ['images in table cells', `| Cover | Note |\n|---|---|\n| ![pic](${IMAGES.png}) | x |\n| ![](${IMAGES.jpeg}) and text | y |\n\nAfter.`],
      ['inline images, one of them not allowed', `Look: ![cover](${IMAGES.png}) and ![vector](data:image/svg+xml;base64,PHN2Zy8+)`],
      ['list items of raw HTML and task boxes', '- <b>x</b>\n- <script>alert(1)</script>\n- [ ] task\n- [x] done'],
      ['unsafe and safe links', '[a](javascript:alert(1)) [b](https://example.com) <mailto:x@example.com> [c](http://x.com)'],
      ['quotes, code, a rule and inline code', '> quote\n> more\n\n```js\nconst x = 1;\n```\n\n---\n\n`inline`'],
      ['control and bidi-override characters only', `${String.fromCharCode(7)}${String.fromCharCode(0x202e)}`],
      ['raw HTML only', '<div>hi</div>'],
      ['nothing', ''],
    ];
    for (const [name, md] of cases) expect(richdocErrors(richdocFromMarkdown(md)), name).toBeUndefined();
  }, 60_000);
});
