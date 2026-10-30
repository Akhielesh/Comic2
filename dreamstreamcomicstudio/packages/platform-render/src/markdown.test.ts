// @vitest-environment jsdom
//
// richdocFromMarkdown (plan §12 W1.7): untrusted Markdown becomes data. `<script>` (and every other raw HTML) is
// dropped, `javascript:` and every other non-https:/mailto: link loses its link, images are never fetched, a GFM
// table becomes a RichDoc table, and every contract cap holds.
import { describe, expect, it } from 'vitest';
import type { DocBlock, DocTable, RichDoc } from '../../platform-core/src/contract/richdoc.js';
import { RICHDOC_LIMITS } from '../../platform-core/src/contract/richdoc.js';
import type { Run } from '../../platform-core/src/contract/schema.js';
import { ID_PATTERN, MODEL_LIMITS } from '../../platform-core/src/contract/schema.js';
import { renderDocx } from './docx.js';
import { RenderError } from './errors.js';
import { MARKDOWN_MAX_CHARS, richdocFromMarkdown } from './markdown.js';
import { IMAGES, renderFixtureText, text, zipParts } from './render.testkit.js';

const blocksOf = (doc: RichDoc): DocBlock[] => doc.sections.reduce<DocBlock[]>((all, s) => all.concat(s.blocks), []);

const runsOf = (doc: RichDoc): Run[] => {
  const out: Run[] = [];
  for (const b of blocksOf(doc)) {
    if ('runs' in b) out.push(...b.runs);
    if (b.type === 'list') for (const it of b.items) out.push(...it.runs);
    if (b.type === 'table') for (const r of b.rows) for (const c of r.cells) out.push(...c.runs);
  }
  return out;
};

const plain = (doc: RichDoc): string => runsOf(doc).map((r) => r.text).join('|');

const links = (doc: RichDoc): string[] => runsOf(doc).filter((r) => r.link).map((r) => r.link!.href);

/** Every cap and id rule the contract (and W1.2's checkRichDoc) holds a RichDoc to. */
const expectWithinContract = (doc: RichDoc): void => {
  const id = new RegExp(ID_PATTERN);
  const ids = new Set<string>();
  expect(doc.v).toBe(1);
  expect(doc.title.length).toBeGreaterThan(0);
  expect(doc.title.length).toBeLessThanOrEqual(RICHDOC_LIMITS.title);
  expect(doc.title).not.toMatch(/[\r\n]/);
  expect(doc.sections.length).toBeLessThanOrEqual(RICHDOC_LIMITS.sections);
  for (const s of doc.sections) {
    expect(s.id).toMatch(id);
    ids.add(s.id);
    expect(s.blocks.length).toBeLessThanOrEqual(RICHDOC_LIMITS.blocksPerSection);
    for (const b of s.blocks) {
      expect(b.id).toMatch(id);
      expect(ids.has(b.id), `duplicate id ${b.id}`).toBe(false);
      ids.add(b.id);
      if ('runs' in b) expect(b.runs.length).toBeLessThanOrEqual(RICHDOC_LIMITS.runsPerBlock);
      if (b.type === 'list') {
        expect(b.items.length).toBeLessThanOrEqual(RICHDOC_LIMITS.listItems);
        for (const it of b.items) expect(it.indent === undefined || (it.indent >= 1 && it.indent <= MODEL_LIMITS.listIndentMax)).toBe(true);
      }
      if (b.type === 'table') {
        expect(b.rows.length).toBeLessThanOrEqual(RICHDOC_LIMITS.tableRows);
        for (const r of b.rows) expect(r.cells.length).toBeLessThanOrEqual(RICHDOC_LIMITS.tableCols);
      }
    }
  }
  for (const r of runsOf(doc)) {
    expect(r.text.length).toBeGreaterThan(0);
    expect(r.text.length).toBeLessThanOrEqual(MODEL_LIMITS.runText);
    expect(r.text).not.toMatch(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u202A-\u202E\u2066-\u2069]/);
    if (r.link) expect(r.link.href).toMatch(/^(https:\/\/|mailto:)/);
  }
};

