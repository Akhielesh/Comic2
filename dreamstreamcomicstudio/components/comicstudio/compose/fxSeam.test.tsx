// The PE-FX seam (collisions B-7): effect drawings load lazily through compose's loader (setFxLoader), never through a
// static import. The screen re-draws once they arrive (one load for the whole app); every export and the print document
// wait for them before drawing a page that holds an effect, and say so calmly when they can't be loaded.
// renderFx is mocked: it draws only once the fake loader has "registered" the drawings, as PE-FX's registry does.

import React from 'react';
import { render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FxNode } from '../../../shared/comic/fx/types';
import { estimateMeasure } from '../../../shared/comic/lettering/layout';
import { ComicPageView } from '../board/ComicPageView';
import { fakeUrlFor } from '../board/__fixtures__/sampleDoc';
import { fakeContext, fakeLayers, fakePath, type FakeCtx } from '../export/__fixtures__/fakeCanvas';
import { effectsLeftOutNote, openPrintView } from '../export/printView';
import { renderPageToBlob } from '../export/rasterize';
import { ensureFxDrawings, fxDrawingsPending, setFxLoader } from './pageNodes';
import { fakePathUrl, LAYERS, layeredDoc } from './__fixtures__/composeDocs';

const registry = vi.hoisted(() => ({ loaded: false }));
const NODES: FxNode[] = vi.hoisted(() => [{ tag: 'rect', x: 0, y: 0, w: 1, h: 1, fill: '#123456' }]);

vi.mock('../../../shared/comic/fx/registry', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../shared/comic/fx/registry')>();
  return { ...real, renderFx: vi.fn((fx: Parameters<typeof real.renderFx>[0], ctx: Parameters<typeof real.renderFx>[1]) => (registry.loaded ? NODES : real.renderFx(fx, ctx))) };
});

/** A loader that "registers" the drawings once `release` is called (immediately when not gated). */
const gatedLoader = (gated = false) => {
  let release: () => void = () => undefined;
  const gate = gated ? new Promise<void>((r) => (release = r)) : Promise.resolve();
  const load = vi.fn(async () => {
    await gate;
    registry.loaded = true;
  });
  return { load, release: () => release() };
};

const doc = () => layeredDoc([LAYERS.effect]);
const drawingUrl = (d: ReturnType<typeof doc>) => fakeUrlFor(d.pages[0].render.asset)!;

