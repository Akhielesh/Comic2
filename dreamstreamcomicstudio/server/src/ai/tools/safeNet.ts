// Outbound network guard for USER/MODEL-supplied URLs (link unfurl, reader mode, deep-research
// reads, user MCP servers).
//
// The string and DNS checks in mcpClient.ts (isSafeMcpUrl + assertSafePublicUrl) look up a host
// and then let fetch() look it up AGAIN when it connects. A DNS-rebinding host answers the first
// lookup with a public address and the second with 127.0.0.1 / 169.254.169.254, so the check and
// the connection see different IPs. This module closes that window: `pinnedFetch` connects with
// a `lookup` hook (`safeLookup`) that resolves the name once, refuses the connection if ANY
// resolved address is private / loopback / link-local / ULA / metadata, and hands the socket
// exactly the addresses it checked. IP-literal hosts never reach a lookup, so they are checked
// up front.
//
// Built on node:http/https (the global fetch takes a lookup only through an undici dispatcher,
// and undici is not a direct dependency). The result is a standard web Response, so callers
// read it like any fetch response; redirects are never followed here (callers that follow
// them, like fetchPublicUrl, re-check every hop).

import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { Readable, pipeline } from 'node:stream';
import zlib from 'node:zlib';

export interface ResolvedAddress {
  address: string;
  family: number;
}

/** Resolves a host name to every address it has (the system resolver unless a test swaps it). */
export type Resolver = (hostname: string) => Promise<ResolvedAddress[]>;

/** fetch-shaped transport used for every pinned request. */
export type Transport = (url: string, init?: RequestInit) => Promise<Response>;

const systemResolver: Resolver = async (hostname) =>
  (await dns.promises.lookup(hostname, { all: true, verbatim: true })).map((a) => ({ address: a.address, family: a.family }));

let resolver: Resolver = systemResolver;
let transportOverride: Transport | null = null;

/** Resolve a host through the current resolver (used by the pre-connect checks too). */
export const resolveHost = (hostname: string): Promise<ResolvedAddress[]> => resolver(hostname);

// ------------------------------------------------------------ address policy --

const parseV4 = (s: string): number[] | null => {
  const parts = s.split('.');
  if (parts.length !== 4) return null;
  const out: number[] = [];
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    out.push(n);
  }
  return out;
};

const isPrivateV4 = ([a, b, c]: number[]): boolean =>
  a === 0 || // "this network"
  a === 10 ||
  a === 127 ||
  (a === 100 && b >= 64 && b <= 127) || // CGNAT
  (a === 169 && b === 254) || // link-local incl. 169.254.169.254 cloud metadata
  (a === 172 && b >= 16 && b <= 31) ||
  (a === 192 && b === 0 && (c === 0 || c === 2)) || // IETF assignments, TEST-NET-1
  (a === 192 && b === 168) ||
  (a === 198 && (b === 18 || b === 19)) || // benchmarking
  (a === 198 && b === 51 && c === 100) || // TEST-NET-2
  (a === 203 && b === 0 && c === 113) || // TEST-NET-3
  a >= 224; // multicast, reserved, broadcast

