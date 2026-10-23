/**
 * Where Stream Studio is running: its own host (https://stream.dreamstreamstudio.ai — the app is
 * at '/') or the main one (dreamstreamstudio.ai/live). Share links are built from location, so they
 * follow automatically; this covers what can't: the app's own path, the alert service worker's
 * scope, and the PWA manifest. See shared/streamHost.ts.
 */
import { isStreamHost } from '@/shared/streamHost';

export const ON_STREAM_HOST: boolean = typeof location !== 'undefined' && isStreamHost(location.hostname);

/** The app's own path on this host: '/' on Stream Studio's host, '/live' on the main one. */
export const LIVE_APP_PATH: string = ON_STREAM_HOST ? '/' : '/live';

/**
 * The alert service worker's scope (/live-sw.js): the app's path, so `serviceWorker.ready` resolves
 * on the app's own pages — at the root of Stream Studio's host, at /live on the main one (where
 * installed apps and existing alert subscriptions keep theirs).
 */
export const LIVE_SW_SCOPE: string = LIVE_APP_PATH;

/** The web-app manifest for this host (its start_url, scope and id differ). */
export const LIVE_MANIFEST: string = ON_STREAM_HOST ? '/stream.webmanifest' : '/live.webmanifest';
