// @vitest-environment node
//
// The W1.3 merge gate (models FIX note 1): the plain text a composer receives is never longer than the bound the
// EmailDoc check caps (EMAIL_LIMITS.field), so a draft that passes checkEmailDoc always fits a 10,000-character
// composer. Checked over every schema-valid email in the fixtures and over seeded generated documents: lists of up to
// 100 multi-line items at indent 0-2, CR / CRLF / LF line breaks, 80 images with empty and long alts, multi-line
// quotes with a cite, columns, buttons, links (with the URL alone when the text is the URL) and a signature.
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { EmailBlock, EmailDoc } from '../contract/email.js';
import type { Run } from '../contract/schema.js';
import { EMAIL_TEXT_ALLOWANCE, EmailDocSchema, emailBodyTextLength, listPrefixWidth } from '../models/email/index.js';
import { check } from '../schema/index.js';
import { emailToPlainText } from './index.js';

const FIXTURES = fileURLToPath(new URL('../../fixtures/', import.meta.url));

/** Every EmailDoc v1 inside a fixture file (at any depth). */
const docsIn = (value: unknown, out: EmailDoc[] = []): EmailDoc[] => {
  if (Array.isArray(value)) for (const v of value) docsIn(v, out);
  else if (value && typeof value === 'object') {
    const o = value as { v?: unknown; blocks?: unknown; mode?: unknown };
    if (o.v === 1 && Array.isArray(o.blocks) && typeof o.mode === 'string') out.push(value as EmailDoc);
    else for (const v of Object.values(value)) docsIn(v, out);
  }
  return out;
};

const fixtureDocs = (): { name: string; doc: EmailDoc }[] => {
  const out: { name: string; doc: EmailDoc }[] = [];
  for (const dir of ['contract/email', 'email']) {
    for (const file of readdirSync(`${FIXTURES}${dir}`).filter((f) => f.endsWith('.json')).sort()) {
      docsIn(JSON.parse(readFileSync(`${FIXTURES}${dir}/${file}`, 'utf8'))).forEach((doc, i) => out.push({ name: `${dir}/${file}#${i}`, doc }));
    }
  }
  return out;
};

/** mulberry32: a small seeded PRNG, so a failure is reproducible from its seed. */
const prng = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const WORDS = ['plan', 'the', 'Q3', 'launch', 'é', '日本', 'notes', '—', 'ok', 'a', 'review', 'x'];
const BREAKS = ['\n', '\r\n', '\r'];
const HREFS = ['https://example.com/a', 'https://docs.example.com/path?q=1&r=two', 'mailto:team@example.com', 'mailto:a@example.com?subject=Hi'];

const generator = (seed: number) => {
  const rnd = prng(seed);
  const int = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)];
  let ids = 0;
  const id = (p: string) => `${p}${++ids}`;
  /** Words with line breaks of every kind; lines may be empty. */
  const text = (maxWords: number, breaks = true): string => {
    const n = int(1, maxWords);
    let s = '';
    for (let i = 0; i < n; i++) s += (i ? (breaks && rnd() < 0.2 ? pick(BREAKS) + (rnd() < 0.2 ? pick(BREAKS) : '') : ' ') : '') + pick(WORDS);
    return s;
  };
  const runs = (maxRuns: number, breaks = true): Run[] =>
    Array.from({ length: int(1, maxRuns) }, () => {
      const r: Run = { text: text(12, breaks) };
      if (rnd() < 0.3) {
        const href = pick(HREFS);
        r.link = { href };
        // The URL alone, the address of a mailto:, or text around it.
        const roll = rnd();
        if (roll < 0.2) r.text = href;
        else if (roll < 0.3 && href.indexOf('mailto:') === 0) r.text = href.slice('mailto:'.length).split('?')[0];
      }
      return r;
    });
  const listItems = (max: number) => Array.from({ length: int(1, max) }, () => ({ runs: runs(3), ...(rnd() < 0.7 ? { indent: int(0, 2) } : {}) }));
  const leaf = (): EmailBlock => {
    switch (int(0, 6)) {
      case 0:
        return { type: 'heading', id: id('h'), level: pick([1, 2, 3] as const), runs: runs(2, false) };
      case 1:
        return { type: 'paragraph', id: id('p'), runs: runs(4) };
      case 2:
        return { type: 'list', id: id('l'), ordered: rnd() < 0.5, items: listItems(rnd() < 0.2 ? 100 : 12) };
      case 3:
        return { type: 'button', id: id('b'), label: text(4, false), href: pick(HREFS) };
      case 4:
        return { type: 'quote', id: id('q'), runs: runs(3), ...(rnd() < 0.6 ? { cite: text(6) } : {}) };
      case 5:
        return { type: 'divider', id: id('d') };
      default:
        return { type: 'image', id: id('i'), ref: { kind: 'asset', id: 'img-1' }, alt: rnd() < 0.3 ? '' : text(rnd() < 0.2 ? 150 : 8) };
    }
  };
  const block = (): EmailBlock =>
    rnd() < 0.08 ? { type: 'columns', id: id('c'), columns: [{ blocks: Array.from({ length: int(0, 6) }, leaf) as never }, { blocks: Array.from({ length: int(0, 6) }, leaf) as never }] } : leaf();
  return (): EmailDoc => {
    ids = 0;
    const shape = rnd();
    const blocks: EmailBlock[] =
      shape < 0.05
        ? // 80 images, alts empty or long
          Array.from({ length: 80 }, (_, i) => ({ type: 'image' as const, id: `img${i}`, ref: { kind: 'asset' as const, id: 'img-1' }, alt: rnd() < 0.5 ? '' : text(150) }))
        : shape < 0.1
          ? // one ordered list of 100 multi-line items
            [{ type: 'list', id: 'l100', ordered: true, items: Array.from({ length: 100 }, () => ({ runs: runs(2), indent: int(0, 2) })) }]
          : Array.from({ length: int(1, 30) }, block);
    const doc: EmailDoc = { v: 1, mode: 'compose', subject: 'Generated', to: [{ address: 'a@example.com' }], blocks };
    if (rnd() < 0.6) doc.signature = text(10);
    return doc;
  };
};

