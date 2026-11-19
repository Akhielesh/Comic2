// quick2 Q-PROG: a run of several pages reads as ONE compact progress card in the chat, not one loading tile per page.
// "Drawing pages · 3 of 8", a thin determinate bar, the page drawing now, and one strip of small thumbnails that fill in
// as pages finish; a failure is one quiet line in the same card; per-page rows wait behind "Details"; a finished run
// is one line ("8 pages drawn · View") with nothing left moving. Everything is read from the stored doc, so a remount
// (the studio reloading the doc) shows the same card.
import React from 'react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { AssetRef, Card, ComicDoc, Page, RenderState } from '../../../../shared/comic/doc';
import { jobModel } from '../../board/boardModel';
import { registerStudioRefresh } from '../../board/ui';
import type { ComicStudioController } from '../../useStudio';
import { CardRenderer } from './CardRenderer';
import { resetRendersDetails, retryAllFailed } from './RendersCard';
import { TILE_CLOCK_MS } from './renderTile';
import { makeFakeStudio, makeSampleDoc, resetUsageStatus, showDollarPrices, showUsagePrices } from '../testing/fixtures';

const T0 = 1_780_000_000_000;

type Phase = 'drawn' | 'drawing' | 'queued' | 'failed' | 'none';

const stored = (name: string): AssetRef => ({
  path: `u/x/p/${name}.png`,
  w: 1536,
  h: 1920,
  source: 'generated',
  at: T0,
  variants: [
    { path: `u/x/p/${name}_w480.webp`, w: 480, h: 600 },
    { path: `u/x/p/${name}_w1080.webp`, w: 1080, h: 1350 }
  ]
});

const renderOf = (phase: Phase, id: string, since = T0): RenderState => {
  switch (phase) {
    case 'drawn':
      return { status: 'ready', history: [], asset: stored(id), updatedAt: T0 - 60_000 };
    case 'drawing':
      return { status: 'rendering', history: [], updatedAt: since };
    case 'queued':
      return { status: 'queued', history: [], updatedAt: since };
    case 'failed':
      return { status: 'failed', history: [], error: 'Provider said 429: rate limited', updatedAt: T0 - 30_000 };
    default:
      return { status: 'none', history: [] };
  }
};

/** The sample comic stretched to `phases.length` pages, each in its phase. */
const runDoc = (phases: Phase[]): ComicDoc => {
  const base = makeSampleDoc();
  const template = base.pages[0];
  const pages: Page[] = phases.map((phase, i) => ({ ...template, id: `pg_${i + 1}`, n: i + 1, render: renderOf(phase, `pg_${i + 1}`) }));
  return { ...base, pages };
};

const runCard = (doc: ComicDoc, label = 'Drawing pages 1–8'): Card => ({ type: 'renders', id: 'card_run', label, targets: doc.pages.map((p) => ({ kind: 'page' as const, id: p.id })) });

/** The signer's contract: a width picks the smallest stored variant (≤ 480w for a chat thumbnail). */
const urlFor = (asset?: AssetRef | string | null, opts?: { width?: number }) => {
  if (!asset) return undefined;
  if (typeof asset === 'string') return `https://cdn.test/${asset}`;
  const small = opts?.width && asset.variants?.length ? asset.variants[0].path : asset.path;
  return `https://cdn.test/${small}`;
};

const MID: Phase[] = ['drawn', 'drawn', 'drawn', 'drawing', 'drawing', 'queued', 'queued', 'queued'];

const show = (doc: ComicDoc, card: Card = runCard(doc), extra: Partial<ComicStudioController> = {}) => {
  const studio = makeFakeStudio({ doc, urlFor, ...extra });
  const utils = render(<CardRenderer card={card} studio={studio} />);
  return { studio, ...utils };
};

beforeEach(() => {
  resetRendersDetails();
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'] });
  vi.setSystemTime(T0 + 12_000);
  showDollarPrices();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetUsageStatus();
});

