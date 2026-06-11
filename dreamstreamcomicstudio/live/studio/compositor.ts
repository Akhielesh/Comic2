/**
 * ProgramCompositor — the studio's program mixer.
 *
 * Draws the active scene (solo camera, or screen-share with a camera PiP)
 * onto a canvas at the stream's resolution, and exposes the canvas as a
 * MediaStream (canvas.captureStream + the mic track). Because the encoder
 * records the CANVAS, scene cuts, camera switches, layouts and looks
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

export type SceneId = 'solo' | 'screen' | 'brb' | 'grid' | 'spotlight' | 'sidebar';

export interface SceneDef {
  id: SceneId;
  name: string;
  desc: string;
  hotkey: string;
}

export const SCENES: SceneDef[] = [
  { id: 'solo', name: 'Solo', desc: 'You, full frame', hotkey: '1' },
  { id: 'screen', name: 'Screen + cam', desc: 'Share with PiP camera', hotkey: '2' },
  { id: 'grid', name: 'Grid', desc: 'You + guests, equal tiles', hotkey: '3' },
  { id: 'spotlight', name: 'Spotlight', desc: 'One tile big, the rest in a strip', hotkey: '4' },
  { id: 'sidebar', name: 'Sidebar', desc: 'Content stage + people column', hotkey: '5' },
  { id: 'brb', name: 'Be right back', desc: 'Branded slate — uploads pause', hotkey: '6' },
];

/** Scenes that mix guest tiles (the meeting layouts). */
export const MULTI_SCENES: ReadonlySet<SceneId> = new Set(['grid', 'spotlight', 'sidebar']);

/** A live source drawn as a tile in the meeting layouts. */
export interface ProgramTile {
  id: string;
  label: string;
  kind: 'cam' | 'screen';
  video: HTMLVideoElement;
}

/** Beyond this aspect mismatch we letterbox instead of cropping. */
const CROP_TOLERANCE = 1.25;

