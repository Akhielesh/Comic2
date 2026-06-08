// Lightweight readable-text extraction for deep research — fetch a public web page and
// pull its main body text so the synthesizer can ground claims in the ACTUAL article,
// not just a 320-char search snippet.
//
// SSRF posture matches the existing unfurl feature (https + public-host guard via
// isSafeMcpUrl, size + time capped). Best-effort: returns null on anything that isn't a
// usable HTML page, so a blocked/binary/redirect-looping source is simply skipped.

import { isSafeMcpUrl } from '../tools/mcpClient.js';

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

/** Strip HTML to readable body text, preferring <article>/<main> when present. */
export const htmlToText = (html: string): string => {
  let s = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(nav|header|footer|aside|form|svg|button)[\s\S]*?<\/\1>/gi, ' ');

  // Lightweight readability: if a main content region exists and is substantial, use it.
  const region = s.match(/<article[\s\S]*?<\/article>/i)?.[0] || s.match(/<main[\s\S]*?<\/main>/i)?.[0];
  if (region && region.length > 500) s = region;

  s = s
    .replace(/<\/(p|div|li|h[1-6]|tr|section)>/gi, '\n') // keep some block structure
    .replace(/<[^>]+>/g, ' ');
  s = decodeEntities(s)
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
  return s;
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
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml' },
      redirect: 'follow',
      signal: controller.signal
    });
    if (!res.ok) return null;
    const ct = res.headers.get('content-type') || '';
    if (ct && !/text\/html|application\/xhtml|text\/plain/i.test(ct)) return null;

    let html = '';
    const reader = (res.body as ReadableStream<Uint8Array> | null)?.getReader();
    if (reader) {
      const dec = new TextDecoder();
      let total = 0;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        html += dec.decode(value, { stream: true });
        if (total > MAX_BYTES) {
          controller.abort();
          break;
        }
      }
    } else {
      html = (await res.text()).slice(0, MAX_BYTES);
    }

    const text = htmlToText(html);
    // Too short to add value over the snippet → treat as unreadable.
    return text.length > 250 ? text.slice(0, maxChars) : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
};
