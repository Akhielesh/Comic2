import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { DEFAULT_CAPS } from '../../../shared/comic/capabilities';
import type { ComicDoc, Gate } from '../../../shared/comic/doc';
import { ACCENT_FILL } from '../../chat/studioDesign';
import { formatUsd } from '../../../shared/comic/models';
import { quoteRenderPages } from '../../../shared/comic/plan';
import { layoutFitFix } from '../../../shared/comic/layoutFit';
import { splitHeldBack } from '../../../shared/comic/pagePlanCheck';
import type { Page } from '../../../shared/comic/doc';
import { PagesTab, DENSITY_KEY } from './PagesTab';
import { byokFromDoc, estimateDraw, estimateOne, pagesForIds, pagesToDraw } from './boardModel';
import { SAMPLE_NOW, asset, makeSampleDoc, makeStudio } from './__fixtures__/sampleDoc';

const card = (n: number) => screen.getByRole('article', { name: `Page ${n}` });
/** An own-key studio: prices are real dollars. */
const dollarStudio = (doc = makeSampleDoc()) => makeStudio(doc, { caps: { ...DEFAULT_CAPS, byok: true } });
const governedStudio = (doc = makeSampleDoc()) => makeStudio(doc, { caps: { ...DEFAULT_CAPS, usage: { governed: true, pctLeft: 70, exhausted: false, pctPerStandardPage: 1.5 } } });
/** An approval as the server stores it; the board's banner above the tab shows its title, price and Approve. */
const gateFor = (action: Gate['action'], status: Gate['status'] = 'open'): Gate => ({
  id: 'gate_1',
  action,
  title: 'Draw 3 pages',
  summary: '3 pages',
  estimateUsd: 0.2,
  imageCount: 3,
  model: 'Nano Banana 2.1',
  createdAt: SAMPLE_NOW,
  status,
  reason: 'policy'
});
const gatedDoc = (gate: Gate) => makeSampleDoc((d) => (d.gate = gate));
/** The Pages header: the plan line, the draw-all and its price, the cover option, the selection bar. */
const header = () => document.querySelector('[data-pages-header]') as HTMLElement;
const DRAW_ALL = /^(Approve & render all|Render (all|remaining))/;
type RenderPagesAction = Extract<Gate['action'], { type: 'render_pages' }>;
/** What an open page-render approval draws, by the run's own rule (the quote's targets). */
const gateDraws = (doc: ComicDoc, a: RenderPagesAction) =>
  quoteRenderPages(doc, { pageIds: a.pageIds, force: a.force, includeCover: a.includeCover, byok: true, tier: doc.settings.quality, modelOverride: doc.settings.imageModelOverride });