describe('several pages drawing at once', () => {
  it('eight pages in flight render ONE compact card, not eight loading tiles', () => {
    const doc = runDoc(MID);
    const { container } = show(doc);
    const cards = container.querySelectorAll('[data-renders-progress]');
    expect(cards).toHaveLength(1);
    const card = cards[0] as HTMLElement;
    // One line says where the run is: what, how far, and the page drawing now.
    expect(card.querySelector('[data-progress-headline]')).toHaveTextContent(/^Drawing pages · 3 of 8 · pages 4 and 5 · 12s$/);
    // One thin determinate bar.
    const bar = within(card).getByRole('progressbar');
    expect(bar).toHaveAttribute('aria-valuenow', '3');
    expect(bar).toHaveAttribute('aria-valuemax', '8');
    expect(bar).toHaveAccessibleName(/Drawing pages/);
    expect(container.querySelectorAll('[role=progressbar]')).toHaveLength(1);
    // No per-page loading tiles: no shimmer, no "Drawing…" / "Queued" pills, no sweeping bars, no time lines per tile.
    expect(container.querySelector('.studio-shimmer')).toBeNull();
    expect(container.querySelector('[data-progress-bar]')).toBeNull();
    expect(container.querySelector('[data-tile-progress]')).toBeNull();
    expect(screen.queryByText('Drawing…')).toBeNull();
    expect(screen.queryByText('Queued')).toBeNull();
    // At most one live pulse in the view.
    expect(container.querySelectorAll('.ds-live-dot').length).toBeLessThanOrEqual(1);
    // One strip of small thumbnails in a single row that scrolls, never a grid that wraps.
    const strip = within(card).getByRole('list', { name: 'Pages in this run' });
    expect(within(strip).getAllByRole('listitem')).toHaveLength(8);
    expect(strip.className).toMatch(/\bflex-nowrap\b/);
    expect(strip.className).toMatch(/\boverflow-x-auto\b/);
    expect(strip.className).not.toMatch(/\bgrid\b/);
    // The three drawn pages fill in as small (480w) lazy pictures; the rest are still placeholders.
    const imgs = [...strip.querySelectorAll('img')];
    expect(imgs).toHaveLength(3);
    for (const img of imgs) {
      expect(img.getAttribute('src')).toMatch(/_w480\.webp$/);
      expect(img).toHaveAttribute('loading', 'lazy');
    }
  });

  it('per-page rows wait behind Details (collapsed by default)', () => {
    const doc = runDoc(MID);
    show(doc);
    expect(screen.queryByRole('list', { name: 'Each page' })).toBeNull();
    const details = screen.getByRole('button', { name: /Details/ });
    expect(details).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(details);
    expect(details).toHaveAttribute('aria-expanded', 'true');
    const rows = within(screen.getByRole('list', { name: 'Each page' })).getAllByRole('listitem');
    expect(rows).toHaveLength(8);
    expect(rows[0]).toHaveTextContent('Page 1');
    expect(rows[0]).toHaveTextContent('Drawn');
    expect(rows[3]).toHaveTextContent('Drawing');
    expect(rows[3]).toHaveTextContent('12s · usually ~20s');
    expect(rows[5]).toHaveTextContent('Waiting');
    // The model is named once, on the first page drawing.
    expect(screen.getAllByText(new RegExp(jobModel(doc, 'page').nickname))).toHaveLength(1);
  });

  it('a drawn thumbnail opens its page', () => {
    const doc = runDoc(MID);
    const { studio } = show(doc);
    fireEvent.click(screen.getByRole('button', { name: 'Open page 2' }));
    expect(studio.openPage).toHaveBeenCalledWith('pg_2');
  });

  it('one clock for the card: it ticks without the network and stops once nothing draws', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const doc = runDoc(MID);
    const { container, rerender, studio } = show(doc);
    act(() => void vi.advanceTimersByTime(5 * TILE_CLOCK_MS));
    expect(container.querySelector('[data-progress-headline]')).toHaveTextContent('· 17s');
    const done = runDoc(MID.map(() => 'drawn'));
    rerender(<CardRenderer card={runCard(done)} studio={{ ...studio, doc: done } as ComicStudioController} />);
    expect(vi.getTimerCount()).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('a page far past its usual time says so once, with a free Check again', () => {
    const refresh = vi.fn();
    const off = registerStudioRefresh(refresh);
    try {
      const doc = runDoc(['drawn', 'drawing', 'queued']);
      vi.setSystemTime(T0 + 201_000);
      const intervals = vi.spyOn(globalThis, 'setInterval');
      const { container } = show(doc);
      expect(screen.getByText(/Page 2 is taking much longer than usual/)).toBeInTheDocument();
      expect(container.querySelector('.ds-live-dot')).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
      expect(refresh).toHaveBeenCalledTimes(1);
      // The clock stays stopped: a stuck run never ticks (and Check again is a tap, never a timer).
      expect(intervals).not.toHaveBeenCalled();
    } finally {
      off();
    }
  });
});

describe('when the run finishes', () => {
  it('the card settles to one line ("8 pages drawn · View") with no spinners or pictures left', () => {
    const doc = runDoc(MID);
    const { container, rerender, studio } = show(doc);
    expect(container.querySelector('[data-renders-progress]')).not.toBeNull();
    const done = runDoc(MID.map(() => 'drawn'));
    const doneStudio = { ...studio, doc: done } as ComicStudioController;
    rerender(<CardRenderer card={runCard(done)} studio={doneStudio} />);
    expect(container.querySelector('[data-renders-progress]')).toBeNull();
    const line = container.querySelector('[data-renders-done]') as HTMLElement;
    expect(line).not.toBeNull();
    expect(line).toHaveTextContent(/^8 pages drawn\s*View/);
    expect(container.querySelector('[role=progressbar]')).toBeNull();
    expect(container.querySelector('.ds-live-dot')).toBeNull();
    expect(container.querySelector('.animate-spin')).toBeNull();
    expect(container.querySelector('.studio-shimmer')).toBeNull();
    expect(container.querySelectorAll('img')).toHaveLength(0);
    fireEvent.click(within(line).getByRole('button', { name: /View/ }));
    expect(studio.setTab).toHaveBeenCalledWith('pages');
  });

  it('a run that was stopped says how many were drawn', () => {
    const doc = runDoc(['drawn', 'drawn', 'drawn', 'drawn', 'drawn', 'drawn', 'none', 'none']);
    const { container } = show(doc);
    expect(container.querySelector('[data-renders-done]')).toHaveTextContent(/^6 of 8 pages drawn · 2 not drawn\s*View/);
  });
});

describe('a page that did not draw', () => {
  const FAILED: Phase[] = ['drawn', 'drawn', 'drawn', 'drawn', 'failed', 'drawing', 'queued', 'queued'];

  it('is one quiet line inside the same card, never a failure tile', () => {
    const doc = runDoc(FAILED);
    const { container } = show(doc);
    expect(container.querySelectorAll('[data-renders-progress]')).toHaveLength(1);
    const line = container.querySelector('[data-renders-failed]') as HTMLElement;
    expect(line).toHaveTextContent(/Page 5 didn’t draw · rate limited/);
    expect(screen.getAllByText(/didn’t draw/)).toHaveLength(1);
    expect(container.querySelector('[data-failed]')).toBeNull();
    // The rest of the run is still drawing: Retry waits for it (the studio draws one run at a time).
    const retry = within(line).getByRole('button', { name: 'Retry page 5' });
    expect(retry).toBeDisabled();
    // The provider's words are under Details, not on the card.
    expect(line).not.toHaveTextContent(/Provider said/);
    fireEvent.click(screen.getByRole('button', { name: /Details/ }));
    expect(within(screen.getByRole('list', { name: 'Each page' })).getAllByRole('listitem')[4]).toHaveTextContent(/Provider said 429/);
  });

  it('Retry redraws only the failed pages, with an honest quote, once the rest have finished', () => {
    const doc = runDoc(['drawn', 'drawn', 'drawn', 'drawn', 'failed', 'drawn', 'failed', 'drawn']);
    const { container, studio } = show(doc);
    expect(container.querySelector('[data-renders-done]')).toHaveTextContent(/^6 of 8 pages drawn/);
    const line = container.querySelector('[data-renders-failed]') as HTMLElement;
    expect(line).toHaveTextContent(/Pages 5 and 7 didn’t draw/);
    const expected = retryAllFailed(doc, [{ target: { kind: 'page', id: 'pg_5' } }, { target: { kind: 'page', id: 'pg_7' } }], false);
    const retry = within(line).getByRole('button', { name: 'Retry 2 failed pages' });
    expect(retry).toBeEnabled();
    expect(line).toHaveTextContent(/≈ \$/);
    fireEvent.click(retry);
    expect(studio.act).toHaveBeenCalledWith(expected.actions[0]);
    expect(expected.actions[0]).toMatchObject({ type: 'render_pages', pageIds: ['pg_5', 'pg_7'], force: true });
  });

  it('governed users read the retry in usage words, never dollars', () => {
    resetUsageStatus();
    showUsagePrices();
    const doc = runDoc(['drawn', 'failed', 'drawn']);
    const { container } = show(doc);
    expect(container.querySelector('[data-renders-failed]')).not.toBeNull();
    expect(container.textContent).not.toMatch(/[$¢]/);
  });
});

describe('remount mid-batch (the studio reloads the doc)', () => {
  it('a fresh mount over the stored doc shows the same card, and Details stays as the creator left it', () => {
    const doc = runDoc(MID);
    const first = show(doc);
    fireEvent.click(screen.getByRole('button', { name: /Details/ }));
    const before = first.container.querySelector('[data-progress-headline]')!.textContent;
    first.unmount();

    // The reload hands back a new doc object with the same stored state.
    const reloaded = JSON.parse(JSON.stringify(doc)) as ComicDoc;
    const second = show(reloaded);
    expect(second.container.querySelectorAll('[data-renders-progress]')).toHaveLength(1);
    expect(second.container.querySelector('[data-progress-headline]')!.textContent).toBe(before);
    expect(screen.getByRole('button', { name: /Details/ })).toHaveAttribute('aria-expanded', 'true');
    expect(within(screen.getByRole('list', { name: 'Pages in this run' })).getAllByRole('listitem')).toHaveLength(8);
    second.unmount();

    // A later reload, after two more pages landed, picks up where the run is now.
    const later = runDoc(['drawn', 'drawn', 'drawn', 'drawn', 'drawn', 'drawing', 'queued', 'queued']);
    const third = show(later);
    expect(third.container.querySelector('[data-progress-headline]')).toHaveTextContent(/Drawing pages · 5 of 8 · page 6/);
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '5');
  });
});

