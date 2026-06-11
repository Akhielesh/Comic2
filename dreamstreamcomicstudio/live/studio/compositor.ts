/**
 * ProgramCompositor — the studio's program mixer.
 *
 * Draws the active scene (solo camera, or screen-share with a camera PiP)
 * onto a canvas at the stream's resolution, and exposes the canvas as a
 * MediaStream (canvas.captureStream + the mic track). Because the encoder
 * records the CANVAS, scene cuts, camera switches, digital zoom and looks
 * are all seamless — the MediaRecorder never has to restart, exactly like a
 * hardware vision mixer feeding one encoder.
 *
 * Performance: the draw loop skips frames whose source hasn't advanced
 * (canvas.captureStream only emits on canvas change, so identical frames cost
 * neither draw nor encode), and the 2D context is opaque + desynchronized.
 *
 * Aspect handling: the canvas is sized to the CAMERA's orientation (a phone
 * held upright streams portrait, not a brutal crop of landscape), and any
 * source whose aspect differs badly from the canvas letterboxes instead of
 * cropping — fixing the "mobile camera looks zoomed in" failure mode.
 */

import type { CameraLook } from '../prefs';
import { LOOK_FILTERS } from '../prefs';

export type SceneId = 'solo' | 'screen' | 'brb';

export interface SceneDef {
  id: SceneId;
  name: string;
  desc: string;
  hotkey: string;
}

export const SCENES: SceneDef[] = [
  { id: 'solo', name: 'Solo', desc: 'You, full frame', hotkey: '1' },
  { id: 'screen', name: 'Screen + cam', desc: 'Share with PiP camera', hotkey: '2' },
  { id: 'brb', name: 'Be right back', desc: 'Branded slate — uploads pause', hotkey: '3' },
];

/** Beyond this aspect mismatch we letterbox instead of cropping. */
const CROP_TOLERANCE = 1.25;

/**
 * Canvas dimensions for a given camera: follow the source's orientation and
 * aspect, capped by the preset's pixel budget (longest edge). Even numbers —
 * encoders dislike odd dimensions.
 */
export function fitCanvasToSource(srcW: number, srcH: number, presetW: number, presetH: number): { w: number; h: number } {
  if (!srcW || !srcH) return { w: presetW, h: presetH };
  const longBudget = Math.max(presetW, presetH);
  const shortBudget = Math.min(presetW, presetH);
  const portrait = srcH > srcW;
  const srcLong = Math.max(srcW, srcH);
  const srcShort = Math.min(srcW, srcH);
  const scale = Math.min(1, longBudget / srcLong, shortBudget / srcShort);
  const even = (n: number) => Math.max(2, Math.round((n * scale) / 2) * 2);
  const long = even(srcLong);
  const short = even(srcShort);
  return portrait ? { w: short, h: long } : { w: long, h: short };
}

export class ProgramCompositor {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private camVideo: HTMLVideoElement;
  private screenVideo: HTMLVideoElement | null = null;
  private screenStream: MediaStream | null = null;
  private scene: SceneId = 'solo';
  private look: CameraLook = 'none';
  private digitalZoom = 1;
  private camEnabled = true;
  private hostInitial = '·';
  private timer: number | null = null;
  private filterSupported = true;
  private lastCamTime = -1;
  private lastScreenTime = -1;
  private dirty = true; // state changed (scene/look/zoom/cam-off) — force a draw
  /** Fires when the user stops a screen share from the browser UI. */
  onScreenEnded: (() => void) | null = null;

