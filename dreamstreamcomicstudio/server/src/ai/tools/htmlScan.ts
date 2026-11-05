// Linear-time HTML scanning for untrusted pages (reader mode, link unfurl, deep-research reads).
//
// The previous whole-document regexes (`<p\b[^>]*>([\s\S]*?)<\/p>`, `<meta[^>]+…[^>]+content=…`,
// `<[^>]+>`) backtrack: every unclosed `<p` / `<meta` / `<` rescans to the end of the page, so a
// few hundred KB of adversarial markup froze the event loop for seconds. Everything here walks
// the page with indexOf and never looks at a character more than a constant number of times:
// every search for a `>` or a close tag is cached and only moves forward, so each `>` is found
// once however many openers share it (`'<p'.repeat(n) + '>'` is one search, not n). Same results
// as the old patterns on ordinary pages; on hostile ones the work stays proportional to the input.
// Meta tags longer than 2 KB are skipped and attribute values longer than 1000 characters are
// dropped (the reference scanner's limits), so no single tag can feed a huge value downstream.

const isWordCode = (c: number): boolean =>
  (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;

/** ASCII-only lowercase: same length as the input, so indexes line up with the original. */
export const asciiLower = (s: string): string => s.replace(/[A-Z]+/g, (m) => m.toLowerCase());

/** True when `lower` has `<name` at `lt` followed by a non-word character (regex `<name\b`). */
const opensTag = (lower: string, lt: number, name: string): boolean =>
  lower.startsWith(name, lt + 1) && !isWordCode(lower.charCodeAt(lt + 1 + name.length));

/**
 * Finder for `</name` (name followed by a non-word char) that only ever moves forward: callers
 * pass non-decreasing `from` values, and a cached answer is reused while it is still ahead.
 */
const closeFinder = (lower: string) => {
  const cache = new Map<string, number>();
  return (name: string, from: number): number => {
    const hit = cache.get(name);
    if (hit !== undefined && (hit === -1 || hit >= from)) return hit;
    const token = `</${name}`;
    let idx = lower.indexOf(token, from);
    while (idx !== -1 && isWordCode(lower.charCodeAt(idx + token.length))) idx = lower.indexOf(token, idx + 1);
    cache.set(name, idx);
    return idx;
  };
};

/** Longest attribute value kept; a longer one is dropped (never cut into a broken URL). */
export const MAX_ATTR_VALUE_CHARS = 1000;
/** Longest `<meta …>` tag read; a longer one is skipped whole. */
export const MAX_META_TAG_CHARS = 2048;

/**
 * Attributes of one tag's inner text (between the tag name and its `>`), lower-cased names,
 * first occurrence wins. Quoted values may contain the other quote character. A value longer
 * than MAX_ATTR_VALUE_CHARS is dropped: the attribute reads as absent.
 */
export const parseAttributes = (inner: string): Map<string, string> => {
  const attrs = new Map<string, string>();
  const n = inner.length;
  let i = 0;
  const isSpace = (c: string) => c === ' ' || c === '\n' || c === '\t' || c === '\r' || c === '\f' || c === '/';
  while (i < n) {
    while (i < n && isSpace(inner[i])) i += 1;
    const start = i;
    while (i < n && !isSpace(inner[i]) && inner[i] !== '=') i += 1;
    const name = asciiLower(inner.slice(start, i));
    while (i < n && (inner[i] === ' ' || inner[i] === '\n' || inner[i] === '\t' || inner[i] === '\r')) i += 1;
    let value = '';
    if (i < n && inner[i] === '=') {
      i += 1;
      while (i < n && (inner[i] === ' ' || inner[i] === '\n' || inner[i] === '\t' || inner[i] === '\r')) i += 1;
      const q = inner[i];
      if (q === '"' || q === "'") {
        const end = inner.indexOf(q, i + 1);
        value = inner.slice(i + 1, end === -1 ? n : end);
        i = end === -1 ? n : end + 1;
      } else {
        const vs = i;
        while (i < n && !(inner[i] === ' ' || inner[i] === '\n' || inner[i] === '\t' || inner[i] === '\r')) i += 1;
        value = inner.slice(vs, i);
      }
    }
    if (name && !attrs.has(name) && value.length <= MAX_ATTR_VALUE_CHARS) attrs.set(name, value);
    if (i === start) i += 1; // never stall on a stray character
  }
  return attrs;
};

const MAX_META_TAGS = 2000;

/**
 * Every `<meta>` tag's content keyed by its `property` and `name` (lower-cased; first non-empty
 * value wins), e.g. `og:title`, `twitter:image`, `description`, `author`.
 */
export const metaTags = (html: string, lower = asciiLower(html)): Map<string, string> => {
  const out = new Map<string, string>();
  let pos = 0;
  let seen = 0;
  while (seen < MAX_META_TAGS) {
    const lt = lower.indexOf('<meta', pos);
    if (lt === -1) break;
    if (isWordCode(lower.charCodeAt(lt + 5))) {
      pos = lt + 5;
      continue;
    }
    const gt = lower.indexOf('>', lt + 5);
    if (gt === -1) break; // no tag can close after this point
    seen += 1;
    // Every `<meta` before gt shares this '>': resuming past it consumes each '>' once.
    if (gt - lt > MAX_META_TAG_CHARS) {
      pos = gt + 1;
      continue;
    }
    const attrs = parseAttributes(html.slice(lt + 5, gt));
    const content = (attrs.get('content') || '').trim();
    if (content) {
      for (const keyAttr of ['property', 'name', 'itemprop']) {
        const key = asciiLower((attrs.get(keyAttr) || '').trim());
        if (key && !out.has(key)) out.set(key, content);
      }
    }
    pos = gt + 1;
  }
  return out;
};

/** Text of the first `<title>` (only when it holds no markup, like the old `([^<]+)` pattern). */
export const titleText = (html: string, lower = asciiLower(html)): string | undefined => {
  let pos = 0;
  while (true) {
    const lt = lower.indexOf('<title', pos);
    if (lt === -1) return undefined;
    if (!opensTag(lower, lt, 'title')) {
      pos = lt + 6;
      continue;
    }
    const gt = lower.indexOf('>', lt + 6);
    if (gt === -1) return undefined;
    const next = lower.indexOf('<', gt + 1);
    if (next === -1) return undefined;
    if (!lower.startsWith('</title', next)) return undefined;
    const text = html.slice(gt + 1, next);
    return text.trim() ? text : undefined;
  }
};

/**
 * The first `<tag …>…</tag>` element (outer HTML), or undefined when none closes. With
 * `openEnded`, a first element that never closes (a page cut off at a download cap) runs to the
 * end of the text instead.
 */
export const firstElement = (
  html: string,
  tag: string,
  lower = asciiLower(html),
  opts: { openEnded?: boolean } = {}
): string | undefined => {
  let pos = 0;
  while (true) {
    const lt = lower.indexOf(`<${tag}`, pos);
    if (lt === -1) return undefined;
    if (!opensTag(lower, lt, tag)) {
      pos = lt + 1 + tag.length;
      continue;
    }
    const close = closeFinder(lower)(tag, lt + 1 + tag.length);
    if (close === -1) return opts.openEnded ? html.slice(lt) : undefined; // no later opening can close either
    const gt = lower.indexOf('>', close);
    return html.slice(lt, gt === -1 ? html.length : gt + 1);
  }
};

/**
 * Remove whole elements (`<script …>…</script>` and the like, first matching close) and,
 * optionally, `<!-- … -->` comments, each replaced by a space. An element or comment that
 * never closes is left in place, as the old lazy patterns did.
 */
export const removeElements = (html: string, names: readonly string[], opts: { comments?: boolean } = {}): string => {
  const lower = asciiLower(html);
  const findClose = closeFinder(lower);
  let commentEnd = -2; // cached index of the next '-->' (-2 unknown, -1 none)
  const out: string[] = [];
  let last = 0;
  let pos = 0;
  while (true) {
    const lt = lower.indexOf('<', pos);
    if (lt === -1) break;
    if (opts.comments && lower.startsWith('<!--', lt)) {
      if (commentEnd === -2 || (commentEnd !== -1 && commentEnd < lt + 4)) commentEnd = lower.indexOf('-->', lt + 4);
      if (commentEnd === -1) {
        pos = lt + 1;
        continue;
      }
      out.push(html.slice(last, lt), ' ');
      last = pos = commentEnd + 3;
      continue;
    }
    let matched: string | null = null;
    for (const name of names) {
      if (opensTag(lower, lt, name)) {
        matched = name;
        break;
      }
    }
    if (!matched) {
      pos = lt + 1;
      continue;
    }
    const close = findClose(matched, lt + 1 + matched.length);
    if (close === -1) {
      pos = lt + 1;
      continue;
    }
    const gt = lower.indexOf('>', close);
    const end = gt === -1 ? html.length : gt + 1;
    out.push(html.slice(last, lt), ' ');
    last = pos = end;
  }
  out.push(html.slice(last));
  return out.join('');
};

/**
 * Walk `<name …>inner</name>` blocks in document order for the given names (regex
 * `<(h2|p|…)\b[^>]*>([\s\S]*?)<\/\1>` with the g flag): after a block, scanning resumes past
 * its close. Stop early by returning false from the callback.
 */
export const forEachBlock = (
  html: string,
  names: readonly string[],
  visit: (name: string, inner: string) => boolean | void
): void => {
  const lower = asciiLower(html);
  const findClose = closeFinder(lower);
  let nextGt = -2; // cached index of the next '>' at or after the current opener (-2 unknown, -1 none)
  let pos = 0;
  while (true) {
    const lt = lower.indexOf('<', pos);
    if (lt === -1) return;
    let matched: string | null = null;
    for (const name of names) {
      if (opensTag(lower, lt, name)) {
        matched = name;
        break;
      }
    }
    if (!matched) {
      pos = lt + 1;
      continue;
    }
    // Openers only move forward, so the cached '>' stays valid until an opener passes it: a run
    // of openers with no '>' (`<p<p<p…>`) shares one search instead of rescanning per opener.
    const from = lt + 1 + matched.length;
    if (nextGt === -2 || (nextGt !== -1 && nextGt < from)) nextGt = lower.indexOf('>', from);
    const gt = nextGt;
    if (gt === -1) return; // no opening tag can end after this point
    const close = findClose(matched, gt + 1);
    if (close === -1) {
      pos = lt + 1;
      continue;
    }
    if (visit(matched, html.slice(gt + 1, close)) === false) return;
    const closeGt = lower.indexOf('>', close);
    pos = closeGt === -1 ? html.length : closeGt + 1;
  }
};

/**
 * Replace every `<…>` tag with `replacement` (the old `/<[^>]+>/g`, but a `<` with no `>`
 * after it is kept as text instead of being rescanned to the end of the page).
 */
export const stripTagsLinear = (html: string, replacement = ' '): string => {
  const out: string[] = [];
  let last = 0;
  let pos = 0;
  let nextGt = -2;
  while (true) {
    const lt = html.indexOf('<', pos);
    if (lt === -1) break;
    if (nextGt === -2 || (nextGt !== -1 && nextGt <= lt)) nextGt = html.indexOf('>', lt + 1);
    if (nextGt === -1) break; // no tag can close: the rest is text
    if (nextGt === lt + 1) {
      pos = lt + 1; // "<>" is not a tag
      continue;
    }
    out.push(html.slice(last, lt), replacement);
    last = pos = nextGt + 1;
  }
  out.push(html.slice(last));
  return out.join('');
};

/**
 * Inline markdown to plain text: images dropped, `[text](url)` links kept as their text,
 * `*`/`_`/`` ` `` emphasis markers around words removed. Linear: bracket searches only move
 * forward.
 */
export const stripMarkdownInline = (s: string): string => {
  const out: string[] = [];
  let nextClose = -2; // next ']'
  let nextParen = -2; // next ')'
  const findClose = (from: number) => {
    if (nextClose === -2 || (nextClose !== -1 && nextClose < from)) nextClose = s.indexOf(']', from);
    return nextClose;
  };
  const findParen = (from: number) => {
    if (nextParen === -2 || (nextParen !== -1 && nextParen < from)) nextParen = s.indexOf(')', from);
    return nextParen;
  };
  let i = 0;
  let last = 0;
  while (i < s.length) {
    const image = s[i] === '!' && s[i + 1] === '[';
    if (s[i] === '[' || image) {
      const open = image ? i + 1 : i;
      const close = findClose(open + 1);
      if (close !== -1 && s[close + 1] === '(') {
        const paren = findParen(close + 2);
        if (paren !== -1) {
          out.push(s.slice(last, i));
          if (!image) out.push(s.slice(open + 1, close));
          i = last = paren + 1;
          continue;
        }
      }
    }
    i += 1;
  }
  out.push(s.slice(last));
  return out
    .join('')
    .replace(/[*_`]{1,3}([^*_`]+)[*_`]{1,3}/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
};
