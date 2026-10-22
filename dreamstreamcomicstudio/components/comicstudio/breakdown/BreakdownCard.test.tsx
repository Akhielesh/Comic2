// BreakdownCard: the book at a glance in the chat (softwarefirst.md §2.6).
import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { pageSpecHash, type Card, type ComicDoc } from '../../../shared/comic/doc';
import { formatUsd } from '../../../shared/comic/models';
import { quoteRenderPages, unitPrice } from '../../../shared/comic/plan';
import { CardRenderer } from '../conversation/cards/CardRenderer';
import { COMPOSE_EVENT } from '../conversation/composerBus';
import { makeFakeStudio, makeSampleDoc } from '../conversation/testing/fixtures';
import { registeredCard } from '../features';
import { BREAKDOWN_VIEW_KEY, BreakdownCard, type BreakdownCardProps } from './BreakdownCard';
import { feature } from './index';

type Studio = ReturnType<typeof makeFakeStudio>;
const msg = { id: 'msg_1', role: 'assistant' as const, text: '', at: 1 };
const bd = (extra: Partial<Extract<Card, { type: 'breakdown' }>> = {}): Extract<Card, { type: 'breakdown' }> => ({ type: 'breakdown', id: 'card_bd', ...extra });

const renderCard = (card: BreakdownCardProps['card'], studio: Studio = makeFakeStudio(), compact?: boolean) => {
  const utils = render(<BreakdownCard card={card} message={msg} studio={studio} compact={compact} />);
  return { ...utils, studio };
};

/** Sample doc with every page drawn and current. */
const drawnDoc = (): ComicDoc => {
  const doc = makeSampleDoc();
  doc.cast = doc.cast.map((c) => ({ ...c, sheet: { status: 'ready', history: [], asset: { path: `u/x/${c.id}.webp`, source: 'generated', at: 1 } } }));
  doc.pages = doc.pages.map((p) => ({
    ...p,
    render: { status: 'ready', history: [], asset: { path: `u/x/${p.id}.webp`, source: 'generated', at: 1, w: 800, h: 1200 }, specHash: pageSpecHash(doc, p) }
  }));
  return doc;
};

afterEach(() => {
  try {
    window.localStorage.clear();
  } catch {
    /* ignore */
  }
});

describe('registration', () => {
  it('registers the breakdown card type with the feature registry', () => {
    expect(feature.cards?.map((c) => c.type)).toEqual(['breakdown']);
    expect(registeredCard('breakdown')?.Component).toBe(BreakdownCard);
  });

  it('CardRenderer renders it from a registered breakdown payload', () => {
    const studio = makeFakeStudio();
    render(<CardRenderer card={bd()} studio={studio} message={msg} />);
    expect(screen.getByRole('region', { name: 'Page breakdown' })).toBeInTheDocument();
  });
});

