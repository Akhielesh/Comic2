// Motion comic export — a "guided view" video of the comic for TikTok / Reels / Shorts.
//
// The camera opens on the cover, then for every drawn page shows the whole page for a
// beat and glides panel to panel (using the vision pass's measured panel boxes when
// available), popping each balloon in at reading speed, with a slow Ken Burns push on
// every shot, and ends on a "Made with DreamStream" card. Everything runs in the
// browser at no cost. Frames are a pure function of time (`drawFrame(ms)`), encoded
// frame-by-frame with WebCodecs + mediabunny (MPL-2.0, unmodified) into MP4/H.264 —
// faster than real time, identical on every run, fine in a background tab. Browsers
// without WebCodecs fall back to recording the canvas in real time with MediaRecorder.
// The timeline and camera math are pure (unit-tested); only the exporter touches the DOM.

import type { Box, ComicDoc, LineKind, Page } from '../../../shared/comic/doc';
import { downloadBlob } from '../../../services/download';
import { panelBoxesFor } from '../board/pageLayout';
import { drawCanvasBalloons, ensureLetteringFonts, ExportError, fontFor, loadExportImage, planCanvasBalloons, type LoadedImage } from './rasterize';
import { exportFileStem, type ExportProgress, type UrlFor } from './zipExport';

export type MotionAspect = '9:16' | '1:1' | '16:9';

export const MOTION_SIZES: Record<MotionAspect, { width: number; height: number }> = {
  '9:16': { width: 1080, height: 1920 },
  '1:1': { width: 1080, height: 1080 },
  '16:9': { width: 1920, height: 1080 }
};

export interface MotionShot {
  kind: 'cover' | 'page' | 'panel' | 'outro';
  pageId?: string;
  panelN?: number;
  /** Page-normalized region the camera frames (whole page for cover/page shots). */
  box: Box;
  startMs: number;
  durationMs: number;
  /** Balloons on screen during this shot, in reveal order, with their reveal offset (ms into the shot). */
  reveals: { lineId: string; atMs: number }[];
  /** Balloons already revealed by earlier shots on the same page (stay visible). */
  carried: string[];
}

export interface MotionTimeline {
  shots: MotionShot[];
  totalMs: number;
}

export interface TimelineOptions {
  /** Minimum time on a panel. */
  minPanelMs?: number;
  maxPanelMs?: number;
  /** Lettering read speed. */
  wordsPerMinute?: number;
  pageOverviewMs?: number;
  coverMs?: number;
  outroMs?: number;
}

const FULL: Box = { x: 0, y: 0, w: 1, h: 1 };
const words = (text: string) => (text.match(/\S+/g) || []).length;

/** How long a reader needs for a line (ms), never under a beat. */
export const readMs = (text: string, wpm = 210): number => Math.max(650, Math.round((words(text) * 60_000) / wpm));

/**
 * The shot list. Overlay-lettered pages reveal their balloons panel by panel; in-art
 * pages (text is part of the drawing) simply hold each panel long enough to read.
 */