/** The widest list prefix the schema allows: indent 2, item 100. */
const widestPrefix = (ordered: boolean) => listPrefixWidth(ordered, 2, 100);

describe('emailToPlainText(d).length <= emailBodyTextLength(d) (the body cap holds for what a composer receives)', () => {
  it('holds for every schema-valid email in the fixtures', () => {
    const docs = fixtureDocs().filter(({ doc }) => check(EmailDocSchema, doc).ok);
    expect(docs.length).toBeGreaterThanOrEqual(3);
    for (const { name, doc } of docs) expect(emailToPlainText(doc).length, name).toBeLessThanOrEqual(emailBodyTextLength(doc));
  });

  it('holds for 3,000 generated documents (seeded), and the bound is tight: some reach it exactly', () => {
    let valid = 0;
    let worst = 0;
    let exact = 0;
    for (let seed = 1; seed <= 3000; seed++) {
      const doc = generator(seed)();
      const r = check(EmailDocSchema, doc);
      if (r.ok === false) continue;
      valid++;
      const text = emailToPlainText(doc).length;
      const bound = emailBodyTextLength(doc);
      expect(text, `seed ${seed}`).toBeLessThanOrEqual(bound);
      worst = Math.max(worst, text / bound);
      if (text === bound) exact++;
    }
    // The generator really exercises the schema (a generator of invalid documents would prove nothing).
    expect(valid).toBeGreaterThan(2900);
    expect(worst).toBeGreaterThan(0.9);
    expect(exact).toBeGreaterThan(0);
    // About 3 s alone; a loaded 4-CPU CI runner can more than double that, so this gate gets its own limit (the
    // package's other heavy tests set theirs too) instead of vitest's default 5 s.
  }, 60_000);

  it('list prefixes are exactly listPrefixWidth wide, and every wrapped line is padded to it', () => {
    const items = Array.from({ length: 12 }, (_, i) => ({ runs: [{ text: `item ${i + 1}\nmore` }], indent: i % 3 }));
    for (const ordered of [false, true]) {
      const doc: EmailDoc = { v: 1, mode: 'compose', subject: 's', to: [{ address: 'a@example.com' }], blocks: [{ type: 'list', id: 'l', ordered, items }] };
      const lines = emailToPlainText(doc).split('\n');
      items.forEach((item, i) => {
        const width = listPrefixWidth(ordered, item.indent, i + 1);
        expect(lines[2 * i].indexOf('item'), `${ordered} item ${i + 1}`).toBe(width);
        expect(lines[2 * i + 1], `${ordered} item ${i + 1} wrap`).toBe(`${' '.repeat(width)}more`);
      });
      expect(widestPrefix(ordered)).toBeLessThanOrEqual(EMAIL_TEXT_ALLOWANCE.listItem - 1);
    }
  });
});