/** Where the camera sits in the Screen + cam scene. */
export type PipPos = 'br' | 'bl' | 'tr' | 'tl' | 'side';
export type PipSize = 'sm' | 'md' | 'lg';
const PIP_WIDTH_FRAC: Record<PipSize, number> = { sm: 0.18, md: 0.24, lg: 0.32 };
const SIDE_WIDTH_FRAC: Record<PipSize, number> = { sm: 0.24, md: 0.3, lg: 0.36 };

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
  private pipPos: PipPos = 'br';
  private pipSize: PipSize = 'md';
  private camEnabled = true;
  private hostInitial = '·';
  private hostLabel = 'You';
  private timer: number | null = null;
  private filterSupported = true;
  private lastCamTime = -1;
  private lastScreenTime = -1;
  private dirty = true; // state changed (scene/look/zoom/cam-off) — force a draw
  private remoteTiles: ProgramTile[] = [];
  private focusId: string | null = null;
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

  /** Layout of the camera within the Screen + cam scene. */
  setPipLayout(pos: PipPos, size: PipSize): void {
    if (this.pipPos !== pos || this.pipSize !== size) {
      this.pipPos = pos;
      this.pipSize = size;
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
    this.hostLabel = name.trim() || 'You';
    this.dirty = true;
  }

  /** Guest cams/screens for the meeting layouts (grid / spotlight / sidebar). */
  setRemoteTiles(tiles: ProgramTile[]): void {
    this.remoteTiles = tiles;
    this.dirty = true;
  }

  /** Which tile the Spotlight/Sidebar scenes feature (null = auto). */
  setFocus(id: string | null): void {
    if (this.focusId !== id) {
      this.focusId = id;
      this.dirty = true;
    }
  }

  /** Everything currently drawable, host first — also drives the focus picker. */
  allTiles(): ProgramTile[] {
    const tiles: ProgramTile[] = [];
    if (this.camEnabled) tiles.push({ id: 'host-cam', label: this.hostLabel, kind: 'cam', video: this.camVideo });
    if (this.screenVideo) tiles.push({ id: 'host-screen', label: 'Your screen', kind: 'screen', video: this.screenVideo });
    return [...tiles, ...this.remoteTiles];
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
    const multi = MULTI_SCENES.has(this.scene);
    // Skip identical frames: drawing only when a source advanced keeps CPU
    // (and the encoder, which follows canvas changes) idle between frames.
    // Meeting layouts have many independent sources — they draw every tick.
    const camT = this.camVideo.currentTime;
    const scrT = this.screenVideo?.currentTime ?? -1;
    if (!multi && !this.dirty && camT === this.lastCamTime && scrT === this.lastScreenTime) return;
    this.lastCamTime = camT;
    this.lastScreenTime = scrT;
    this.dirty = false;

    const { ctx, width: w, height: h } = this;
    ctx.filter = 'none';
    ctx.fillStyle = '#17161b';
    ctx.fillRect(0, 0, w, h);

    if (multi) {
      this.drawMulti();
      return;
    }

    if (this.scene === 'screen' && this.screenVideo) {
      if (this.pipPos === 'side' && this.camEnabled && this.hasCamFrame()) {
        // Side-by-side: screen keeps the stage, camera takes a full-height column.
        const camW = Math.round(w * SIDE_WIDTH_FRAC[this.pipSize]);
        this.drawContain(this.screenVideo, 0, 0, w - camW, h);
        this.applyLook();
        this.drawSmart(this.camVideo, w - camW, 0, camW, h, true);
        ctx.filter = 'none';
        return;
      }
      this.drawContain(this.screenVideo, 0, 0, w, h);
      if (this.camEnabled && this.hasCamFrame()) {
        const pw = Math.round(w * PIP_WIDTH_FRAC[this.pipSize]);
        const ph = Math.round((pw * 10) / 16);
        const m = Math.round(w * 0.015);
        const px = this.pipPos === 'bl' || this.pipPos === 'tl' ? m : w - pw - m;
        const py = this.pipPos === 'tl' || this.pipPos === 'tr' ? m : h - ph - m;
        ctx.save();
        this.roundRectPath(px, py, pw, ph, Math.round(w * 0.008));
        ctx.clip();
        this.applyLook();
        this.drawSmart(this.camVideo, px, py, pw, ph, true);
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
      this.drawSmart(this.camVideo, 0, 0, w, h, false);
      ctx.filter = 'none';
    } else {
      this.drawCamOff();
    }
  }

  // ------------------------------------------------- meeting layouts (multi)

  /** The tile Spotlight/Sidebar feature: explicit pick → any screen → host. */
  private focusTile(tiles: ProgramTile[]): ProgramTile | null {
    if (tiles.length === 0) return null;
    const picked = this.focusId ? tiles.find((t) => t.id === this.focusId) : null;
    return picked ?? tiles.find((t) => t.kind === 'screen') ?? tiles[0];
  }

  private drawMulti(): void {
    const { ctx, width: w, height: h } = this;
    const tiles = this.allTiles();
    if (tiles.length === 0) {
      this.drawCamOff();
      return;
    }
    const gap = Math.round(Math.min(w, h) * 0.015);

    if (this.scene === 'grid' || tiles.length === 1) {
      const n = tiles.length;
      const cols = Math.ceil(Math.sqrt(n));
      const rows = Math.ceil(n / cols);
      const cw = (w - gap * (cols + 1)) / cols;
      const ch = (h - gap * (rows + 1)) / rows;
      tiles.forEach((t, i) => {
        const col = i % cols;
        const row = Math.floor(i / cols);
        // Center the last (possibly short) row, like every meeting app.
        const inRow = row === rows - 1 ? n - (rows - 1) * cols : cols;
        const xOffset = row === rows - 1 ? (w - (inRow * (cw + gap) + gap)) / 2 : 0;
        this.drawTile(t, xOffset + gap + col * (cw + gap), gap + row * (ch + gap), cw, ch);
      });
      return;
    }

    const focus = this.focusTile(tiles)!;
    const rest = tiles.filter((t) => t.id !== focus.id);

    if (this.scene === 'spotlight') {
      if (rest.length === 0) {
        this.drawTile(focus, 0, 0, w, h, true);
        return;
      }
      const stripH = Math.round(h * 0.2);
      this.drawTile(focus, 0, 0, w, h - stripH - gap, true);
      const tw = Math.min(Math.round((stripH - gap) * (16 / 10)), Math.floor((w - gap * (rest.length + 1)) / rest.length));
      const totalW = rest.length * (tw + gap) - gap;
      let x = w - totalW - gap; // right-aligned strip, the broadcast look
      for (const t of rest) {
        this.drawTile(t, x, h - stripH, tw, stripH - gap);
        x += tw + gap;
      }
      return;
    }

    // sidebar: focus owns the stage, everyone else stacks in a right column.
    const colW = Math.round(w * 0.24);
    if (rest.length === 0) {
      this.drawTile(focus, 0, 0, w, h, true);
      return;
    }
    this.drawTile(focus, gap, gap, w - colW - gap * 3, h - gap * 2, true);
    const maxRows = Math.min(rest.length, 4);
    const th = (h - gap * (maxRows + 1)) / maxRows;
    rest.slice(0, maxRows).forEach((t, i) => {
      this.drawTile(t, w - colW - gap, gap + i * (th + gap), colW, th);
    });
  }

  /** One labeled tile: cover-fit cams, letterbox screens, rounded corners. */
  private drawTile(t: ProgramTile, x: number, y: number, tw: number, th: number, stage = false): void {
    const { ctx } = this;
    if (tw <= 4 || th <= 4) return;
    const r = Math.round(Math.min(this.width, this.height) * 0.012);
    ctx.save();
    this.roundRectPath(x, y, tw, th, r);
    ctx.clip();
    ctx.fillStyle = '#211f26';
    ctx.fillRect(x, y, tw, th);
    const hasFrame = t.video.videoWidth > 0;
    if (hasFrame) {
      if (t.id === 'host-cam') this.applyLook();
      if (t.kind === 'screen') this.drawContain(t.video, x, y, tw, th);
      else this.drawSmart(t.video, x, y, tw, th, true);
      ctx.filter = 'none';
    } else {
      // No frames yet (connecting / cam off) — initial avatar placeholder.
      const rr = Math.round(Math.min(tw, th) * 0.18);
      ctx.beginPath();
      ctx.arc(x + tw / 2, y + th / 2, rr, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,255,255,0.12)';
      ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.8)';
      ctx.font = `600 ${rr}px Georgia, serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText((t.label[0] || '·').toUpperCase(), x + tw / 2, y + th / 2);
    }
    this.drawTileLabel(t.label, x, y, tw, th, stage);
    ctx.restore();
    ctx.filter = 'none';
    ctx.strokeStyle = 'rgba(255,255,255,0.16)';
    ctx.lineWidth = Math.max(1, this.width / 960);
    this.roundRectPath(x, y, tw, th, r);
    ctx.stroke();
  }

  private drawTileLabel(label: string, x: number, y: number, tw: number, th: number, stage: boolean): void {
    const { ctx } = this;
    const fs = Math.max(10, Math.round(Math.min(this.width, this.height) * (stage ? 0.024 : 0.02)));
    if (th < fs * 3.4 || tw < fs * 4) return; // tiny strip tiles skip the chip
    ctx.font = `500 ${fs}px 'Hanken Grotesk', sans-serif`;
    const text = label.slice(0, 24);
    const padX = Math.round(fs * 0.6);
    const tw2 = Math.min(ctx.measureText(text).width + padX * 2, tw - padX * 2);
    const lh = Math.round(fs * 1.7);
    const lx = x + padX;
    const ly = y + th - lh - padX;
    ctx.fillStyle = 'rgba(10,9,12,0.55)';
    this.roundRectPath(lx, ly, tw2, lh, Math.round(lh / 2));
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.92)';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, lx + padX, ly + lh / 2 + 0.5, tw2 - padX * 2);
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
   * must never become a 2× face crop. (Zoom is the camera's own native zoom,
   * applied on the track — never synthesized here.)
   */
  private drawSmart(video: HTMLVideoElement, dx: number, dy: number, dw: number, dh: number, alwaysCover: boolean): void {
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh) return;
    const mismatch = Math.max((vw / vh) / (dw / dh), (dw / dh) / (vw / vh));
    if (alwaysCover || mismatch <= CROP_TOLERANCE) {
      const scale = Math.max(dw / vw, dh / vh);
      const sw = dw / scale;
      const sh = dh / scale;
      this.ctx.drawImage(video, (vw - sw) / 2, (vh - sh) / 2, sw, sh, dx, dy, dw, dh);
    } else {
      this.drawContain(video, dx, dy, dw, dh);
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
