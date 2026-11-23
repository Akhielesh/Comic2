// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ComicPanel } from '../types';
import { REVIEW_GROUP_SIZE, reviewWindow, scanPanelWindow, similarPanelPairs, type PanelThumbnail } from './classicArtworkComparison';

function thumbnail(colors: number[], aspect = 1): PanelThumbnail {
  return { url: '', aspect, pixels: new Uint8ClampedArray(colors.flatMap(color => [color, color, color, 255])) };
}
afterEach(() => vi.unstubAllGlobals());

describe('local classic artwork comparison', () => {
  it('finds near and exact repeated compositions at different positions while rejecting flat, reframed, and rearranged images', () => {
    const a = thumbnail([10, 240, 10, 240]);
    const sameScene = thumbnail([13, 238, 15, 235]);
    const different = thumbnail([240, 10, 240, 10]);
    const flat = thumbnail([50,50,50,50]);
    const matches = similarPanelPairs([a, sameScene, different, null, a, thumbnail([10,240,10,240], 2), flat, flat]);
    expect(matches.map(p => [p.left,p.right])).toEqual([[0,4],[0,1],[1,4]]);
  });

  it('keeps each adjacent turn reachable across a group boundary', () => {
    const panels = Array.from({ length: REVIEW_GROUP_SIZE * 2 + 1 }, (_, i) => ({ id: String(i) } as ComicPanel));
    const a = reviewWindow(panels, 0), b = reviewWindow(panels, 1), c = reviewWindow(panels, 2);
    expect(a.panels).toHaveLength(REVIEW_GROUP_SIZE);
    expect(b.panels[0]).toBe(a.panels.at(-1));
    expect(c.panels[0]).toBe(b.panels.at(-1));
    expect(c.panels).toHaveLength(2);
  });

  it('limits active ID resolutions to two, stops remaining work on close, and suppresses late results', async () => {
    const resolveImage = vi.fn(() => new Promise<string | undefined>(() => {}));
    const onImage = vi.fn();
    const controller = new AbortController();
    const work = scanPanelWindow(Array.from({length: 90}, (_,i)=>({imageId:String(i)})), resolveImage, controller.signal, onImage);
    expect(resolveImage).toHaveBeenCalledTimes(2);
    controller.abort();
    await work;
    expect(resolveImage).toHaveBeenCalledTimes(2);
    expect(onImage).not.toHaveBeenCalled();
  });

  it('does not start additional signer requests while two timed-out resolutions remain pending', async () => {
    vi.useFakeTimers();
    try {
      const resolver = vi.fn(() => new Promise<string | undefined>(() => {}));
      const update = vi.fn();
      const work = scanPanelWindow(Array.from({length:8}, (_,i) => ({imageId: String(i)})), resolver, new AbortController().signal, update);
      await vi.advanceTimersByTimeAsync(7000);
      await work;
      expect(resolver).toHaveBeenCalledTimes(2);
      expect(update).toHaveBeenCalledTimes(8);
    } finally { vi.useRealTimers(); }
  });

  it('skips unavailable data individually, bounds group size and retries an expired saved URL through its current image ID', async () => {
    const fetchImage = vi.fn(async () => new Response(null, { status: 403 }));
    vi.stubGlobal('fetch', fetchImage);
    const resolver = vi.fn(async () => 'https://images.example/refreshed');
    const onImage = vi.fn();
    const list = [{ imageId:'one', imageUrl:'https://images.example/expired' }, ...Array.from({length:70}, () => ({}))];
    await scanPanelWindow(list, resolver, new AbortController().signal, onImage);
    expect(resolver).toHaveBeenCalledOnce();
    expect(fetchImage.mock.calls).toHaveLength(2);
    expect(onImage).toHaveBeenCalledTimes(REVIEW_GROUP_SIZE + 1);
    expect(onImage.mock.calls.every(([,img]) => img === null)).toBe(true);
  });

  it('cancels oversized image responses before decoding and never requests a non-image data URL', async () => {
    const cancel = vi.fn();
    const fetchImage = vi.fn(async () => new Response(new ReadableStream({ cancel }), {
      headers:{ 'content-length': String(16 * 1024 * 1024), 'content-type':'image/png' }
    }));
    vi.stubGlobal('fetch', fetchImage);
    const update = vi.fn();
    await scanPanelWindow([{imageUrl:'https://images.example/huge'},{imageUrl:'data:text/html,sample'}],vi.fn(),new AbortController().signal,update);
    expect(fetchImage).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledOnce();
    expect(update.mock.calls).toEqual(expect.arrayContaining([[0,null],[1,null]]));
  });
});