beforeEach(() => {
  registry.loaded = false;
  setFxLoader(undefined);
});
afterEach(() => {
  setFxLoader(undefined);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('compose loads the effect drawings lazily (setFxLoader / ensureFxDrawings)', () => {
  it('without a loader nothing waits; with one, a page holding an effect waits until it has loaded once', async () => {
    const d = doc();
    expect(fxDrawingsPending(d.pages[0])).toBe(false);
    await expect(ensureFxDrawings(d.pages[0])).resolves.toBe(false);
    const { load } = gatedLoader();
    setFxLoader(load);
    expect(fxDrawingsPending(d.pages[0])).toBe(true);
    // A page without an effect never loads them.
    const plain = layeredDoc([LAYERS.shape]);
    await expect(ensureFxDrawings(plain.pages[0])).resolves.toBe(false);
    expect(load).not.toHaveBeenCalled();
    const [a, b] = await Promise.all([ensureFxDrawings(d.pages[0]), ensureFxDrawings(d.pages[0])]);
    expect([a, b]).toEqual([true, true]);
    expect(load).toHaveBeenCalledTimes(1);
    expect(fxDrawingsPending(d.pages[0])).toBe(false);
    await expect(ensureFxDrawings(d.pages[0])).resolves.toBe(false);
  });

  it('a failed load stays pending and is tried again on the next call', async () => {
    const d = doc();
    const load = vi.fn().mockRejectedValueOnce(new Error('offline')).mockImplementation(async () => (registry.loaded = true));
    setFxLoader(load);
    await expect(ensureFxDrawings(d.pages[0])).resolves.toBe(false);
    expect(fxDrawingsPending(d.pages[0])).toBe(true);
    await expect(ensureFxDrawings(d.pages[0])).resolves.toBe(true);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('the screen draws the effect blank, then re-draws every view once the drawings arrive (one load)', async () => {
    const d = doc();
    const page = d.pages[0];
    const { load, release } = gatedLoader(true);
    setFxLoader(load);
    const view = render(
      <>
        <ComicPageView doc={d} page={page} imageUrl={drawingUrl(d)} loading="eager" />
        <ComicPageView doc={d} page={page} imageUrl={drawingUrl(d)} loading="eager" />
      </>
    );
    const marks = () => view.container.querySelectorAll('g[data-layer-id="ly_fx"] rect').length;
    expect(view.container.querySelectorAll('g[data-layer-id="ly_fx"]')).toHaveLength(2);
    expect(marks()).toBe(0);
    release();
    await waitFor(() => expect(marks()).toBe(2));
    expect(load).toHaveBeenCalledTimes(1);
  });
});

describe('exports and print wait for the effect drawings', () => {
  let made: FakeCtx[] = [];
  beforeEach(() => {
    made = [];
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
      const f = fakeContext(this.width, this.height);
      made.push(f);
      return f.ctx as never;
    } as never);
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (this: HTMLCanvasElement, cb: BlobCallback, type?: string) {
      cb(new Blob(['x'], { type: type || 'image/png' }));
    });
    vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(String(url), { status: 200, headers: { 'content-type': 'image/png' } })));
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 1000, height: 1500, close: () => undefined })));
  });
  const opts = { measure: estimateMeasure, makePath: fakePath, createLayer: fakeLayers().createLayer, urlForPath: fakePathUrl };
  const effectFills = (f: FakeCtx) => f.calls.filter((c) => c.name === 'fill' && c.state.fillStyle === '#123456').length;

  it('PNG / PDF / ZIP: the page is drawn after the drawings load, with its effect', async () => {
    const d = doc();
    const { load } = gatedLoader();
    setFxLoader(load);
    await renderPageToBlob(d, d.pages[0], drawingUrl(d), opts);
    expect(load).toHaveBeenCalledTimes(1);
    expect(effectFills(made[0])).toBe(1);
  });

  it('a page whose effect drawings cannot load is refused calmly, never exported without them', async () => {
    const d = doc();
    setFxLoader(() => Promise.reject(new Error('offline')));
    await expect(renderPageToBlob(d, d.pages[0], drawingUrl(d), opts)).rejects.toThrow('The effects on page 1 couldn’t be drawn yet. Try again in a moment.');
    expect(made).toHaveLength(0);
  });

  const fakeWindow = () => {
    const document = window.document.implementation.createHTMLDocument('print');
    return { document, focus: vi.fn(), print: vi.fn(), innerWidth: 390 } as unknown as Window;
  };

  it('print loads the drawings before writing the document', async () => {
    const d = doc();
    const { load } = gatedLoader();
    setFxLoader(load);
    const win = fakeWindow();
    const result = await openPrintView(d, fakeUrlFor, { win, timeoutMs: 5, measure: estimateMeasure });
    expect(load).toHaveBeenCalledTimes(1);
    expect(win.document.querySelectorAll('svg[data-compose] g[data-layer-id="ly_fx"] rect')).toHaveLength(1);
    expect(result.skipped).not.toContain(effectsLeftOutNote('Page 1'));
  });

  it('print without the drawings: the page prints without its effects, and the bar and the result say so', async () => {
    const d = doc();
    setFxLoader(() => Promise.reject(new Error('offline')));
    const win = fakeWindow();
    const onStatus = vi.fn();
    const result = await openPrintView(d, fakeUrlFor, { win, timeoutMs: 5, measure: estimateMeasure, onStatus });
    expect(result.skipped).toContain(effectsLeftOutNote('Page 1'));
    expect(win.document.querySelector('.bar')!.textContent).toContain(effectsLeftOutNote('Page 1'));
    expect(onStatus).toHaveBeenLastCalledWith(expect.stringContaining('Try again in a moment.'));
  });
});
