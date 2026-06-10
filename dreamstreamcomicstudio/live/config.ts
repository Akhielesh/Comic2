/**
 * Clear-cut quality options and platform limits for DreamStream Live.
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

export const SEGMENT_MS = 3000;

/** Local recording runs at a higher bitrate than the stream — the master copy
 *  is always better than what viewers saw ("record in full clarity"). */
export const LOCAL_REC_BITRATE_FACTOR = 2.5;

/** Shown verbatim in the UI so the limits are never a surprise. */
export const LIMITS: { label: string; value: string }[] = [
  { label: 'Max concurrent viewers', value: '100 (soft cap — delivery is CDN-cached, so more is possible)' },
  { label: 'Latency', value: '≈ 4–10 s (segmented delivery; sub-second mode planned)' },
  { label: 'Session length', value: 'Unlimited — short clips or marathon sessions' },
  { label: 'Resolution ceiling', value: '1080p60 streaming · local recording at the same resolution, ~2.5× bitrate' },
  { label: 'Recording', value: 'Program feed only — never your screen, chat is never burned in' },
  { label: 'Chat log', value: 'Last 200 messages kept server-side (normal logging, separate from video)' },
  { label: 'Cost', value: '≈ $0.10 per 100-viewer hour on this rail (R2 has zero egress fees)' },
];

export const WORKER_BASE: string =
  ((import.meta as unknown as { env?: Record<string, string> }).env?.VITE_LIVE_WORKER_URL || 'http://127.0.0.1:8788').replace(/\/$/, '');