/** Expand an IPv6 address to its 8 hextets (embedded dotted IPv4 tail allowed), or null. */
const parseV6 = (input: string): number[] | null => {
  let s = input;
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  if (!s.includes(':')) return null;
  let tail: number[] = [];
  const lastColon = s.lastIndexOf(':');
  const last = s.slice(lastColon + 1);
  if (last.includes('.')) {
    const v4 = parseV4(last);
    if (!v4) return null;
    tail = [(v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]];
    s = s.slice(0, lastColon + 1) + '0:0'; // placeholder hextets, replaced below
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const toNums = (part: string): number[] | null => {
    if (!part) return [];
    const out: number[] = [];
    for (const h of part.split(':')) {
      if (!/^[0-9a-f]{1,4}$/i.test(h)) return null;
      out.push(parseInt(h, 16));
    }
    return out;
  };
  const head = toNums(halves[0]);
  const rest = halves.length === 2 ? toNums(halves[1]) : [];
  if (!head || !rest) return null;
  let hextets: number[];
  if (halves.length === 2) {
    const fill = 8 - head.length - rest.length;
    if (fill < 1) return null;
    hextets = [...head, ...new Array(fill).fill(0), ...rest];
  } else {
    hextets = head;
  }
  if (hextets.length !== 8) return null;
  if (tail.length) hextets.splice(6, 2, ...tail);
  return hextets;
};

const embeddedV4 = (h: number[], hi: number, lo: number): number[] => [h[hi] >> 8, h[hi] & 0xff, h[lo] >> 8, h[lo] & 0xff];

const isPrivateV6 = (h: number[]): boolean => {
  const zeroUpTo = (n: number) => h.slice(0, n).every((x) => x === 0);
  if (h.every((x) => x === 0)) return true; // :: unspecified
  if (zeroUpTo(7) && h[7] === 1) return true; // ::1 loopback
  if (zeroUpTo(5) && h[5] === 0xffff) return isPrivateV4(embeddedV4(h, 6, 7)); // ::ffff:a.b.c.d (IPv4-mapped)
  if (zeroUpTo(4) && h[4] === 0xffff && h[5] === 0) return isPrivateV4(embeddedV4(h, 6, 7)); // ::ffff:0:a.b.c.d
  if (zeroUpTo(6)) return true; // ::a.b.c.d IPv4-compatible (deprecated, never a public server)
  if (h[0] === 0x64 && h[1] === 0xff9b && h[2] === 0 && h[3] === 0 && h[4] === 0 && h[5] === 0) {
    return isPrivateV4(embeddedV4(h, 6, 7)); // 64:ff9b::/96 NAT64 well-known prefix
  }
  if (h[0] === 0x64 && h[1] === 0xff9b && h[2] === 1) return true; // 64:ff9b:1::/48 local-use NAT64
  if (h[0] === 0x2002) return isPrivateV4(embeddedV4(h, 1, 2)); // 6to4
  if (h[0] === 0x2001 && h[1] === 0) return true; // Teredo (embedded client address is obfuscated)
  if (h[0] === 0x2001 && h[1] === 0x0db8) return true; // documentation
  if (h[0] === 0x0100 && h[1] === 0 && h[2] === 0 && h[3] === 0) return true; // discard-only
  if ((h[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local (ULA)
  if ((h[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((h[0] & 0xffc0) === 0xfec0) return true; // fec0::/10 site-local (deprecated)
  if ((h[0] & 0xff00) === 0xff00) return true; // multicast
  return false;
};

/**
 * True when an IP address must never be reached from a user-supplied URL: private, loopback,
 * link-local, CGNAT, metadata, ULA, multicast, reserved, IPv4-mapped / NAT64 / 6to4 forms of
 * any of those. Anything that does not parse as an IP counts as unsafe (fail closed).
 */
export const isPrivateAddress = (ip: string): boolean => {
  const s = String(ip || '').trim().replace(/^\[|\]$/g, '');
  const v4 = parseV4(s);
  if (v4) return isPrivateV4(v4);
  const v6 = parseV6(s);
  if (v6) return isPrivateV6(v6);
  return true;
};

export class UnsafeAddressError extends Error {
  code = 'EUNSAFEADDR';
  constructor(hostname: string) {
    super(`${hostname} resolves to a private/internal address`);
    this.name = 'UnsafeAddressError';
  }
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void;

/**
 * A dns.lookup-compatible hook for net/tls connect: resolves once, refuses the connection when
 * ANY address is unsafe, and returns exactly the addresses it checked (so the socket connects
 * to an IP that passed). Handles both call shapes Node uses (`all: true` with
 * autoSelectFamily, a single address otherwise) and an optional family filter.
 */
export const createSafeLookup = (resolve: Resolver = (h) => resolver(h)) =>
  (hostname: string, options: dns.LookupOptions | number | LookupCallback, callback?: LookupCallback): void => {
    const cb = (typeof options === 'function' ? options : callback) as LookupCallback;
    const opts: dns.LookupOptions = typeof options === 'number' ? { family: options } : typeof options === 'object' && options ? options : {};
    resolve(hostname).then(
      (addrs) => {
        if (!addrs.length) {
          const err: NodeJS.ErrnoException = new Error(`getaddrinfo ENOTFOUND ${hostname}`);
          err.code = 'ENOTFOUND';
          cb(err, '', 0);
          return;
        }
        if (addrs.some((a) => isPrivateAddress(a.address))) {
          cb(new UnsafeAddressError(hostname), '', 0);
          return;
        }
        const fam = opts.family === 4 || opts.family === 'IPv4' ? 4 : opts.family === 6 || opts.family === 'IPv6' ? 6 : 0;
        const usable = fam ? addrs.filter((a) => a.family === fam) : addrs;
        if (!usable.length) {
          const err: NodeJS.ErrnoException = new Error(`getaddrinfo ENOTFOUND ${hostname}`);
          err.code = 'ENOTFOUND';
          cb(err, '', 0);
          return;
        }
        if (opts.all) cb(null, usable.map((a) => ({ address: a.address, family: a.family })));
        else cb(null, usable[0].address, usable[0].family);
      },
      (err: NodeJS.ErrnoException) => cb(err, '', 0)
    );
  };

/** The lookup hook every pinned connection uses. */
export const safeLookup = createSafeLookup();

// ------------------------------------------------------------------ transport --

const NULL_BODY_STATUS = new Set([101, 204, 205, 304]);

const abortError = (signal: AbortSignal): Error => {
  const reason = signal.reason;
  if (reason instanceof Error) return reason;
  const err = new Error('This operation was aborted');
  err.name = 'AbortError';
  return err;
};

const requestBody = (body: RequestInit['body']): string | Uint8Array | undefined => {
  if (body === undefined || body === null) return undefined;
  if (typeof body === 'string' || body instanceof Uint8Array) return body;
  throw new TypeError('pinnedFetch supports only string or byte bodies');
};

/**
 * One HTTP(S) request through node:http(s) with the given lookup hook, returned as a web
 * Response. Never follows redirects. Content-Encoding gzip / deflate / br is decoded (and the
 * header dropped), matching what fetch hands its callers. Exported for tests.
 */
export const requestWithLookup = (url: string, init: RequestInit, lookup: ReturnType<typeof createSafeLookup>): Promise<Response> =>
  new Promise<Response>((resolve, reject) => {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      reject(new TypeError('invalid URL'));
      return;
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      reject(new TypeError(`unsupported protocol ${u.protocol}`));
      return;
    }
    const signal = init.signal ?? undefined;
    if (signal?.aborted) {
      reject(abortError(signal));
      return;
    }
    let body: string | Uint8Array | undefined;
    try {
      body = requestBody(init.body);
    } catch (err) {
      reject(err);
      return;
    }
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => {
      headers[k] = v;
    });
    if (!headers['accept-encoding']) headers['accept-encoding'] = 'gzip, deflate, br';
    const method = (init.method || 'GET').toUpperCase();
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(
      u,
      { method, headers, lookup: lookup as unknown as net.LookupFunction, agent: false, signal },
      (res) => {
        const status = res.statusCode || 0;
        if (status < 200 || status > 599) {
          res.destroy();
          reject(new Error(`unexpected HTTP status ${status}`));
          return;
        }
        const out = new Headers();
        for (let i = 0; i + 1 < res.rawHeaders.length; i += 2) {
          try {
            out.append(res.rawHeaders[i], res.rawHeaders[i + 1]);
          } catch {
            /* a header value fetch would also refuse: drop it */
          }
        }
        if (method === 'HEAD' || NULL_BODY_STATUS.has(status)) {
          res.resume();
          resolve(new Response(null, { status, statusText: res.statusMessage || '', headers: out }));
          return;
        }
        const encoding = String(res.headers['content-encoding'] || '').trim().toLowerCase();
        const decoder =
          encoding === 'gzip' || encoding === 'x-gzip'
            ? zlib.createGunzip({ finishFlush: zlib.constants.Z_SYNC_FLUSH })
            : encoding === 'deflate'
              ? zlib.createInflate({ finishFlush: zlib.constants.Z_SYNC_FLUSH })
              : encoding === 'br'
                ? zlib.createBrotliDecompress({ finishFlush: zlib.constants.BROTLI_OPERATION_FLUSH })
                : null;
        let stream: Readable = res;
        if (decoder) {
          out.delete('content-encoding');
          out.delete('content-length');
          stream = pipeline(res, decoder, () => undefined) as unknown as Readable;
        }
        const webBody = Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>;
        resolve(new Response(webBody as unknown as BodyInit, { status, statusText: res.statusMessage || '', headers: out }));
      }
    );
    req.on('error', (err) => reject(err));
    req.end(body);
  });

const nodeTransport: Transport = async (url, init = {}) => {
  let host: string;
  try {
    host = new URL(url).hostname.replace(/^\[|\]$/g, '');
  } catch {
    throw new TypeError('invalid URL');
  }
  // An IP-literal host is connected to directly — no lookup runs — so check it here.
  if (net.isIP(host) && isPrivateAddress(host)) throw new UnsafeAddressError(host);
  return requestWithLookup(url, init, safeLookup);
};

/**
 * fetch() for an untrusted URL with the resolved IP pinned: the connection goes only to an
 * address that passed `isPrivateAddress` in the same lookup. Never follows redirects (a 3xx
 * comes back as the response). Use fetchPublicUrl (mcpClient.ts) to follow redirects safely.
 */
export const pinnedFetch: Transport = (url, init) => (transportOverride ?? nodeTransport)(url, init ?? {});

/**
 * Test hook: swap the resolver (pre-connect checks + the lookup hook) and/or the transport.
 * Returns a function that restores the previous ones.
 */
export const __setNetForTests = (o: { resolve?: Resolver; transport?: Transport | null }): (() => void) => {
  const prev = { resolver, transportOverride };
  if (o.resolve) resolver = o.resolve;
  if (o.transport !== undefined) transportOverride = o.transport;
  return () => {
    resolver = prev.resolver;
    transportOverride = prev.transportOverride;
  };
};