describe('one page', () => {
  it('no "1 of 1" and no bar: just the page, then one line', () => {
    const doc = runDoc(['drawn', 'drawing', 'drawn']);
    const card: Card = { type: 'renders', id: 'card_one', label: 'Drawing page 2', targets: [{ kind: 'page', id: 'pg_2' }] };
    const { container, rerender, studio } = show(doc, card);
    expect(container.querySelectorAll('[data-renders-progress]')).toHaveLength(1);
    expect(container.querySelector('[role=progressbar]')).toBeNull();
    expect(container.textContent).not.toMatch(/\bof 1\b/);
    expect(container.querySelector('[data-progress-headline]')).toHaveTextContent(/^Drawing page 2 · 12s$/);
    expect(screen.queryByRole('list', { name: 'Pages in this run' })).toBeNull();
    expect(container.querySelectorAll('[data-progress-thumb]')).toHaveLength(1);
    expect(screen.queryByRole('button', { name: /Details/ })).toBeNull();

    const done = runDoc(['drawn', 'drawn', 'drawn']);
    rerender(<CardRenderer card={card} studio={{ ...studio, doc: done } as ComicStudioController} />);
    const line = container.querySelector('[data-renders-done]') as HTMLElement;
    expect(line).toHaveTextContent(/^Page 2 drawn\s*View/);
    fireEvent.click(within(line).getByRole('button', { name: /View/ }));
    expect(studio.openPage).toHaveBeenCalledWith('pg_2');
  });

  it('a single page that failed is one line with Retry', () => {
    const doc = runDoc(['drawn', 'failed']);
    const card: Card = { type: 'renders', id: 'card_one', label: 'Drawing page 2', targets: [{ kind: 'page', id: 'pg_2' }] };
    const { container } = show(doc, card);
    expect(container.querySelector('[data-renders-failed]')).toHaveTextContent(/Page 2 didn’t draw · rate limited/);
    expect(screen.getByRole('button', { name: 'Retry page 2' })).toBeEnabled();
    expect(container.textContent).not.toMatch(/\bof 1\b/);
  });
});

