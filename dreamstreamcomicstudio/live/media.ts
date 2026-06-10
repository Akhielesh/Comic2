/** Camera capture, codec selection and the two recorders (stream + local master). */

import type { QualityPreset } from './config';
import { LOCAL_REC_BITRATE_FACTOR } from './config';

/**
 * Codec preference: MP4/H.264 first — if the host can produce it, every viewer
 * (including Safari) can play it via MSE. WebM is the fallback for browsers
 * whose MediaRecorder can't mux MP4.
 */
const MIME_CANDIDATES = [
  'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
  'video/mp4',
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
];

export function pickSupportedMime(
  isTypeSupported: (m: string) => boolean = (m) =>
    typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(m),
): string | null {
  for (const m of MIME_CANDIDATES) {
    try {
      if (isTypeSupported(m)) return m;
    } catch {
      /* some browsers throw on unknown containers */
    }
  }
  return null;
}

export async function openCamera(preset: QualityPreset, deviceId?: string): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true },
    video: {
      width: { ideal: preset.width },
      height: { ideal: preset.height },
      frameRate: { ideal: preset.frameRate },
      ...(deviceId ? { deviceId: { exact: deviceId } } : { facingMode: 'user' }),
    },
  });
}

export async function listVideoInputs(): Promise<MediaDeviceInfo[]> {
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.filter((d) => d.kind === 'videoinput');
}

/** Compact chip label for a camera device (iOS exposes the discrete lenses). */
export function lensLabel(label: string, index: number): string {
  const l = label.toLowerCase();
  if (l.includes('ultra wide') || l.includes('ultra-wide')) return '0.5×';
  if (l.includes('telephoto')) return 'Tele';
  if (l.includes('triple') || l.includes('dual')) return 'Auto';
  if (l.includes('front')) return 'Front';
  if (l.includes('back') || l.includes('rear')) return 'Back';
  return label ? label.split(' ')[0].slice(0, 8) : `Cam ${index + 1}`;
}

export interface ZoomRange {
  min: number;
  max: number;
  step: number;
  value: number;
}

/** Optical/digital zoom where the browser exposes it (Safari 17+, Chrome Android). */
export function zoomCapability(track: MediaStreamTrack): ZoomRange | null {
  const caps = (track.getCapabilities?.() ?? {}) as Record<string, { min?: number; max?: number; step?: number }>;
  const z = caps.zoom;
  if (!z || z.min == null || z.max == null) return null;
  const settings = track.getSettings() as Record<string, number>;
  return { min: z.min, max: z.max, step: z.step || 0.1, value: settings.zoom ?? z.min };
}

export function setZoom(track: MediaStreamTrack, value: number): Promise<void> {
  // `zoom` is not in TS's MediaTrackConstraintSet yet, but Safari 17+/Chrome Android honor it.
  return track.applyConstraints({ advanced: [{ zoom: value } as unknown as MediaTrackConstraintSet] });
}

export interface SegmentHandler {
  (blob: Blob, seq: number, durMs: number): void;
}

/**
 * Streams the camera as short SELF-CONTAINED segments by rotating MediaRecorder
 * instances: each segment is an independently playable file, so viewers can
 * join at the live edge instead of needing the whole stream from byte zero.
 */
export class SegmentedRecorder {
  private active: MediaRecorder | null = null;
  private timer: number | null = null;
  private seqCounter: number;

  constructor(
    private stream: MediaStream,
    private opts: { mimeType: string; videoBps: number; audioBps: number; segMs: number; startSeq?: number },
    private onSegment: SegmentHandler,
  ) {
    this.seqCounter = (opts.startSeq ?? 1) - 1;
  }

  get nextSeq(): number {
    return this.seqCounter + 1;
  }

  start(): void {
    this.spin();
    this.timer = window.setInterval(() => this.spin(), this.opts.segMs);
  }

  /** Stops recording; the in-flight segment still flushes through onSegment. */
  stop(): void {
    if (this.timer != null) window.clearInterval(this.timer);
    this.timer = null;
    if (this.active && this.active.state !== 'inactive') this.active.stop();
    this.active = null;
  }

  private spin(): void {
    const prev = this.active;
    const seq = ++this.seqCounter;
    const startedAt = performance.now();
    const chunks: Blob[] = [];
    const rec = new MediaRecorder(this.stream, {
      mimeType: this.opts.mimeType,
      videoBitsPerSecond: this.opts.videoBps,
      audioBitsPerSecond: this.opts.audioBps,
    });
    rec.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };
    rec.onstop = () => {
      if (chunks.length === 0) return;
      this.onSegment(new Blob(chunks, { type: this.opts.mimeType }), seq, Math.round(performance.now() - startedAt));
    };
    rec.start(250);
    this.active = rec;
    // Overlap: the new recorder is already rolling before the old one stops,
    // keeping the seam between segments as small as the browser allows.
    if (prev && prev.state !== 'inactive') prev.stop();
  }
}

/**
 * Full-clarity local recording of the PROGRAM FEED only (camera stream — never
 * the screen, never the chat). Runs at ~2.5× the streaming bitrate so the
 * creator's master copy beats anything viewers saw.
 */
export class LocalRecorder {
  private rec: MediaRecorder;
  private chunks: Blob[] = [];
  bytes = 0;

  constructor(stream: MediaStream, mimeType: string, streamVideoBps: number) {
    this.rec = new MediaRecorder(stream, {
      mimeType,
      videoBitsPerSecond: Math.round(streamVideoBps * LOCAL_REC_BITRATE_FACTOR),
      audioBitsPerSecond: 192_000,
    });
    this.rec.ondataavailable = (e) => {
      if (e.data.size > 0) {
        this.chunks.push(e.data);
        this.bytes += e.data.size;
      }
    };
    this.rec.start(1000);
  }

  get state(): RecordingState {
    return this.rec.state;
  }

  pause(): void {
    if (this.rec.state === 'recording') this.rec.pause();
  }

  resume(): void {
    if (this.rec.state === 'paused') this.rec.resume();
  }

  stop(): Promise<Blob> {
    return new Promise((resolve) => {
      this.rec.onstop = () => resolve(new Blob(this.chunks, { type: this.rec.mimeType }));
      if (this.rec.state !== 'inactive') this.rec.stop();
      else resolve(new Blob(this.chunks, { type: this.rec.mimeType }));
    });
  }
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export const recordingFilename = (eventId: string, part: number, mime: string): string => {
  const ext = mime.includes('mp4') ? 'mp4' : 'webm';
  const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
  return `dreamstream-${eventId}-${stamp}${part > 1 ? `-part${part}` : ''}.${ext}`;
};
