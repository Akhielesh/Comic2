/**
 * The ENFORCED Content-Security-Policy of the share/reader route /c/* (contract §14.2).
 *
 * The SPA shell has inline scripts (an import map and a splash watchdog) and one inline event
 * handler. Instead of 'unsafe-inline', every inline executable <script> in the served
 * index.html is hashed at runtime (sha256, cached per deploy by content), and the inline
 * handlers get 'unsafe-hashes' + their exact hashes. JSON blocks (application/json,
 * application/ld+json — our boot card and JSON-LD) are data, never executed, so they need no
 * hash. Violations are reported to /api/csp-report, which the dreamstream-api Worker answers at
 * the edge (it never wakes the backend container).
 */

const NON_EXECUTABLE = /^(application\/(ld\+)?json|text\/plain|text\/template)$/i;

const decodeAttr = (v: string): string =>
  v.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

async function sha256b64(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  let bin = '';
  for (const b of new Uint8Array(digest)) bin += String.fromCharCode(b);
  return btoa(bin);
}

export interface InlineHashes {
  scripts: string[];
  handlers: string[];
}

let cache: { html: string; hashes: InlineHashes } | null = null;

/** sha256 hashes of every inline executable <script> body and inline on*="" handler in `html`. */
export async function inlineHashes(html: string): Promise<InlineHashes> {
  if (cache && cache.html === html) return cache.hashes;
  const scripts = new Set<string>();
  const handlers = new Set<string>();
  const scriptRe = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
  for (const m of html.matchAll(scriptRe)) {
    const attrs = m[1] || '';
    if (/\bsrc\s*=/i.test(attrs)) continue;
    const type = /\btype\s*=\s*["']?([^"'\s>]+)/i.exec(attrs)?.[1] || '';
    if (type && NON_EXECUTABLE.test(type)) continue;
    scripts.add(`'sha256-${await sha256b64(m[2])}'`);
  }
  const handlerRe = /\son[a-z]+\s*=\s*"([^"]*)"/gi;
  for (const m of html.matchAll(handlerRe)) handlers.add(`'sha256-${await sha256b64(decodeAttr(m[1]))}'`);
  const hashes = { scripts: [...scripts].sort(), handlers: [...handlers].sort() };
  cache = { html, hashes };
  return hashes;
}

export interface CspOptions {
  hashes: InlineHashes;
  /** https://<ref>.supabase.co — public images + the signed-in owner's API calls. */
  supabaseOrigin: string;
  /** The /embed route of a publication that allows embedding: any site may frame it. */
  embed: boolean;
}

/** The enforced policy string. */
export function buildCsp({ hashes, supabaseOrigin, embed }: CspOptions): string {
  const supabaseWs = supabaseOrigin.replace(/^https:/, 'wss:');
  const script = [
    "'self'",
    ...hashes.scripts,
    ...(hashes.handlers.length ? ["'unsafe-hashes'", ...hashes.handlers] : []),
    'https://cdnjs.cloudflare.com',
    'https://aistudiocdn.com',
    'https://static.cloudflareinsights.com',
    'https://challenges.cloudflare.com'
  ];
  return [
    "default-src 'self'",
    `script-src ${script.join(' ')}`,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' data: https://fonts.gstatic.com",
    `img-src 'self' data: blob: ${supabaseOrigin}`,
    "media-src 'self' data: blob:",
    `connect-src 'self' ${supabaseOrigin} ${supabaseWs} https://cloudflareinsights.com https://challenges.cloudflare.com`,
    'frame-src https://challenges.cloudflare.com',
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    `frame-ancestors ${embed ? '*' : "'self'"}`,
    "base-uri 'none'",
    "object-src 'none'",
    "form-action 'self'",
    'upgrade-insecure-requests',
    'report-uri /api/csp-report'
  ].join('; ');
}
