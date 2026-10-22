// Stream Studio's own address: https://stream.dreamstreamstudio.ai
//
// Stream Studio (the live app: live.html + live/**) used to live at dreamstreamstudio.ai/live.
// It now has its own host, like Atlas (atlas.dreamstreamstudio.ai). Everything that decides
// "where is Stream Studio?" reads THIS file — the Pages middleware (functions/_middleware.ts),
// both apps (services/liveLink.ts, live/host.ts), the backend (auth email links, the sign-in
// handoff, "Your studios") and the email Worker — so the move is one switch.
//
// STREAM_HOST_ON = false: behaviour is exactly as before (links say /live…, the apex serves the
// app). The new host still serves Stream Studio either way, so it can be checked before the flip.
// STREAM_HOST_ON = true: dreamstreamstudio.ai/live, /live/ and /live.html 301 to the new host,
// and every link, email and "Your studios" entry points there. /live-api/*, /api/*, /assets/*,
// /live-sw.js and the manifest keep working on the apex for installed apps and old tabs.
//
// Dependency-free on purpose: the Pages middleware, the Workers and the Node backend all import it.

/** The main DreamStream app (Comic Studio, Chat Studio, account, legal pages). */
export const MAIN_ORIGIN = 'https://dreamstreamstudio.ai';
export const MAIN_HOSTNAME = 'dreamstreamstudio.ai';

/** Stream Studio's own host. */
export const STREAM_HOSTNAME = 'stream.dreamstreamstudio.ai';
export const STREAM_ORIGIN = `https://${STREAM_HOSTNAME}`;

/**
 * THE switch. Flip to `true` only after https://stream.dreamstreamstudio.ai/ serves Stream
 * Studio (custom domain attached to the Pages project, the retired dreamstream-studio Worker
 * and its wildcard route deleted) — see docs/infrastructure/INFRA_MAP.md §"Stream Studio host".
 */
export const STREAM_HOST_ON = false;

/** Hosts that only redirect to the Stream Studio host (exact match). */
export const STREAM_ALIAS_HOSTS: readonly string[] = [`www.${STREAM_HOSTNAME}`];

/** True on the Stream Studio host itself. */
export const isStreamHost = (hostname: string | null | undefined): boolean =>
  (hostname || '').toLowerCase() === STREAM_HOSTNAME;

/** The old addresses of the app on the main host: /live, /live/ and /live.html. */
export const isLegacyLivePath = (pathname: string): boolean =>
  pathname === '/live' || pathname === '/live/' || pathname === '/live.html';

/**
 * A Stream Studio link written the old way ('/live', '/live.html?e=X', '/live#/monitor',
 * '/live?after=monitor&token_hash=…') → the same place on the Stream Studio host
 * ('https://stream.dreamstreamstudio.ai/?e=X', '…/#/monitor', …). Query and #fragment are kept.
 * Anything that isn't a Stream Studio path keeps its path.
 */
export function toStreamUrl(legacy: string, origin: string = STREAM_ORIGIN): string {
  const base = origin.replace(/\/+$/, '');
  let url: URL;
  try {
    url = new URL(legacy || '/', `${MAIN_ORIGIN}/`);
  } catch {
    return `${base}/`;
  }
  const path = isLegacyLivePath(url.pathname) ? '/' : url.pathname;
  return `${base}${path}${url.search}${url.hash}`;
}

/**
 * Where a Stream Studio link should point. Switch off: the old path, unchanged (same-origin,
 * exactly as before). Switch on: the absolute address on the Stream Studio host.
 * `on` is a parameter only so tests can exercise both sides of the switch.
 */
export const streamAppHref = (legacy: string = '/live', on: boolean = STREAM_HOST_ON): string =>
  on ? toStreamUrl(legacy) : legacy;

/** True when `href` points at the Stream Studio host (any path). */
export function isStreamUrl(href: string | null | undefined): boolean {
  if (!href) return false;
  try {
    const url = new URL(href);
    return url.protocol === 'https:' && isStreamHost(url.hostname) && !url.port && !url.username && !url.password;
  } catch {
    return false;
  }
}

/** The address people see and type, for copy ("Open stream.dreamstreamstudio.ai"). */
export const streamAddressLabel = (on: boolean = STREAM_HOST_ON): string =>
  on ? STREAM_HOSTNAME : `${MAIN_HOSTNAME}/live`;

/**
 * Stream Studio screens a sign-in link or the handoff may land on (`after=…` → `#/<screen>`).
 * The live app (live/account.ts), the backend (services/authEmailLinks.ts) and the handoff
 * share this list, so a link can never name a screen the app doesn't restore.
 */
export const STREAM_RETURN_SCREENS = ['monitor', 'settings', 'create', 'calls'] as const;
export type StreamReturnScreen = (typeof STREAM_RETURN_SCREENS)[number];

export const parseStreamScreen = (value: unknown): StreamReturnScreen | undefined =>
  typeof value === 'string' && (STREAM_RETURN_SCREENS as readonly string[]).includes(value)
    ? (value as StreamReturnScreen)
    : undefined;

/** '#/monitor/abc/watch' → 'monitor' (when it's a screen a link may return to). */
export const screenOfHash = (hash: string | null | undefined): StreamReturnScreen | undefined =>
  parseStreamScreen(String(hash || '').replace(/^#\/?/, '').split(/[/?]/)[0]);
