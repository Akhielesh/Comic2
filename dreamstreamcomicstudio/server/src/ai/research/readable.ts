// Lightweight readable-text extraction for deep research — fetch a public web page and
// pull its main body text so the synthesizer can ground claims in the ACTUAL article,
// not just a 320-char search snippet.
//
// SSRF posture matches the existing unfurl feature: fetchPublicUrl (https + public host, the
// resolved IP pinned for the connection, every redirect hop re-checked), one deadline over
// headers and body, a streamed byte cap, and linear-time HTML scanning. Best-effort: returns
// null on anything that isn't a usable HTML page, so a blocked/binary/redirect-looping source
// is simply skipped.

import { isSafeMcpUrl } from '../tools/mcpClient.js';
import { fetchTextCapped } from '../tools/http.js';
import { firstElement, removeElements, stripTagsLinear } from '../tools/htmlScan.js';

const UA = 'Mozilla/5.0 (compatible; DreamStreamBot/1.0; +https://dreamstream)';
const MAX_BYTES = 400_000;
const FETCH_TIMEOUT_MS = 8_000;
const DEFAULT_MAX_CHARS = 3_500;

const decodeEntities = (s: string): string =>
  s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&#x2F;/g, '/');

/** Strip HTML to readable body text, preferring <article>/<main> when present. Linear time. */
export const htmlToText = (html: string): string => {
  let s = removeElements(html, ['script', 'style', 'noscript', 'nav', 'header', 'footer', 'aside', 'form', 'svg', 'button'], {
    comments: true
  });

  // Lightweight readability: if a main content region exists and is substantial, use it.
  const region = firstElement(s, 'article') || firstElement(s, 'main');
  if (region && region.length > 500) s = region;

  s = stripTagsLinear(s.replace(/<\/(p|div|li|h[1-6]|tr|section)>/gi, '\n')); // keep some block structure
  const lines = decodeEntities(s)
    .replace(/[ \t\f\v\r]+/g, ' ')
    .split('\n')
    .map((l) => l.trim());
  // Collapse runs of blank lines to one (the old /\n\s*\n\s*\n+/ without its backtracking).
  const kept: string[] = [];
  for (const l of lines) {
    if (!l && kept.length && !kept[kept.length - 1]) continue;
    kept.push(l);
  }
  return kept.join('\n').trim();
};

/**
 * Fetch a URL and return its main readable text (capped), or null if it can't be read.
 * Never throws.
 */
export const fetchReadable = async (
  url: string,
  signal?: AbortSignal,
  maxChars = DEFAULT_MAX_CHARS
): Promise<string | null> => {
  if (!isSafeMcpUrl(url).ok) return null;
  try {
    const page = await fetchTextCapped(url, {
      timeoutMs: FETCH_TIMEOUT_MS,
      accept: 'text/html,application/xhtml+xml',
      headers: { 'User-Agent': UA },
      signal,
      maxBytes: MAX_BYTES,
      publicOnly: true,
      contentTypes: /text\/html|application\/xhtml|text\/plain/i // a PDF or image is refused before its body is read
    });
    const text = htmlToText(page.text);
    // Too short to add value over the snippet → treat as unreadable.
    return text.length > 250 ? text.slice(0, maxChars) : null;
  } catch {
    return null;
  }
};
