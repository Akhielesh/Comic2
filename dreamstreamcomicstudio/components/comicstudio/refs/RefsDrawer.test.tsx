// refs.md §9 client: the drawer (keyboard reorder → ref_move, Home → main, remove with an Undo window,
// labels, uploads through the queue with progress, inline over-cap, the quoted sheet offer, likeness),
// the strip (Add tile, "+N", the "new photos since this sheet" hint) and the live refs card.
import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Card, ComicDoc, RefAsset } from '../../../shared/comic/doc';
import { makeSampleDoc, makeStudio } from '../board/__fixtures__/sampleDoc';
import { RefsCard } from './RefsCard';
import { RefsDrawer } from './RefsDrawer';
import { RefStrip } from './RefStrip';
import { refUsage, styleRefsUsed } from './refsModel';
import { feature } from './index';
import { resetUsageStatus, showDollarPrices, showUsagePrices } from '../conversation/testing/fixtures';
import { refTileName } from './RefTile';
import { __resetUploadQueues, RefUploadError, type UploadResponse, type UploadTransport } from './useRefUpload';

const MAYA = { kind: 'character', id: 'ch_maya' } as const;
const ref = (n: number, extra: Partial<RefAsset> = {}): RefAsset => ({ path: `u/u1/p/p1/ref/r${n}.webp`, source: 'upload', at: n, safety: { assessed: 'G', at: 1 }, ...extra });

const docWith = (refs: RefAsset[], mutate?: (d: ComicDoc) => void) =>
  makeSampleDoc((d) => {
    d.cast[0].refs = refs;
    mutate?.(d);
  });

beforeEach(() => {
  // Admin / own-key wording (dollars); the governed wording has its own test below.
  showDollarPrices();
});

afterEach(() => {
  __resetUploadQueues();
  vi.useRealTimers();
  resetUsageStatus();
});

describe('feature registration', () => {
  it('registers the live refs card', () => {
    expect(feature.cards).toEqual([{ type: 'refs', Component: RefsCard }]);
  });
});

