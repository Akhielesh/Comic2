/**
 * The recap's Delivery block (feature doc §4.4, Phase B5): what a finished broadcast took to
 * deliver, from what the host-gated /stats already returns — no new request, no new counter.
 *
 *   - stored: the encoder's own bitrate samples (the studio's health telemetry, every ~30 s),
 *     else the quality preset's bitrate × the time on air;
 *   - viewer-minutes: the room's own count (`stats.use`, host-gated), else the viewer curve
 *     (one sample every 30 s);
 *   - delivered ≈ viewer-minutes × the average bitrate (segments come from R2 through the
 *     Worker; egress costs nobody, so this is for scale, not for a bill);
 *   - list value: the shared price table (shared/stream/usage.ts), shown only inside
 *     "What this costs DreamStream (est.)".
 *
 * Every figure is an estimate, and is shown with ≈.
 */
import { emptyCounters, sanitizeUsage, type UsageCounters } from '@/shared/stream/usage';
import { presetById, SEGMENT_MS } from '../config';
import { bytesPerHour } from '../costCopy';

/** The viewer curve and health telemetry are sampled this often (live-worker eventRoom.ts). */
export const CURVE_SAMPLE_MS = 30_000;

export interface BroadcastRecapInput {
  startedAt: number | null;
  endedAt: number | null;
  quality: string;
  /** The room's segment length (older rooms keep their own). */
  segMs?: number;
  peakViewers: number;
  curve: readonly { at: number; n: number }[];
  healthCurve?: readonly { at: number; enc: number }[] | null;
  /** The room's own usage totals (host-gated; absent on rooms from before Phase A). */
  use?: unknown;
  /** 7-day copies kept for this event (bytes, as R2 stored them). */
  cloudCopyBytes?: number;
}

export interface BroadcastRecap {
  durMs: number;
  peakViewers: number;
  storedBytes: number;
  deliveredBytes: number;
  viewerMinutes: number;
  /** For "What this costs DreamStream (est.)". */
  broadcast: UsageCounters;
  cloudCopy: UsageCounters | null;
}

/** null when the event never went on air. */
export function broadcastRecap(i: BroadcastRecapInput, now = Date.now()): BroadcastRecap | null {
  if (!i.startedAt) return null;
  const durMs = Math.max(0, (i.endedAt ?? now) - i.startedAt);
  if (!(durMs > 0)) return null;

  // Stored: the encoder's samples where there are enough of them, else the preset.
  const enc = (i.healthCurve ?? []).filter((p) => p.enc > 0);
  const storedBytes = enc.length >= 2
    ? (enc.reduce((s, p) => s + p.enc, 0) / enc.length / 8) * (durMs / 1000)
    : bytesPerHour(presetById(i.quality)) * (durMs / 3_600_000);

  const room = i.use ? sanitizeUsage(i.use) : null;
  const curveMinutes = i.curve.reduce((s, p) => s + Math.max(0, p.n), 0) * (CURVE_SAMPLE_MS / 60_000);
  const viewerMinutes = room && room.viewerMinutes > 0 ? room.viewerMinutes : curveMinutes;
  const bytesPerMinute = storedBytes / (durMs / 60_000);
  const deliveredBytes = viewerMinutes * bytesPerMinute;

  const segCount = Math.ceil(durMs / (i.segMs && i.segMs > 0 ? i.segMs : SEGMENT_MS));
  const samples = Math.ceil(durMs / CURVE_SAMPLE_MS);
  const broadcast: UsageCounters = {
    ...emptyCounters(),
    segBytes: storedBytes,
    segCount,
    viewerMinutes,
    workerRequestsEst: segCount,
    // What the room counts per segment (2 requests, 1 row; kept private in its meta) plus its
    // live upkeep (1 request, 2 rows per curve sample; in the stats it returns, when present).
    doRequestsEst: segCount * 2 + (room && room.doRequestsEst > 0 ? room.doRequestsEst : samples),
    rowsWrittenEst: segCount + (room && room.rowsWrittenEst > 0 ? room.rowsWrittenEst : samples * 2),
  };
  const cloud = i.cloudCopyBytes && i.cloudCopyBytes > 0 ? { ...emptyCounters(), cloudCopyBytes: i.cloudCopyBytes } : null;
  return { durMs, peakViewers: Math.max(0, i.peakViewers | 0), storedBytes, deliveredBytes, viewerMinutes, broadcast, cloudCopy: cloud };
}