export function buildMotionTimeline(doc: ComicDoc, opts: TimelineOptions = {}): MotionTimeline {
  const minPanel = opts.minPanelMs ?? 1800;
  const maxPanel = opts.maxPanelMs ?? 7500;
  const wpm = opts.wordsPerMinute ?? 210;
  const overview = opts.pageOverviewMs ?? 1300;
  const shots: MotionShot[] = [];
  let t = 0;
  const push = (shot: Omit<MotionShot, 'startMs'>) => {
    shots.push({ ...shot, startMs: t });
    t += shot.durationMs;
  };

  if (doc.cover.render.asset?.path) push({ kind: 'cover', box: FULL, durationMs: opts.coverMs ?? 2600, reveals: [], carried: [] });

  const overlay = doc.format.lettering === 'overlay';
  for (const page of [...doc.pages].sort((a, b) => a.n - b.n)) {
    if (page.render.status !== 'ready' || !page.render.asset?.path) continue;
    push({ kind: 'page', pageId: page.id, box: FULL, durationMs: overview, reveals: [], carried: [] });
    const boxes = panelBoxesFor(doc, page);
    const carried: string[] = [];
    page.panels.forEach((panel, i) => {
      const box = boxes[i] || FULL;
      const lines = panel.lines.filter((l) => l.text.trim());
      let at = 450; // let the camera settle first
      const reveals = overlay
        ? lines.map((l) => {
            const reveal = { lineId: l.id, atMs: at };
            at += readMs(l.text, wpm);
            return reveal;
          })
        : [];
      const reading = lines.reduce((ms, l) => ms + readMs(l.text, wpm), 0);
      const durationMs = Math.min(maxPanel, Math.max(minPanel, 450 + reading + 500));
      push({ kind: 'panel', pageId: page.id, panelN: panel.n, box, durationMs, reveals, carried: [...carried] });
      carried.push(...reveals.map((r) => r.lineId));
    });
  }

  push({ kind: 'outro', box: FULL, durationMs: opts.outroMs ?? 2200, reveals: [], carried: [] });
  return { shots, totalMs: t };
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Source rectangle (page px) that frames `box` at the output aspect, with breathing room.
 * The frame is expanded (never cropped tighter) to match the output aspect, and kept on
 * the page where it fits.
 */
export function cameraRect(box: Box, pageW: number, pageH: number, outAspect: number, pad = 0.06): Rect {
  let w = box.w * pageW * (1 + 2 * pad);
  let h = box.h * pageH * (1 + 2 * pad);
  const cx = (box.x + box.w / 2) * pageW;
  const cy = (box.y + box.h / 2) * pageH;
  if (w / h > outAspect) h = w / outAspect;
  else w = h * outAspect;
  let x = cx - w / 2;
  let y = cy - h / 2;
  // Keep the frame on the page when it can fit; otherwise centre it (the rest is background).
  if (w <= pageW) x = Math.min(Math.max(0, x), pageW - w);
  else x = (pageW - w) / 2;
  if (h <= pageH) y = Math.min(Math.max(0, y), pageH - h);
  else y = (pageH - h) / 2;
  return { x, y, w, h };
}

export const lerpRect = (a: Rect, b: Rect, t: number): Rect => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
  w: a.w + (b.w - a.w) * t,
  h: a.h + (b.h - a.h) * t
});

/** Slow push-in: shrink the frame around its centre by up to `amount` over the shot. */
export const kenBurns = (r: Rect, progress: number, amount = 0.05): Rect => {
  const s = 1 - amount * Math.min(1, Math.max(0, progress));
  const w = r.w * s;
  const h = r.h * s;
  return { x: r.x + (r.w - w) / 2, y: r.y + (r.h - h) / 2, w, h };
};

export const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

/** Best recording container this browser supports (MP4 first: it plays everywhere social). */
export const pickRecorderMime = (isSupported: (mime: string) => boolean): { mime: string; ext: 'mp4' | 'webm' } | null => {
  const candidates: { mime: string; ext: 'mp4' | 'webm' }[] = [
    { mime: 'video/mp4;codecs=avc1.640028', ext: 'mp4' },
    { mime: 'video/mp4;codecs=avc1', ext: 'mp4' },
    { mime: 'video/mp4', ext: 'mp4' },
    { mime: 'video/webm;codecs=vp9', ext: 'webm' },
    { mime: 'video/webm;codecs=vp8', ext: 'webm' },
    { mime: 'video/webm', ext: 'webm' }
  ];
  return candidates.find((c) => {
    try {
      return isSupported(c.mime);
    } catch {
      return false;
    }
  }) || null;
};

// ── Rendering (browser) ──────────────────────────────────────────────────────

export interface MotionExportOptions {
  aspect?: MotionAspect;
  onProgress?: (progress: ExportProgress) => void;
  signal?: AbortSignal;
  download?: (blob: Blob, fileName: string) => void;
  timeline?: TimelineOptions;
}