describe('richdocFromMarkdown: hostile input', () => {
  const doc = richdocFromMarkdown(renderFixtureText('markdown/hostile.md'));

  it('drops <script> and every other raw HTML, block and inline, with the script content', () => {
    const all = JSON.stringify(doc);
    for (const bad of ['<script', 'script>', "alert('block", "alert('inline", 'onerror', '<iframe', '<img', '<div', 'onclick', '<b>']) expect(all).not.toContain(bad);
    expect(plain(doc)).toContain('bold tags keep their text');
    expect(plain(doc)).toContain("Text inside an HTML block's markdown stays text.");
  });

  it('keeps a link only when it is https: or mailto: (javascript: in any case, data:, http:, relative and file: lose it)', () => {
    expect(links(doc).sort()).toEqual(['https://example.com/notes', 'https://example.net/ref', 'https://example.org/auto', 'mailto:team@example.com?subject=Notes'].sort());
    expect(JSON.stringify(doc)).not.toMatch(/"href":"(javascript|data|http:|file|\.\.)/i);
    for (const t of ['js', 'JS upper', 'data', 'plain http', 'relative', 'file']) expect(plain(doc)).toContain(t);
  });

  it('never keeps a remote or file image: only its alt text stays', () => {
    expect(blocksOf(doc).filter((b) => b.type === 'image')).toEqual([]);
    expect(plain(doc)).toContain('[remote picture] and [local file]');
    expect(JSON.stringify(doc)).not.toContain('evil.example/track.png');
  });

  it('stays within the contract', () => expectWithinContract(doc));
});

describe('richdocFromMarkdown: GFM', () => {
  const doc = richdocFromMarkdown(renderFixtureText('markdown/gfm.md'));

  it('a GFM table becomes a RichDoc table with a header row, marks and links kept', () => {
    const tables = blocksOf(doc).filter((b): b is DocTable => b.type === 'table');
    expect(tables).toHaveLength(1);
    expect(tables[0].header).toBe(true);
    expect(tables[0].rows.map((r) => r.cells.map((c) => c.runs.map((x) => x.text).join('')))).toEqual([
      ['Issue', 'Pages', 'Status'],
      ['#1', '22', 'drawn'],
      ['#2', '24', 'inked'],
      ['#3', '20', 'script'],
    ]);
    expect(tables[0].rows[1].cells[2].runs[0].marks).toEqual(['b']);
    expect(tables[0].rows[2].cells[2].runs[0].marks).toEqual(['code']);
    expect(tables[0].rows[3].cells[2].runs[0].link).toEqual({ href: 'https://example.com/3' });
  });

  it('task lists keep a ballot box, nested lists indent, strikethrough keeps its text, footnotes become text', () => {
    const list = blocksOf(doc).filter((b) => b.type === 'list')[0];
    expect(list && list.type === 'list' && list.items.map((i) => [i.runs.map((r) => r.text).join(''), i.indent || 0])).toEqual([
      ['\u2611 Thumbnails', 0],
      ['\u2610 Letters', 0],
      ['Balloons', 1],
      ['Pass one', 2],
    ]);
    expect(plain(doc)).toContain('cut kept text');
    expect(plain(doc)).toContain('[n]');
    expect(plain(doc)).toContain('[n] Printed at 6.625 by 10.25 inches.');
  });

  it('takes the first heading as the title unless one is given; meta carries lang and author', () => {
    expect(doc.title).toBe('Issue plan');
    const named = richdocFromMarkdown('# A\n\nB', { title: 'Given title', lang: 'te-IN', author: 'Sample Writer' });
    expect(named.title).toBe('Given title');
    expect(named.meta).toEqual({ lang: 'te-IN', author: 'Sample Writer' });
    expect(richdocFromMarkdown('just a line\nand more').title).toBe('just a line');
    expect(richdocFromMarkdown('').title).toBe('Untitled');
    expect(richdocFromMarkdown('x', { lang: 'not a tag!' }).meta).toBeUndefined();
  });

  it('a data: PNG becomes an image block; a data: SVG keeps only its alt', () => {
    const d = richdocFromMarkdown(`Look: ![cover](${IMAGES.png}) and ![vector](data:image/svg+xml;base64,PHN2Zy8+)`);
    const imgs = blocksOf(d).filter((b) => b.type === 'image');
    expect(imgs).toEqual([{ type: 'image', id: imgs[0].id, ref: { kind: 'data', dataUri: IMAGES.png }, alt: 'cover' }]);
    expect(plain(d)).toContain('[vector]');
  });

  it('stays within the contract', () => expectWithinContract(doc));
});

describe('richdocFromMarkdown: caps', () => {
  it('a table over 50 rows continues in new tables with the header repeated; past 12 columns is cut with a note', () => {
    const head = `| ${Array.from({ length: 15 }, (_, i) => `C${i + 1}`).join(' | ')} |`;
    const rule = `|${Array.from({ length: 15 }, () => '---').join('|')}|`;
    const rows = Array.from({ length: 120 }, (_, r) => `| ${Array.from({ length: 15 }, (_, c) => `r${r}c${c}`).join(' | ')} |`);
    const d = richdocFromMarkdown([head, rule, ...rows].join('\n'));
    const tables = blocksOf(d).filter((b): b is DocTable => b.type === 'table');
    expect(tables.map((t) => t.rows.length)).toEqual([50, 50, 23]);
    for (const t of tables) {
      expect(t.rows[0].cells[0].runs[0].text).toBe('C1');
      expect(t.rows[0].cells).toHaveLength(RICHDOC_LIMITS.tableCols);
    }
    expect(tables.reduce((n, t) => n + t.rows.length - 1, 0)).toBe(120);
    expect(plain(d)).toContain('This table has 15 columns; the first 12 are shown.');
    expectWithinContract(d);
  });

  it('long text is split into runs of at most 4,000 characters; nothing is lost', () => {
    const long = 'word '.repeat(3000).trim();
    const d = richdocFromMarkdown(long);
    expect(runsOf(d).length).toBe(4);
    expect(runsOf(d).map((r) => r.text).join('')).toBe(long);
    expectWithinContract(d);
  });

  it('over 2,000 blocks continue in a new section without a page break', () => {
    const d = richdocFromMarkdown(Array.from({ length: 2500 }, (_, i) => `Paragraph ${i}.`).join('\n\n'));
    expect(d.sections.map((s) => s.blocks.length)).toEqual([2000, 500]);
    expect(d.sections.every((s) => s.pageBreakBefore === false)).toBe(true);
    expectWithinContract(d);
  });

  it('control and bidi-override characters are removed', () => {
    const d = richdocFromMarkdown(`a${String.fromCharCode(7)}b${String.fromCharCode(0x202e)}c`);
    expect(plain(d)).toBe('abc');
  });

  it('Markdown over the character cap is too-large; a non-string is invalid', () => {
    expect(() => richdocFromMarkdown('x'.repeat(MARKDOWN_MAX_CHARS + 1))).toThrowError(RenderError);
    try {
      richdocFromMarkdown('x'.repeat(MARKDOWN_MAX_CHARS + 1));
    } catch (err) {
      expect((err as RenderError).code).toBe('too-large');
    }
    expect(() => richdocFromMarkdown(42 as unknown as string)).toThrowError(/text/);
  });
});

describe('richdocFromMarkdown → renderDocx', () => {
  it('a chat answer with a GFM table renders as a Word table, with no trace of its script', async () => {
    const md = `${renderFixtureText('markdown/gfm.md')}\n\n${renderFixtureText('markdown/hostile.md')}`;
    const parts = await zipParts(await renderDocx(richdocFromMarkdown(md)));
    const xml = text(parts, 'word/document.xml');
    expect(xml.match(/<w:tbl>/g)!.length).toBe(1);
    expect(xml).toContain('>drawn<');
    expect(xml).not.toMatch(/script>|alert\('|onerror|<iframe/);
    // An unsafe autolink stays as the text the author typed, never as a link.
    const targets = (text(parts, 'word/_rels/document.xml.rels').match(/Target="[^"]*"/g) || []).join(' ');
    expect(targets).not.toMatch(/javascript|data:|http:\/\/|file:/);
  });
});