/** Every price a card prints next to its own draw button (`price-<page id>`, `price-cover`), in grid order. */
const cardPrices = () => Array.from(document.querySelectorAll('[data-pages-grid] [id^="price-"]')).map((el) => el.id);
const WAITING = 'Waiting for your OK above';
/** A primary (accent-filled) button: while an approval is open its Approve is the screen's only one. */
const isPrimary = (el: Element) => el.className.split(/\s+/).includes(ACCENT_FILL);

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(SAMPLE_NOW);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new TypeError('offline');
    })
  );
  try {
    localStorage.removeItem(DENSITY_KEY);
  } catch {
    /* no storage */
  }
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('PagesTab', () => {
  it('shows every page in its state', () => {
    const studio = makeStudio();
    render(<PagesTab studio={studio} doc={studio.doc!} />);
    const states = screen.getAllByTestId('page-card').map((el) => el.getAttribute('data-status'));
    expect(states).toEqual(['ready', 'planned', 'queued', 'rendering', 'stale', 'failed']);
  });

  it('planned pages show their script — the plan comes before pixels', () => {
    const studio = makeStudio();
    render(<PagesTab studio={studio} doc={studio.doc!} />);
    const planned = card(2);
    expect(within(planned).getByText('The spice market at dawn, stalls opening under striped awnings.')).toBeInTheDocument();
    expect(within(planned).getByText('“You owe me an explanation, Maya.”')).toBeInTheDocument();
    expect(within(planned).getAllByText(/Arjun/).length).toBeGreaterThan(0);
  });

  it('drawn pages show the art with balloons, asking for the ≤ 480w variant', () => {
    const studio = makeStudio();
    render(<PagesTab studio={studio} doc={studio.doc!} />);
    const ready = card(1);
    expect(within(ready).getByRole('img', { name: /Page 1/ })).toHaveAttribute('src', 'https://cdn.test/u/proj/pages/p1.png');
    expect(ready.querySelectorAll('[data-testid="balloon"]').length).toBe(5);
    const widths = (studio.urlFor as ReturnType<typeof vi.fn>).mock.calls.filter(([a]) => (a as { path?: string })?.path === 'u/proj/pages/p1.png').map(([, o]) => (o as { width?: number })?.width);
    expect(widths.length).toBeGreaterThan(0);
    for (const w of widths) expect(w).toBeLessThanOrEqual(480);
  });

  it('the art is a pointer shortcut only: keyboard users get a named Edit button (no nested interactive)', () => {
    const studio = makeStudio();
    render(<PagesTab studio={studio} doc={studio.doc!} />);
    expect(within(card(1)).queryByRole('button', { name: 'Open page 1 in the editor' })).toBeNull();
    fireEvent.click(within(card(1)).getByTestId('page-art'));
    expect(studio.openPage).toHaveBeenCalledWith('pg_1');
    fireEvent.click(within(card(1)).getByRole('button', { name: 'Edit page 1' }));
    expect(studio.openPage).toHaveBeenCalledTimes(2);
  });

  it('queued and drawing pages show progress with the model and a clock', () => {
    const studio = makeStudio();
    render(<PagesTab studio={studio} doc={studio.doc!} />);
    expect(within(card(3)).getByText(/Queued · Nano Banana 2.1/)).toBeInTheDocument();
    expect(within(card(4)).getByText(/Drawing · 12s · Nano Banana 2.1/)).toBeInTheDocument();
  });

  it('a drawing page is calm: its status chip and its overlay keep a static dot and the word, nothing pulses (C9)', () => {
    const studio = makeStudio();
    const { container } = render(<PagesTab studio={studio} doc={studio.doc!} />);
    const drawing = card(4);
    expect(drawing).toHaveAttribute('data-status', 'rendering');
    // The words carry the state: the chip says Drawing, the overlay says Drawing with its clock.
    expect(within(drawing).getByText('Drawing')).toBeInTheDocument();
    expect(within(drawing).getByText(/^Drawing · 12s/)).toBeInTheDocument();
    // Both dots are still there (the chip's and the overlay pill's), and neither moves.
    const dots = Array.from(drawing.querySelectorAll('span[aria-hidden]')).filter((el) => /\bh-1\.5 w-1\.5 rounded-full\b/.test(el.getAttribute('class') || ''));
    expect(dots).toHaveLength(2);
    for (const dot of dots) expect(dot.getAttribute('class')).not.toMatch(/animate-/);
    expect(container.querySelectorAll('[class*="animate-pulse"]')).toHaveLength(0);
  });

  it('stale pages carry the amber badge and a re-render with its price', () => {
    const studio = dollarStudio();
    render(<PagesTab studio={studio} doc={studio.doc!} />);
    const stale = card(5);
    expect(within(stale).getByText('Out of date — re-render')).toBeInTheDocument();
    const button = within(stale).getByRole('button', { name: /^Re-render/ });
    const price = estimateDraw(studio.doc!, pagesForIds(studio.doc!, ['pg_5']), true).estimate.usd;
    expect(document.getElementById(button.getAttribute('aria-describedby')!)).toHaveTextContent(`≈ ${formatUsd(price)}`);
    fireEvent.click(button);
    expect(studio.act).toHaveBeenCalledWith({ type: 'render_pages', pageIds: ['pg_5'], force: true });
  });

  it('failed pages are calm: when and why, the exact words under Details, and Retry (2026-10-22 incident)', () => {
    const studio = makeStudio();
    render(<PagesTab studio={studio} doc={studio.doc!} />);
    const failed = card(6);
    const status = within(failed).getByRole('group', { name: /Page 6: failed \d\d:\d\d · timed out/ });
    expect(status).not.toHaveTextContent('The image model timed out.');
    expect(within(failed).queryByRole('alert')).toBeNull();
    fireEvent.click(within(status).getByRole('button', { name: 'Details' }));
    expect(status).toHaveTextContent('The image model timed out.');
    fireEvent.click(within(failed).getByRole('button', { name: /Retry/ }));
    expect(studio.act).toHaveBeenCalledWith({ type: 'render_pages', pageIds: ['pg_6'], force: true });
  });

  it('a failure with provider facts shows them under Details', () => {
    const doc = makeSampleDoc((d) => {
      d.pages[5].render = {
        status: 'failed',
        history: [],
        error: 'The provider is busy right now.',
        errorDetail: { code: '429', provider: 'OpenRouter', at: SAMPLE_NOW - 5 * 60_000, text: 'OpenRouter · 429 · upstream Google · 17:42 UTC' },
        attempts: 2,
        updatedAt: SAMPLE_NOW
      };
    });
    render(<PagesTab studio={makeStudio(doc)} doc={doc} />);
    const status = within(card(6)).getByRole('group', { name: /Page 6: failed .* · rate limited/ });
    fireEvent.click(within(status).getByRole('button', { name: 'Details' }));
    expect(status).toHaveTextContent('OpenRouter · 429');
    expect(status).toHaveTextContent('after 2 tries');
  });

  it('planned pages render on demand', () => {
    const studio = makeStudio();
    render(<PagesTab studio={studio} doc={studio.doc!} />);
    fireEvent.click(within(card(2)).getByRole('button', { name: /^Render/ }));
    expect(studio.act).toHaveBeenCalledWith({ type: 'render_pages', pageIds: ['pg_2'], force: true });
  });

  it('asks for review while the plan is a draft and prices "render all" honestly', () => {
    const studio = dollarStudio();
    const doc = studio.doc!;
    render(<PagesTab studio={studio} doc={doc} />);
    expect(screen.getByText('Plan draft — review the scripts, then render')).toBeInTheDocument();
    const expected = estimateDraw(doc, pagesToDraw(doc), byokFromDoc(doc)).estimate.usd;
    const button = screen.getByRole('button', { name: 'Approve & render all' });
    expect(document.getElementById(button.getAttribute('aria-describedby')!)).toHaveTextContent(`≈ ${formatUsd(expected)}`);
    fireEvent.click(button);
    expect(studio.act).toHaveBeenCalledWith({ type: 'render_pages' });
    fireEvent.click(screen.getByRole('button', { name: 'Approve plan only' }));
    expect(studio.act).toHaveBeenCalledWith({ type: 'approve_plan' });
  });

  describe('pages whose words do not fit their panels (the plan check holds them back from Render all)', () => {
    const WORDS = 'listen the carrier behind those flower stalls has no plates and nobody has unloaded anything since morning'.split(' ');
    const said = (n: number) => Array.from({ length: n }, (_, i) => WORDS[i % WORDS.length]).join(' ');
    /** Overfull: three small panels, each with far more words than it holds. */
    const overfill = (doc: ComicDoc, id: string) => {
      const page = doc.pages.find((p) => p.id === id)!;
      page.layout = 'Row 1: three small panels.';
      page.panels = page.panels.map((pn, i) => ({ ...pn, size: 'small', lines: [{ id: `ln_over_${id}_${i}`, kind: 'speech', speakerId: 'ch_maya', text: said(60) }] }));
    };
    const allQuote = (doc: ComicDoc) => quoteRenderPages(doc, { byok: true, tier: doc.settings.quality, modelOverride: doc.settings.imageModelOverride, holdBack: {} });

    it('the button names what it draws, the price leaves the held-back page out, and the note says which and why', () => {
      const doc = makeSampleDoc((d) => {
        overfill(d, 'pg_2');
        d.planStatus = 'approved';
      });
      const studio = dollarStudio(doc);
      render(<PagesTab studio={studio} doc={doc} />);
      const quote = allQuote(doc);
      expect(quote.heldBackIds).toEqual(['pg_2']);
      expect(quote.pageIds).toEqual(['pg_5', 'pg_6']);
      const button = within(header()).getByRole('button', { name: 'Render 2 pages' });
      const note = document.getElementById(button.getAttribute('aria-describedby')!)!;
      expect(note).toHaveTextContent(`≈ ${formatUsd(quote.usd)}`);
      expect(note).toHaveTextContent('page 2 is held back — too much text for its panels');
      expect(within(header()).queryByRole('button', { name: /remaining/ })).toBeNull();
      // The run is the server's Render all (it holds the same page back and offers the free fixes).
      fireEvent.click(button);
      expect(studio.act).toHaveBeenCalledWith({ type: 'render_pages' });
    });

    it('in a draft the approval counts the pages too', () => {
      const doc = makeSampleDoc((d) => overfill(d, 'pg_2'));
      render(<PagesTab studio={dollarStudio(doc)} doc={doc} />);
      expect(within(header()).getByRole('button', { name: 'Approve & render 2 pages' })).toBeInTheDocument();
    });

    it('every page left is held back: no draw button and no price, a plain line and the way on', () => {
      const doc = makeSampleDoc((d) => {
        for (const id of ['pg_2', 'pg_5', 'pg_6']) overfill(d, id);
        d.planStatus = 'approved';
      });
      const studio = dollarStudio(doc);
      render(<PagesTab studio={studio} doc={doc} />);
      expect(allQuote(doc)).toMatchObject({ pageIds: [], nothing: true, heldBackIds: ['pg_2', 'pg_5', 'pg_6'] });
      expect(within(header()).queryByRole('button', { name: DRAW_ALL })).toBeNull();
      expect(within(header()).queryByRole('button', { name: /^Render/ })).toBeNull();
      expect(document.getElementById('pages-draw-all-price')).toBeNull();
      expect(header()).toHaveTextContent('Pages 2, 5 and 6 are held back — too much text for their panels. Fit the words, or draw them anyway from the page.');
      expect(header().textContent).not.toContain('$');
      fireEvent.click(within(header()).getByRole('button', { name: 'Open page 2' }));
      expect(studio.openPage).toHaveBeenCalledWith('pg_2');
      expect(studio.act).not.toHaveBeenCalled();
    });

    it('every page left is held back and a layout fits: the free fix is offered first, and it only patches', async () => {
      const say = (n: number, seed = 0) => Array.from({ length: n }, (_, i) => WORDS[(seed + i) % WORDS.length]).join(' ');
      const sp = (id: string, n: number, seed = 0) => ({ id, kind: 'speech' as const, speakerId: 'ch_maya', text: say(n, seed) });
      const pn = (n: number, over: Partial<Page['panels'][number]>): Page['panels'][number] => ({ id: `pg_2_p${n}`, n, size: 'medium', shot: 'medium', action: `Beat ${n}.`, castIds: ['ch_maya'], lines: [], ...over });
      const doc = makeSampleDoc((d) => {
        const p2 = d.pages.find((p) => p.id === 'pg_2')!;
        // Two equal / one wide / three small: panels 5 and 6 are too full for their small cells, and a blueprint fits.
        p2.layout = 'Row 1: two equal panels. Row 2: one wide panel. Row 3: three small panels.';
        p2.panels = [
          pn(1, { shot: 'wide', lines: [sp('l1', 10)] }),
          pn(2, { lines: [{ id: 'l2', kind: 'sfx', text: 'BZZT' }] }),
          pn(3, { size: 'wide', shot: 'wide' }),
          pn(4, { size: 'small', shot: 'insert', castIds: [], lines: [{ id: 'l4', kind: 'sfx', text: 'CLICK' }] }),
          pn(5, { size: 'small', shot: 'close_up', lines: [sp('l5', 17, 3)] }),
          pn(6, { size: 'small', lines: [sp('l6a', 15, 5), sp('l6b', 14, 9)] })
        ];
        d.pages = d.pages.filter((p) => p.id === 'pg_1' || p.id === 'pg_2');
        d.planStatus = 'approved';
      });
      const layout = splitHeldBack(doc, ['pg_2']).heldBack[0]?.layoutFix;
      const ops = layoutFitFix(doc, doc.pages.find((p) => p.id === 'pg_2')!, layout);
      expect(ops).not.toBeNull();
      expect(allQuote(doc)).toMatchObject({ pageIds: [], heldBackIds: ['pg_2'] });
      const studio = dollarStudio(doc);
      render(<PagesTab studio={studio} doc={doc} />);
      fireEvent.click(within(header()).getByRole('button', { name: /^Use the layout that fits page 2/ }));
      await new Promise((r) => setTimeout(r, 0));
      expect(studio.patch).toHaveBeenCalledWith(ops, { label: 'Use the layout that fits' });
      expect(studio.act).not.toHaveBeenCalled();
    });

    it('governed: the held-back words beside a share of the usage, never dollars', () => {
      const doc = makeSampleDoc((d) => overfill(d, 'pg_2'));
      const { container } = render(<PagesTab studio={governedStudio(doc)} doc={doc} />);
      expect(document.getElementById('pages-draw-all-price')).toHaveTextContent(/% of your usage.*page 2 is held back/);
      expect(container.textContent).not.toContain('$');
    });
  });

  it('"Include the cover" adds the cover to the draw-all, quoted like the server gate', () => {
    const studio = dollarStudio();
    const doc = studio.doc!;
    render(<PagesTab studio={studio} doc={doc} />);
    fireEvent.click(screen.getByRole('checkbox', { name: /Include the cover/ }));
    const quote = quoteRenderPages(doc, { includeCover: true, byok: true, tier: doc.settings.quality, modelOverride: doc.settings.imageModelOverride });
    expect(quote.cover).toBe(true);
    const button = screen.getByRole('button', { name: 'Approve & render all' });
    const note = document.getElementById(button.getAttribute('aria-describedby')!);
    expect(note).toHaveTextContent(`≈ ${formatUsd(quote.usd)}`);
    expect(note).toHaveTextContent('the cover');
    fireEvent.click(button);
    expect(studio.act).toHaveBeenCalledWith({ type: 'render_pages', includeCover: true });
  });

  it('while a page-render approval is open, the banner above holds its one price: no Draw-all, no second price, one muted line', () => {
    for (const studio of [dollarStudio(gatedDoc(gateFor({ type: 'render_pages' }))), governedStudio(gatedDoc(gateFor({ type: 'render_pages' })))]) {
      const { unmount } = render(<PagesTab studio={studio} doc={studio.doc!} />);
      expect(screen.queryByRole('button', { name: DRAW_ALL })).toBeNull();
      expect(document.getElementById('pages-draw-all-price')).toBeNull();
      // The cover option belongs to the draw-all (and carries its own price): it waits with it.
      expect(screen.queryByRole('checkbox', { name: /Include the cover/ })).toBeNull();
      const line = within(header()).getByText('Waiting for your OK above');
      expect(line.className).toContain('text-[var(--ds-muted)]');
      // No price of any kind in the header: never "$", never usage words.
      expect(header().textContent).not.toMatch(/\$|¢|usage/);
      // The free plan approval stays; it spends nothing.
      expect(within(header()).getByRole('button', { name: 'Approve plan only' })).toBeInTheDocument();
      unmount();
    }
  });

  it('while a page-render approval is open, the cards it draws print no price and no draw button of their own; cards outside it keep theirs', () => {
    const action: RenderPagesAction = { type: 'render_pages' };
    for (const make of [dollarStudio, governedStudio]) {
      const studio = make(gatedDoc(gateFor(action)));
      const doc = studio.doc!;
      const { unmount } = render(<PagesTab studio={studio} doc={doc} />);
      const inGate = gateDraws(doc, action).pageIds;
      // Render all draws the planned, out-of-date and failed pages (not the drawn page 1, not the two busy ones).
      expect(inGate).toEqual(['pg_2', 'pg_5', 'pg_6']);
      for (const id of inGate) {
        const c = card(doc.pages.find((p) => p.id === id)!.n);
        expect(within(c).getByText(WAITING).className).toContain('text-[var(--ds-muted)]');
        expect(within(c).queryByRole('button', { name: /^(Render|Retry|Re-render)/ })).toBeNull();
        expect(c.textContent).not.toMatch(/\$|¢|usage/);
      }
      // One price per spend: only the spends outside the approval keep their own price (page 1's re-render, the cover).
      expect(cardPrices()).toEqual(['price-cover', 'price-pg_1']);
      expect(within(card(1)).getByRole('button', { name: /^Re-render/ })).toBeInTheDocument();
      for (const n of [1, 3, 4]) expect(within(card(n)).queryByText(WAITING)).toBeNull();
      unmount();
    }
  });

  it('an approval that also draws the cover: the cover card waits too, without its price', () => {
    const studio = dollarStudio(gatedDoc(gateFor({ type: 'render_pages', includeCover: true })));
    render(<PagesTab studio={studio} doc={studio.doc!} />);
    expect(gateDraws(studio.doc!, { type: 'render_pages', includeCover: true }).cover).toBe(true);
    const cover = screen.getByTestId('cover-card');
    expect(within(cover).getByText(WAITING)).toBeInTheDocument();
    expect(within(cover).queryByRole('button', { name: /Design cover|Redesign/ })).toBeNull();
    expect(cardPrices()).toEqual(['price-pg_1']);
  });

  it('an approval for chosen pages: only those wait; the others keep their price, and no card button is primary beside Approve', () => {
    const action: RenderPagesAction = { type: 'render_pages', pageIds: ['pg_6'], force: true };
    const studio = dollarStudio(gatedDoc(gateFor(action)));
    render(<PagesTab studio={studio} doc={studio.doc!} />);
    expect(gateDraws(studio.doc!, action).pageIds).toEqual(['pg_6']);
    expect(within(card(6)).getByText(WAITING)).toBeInTheDocument();
    expect(within(card(6)).queryByRole('button', { name: /^Retry/ })).toBeNull();
    expect(cardPrices()).toEqual(['price-cover', 'price-pg_1', 'price-pg_2', 'price-pg_5']);
    // The out-of-date page 5 is its own spend (its price stays), but it steps back while the approval is open.
    const rerender = within(card(5)).getByRole('button', { name: /^Re-render/ });
    expect(document.getElementById(rerender.getAttribute('aria-describedby')!)).toHaveTextContent(/≈ \$\d/);
    expect(isPrimary(rerender)).toBe(false);
  });

  it('with no approval open the failed and out-of-date cards keep their primary Retry / Re-render', () => {
    const studio = dollarStudio();
    render(<PagesTab studio={studio} doc={studio.doc!} />);
    expect(isPrimary(within(card(6)).getByRole('button', { name: /^Retry/ }))).toBe(true);
    expect(isPrimary(within(card(5)).getByRole('button', { name: /^Re-render/ }))).toBe(true);
    expect(cardPrices()).toEqual(['price-cover', 'price-pg_1', 'price-pg_2', 'price-pg_5', 'price-pg_6']);
  });

  it('while a page-render approval is open, a selection cannot start a second priced render: the bar waits too', () => {
    for (const make of [dollarStudio, governedStudio]) {
      const studio = make(gatedDoc(gateFor({ type: 'render_pages' })));
      const { unmount } = render(<PagesTab studio={studio} doc={studio.doc!} />);
      fireEvent.click(screen.getByRole('checkbox', { name: 'Select page 2' }));
      const region = screen.getByRole('region', { name: 'Selected pages' });
      expect(region).toHaveTextContent('1 page selected');
      expect(within(region).getByText(WAITING).className).toContain('text-[var(--ds-muted)]');
      expect(within(region).queryByRole('button', { name: /Render selected/ })).toBeNull();
      expect(document.getElementById('pages-selected-price')).toBeNull();
      // No price and no primary button anywhere in the header: the banner's Approve is the one.
      expect(header().textContent).not.toMatch(/\$|¢|usage/);
      expect(Array.from(header().querySelectorAll('button')).filter(isPrimary)).toEqual([]);
      fireEvent.click(within(region).getByRole('button', { name: 'Clear' }));
      expect(screen.queryByRole('region', { name: 'Selected pages' })).toBeNull();
      unmount();
    }
  });

  it('while another approval is open (character sheets), Render selected keeps its price but steps back from primary', () => {
    const studio = dollarStudio(gatedDoc(gateFor({ type: 'render_sheets' })));
    render(<PagesTab studio={studio} doc={studio.doc!} />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select page 2' }));
    const region = screen.getByRole('region', { name: 'Selected pages' });
    const button = within(region).getByRole('button', { name: /Render selected/ });
    expect(isPrimary(button)).toBe(false);
    expect(document.getElementById(button.getAttribute('aria-describedby')!)).toHaveTextContent(/≈ \$\d/);
    expect(within(region).queryByText(WAITING)).toBeNull();
    expect(cardPrices()).toEqual(['price-cover', 'price-pg_1', 'price-pg_2', 'price-pg_5', 'price-pg_6']);
  });

  it('an open approval for something else (character sheets) keeps the Draw-all and its price', () => {
    const studio = dollarStudio(gatedDoc(gateFor({ type: 'render_sheets' })));
    render(<PagesTab studio={studio} doc={studio.doc!} />);
    const button = screen.getByRole('button', { name: 'Approve & render all' });
    expect(document.getElementById(button.getAttribute('aria-describedby')!)).toHaveTextContent(/≈ \$\d/);
    expect(screen.getByRole('checkbox', { name: /Include the cover/ })).toBeInTheDocument();
    expect(screen.queryByText('Waiting for your OK above')).toBeNull();
  });

  it.each(['approved', 'declined'] as const)('a %s page-render approval is closed: the Pages header is as without one', (status) => {
    const studio = dollarStudio(gatedDoc(gateFor({ type: 'render_pages' }, status)));
    render(<PagesTab studio={studio} doc={studio.doc!} />);
    const button = screen.getByRole('button', { name: 'Approve & render all' });
    expect(document.getElementById(button.getAttribute('aria-describedby')!)).toHaveTextContent(/≈ \$\d/);
    expect(screen.getByRole('checkbox', { name: /Include the cover/ })).toBeInTheDocument();
    expect(screen.queryByText('Waiting for your OK above')).toBeNull();
    // The cards are as without one too: every card that can draw prints its own price, and Retry is primary again.
    expect(cardPrices()).toEqual(['price-cover', 'price-pg_1', 'price-pg_2', 'price-pg_5', 'price-pg_6']);
    expect(isPrimary(within(card(6)).getByRole('button', { name: /^Retry/ }))).toBe(true);
  });

  it('with no approval open the header has no waiting line', () => {
    const studio = dollarStudio();
    render(<PagesTab studio={studio} doc={studio.doc!} />);
    expect(within(header()).getByRole('button', { name: 'Approve & render all' })).toBeInTheDocument();
    expect(screen.queryByText('Waiting for your OK above')).toBeNull();
  });

  it('governed users never see dollars on the Pages tab', () => {
    const studio = governedStudio();
    const { container } = render(<PagesTab studio={studio} doc={studio.doc!} />);
    expect(container).toHaveTextContent(/% of your usage/);
    expect(container.textContent).not.toMatch(/\$\d/);
  });

  it('after approval it reports progress and offers the remaining pages', () => {
    const studio = makeStudio(makeSampleDoc((d) => (d.planStatus = 'approved')));
    render(<PagesTab studio={studio} doc={studio.doc!} />);
    expect(screen.getByText('1 of 6 pages drawn')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Render remaining 3/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve plan only' })).toBeNull();
  });

  it('renders a selection of pages (skipping ones already drawing)', () => {
    const studio = dollarStudio();
    const doc = studio.doc!;
    render(<PagesTab studio={studio} doc={doc} />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select page 1' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select page 3' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select page 5' }));
    const region = screen.getByRole('region', { name: 'Selected pages' });
    expect(region).toHaveTextContent('3 pages selected');
    const price = estimateDraw(doc, pagesForIds(doc, ['pg_1', 'pg_5']), byokFromDoc(doc)).estimate.usd;
    expect(region).toHaveTextContent(formatUsd(price));
    fireEvent.click(within(region).getByRole('button', { name: /Render selected/ }));
    expect(studio.act).toHaveBeenCalledWith({ type: 'render_pages', pageIds: ['pg_1', 'pg_5'], force: true });
    expect(screen.queryByRole('region', { name: 'Selected pages' })).toBeNull();
  });

  it('flips a drawn page to its script and back', () => {
    const studio = makeStudio();
    render(<PagesTab studio={studio} doc={studio.doc!} />);
    fireEvent.click(within(card(1)).getByRole('button', { name: 'Show the script' }));
    expect(within(card(1)).getByText('Maya slips a saffron tin into her satchel.')).toBeInTheDocument();
    fireEvent.click(within(card(1)).getByRole('button', { name: 'Show the art' }));
    expect(within(card(1)).getByRole('img', { name: /Page 1/ })).toBeInTheDocument();
  });

  it('leads with the cover and designs it on request', () => {
    const studio = dollarStudio();
    const doc = studio.doc!;
    render(<PagesTab studio={studio} doc={doc} />);
    const cover = screen.getByTestId('cover-card');
    expect(cover.compareDocumentPosition(card(1)) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const price = estimateOne(doc, 'cover', byokFromDoc(doc)).usd;
    expect(cover).toHaveTextContent(`≈ ${formatUsd(price)}`);
    fireEvent.click(within(cover).getByRole('button', { name: /Design cover/ }));
    expect(studio.act).toHaveBeenCalledWith({ type: 'render_cover' });
  });

  it('a textless cover shows its typed title on the art, and the empty card says how the title is made', () => {
    const drawn = (lettering?: 'overlay') =>
      makeSampleDoc((d) => {
        if (lettering) d.cover.lettering = lettering;
        d.cover.render = { status: 'ready', history: [], asset: asset('u/proj/cover.png', { w: 1000, h: 1500 }) };
      });
    const overlay = drawn('overlay');
    const { unmount } = render(<PagesTab studio={makeStudio(overlay)} doc={overlay} />);
    const cover = screen.getByTestId('cover-card');
    expect(within(cover).getByRole('img', { name: /^Cover of/ })).toBeInTheDocument();
    expect(within(cover).getByTestId('cover-title')).toBeInTheDocument();
    unmount();
    const painted = drawn();
    const second = render(<PagesTab studio={makeStudio(painted)} doc={painted} />);
    expect(within(screen.getByTestId('cover-card')).queryByTestId('cover-title')).toBeNull();
    second.unmount();
    const empty = makeSampleDoc((d) => (d.cover.lettering = 'overlay'));
    render(<PagesTab studio={makeStudio(empty)} doc={empty} />);
    const blank = screen.getByTestId('cover-card');
    expect(blank).toHaveTextContent('The title is typed over the art, so you can change it for free.');
    expect(blank).not.toHaveTextContent('lettered in');
    expect(within(blank).queryByTestId('cover-title')).toBeNull();
  });

  it('edits the cover text', () => {
    const studio = makeStudio();
    render(<PagesTab studio={studio} doc={studio.doc!} />);
    fireEvent.click(screen.getByRole('button', { name: /Cover text/ }));
    const tagline = screen.getByLabelText('Tagline');
    fireEvent.focus(tagline);
    fireEvent.change(tagline, { target: { value: 'One tin. One chance.' } });
    fireEvent.blur(tagline);
    expect(studio.patch).toHaveBeenCalledWith([{ op: 'cover', patch: { tagline: 'One tin. One chance.' } }]);
  });

  it('art drawn at the wrong shape says so, with a free Fit', () => {
    const doc = makeSampleDoc((d) => {
      d.pages[0].render.asset = asset('u/proj/pages/p1.png', { w: 1024, h: 1024 });
    });
    const studio = makeStudio(doc);
    render(<PagesTab studio={studio} doc={doc} />);
    expect(within(card(1)).getByText('1:1 · book is 2:3')).toBeInTheDocument();
    fireEvent.click(within(card(1)).getByRole('button', { name: /Fit to 2:3/ }));
    expect(studio.act).toHaveBeenCalledWith({ type: 'fit_render', target: { kind: 'page', id: 'pg_1' }, mode: 'auto' });
  });

  it('a blocked page is never an <img>: Redraw safer and Check again', () => {
    const doc = makeSampleDoc((d) => {
      d.pages[0].render.asset = asset('u/proj/pages/p1.png', { w: 1000, h: 1500, safety: { assessed: 'X', by: 'check', at: SAMPLE_NOW } });
    });
    const studio = makeStudio(doc);
    render(<PagesTab studio={studio} doc={doc} />);
    expect(within(card(1)).queryByRole('img', { name: /Page 1/ })).toBeNull();
    expect(within(card(1)).getByRole('img', { name: 'Image withheld' })).toBeInTheDocument();
    expect(studio.urlFor).not.toHaveBeenCalledWith(expect.objectContaining({ path: 'u/proj/pages/p1.png' }), expect.anything());
    fireEvent.click(within(card(1)).getByRole('button', { name: /^Redraw safer/ }));
    expect(studio.act).toHaveBeenCalledWith({ type: 'render_pages', pageIds: ['pg_1'], force: true, safe: true });
    fireEvent.click(within(card(1)).getByRole('button', { name: 'Check again' }));
    expect(studio.act).toHaveBeenCalledWith({ type: 'safety_recheck', target: { kind: 'page', id: 'pg_1' } });
  });

  it('"Redraw safer" carries its price for THIS user: usage terms when governed, dollars on their own key', () => {
    const blocked = () =>
      makeSampleDoc((d) => {
        d.pages[0].render.asset = asset('u/proj/pages/p1.png', { w: 1000, h: 1500, safety: { assessed: 'X', by: 'check', at: SAMPLE_NOW } });
        d.cover.render = { status: 'ready', history: [], asset: asset('u/proj/cover.png', { w: 1000, h: 1500, safety: { assessed: 'X', by: 'check', at: SAMPLE_NOW } }) };
      });
    const governed = governedStudio(blocked());
    const { unmount } = render(<PagesTab studio={governed} doc={governed.doc!} />);
    const pageSafer = within(card(1)).getByRole('button', { name: /^Redraw safer/ });
    expect(pageSafer).toHaveTextContent(/^Redraw safer · .*% of your usage$/);
    expect(pageSafer).not.toHaveTextContent('$');
    const coverSafer = within(screen.getByTestId('cover-card')).getByRole('button', { name: /^Redraw safer/ });
    expect(coverSafer).toHaveTextContent(/% of your usage$/);
    expect(coverSafer).not.toHaveTextContent('$');
    unmount();

    const own = dollarStudio(blocked());
    render(<PagesTab studio={own} doc={own.doc!} />);
    expect(within(card(1)).getByRole('button', { name: /^Redraw safer/ })).toHaveTextContent(/^Redraw safer · ≈ \$\d/);
    expect(within(screen.getByTestId('cover-card')).getByRole('button', { name: /^Redraw safer/ })).toHaveTextContent(/^Redraw safer · ≈ \$\d/);
  });

  it('an over-rating page is blurred behind the veil with a way to change the rating', () => {
    const doc = makeSampleDoc((d) => {
      d.brief.audience = 'kids 6-9';
      d.pages[0].render.asset = asset('u/proj/pages/p1.png', { w: 1000, h: 1500, safety: { assessed: 'PG-13', by: 'check', at: SAMPLE_NOW } });
    });
    const studio = makeStudio(doc);
    render(<PagesTab studio={studio} doc={doc} />);
    expect(within(card(1)).getByText(/Rated PG-13 — your comic is PG/)).toBeInTheDocument();
    fireEvent.click(within(card(1)).getByRole('button', { name: 'Change rating' }));
    expect(studio.setTab).toHaveBeenCalledWith('story');
  });

  it('every card has the clip menu (⋯ and right-click / long-press): duplicate is free with an undo toast', () => {
    const studio = makeStudio();
    render(<PagesTab studio={studio} doc={studio.doc!} />);
    fireEvent.click(within(card(1)).getByRole('button', { name: 'Page 1 actions' }));
    const menu = screen.getByRole('menu', { name: 'Page 1 actions' });
    fireEvent.click(within(menu).getByRole('menuitem', { name: /Duplicate/ }));
    const [ops, opts] = (studio.patch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(ops).toEqual([{ op: 'page_duplicate', id: 'pg_1', newId: expect.stringMatching(/^pg_/) }]);
    expect(opts).toMatchObject({ label: 'Duplicate page' });
    expect(screen.getByText('Copied page 1')).toBeInTheDocument();

    fireEvent.contextMenu(card(2));
    expect(screen.getByRole('menu', { name: 'Page 2 actions' })).toBeInTheDocument();
  });

  it('the card menu never hijacks a text field or a dialog opened from the card', () => {
    const doc = makeSampleDoc((d) => {
      d.pages[0].render.history = [asset('u/proj/pages/p1-old.png', { w: 1000, h: 1500 })];
    });
    const studio = makeStudio(doc);
    render(<PagesTab studio={studio} doc={doc} />);
    // Right-click in the cover title keeps the browser's own text menu (copy / paste).
    fireEvent.click(within(screen.getByTestId('cover-card')).getByRole('button', { name: /Cover text/ }));
    const title = within(screen.getByTestId('cover-card')).getByLabelText('Title on the cover');
    expect(fireEvent.contextMenu(title)).toBe(true);
    expect(screen.queryByRole('menu')).toBeNull();
    // A right-click inside the versions dialog (portalled, but a React child of the card) stays there.
    fireEvent.click(within(card(1)).getByRole("button", { name: /Page 1: \d+ versions/ }));
    const dialog = screen.getByRole('dialog');
    expect(card(1).contains(dialog)).toBe(false);
    fireEvent.contextMenu(dialog);
    expect(screen.queryByRole('menu', { name: 'Page 1 actions' })).toBeNull();
    // The card itself still opens it.
    fireEvent.contextMenu(card(1));
    expect(screen.getByRole('menu', { name: 'Page 1 actions' })).toBeInTheDocument();
  });

  it('compact cards keep "Fit · Free" short enough for two columns on a 320 px phone', () => {
    const doc = makeSampleDoc((d) => {
      d.pages[0].render.asset = asset('u/proj/pages/p1.png', { w: 1024, h: 1024 });
    });
    const studio = makeStudio(doc);
    render(<PagesTab studio={studio} doc={doc} />);
    fireEvent.click(screen.getByRole('radio', { name: 'Compact' }));
    const fit = within(card(1)).getByRole('button', { name: 'Fit to 2:3 · Free' });
    expect(fit).toHaveTextContent(/^Fit · Free$/);
    fireEvent.click(fit);
    expect(studio.act).toHaveBeenCalledWith({ type: 'fit_render', target: { kind: 'page', id: 'pg_1' }, mode: 'auto' });
  });

  it('the clip menu prices a redraw for THIS user (never dollars for governed users)', () => {
    const studio = governedStudio();
    render(<PagesTab studio={studio} doc={studio.doc!} />);
    fireEvent.click(within(card(1)).getByRole('button', { name: 'Page 1 actions' }));
    const redraw = within(screen.getByRole('menu', { name: 'Page 1 actions' })).getByRole('menuitem', { name: /Redraw/ });
    expect(redraw).toHaveTextContent(/% of your usage/);
    expect(redraw).not.toHaveTextContent('$');
    fireEvent.click(redraw);
    expect(studio.act).toHaveBeenCalledWith({ type: 'render_pages', pageIds: ['pg_1'], force: true });
  });

  it('density: compact cards fit two columns on a phone and the choice is remembered', () => {
    const studio = makeStudio();
    const { container } = render(<PagesTab studio={studio} doc={studio.doc!} />);
    const grid = container.querySelector('[data-pages-grid]') as HTMLElement;
    expect(grid.getAttribute('data-pages-grid')).toBe('1');
    fireEvent.click(screen.getByRole('radio', { name: 'Compact' }));
    expect(container.querySelector('[data-pages-grid]')!.getAttribute('data-pages-grid')).toBe('2');
    expect(container.querySelector('[data-pages-grid]')!.className).toContain('minmax(min(100%,128px),1fr)');
    expect(localStorage.getItem(DENSITY_KEY)).toBe('2');
    // Compact cards drop the long script view (the art / sketch stays).
    expect(within(card(2)).queryByText('“You owe me an explanation, Maya.”')).toBeNull();
  });

  it('the Book section toggles free software pages with an undo', () => {
    const studio = makeStudio();
    render(<PagesTab studio={studio} doc={studio.doc!} />);
    const book = screen.getByRole('region', { name: 'Book pages' });
    expect(book).toHaveTextContent('Free — made by the editor, no AI cost');
    fireEvent.click(within(book).getByRole('switch', { name: 'Title page' }));
    expect(studio.patch).toHaveBeenCalledWith([{ op: 'book', patch: { titlePage: true } }], { label: 'Change book pages' });
    fireEvent.click(within(book).getByRole('switch', { name: 'Back cover' }));
    expect(studio.patch).toHaveBeenCalledWith([{ op: 'book', patch: { backCover: 'auto' } }], { label: 'Change book pages' });
  });

  it('invites reading once every page is drawn', () => {
    const studio = makeStudio(
      makeSampleDoc((d) => {
        d.planStatus = 'approved';
        d.pages = d.pages.slice(0, 1);
      })
    );
    render(<PagesTab studio={studio} doc={studio.doc!} />);
    expect(screen.getByText('1 of 1 page drawn')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Read the comic/ }));
    expect(studio.setTab).toHaveBeenCalledWith('read');
    expect(screen.queryByRole('button', { name: /Render (all|remaining)/ })).toBeNull();
  });

  it('offers to plan when there are no pages', () => {
    const studio = makeStudio(makeSampleDoc((d) => ((d.pages = []), (d.planStatus = 'none'))));
    render(<PagesTab studio={studio} doc={studio.doc!} />);
    fireEvent.click(screen.getByRole('button', { name: 'Plan the pages' }));
    expect(studio.act).toHaveBeenCalledWith({ type: 'plan_pages' });
    expect(document.querySelector('[data-empty-art="pages"]')).not.toBeNull();
  });
});
