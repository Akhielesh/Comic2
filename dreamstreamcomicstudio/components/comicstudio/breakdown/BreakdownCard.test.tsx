// BreakdownCard: the book at a glance in the chat (softwarefirst.md §2.6).
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { emptyRender, pageSpecHash, type Card, type ComicDoc, type Gate, type Line, type Page, type Panel } from '../../../shared/comic/doc';
import { formatUsd } from '../../../shared/comic/models';
import { layoutFixOps } from '../../../shared/comic/ops';
import { quoteRenderPages, summarizeBook, unitPrice } from '../../../shared/comic/plan';
import { CardRenderer } from '../conversation/cards/CardRenderer';
import { COMPOSE_EVENT } from '../conversation/composerBus';
import { makeFakeStudio, makeSampleDoc, resetUsageStatus, showDollarPrices, showUsagePrices } from '../conversation/testing/fixtures';
import { registeredCard } from '../features';
import { BREAKDOWN_VIEW_KEY, BreakdownCard, fitWords, layoutFitFix, paidAmount, type BreakdownCardProps } from './BreakdownCard';
import { FIT_DOT_COLOR, PageWireframe } from './PageWireframe';
import { feature } from './index';
import { checkPagePlan } from '../../../shared/comic/pagePlanCheck';
import { CostInsights } from '../insights/CostInsights';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Spies that call the real code (behaviour unchanged): how often the card runs plan checks and quotes, and what it
// hands the cost view.
vi.mock('../../../shared/comic/pagePlanCheck', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../../shared/comic/pagePlanCheck')>();
  return { ...mod, checkPagePlan: vi.fn(mod.checkPagePlan) };
});
vi.mock('../../../shared/comic/plan', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../../shared/comic/plan')>();
  return { ...mod, quoteRenderPages: vi.fn(mod.quoteRenderPages) };
});
vi.mock('../insights/CostInsights', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../insights/CostInsights')>();
  return { ...mod, CostInsights: vi.fn(mod.CostInsights) };
});

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

beforeEach(() => {
  // Admin / own-key wording (dollars); governed users have their own describe below.
  showDollarPrices();
});