describe('RefsDrawer', () => {
  it('shows the photos with ★ main, the count, both pickers and the privacy promise', () => {
    const studio = makeStudio(docWith([ref(1, { label: 'front' }), ref(2), ref(3, { label: 'side' })]));
    render(<RefsDrawer studio={studio} owner={MAYA} open onClose={vi.fn()} />);
    const dialog = screen.getByRole('dialog', { name: 'Maya — photos' });
    expect(within(dialog).getByText('3 / 12')).toBeInTheDocument();
    // The name starts with the tile's visible words (WCAG 2.5.3), then says which photo it is.
    const main = within(dialog).getByRole('button', { name: /^Front\b.*, Photo 1 \(main\)$/ });
    expect(within(main).getByTitle('Main photo')).toBeInTheDocument();
    const picker = screen.getByTestId('refs-picker') as HTMLInputElement;
    expect(picker.multiple).toBe(true);
    expect(picker.accept).toBe('image/jpeg,image/png,image/webp,image/gif,image/avif');
    expect(screen.getByTestId('refs-camera').getAttribute('capture')).toBe('environment');
    expect(screen.getByText(/Your photos stay private to you/)).toBeInTheDocument();
  });

  it('keyboard reorder emits ref_move; Home makes the photo main', () => {
    const studio = makeStudio(docWith([ref(1), ref(2), ref(3)]));
    render(<RefsDrawer studio={studio} owner={MAYA} open onClose={vi.fn()} />);
    fireEvent.keyDown(screen.getByRole('button', { name: /(^|, )Photo 1 \(main\)$/ }), { key: 'ArrowRight', altKey: true });
    expect(studio.patch).toHaveBeenLastCalledWith([{ op: 'ref_move', owner: MAYA, path: ref(1).path, to: 1 }], { label: 'Reorder photos' });
    fireEvent.keyDown(screen.getByRole('button', { name: /(^|, )Photo 3$/ }), { key: 'Home' });
    expect(studio.patch).toHaveBeenLastCalledWith([{ op: 'ref_move', owner: MAYA, path: ref(3).path, to: 0 }], { label: 'Make main photo' });
  });

  it('remove hides the photo with an Undo window; Undo sends nothing, otherwise ref_remove goes out', async () => {
    const studio = makeStudio(docWith([ref(1), ref(2)]));
    render(<RefsDrawer studio={studio} owner={MAYA} open onClose={vi.fn()} />);
    fireEvent.keyDown(screen.getByRole('button', { name: /(^|, )Photo 2$/ }), { key: 'Delete' });
    expect(screen.queryByRole('button', { name: /(^|, )Photo 2$/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(screen.getByRole('button', { name: /(^|, )Photo 2$/ })).toBeInTheDocument();
    expect(studio.patch).not.toHaveBeenCalled();

    vi.useFakeTimers();
    fireEvent.click(screen.getByRole('button', { name: /(^|, )Photo 2$/ }));
    fireEvent.click(screen.getByRole('button', { name: /Remove/ }));
    expect(studio.patch).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(studio.patch).toHaveBeenCalledWith([{ op: 'ref_remove', owner: MAYA, path: ref(2).path }], { label: 'Remove photo' });
  });

  it('closing the drawer sends a pending removal right away (never lost)', () => {
    const studio = makeStudio(docWith([ref(1), ref(2)]));
    const { unmount } = render(<RefsDrawer studio={studio} owner={MAYA} open onClose={vi.fn()} />);
    fireEvent.keyDown(screen.getByRole('button', { name: /(^|, )Photo 2$/ }), { key: 'Delete' });
    unmount();
    expect(studio.patch).toHaveBeenCalledWith([{ op: 'ref_remove', owner: MAYA, path: ref(2).path }], { label: 'Remove photo' });
  });

  it('the selected photo: label, note, free crop, move to someone else', () => {
    const studio = makeStudio(docWith([ref(1), ref(2)]));
    render(<RefsDrawer studio={studio} owner={MAYA} open onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /(^|, )Photo 2$/ }));
    const actions = screen.getByRole('region', { name: 'Photo 2 actions' });
    fireEvent.change(within(actions).getByLabelText('View'), { target: { value: 'side' } });
    expect(studio.patch).toHaveBeenLastCalledWith([{ op: 'ref_patch', owner: MAYA, path: ref(2).path, patch: { label: 'side' } }], { label: 'Label photo' });
    const note = within(actions).getByPlaceholderText('e.g. her festival outfit');
    fireEvent.change(note, { target: { value: '  festival   dress ' } });
    fireEvent.blur(note);
    expect(studio.patch).toHaveBeenLastCalledWith([{ op: 'ref_patch', owner: MAYA, path: ref(2).path, patch: { note: 'festival dress' } }], { label: 'Photo note' });
    fireEvent.click(within(actions).getByRole('button', { name: /Tighten to subject/ }));
    expect(studio.act).toHaveBeenLastCalledWith({ type: 'ref_crop', owner: MAYA, path: ref(2).path });
    fireEvent.change(within(actions).getByLabelText('Move to'), { target: { value: 'character:ch_arjun' } });
    expect(studio.patch).toHaveBeenLastCalledWith([{ op: 'ref_transfer', from: MAYA, to: { kind: 'character', id: 'ch_arjun' }, path: ref(2).path }], { label: 'Move photo' });
  });

  it('uploads from the picker through the queue (progress, then a resync), never above the cap', async () => {
    const studio = makeStudio(docWith([ref(1)]));
    let progress: ((f: number) => void) | undefined;
    let resolve: ((r: UploadResponse) => void) | undefined;
    const transport: UploadTransport = ({ onProgress }) =>
      new Promise((res) => {
        progress = onProgress;
        resolve = res;
      });
    render(<RefsDrawer studio={studio} owner={MAYA} open onClose={vi.fn()} transport={transport} />);
    // 200 KB PNG at its natural size → sent as is (no canvas needed in the test DOM).
    const png = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, ...new Array(200).fill(1)])], 'maya-side.png', { type: 'image/png' });
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 800, height: 600, close: vi.fn() })));
    fireEvent.change(screen.getByTestId('refs-picker'), { target: { files: [png] } });
    await waitFor(() => expect(progress).toBeDefined());
    act(() => progress!(0.5));
    expect(screen.getByRole('progressbar', { name: 'Uploading maya-side.png' }).getAttribute('aria-valuenow')).toBe('50');
    await act(async () => resolve!({ ref: ref(2), ops: [], urls: {} }));
    await waitFor(() => expect(studio.refresh).toHaveBeenCalledTimes(1));
    vi.unstubAllGlobals();
  });

  it('a full owner says so inline and disables adding', () => {
    const studio = makeStudio(docWith(Array.from({ length: 12 }, (_, i) => ref(i + 1))));
    render(<RefsDrawer studio={studio} owner={MAYA} open onClose={vi.fn()} />);
    expect(screen.getByRole('status')).toHaveTextContent('MAYA can hold 12 photos — remove one to add more.');
    expect(screen.getByRole('button', { name: /Add photos/ })).toBeDisabled();
  });

  it('offers the model sheet with its real price (never drawn unasked) and sets what pages use', () => {
    const studio = makeStudio(docWith([ref(1), ref(2)], (d) => (d.cast[0].sheet = { status: 'none', history: [] })));
    render(<RefsDrawer studio={studio} owner={MAYA} open onClose={vi.fn()} />);
    expect(studio.act).not.toHaveBeenCalled();
    const cta = screen.getByRole('button', { name: /Make the sheet/ });
    expect(cta.textContent).toMatch(/Make the sheet ≈ \$0\.\d\d$/);
    fireEvent.click(cta);
    expect(studio.act).toHaveBeenCalledWith({ type: 'render_sheets', characterIds: ['ch_maya'] });
    fireEvent.click(screen.getByRole('radio', { name: 'Sheet only' }));
    expect(studio.patch).toHaveBeenLastCalledWith([{ op: 'character', id: 'ch_maya', patch: { likeness: 'sheet_only' } }], { label: 'Likeness' });
  });

  it('a blocked photo never becomes an <img>', () => {
    const studio = makeStudio(docWith([ref(1), ref(2, { safety: { assessed: 'X', at: 1 } })]));
    render(<RefsDrawer studio={studio} owner={MAYA} open onClose={vi.fn()} />);
    const tile = screen.getByRole('button', { name: /(^|, )Photo 2$/ });
    expect(tile.querySelector('img')).toBeNull();
  });
});

