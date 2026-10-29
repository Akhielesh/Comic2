import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { BoardTab } from '../types';
// Built-in tabs only: feature tabs (Media, Languages) have their own registry tests (features.test.tsx).
// Feature tabs are injected per test through `mocks.tabs` (empty by default).
const mocks = vi.hoisted(() => ({ tabs: [] as unknown[] }));
vi.mock('../features', async (importOriginal) => ({ ...(await importOriginal<typeof import('../features')>()), registeredTabs: () => mocks.tabs }));

import { DEFAULT_CAPS } from '../../../shared/comic/capabilities';
import { BoardPane, boardTabsFor } from './BoardPane';
import { SAMPLE_NOW, makeSampleDoc, makeStudio } from './__fixtures__/sampleDoc';
import { FormFactorProvider, formFactorFor } from '../mobile/useFormFactor';
import { openLayers, resetBackStack } from '../mobile/backStack';

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(SAMPLE_NOW);
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('BoardPane', () => {
  it('shows the five tabs with live counts', () => {
    render(<BoardPane studio={makeStudio()} />);
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual(['Story', 'Cast3', 'Style✓', 'Pages1/6', 'Read']);
    expect(screen.getByRole('tab', { name: /Pages/ })).toHaveAttribute('aria-selected', 'true');
  });

  it('switches tabs by click and with the arrow keys (wrapping, Home/End)', () => {
    const studio = makeStudio(makeSampleDoc(), { tab: 'pages' });
    render(<BoardPane studio={studio} />);
    fireEvent.click(screen.getByRole('tab', { name: /Story/ }));
    expect(studio.setTab).toHaveBeenLastCalledWith('story');
    const pages = screen.getByRole('tab', { name: /Pages/ });
    fireEvent.keyDown(pages, { key: 'ArrowRight' });
    expect(studio.setTab).toHaveBeenLastCalledWith('read');
    fireEvent.keyDown(pages, { key: 'ArrowLeft' });
    expect(studio.setTab).toHaveBeenLastCalledWith('style');
    fireEvent.keyDown(pages, { key: 'Home' });
    expect(studio.setTab).toHaveBeenLastCalledWith('story');
    fireEvent.keyDown(pages, { key: 'End' });
    expect(studio.setTab).toHaveBeenLastCalledWith('read');
  });

  it.each<[BoardTab, RegExp | string]>([
    ['story', 'Notes the comic follows'],
    ['cast', /Cast · 3/],
    ['style', 'Your style'],
    ['pages', 'Plan draft — review the scripts, then render'],
    // The Read tab's own toolbar (the inline reader's counter text belongs to ComicReaderView).
    ['read', 'Read full screen']
  ])('renders the %s tab', (tab, marker) => {
    render(<BoardPane studio={makeStudio(makeSampleDoc(), { tab })} />);
    const panel = screen.getByRole('tabpanel');
    expect(within(panel).getAllByText(marker).length).toBeGreaterThan(0);
  });

  it('answers an open spend gate right on the board', () => {
    const doc = makeSampleDoc((d) => {
      d.gate = {
        id: 'gate_1',
        action: { type: 'render_pages' },
        title: 'Draw 3 pages',
        summary: '3 pages',
        estimateUsd: 0.2,
        imageCount: 3,
        model: 'Nano Banana 2.1',
        createdAt: SAMPLE_NOW,
        status: 'open',
        reason: 'policy'
      };
    });
    const studio = makeStudio(doc, { caps: { ...DEFAULT_CAPS, byok: true } });
    render(<BoardPane studio={studio} />);
    const banner = screen.getByRole('region', { name: 'Waiting for your approval' });
    expect(banner).toHaveTextContent('Draw 3 pages');
    expect(banner).toHaveTextContent('≈ $0.20');
    fireEvent.click(within(banner).getByRole('button', { name: 'Approve' }));
    expect(studio.act).toHaveBeenCalledWith({ type: 'approve_gate', gateId: 'gate_1' });
  });

  it('a governed user reads the gate as a share of their usage, never dollars', () => {
    const doc = makeSampleDoc((d) => {
      d.gate = { id: 'gate_g', action: { type: 'render_pages' }, title: 'Draw 3 pages', summary: '', estimateUsd: 0.2, imageCount: 3, model: 'x', createdAt: SAMPLE_NOW, status: 'open', reason: 'policy' };
    });
    render(<BoardPane studio={makeStudio(doc, { caps: { ...DEFAULT_CAPS, usage: { governed: true, pctLeft: 50, exhausted: false, pctPerStandardPage: 1 } } })} />);
    const banner = screen.getByRole('region', { name: 'Waiting for your approval' });
    expect(banner).toHaveTextContent(/% of your usage/);
    expect(banner).not.toHaveTextContent('$');
  });

  it('names the model by its nickname, never the raw provider route (visualqa P0-1)', () => {
    const doc = makeSampleDoc((d) => {
      d.gate = {
        id: 'gate_2',
        action: { type: 'render_pages' },
        title: 'Draw 2 pages',
        summary: '2 pages',
        estimateUsd: 0.14,
        imageCount: 2,
        model: 'google/gemini-nano-banana-2.1',
        createdAt: SAMPLE_NOW,
        status: 'open',
        reason: 'policy'
      };
    });
    render(<BoardPane studio={makeStudio(doc)} />);
    const banner = screen.getByRole('region', { name: 'Waiting for your approval' });
    expect(banner).toHaveTextContent('2 images on Nano Banana 2.1');
    expect(banner).not.toHaveTextContent('google/gemini-nano-banana-2.1');
  });

  it('declines a gate', () => {
    const doc = makeSampleDoc((d) => {
      d.gate = { id: 'g2', action: { type: 'render_cover' }, title: 'Cover', summary: '', estimateUsd: 0.07, imageCount: 1, model: 'x', createdAt: 0, status: 'open', reason: 'budget' };
    });
    const studio = makeStudio(doc);
    render(<BoardPane studio={studio} />);
    expect(screen.getByRole('region', { name: 'Waiting for your approval' })).toHaveTextContent('over your budget cap');
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
    expect(studio.act).toHaveBeenCalledWith({ type: 'decline_gate', gateId: 'g2' });
  });

  it('opens the page editor for the focused page', () => {
    render(<BoardPane studio={makeStudio(makeSampleDoc(), { focusedPageId: 'pg_5' })} />);
    expect(screen.getByRole('dialog', { name: 'Page 5 editor' })).toBeInTheDocument();
  });

  it('closes a focused page that left the plan', () => {
    const studio = makeStudio(makeSampleDoc(), { focusedPageId: 'pg_gone' });
    render(<BoardPane studio={studio} />);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(studio.openPage).toHaveBeenCalledWith(null);
  });

  it('Read: the reader owns the only scroller (no nested scrolling inside the board)', () => {
    const { rerender } = render(<BoardPane studio={makeStudio(makeSampleDoc(), { tab: 'read' })} />);
    const panel = screen.getByRole('tabpanel');
    expect(panel).toHaveAttribute('data-board-scroll', 'reader');
    expect(panel.className).toContain('overflow-hidden');
    expect(panel.className).not.toContain('overflow-y-auto');
    rerender(<BoardPane studio={makeStudio(makeSampleDoc(), { tab: 'story' })} />);
    expect(screen.getByRole('tabpanel').className).toContain('overflow-y-auto');
  });

  it('shows skeletons while loading and a retry on a load error', () => {
    const { unmount } = render(<BoardPane studio={makeStudio(null, { loading: true })} />);
    expect(screen.queryAllByRole('tab')).toHaveLength(0);
    unmount();
    const studio = makeStudio(null, { loadError: "This comic doesn't exist or you don't have access to it." });
    render(<BoardPane studio={studio} />);
    expect(screen.getByRole('alert')).toHaveTextContent("This comic doesn't exist");
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(studio.refresh).toHaveBeenCalled();
  });
});

