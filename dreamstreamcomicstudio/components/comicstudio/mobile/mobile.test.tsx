// Mobile helpers (mobile.md §3.10, §8, §9; decisions-final #1, #6): the back stack, image variants and
// the memory budget, the theme colour, the Easy/Pro toggle and the "saved by software" chip.

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import type { AssetRef, ComicDoc } from '../../../shared/comic/doc';
import { DEFAULT_CAPS } from '../../../shared/comic/capabilities';
import { HISTORY_LAYERS_KEY, historyLayers, openLayers, popLayer, pushLayer, resetBackStack, useBackLayer } from './backStack';
import { VARIANT_SCREEN_W, VARIANT_THUMB_W, heavyImageAttr, pickVariant, srcSetFor, variantWidthFor } from './media/imageVariants';
import { BUDGET_DEFAULT, BUDGET_LOW, releasePlan, resetImageBudget, trackedImageCount, useImageBudget } from './media/imageBudget';
import { useThemeColor } from './useThemeColor';
import { ModeToggle, MODE_HINT } from './ModeToggle';
import { SAVINGS_COPY, SavingsChip, savedEntries, savedTotal } from './SavingsChip';
import { FormFactorProvider, formFactorFor } from './useFormFactor';
import { HEADER_BANNER_MIN_ORDER, HEADER_SLOT_ORDER } from './headerSlots';
import { feature } from './index';
import { makeFakeStudio, makeSampleDoc } from '../conversation/testing/fixtures';

const PHONE = formFactorFor({ w: 390, h: 844, coarse: true });
const DESKTOP = formFactorFor({ w: 1440, h: 900 });

describe('backStack (the back gesture closes the top layer first)', () => {
  beforeEach(() => resetBackStack());
  afterEach(() => resetBackStack());

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
});

describe('mobile feature module', () => {
  it('registers the Easy/Pro and savings header slots and reserves the status pill + banner', () => {
    expect(feature.headerSlots?.map((s) => s.id)).toEqual(['mode', 'savings']);
    expect(HEADER_SLOT_ORDER.status).toBeLessThan(HEADER_SLOT_ORDER.mode);
    expect(HEADER_SLOT_ORDER.statusBanner).toBeGreaterThanOrEqual(HEADER_BANNER_MIN_ORDER);
  });
});