afterEach(() => {
  resetUsageStatus();
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
  it('cover first, then every page; each name starts with the visible words, then cost, status and panels', () => {
    const studio = makeFakeStudio();
    const doc = studio.doc!;
    renderCard(bd(), studio);
    const list = screen.getByRole('list', { name: /Pages in this book/ });
    const tiles = within(list).getAllByRole('button');
    expect(tiles).toHaveLength(4);
    const per = formatUsd(unitPrice(doc, 'page', { byok: false }).usd);
    expect(tiles[0]).toHaveAccessibleName(`Cover, about ${formatUsd(unitPrice(doc, 'cover', { byok: false }).usd)} to draw, not drawn`);
    expect(tiles[1]).toHaveAccessibleName('Page 1, drawn, 2 panels');
    expect(tiles[2]).toHaveAccessibleName(`Page 2, about ${per} to draw, not drawn, 2 panels`);
    expect(tiles[3]).toHaveAccessibleName(`Page 3, about ${per} to draw, failed, 2 panels`);
    // P1-QA breakdown-tile-names: no aria-label that could drift from the visible text.
    for (const t of tiles) expect(t).not.toHaveAttribute('aria-label');
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

  it('out-of-flow tile text (the sr-only spoken names) stays inside the scrolling strip: tiles are positioned', () => {
    // P2-GATE breakdown-strip-sronly-overflow: Tailwind `sr-only` is position:absolute, so its containing block is
    // its nearest POSITIONED ancestor. When none sat inside the overflow-x-auto strip, that was the page itself:
    // the strip did not clip the far tiles' hidden names and the document grew to 2063 px at a 1440 px viewport
    // (1715 px at 360 px). jsdom has no layout, so the containing block is found from the positioning classes.
    const cls = (el: Element) => el.getAttribute('class') ?? '';
    const POSITIONED = /(?:^|\s)(?:relative|absolute|fixed|sticky)(?:\s|$)/;
    const OUT_OF_FLOW = /(?:^|\s)(?:sr-only|absolute|fixed)(?:\s|$)/;
    const containingBlock = (el: Element): Element | null => {
      for (let a = el.parentElement; a; a = a.parentElement) if (POSITIONED.test(cls(a))) return a;
      return null;
    };
    const check = (label: string) => {
      const list = screen.getByRole('list', { name: /Pages in this book/ });
      const items = within(list).getAllByRole('listitem');
      const floating = [...list.querySelectorAll('*')].filter((el) => OUT_OF_FLOW.test(cls(el)));
      // every tile carries its spoken name, so this check can never pass on an empty set
      const spoken = floating.filter((el) => /(?:^|\s)sr-only(?:\s|$)/.test(cls(el)));
      expect(spoken.length, `${label}: one spoken name per tile`).toBe(items.length);
      for (const el of floating) {
        const cb = containingBlock(el);
        const what = `${label}: <${el.tagName.toLowerCase()} class="${cls(el)}">${(el.textContent || '').slice(0, 40)}`;
        expect(cb, `${what} has a positioned ancestor`).not.toBeNull();
        expect(list.contains(cb), `${what} is placed (and clipped) inside the strip, not against the page`).toBe(true);
      }
      // the hidden name scrolls with its own tile
      for (const el of spoken) expect(el.closest('li')!.contains(containingBlock(el)), `${label}: inside its tile`).toBe(true);
    };

    let r = renderCard(bd());
    check('easy plan');
    r.unmount();
    r = renderCard(bd(), makeFakeStudio(), true);
    check('compact');
    r.unmount();
    // Pro status view with drawn art (thumbnails are <img>, the names carry "drawn"); then the cost view.
    r = renderCard(bd({ view: 'status' }), makeFakeStudio({ doc: drawnDoc(), mode: 'pro' }));
    check('pro status');
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Breakdown view' })).getByRole('radio', { name: /Cost/ }));
    check('pro cost');
    r.unmount();
    // Governed wording ("a little of your usage to draw") rides in the same spoken span.
    resetUsageStatus();
    renderCard(bd(), makeFakeStudio({ mode: 'pro' }));
    check('governed');
  });

  it('compact tiles are 96 px', () => {
    renderCard(bd(), makeFakeStudio(), true);
    for (const li of within(screen.getByRole('list', { name: /Pages in this book/ })).getAllByRole('listitem')) expect(li.style.width).toBe('96px');
  });

  it('a subset shows only those pages and no cover; vanished pages fall back to the whole book', () => {
    renderCard(bd({ pageIds: ['pg_2'] }));
    const list = screen.getByRole('list', { name: /Pages in this book/ });
    const only = within(list).getAllByRole('button');
    expect(only).toHaveLength(1);
    expect(only[0]).toHaveAccessibleName(/^Page 2,/);
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
  it('Easy: one primary action — Approve & render all (decisions-final #3) with the gate-equal quote', () => {
    const studio = makeFakeStudio();
    const doc = studio.doc!;
    renderCard(bd(), studio);
    const q = quoteRenderPages(doc, { byok: false, tier: doc.settings.quality, modelOverride: doc.settings.imageModelOverride });
    const btn = screen.getByRole('button', { name: `Approve & render all · ≈${formatUsd(q.usd)}` });
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
    expect(screen.getByRole('button', { name: /^Cover,.*out of date/ })).toBeInTheDocument();
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
    // The lock line (models.md §3.6 A): nothing drawn on a recorded model yet → the model the first image locks.
    const per = unitPrice(doc, 'page', { byok: false });
    expect(within(panel).getByText(`Will draw with ${per.model} · locks when the first image is drawn`)).toBeInTheDocument();
    expect(within(panel).getByText(`≈${formatUsd(per.usd)}/page`)).toBeInTheDocument();
    // Pro sees the insights tabs inline (models.md §4.1 L2); per-model figures live in the Models tab now.
    const tabs = screen.getByRole('tablist', { name: 'Cost details' });
    expect(within(tabs).getAllByRole('tab').map((t) => t.textContent)).toEqual(['Overview', 'Pages', 'Models', 'Trends']);
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Spent on this comic$0.42');
    // the drawn page's tile shows what was really spent on it
    expect(screen.getByRole('button', { name: /^Page 1, \$0\.30 spent, drawn, 2 panels/ })).toBeInTheDocument();
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

describe('governed users never see dollars (P1-LIMITS rule)', () => {
  const NO_DOLLARS = /\$\s?\d|\$0\b|<\$/;

  it('plan, status and cost views speak in shares of the usage; the kept button keeps its words', () => {
    showUsagePrices(1);
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
    const { container } = renderCard(bd(), studio);
    expect(screen.getByRole('button', { name: /^Approve & render all · (≈[\d.]+%|<0\.1%) of your usage$/ })).toBeInTheDocument();
    expect(container.textContent).not.toMatch(NO_DOLLARS);
    for (const view of ['Status', 'Cost']) {
      fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Breakdown view' })).getByRole('radio', { name: new RegExp(view) }));
      expect(container.textContent).not.toMatch(NO_DOLLARS);
    }
    const panel = screen.getByRole('region', { name: 'Cost breakdown' });
    expect(within(panel).getByText('Spent on this comic').parentElement!.parentElement).toHaveTextContent(/of your usage/);
    // Tile names carry the share too, and still start with the visible label.
    for (const t of within(screen.getByRole('list', { name: /Pages in this book/ })).getAllByRole('button')) {
      expect(t.textContent).not.toMatch(NO_DOLLARS);
      expect(t).toHaveAccessibleName(/^(Cover|Page \d+),/);
    }
  });

  it('fails closed: before the usage status loads, a non-admin sees no dollar figure', () => {
    resetUsageStatus();
    const { container } = renderCard(bd(), makeFakeStudio({ mode: 'pro' }));
    expect(container.textContent).not.toMatch(NO_DOLLARS);
    expect(screen.getByRole('button', { name: /^Approve & render all · uses a little of your usage$/ })).toBeInTheDocument();
    // Inside sentences the unknown share reads as words, not a broken verb phrase.
    expect(container.textContent).toMatch(/a little of your usage to draw/);
    expect(container.textContent).not.toMatch(/uses a little of your usage (to draw|spent)/);
    const tiles = within(screen.getByRole('list', { name: /Pages in this book/ })).getAllByRole('button');
    expect(tiles.some((t) => /, a little of your usage to draw,/.test(t.textContent || ''))).toBe(true);
  });

  it('admins (caps.admin) and own-key comics keep dollars', () => {
    resetUsageStatus();
    const { unmount } = renderCard(bd(), makeFakeStudio({ caps: { ...makeFakeStudio().caps, admin: true } }));
    expect(screen.getByRole('button', { name: /^Approve & render all · ≈\$\d/ })).toBeInTheDocument();
    unmount();
    renderCard(bd(), makeFakeStudio({ byok: true }));
    expect(screen.getByRole('button', { name: /^Approve & render all · ≈\$\d/ })).toBeInTheDocument();
  });
});

// ── Plan fit (A5: plan §4.1, §6; decision PD-1) ──────────────────────────────
// Synthetic pages shaped like the owner's b4b5774f p2 — no production text.

const WORDS = 'listen the carrier behind those flower stalls has no plates and nobody has unloaded anything since morning which means someone wants us watching it closely tonight'.split(' ');
const say = (n: number, seed = 0) => Array.from({ length: n }, (_, i) => WORDS[(seed + i) % WORDS.length]).join(' ');
const sp = (id: string, n: number, seed = 0): Line => ({ id, kind: 'speech', speakerId: 'c_maya', text: say(n, seed) });
const pn = (pageId: string, n: number, over: Partial<Panel>): Panel => ({ id: `${pageId}_p${n}`, n, size: 'medium', shot: 'medium', action: `Beat ${n}.`, castIds: ['c_maya'], lines: [], ...over });

/** b4b5774f-p2-shaped: two equal / one wide / three small; panels 5 and 6 are too full for their small cells and
 *  a same-order blueprint fits them for free. */
const p2Shaped = (): Page => ({
  id: 'pg_2',
  n: 2,
  summary: 'Maya spots the carrier.',
  layout: 'Row 1: two equal panels. Row 2: one wide panel. Row 3: three small panels.',
  panels: [
    pn('pg_2', 1, { shot: 'wide', lines: [sp('l1', 10)] }),
    pn('pg_2', 2, { lines: [{ id: 'l2', kind: 'sfx', text: 'BZZT' }] }),
    pn('pg_2', 3, { size: 'wide', shot: 'wide' }),
    pn('pg_2', 4, { size: 'small', shot: 'insert', castIds: [], lines: [{ id: 'l4', kind: 'sfx', text: 'CLICK' }] }),
    pn('pg_2', 5, { size: 'small', shot: 'close_up', lines: [sp('l5', 17, 3)] }),
    pn('pg_2', 6, { size: 'small', lines: [sp('l6a', 15, 5), sp('l6b', 14, 9)] })
  ],
  render: emptyRender(),
  balloons: []
});

/** One wide panel over two: 5 words (fits), 36 (tight) and 60 (too full) on the blueprint. */
const threeStates = (): Page => ({
  id: 'pg_2',
  n: 2,
  summary: 'Maya argues with the courier.',
  layout: 'Row 1: one wide panel. Row 2: two equal panels.',
  panels: [pn('pg_2', 1, { size: 'wide', lines: [sp('a', 5)] }), pn('pg_2', 2, { lines: [sp('b', 36, 2)] }), pn('pg_2', 3, { lines: [sp('c', 60, 4)] })],
  render: emptyRender(),
  balloons: []
});

/** Three panels of 75 words each: no blueprint fits, so there is no free layout fix. */
const noFit = (): Page => ({
  ...threeStates(),
  panels: [1, 2, 3].map((n) => pn('pg_2', n, { lines: [sp(`a${n}`, 25), sp(`b${n}`, 25, 4), sp(`c${n}`, 25, 8)] }))
});

const withPage2 = (page: Page, over: Partial<ComicDoc> = {}): ComicDoc => {
  const doc = makeSampleDoc(over);
  doc.pages = doc.pages.map((p) => (p.id === 'pg_2' ? page : p));
  return doc;
};

const flush = () => new Promise((r) => setTimeout(r, 0));
const tileOf = (name: RegExp) => within(screen.getByRole('list', { name: /Pages in this book/ })).getByRole('button', { name });
const fixesOf = () => within(screen.getByRole('group', { name: /^Page 2 is held back$/ })).getByRole('group', { name: 'Fixes' });

describe('plan fit: dots on the wireframes', () => {
  it('every wireframe panel carries a fit dot in three states — green fits, amber tight, red too full — with different shapes', () => {
    const doc = withPage2(threeStates());
    renderCard(bd({ view: 'plan' }), makeFakeStudio({ doc }));
    const dots = [...tileOf(/^Page 2,/).querySelectorAll('[data-fit-dot]')];
    expect(dots.map((d) => d.getAttribute('data-fit-dot'))).toEqual(['fits', 'tight', 'overfull']);
    expect(dots.map((d) => d.firstElementChild!.tagName.toLowerCase())).toEqual(['circle', 'circle', 'rect']);
    // the overfull panel is outlined in the danger tone too (hue never alone: shape + words)
    const outline = (dot: Element) => (dot.parentElement!.querySelector(':scope > rect') as SVGElement).style.stroke;
    expect(dots.map(outline)).toEqual(['var(--ds-hairline)', 'var(--ds-hairline)', 'var(--ds-danger-text)']);
    // every wireframe panel of every page tile has its dot (pages 1 and 3 have 2 panels each)
    expect(tileOf(/^Page 1,/).querySelectorAll('[data-fit-dot]')).toHaveLength(2);
    expect(tileOf(/^Page 3,/).querySelectorAll('[data-fit-dot]')).toHaveLength(2);
  });

  it('the wireframe maps roomy/fits → green, tight → amber, overfull → red through the readable Atlas tone tokens', () => {
    const box = { x: 0, y: 0, w: 0.5, h: 0.5 };
    const panel = (n: number, fitState?: 'roomy' | 'fits' | 'tight' | 'overfull') => ({ n, box: { ...box, x: (n - 1) * 0.25 }, shot: 'medium' as const, speech: 1, captions: 0, sfx: 0, ...(fitState ? { fitState } : {}) });
    const { container } = render(<PageWireframe panels={[panel(1, 'roomy'), panel(2, 'fits'), panel(3, 'tight'), panel(4, 'overfull'), panel(5)]} aspect="2:3" />);
    const marks = [...container.querySelectorAll('[data-fit-dot]')];
    expect(marks.map((m) => [m.getAttribute('data-panel'), m.getAttribute('data-fit-dot')])).toEqual([
      ['1', 'fits'],
      ['2', 'fits'],
      ['3', 'tight'],
      ['4', 'overfull']
    ]);
    const paint = (m: Element) => (m.firstElementChild as SVGElement).style;
    expect(paint(marks[0]).fill).toBe('var(--ds-success-text)');
    expect(paint(marks[2]).stroke).toBe('var(--ds-warning-text)');
    expect(paint(marks[3]).fill).toBe('var(--ds-danger-text)');
    // fit={false} turns them off (e.g. a future editor overlay); a panel without a fit state never gets one
    const off = render(<PageWireframe panels={[panel(1, 'overfull')]} aspect="2:3" fit={false} />);
    expect(off.container.querySelector('[data-fit-dot]')).toBeNull();
  });

  it('each panel row says its fit in words beside the dot (plan §6 copy)', () => {
    const doc = withPage2(threeStates());
    renderCard(bd({ view: 'plan' }), makeFakeStudio({ doc }));
    fireEvent.click(tileOf(/^Page 2,/));
    fireEvent.click(screen.getByRole('button', { name: 'Panels & actions' }));
    const rows = within(screen.getByRole('list', { name: 'Panels on page 2' })).getAllByRole('listitem');
    expect(rows.map((r) => r.getAttribute('data-fit'))).toEqual(['fits', 'tight', 'overfull']);
    const s = summarizeBook(doc, { byok: false }).pages.find((p) => p.id === 'pg_2')!;
    expect(rows[0]).toHaveTextContent(`Fits (5 of ${s.panels[0].budget} words)`);
    expect(rows[1]).toHaveTextContent(`Tight — 36 of ${s.panels[1].budget} words`);
    expect(rows[2]).toHaveTextContent(`Too full — 60 words, fits about ${s.panels[2].budget}`);
    expect(fitWords('fits', 18, 32, { noun: 'word' })).toBe('Fits (18 of 32 words)');
    expect(fitWords('tight', 30, 32, { noun: 'word' })).toBe('Tight — 30 of 32 words');
    expect(fitWords('overfull', 29, 11, { noun: 'word' })).toBe('Too full — 29 words, fits about 11');
  });
});

// ── Atlas colours as data (index.css; the same rules as tests/config/cssTokens.ts, which reads the file through a
// URL this jsdom test cannot use): hex, var(), oklch() and color-mix(in srgb, a p%, b) → sRGB 0–1. ──
const INDEX_CSS = readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../index.css'), 'utf8');
const cssBlock = (selector: string): Map<string, string> => {
  const at = INDEX_CSS.indexOf(`${selector} {`);
  if (at < 0) throw new Error(`index.css: no ${selector} block`);
  const body = INDEX_CSS.slice(INDEX_CSS.indexOf('{', at) + 1, INDEX_CSS.indexOf('\n}', at)).replace(/\/\*[\s\S]*?\*\//g, '');
  return new Map([...body.matchAll(/(--ds-[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()] as [string, string]));
};
const atlasTokens = (theme: 'light' | 'dark'): Map<string, string> => {
  const light = cssBlock('[data-ds-skin="atlas"]');
  return theme === 'light' ? light : new Map([...light, ...cssBlock('.dark[data-ds-skin="atlas"],\n.dark [data-ds-skin="atlas"]')]);
};
const srgbEncode = (x: number) => (x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055);
const srgbDecode = (x: number) => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4);
const cssColor = (value: string, tokens: Map<string, string>): number[] => {
  const v = value.trim();
  let m = /^var\((--[\w-]+)\)$/.exec(v);
  if (m) {
    const t = tokens.get(m[1]);
    if (t === undefined) throw new Error(`index.css: ${m[1]} is not defined`);
    return cssColor(t, tokens);
  }
  m = /^#([0-9a-f]{6})$/i.exec(v);
  if (m) return [0, 2, 4].map((i) => parseInt(m![1].slice(i, i + 2), 16) / 255);
  m = /^oklch\(([\d.]+)\s+([\d.]+)\s+([\d.]+)\)$/.exec(v);
  if (m) {
    const [L, C, H] = [+m[1], +m[2], (+m[3] * Math.PI) / 180];
    const [a, b] = [C * Math.cos(H), C * Math.sin(H)];
    const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
    const mm = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
    const s2 = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
    return [
      4.0767416621 * l - 3.3077115913 * mm + 0.2309699292 * s2,
      -1.2684380046 * l + 2.6097574011 * mm - 0.3413193965 * s2,
      -0.0041960863 * l - 0.7034186147 * mm + 1.707614701 * s2
    ].map((x) => Math.min(1, Math.max(0, srgbEncode(x))));
  }
  m = /^color-mix\(in srgb,\s*(.+?)\s+([\d.]+)%,\s*(.+)\)$/.exec(v);
  if (m) {
    const [a, b, p] = [cssColor(m[1], tokens), cssColor(m[3], tokens), +m[2] / 100];
    return a.map((x, i) => x * p + b[i] * (1 - p));
  }
  throw new Error(`cannot read the colour ${v}`);
};
const contrast = (fg: number[], bg: number[]): number => {
  const lum = (c: number[]) => 0.2126 * srgbDecode(c[0]) + 0.7152 * srgbDecode(c[1]) + 0.0722 * srgbDecode(c[2]);
  const [hi, lo] = [lum(fg), lum(bg)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

describe('plan fit: the dots are visible and spoken', () => {
  it('every fit mark is at least 3:1 against the wireframe and tile surfaces in Atlas light and dark (WCAG 1.4.11)', () => {
    const themes: [string, Map<string, string>][] = [
      ['light', atlasTokens('light')],
      ['dark', atlasTokens('dark')]
    ];
    for (const [theme, tokens] of themes) {
      // the panel fill, the page behind it and the tight ring's own fill / the tile
      for (const bg of ['var(--ds-surface-soft)', 'var(--ds-raised)', 'var(--ds-surface)']) {
        const under = cssColor(bg, tokens);
        for (const dot of ['fits', 'tight', 'overfull'] as const) {
          const r = contrast(cssColor(FIT_DOT_COLOR[dot], tokens), under);
          expect(r, `${theme}: ${dot} (${FIT_DOT_COLOR[dot]}) on ${bg} is ${r.toFixed(2)}:1`).toBeGreaterThanOrEqual(3);
        }
      }
    }
    // the bare tones this replaced are not (Atlas light amber ≈ 1.95:1, Atlas dark red ≈ 1.73:1)
    expect(contrast(cssColor('var(--ds-warning)', atlasTokens('light')), cssColor('var(--ds-surface-soft)', atlasTokens('light')))).toBeLessThan(3);
    expect(contrast(cssColor('var(--ds-danger)', atlasTokens('dark')), cssColor('var(--ds-surface-soft)', atlasTokens('dark')))).toBeLessThan(3);
  });

  it('the tile says tight panels in words too, next to the too-full ones', () => {
    const doc = withPage2(threeStates());
    renderCard(bd({ view: 'plan' }), makeFakeStudio({ doc }));
    const s = summarizeBook(doc, { byok: false }).pages.find((p) => p.id === 'pg_2')!;
    expect(s.panels.map((p) => p.fitState)).toEqual([expect.stringMatching(/^(roomy|fits)$/), 'tight', 'overfull']);
    expect(tileOf(/^Page 2,/)).toHaveAccessibleName('Page 2, not drawn, 3 panels, held back: panel 3 too full, panel 2 tight');
    // a page with only a tight panel is not held back, and says so
    cleanup();
    const tightOnly = withPage2({ ...threeStates(), panels: [...threeStates().panels.slice(0, 2), pn('pg_2', 3, { lines: [sp('c', 5, 4)] })] });
    const t = summarizeBook(tightOnly, { byok: false }).pages.find((p) => p.id === 'pg_2')!;
    expect(t.panels.map((p) => p.fitState)).toEqual([expect.stringMatching(/^(roomy|fits)$/), 'tight', expect.stringMatching(/^(roomy|fits)$/)]);
    renderCard(bd({ view: 'plan' }), makeFakeStudio({ doc: tightOnly }));
    expect(tileOf(/^Page 2,/)).toHaveAccessibleName(`Page 2, about ${formatUsd(unitPrice(tightOnly, 'page', { byok: false }).usd)} to draw, not drawn, 3 panels, panel 2 tight`);
  });
});

describe('plan fit: held-back pages (PD-1)', () => {
  it('an overfull page is red, held back from the quote, opened first, with the free fixes before "Draw anyway"', async () => {
    const doc = withPage2(p2Shaped());
    const studio = makeFakeStudio({ doc });
    renderCard(bd(), studio);
    // red tile, "Held back" in words, no "to draw" price on it
    const tile = tileOf(/^Page 2,/);
    expect(tile).toHaveAccessibleName('Page 2, not drawn, 6 panels, held back: panels 5 and 6 too full');
    expect(tile.querySelector('[data-held-back="true"]')).not.toBeNull();
    expect(tile).toHaveTextContent('Held back');
    expect(screen.getByTestId('breakdown-held-back')).toHaveTextContent('1 page held back');
    // the quote leaves it out — the same rule as the server's Render-all gate
    const held = quoteRenderPages(doc, { byok: false, tier: doc.settings.quality, holdBack: {} });
    const all = quoteRenderPages(doc, { byok: false, tier: doc.settings.quality });
    expect(held.heldBackIds).toEqual(['pg_2']);
    expect(held.usd).toBeLessThan(all.usd);
    const approve = screen.getByRole('button', { name: `Approve & render all · ≈${formatUsd(held.usd)}` });
    expect(screen.getByText(/Page 2 is held back — a panel has more words than it can hold, so it isn’t in this price\./)).toBeInTheDocument();
    // the held-back page is the one shown, with the plan §6 sentence and the worst panel in words
    const group = screen.getByRole('group', { name: 'Page 2 is held back' });
    expect(group).toHaveTextContent('Page 2 isn’t drawn yet: panels 5 and 6 have more words than they can hold. Fix it free, or draw it anyway.');
    expect(group).toHaveTextContent('Panel 6: Too full — 29 words, fits about 9');
    // free fixes first, then Draw anyway
    const names = within(fixesOf()).getAllByRole('button').map((b) => b.textContent);
    expect(names).toEqual(['Use the layout that fitsFree', 'Move or cut a lineFree', 'Split the page…', 'Shorten it…', expect.stringMatching(/^Draw anywayadds ≈\$/)]);
    // no single-page "Draw this page" for a held-back page: the fixes come first
    fireEvent.click(screen.getByRole('button', { name: 'Panels & actions' }));
    expect(screen.queryByRole('button', { name: /Draw this page|New take/ })).toBeNull();
    // Render all without drawOverfull: the server holds page 2 back the same way
    fireEvent.click(approve);
    await flush();
    expect(studio.act).toHaveBeenNthCalledWith(2, { type: 'render_pages', quotedUsd: held.usd });
  });

  it('"Draw anyway" adds the page to drawOverfull: re-quoted, sent with the run, and undoable before approving', async () => {
    const doc = withPage2(p2Shaped());
    const studio = makeFakeStudio({ doc });
    renderCard(bd(), studio);
    const before = quoteRenderPages(doc, { byok: false, tier: doc.settings.quality, holdBack: {} });
    const after = quoteRenderPages(doc, { byok: false, tier: doc.settings.quality, holdBack: { drawOverfull: ['pg_2'] } });
    const anyway = within(fixesOf()).getByRole('button', { name: /^Draw anyway/ });
    expect(anyway).toHaveAttribute('aria-pressed', 'false');
    expect(anyway).toHaveTextContent(`adds ≈${formatUsd(Math.round((after.usd - before.usd) * 10000) / 10000)}`);
    fireEvent.click(anyway);
    // no longer held back; the quote now includes it; the detail says it will be drawn as is
    expect(screen.queryByTestId('breakdown-held-back')).toBeNull();
    expect(screen.queryByRole('group', { name: 'Page 2 is held back' })).toBeNull();
    expect(screen.getByRole('group', { name: 'Page 2 is drawn as is' })).toHaveTextContent('Page 2 will be drawn as is, although panels 5 and 6 are too full.');
    expect(tileOf(/^Page 2,/)).toHaveAccessibleName(`Page 2, about ${formatUsd(unitPrice(doc, 'page', { byok: false }).usd)} to draw, not drawn, 6 panels, panels 5 and 6 too full`);
    fireEvent.click(screen.getByRole('button', { name: `Approve & render all · ≈${formatUsd(after.usd)}` }));
    await flush();
    expect(studio.act).toHaveBeenNthCalledWith(1, { type: 'approve_plan' });
    expect(studio.act).toHaveBeenNthCalledWith(2, { type: 'render_pages', drawOverfull: ['pg_2'], quotedUsd: after.usd });
    // "Hold it back" puts it back out of the run
    fireEvent.click(screen.getByRole('button', { name: 'Hold it back' }));
    expect(screen.getByTestId('breakdown-held-back')).toHaveTextContent('1 page held back');
    expect(screen.getByRole('button', { name: `Approve & render all · ≈${formatUsd(before.usd)}` })).toBeInTheDocument();
  });

  it('approved plans and subsets carry it too: Render all with drawOverfull, a subset with the page in its explicit list', async () => {
    const doc = withPage2(p2Shaped(), { planStatus: 'approved' });
    const studio = makeFakeStudio({ doc });
    const { unmount } = renderCard(bd(), studio);
    fireEvent.click(within(fixesOf()).getByRole('button', { name: /^Draw anyway/ }));
    const all = quoteRenderPages(doc, { byok: false, tier: doc.settings.quality, holdBack: { drawOverfull: ['pg_2'] } });
    fireEvent.click(screen.getByRole('button', { name: `Draw 2 pages · ≈${formatUsd(all.usd)}` }));
    await flush();
    expect(studio.act).toHaveBeenLastCalledWith({ type: 'render_pages', drawOverfull: ['pg_2'], quotedUsd: all.usd });
    unmount();
    // a subset holds the page back too (an explicit list is never gated on the server, so it must not carry it)
    const s2 = makeFakeStudio({ doc });
    renderCard(bd({ pageIds: ['pg_2', 'pg_3'] }), s2);
    const one = quoteRenderPages(doc, { pageIds: ['pg_2', 'pg_3'], byok: false, tier: doc.settings.quality, holdBack: {} });
    expect(one.pageIds).toEqual(['pg_3']);
    fireEvent.click(screen.getByRole('button', { name: `Draw 1 page · ≈${formatUsd(one.usd)}` }));
    await flush();
    expect(s2.act).toHaveBeenLastCalledWith({ type: 'render_pages', pageIds: ['pg_3'], quotedUsd: one.usd });
    fireEvent.click(within(fixesOf()).getByRole('button', { name: /^Draw anyway/ }));
    const both = quoteRenderPages(doc, { pageIds: ['pg_2', 'pg_3'], byok: false, tier: doc.settings.quality, holdBack: { drawOverfull: ['pg_2'] } });
    fireEvent.click(screen.getByRole('button', { name: `Draw 2 pages · ≈${formatUsd(both.usd)}` }));
    await flush();
    expect(s2.act).toHaveBeenLastCalledWith({ type: 'render_pages', pageIds: ['pg_2', 'pg_3'], quotedUsd: both.usd });
  });

  it('"Use the layout that fits" dispatches layoutFixOps (the blueprint AND the panel sizes, never a bare layout patch)', async () => {
    const doc = withPage2(p2Shaped());
    const studio = makeFakeStudio({ doc });
    renderCard(bd(), studio);
    const layout = summarizeBook(doc, { byok: false }).pages.find((p) => p.id === 'pg_2')!.planFit!.layoutFix!;
    const ops = layoutFixOps(doc, doc.pages[1], layout);
    expect(ops.length).toBeGreaterThan(1);
    expect(ops.some((o) => o.op === 'panel')).toBe(true);
    fireEvent.click(within(fixesOf()).getByRole('button', { name: /^Use the layout that fits/ }));
    await flush();
    expect(studio.act).toHaveBeenCalledWith({ type: 'patch', ops });
    expect(layoutFitFix(doc, doc.pages[1], layout)).toEqual(ops);
  });

  it('the layout chip hides when the ops are [] or the page is still too full on that layout', () => {
    const page = noFit();
    const doc = withPage2(page);
    expect(summarizeBook(doc, { byok: false }).pages.find((p) => p.id === 'pg_2')!.planFit).toMatchObject({ heldBack: true });
    renderCard(bd(), makeFakeStudio({ doc }));
    expect(within(fixesOf()).queryByRole('button', { name: /Use the layout that fits/ })).toBeNull();
    expect(within(fixesOf()).getByRole('button', { name: /^Move or cut a line/ })).toBeInTheDocument();
    // [] → null: a sentence that is not a blueprint, or one with another panel count
    expect(layoutFitFix(doc, page, 'make it nice')).toBeNull();
    expect(layoutFitFix(doc, page, 'Row 1: two equal panels.')).toBeNull();
    expect(layoutFitFix(doc, page, undefined)).toBeNull();
    // a valid 3-panel blueprint that is still overfull → null
    expect(layoutFixOps(doc, page, 'Row 1: one wide panel. Row 2: one wide panel. Row 3: one large panel.').length).toBeGreaterThan(0);
    expect(layoutFitFix(doc, page, 'Row 1: one wide panel. Row 2: one wide panel. Row 3: one large panel.')).toBeNull();
  });

  it('the other free fixes: the page editor, and split or shorten prefilled for the director (nothing sent)', () => {
    const doc = withPage2(p2Shaped());
    const studio = makeFakeStudio({ doc });
    renderCard(bd(), studio);
    fireEvent.click(within(fixesOf()).getByRole('button', { name: /^Move or cut a line/ }));
    expect(studio.openPage).toHaveBeenCalledWith('pg_2');
    const composed: unknown[] = [];
    const onCompose = (e: Event) => composed.push((e as CustomEvent).detail);
    window.addEventListener(COMPOSE_EVENT, onCompose);
    fireEvent.click(within(fixesOf()).getByRole('button', { name: 'Split the page…' }));
    fireEvent.click(within(fixesOf()).getByRole('button', { name: 'Shorten it…' }));
    window.removeEventListener(COMPOSE_EVENT, onCompose);
    expect(composed).toEqual([
      { text: 'Split page 2 into two pages so panel 6 has room for its words.', focus: true },
      { text: 'Shorten the words in panel 6 on page 2 to about 9 words.', focus: true }
    ]);
    expect(studio.act).not.toHaveBeenCalled();
    expect(studio.send).not.toHaveBeenCalled();
  });
});

describe('plan fit: next to a gate', () => {
  const renderAllGate = (over: Partial<Gate> = {}): Gate => ({
    id: 'gate_1',
    action: { type: 'render_pages', includeCover: true, quotedUsd: 0.2 },
    title: 'Draw the pages?',
    summary: '1 page',
    estimateUsd: 0.2,
    imageCount: 2,
    model: 'nano-banana-2.1',
    createdAt: 1,
    status: 'open',
    reason: 'first_render',
    ...over
  });

  it('"Draw anyway" beside an open Render-all gate extends that run (drawOverfull), quoted as a whole', async () => {
    const doc = withPage2(p2Shaped(), { gate: renderAllGate() });
    const studio = makeFakeStudio({ doc });
    renderCard(bd({ gateId: 'gate_1', view: 'plan' }), studio, true);
    // the gate owns approval: no Approve/Draw-this-page here, only the extension of its own run
    expect(screen.queryByRole('button', { name: /^Approve/ })).toBeNull();
    const q = quoteRenderPages(doc, { byok: false, tier: doc.settings.quality, includeCover: true, holdBack: { drawOverfull: ['pg_2'] } });
    const chip = within(fixesOf()).getByRole('button', { name: /^Draw page 2 anyway \(with the rest\)/ });
    expect(chip).toHaveTextContent(`≈${formatUsd(q.usd)}`);
    expect(screen.getByRole('group', { name: 'Page 2 is held back' })).toHaveTextContent('Fix it free, or draw it anyway.');
    expect(within(fixesOf()).queryByRole('button', { name: /^Draw anyway/ })).toBeNull();
    fireEvent.click(chip);
    await flush();
    expect(studio.act).toHaveBeenCalledWith({ type: 'render_pages', drawOverfull: ['pg_2'], includeCover: true, quotedUsd: q.usd });
  });

  it('a gate that draws named pages draws them whatever their fit: nothing is held back there; a closed gate offers no spend', () => {
    const explicit = withPage2(p2Shaped(), { gate: renderAllGate({ action: { type: 'render_pages', pageIds: ['pg_2'], quotedUsd: 0.07 } }) });
    const { unmount } = renderCard(bd({ gateId: 'gate_1', pageIds: ['pg_2'] }), makeFakeStudio({ doc: explicit }), true);
    expect(screen.queryByTestId('breakdown-held-back')).toBeNull();
    expect(screen.queryByRole('group', { name: 'Page 2 is held back' })).toBeNull();
    unmount();
    const closed = withPage2(p2Shaped(), { gate: renderAllGate({ status: 'approved' }) });
    renderCard(bd({ gateId: 'gate_1' }), makeFakeStudio({ doc: closed }), true);
    expect(within(fixesOf()).queryByRole('button', { name: /anyway/ })).toBeNull();
    // and the sentence offers only what is there: no "draw it anyway" without a Draw-anyway control
    const group = screen.getByRole('group', { name: 'Page 2 is held back' });
    expect(group).toHaveTextContent('Page 2 isn’t drawn yet: panels 5 and 6 have more words than they can hold. Fix it free.');
    expect(group).not.toHaveTextContent(/draw it anyway/i);
    // free fixes stay
    expect(within(fixesOf()).getByRole('button', { name: /^Use the layout that fits/ })).toBeInTheDocument();
  });
});

describe('plan fit: prices in the viewer’s terms', () => {
  const NO_DOLLARS = /\$\s?\d|\$0\b|<\$/;

  it('governed users see usage words, never dollars; BYOK users see "on your key"', () => {
    showUsagePrices(1);
    const doc = withPage2(p2Shaped(), { gate: undefined });
    const { container, unmount } = renderCard(bd(), makeFakeStudio({ doc }));
    expect(container.textContent).not.toMatch(NO_DOLLARS);
    expect(within(fixesOf()).getByRole('button', { name: /^Draw anyway/ })).toHaveTextContent(/adds (≈[\d.]+%|<0\.1%) of your usage$/);
    expect(screen.getByTestId('breakdown-moments')).toHaveTextContent(/of your usage to draw it$/);
    unmount();

    resetUsageStatus();
    const byokDoc = withPage2(p2Shaped(), {
      gate: {
        id: 'gate_1', action: { type: 'render_pages' }, title: 't', summary: 's', estimateUsd: 0.1, imageCount: 1, model: 'nano-banana-2.1', createdAt: 1, status: 'open', reason: 'policy'
      }
    });
    const r = renderCard(bd(), makeFakeStudio({ doc: byokDoc, byok: true }));
    expect(within(fixesOf()).getByRole('button', { name: /^Draw anyway/ })).toHaveTextContent(/adds ≈\$[\d.]+ on your key$/);
    r.unmount();
    renderCard(bd({ gateId: 'gate_1' }), makeFakeStudio({ doc: byokDoc, byok: true }), true);
    expect(within(fixesOf()).getByRole('button', { name: /^Draw page 2 anyway/ })).toHaveTextContent(/≈\$[\d.]+ on your key$/);
    // the helper: governed → usage share, BYOK → on your key, admin → plain dollars
    expect(paidAmount({ governed: false, badge: (u: number) => `≈${formatUsd(u)}` } as never, 0.07, true)).toBe(`≈${formatUsd(0.07)} on your key`);
    expect(paidAmount({ governed: true, badge: () => '≈1% of your usage' } as never, 0.07, true)).toBe('≈1% of your usage');
  });

  it('the moments line: "Want more moments? Add a page" with one page’s price; the button only prefills the composer', () => {
    const studio = makeFakeStudio();
    renderCard(bd(), studio);
    const line = screen.getByTestId('breakdown-moments');
    expect(line).toHaveTextContent(`Want more moments? Add a page · ≈${formatUsd(unitPrice(studio.doc!, 'page', { byok: false }).usd)} to draw it`);
    let composed: unknown = null;
    const onCompose = (e: Event) => (composed = (e as CustomEvent).detail);
    window.addEventListener(COMPOSE_EVENT, onCompose);
    fireEvent.click(within(line).getByRole('button', { name: 'Add a page' }));
    window.removeEventListener(COMPOSE_EVENT, onCompose);
    expect(composed).toEqual({ text: 'Add a page after page 3: ', focus: true });
    expect(studio.act).not.toHaveBeenCalled();
  });
});

describe('plan fit: phone layout (320/360 px)', () => {
  it('the held-back panel and its fixes wrap inside the card: no fixed widths, long words wrap, 44 px targets', () => {
    const doc = withPage2(p2Shaped());
    const { container } = renderCard(bd(), makeFakeStudio({ doc }), true);
    const group = screen.getByRole('group', { name: 'Page 2 is held back' });
    expect(group.className).toMatch(/\bmin-w-0\b/);
    const fixes = fixesOf();
    expect(fixes.className).toMatch(/\bflex-wrap\b/);
    expect(fixes.className).toMatch(/\bmin-w-0\b/);
    for (const chip of within(fixes).getAllByRole('button')) {
      expect(chip.className).toMatch(/coarse:min-h-\[44px\]/);
      expect(chip.className).toMatch(/\bmax-w-full\b/);
      expect(chip.className).toMatch(/\bmin-w-0\b/);
      expect(chip.querySelector('span')!.className).toMatch(/overflow-wrap:anywhere/);
    }
    for (const p of group.querySelectorAll('p > span:last-child')) expect(p.className).toMatch(/overflow-wrap:anywhere/);
    // nothing in the new UI sets a fixed width that could widen a 320 px chat
    for (const el of group.querySelectorAll('*')) expect(el.getAttribute('class') ?? '').not.toMatch(/(?:^|\s)(?:w|min-w)-\[\d/);
    // the "Add a page" link and the moments line are touch-sized and wrap
    const moments = screen.getByTestId('breakdown-moments');
    expect(moments.className).toMatch(/\bflex-wrap\b/);
    expect(within(moments).getByRole('button', { name: 'Add a page' }).className).toMatch(/coarse:min-h-11/);
    // the strip still never widens the chat
    expect(screen.getByRole('list', { name: /Pages in this book/ }).className).toMatch(/\boverflow-x-auto\b/);
    expect(container.querySelector('[data-held-back="true"]')).not.toBeNull();
  });
});

describe('plan fit: the cost view and the work per render', () => {
  /** Every page drawn and current except page 2, which is p2-shaped and held back. */
  const onlyHeldBackLeft = (): ComicDoc => {
    const doc = drawnDoc();
    doc.pages = doc.pages.map((p) => (p.id === 'pg_2' ? p2Shaped() : p));
    return doc;
  };

  it('a book whose only undrawn page is held back: the cost view gets a quote that says so, and the card says it is not in the price', () => {
    const doc = onlyHeldBackLeft();
    const cost = vi.mocked(CostInsights);
    cost.mockClear();
    renderCard(bd({ view: 'cost' }), makeFakeStudio({ doc }));
    // the quote handed to the cost view: nothing to draw now, because page 2 is held back (not because all is drawn)
    const quote = cost.mock.calls.at(-1)![0].quote;
    expect(quote).toMatchObject({ nothing: true, heldBackIds: ['pg_2'] });
    expect(quote.pageIds).toEqual([]);
    // the card never calls the book drawn while page 2 is not: it names the held-back page and the free fix
    expect(screen.getByTestId('breakdown-held-back')).toHaveTextContent('1 page held back');
    expect(screen.queryByText(/all drawn/)).toBeNull();
    expect(screen.getByText(/Page 2 is held back — a panel has more words than it can hold, so it isn’t in this price\. Fix it free, or draw it anyway\./)).toBeInTheDocument();
    expect(screen.queryByText(/^Every page is drawn/)).toBeNull();
  });

  it('the selected page’s plan checks run once per doc, not on every render; every hold-back quote shares one need meter', () => {
    const doc = withPage2(p2Shaped());
    const check = vi.mocked(checkPagePlan);
    const quotes = vi.mocked(quoteRenderPages);
    quotes.mockClear();
    const studio = makeFakeStudio({ doc });
    const { rerender } = renderCard(bd(), studio);
    expect(screen.getByRole('group', { name: 'Page 2 is held back' })).toBeInTheDocument();
    // the free layout fix was checked (applyOps + checkPagePlan) and Draw anyway was quoted
    const holdBack = quotes.mock.calls.map((c) => c[1].holdBack).filter((h): h is NonNullable<typeof h> => !!h);
    expect(holdBack.length).toBeGreaterThanOrEqual(2);
    expect(holdBack.every((h) => !!h.meter && h.meter === holdBack[0].meter)).toBe(true);
    // re-renders that do not change the doc (a new controller object, a toggle) run no plan check and no hold-back quote
    check.mockClear();
    quotes.mockClear();
    rerender(<BreakdownCard card={bd()} message={msg} studio={{ ...studio }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Panels & actions' }));
    fireEvent.click(screen.getByRole('button', { name: 'Fewer details' }));
    expect(check).not.toHaveBeenCalled();
    expect(quotes.mock.calls.filter((c) => c[1].holdBack)).toHaveLength(0);
    expect(within(fixesOf()).getByRole('button', { name: /^Use the layout that fits/ })).toBeInTheDocument();
    // a new doc is checked again
    rerender(<BreakdownCard card={bd()} message={msg} studio={{ ...studio, doc: { ...doc, rev: doc.rev + 1 } }} />);
    expect(check).toHaveBeenCalled();
  });
});
