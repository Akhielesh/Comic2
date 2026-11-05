// @vitest-environment node
// abuse-ops-1: page parsing is linear. The old whole-document regexes rescanned to the end of
// the page from every unclosed `<p` / `<meta` / `<`, so a few hundred KB of hostile markup froze
// the event loop for seconds. Semantics are checked on ordinary pages; linearity is checked by
// parsing adversarial input at 256 KB and 1 MB (a generous absolute bound plus a size-ratio
// bound, so a slow CI box does not flake while quadratic work still fails).
import { describe, expect, it } from 'vitest';
import {
  firstElement,
  forEachBlock,
  metaTags,
  parseAttributes,
  removeElements,
  stripMarkdownInline,
  stripTagsLinear,
  titleText
} from './htmlScan.js';
import { extractArticle, parseJinaReader } from './readArticle.js';
import { parseUnfurl } from './unfurl.js';
import { htmlToText } from '../research/readable.js';

describe('htmlScan semantics', () => {
  it('reads meta tags in either attribute order, quotes of both kinds, first value wins', () => {
    const html = `<head>
      <meta property="og:title" content="Don't panic">
      <META content='Second "quoted"' name="twitter:title" />
      <meta property="og:title" content="ignored duplicate">
      <meta name=description content=plain>
      <meta charset="utf-8">
      <metadata property="og:image" content="not a meta tag">
    </head>`;
    const meta = metaTags(html);
    expect(meta.get('og:title')).toBe("Don't panic");
    expect(meta.get('twitter:title')).toBe('Second "quoted"');
    expect(meta.get('description')).toBe('plain');
    expect(meta.has('og:image')).toBe(false);
  });

  it('parses attributes without stalling on junk', () => {
    const a = parseAttributes(' a="1" b=\'2\' c=3 d = "4" e / f="unterminated');
    expect(Object.fromEntries(a)).toEqual({ a: '1', b: '2', c: '3', d: '4', e: '', f: 'unterminated' });
  });

  it('title text, first element, removed elements, blocks', () => {
    expect(titleText('<html><TITLE lang="en">Hello &amp; bye</TITLE>')).toBe('Hello &amp; bye');
    expect(titleText('<title>has <b>markup</b></title>')).toBeUndefined();
    expect(titleText('<titles>no</titles>')).toBeUndefined();
    expect(firstElement('x<main id=a>one</main><main>two</main>', 'main')).toBe('<main id=a>one</main>');
    expect(firstElement('<article>never closed', 'article')).toBeUndefined();
    expect(removeElements('a<script>x</script>b<!-- c -->d<style>never closed', ['script', 'style'], { comments: true })).toBe(
      'a b d<style>never closed'
    );
    const seen: string[] = [];
    forEachBlock('<li><p>in li</p></li><pre>no</pre><p class=x>one</p><h2>two</h2><p>unclosed', ['h2', 'h3', 'p', 'li'], (n, inner) => {
      seen.push(`${n}:${inner}`);
    });
    expect(seen).toEqual(['li:<p>in li</p>', 'p:one', 'h2:two']);
  });

  it('strips tags like /<[^>]+>/ but keeps a stray < as text', () => {
    expect(stripTagsLinear('a<b>c</b>d', '')).toBe('acd');
    expect(stripTagsLinear('1 <> 2 < 3', '')).toBe('1 <> 2 < 3');
    expect(stripTagsLinear('x<a<b>y', '')).toBe('xy');
  });

  it('strips inline markdown: images dropped, links kept as text, emphasis removed', () => {
    expect(stripMarkdownInline('See ![pic](https://x/y.png) the [docs](https://d) for **bold** and _it_ ok')).toBe('See the docs for bold and it ok');
    // Same as the old patterns: brackets not followed by "(" stay text; the inner [b] is not a link either.
    expect(stripMarkdownInline('[not a link] (x) and [a [b] c](u)')).toBe('[not a link] (x) and [a [b] c](u)');
    // `[^\]]*` may hold a "[": the old image pattern took the whole `![unclosed image [and](…)` — so does this.
    expect(stripMarkdownInline('![unclosed image [and](https://l) text')).toBe('text');
  });

  it('extractArticle keeps the old reader behaviour on an ordinary page', () => {
    const html = `<html><head><meta property="og:title" content="A &amp; B"><meta name="author" content="Ann">
      <meta property="og:image" content="/img/lead.jpg"><title>Fallback</title></head>
      <body><nav><p>Navigation link that is long enough to be a paragraph but is chrome.</p></nav>
      <article><h2>Heading</h2><p>${'Real article text. '.repeat(10)}</p><figure><p>${'Caption text. '.repeat(10)}</p></figure>
      <p>${'More article text here. '.repeat(10)}</p></article></body></html>`;
    const out = extractArticle(html, 'https://site.test/a/b');
    expect(out.title).toBe('A & B');
    expect(out.byline).toBe('Ann');
    expect(out.image).toBe('https://site.test/img/lead.jpg');
    expect(out.blocks.map((b) => b.type)).toEqual(['h', 'p', 'p']);
    expect(out.charCount).toBeGreaterThan(240);
  });

  it('parseUnfurl absolutises the image and only keeps http(s) images', () => {
    expect(parseUnfurl('<meta content="/i.png" property="og:image"><title>T</title>', 'https://s.test/p').image).toBe('https://s.test/i.png');
    expect(parseUnfurl('<meta property="og:image" content="javascript:alert(1)">', 'https://s.test/').image).toBeUndefined();
    expect(parseUnfurl('<title>Only title</title>', 'https://s.test/').title).toBe('Only title');
  });
});

describe('linear time on adversarial pages', () => {
  // Every construct the old patterns backtracked on, none of them ever closed.
  const UNIT = '<p>a<li>b<h2 x<meta property="og:title" content="t" <article <main <body <script <!-- <a ![x](y [z](w ';
  const adversarial = (bytes: number): string => UNIT.repeat(Math.ceil(bytes / UNIT.length)).slice(0, bytes);
  const jinaAdversarial = (bytes: number): string => `Title: x\nMarkdown Content:\n${'![['.repeat(Math.ceil(bytes / 3)).slice(0, bytes)}`;

  const time = (fn: () => unknown): number => {
    const runs: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      const t0 = performance.now();
      fn();
      runs.push(performance.now() - t0);
    }
    return runs.sort((a, b) => a - b)[1]; // median of 3
  };

  const parsers: [string, (html: string) => unknown][] = [
    ['extractArticle (read-url)', (h) => extractArticle(h, 'https://x.test/')],
    ['parseUnfurl (unfurl)', (h) => parseUnfurl(h, 'https://x.test/')],
    ['htmlToText (deep research)', (h) => htmlToText(h)],
    ['parseJinaReader (Jina fallback)', (h) => parseJinaReader(h)]
  ];

  it.each(parsers)('%s: 1 MB parses fast and scales linearly', (_name, parse) => {
    const make = _name.startsWith('parseJinaReader') ? jinaAdversarial : adversarial;
    const small = make(256 * 1024);
    const big = make(1024 * 1024);
    parse(small); // warm up the JIT
    const tSmall = time(() => parse(small));
    const tBig = time(() => parse(big));
    // Linear work: ~100 ms on a laptop for 1 MB is far above the real figure (a few ms) and far
    // below the old patterns (seconds at 256 KB, minutes at 1 MB).
    expect(tBig).toBeLessThan(1500);
    // 4x the input: linear ≈ 4x the time; quadratic ≈ 16x. The floor keeps timer noise out.
    expect(tBig / Math.max(tSmall, 5)).toBeLessThan(10);
  }, 20_000);
});