describe('other runs read the same way', () => {
  it('pages and the cover; sheets; style options', () => {
    const doc = runDoc(['drawn', 'drawing', 'queued']);
    doc.cover = { ...doc.cover, render: { status: 'queued', history: [], updatedAt: T0 } };
    const withCover: Card = { type: 'renders', id: 'card_cover', label: 'Drawing pages 1–3 and the cover', targets: [...doc.pages.map((p) => ({ kind: 'page' as const, id: p.id })), { kind: 'cover' as const }] };
    const a = show(doc, withCover);
    expect(a.container.querySelector('[data-progress-headline]')).toHaveTextContent(/^Drawing the pages and cover · 1 of 4 · page 2/);
    a.unmount();

    const sheets = makeSampleDoc();
    sheets.cast = sheets.cast.map((c, i) => ({ ...c, sheet: i === 0 ? { status: 'ready', history: [], asset: stored('maya'), updatedAt: T0 } : { status: 'rendering', history: [], updatedAt: T0 } }));
    const b = show(sheets, { type: 'renders', id: 'card_sheets', label: 'Drawing 3 sheets', targets: sheets.cast.map((c) => ({ kind: 'sheet' as const, id: c.id })) });
    expect(b.container.querySelector('[data-progress-headline]')).toHaveTextContent(/^Drawing character sheets · 1 of 3 · Arjun and Vendor/);
    b.unmount();

    const styles = makeSampleDoc(); // opt_a drawn, opt_b drawing, opt_c failed
    const c = show(styles, { type: 'renders', id: 'card_styles', label: 'Drawing 3 style options', targets: styles.style.options.map((o) => ({ kind: 'style_option' as const, id: o.id })) });
    expect(c.container.querySelector('[data-progress-headline]')).toHaveTextContent(/^Drawing style options · 1 of 3 · Pastel/);
    expect(c.container.querySelector('[data-renders-failed]')).toHaveTextContent(/“Retro” didn’t draw/);
  });

  it('targets removed from the comic say so', () => {
    const doc = runDoc(['drawn']);
    const { container } = show(doc, { type: 'renders', id: 'gone', label: 'Drawing pages', targets: [{ kind: 'page', id: 'nope' }] });
    expect(container).toHaveTextContent('These images were removed from the comic.');
  });
});

