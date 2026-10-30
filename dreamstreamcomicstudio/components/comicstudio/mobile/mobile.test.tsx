// Mobile helpers (mobile.md §3.10, §8, §9; decisions-final #1, #6): the back stack, image variants and
// the memory budget, the theme colour, the Easy/Pro toggle and the "saved by software" chip.

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import type { AssetRef, ComicDoc } from '../../../shared/comic/doc';
import { DEFAULT_CAPS } from '../../../shared/comic/capabilities';
import { HISTORY_LAYERS_KEY, historyLayers, layerKey, leaveLayer, openLayers, popLayer, pushLayer, resetBackStack, useBackLayer } from './backStack';
import { VARIANT_SCREEN_W, VARIANT_THUMB_W, heavyImageAttr, pickVariant, srcSetFor, variantWidthFor } from './media/imageVariants';
import { BUDGET_DEFAULT, BUDGET_LOW, releasePlan, resetImageBudget, trackedImageCount, useImageBudget } from './media/imageBudget';
import { useThemeColor } from './useThemeColor';
import { ModeToggle, MODE_HINT } from './ModeToggle';
import { SAVINGS_COPY, SavingsChip, savedEntries, savedTotal } from './SavingsChip';
import { FormFactorProvider, formFactorFor } from './useFormFactor';
import { HEADER_BANNER_MIN_ORDER, HEADER_SLOT_ORDER } from './headerSlots';
import { feature } from './index';
import { makeFakeStudio, makeSampleDoc, resetUsageStatus, showDollarPrices, showUsagePrices } from '../conversation/testing/fixtures';

const PHONE = formFactorFor({ w: 390, h: 844, coarse: true });
const DESKTOP = formFactorFor({ w: 1440, h: 900 });

