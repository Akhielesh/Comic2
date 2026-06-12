// Google News RSS link decoder. The RSS feed's <link>s point at
// news.google.com/rss/articles/<token> — an interstitial that redirects with
// JavaScript, so the in-app article reader could never extract the real story
// (every Google News click showed "couldn't be loaded"). This resolves the token
// to the publisher's URL:
//
//  1. Old tokens (CBMi…) embed the URL in base64 — decoded locally, no network.
//  2. New tokens (decode yields an AU_yqL… handle) need Google's internal
//     DotsSplashUi/batchexecute endpoint: read the interstitial's signature +
//     timestamp attributes, then ask it for the "garturl" (the real URL).
//
// Best-effort: any failure returns null and the caller keeps the original link.

import { fetchText } from './http.js';

/** True for news.google.com article-redirect links (RSS or web variants). */
export const isGoogleNewsUrl = (raw: string): boolean => {
  try {
    const u = new URL(raw);
    return /(^|\.)news\.google\.com$/i.test(u.hostname) && /\/articles\//.test(u.pathname);
  } catch {
    return false;
  }
};

const tokenOf = (raw: string): string | null => {
  try {
    const u = new URL(raw);
    const m = u.pathname.match(/\/articles\/([^/?#]+)/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
};

/**
 * Decode the base64 article token locally (pure). Returns the embedded http(s)
 * URL for old-format tokens, the `AU_yqL…` handle for new-format tokens (which
 * then needs the network step), or null when the token is unparseable.
 */
export const decodeArticleToken = (token: string): { url?: string; handle?: string } | null => {
  let bin: string;
  try {
    bin = Buffer.from(token, 'base64').toString('latin1');
  } catch {
    return null;
  }
  const prefix = '\x08\x13\x22';
  if (bin.startsWith(prefix)) bin = bin.slice(prefix.length);
  const suffix = '\xd2\x01\x00';
  if (bin.endsWith(suffix)) bin = bin.slice(0, -suffix.length);
  if (!bin.length) return null;
  // Length-prefixed string: one byte, or two bytes little-endian varint when ≥ 0x80.
  const first = bin.charCodeAt(0);
  let start = 1;
  let len = first;
  if (first >= 0x80) {
    if (bin.length < 2) return null;
    start = 2;
    len = (first & 0x7f) | (bin.charCodeAt(1) << 7);
  }
  const out = bin.slice(start, start + len);
  if (out.startsWith('AU_yqL')) return { handle: out };
  if (/^https?:\/\//i.test(out)) return { url: out };
  return null;
};

/** Pull the batchexecute response's decoded URL out of its anti-JSON envelope. */
export const parseBatchexecuteUrl = (body: string): string | null => {
  // Envelope: ")]}'\n\n[[\"wrb.fr\",\"Fbv4je\",\"[\\\"garturlres\\\",\\\"https://…\\\"…"
  const m = body.match(/"\[\\"garturlres\\",\\"(.*?)\\"/);
  if (m) return m[1].replace(/\\u003d/gi, '=').replace(/\\u0026/gi, '&');
  // Fallback: first escaped http(s) URL that isn't a google.com asset.
  const any = body.match(/\\"(https?:[^"\\]+)\\"/);
  return any && !/news\.google\.com/.test(any[1]) ? any[1].replace(/\\u003d/gi, '=').replace(/\\u0026/gi, '&') : null;
};

const BATCH_URL = 'https://news.google.com/_/DotsSplashUi/data/batchexecute';

/** Resolve a new-format handle via the interstitial's signature + timestamp. */
const resolveViaBatchexecute = async (token: string, signal?: AbortSignal): Promise<string | null> => {
  const page = await fetchText(`https://news.google.com/rss/articles/${token}`, {
    timeoutMs: 8000,
    accept: 'text/html,*/*',
    signal
  });
  const sg = page.match(/data-n-a-sg="([^"]+)"/)?.[1];
  const ts = page.match(/data-n-a-ts="([^"]+)"/)?.[1];
  if (!sg || !ts) return null;

  const inner = JSON.stringify([
    'garturlreq',
    [['X', 'X', ['X', 'X'], null, null, 1, 1, 'US:en', null, 1, null, null, null, null, null, 0, 1], 'X', 'X', 1, [1, 1, 1], 1, 1, null, 0, 0, null, 0],
    token,
    Number(ts),
    sg
  ]);
  const fReq = JSON.stringify([[['Fbv4je', inner, null, 'generic']]]);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  try {
    const res = await fetch(BATCH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body: `f.req=${encodeURIComponent(fReq)}`,
      signal: controller.signal
    });
    if (!res.ok) return null;
    return parseBatchexecuteUrl(await res.text());
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
};

// Decoded URLs are immutable — cache them so re-opening an article is instant.
const cache = new Map<string, string | null>();
const CACHE_MAX = 500;

/** Resolve a news.google.com article link to the publisher's URL (null = couldn't). */
export const decodeGoogleNewsUrl = async (raw: string, signal?: AbortSignal): Promise<string | null> => {
  const token = tokenOf(raw);
  if (!token) return null;
  if (cache.has(token)) return cache.get(token) ?? null;

  let resolved: string | null = null;
  const local = decodeArticleToken(token);
  if (local?.url) resolved = local.url;
  else {
    try {
      resolved = await resolveViaBatchexecute(token, signal);
    } catch {
      resolved = null;
    }
  }
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
  cache.set(token, resolved);
  return resolved;
};
