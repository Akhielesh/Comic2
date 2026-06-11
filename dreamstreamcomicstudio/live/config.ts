/**
 * Clear-cut quality options and platform limits for Stream Studio.
 * Everything user-facing about "what can I stream and what does it cost"
 * derives from these tables — keep docs/features/stream-studio.md in sync.
 */

export interface QualityPreset {
  id: string;
  label: string;
  width: number;
  height: number;
  frameRate: number;
  videoBps: number;
  audioBps: number;
  /** Honest uplink requirement shown next to the option (≈1.5× total bitrate). */
  minUplinkMbps: number;
}

export const QUALITY_PRESETS: QualityPreset[] = [
  { id: '480p',    label: 'Data saver · 480p30',  width: 854,  height: 480,  frameRate: 30, videoBps: 1_200_000, audioBps: 64_000,  minUplinkMbps: 2 },
  { id: '720p',    label: 'Standard · 720p30',    width: 1280, height: 720,  frameRate: 30, videoBps: 2_500_000, audioBps: 96_000,  minUplinkMbps: 4 },
  { id: '1080p',   label: 'High · 1080p30',       width: 1920, height: 1080, frameRate: 30, videoBps: 4_500_000, audioBps: 128_000, minUplinkMbps: 7 },
  { id: '1080p60', label: 'Ultra · 1080p60',      width: 1920, height: 1080, frameRate: 60, videoBps: 6_800_000, audioBps: 128_000, minUplinkMbps: 10 },
];

export const DEFAULT_PRESET_ID = '720p';

export const presetById = (id: string): QualityPreset =>
  QUALITY_PRESETS.find((p) => p.id === id) ?? QUALITY_PRESETS[1];

/** 6-second segments: fewer encoder rotations (smoother audio, fewer seams),
 *  fewer uploads, and a deliberate ~10 s glass-to-glass buffer that absorbs
 *  network wobble. Rooms created on older builds keep their stored segMs. */
export const SEGMENT_MS = 6000;

/** Local recording runs at a higher bitrate than the stream — the master copy
 *  is always better than what viewers saw ("record in full clarity"). */
export const LOCAL_REC_BITRATE_FACTOR = 2.5;

/** Shown verbatim in the UI so the limits are never a surprise. */
export const LIMITS: { label: string; value: string }[] = [
  { label: 'Concurrent viewers', value: 'You set the cap per event — hard ceiling 200, never exceeded' },
  { label: 'On-air guests', value: 'Up to 4 guests join with cam, mic and screen share — mixed into the program live (Grid / Spotlight / Sidebar scenes)' },
  { label: 'Latency', value: '≈ 8–15 s by design — the buffer keeps playback smooth through network wobble (guests talk to you in real time)' },
  { label: 'Session length', value: 'Unlimited — short clips or marathon sessions' },
  { label: 'Resolution ceiling', value: '1080p60 streaming · local recording at the same resolution, ~2.5× bitrate' },
  { label: 'Replay', value: 'Viewers can re-watch from the same link for 24 h after the stream ends' },
  { label: 'Recordings', value: 'Saved to your device AND kept on the server for 7 days (then auto-deleted) — chat is never burned in' },
  { label: 'Moderation', value: 'Profanity & spam are auto-hidden with strikes → 5-minute timeouts, all logged' },
  { label: 'Cost guardrails', value: 'Closing the studio tab ends the stream instantly (restartable); silent drops auto-end after a 2-minute grace' },
];

const explicitBase = (import.meta as unknown as { env?: Record<string, string> }).env?.VITE_LIVE_WORKER_URL;
const isLocalhost = typeof location !== 'undefined' && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);

/** Worker base: explicit env override → local wrangler dev → same-origin
 *  `/live-api` (the live-worker is mounted on that path via a Workers route on
 *  whatever domain serves the app, e.g. dreamstreamstudio.ai/live-api). Using
 *  the page's own origin — instead of a hardcoded domain — keeps viewer links
 *  working on any deployment of the site. */
export const WORKER_BASE: string = (
  explicitBase ||
  (isLocalhost
    ? 'http://127.0.0.1:8788'
    : typeof location !== 'undefined'
      ? `${location.origin}/live-api`
      : 'https://dreamstreamstudio.ai/live-api')
).replace(/\/$/, '');

/** True when running on localhost — share links minted here won't work on
 *  other devices; the studio shows a heads-up so hosts aren't surprised. */
export const IS_LOCAL_DEV = isLocalhost;
