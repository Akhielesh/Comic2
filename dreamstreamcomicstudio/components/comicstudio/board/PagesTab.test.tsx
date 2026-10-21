import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { formatUsd } from '../../../shared/comic/models';
import { PagesTab } from './PagesTab';
import { byokFromDoc, estimateDraw, estimateOne, pagesForIds, pagesToDraw } from './boardModel';
import { SAMPLE_NOW, makeSampleDoc, makeStudio } from './__fixtures__/sampleDoc';

const card = (n: number) => screen.getByRole('article', { name: `Page ${n}` });

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(SAMPLE_NOW);
});
afterEach(() => {
  vi.restoreAllMocks();
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

  it('drawn pages show the art with balloons', () => {
    const studio = makeStudio();
    render(<PagesTab studio={studio} doc={studio.doc!} />);
    const ready = card(1);
    expect(within(ready).getByRole('img', { name: /Page 1/ })).toHaveAttribute('src', 'https://cdn.test/u/proj/pages/p1.png');
    expect(ready.querySelectorAll('[data-testid="balloon"]').length).toBe(5);
  });

  it('queued and drawing pages show progress with the model and a clock', () => {
    const studio = makeStudio();
    render(<PagesTab studio={studio} doc={studio.doc!} />);
    expect(within(card(3)).getByText(/Queued · Nano Banana 2.1/)).toBeInTheDocument();
    expect(within(card(4)).getByText(/Drawing · 12s · Nano Banana 2.1/)).toBeInTheDocument();
  });

  it('stale pages carry the amber badge and a re-render with its price', () => {
    const studio = makeStudio();
    render(<PagesTab studio={studio} doc={studio.doc!} />);
    const stale = card(5);
    expect(within(stale).getByText('Script changed — re-render')).toBeInTheDocument();
    fireEvent.click(within(stale).getByRole('button', { name: /^Re-render/ }));
    expect(studio.act).toHaveBeenCalledWith({ type: 'render_pages', pageIds: ['pg_5'], force: true });
  });

  it('failed pages show the error and retry', () => {
    const studio = makeStudio();
    render(<PagesTab studio={studio} doc={studio.doc!} />);
    const failed = card(6);
    expect(within(failed).getByRole('alert')).toHaveTextContent('The image model timed out.');
    fireEvent.click(within(failed).getByRole('button', { name: /Retry/ }));
    expect(studio.act).toHaveBeenCalledWith({ type: 'render_pages', pageIds: ['pg_6'], force: true });
  });

  it('planned pages render on demand and open in the editor', () => {
    const studio = makeStudio();
    render(<PagesTab studio={studio} doc={studio.doc!} />);
    fireEvent.click(within(card(2)).getByRole('button', { name: /^Render/ }));
    expect(studio.act).toHaveBeenCalledWith({ type: 'render_pages', pageIds: ['pg_2'], force: true });
    fireEvent.click(within(card(1)).getByRole('button', { name: 'Open page 1 in the editor' }));
    expect(studio.openPage).toHaveBeenCalledWith('pg_1');
  });

  it('asks for review while the plan is a draft and prices "render all" honestly', () => {
    const studio = makeStudio();
    const doc = studio.doc!;
    render(<PagesTab studio={studio} doc={doc} />);
    expect(screen.getByText('Plan draft — review the scripts, then render')).toBeInTheDocument();
    const expected = estimateDraw(doc, pagesToDraw(doc), byokFromDoc(doc)).estimate.usd;
    const button = screen.getByRole('button', { name: new RegExp(`Approve & render all \\(≈ \\${formatUsd(expected)}\\)`) });
    fireEvent.click(button);
    expect(studio.act).toHaveBeenCalledWith({ type: 'render_pages' });
    fireEvent.click(screen.getByRole('button', { name: 'Approve plan only' }));
    expect(studio.act).toHaveBeenCalledWith({ type: 'approve_plan' });
  });

  it('after approval it reports progress and offers the remaining pages', () => {
    const studio = makeStudio(makeSampleDoc((d) => (d.planStatus = 'approved')));
    render(<PagesTab studio={studio} doc={studio.doc!} />);
    expect(screen.getByText('1 of 6 pages drawn')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Render remaining 3/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve plan only' })).toBeNull();
  });

  it('renders a selection of pages (skipping ones already drawing)', () => {
    const studio = makeStudio();
    const doc = studio.doc!;
    render(<PagesTab studio={studio} doc={doc} />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select page 1' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select page 3' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select page 5' }));
    const region = screen.getByRole('region', { name: 'Selected pages' });
    expect(region).toHaveTextContent('3 pages selected');
    const price = estimateDraw(doc, pagesForIds(doc, ['pg_1', 'pg_5']), byokFromDoc(doc)).estimate.usd;
    const button = within(region).getByRole('button', { name: /Render selected/ });
    expect(button).toHaveTextContent(formatUsd(price));
    fireEvent.click(button);
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
    const studio = makeStudio();
    const doc = studio.doc!;
    render(<PagesTab studio={studio} doc={doc} />);
    const cover = screen.getByTestId('cover-card');
    expect(cover.compareDocumentPosition(card(1)) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const price = estimateOne(doc, 'cover', byokFromDoc(doc)).usd;
    fireEvent.click(within(cover).getByRole('button', { name: new RegExp(`Design cover ≈ \\${formatUsd(price)}`) }));
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
  });
});