  constructor(
    private width: number,
    private height: number,
    private fps: number,
  ) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = width;
    this.canvas.height = height;
    const ctx = this.canvas.getContext('2d', { alpha: false, desynchronized: true });
    if (!ctx) throw new Error('canvas 2d unavailable');
    this.ctx = ctx;
    this.camVideo = document.createElement('video');
    this.camVideo.muted = true;
    this.camVideo.playsInline = true;
  }

  /** Resize the program before going live (e.g. once the camera reports its
   *  real dimensions). Mid-stream resizes are avoided — encoders glitch. */
  resize(w: number, h: number): void {
    if (w === this.width && h === this.height) return;
    this.width = w;
    this.height = h;
    this.canvas.width = w;
    this.canvas.height = h;
    this.dirty = true;
  }

  get size(): { w: number; h: number } {
    return { w: this.width, h: this.height };
  }

  /** Canvas video track + the given mic track = the stream the encoder gets. */
  buildOutput(micTrack: MediaStreamTrack | null): MediaStream {
    const canvasStream = this.canvas.captureStream(this.fps);
    const out = new MediaStream(canvasStream.getVideoTracks());
    if (micTrack) out.addTrack(micTrack);
    return out;
  }

  setCamera(stream: MediaStream | null): void {
    if (this.camVideo.srcObject !== stream) {
      this.camVideo.srcObject = stream;
      this.lastCamTime = -1;
      this.dirty = true;
      if (stream) this.camVideo.play().catch(() => undefined);
    }
  }

  async startScreenShare(): Promise<boolean> {
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      this.stopScreenShare();
      this.screenStream = stream;
      const v = document.createElement('video');
      v.muted = true;
      v.playsInline = true;
      v.srcObject = stream;
      await v.play().catch(() => undefined);
      this.screenVideo = v;
      this.lastScreenTime = -1;
      this.dirty = true;
      stream.getVideoTracks()[0]?.addEventListener('ended', () => {
        this.stopScreenShare();
        this.onScreenEnded?.();
      });
      return true;
    } catch {
      return false; // user dismissed the picker
    }
  }

  stopScreenShare(): void {
    this.screenStream?.getTracks().forEach((t) => t.stop());
    this.screenStream = null;
    this.screenVideo = null;
    this.dirty = true;
  }

  get screenActive(): boolean {
    return !!this.screenVideo;
  }

  setScene(s: SceneId): void {
    if (this.scene !== s) {
      this.scene = s;
      this.dirty = true;
    }
  }

  setLook(l: CameraLook): void {
    if (this.look !== l) {
      this.look = l;
      this.dirty = true;
    }
  }

  /** Burned-in digital zoom — used when the camera has no hardware zoom. */
  setDigitalZoom(z: number): void {
    const next = Math.max(1, z);
    if (this.digitalZoom !== next) {
      this.digitalZoom = next;
      this.dirty = true;
    }
  }

  setCamEnabled(on: boolean): void {
    if (this.camEnabled !== on) {
      this.camEnabled = on;
      this.dirty = true;
    }
  }

  setHostInitial(name: string): void {
    this.hostInitial = (name.trim()[0] || '·').toUpperCase();
    this.dirty = true;
  }

  start(): void {
    if (this.timer != null) return;
    // setInterval (not rAF) so the program keeps rendering ~1 fps even when
    // the tab is backgrounded — the stream stays alive, just low-motion.
    this.timer = window.setInterval(() => this.draw(), Math.round(1000 / this.fps));
  }

  stop(): void {
    if (this.timer != null) window.clearInterval(this.timer);
    this.timer = null;
    this.stopScreenShare();
    this.camVideo.srcObject = null;
  }

  // ------------------------------------------------------------------ draw

  private draw(): void {
    // Skip identical frames: drawing only when a source advanced keeps CPU
    // (and the encoder, which follows canvas changes) idle between frames.
    const camT = this.camVideo.currentTime;
    const scrT = this.screenVideo?.currentTime ?? -1;
    if (!this.dirty && camT === this.lastCamTime && scrT === this.lastScreenTime) return;
    this.lastCamTime = camT;
    this.lastScreenTime = scrT;
    this.dirty = false;

    const { ctx, width: w, height: h } = this;
    ctx.filter = 'none';
    ctx.fillStyle = '#17161b';
    ctx.fillRect(0, 0, w, h);

    if (this.scene === 'screen' && this.screenVideo) {
      this.drawContain(this.screenVideo, 0, 0, w, h);
      if (this.camEnabled && this.hasCamFrame()) {
        const pw = Math.round(w * 0.24);
        const ph = Math.round((pw * 10) / 16);
        const px = w - pw - Math.round(w * 0.015);
        const py = h - ph - Math.round(w * 0.015);
        ctx.save();
        this.roundRectPath(px, py, pw, ph, Math.round(w * 0.008));
        ctx.clip();
        this.applyLook();
        this.drawSmart(this.camVideo, px, py, pw, ph, this.digitalZoom, true);
        ctx.restore();
        ctx.filter = 'none';
        ctx.strokeStyle = 'rgba(255,255,255,0.25)';
        ctx.lineWidth = Math.max(1, w / 640);
        this.roundRectPath(px, py, pw, ph, Math.round(w * 0.008));
        ctx.stroke();
      }
      return;
    }

    // solo (and brb — uploads are paused, but keep the preview honest)
    if (this.camEnabled && this.hasCamFrame()) {
      this.applyLook();
      this.drawSmart(this.camVideo, 0, 0, w, h, this.digitalZoom, false);
      ctx.filter = 'none';
    } else {
      this.drawCamOff();
    }
  }

  private hasCamFrame(): boolean {
    return !!this.camVideo.srcObject && this.camVideo.videoWidth > 0;
  }

  private applyLook(): void {
    if (!this.filterSupported) return;
    try {
      this.ctx.filter = LOOK_FILTERS[this.look] || 'none';
    } catch {
      this.filterSupported = false;
    }
  }

  /**
   * Crop-guarded draw: cover-fit when the aspects roughly agree (≤25% crop),
   * letterbox when they don't — a portrait phone camera in a landscape frame
   * must never become a 2× face crop. Digital zoom shrinks the source rect
   * in either mode, so it stays a real zoom.
   */
  private drawSmart(video: HTMLVideoElement, dx: number, dy: number, dw: number, dh: number, zoom: number, alwaysCover: boolean): void {
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh) return;
    const mismatch = Math.max((vw / vh) / (dw / dh), (dw / dh) / (vw / vh));
    if (alwaysCover || mismatch <= CROP_TOLERANCE) {
      const scale = Math.max(dw / vw, dh / vh) * zoom;
      const sw = dw / scale;
      const sh = dh / scale;
      this.ctx.drawImage(video, (vw - sw) / 2, (vh - sh) / 2, sw, sh, dx, dy, dw, dh);
    } else {
      // Letterbox/pillarbox, zoom still crops into the source.
      const sw = vw / zoom;
      const sh = vh / zoom;
      const scale = Math.min(dw / sw, dh / sh);
      const w = sw * scale;
      const h = sh * scale;
      this.ctx.drawImage(video, (vw - sw) / 2, (vh - sh) / 2, sw, sh, dx + (dw - w) / 2, dy + (dh - h) / 2, w, h);
    }
  }

  private drawContain(video: HTMLVideoElement, dx: number, dy: number, dw: number, dh: number): void {
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh) return;
    const scale = Math.min(dw / vw, dh / vh);
    const w = vw * scale;
    const h = vh * scale;
    this.ctx.drawImage(video, dx + (dw - w) / 2, dy + (dh - h) / 2, w, h);
  }

  private drawCamOff(): void {
    const { ctx, width: w, height: h } = this;
    const grad = ctx.createLinearGradient(0, 0, w, h);
    grad.addColorStop(0, '#2c2a33');
    grad.addColorStop(1, '#1b1a20');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);
    const r = Math.round(Math.min(w, h) * 0.13);
    ctx.beginPath();
    ctx.arc(w / 2, h / 2 - r * 0.4, r, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.82)';
    ctx.font = `600 ${Math.round(r)}px Georgia, serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(this.hostInitial, w / 2, h / 2 - r * 0.4);
    ctx.font = `500 ${Math.round(Math.min(w, h) * 0.045)}px sans-serif`;
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.fillText('Camera is off', w / 2, h / 2 + r * 1.4);
  }

  private roundRectPath(x: number, y: number, w: number, h: number, r: number): void {
    const { ctx } = this;
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
}