describe('BoardPane on a phone (visualqa P1-6, P1-7; mobile.md §3.1)', () => {
  const PHONE = formFactorFor({ w: 360, h: 740, coarse: true });
  const gated = () =>
    makeSampleDoc((d) => {
      d.gate = {
        id: 'gate_9',
        action: { type: 'render_pages' },
        title: 'Draw the remaining 5 pages in the painted style',
        summary: '5 pages',
        estimateUsd: 1.31,
        imageCount: 5,
        model: 'nano-banana-2.1-a-very-long-model-identifier-for-layout-tests',
        createdAt: SAMPLE_NOW,
        status: 'open',
        reason: 'policy'
      };
    });
  const atPhone = (studio: ReturnType<typeof makeStudio>) =>
    render(
      <FormFactorProvider value={PHONE}>
        <BoardPane studio={studio} />
      </FormFactorProvider>
    );

  afterEach(() => resetBackStack());

  it('the spend gate is ONE compact line pinned above the scroller; details on demand; still answerable', () => {
    const studio = makeStudio(gated());
    atPhone(studio);
    const banner = screen.getByRole('region', { name: 'Waiting for your approval' });
    expect(banner).toHaveAttribute('data-gate-banner', 'compact');
    // Pinned: it sits outside (above) the scrolling tab panel, so it never scrolls away.
    expect(screen.getByRole('tabpanel').contains(banner)).toBe(false);
    expect(within(banner).getByText('Draw the remaining 5 pages in the painted style').className).toContain('truncate');
    expect(within(banner).queryByText(/very-long-model-identifier/)).toBeNull();
    fireEvent.click(within(banner).getByRole('button', { name: /Show details/ }));
    expect(within(banner).getByText(/5 images on nano-banana-2\.1-a-very-long-model-identifier/).className).toContain('[overflow-wrap:anywhere]');
    fireEvent.click(within(banner).getByRole('button', { name: 'Approve' }));
    expect(studio.act).toHaveBeenCalledWith({ type: 'approve_gate', gateId: 'gate_9' });
  });

  it('the tab strip scrolls inside itself with snap, keeps the active chip in view, and drops inactive badges below 380 px', () => {
    const spy = vi.fn();
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = spy;
    try {
      const studio = makeStudio(makeSampleDoc(), { tab: 'pages' });
      const { rerender } = atPhone(studio);
      const strip = screen.getByRole('tablist', { name: 'Board' });
      expect(strip).toHaveAttribute('data-tab-strip');
      expect(strip.className).toContain('overflow-x-auto');
      expect(strip.className).toContain('snap-x');
      expect(strip.className).toContain('min-w-0');
      // Inactive Cast loses its badge at 360; the active Pages tab keeps "1/6".
      expect(screen.getByRole('tab', { name: 'Cast' })).toBeInTheDocument();
      expect(screen.getByRole('tab', { name: /Pages/ })).toHaveTextContent('1/6');
      for (const t of screen.getAllByRole('tab')) expect(t.className).toContain('coarse:min-h-[44px]');
      expect(spy).toHaveBeenCalled();
      spy.mockClear();
      rerender(
        <FormFactorProvider value={PHONE}>
          <BoardPane studio={{ ...studio, tab: 'read' }} />
        </FormFactorProvider>
      );
      expect(spy).toHaveBeenCalledWith({ inline: 'nearest', block: 'nearest' });
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });

  it('leaves a dock slot at the foot of the board for the book timeline', () => {
    atPhone(makeStudio(makeSampleDoc()));
    const dock = document.querySelector('[data-board-dock]');
    expect(dock).not.toBeNull();
    expect(screen.getByRole('tabpanel').compareDocumentPosition(dock as Node) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('the back gesture closes the page editor before it leaves the studio', () => {
    atPhone(makeStudio(makeSampleDoc(), { focusedPageId: 'pg_5' }));
    expect(openLayers()).toContain('page-editor');
  });
});

describe('BoardPane feature tabs and dock (wave 2)', () => {
  afterEach(() => {
    mocks.tabs = [];
    resetBackStack();
  });

  const languages = {
    id: 'languages',
    label: 'Languages',
    order: 800,
    icon: null,
    Component: () => <p>Languages panel</p>,
    visible: () => false
  };

  it('a feature tab shows only while visible — but the tab the user is ON stays listed and rendered', () => {
    mocks.tabs = [languages];
    const doc = makeSampleDoc();
    expect(boardTabsFor(doc, DEFAULT_CAPS).map((t) => t.id)).not.toContain('languages');
    expect(boardTabsFor(doc, DEFAULT_CAPS, 'languages').map((t) => t.id)).toContain('languages');
    render(<BoardPane studio={makeStudio(doc, { tab: 'languages' })} />);
    expect(screen.getByRole('tab', { name: 'Languages' })).toHaveAttribute('aria-selected', 'true');
    expect(within(screen.getByRole('tabpanel')).getByText('Languages panel')).toBeInTheDocument();
  });

  it('a visibility check that throws never breaks the board', () => {
    mocks.tabs = [{ ...languages, visible: () => { throw new Error('boom'); } }];
    render(<BoardPane studio={makeStudio()} />);
    expect(screen.queryByRole('tab', { name: 'Languages' })).toBeNull();
  });

  it('the book timeline docks at the foot, but not in Read (the reader owns the pane)', () => {
    const { unmount } = render(<BoardPane studio={makeStudio(makeSampleDoc(), { tab: 'pages' })} />);
    expect(document.querySelector('[data-board-dock] [aria-label="Book timeline"]')).not.toBeNull();
    unmount();
    render(<BoardPane studio={makeStudio(makeSampleDoc(), { tab: 'read' })} />);
    expect(document.querySelector('[data-board-dock] [aria-label="Book timeline"]')).toBeNull();
  });

  it('a landscape phone (short board) gets the one-line gate so it never covers the Pages grid', () => {
    const doc = makeSampleDoc((d) => {
      d.gate = { id: 'g_l', action: { type: 'render_pages' }, title: 'Draw 2 pages', summary: '', estimateUsd: 0.1, imageCount: 2, model: 'x', createdAt: SAMPLE_NOW, status: 'open', reason: 'policy' };
    });
    render(
      <FormFactorProvider value={formFactorFor({ w: 734, h: 343, coarse: true })}>
        <BoardPane studio={makeStudio(doc)} />
      </FormFactorProvider>
    );
    expect(screen.getByRole('region', { name: 'Waiting for your approval' })).toHaveAttribute('data-gate-banner', 'compact');
  });

  it('a landscape phone: the tab row and the one-line gate drop their outer padding (the panel keeps the height)', () => {
    const doc = makeSampleDoc((d) => {
      d.gate = { id: 'g_d', action: { type: 'render_pages' }, title: 'Draw 2 pages', summary: '', estimateUsd: 0.1, imageCount: 2, model: 'x', createdAt: SAMPLE_NOW, status: 'open', reason: 'policy' };
    });
    const { unmount } = render(
      <FormFactorProvider value={formFactorFor({ w: 734, h: 343, coarse: true })}>
        <BoardPane studio={makeStudio(doc)} />
      </FormFactorProvider>
    );
    const row = screen.getByRole('tablist', { name: 'Board' }).parentElement as HTMLElement;
    expect(row).toHaveAttribute('data-board-tabs', 'dense');
    expect(row.className).toMatch(/\bpy-0\.5\b/);
    expect(row.className).not.toMatch(/\bsm:py-2\b/);
    const gate = screen.getByRole('region', { name: 'Waiting for your approval' });
    expect(gate.className).toMatch(/\bmt-1\b/);
    expect(gate.className).toMatch(/\bpy-0\b/);
    unmount();
    // A portrait phone keeps the roomier spacing.
    render(
      <FormFactorProvider value={formFactorFor({ w: 360, h: 740, coarse: true })}>
        <BoardPane studio={makeStudio(doc)} />
      </FormFactorProvider>
    );
    expect(screen.getByRole('tablist', { name: 'Board' }).parentElement).not.toHaveAttribute('data-board-tabs');
    expect(screen.getByRole('region', { name: 'Waiting for your approval' }).className).toMatch(/\bmt-2\b/);
  });
});