describe('RefStrip', () => {
  it('always offers Add; shows +N and the "new photos since this sheet" hint', () => {
    const sheet = { status: 'ready' as const, history: [], asset: { path: 'u/x/sheet.webp', source: 'generated' as const, at: 1 }, refPaths: [ref(1).path] };
    const studio = makeStudio(docWith(Array.from({ length: 7 }, (_, i) => ref(i + 1)), (d) => (d.cast[0].sheet = sheet)));
    render(<RefStrip studio={studio} owner={MAYA} />);
    expect(screen.getByRole('button', { name: 'Add photos to MAYA' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '2 more photos — manage photos' })).toBeInTheDocument();
    expect(screen.getByText(/New photos since this sheet — redraw ≈ \$0\.\d\d/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '7/12' }));
    expect(screen.getByRole('dialog', { name: 'Maya — photos' })).toBeInTheDocument();
  });

  it('an upload started from the strip is never swallowed: a blocked photo shows its red row right there', async () => {
    const studio = makeStudio(docWith([ref(1)]));
    const transport: UploadTransport = async () => {
      throw new RefUploadError(422, "This image doesn't fit DreamStream's content rules, so it wasn't added.", 'CONTENT_POLICY');
    };
    render(<RefStrip studio={studio} owner={MAYA} transport={transport} />);
    const png = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, ...new Array(200).fill(1)])], 'beach.png', { type: 'image/png' });
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 800, height: 600, close: vi.fn() })));
    fireEvent.change(screen.getByTestId('refstrip-picker'), { target: { files: [png] } });
    await waitFor(() => expect(screen.getByText("Not added — this image doesn't fit DreamStream's content rules.")).toBeInTheDocument());
    const row = screen.getByText('beach.png').closest('li')!;
    expect(row).toHaveAttribute('data-state', 'rejected');
    expect(within(row).queryByRole('button', { name: /Retry/ })).toBeNull();
    expect(row.querySelector('img')).toBeNull();
    fireEvent.click(within(row).getByRole('button', { name: 'Dismiss beach.png' }));
    expect(screen.queryByText('beach.png')).toBeNull();
    vi.unstubAllGlobals();
  });

  it('renders nothing for an owner that no longer exists', () => {
    const { container } = render(<RefStrip studio={makeStudio(docWith([]))} owner={{ kind: 'character', id: 'gone' }} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('RefTile names (P1-QA ref-tile-names)', () => {
  it('start with the visible chip words, then the position', () => {
    expect(refTileName(0, ['Front', 'Sheet'])).toBe('Front Sheet, Photo 1 (main)');
    expect(refTileName(2, [])).toBe('Photo 3');
    expect(refTileName(1, ['Blurry'])).toBe('Blurry, Photo 2');
  });
});

describe('governed users never see dollars (P2-STUDIO-CORE)', () => {
  it('the sheet offer reads as a share of the usage', () => {
    showUsagePrices(1);
    const studio = makeStudio(docWith([ref(1), ref(2)], (d) => (d.cast[0].sheet = { status: 'none', history: [] })));
    render(<RefsDrawer studio={studio} owner={MAYA} open onClose={vi.fn()} />);
    const cta = screen.getByRole('button', { name: /Make the sheet/ });
    expect(cta.textContent).toMatch(/Make the sheet (≈[\d.]+%|<0\.1%) of your usage$/);
    expect(document.body.textContent).not.toMatch(/\$\d/);
  });

  it('before the usage status loads, a non-admin sees no dollar figure (fail closed)', () => {
    resetUsageStatus();
    const studio = makeStudio(docWith([ref(1), ref(2)], (d) => (d.cast[0].sheet = { status: 'none', history: [] })));
    render(<RefsDrawer studio={studio} owner={MAYA} open onClose={vi.fn()} />);
    expect(screen.getByRole('button', { name: /Make the sheet/ }).textContent).not.toMatch(/\$/);
  });
});

describe('honest usage badges (the compiler’s own picks)', () => {
  const style = (refs: RefAsset[], override: string | undefined, board: boolean) =>
    makeSampleDoc((d) => {
      d.style.refs = refs;
      d.settings.imageModelOverride = override;
      if (!board) delete d.style.board;
    });
  it('style photos: none while the board is the only anchor; 1 without a board; up to 2 beside the board on Pro', () => {
    const four = [ref(1), ref(2), ref(3), ref(4)];
    const used = (d: ComicDoc) => [...refUsage(d, { kind: 'style' }).values()].filter((u) => u.style).length;
    expect(styleRefsUsed(style(four, 'nano-banana-2.1', true))).toBe(0);
    expect(used(style(four, 'nano-banana-2.1', true))).toBe(0);
    expect(used(style(four, 'nano-banana-2.1', false))).toBe(1);
    expect(used(style(four, 'nano-banana-pro', true))).toBe(2);
    expect(used(style(four, 'nano-banana-pro', false))).toBe(2);
  });
});

describe('RefsCard (live doc state)', () => {
  const msg = { id: 'm', role: 'assistant' as const, text: '', at: 1 };
  it('shows only the photos still on the owner, opens the drawer, offers the sheet', () => {
    const studio = makeStudio(docWith([ref(1), ref(3)], (d) => (d.cast[0].sheet = { status: 'none', history: [] })));
    const card: Extract<Card, { type: 'refs' }> = { type: 'refs', id: 'c1', owner: MAYA, paths: [ref(1).path, ref(2).path] };
    render(<RefsCard card={card} message={msg} studio={studio} />);
    expect(screen.getByText('1 photo on MAYA')).toBeInTheDocument();
    expect(screen.getAllByRole('img')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: /Draw MAYA's sheet/ }));
    expect(studio.act).toHaveBeenCalledWith({ type: 'render_sheets', characterIds: ['ch_maya'] });
    fireEvent.click(screen.getByRole('button', { name: 'Manage photos' }));
    expect(screen.getByRole('dialog', { name: 'Maya — photos' })).toBeInTheDocument();
  });

  it('is honest when the owner is gone', () => {
    const card: Extract<Card, { type: 'refs' }> = { type: 'refs', id: 'c1', owner: { kind: 'character', id: 'gone' }, paths: [] };
    render(<RefsCard card={card} message={msg} studio={makeStudio(docWith([]))} />);
    expect(screen.getByText('That character is no longer in the story.')).toBeInTheDocument();
  });
});