export interface MotionExportResult {
  fileName: string;
  durationMs: number;
  mimeType: string;
  skipped: string[];
  /** webcodecs = deterministic offline encode; realtime = MediaRecorder fallback. */
  engine: 'webcodecs' | 'realtime';
}

export const MOTION_FPS = 30;

const BG = '#0f0e0c';
const ACCENT = '#D97757';

/** Draw `text` centred, wrapped to `maxW`, starting at `y`; returns the y after the block. */
const centeredText = (ctx: CanvasRenderingContext2D, text: string, cx: number, y: number, maxW: number, lineH: number): number => {
  const out: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${word}` : word;
    if (ctx.measureText(next).width > maxW && line) {
      out.push(line);
      line = word;
    } else line = next;
  }
  if (line) out.push(line);
  out.forEach((l, i) => ctx.fillText(l, cx, y + i * lineH));
  return y + out.length * lineH;
};

export async function exportMotionComic(doc: ComicDoc, urlFor: UrlFor, opts: MotionExportOptions = {}): Promise<MotionExportResult> {
  if (typeof document === 'undefined') throw new ExportError('Video export runs in the browser.');
  const size = MOTION_SIZES[opts.aspect || '9:16'];
  const canvas = document.createElement('canvas');
  canvas.width = size.width;
  canvas.height = size.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new ExportError('This browser can’t draw video frames.');

  const timeline = buildMotionTimeline(doc, opts.timeline);
  const pageShots = timeline.shots.filter((s) => s.kind === 'page');
  if (!pageShots.length) throw new ExportError('Nothing to animate yet — draw at least one page first.');

  // Load art up front (bounded by the comic's size; pages are reused across shots).
  const skipped: string[] = [];
  const images = new Map<string, LoadedImage>();
  const load = async (key: string, url?: string) => {
    if (!url) return;
    try {
      images.set(key, await loadExportImage(url, opts.signal));
    } catch (err) {
      if (opts.signal?.aborted) throw new ExportError('Export cancelled.');
      skipped.push(`${key === 'cover' ? 'Cover' : `Page ${doc.pages.find((p) => p.id === key)?.n ?? '?'}`} (${(err as Error).message})`);
    }
  };
  try {
    opts.onProgress?.({ done: 0, total: 1, label: 'Loading pages…' });
    await load('cover', doc.cover.render.asset ? urlFor(doc.cover.render.asset) : undefined);
    for (const shot of pageShots) {
      const page = doc.pages.find((p) => p.id === shot.pageId)!;
      await load(page.id, urlFor(page.render.asset));
    }
    await ensureLetteringFonts();
    const drawFrame = createFrameDrawer(doc, timeline, images, ctx, size);
    const stem = `${exportFileStem(doc)}-motion-${(opts.aspect || '9:16').replace(':', 'x')}`;

    const encoded = (await encodeWithWebCodecs(canvas, drawFrame, timeline.totalMs, opts)) || (await recordRealtime(canvas, drawFrame, timeline.totalMs, opts));
    if (!encoded.blob.size) throw new ExportError('The video came out empty. Try again.');
    const fileName = `${stem}.${encoded.ext}`;
    (opts.download || downloadBlob)(encoded.blob, fileName);
    opts.onProgress?.({ done: timeline.totalMs, total: timeline.totalMs, label: 'Done' });
    return { fileName, durationMs: timeline.totalMs, mimeType: encoded.blob.type, skipped, engine: encoded.engine };
  } finally {
    images.forEach((img) => img.release());
  }
}

interface Encoded {
  blob: Blob;
  ext: 'mp4' | 'webm';
  engine: MotionExportResult['engine'];
}

/** Frame renderer: a pure function of time over the loaded art. */
function createFrameDrawer(
  doc: ComicDoc,
  timeline: MotionTimeline,
  images: Map<string, LoadedImage>,
  ctx: CanvasRenderingContext2D,
  size: { width: number; height: number }
): (ms: number) => void {
  // A lettered copy of each page per revealed-balloon set (only rebuilt when it changes).
  const lettered = new Map<string, { key: string; canvas: HTMLCanvasElement }>();
  const letteredPage = (page: Page, visible: Set<string>): CanvasImageSource | undefined => {
    const art = images.get(page.id);
    if (!art) return undefined;
    if (doc.format.lettering !== 'overlay' || !visible.size) return art.source;
    const key = [...visible].sort().join('|');
    const cached = lettered.get(page.id);
    if (cached?.key === key) return cached.canvas;
    const c = cached?.canvas || document.createElement('canvas');
    c.width = art.width;
    c.height = art.height;
    const cx = c.getContext('2d')!;
    cx.drawImage(art.source, 0, 0);
    const measure = (text: string, fontPx: number, kind: LineKind) => {
      cx.font = fontFor(kind, fontPx);
      return cx.measureText(text).width;
    };
    drawCanvasBalloons(cx, planCanvasBalloons(doc, page, art.width, art.height, measure).filter((p) => visible.has(p.lineId)));
    lettered.set(page.id, { key, canvas: c });
    return c;
  };

  const outAspect = size.width / size.height;
  const rectFor = (shot: MotionShot): Rect | null => {
    const key = shot.kind === 'cover' ? 'cover' : shot.pageId;
    const img = key ? images.get(key) : undefined;
    if (!img) return null;
    return cameraRect(shot.box, img.width, img.height, outAspect, shot.kind === 'panel' ? 0.06 : 0.02);
  };

  return (ms: number) => {
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, size.width, size.height);
    const i = timeline.shots.findIndex((s) => ms >= s.startMs && ms < s.startMs + s.durationMs);
    const index = i === -1 ? timeline.shots.length - 1 : i;
    const shot = timeline.shots[index];
    const local = ms - shot.startMs;
    const progress = local / shot.durationMs;

    if (shot.kind === 'outro') {
      ctx.textAlign = 'center';
      ctx.fillStyle = '#f4f1ea';
      ctx.font = `700 ${Math.round(size.width * 0.07)}px "Bangers", Impact, sans-serif`;
      const end = centeredText(ctx, doc.brief.title || 'Untitled comic', size.width / 2, size.height * 0.42, size.width * 0.84, size.width * 0.08);
      ctx.fillStyle = ACCENT;
      ctx.font = `600 ${Math.round(size.width * 0.032)}px Inter, system-ui, sans-serif`;
      ctx.fillText('Made with DreamStream Comic Studio', size.width / 2, end + size.width * 0.05);
      ctx.fillStyle = 'rgba(244,241,234,0.6)';
      ctx.font = `500 ${Math.round(size.width * 0.026)}px Inter, system-ui, sans-serif`;
      ctx.fillText('dreamstreamstudio.ai', size.width / 2, end + size.width * 0.1);
      return;
    }

    const key = shot.kind === 'cover' ? 'cover' : shot.pageId!;
    const page = shot.pageId ? doc.pages.find((p) => p.id === shot.pageId) : undefined;
    const visible = new Set<string>(shot.carried);
    shot.reveals.forEach((r) => local >= r.atMs && visible.add(r.lineId));
    const source = shot.kind === 'cover' ? images.get('cover')?.source : page ? letteredPage(page, visible) : undefined;
    const target = rectFor(shot);
    if (!source || !target) return;

    // Glide from the previous shot's frame on the same image, then push in slowly.
    const prev = timeline.shots[index - 1];
    const prevKey = prev ? (prev.kind === 'cover' ? 'cover' : prev.pageId) : undefined;
    const prevRect = prev && prevKey === key ? rectFor(prev) : null;
    const glide = Math.min(1, local / 450);
    let rect = prevRect ? lerpRect(kenBurns(prevRect, 1, 0.04), target, easeInOut(glide)) : target;
    rect = kenBurns(rect, progress, shot.kind === 'panel' ? 0.04 : 0.025);
    ctx.drawImage(source, rect.x, rect.y, rect.w, rect.h, 0, 0, size.width, size.height);

    // Fade in when the image changes (page turn / cover → page 1).
    if (!prevRect && local < 350) {
      ctx.fillStyle = `rgba(15,14,12,${1 - local / 350})`;
      ctx.fillRect(0, 0, size.width, size.height);
    }
  };
}

/** Offline, deterministic encode (WebCodecs + mediabunny). Null when the browser can't. */
async function encodeWithWebCodecs(
  canvas: HTMLCanvasElement,
  drawFrame: (ms: number) => void,
  totalMs: number,
  opts: MotionExportOptions
): Promise<Encoded | null> {
  if (typeof VideoEncoder === 'undefined') return null;
  const mb = await import('mediabunny');
  const codec = await mb.getFirstEncodableVideoCodec(['avc', 'vp9', 'av1'], { width: canvas.width, height: canvas.height, quality: mb.QUALITY_HIGH });
  if (!codec) return null;
  const mp4 = codec === 'avc';
  const target = new mb.BufferTarget();
  const output = new mb.Output({ format: mp4 ? new mb.Mp4OutputFormat({ fastStart: 'in-memory' }) : new mb.WebMOutputFormat(), target });
  const source = new mb.CanvasSource(canvas, { codec, quality: mb.QUALITY_HIGH, keyFrameInterval: 2 });
  output.addVideoTrack(source, { frameRate: MOTION_FPS });
  await output.start();
  const frames = Math.max(1, Math.ceil((totalMs / 1000) * MOTION_FPS));
  try {
    for (let f = 0; f < frames; f += 1) {
      if (opts.signal?.aborted) throw new ExportError('Export cancelled.');
      drawFrame((f * 1000) / MOTION_FPS);
      await source.add(f / MOTION_FPS, 1 / MOTION_FPS);
      if (f % 15 === 0) opts.onProgress?.({ done: f, total: frames, label: `Rendering video… ${Math.round((f / frames) * 100)}%` });
    }
    await output.finalize();
  } catch (err) {
    await output.cancel().catch(() => undefined);
    throw err;
  }
  if (!target.buffer) return null;
  return { blob: new Blob([target.buffer], { type: mp4 ? 'video/mp4' : 'video/webm' }), ext: mp4 ? 'mp4' : 'webm', engine: 'webcodecs' };
}

/** Real-time fallback: animate the canvas and record it with MediaRecorder. */
async function recordRealtime(
  canvas: HTMLCanvasElement,
  drawFrame: (ms: number) => void,
  totalMs: number,
  opts: MotionExportOptions
): Promise<Encoded> {
  const capture = (canvas as HTMLCanvasElement & { captureStream?: (fps?: number) => MediaStream }).captureStream;
  if (typeof MediaRecorder === 'undefined' || typeof capture !== 'function') {
    throw new ExportError('This browser can’t record video. Try Chrome, Edge or Safari 17+.');
  }
  const format = pickRecorderMime((m) => MediaRecorder.isTypeSupported(m));
  if (!format) throw new ExportError('This browser can’t record MP4 or WebM video.');
  const stream = capture.call(canvas, MOTION_FPS);
  const recorder = new MediaRecorder(stream, { mimeType: format.mime, videoBitsPerSecond: 8_000_000 });
  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const stopped = new Promise<void>((resolve) => (recorder.onstop = () => resolve()));
  drawFrame(0);
  recorder.start(1000);
  const startedAt = performance.now();
  try {
    await new Promise<void>((resolve, reject) => {
      const tick = () => {
        if (opts.signal?.aborted) return reject(new ExportError('Export cancelled.'));
        const ms = performance.now() - startedAt;
        drawFrame(Math.min(ms, totalMs - 1));
        opts.onProgress?.({ done: Math.min(ms, totalMs), total: totalMs, label: `Recording… ${Math.round((ms / totalMs) * 100)}% (keep this tab open)` });
        if (ms >= totalMs) resolve();
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  } finally {
    if (recorder.state !== 'inactive') recorder.stop();
    stream.getTracks().forEach((t) => t.stop());
  }
  await stopped;
  return { blob: new Blob(chunks, { type: format.mime.split(';')[0] }), ext: format.ext, engine: 'realtime' };
}
