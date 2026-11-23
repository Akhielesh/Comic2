import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ComicDoc } from '../../../shared/comic/doc';
import { makeSampleDoc } from '../board/__fixtures__/sampleDoc';
import { ComicReaderView } from './ComicReaderView';
import { readerItems, resolvePageN } from './readerModel';

const art = (path: string) => ({ path, source: 'generated' as const, at: 1 });

function history(prefix: string, flattened: boolean): ComicDoc {
  return makeSampleDoc((doc) => {
    const page = doc.pages[0];
    doc.pages = [page];
    page.artMode = 'panels';
    page.panels = page.panels.slice(0, 2).map((p, i) => ({
      ...p,
      frame: { box: { x: i / 2, y: 0, w: 0.5, h: 1 }, src: { path: prefix + (i ? 'right' : 'left') } }
    }));
    const box = { x: 0.4, y: 0.4, w: 0.2, h: 0.2 };
    page.layers = [
      { id: 'printed', kind: 'image', box, src: { path: prefix + 'decal' } },
      { id: 'guide', kind: 'image', box, src: { path: prefix + 'guide' }, print: false }
    ];
    page.render = flattened
      ? { status: 'ready', history: [], asset: art(prefix + 'flat') }
      : { status: 'none', history: [] };
  });
}

function hrefs(root: HTMLElement) {
  return [...root.querySelectorAll('svg image')].map((node) => node.getAttribute('href'));
}
afterEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  vi.unstubAllGlobals();
});
describe('stored Director page composition', () => {
  for (const mode of ['scroll', 'page'] as const) {
    for (const prefix of ['pub/fixture/', 'u/owner/p/edition/img/', 'library/cast/']) {
      it(`shows the authorized printed layers of a frame-only ${prefix} page in ${mode} mode`, () => {
        const doc = history(prefix, false);
        const allowed = new Map(['left', 'right', 'decal'].map((k) => [prefix + k, '/served/' + k]));
        const urlFor = vi.fn((asset?: string | { path: string } | null) => {
          const path = typeof asset === 'string' ? asset : asset?.path;
          return path ? allowed.get(path) : undefined;
        });
        const items = readerItems(doc);
        expect(resolvePageN(items, 1)).toEqual({ index: 0, exact: true, shownN: 1 });
        expect(items[0].asset).toBeUndefined();
        render(<ComicReaderView doc={doc} urlFor={urlFor} initialMode={mode} initialPage={1} />);
        expect(hrefs(screen.getByTestId('composed-art'))).toEqual(['/served/left', '/served/right', '/served/decal']);
        expect(urlFor.mock.calls.flat()).not.toContain(prefix + 'guide');
      });
    }
  }
  it('uses the same authority for frames on a flattened page and drops paths without permission', () => {
    const prefix = 'u/owner/p/edition/img/';
    const doc = history(prefix, true);
    const called: string[] = [];
    const resolve = (a?: string | { path: string } | null) => {
      const k = typeof a === 'string' ? a : a?.path;
      if (k) called.push(k);
      return k === prefix + 'left' ? '/allowed-left' : undefined;
    };
    render(<ComicReaderView doc={doc} urlFor={resolve} initialMode="scroll" />);
    expect(hrefs(screen.getByTestId('composed-art'))).toEqual(['/allowed-left']);
    expect(called).toContain(prefix + 'right');
  });
  it("refreshes the host's image links after a composed picture fails", () => {
    const doc = history('u/owner/p/edition/img/', false);
    const onImageError = vi.fn();
    render(<ComicReaderView doc={doc} urlFor={() => '/served/frame'} initialMode="scroll" onImageError={onImageError} />);
    fireEvent.error(screen.getByTestId('composed-art').querySelector('image')!);
    expect(onImageError).toHaveBeenCalledOnce();
    expect(screen.getByTestId('composed-art')).toBeInTheDocument();
  });

  it('never resolves quarantined, externally linked or withheld frames', () => {
    const prefix = 'u/owner/p/edition/img/';
    const doc = history(prefix, false);
    const page = doc.pages[0];
    page.render.history = [{ ...art(prefix + 'left'), safety: { quarantined: true, by: 'check', at: 1 } }];
    page.panels[1].frame!.src!.path = 'https://example.invalid/external';
    page.layers = [];
    const urlFor = vi.fn(() => '/would-have-resolved');
    const { unmount } = render(<ComicReaderView doc={doc} urlFor={urlFor} initialMode="scroll" />);
    expect(hrefs(screen.getByTestId('composed-art'))).toEqual([]);
    expect(urlFor.mock.calls.flat()).not.toContain(prefix + 'left');
    expect(urlFor.mock.calls.flat()).not.toContain('https://example.invalid/external');
    unmount();
    page.render.withheld = 'safety';
    render(<ComicReaderView doc={doc} urlFor={urlFor} initialMode="page" />);
    expect(screen.queryByTestId('composed-art')).toBeNull();
    expect(screen.getByLabelText('Image withheld')).toBeInTheDocument();
  });
  it('leaves a plan with a broken frame and no drawing out of the reading order', () => {
    const doc = history('u/owner/p/edition/img/', false);
    delete doc.pages[0].panels[1].frame;
    expect(readerItems(doc)).toEqual([]);
  });
});
