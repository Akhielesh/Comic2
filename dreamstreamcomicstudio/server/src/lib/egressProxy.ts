// Edge egress relay client. Several market-data upstreams (Yahoo Finance,
// Stooq, Treasury FiscalData intermittently) block this backend's datacenter
// egress IPs — production probing showed every stock/metals/ticker tool
// returning nothing while the same calls worked elsewhere. The data-egress
// Cloudflare Worker (data-egress/) fetches those public endpoints from the
// edge instead; fetchers retry through it ONLY after a direct attempt failed,
// and ONLY for the allowlisted hosts below (mirrors the worker's allowlist).
//
// Config: DATA_EGRESS_URL overrides the relay base ('' disables entirely);
// DATA_EGRESS_SECRET must match the worker's EGRESS_SHARED_SECRET when set.

const DEFAULT_EGRESS_BASE = 'https://dreamstreamstudio.ai/egress';

/** Hosts the relay may fetch — keep in sync with data-egress/src/index.ts. */
export const EGRESS_HOSTS = new Set([
  'query1.finance.yahoo.com',
  'query2.finance.yahoo.com',
  'fc.yahoo.com',
  'stooq.com',
  'api.fiscaldata.treasury.gov'
]);

export const egressBase = (): string | null => {
  const v = process.env.DATA_EGRESS_URL;
  const base = (v === undefined ? DEFAULT_EGRESS_BASE : v).trim().replace(/\/$/, '');
  return base || null;
};

/** The relay URL for an upstream request, or null when not relayable
 *  (host not allowlisted, relay disabled, or the URL IS the relay). */
export const egressUrlFor = (url: string): string | null => {
  const base = egressBase();
  if (!base) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' || !EGRESS_HOSTS.has(u.hostname)) return null;
    if (url.startsWith(base)) return null; // never relay the relay
    return `${base}/fetch?url=${encodeURIComponent(url)}`;
  } catch {
    return null;
  }
};

/** Extra headers the relay requires (shared secret, when configured). */
export const egressHeaders = (): Record<string, string> => {
  const secret = (process.env.DATA_EGRESS_SECRET || '').trim();
  return secret ? { 'x-egress-key': secret } : {};
};
