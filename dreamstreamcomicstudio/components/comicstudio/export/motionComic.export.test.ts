// AV-0 (av.md F10, F9): the motion-comic export end to end on fakes — a fake WebCodecs encoder (mediabunny), fake
// art and a recording canvas. Each export sends exactly ONE telemetry event (done, failed or cancelled) with counts
// and enums only, schedules no timer of its own, and paints the frame with the reader-room token. One case leaves the
// telemetry queue real (only apiClient is faked) to prove the whole path to /api: one POST, 8 s after the export, then
// silence (the container can sleep).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyRender, type ComicDoc } from '../../../shared/comic/doc';
import { makeSampleDoc } from '../board/__fixtures__/sampleDoc';
import { fakeContext, type FakeCtx } from './__fixtures__/fakeCanvas';
import type { UrlFor } from './sequence';

const tel = vi.hoisted(() => ({ captureEvent: vi.fn() }));
vi.mock('../../../services/telemetry', () => tel);
// The only network the telemetry queue has; the export path imports nothing else from apiClient.
const api = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock('../../../services/apiClient', () => api);

const art = vi.hoisted(() => ({ fail: new Set<string>(), released: 0 }));
vi.mock('./rasterize', async (orig) => ({
  ...(await orig<typeof import('./rasterize')>()),
  loadExportImage: async (url: string) => {
    if (art.fail.has(url)) throw new Error(`could not load ${url}`);
    return { source: { label: url } as unknown as CanvasImageSource, width: 800, height: 1200, release: () => (art.released += 1) };
  }
}));

const enc = vi.hoisted(() => ({ frames: 0, onFrame: undefined as undefined | ((f: number) => void) }));
vi.mock('mediabunny', () => {
  class BufferTarget {
    buffer: ArrayBuffer | null = null;
  }
  class Output {
    target: BufferTarget;
    constructor(o: { target: BufferTarget }) {
      this.target = o.target;
    }
    addVideoTrack() {}
    async start() {}
    async finalize() {
      this.target.buffer = new ArrayBuffer(64);
    }
    async cancel() {}
  }
  class CanvasSource {
    async add() {
      enc.frames += 1;
      enc.onFrame?.(enc.frames);
    }
  }
  class Mp4OutputFormat {}
  class WebMOutputFormat {}
  return { BufferTarget, Output, CanvasSource, Mp4OutputFormat, WebMOutputFormat, QUALITY_HIGH: 1, getFirstEncodableVideoCodec: async () => 'avc' };
});

const { exportMotionComic, MOTION_EXPORT_EVENT } = await import('./motionComic');

/** A small drawn comic: no cover, two drawn pages (in-art lettering, so frames draw only art). */
const SECRET_TITLE = 'Secret Title Of The Saffron Thief';
const SECRET_LINE = 'Arjun whispers the vault code 4417';
const smallDoc = (mutate?: (d: ComicDoc) => void): ComicDoc =>
  makeSampleDoc((d) => {
    d.format = { ...d.format, lettering: 'in_art' };
    d.brief = { ...d.brief, title: SECRET_TITLE };
    d.cover = { ...d.cover, title: SECRET_TITLE, render: emptyRender() };
    d.pages = d.pages.slice(0, 2).map((p) => ({
      ...p,
      panels: p.panels.map((panel) => ({ ...panel, lines: panel.lines.map((l) => ({ ...l, text: SECRET_LINE })) })),
      render: { ...emptyRender(), status: 'ready', asset: { path: `u/secret/${p.id}.webp`, source: 'generated', at: 1 } }
    }));
    mutate?.(d);
  });
const urlFor: UrlFor = (a) => {
  const path = typeof a === 'string' ? a : a?.path;
  return path ? `https://cdn.test/${path}` : undefined;
};

let canvases: FakeCtx[];
beforeEach(() => {
  canvases = [];
  tel.captureEvent.mockReset();
  api.post.mockReset();
  art.fail.clear();
  art.released = 0;
  enc.frames = 0;
  enc.onFrame = undefined;
  vi.stubGlobal('VideoEncoder', class {});
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
    const f = fakeContext(this.width, this.height);
    canvases.push(f);
    return f.ctx as never;
  } as never);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.documentElement.style.removeProperty('--ds-reader-room');
  document.documentElement.style.removeProperty('--ds-reader-paper-back');
});

const onlyEvent = () => {
  expect(tel.captureEvent).toHaveBeenCalledTimes(1);
  return tel.captureEvent.mock.calls[0][0] as { eventType: string; source: string; message: string; metadata: Record<string, unknown> };
};

/** Nothing the reader of a telemetry row could learn the comic from. */
const expectNoContent = (event: unknown, extra: string[] = []) => {
  const json = JSON.stringify(event);
  for (const secret of [SECRET_TITLE, SECRET_LINE, 'Saffron', 'secret', 'cdn.test', '.mp4', 'pg_1', ...extra]) expect(json).not.toContain(secret);
};