describe('filmstrip', () => {
  it('cover first, then every page, each tile labelled with panels, status and real cost', () => {
    const studio = makeFakeStudio();
    const doc = studio.doc!;
    renderCard(bd(), studio);
    const list = screen.getByRole('list', { name: /Pages in this book/ });
    const tiles = within(list).getAllByRole('button');
    expect(tiles).toHaveLength(4);
    const per = formatUsd(unitPrice(doc, 'page', { byok: false }).usd);
    expect(tiles[0]).toHaveAccessibleName(`Cover, not drawn, about ${formatUsd(unitPrice(doc, 'cover', { byok: false }).usd)} to draw`);
    expect(tiles[1]).toHaveAccessibleName('Page 1, 2 panels, drawn');
    expect(tiles[2]).toHaveAccessibleName(`Page 2, 2 panels, not drawn, about ${per} to draw`);
    expect(tiles[3]).toHaveAccessibleName(`Page 3, 2 panels, failed, about ${per} to draw`);
    // page 1 is selected by default (roving tabindex)
    expect(tiles[1]).toHaveAttribute('aria-current', 'true');
    expect(tiles[1]).toHaveAttribute('tabindex', '0');
    expect(tiles[0]).toHaveAttribute('tabindex', '-1');
    expect(screen.getByRole('region', { name: 'Page 1 details' })).toBeInTheDocument();
  });

  it('←/→, Home and End move the selection and focus', () => {
    renderCard(bd());
    const list = screen.getByRole('list', { name: /Pages in this book/ });
    const tiles = () => within(list).getAllByRole('button');
    tiles()[1].focus();
    fireEvent.keyDown(list, { key: 'ArrowRight' });
    expect(tiles()[2]).toHaveAttribute('aria-current', 'true');
    expect(document.activeElement).toBe(tiles()[2]);
    expect(screen.getByRole('region', { name: 'Page 2 details' })).toBeInTheDocument();
    fireEvent.keyDown(list, { key: 'End' });
    expect(tiles()[3]).toHaveAttribute('aria-current', 'true');
    fireEvent.keyDown(list, { key: 'ArrowRight' });
    expect(tiles()[3]).toHaveAttribute('aria-current', 'true');
    fireEvent.keyDown(list, { key: 'Home' });
    expect(tiles()[0]).toHaveAttribute('aria-current', 'true');
    expect(screen.getByRole('region', { name: 'Cover details' })).toBeInTheDocument();
    fireEvent.keyDown(list, { key: 'ArrowLeft' });
    expect(tiles()[0]).toHaveAttribute('aria-current', 'true');
  });

  it('never widens the chat at 360 px: min-w-0 shell, scrolling strip, fixed tile widths', () => {
    const { container } = renderCard(bd());
    const shell = screen.getByRole('region', { name: 'Page breakdown' });
    expect(shell.className).toMatch(/\bmin-w-0\b/);
    expect(shell.className).toMatch(/\bmax-w-full\b/);
    const list = screen.getByRole('list', { name: /Pages in this book/ });
    expect(list.className).toMatch(/\boverflow-x-auto\b/);
    expect(list.className).toMatch(/\bmin-w-0\b/);
    expect(list.parentElement!.className).toMatch(/\bmin-w-0\b/);
    for (const li of within(list).getAllByRole('listitem')) expect(li.style.width).toBe('132px');
    // every flex row that holds text can shrink
    for (const row of container.querySelectorAll('.flex-wrap')) expect(row.className).not.toMatch(/\bw-\[/);
  });

  it('compact tiles are 96 px', () => {
    renderCard(bd(), makeFakeStudio(), true);
    for (const li of within(screen.getByRole('list', { name: /Pages in this book/ })).getAllByRole('listitem')) expect(li.style.width).toBe('96px');
  });

  it('a subset shows only those pages and no cover; vanished pages fall back to the whole book', () => {
    renderCard(bd({ pageIds: ['pg_2'] }));
    const list = screen.getByRole('list', { name: /Pages in this book/ });
    expect(within(list).getAllByRole('button').map((b) => b.getAttribute('aria-label')?.split(',')[0])).toEqual(['Page 2']);
    expect(screen.getByText(/1 page of 3/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show the whole book' }));
    expect(within(list).getAllByRole('button')).toHaveLength(4);
  });

  it('pages that no longer exist: honest note and the whole book', () => {
    renderCard(bd({ pageIds: ['pg_gone'] }));
    expect(screen.getByText(/no longer in the book/)).toBeInTheDocument();
    expect(within(screen.getByRole('list', { name: /Pages in this book/ })).getAllByRole('button')).toHaveLength(4);
  });
});

describe('legacy plan payload', () => {
  it('renders {type:"plan"} through the same component with defaults', () => {
    renderCard({ type: 'plan', id: 'card_plan' });
    expect(screen.getByRole('region', { name: 'Page breakdown' })).toBeInTheDocument();
    expect(within(screen.getByRole('list', { name: /Pages in this book/ })).getAllByRole('button')).toHaveLength(4);
  });
});

describe('actions and money', () => {
  it('Easy: one primary action — Approve & draw all with the gate-equal quote', () => {
    const studio = makeFakeStudio();
    const doc = studio.doc!;
    renderCard(bd(), studio);
    const q = quoteRenderPages(doc, { byok: false, tier: doc.settings.quality, modelOverride: doc.settings.imageModelOverride });
    const btn = screen.getByRole('button', { name: `Approve & draw all · ≈${formatUsd(q.usd)}` });
    expect(screen.queryByRole('radiogroup', { name: 'Breakdown view' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Approve only/ })).toBeNull();
    // per-page spend is one tap away, not on screen
    expect(screen.queryByRole('button', { name: /Draw this page/ })).toBeNull();
    fireEvent.click(btn);
    return Promise.resolve().then(async () => {
      await new Promise((r) => setTimeout(r, 0));
      expect(studio.act).toHaveBeenNthCalledWith(1, { type: 'approve_plan' });
      expect(studio.act).toHaveBeenNthCalledWith(2, { type: 'render_pages', quotedUsd: q.usd });
    });
  });

  it('per-page actions: draw a page with its own quote, edit, board, ask the AI', async () => {
    const studio = makeFakeStudio();
    const doc = studio.doc!;
    renderCard(bd(), studio);
    fireEvent.click(screen.getByRole('button', { name: /^Page 2,/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Panels & actions' }));
    const q = quoteRenderPages(doc, { pageIds: ['pg_2'], byok: false, tier: doc.settings.quality });
    expect(screen.getByText(/Includes 1 character sheet \(Arjun\)/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: `Draw this page · ≈${formatUsd(q.usd)}` }));
    await new Promise((r) => setTimeout(r, 0));
    expect(studio.act).toHaveBeenCalledWith({ type: 'render_pages', pageIds: ['pg_2'], quotedUsd: q.usd });
    fireEvent.click(screen.getByRole('button', { name: /Edit/ }));
    expect(studio.openPage).toHaveBeenCalledWith('pg_2');
    let composed: unknown = null;
    const onCompose = (e: Event) => (composed = (e as CustomEvent).detail);
    window.addEventListener(COMPOSE_EVENT, onCompose);
    fireEvent.click(screen.getByRole('button', { name: 'Ask AI to change…' }));
    window.removeEventListener(COMPOSE_EVENT, onCompose);
    expect(composed).toEqual({ text: 'Change page 2: ', focus: true });
    fireEvent.click(screen.getAllByRole('button', { name: 'Open in board' })[0]);
    expect(studio.setTab).toHaveBeenCalledWith('pages');
  });

  it('a drawn page offers a forced New take priced like the gate (missing sheets included), never a "to draw" quote', async () => {
    const studio = makeFakeStudio();
    const doc = studio.doc!;
    renderCard(bd(), studio);
    fireEvent.click(screen.getByRole('button', { name: 'Panels & actions' })); // page 1 (drawn)
    expect(screen.queryByRole('button', { name: /Draw this page/ })).toBeNull();
    // The server's forced render_pages also draws ARJUN's missing sheet: the button must say so.
    const redo = quoteRenderPages(doc, { pageIds: ['pg_1'], force: true, byok: false, tier: doc.settings.quality });
    expect(redo.usd).toBeGreaterThan(unitPrice(doc, 'page', { byok: false }).usd);
    expect(screen.getByText(/Includes 1 character sheet \(Arjun\)/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: `New take · ≈${formatUsd(redo.usd)}` }));
    await new Promise((r) => setTimeout(r, 0));
    expect(studio.act).toHaveBeenCalledWith({ type: 'render_pages', pageIds: ['pg_1'], force: true, quotedUsd: redo.usd });
  });

  it('a drawn page whose cast all have sheets: New take is exactly one page', () => {
    const doc = drawnDoc();
    const studio = makeFakeStudio({ doc });
    renderCard(bd(), studio);
    fireEvent.click(screen.getByRole('button', { name: 'Panels & actions' }));
    expect(screen.getByRole('button', { name: `New take · ≈${formatUsd(unitPrice(doc, 'page', { byok: false }).usd)}` })).toBeInTheDocument();
    expect(screen.queryByText(/Includes \d+ character sheet/)).toBeNull();
  });

  it('inside a gate every spend button is hidden (the gate owns approval); free fixes stay', () => {
    renderCard(bd({ gateId: 'gate_1' }), makeFakeStudio({ mode: 'pro' }));
    expect(screen.queryByRole('button', { name: /Approve/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Draw/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /New take|Make the cover/ })).toBeNull();
    expect(screen.getByRole('button', { name: /Edit/ })).toBeInTheDocument();
    // adding a reference photo is free and is the best fix before approving the drawing
    expect(screen.getByRole('button', { name: 'Add a photo (free)' })).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole('list', { name: /Pages in this book/ }), { key: 'Home' });
    expect(screen.getByRole('region', { name: 'Cover details' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Make the cover|New cover|Redraw the cover|Try the cover again/ })).toBeNull();
  });

  it('a stale cover is called out of date and offered as a redraw, not "make"', () => {
    const doc = drawnDoc();
    doc.cover = { ...doc.cover, render: { status: 'ready', history: [], asset: { path: 'u/x/cover.webp', source: 'generated', at: 1 }, specHash: 'an-older-title' } };
    const studio = makeFakeStudio({ doc });
    renderCard(bd(), studio);
    const usd = unitPrice(doc, 'cover', { byok: false }).usd;
    expect(screen.getByRole('button', { name: `Redraw the cover · ≈${formatUsd(usd)}` })).toBeInTheDocument();
    expect(screen.getByText(/The cover is out of date/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Cover, out of date/ })).toBeInTheDocument();
  });

  it('nothing to draw because a page has no panels: an honest note instead of silence', () => {
    const doc = drawnDoc();
    doc.pages.push({ ...doc.pages[0], id: 'pg_4', n: 4, panels: [], render: { status: 'none', history: [] } });
    renderCard(bd(), makeFakeStudio({ doc }));
    expect(screen.queryByRole('button', { name: /Approve|Draw|Read it/ })).toBeNull();
    expect(screen.getByText('Page 4 has no panels yet — add panels (free) before it can be drawn.')).toBeInTheDocument();
  });

  it('all pages drawn: Make the cover, then Read it', async () => {
    const doc = drawnDoc();
    const studio = makeFakeStudio({ doc });
    const { unmount } = renderCard(bd(), studio);
    const coverUsd = unitPrice(doc, 'cover', { byok: false }).usd;
    fireEvent.click(screen.getByRole('button', { name: `Make the cover · ≈${formatUsd(coverUsd)}` }));
    await new Promise((r) => setTimeout(r, 0));
    expect(studio.act).toHaveBeenCalledWith({ type: 'render_cover', quotedUsd: coverUsd });
    unmount();
    const done = { ...doc, cover: { ...doc.cover, render: { status: 'ready' as const, history: [], asset: { path: 'u/x/cover.webp', source: 'generated' as const, at: 1 } } } };
    const s2 = makeFakeStudio({ doc: done });
    renderCard(bd(), s2);
    fireEvent.click(screen.getByRole('button', { name: 'Read it' }));
    expect(s2.runClientAction).toHaveBeenCalledWith({ type: 'open_reader' });
    expect(screen.getByText(/Every page is drawn/)).toBeInTheDocument();
  });

  it('no pages: an honest empty state that can plan them', async () => {
    const studio = makeFakeStudio({ doc: makeSampleDoc({ pages: [] }) });
    renderCard(bd(), studio);
    expect(screen.getByText(/There are no pages yet/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Plan the pages' }));
    await new Promise((r) => setTimeout(r, 0));
    expect(studio.act).toHaveBeenCalledWith({ type: 'plan_pages' });
  });
});

describe('views', () => {
  it('Pro: Plan / Status / Cost switcher, persisted per card; expanded details with words', () => {
    const studio = makeFakeStudio({ mode: 'pro' });
    renderCard(bd(), studio);
    const group = screen.getByRole('radiogroup', { name: 'Breakdown view' });
    expect(within(group).getAllByRole('radio').map((r) => r.textContent?.trim())).toEqual(['Plan', 'Status', 'Cost']);
    expect(screen.getByRole('list', { name: 'Panels on page 1' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Approve only/ })).toBeInTheDocument();
    fireEvent.click(within(group).getByRole('radio', { name: /Cost/ }));
    expect(screen.getByRole('region', { name: 'Cost breakdown' })).toBeInTheDocument();
    expect(JSON.parse(window.localStorage.getItem(BREAKDOWN_VIEW_KEY) || '{}')).toEqual({ card_bd: 'cost' });
  });

  it('the cost view shows real ledger numbers, the next model and its price', () => {
    const doc = makeSampleDoc();
    doc.spend = {
      totalUsd: 0.42,
      byKind: { page: 0.3, sheet: 0.12 },
      savedUsd: 0.06,
      entries: [
        { id: 's1', at: 2, kind: 'page', label: 'Page 1', usd: 0.3, model: 'nano-banana-2.1', byok: false, estimated: false, target: 'page:pg_1' },
        { id: 's2', at: 1, kind: 'sheet', label: 'Maya', usd: 0.12, model: 'nano-banana-2.1', byok: false, estimated: false, target: 'sheet:c_maya' }
      ]
    };
    const studio = makeFakeStudio({ doc, mode: 'pro' });
    renderCard(bd({ view: 'cost' }), studio);
    const panel = screen.getByRole('region', { name: 'Cost breakdown' });
    expect(within(panel).getByText('Spent on this comic').parentElement!.parentElement).toHaveTextContent('$0.42');
    expect(within(panel).getByText('Saved by software').parentElement!.parentElement).toHaveTextContent('$0.06');
    expect(within(panel).getByText('Free — done by the editor, no AI cost.')).toBeInTheDocument();
    expect(within(panel).getByText('Pages')).toBeInTheDocument();
    expect(within(panel).getByText('Character sheets')).toBeInTheDocument();
    expect(within(panel).getByText(/2 calls · \$0\.42/)).toBeInTheDocument();
    const per = unitPrice(doc, 'page', { byok: false });
    expect(within(panel).getByText(new RegExp(`Next pages draw on ${per.model}`))).toBeInTheDocument();
    expect(within(panel).getByText(`≈${formatUsd(per.usd)}/page`)).toBeInTheDocument();
    // the drawn page's tile shows what was really spent on it
    expect(screen.getByRole('button', { name: /^Page 1, 2 panels, drawn, \$0\.30 spent/ })).toBeInTheDocument();
  });

  it('Easy: the art/layout toggle swaps thumbnails for wireframes; the cost link opens costs', () => {
    renderCard(bd());
    const tile = screen.getByRole('button', { name: /^Page 1,/ });
    expect(tile.querySelector('img')).not.toBeNull(); // drawn ⇒ art by default
    fireEvent.click(screen.getByRole('button', { name: 'Show layouts' }));
    expect(tile.querySelector('img')).toBeNull();
    expect(tile.querySelector('svg')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Show the cost breakdown/ }));
    expect(screen.getByRole('region', { name: 'Cost breakdown' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Hide costs' }));
    expect(screen.queryByRole('region', { name: 'Cost breakdown' })).toBeNull();
  });

  it('art held by the safety check never renders as an <img>', () => {
    const doc = makeSampleDoc();
    doc.pages[0].render.asset = { ...doc.pages[0].render.asset!, safety: { assessed: 'X', at: 1 } };
    renderCard(bd({ view: 'status' }), makeFakeStudio({ doc }));
    const tile = screen.getByRole('button', { name: /^Page 1,/ });
    expect(tile.querySelector('img')).toBeNull();
    expect(tile).toHaveTextContent('Held for review');
  });

  it('a cast avatar whose sheet is held by the safety check shows initials, never the image', () => {
    const doc = makeSampleDoc();
    const maya = doc.cast.find((c) => c.id === 'c_maya')!;
    maya.sheet = { ...maya.sheet, asset: { ...maya.sheet.asset!, safety: { assessed: 'X', at: 1 } } };
    renderCard(bd(), makeFakeStudio({ doc, mode: 'pro' }));
    const panels = screen.getByRole('list', { name: 'Panels on page 1' });
    expect(panels.querySelector('img')).toBeNull();
    expect(within(panels).getAllByTitle('Maya')[0]).toHaveTextContent('MA');
    // and a clean sheet does render as an avatar image
    const ok = makeSampleDoc();
    const { unmount } = render(<BreakdownCard card={bd({ id: 'card_ok' })} message={msg} studio={makeFakeStudio({ doc: ok, mode: 'pro' })} />);
    expect(screen.getAllByRole('list', { name: 'Panels on page 1' })[1].querySelector('img')).not.toBeNull();
    unmount();
  });

  it('flags missing references in the detail row with a free shortcut to add one', () => {
    renderCard(bd());
    const details = screen.getByRole('region', { name: 'Page 1 details' });
    expect(details).toHaveTextContent('ARJUN has no reference — may vary between pages');
    let composed: unknown = null;
    const onCompose = (e: Event) => (composed = (e as CustomEvent).detail);
    window.addEventListener(COMPOSE_EVENT, onCompose);
    fireEvent.click(within(details).getByRole('button', { name: 'Add a photo (free)' }));
    window.removeEventListener(COMPOSE_EVENT, onCompose);
    expect(composed).toEqual({ text: 'This is ARJUN: ', pickFiles: true, focus: true });
  });
});
