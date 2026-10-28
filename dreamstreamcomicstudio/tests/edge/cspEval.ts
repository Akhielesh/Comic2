/**
 * A small, honest Content-Security-Policy evaluator for tests (CSP Level 3 matching rules,
 * minus the parts our policies never use: nonces, 'strict-dynamic', paths with wildcards).
 * Used by tests/edge/*.test.ts to prove a policy allows exactly what a built page loads.
 */
import { createHash } from 'node:crypto';

export type Policy = Map<string, string[]>;

export function parsePolicy(header: string): Policy {
  const policy: Policy = new Map();
  for (const part of header.split(';')) {
    const tokens = part.trim().split(/\s+/).filter(Boolean);
    if (!tokens.length) continue;
    const name = tokens[0].toLowerCase();
    if (!policy.has(name)) policy.set(name, tokens.slice(1)); // first occurrence wins (CSP3 §2.2.1)
  }
  return policy;
}

/** Several policies in one header value are comma-separated. */
export const parsePolicies = (header: string): Policy[] => header.split(',').map((p) => parsePolicy(p));

const FALLBACKS: Record<string, string[]> = {
  'script-src-elem': ['script-src-elem', 'script-src', 'default-src'],
  'script-src-attr': ['script-src-attr', 'script-src', 'default-src'],
  'style-src-elem': ['style-src-elem', 'style-src', 'default-src'],
  'style-src-attr': ['style-src-attr', 'style-src', 'default-src'],
  'worker-src': ['worker-src', 'child-src', 'script-src', 'default-src'],
  'frame-src': ['frame-src', 'child-src', 'default-src'],
};

/** The source list that governs `directive` (after fallbacks), or null when nothing restricts it. */
export function sourcesFor(policy: Policy, directive: string): string[] | null {
  for (const name of FALLBACKS[directive] ?? [directive, 'default-src']) {
    const list = policy.get(name);
    if (list) return list;
  }
  return null;
}

const defaultPort = (scheme: string) => ({ 'http:': '80', 'https:': '443', 'ws:': '80', 'wss:': '443' } as Record<string, string>)[scheme] ?? '';
const portOf = (u: URL) => u.port || defaultPort(u.protocol);

/** CSP3 scheme-part match, including the http→https and ws→wss upgrades (and http(s)→ws(s)). */
function schemeMatches(expression: string, scheme: string): boolean {
  const e = expression.toLowerCase();
  const s = scheme.toLowerCase();
  if (e === s) return true;
  if (e === 'http:' && (s === 'https:')) return true;
  if (e === 'ws:' && (s === 'wss:' || s === 'http:' || s === 'https:')) return true;
  if (e === 'wss:' && s === 'https:') return true;
  return false;
}

function hostMatches(pattern: string, host: string): boolean {
  const p = pattern.toLowerCase();
  const h = host.toLowerCase();
  if (p === '*') return true;
  if (p.startsWith('*.')) return h.endsWith(p.slice(1)) && h.length > p.length - 1;
  return p === h;
}

/** Does `url` match one source expression, on a page at `self`? */
export function matchesSource(expression: string, url: URL, self: URL): boolean {
  const e = expression;
  if (e === "'self'") {
    if (url.origin === self.origin) return true;
    // CSP3 §6.7.2.8: same host and port, with a secure-scheme upgrade (https page → wss:).
    if (url.hostname !== self.hostname || portOf(url) !== portOf(self)) return false;
    return url.protocol === 'https:' || url.protocol === 'wss:' || (self.protocol === 'http:' && (url.protocol === 'http:' || url.protocol === 'ws:'));
  }
  if (e.startsWith("'")) return false; // keywords, hashes, nonces don't match URLs
  if (/^[a-z][a-z0-9+.-]*:$/i.test(e)) return schemeMatches(e, url.protocol);
  const m = /^(?:([a-z][a-z0-9+.-]*):\/\/)?([^/:]+)(?::(\d+|\*))?(\/.*)?$/i.exec(e);
  if (!m) return false;
  const [, scheme, host, port, path] = m;
  if (scheme) {
    if (!schemeMatches(`${scheme}:`, url.protocol)) return false;
  } else if (!schemeMatches(self.protocol, url.protocol)) {
    return false;
  }
  if (!hostMatches(host, url.hostname)) return false;
  if (port) {
    if (port !== '*' && port !== portOf(url)) return false;
  } else if (portOf(url) !== defaultPort(url.protocol)) {
    return false; // a non-default port must be named in the expression
  }
  if (path) return path.endsWith('/') ? url.pathname.startsWith(path) : url.pathname === path;
  return true;
}

export function allowsUrl(policy: Policy, directive: string, url: string | URL, self: string | URL): boolean {
  const list = sourcesFor(policy, directive);
  if (!list) return true;
  const target = typeof url === 'string' ? new URL(url, self) : url;
  const page = typeof self === 'string' ? new URL(self) : self;
  return list.some((s) => matchesSource(s, target, page));
}

export const sha256Source = (text: string) => `'sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}'`;

/** An inline <script> body runs only with 'unsafe-inline' (and no hash/nonce present) or its hash. */
export function allowsInlineScript(policy: Policy, body: string): boolean {
  const list = sourcesFor(policy, 'script-src-elem');
  if (!list) return true;
  if (list.includes(sha256Source(body))) return true;
  const hasHashOrNonce = list.some((s) => /^'(sha(256|384|512)|nonce)-/.test(s));
  return list.includes("'unsafe-inline'") && !hasHashOrNonce;
}

/** A style="" attribute needs 'unsafe-inline' on style-src-attr (or its fallbacks). */
export function allowsInlineStyleAttribute(policy: Policy): boolean {
  const list = sourcesFor(policy, 'style-src-attr');
  return !list || list.includes("'unsafe-inline'");
}

export const allowsEval = (policy: Policy) => !!sourcesFor(policy, 'script-src')?.includes("'unsafe-eval'");
export const allowsWasm = (policy: Policy) => {
  const list = sourcesFor(policy, 'script-src');
  return !list || list.includes("'wasm-unsafe-eval'") || list.includes("'unsafe-eval'");
};
