import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { DEFAULT_CAPS } from '../../../shared/comic/capabilities';
import { formatUsd } from '../../../shared/comic/models';
import { quoteRenderPages } from '../../../shared/comic/plan';
import { PagesTab, DENSITY_KEY } from './PagesTab';
import { byokFromDoc, estimateDraw, estimateOne, pagesForIds, pagesToDraw } from './boardModel';
import { SAMPLE_NOW, asset, makeSampleDoc, makeStudio } from './__fixtures__/sampleDoc';

const card = (n: number) => screen.getByRole('article', { name: `Page ${n}` });
/** An own-key studio: prices are real dollars. */
const dollarStudio = (doc = makeSampleDoc()) => makeStudio(doc, { caps: { ...DEFAULT_CAPS, byok: true } });
const governedStudio = (doc = makeSampleDoc()) => makeStudio(doc, { caps: { ...DEFAULT_CAPS, usage: { governed: true, pctLeft: 70, exhausted: false, pctPerStandardPage: 1.5 } } });

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