describe('the card follows the house rules', () => {
  it('44 px targets on touch: Details, Retry, View, Check again and every thumbnail', () => {
    const doc = runDoc(['drawn', 'drawn', 'failed', 'drawing', 'queued']);
    show(doc);
    // The controls are ds Buttons (44 px tall under a coarse pointer: the density token); thumbnails are 56 px tall.
    for (const name of [/Details/, /Retry page 3/]) {
      expect(screen.getByRole('button', { name }).className).toMatch(/coarse:min-h-\[var\(--ds-density-touch\)\]/);
    }
    for (const thumb of document.querySelectorAll('[data-progress-thumb]')) expect(thumb.className).toMatch(/\bh-14\b.*\bmin-w-11\b|\bmin-w-11\b.*\bh-14\b/);
    expect(screen.getByRole('button', { name: 'Open page 1' })).toHaveAttribute('data-progress-thumb');
  });

  it('tokens only: no spelled colours, radii or durations in the card', () => {
    const source = readFileSync(path.resolve(process.cwd(), 'components/comicstudio/conversation/cards/RendersCard.tsx'), 'utf8');
    expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(source).not.toMatch(/\b(?:text|bg|border)-(?:red|amber|green|orange|yellow|blue|slate|gray|zinc)-\d/);
    expect(source).not.toMatch(/\brounded-(?:lg|xl|2xl|3xl)\b/);
    expect(source).not.toMatch(/\bduration-\d/);
    expect(source).not.toMatch(/studio-shimmer/);
  });
});