describe('backStack (the back gesture closes the top layer first)', () => {
  beforeEach(() => resetBackStack());
  afterEach(() => {
    resetBackStack();
    vi.restoreAllMocks();
  });

  it('pushes one tagged history entry per layer and closes the topmost on popstate', async () => {
    const closeEditor = vi.fn();
    const closeSheet = vi.fn();
    pushLayer('page-editor', closeEditor);
    pushLayer('sheet:tools', closeSheet);
    expect(openLayers()).toEqual(['page-editor', 'sheet:tools']);
    expect(historyLayers()).toHaveLength(2);
    await act(async () => {
      window.history.back();
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(closeSheet).toHaveBeenCalledTimes(1);
    expect(closeEditor).not.toHaveBeenCalled();
    expect(openLayers()).toEqual(['page-editor']);
  });

  it('a layer closed from the UI leaves no dead history entry; a sheet opened from a closing menu reuses its entry', async () => {
    const push = vi.spyOn(window.history, 'pushState');
    const replace = vi.spyOn(window.history, 'replaceState');
    const menu = pushLayer('sheet:menu', vi.fn());
    expect(push).toHaveBeenCalledTimes(1);
    popLayer(menu);
    const next = pushLayer('sheet:quality', vi.fn()); // menu → quality in the same tick
    expect(push).toHaveBeenCalledTimes(1);
    expect(replace).toHaveBeenCalledTimes(1);
    // (history entries from earlier tests may sit below; ours is on top and the menu's is gone)
    expect(historyLayers().slice(-1)).toEqual([next]);
    expect(historyLayers()).not.toContain(menu);
    expect((window.history.state as Record<string, unknown>)[HISTORY_LAYERS_KEY]).toEqual(historyLayers());
    push.mockRestore();
    replace.mockRestore();
  });

  // Leaving from the UI and THEN acting (the readers' Close / Library / legal links, mobile-reading hotfix): the
  // layer's entry — and every entry above it — goes first, in one traversal, and the action runs on the entry under it.
  const settle = async () => {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
  };
  const openFrom = () => {
    const opening = { __leaveTest: Math.random() };
    window.history.pushState(opening, '');
    return opening;
  };

  it('leaveLayer pops the layer and the layers above it in one traversal, then acts (instead of the back close)', async () => {
    const opening = openFrom();
    const before = window.history.length;
    const closeReader = vi.fn();
    const closeFull = vi.fn();
    const reader = pushLayer('reader:c1', closeReader);
    pushLayer('fullscreen', closeFull);
    const go = vi.spyOn(window.history, 'go');
    let stateAtAction: unknown = 'not called';
    const action = vi.fn(() => {
      stateAtAction = window.history.state;
    });
    leaveLayer(reader, action);
    expect(go).toHaveBeenCalledTimes(1);
    expect(go).toHaveBeenCalledWith(-2);
    expect(action).not.toHaveBeenCalled(); // not before its entry is gone
    await settle();
    expect(action).toHaveBeenCalledTimes(1);
    expect(stateAtAction).toEqual(opening);
    expect(closeFull).toHaveBeenCalledTimes(1); // the layer above closes as usual
    expect(closeReader).not.toHaveBeenCalled(); // the action replaced the back-gesture close
    expect(openLayers()).toEqual([]);
    expect(window.history.length).toBe(before + 2);
    go.mockRestore();
  });

  it('unwinds through an entry some other script pushed above the layer, never further', async () => {
    const opening = openFrom();
    const reader = pushLayer('reader:c2', vi.fn());
    // A foreign entry that copies the state: it still lists the reader's layer.
    window.history.pushState({ ...(window.history.state as object), __foreign: 1 }, '');
    const action = vi.fn();
    leaveLayer(reader, action);
    await settle();
    await settle();
    expect(action).toHaveBeenCalledTimes(1);
    expect(window.history.state).toEqual(opening);
  });

  it('leaving again while the traversal is under way swaps the action and never goes further back', async () => {
    const opening = openFrom();
    const reader = pushLayer('reader:c3', vi.fn());
    const first = vi.fn();
    const second = vi.fn();
    leaveLayer(reader, first);
    leaveLayer(reader, second);
    await settle();
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    expect(window.history.state).toEqual(opening);
    // Already gone: a later leave acts at once, with no traversal.
    const go = vi.spyOn(window.history, 'go');
    const third = vi.fn();
    leaveLayer(reader, third);
    expect(third).toHaveBeenCalledTimes(1);
    expect(go).not.toHaveBeenCalled();
    go.mockRestore();
  });

  it('a traversal that never reports back still closes after the settle time', async () => {
    vi.useFakeTimers();
    try {
      openFrom();
      const reader = pushLayer('reader:c4', vi.fn());
      const go = vi.spyOn(window.history, 'go').mockImplementation(() => undefined);
      const action = vi.fn();
      leaveLayer(reader, action, 800);
      vi.advanceTimersByTime(799);
      expect(action).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(action).toHaveBeenCalledTimes(1);
      expect(openLayers()).toEqual([]);
      go.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });

  it('useBackLayer returns leave(action): with no open layer the action runs at once', () => {
    const action = vi.fn();
    const { result } = renderHook(() => useBackLayer(false, vi.fn(), 'reader'));
    result.current(action);
    expect(action).toHaveBeenCalledTimes(1);
  });

  it('useBackLayer registers while open and survives a StrictMode double effect', () => {
    const onClose = vi.fn();
    const { rerender, unmount } = renderHook(({ open }) => useBackLayer(open, onClose, 'reader'), {
      initialProps: { open: true },
      wrapper: React.StrictMode
    });
    expect(openLayers()).toEqual(['reader']);
    rerender({ open: false });
    expect(openLayers()).toEqual([]);
    unmount();
  });

  // Reloads (history.state survives them: pull-to-refresh, iOS evicting the tab): the entry a layer pushed comes back
  // while nothing owns it. Ids are unique per page load and a layer opening again with the same key adopts it.
  it('layer ids are unique per page load: never the bare <key>#<n> an earlier load (or build) left in history', () => {
    const a = pushLayer('sheet:a', vi.fn());
    const b = pushLayer('sheet:a', vi.fn());
    expect(a).not.toBe(b);
    expect(layerKey(a)).toBe('sheet:a');
    expect(layerKey(b)).toBe('sheet:a');
    expect(a).not.toMatch(/^sheet:a#\d+$/);
    expect(layerKey('reader:c1#1')).toBe('reader:c1');
  });

  it('after a reload, a layer adopts the entry it left behind instead of stacking a dead one under it', async () => {
    const opening = openFrom();
    window.history.pushState({ ...opening, [HISTORY_LAYERS_KEY]: ['reader:c1#1'] }, ''); // what the reload brought back
    const before = window.history.length;
    const push = vi.spyOn(window.history, 'pushState');
    const close = vi.fn();
    const id = pushLayer('reader:c1', close);
    expect(push).not.toHaveBeenCalled();
    expect(window.history.length).toBe(before);
    expect(historyLayers()).toEqual([id]);
    expect(id).not.toBe('reader:c1#1');
    push.mockRestore();
    await act(async () => {
      window.history.back();
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(close).toHaveBeenCalledTimes(1); // the first Back closes it
    expect(window.history.state).toEqual(opening);
  });

  it('the stale layers above it (a reading mode open at the reload) go with the adopted entry', () => {
    openFrom();
    window.history.pushState({ [HISTORY_LAYERS_KEY]: ['reader:c1#1'] }, '');
    window.history.pushState({ [HISTORY_LAYERS_KEY]: ['reader:c1#1', 'fullscreen#2'] }, '');
    const before = window.history.length;
    const id = pushLayer('reader:c1', vi.fn());
    expect(window.history.length).toBe(before);
    expect(historyLayers()).toEqual([id]);
  });

  it("never adopts a live layer's entry, nor a left-behind entry of another key", () => {
    openFrom();
    const before = window.history.length;
    const a = pushLayer('sheet:a', vi.fn());
    const a2 = pushLayer('sheet:a', vi.fn()); // the first one is still open: stack on it
    expect(window.history.length).toBe(before + 2);
    expect(historyLayers()).toEqual([a, a2]);
    resetBackStack();
    openFrom();
    window.history.pushState({ [HISTORY_LAYERS_KEY]: ['sheet:b#1'] }, '');
    const len = window.history.length;
    const c = pushLayer('reader:c1', vi.fn());
    expect(window.history.length).toBe(len + 1);
    expect(historyLayers()).toEqual(['sheet:b#1', c]);
  });

  it('a layer re-opened while its old entry is still being popped stacks a new entry (never adopts one about to go)', async () => {
    openFrom();
    const first = pushLayer('sheet:menu', vi.fn());
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => undefined); // the traversal has not landed yet
    popLayer(first);
    await settle(); // its deferred back() is under way
    expect(back).toHaveBeenCalledTimes(1);
    const before = window.history.length;
    const again = pushLayer('sheet:menu', vi.fn());
    expect(window.history.length).toBe(before + 1);
    expect(historyLayers()).toEqual([first, again]);
    back.mockRestore();
  });

  it('layers closed from the UI in the same tick leave in one traversal, in either order', async () => {
    for (const order of ['top first', 'bottom first'] as const) {
      const opening = openFrom();
      const reader = pushLayer('reader', vi.fn());
      const immersive = pushLayer('immersive', vi.fn());
      const go = vi.spyOn(window.history, 'go');
      const back = vi.spyOn(window.history, 'back');
      if (order === 'top first') {
        popLayer(immersive);
        popLayer(reader);
      } else {
        popLayer(reader);
        popLayer(immersive);
      }
      await settle();
      await settle();
      expect(go).toHaveBeenCalledTimes(1);
      expect(go).toHaveBeenCalledWith(-2);
      expect(back).not.toHaveBeenCalled();
      expect(window.history.state).toEqual(opening);
      go.mockRestore();
      back.mockRestore();
    }
  });

  it('a non-final leave the host ignores registers the layer again: Back and Close keep working', async () => {
    const opening = openFrom();
    const onClose = vi.fn();
    const { result } = renderHook(() => useBackLayer(true, onClose, 'reader:c5'));
    const before = window.history.length;
    const action = vi.fn();
    act(() => result.current(action, { final: false }));
    await settle();
    expect(action).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    expect(openLayers()).toEqual(['reader:c5']);
    expect(historyLayers().map(layerKey)).toEqual(['reader:c5']); // a fresh entry where the left one was
    expect(window.history.length).toBe(before);
    await act(async () => {
      window.history.back();
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(window.history.state).toEqual(opening);
  });

  it('a final leave (a close) never registers again, even when the host stays', async () => {
    const opening = openFrom();
    const { result } = renderHook(() => useBackLayer(true, vi.fn(), 'reader:c6'));
    const action = vi.fn();
    act(() => result.current(action));
    await settle();
    expect(action).toHaveBeenCalledTimes(1);
    expect(openLayers()).toEqual([]);
    expect(window.history.state).toEqual(opening);
  });

  it('a non-final leave whose action closes the host does not register again', async () => {
    const opening = openFrom();
    const { result } = renderHook(() => {
      const [open, setOpen] = React.useState(true);
      return { leave: useBackLayer(open, vi.fn(), 'reader:c7'), close: () => setOpen(false) };
    });
    act(() => result.current.leave(() => result.current.close(), { final: false }));
    await settle();
    expect(openLayers()).toEqual([]);
    expect(window.history.state).toEqual(opening);
  });
});

describe('image variants (mobile.md §8.2)', () => {
  const asset: AssetRef = {
    path: 'u/1/p/page.webp',
    w: 2048,
    h: 3072,
    source: 'generated',
    at: 0,
    variants: [
      { w: 1080, h: 1620, path: 'u/1/p/page.1080.webp' },
      { w: 480, h: 720, path: 'u/1/p/page.480.webp' }
    ]
  } as AssetRef;
  const urlFor = (a?: AssetRef | string | null, opts?: { width?: number }) => {
    const path = typeof a === 'string' ? a : a ? (opts?.width ? pickVariant(a, opts.width, 1).path : a.path) : undefined;
    return path ? `https://cdn.test/${path}` : undefined;
  };

  it('picks the smallest variant ≥ width × dpr (dpr capped at 2), else the original', () => {
    expect(pickVariant(asset, 200, 2).path).toBe('u/1/p/page.480.webp');
    expect(pickVariant(asset, 400, 2).path).toBe('u/1/p/page.1080.webp');
    expect(pickVariant(asset, 400, 3).path).toBe('u/1/p/page.1080.webp');
    expect(pickVariant(asset, 1200, 1).path).toBe('u/1/p/page.webp');
    expect(pickVariant({ ...asset, variants: undefined }, 100, 1).path).toBe('u/1/p/page.webp');
  });

  it('widths per surface: thumbnails 480, phone reader/editor 1080, original on tablets or zoomed, saveData', () => {
    const phone = { widthClass: 'compact' as const, heightClass: 'regular' as const, saveData: false };
    const tablet = { widthClass: 'medium' as const, heightClass: 'regular' as const, saveData: false };
    expect(variantWidthFor('grid', tablet)).toBe(VARIANT_THUMB_W);
    expect(variantWidthFor('reader', phone)).toBe(VARIANT_SCREEN_W);
    expect(variantWidthFor('reader', tablet)).toBeUndefined();
    expect(variantWidthFor('editor', phone, 2)).toBeUndefined();
    expect(variantWidthFor('editor', { ...phone, saveData: true })).toBe(VARIANT_THUMB_W);
    expect(variantWidthFor('reader', { ...phone, saveData: true })).toBe(VARIANT_SCREEN_W);
  });

  it('srcSetFor builds src + srcSet + sizes from signed variants', () => {
    const out = srcSetFor(asset, urlFor, { width: 240 });
    expect(out.src).toBe('https://cdn.test/u/1/p/page.480.webp');
    expect(out.srcSet).toBe('https://cdn.test/u/1/p/page.480.webp 480w, https://cdn.test/u/1/p/page.1080.webp 1080w, https://cdn.test/u/1/p/page.webp 2048w');
    expect(out.sizes).toBe('240px');
    expect(srcSetFor(null, urlFor)).toEqual({});
    expect(heavyImageAttr(undefined)).toEqual({ 'data-heavy-img': '' });
    expect(heavyImageAttr(480)).toEqual({});
  });
});

describe('image memory budget (mobile.md §8.3)', () => {
  afterEach(() => resetImageBudget(null));

  it('releasePlan: nothing under the budget; over it, everything not near the viewport', () => {
    expect(releasePlan([{ near: false }, { near: true }], 4)).toEqual([false, false]);
    expect(releasePlan([{ near: false }, { near: true }, { near: false }], 2)).toEqual([true, false, true]);
    expect(BUDGET_LOW).toBeLessThan(BUDGET_DEFAULT);
  });

  it('useImageBudget tracks heavy images and untracks on unmount', () => {
    resetImageBudget(1);
    const Img: React.FC<{ id: string }> = ({ id }) => {
      const [ref, released] = useImageBudget<HTMLDivElement>();
      return <div ref={ref} data-testid={id} data-released={String(released)} />;
    };
    const { unmount } = render(
      <>
        <Img id="a" />
        <Img id="b" />
      </>
    );
    expect(trackedImageCount()).toBe(2);
    unmount();
    expect(trackedImageCount()).toBe(0);
  });
});

describe('useThemeColor', () => {
  it('tints the browser chrome with the studio canvas and restores it after', () => {
    const meta = document.createElement('meta');
    meta.name = 'theme-color';
    meta.content = '#3B82F6';
    document.head.appendChild(meta);
    const { unmount } = renderHook(() => useThemeColor('#14120f'));
    expect(meta.content).toBe('#14120f');
    unmount();
    expect(meta.content).toBe('#3B82F6');
    meta.remove();
  });
});

describe('ModeToggle (decisions-final #1: a view, never a permission)', () => {
  it('in the regular header: Easy | Pro; picking Pro sets the view', () => {
    const studio = makeFakeStudio();
    render(
      <FormFactorProvider value={DESKTOP}>
        <ModeToggle studio={studio} />
      </FormFactorProvider>
    );
    expect(screen.getByRole('radio', { name: 'Easy' })).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(screen.getByRole('radio', { name: 'Pro' }));
    expect(studio.setMode).toHaveBeenCalledWith('pro');
  });

  it('phones and narrow tablets: nothing in the header (it lives in ⋯); the menu form explains', () => {
    const studio = makeFakeStudio();
    const { container } = render(
      <FormFactorProvider value={PHONE}>
        <ModeToggle studio={studio} />
      </FormFactorProvider>
    );
    expect(container).toBeEmptyDOMElement();
    render(
      <FormFactorProvider value={PHONE}>
        <ModeToggle studio={studio} variant="menu" />
      </FormFactorProvider>
    );
    expect(screen.getByText(MODE_HINT)).toBeInTheDocument();
  });

  it('Pro is shown as unavailable (never hidden) when the capability is off', () => {
    const studio = makeFakeStudio({ caps: { ...DEFAULT_CAPS, proEditor: false }, mode: 'pro' });
    render(
      <FormFactorProvider value={DESKTOP}>
        <ModeToggle studio={studio} />
      </FormFactorProvider>
    );
    expect(screen.getByRole('radio', { name: 'Pro' })).toBeDisabled();
    expect(screen.getByRole('radio', { name: 'Easy' })).toHaveAttribute('aria-checked', 'true');
  });
});

describe('SavingsChip (decisions-final #6)', () => {
  // Admin / own-key wording (dollars) unless a test says otherwise; governed users never see dollars.
  beforeEach(() => showDollarPrices());
  afterEach(() => resetUsageStatus());

  const docWithSavings = (saved: number): ComicDoc => {
    const doc = makeSampleDoc();
    return {
      ...doc,
      spend: {
        ...doc.spend,
        savedUsd: saved,
        entries: [{ id: 's1', kind: 'edit', label: 'Moved 3 balloons', usd: 0, at: 1, savedUsd: saved } as never, ...doc.spend.entries]
      }
    };
  };

  it('totals honestly and shows nothing when nothing was saved', () => {
    expect(savedTotal(makeSampleDoc())).toBe(0);
    expect(savedTotal(docWithSavings(0.3))).toBeCloseTo(0.3);
    expect(savedEntries(docWithSavings(0.3))).toHaveLength(1);
    const { container } = render(
      <FormFactorProvider value={DESKTOP}>
        <SavingsChip studio={{ doc: makeSampleDoc() }} />
      </FormFactorProvider>
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('a quiet chip that opens the breakdown with the copy', () => {
    render(
      <FormFactorProvider value={DESKTOP}>
        <SavingsChip studio={{ doc: docWithSavings(0.3) }} />
      </FormFactorProvider>
    );
    fireEvent.click(screen.getByRole('button', { name: /Saved \$0\.30 by software/ }));
    expect(screen.getByRole('dialog', { name: 'Saved by software' })).toHaveTextContent(SAVINGS_COPY);
    expect(screen.getByText('Moved 3 balloons')).toBeInTheDocument();
  });

  it('governed users read the saving as a share of their usage — never dollars, also before the status loads', () => {
    showUsagePrices(1);
    const { unmount } = render(
      <FormFactorProvider value={DESKTOP}>
        <SavingsChip studio={{ doc: docWithSavings(0.3) }} />
      </FormFactorProvider>
    );
    const chip = screen.getByRole('button', { name: /^Saved (≈[\d.]+%|<0\.1%) of your usage by software/ });
    expect(chip.textContent).not.toMatch(/\$/);
    fireEvent.click(chip);
    expect(screen.getByRole('dialog', { name: 'Saved by software' }).textContent).not.toMatch(/\$/);
    unmount();
    resetUsageStatus();
    render(
      <FormFactorProvider value={DESKTOP}>
        <SavingsChip studio={{ doc: docWithSavings(0.3) }} />
      </FormFactorProvider>
    );
    expect(screen.getByRole('button', { name: /^Saved some of your usage by software/ }).textContent).toBe('Saved');
  });

  it('phones: no header chip; a new saving shows the copy as a calm toast', async () => {
    const { rerender } = render(
      <FormFactorProvider value={PHONE}>
        <SavingsChip studio={{ doc: docWithSavings(0.3) }} />
      </FormFactorProvider>
    );
    expect(screen.queryByRole('button')).toBeNull();
    rerender(
      <FormFactorProvider value={PHONE}>
        <SavingsChip studio={{ doc: docWithSavings(0.5) }} />
      </FormFactorProvider>
    );
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(SAVINGS_COPY));
  });

  it('the phone toast is portalled outside the shell, so it carries the phone header size itself (it sat 4 px low)', async () => {
    const toastFor = async (ff: typeof PHONE) => {
      const { rerender, unmount } = render(
        <FormFactorProvider value={ff}>
          <SavingsChip studio={{ doc: docWithSavings(0.3) }} />
        </FormFactorProvider>
      );
      rerender(
        <FormFactorProvider value={ff}>
          <SavingsChip studio={{ doc: docWithSavings(0.5) }} />
        </FormFactorProvider>
      );
      const toast = await waitFor(() => screen.getByRole('status'));
      const out = { parent: toast.parentElement, header: toast.style.getPropertyValue('--header-h'), top: toast.style.top };
      unmount();
      return out;
    };
    const portrait = await toastFor(PHONE);
    expect(portrait.parent).toBe(document.body);
    expect(portrait.header).toBe('44px');
    expect(portrait.top).toBe('calc(var(--sa-top, 0px) + var(--header-h, 48px) + 8px)');
    // Phones in landscape keep index.css's compact-height header (no override).
    const landscape = await toastFor(formFactorFor({ w: 852, h: 393, coarse: true }));
    expect(landscape.header).toBe('');
  });
});

describe('mobile feature module', () => {
  it('registers the Easy/Pro and savings header slots and reserves the status pill + banner', () => {
    expect(feature.headerSlots?.map((s) => s.id)).toEqual(['mode', 'savings']);
    expect(HEADER_SLOT_ORDER.status).toBeLessThan(HEADER_SLOT_ORDER.mode);
    expect(HEADER_SLOT_ORDER.statusBanner).toBeGreaterThanOrEqual(HEADER_BANNER_MIN_ORDER);
  });
});