describe('motion comic export telemetry: one event per export, no content', () => {
  it('a finished export sends exactly one "done" event with counts, timings and enums', async () => {
    const download = vi.fn();
    const result = await exportMotionComic(smallDoc(), urlFor, { aspect: '1:1', download, timeline: { plates: false } });
    expect(download).toHaveBeenCalledTimes(1);
    expect(result.engine).toBe('webcodecs');
    const ev = onlyEvent();
    expect(ev.eventType).toBe(MOTION_EXPORT_EVENT);
    expect(ev.source).toBe('comic_studio');
    expect(ev.metadata).toMatchObject({
      outcome: 'done',
      stage: 'done',
      engine: 'webcodecs',
      aspect: '1:1',
      pages: 2,
      panels: 6,
      skipped: 0,
      videoMs: result.durationMs,
      rtl: false,
      overlay: false,
      outro: true
    });
    expect(typeof ev.metadata.elapsedMs).toBe('number');
    expectNoContent(ev, [result.fileName]);
  });

  it('a failed export sends one "failed" event naming the stage, never the error text', async () => {
    art.fail.add('https://cdn.test/u/secret/pg_1.webp');
    art.fail.add('https://cdn.test/u/secret/pg_2.webp');
    await expect(exportMotionComic(smallDoc(), urlFor, { download: vi.fn() })).rejects.toThrow('Couldn’t load any pages');
    const ev = onlyEvent();
    expect(ev.metadata).toMatchObject({ outcome: 'failed', stage: 'loading', pages: 0, skipped: 2 });
    expectNoContent(ev, ['could not load']);
  });

  it('nothing to animate is still exactly one event', async () => {
    await expect(exportMotionComic(smallDoc((d) => (d.pages = [])), urlFor, {})).rejects.toThrow('Nothing to animate yet');
    expect(onlyEvent().metadata).toMatchObject({ outcome: 'failed', stage: 'setup' });
  });

  it('a cancelled export sends one "cancelled" event', async () => {
    const ctrl = new AbortController();
    enc.onFrame = (f) => f === 5 && ctrl.abort();
    await expect(exportMotionComic(smallDoc(), urlFor, { signal: ctrl.signal, download: vi.fn() })).rejects.toThrow('Export cancelled.');
    expect(onlyEvent().metadata).toMatchObject({ outcome: 'cancelled', stage: 'encoding' });
    expect(art.released).toBe(2); // the art is released either way
  });

  it('two exports, two events; the exporter itself starts no timer (fake timers)', async () => {
    vi.useFakeTimers();
    await exportMotionComic(smallDoc(), urlFor, { download: vi.fn(), timeline: { plates: false, outro: false } });
    await exportMotionComic(smallDoc((d) => (d.format = { ...d.format, readingDirection: 'rtl' })), urlFor, { download: vi.fn(), timeline: { plates: false } });
    expect(vi.getTimerCount()).toBe(0);
    expect(tel.captureEvent).toHaveBeenCalledTimes(2);
    expect(tel.captureEvent.mock.calls.map((c) => c[0].metadata.outro)).toEqual([false, true]);
    expect(tel.captureEvent.mock.calls[1][0].metadata.rtl).toBe(true);
  });

  it('through the real telemetry queue: one POST /api/telemetry/events 8 s after the export, then nothing (fake timers)', async () => {
    const real = await vi.importActual<typeof import('../../../services/telemetry')>('../../../services/telemetry');
    tel.captureEvent.mockImplementation(real.captureEvent);
    api.post.mockResolvedValue({});
    vi.useFakeTimers();
    await exportMotionComic(smallDoc(), urlFor, { download: vi.fn(), timeline: { plates: false } });
    expect(tel.captureEvent).toHaveBeenCalledTimes(1);
    expect(api.post).not.toHaveBeenCalled(); // the export itself sends nothing
    vi.advanceTimersByTime(7999);
    expect(api.post).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(api.post).toHaveBeenCalledTimes(1);
    const [path, body] = api.post.mock.calls[0] as [string, { events: { eventType: string }[] }];
    expect(path).toBe('/api/telemetry/events');
    expect(body.events.map((e) => e.eventType)).toEqual([MOTION_EXPORT_EVENT]);
    expectNoContent(body);
    // Idle afterwards: no periodic flush, no retry, no timer left that could wake the backend.
    await vi.advanceTimersByTimeAsync(600_000);
    expect(api.post).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('motion comic frames read the design tokens', () => {
  it('every frame clears to --ds-reader-room, read once from the stylesheet', async () => {
    document.documentElement.style.setProperty('--ds-reader-room', 'rgb(9, 8, 7)');
    await exportMotionComic(smallDoc(), urlFor, { download: vi.fn(), timeline: { plates: false } });
    const main = canvases.find((c) => (c.ctx.canvas as unknown as { width: number }).width === 1080)!;
    const clears = main.calls.filter((c) => c.name === 'fillRect' && c.args[0] === 0 && c.args[1] === 0 && c.args[2] === 1080 && c.args[3] === 1920);
    expect(clears.length).toBeGreaterThanOrEqual(enc.frames);
    expect(new Set(clears.map((c) => c.state.fillStyle))).toEqual(new Set(['rgb(9, 8, 7)']));
  });

  it('the outro words are painted with --ds-reader-paper-back', async () => {
    document.documentElement.style.setProperty('--ds-reader-paper-back', 'rgb(1, 2, 3)');
    await exportMotionComic(smallDoc(), urlFor, { download: vi.fn(), timeline: { plates: false } });
    const main = canvases.find((c) => (c.ctx.canvas as unknown as { width: number }).width === 1080)!;
    const texts = main.calls.filter((c) => c.name === 'fillText');
    const brand = texts.filter((c) => c.args[0] === 'Made with DreamStream Comic Studio' || c.args[0] === 'dreamstreamstudio.ai');
    expect(new Set(brand.map((c) => c.args[0]))).toEqual(new Set(['Made with DreamStream Comic Studio', 'dreamstreamstudio.ai']));
    expect(new Set(brand.map((c) => c.state.fillStyle))).toEqual(new Set(['rgb(1, 2, 3)']));
    // The title on the end card too: every word the frame drawer writes is paper.
    expect(texts.some((c) => String(c.args[0]).includes('Saffron'))).toBe(true);
    expect(new Set(texts.map((c) => c.state.fillStyle))).toEqual(new Set(['rgb(1, 2, 3)']));
  });
});
