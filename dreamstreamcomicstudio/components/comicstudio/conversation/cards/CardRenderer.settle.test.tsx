// CardRenderer picks live or settled (PROGRAM3 SETTLE-UI; lead decision D3, CHANGED). With a settled `settle`, the
// card renders its one line and its live component is NEVER mounted: no images, no History fetch, no model-status
// request, no control. Every case below fails without the settled branch (the live card mounts and reaches out).

import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Card, ComicDoc, Msg } from '../../../../shared/comic/doc';
import { DEFAULT_CAPS } from '../../../../shared/comic/capabilities';
import { gateClosedFor, type CardSettle, type GateCardStamped } from '../../../../shared/comic/settle';
import { HistoryApiProvider, type HistoryApi } from '../../history/historyApi';
import { __resetStatusStore, __setStatusFetcherForTests } from '../../reliability/statusStore';
import { __resetRetries } from '../../reliability/retryIntents';
import { makeFakeStudio, makeSampleDoc, resetUsageStatus, showDollarPrices, showUsagePrices } from '../testing/fixtures';
import { CardRenderer } from './CardRenderer';
import { settledSummaryFor } from './SettledCard';

const SETTLED: CardSettle = { state: 'settled', outcome: 'passed' };
const LIVE: CardSettle = { state: 'live' };
const CONTROLS = 'button, input, select, textarea, [role="button"], [role="checkbox"], [role="radio"], [role="switch"], [role="menuitem"]';

const reply = (card: Card, at = 2): Msg => ({ id: `m_${card.id}`, role: 'assistant', text: '', at, cards: [card] });
const docWith = (card: Card, over: Partial<ComicDoc> = {}): ComicDoc =>
  makeSampleDoc({ conversation: [reply(card), { id: 'u_later', role: 'user', text: 'something else', at: 3 }], ...over });

beforeEach(showDollarPrices);
afterEach(resetUsageStatus);

describe('a settled renders card', () => {
  const card: Card = {
    type: 'renders',
    id: 'cr_done',
    label: 'Pages 1 and 3',
    targets: [
      { kind: 'page', id: 'pg_1' },
      { kind: 'page', id: 'pg_3' }
    ]
  };

  it('mounts 0 <img> and keeps one plain link to the pages (navigation only)', () => {
    const doc = docWith(card);
    const studio = makeFakeStudio({ doc });
    const { container, rerender } = render(<CardRenderer card={card} studio={studio} message={doc.conversation[0]} settle={LIVE} />);
    // Live (control): the drawn page is a real image.
    expect(container.querySelectorAll('img').length).toBeGreaterThan(0);
    rerender(<CardRenderer card={card} studio={studio} message={doc.conversation[0]} settle={SETTLED} />);
    expect(container.querySelectorAll('img')).toHaveLength(0);
    expect(container.querySelectorAll(CONTROLS)).toHaveLength(0);
    const row = container.querySelector('[data-settled="renders"]')!;
    expect(row.textContent).toMatch(/^Drew 1 page · 1 didn’t finish/);
    const link = screen.getByRole('link', { name: 'Open the pages' });
    expect(row.querySelectorAll('a')).toHaveLength(1);
    fireEvent.click(link);
    expect(studio.runClientAction).toHaveBeenCalledWith({ type: 'open_tab', tab: 'pages' });
  });
});

describe('a settled history card', () => {
  const card: Card = { type: 'history', id: 'hc_list', view: 'list' } as Card;
  const compare: Card = { type: 'history', id: 'hc_cmp', view: 'compare', a: 'ver_1', b: 'now' } as Card;
  const api = () =>
    ({
      list: vi.fn(async () => ({ rows: [], line: null })),
      compare: vi.fn(() => new Promise(() => undefined)),
      detail: vi.fn(() => new Promise(() => undefined)),
      book: vi.fn(() => new Promise(() => undefined)),
      urls: vi.fn(async () => ({})),
      classicSnapshots: vi.fn(async () => ({ snapshots: [] })),
      startFromClassicSnapshot: vi.fn(async () => ({ projectId: 'p' }))
    }) as unknown as HistoryApi & Record<'list' | 'compare', ReturnType<typeof vi.fn>>;

  it('makes no api.list or api.compare call (a live one does)', async () => {
    const studio = makeFakeStudio({ doc: docWith(card), caps: { ...DEFAULT_CAPS, history: true } });
    const live = api();
    const r1 = render(
      <HistoryApiProvider api={live}>
        <CardRenderer card={card} studio={studio} settle={LIVE} />
        <CardRenderer card={compare} studio={studio} settle={LIVE} />
      </HistoryApiProvider>
    );
    await act(async () => undefined);
    expect(live.list).toHaveBeenCalled();
    expect(live.compare).toHaveBeenCalled();
    r1.unmount();

    const settled = api();
    const { container } = render(
      <HistoryApiProvider api={settled}>
        <CardRenderer card={card} studio={studio} settle={SETTLED} />
        <CardRenderer card={compare} studio={studio} settle={SETTLED} />
      </HistoryApiProvider>
    );
    await act(async () => undefined);
    expect(settled.list).not.toHaveBeenCalled();
    expect(settled.compare).not.toHaveBeenCalled();
    expect([...container.querySelectorAll('[data-settled="history"]')].map((n) => n.textContent)).toEqual(['History', 'History · a comparison']);
    expect(container.querySelectorAll(CONTROLS)).toHaveLength(0);
  });
});

describe('a settled model_outage card', () => {
  const card: Card = {
    type: 'model_outage',
    id: 'out_1',
    modelId: 'nano-banana-2.1',
    options: [{ kind: 'wait_and_retry' }],
    blockedAction: { type: 'render_pages', pageIds: ['pg_2', 'pg_3'], quotedUsd: 0.14 }
  } as Card;
  const fetcher = vi.fn(async (ids: readonly string[]) => ids.map((modelId) => ({ modelId, state: 'down' as const, checkedAt: Date.now(), routes: [] })));

  beforeEach(() => {
    fetcher.mockClear();
    __resetStatusStore();
    __resetRetries();
    __setStatusFetcherForTests(fetcher);
  });
  afterEach(() => __setStatusFetcherForTests(null));

  it('makes no loadStatus call (a live one asks once)', async () => {
    const studio = makeFakeStudio({ doc: docWith(card) });
    const live = render(<CardRenderer card={card} studio={studio} settle={LIVE} />);
    await act(async () => undefined);
    expect(fetcher).toHaveBeenCalled();
    live.unmount();
    fetcher.mockClear();
    __resetStatusStore();
    const { container } = render(<CardRenderer card={card} studio={studio} settle={SETTLED} />);
    await act(async () => undefined);
    expect(fetcher).not.toHaveBeenCalled();
    expect(container.querySelector('[data-settled="model_outage"]')!.textContent).toBe('Nano Banana 2.1 was paused · 2 pages waited');
    expect(container.querySelectorAll(CONTROLS)).toHaveLength(0);
  });
});

describe('a settled notice', () => {
  const error: Card = { type: 'notice', id: 'n_err', tone: 'error', text: 'Rendering failed for page 7. Nothing was charged.' };

  it('keeps role="alert" only while unsettled, so a reload never re-announces an old error', () => {
    const studio = makeFakeStudio({ doc: docWith(error) });
    const { container, rerender } = render(<CardRenderer card={error} studio={studio} settle={LIVE} />);
    expect(screen.getByRole('alert')).toHaveTextContent(/Rendering failed/);
    rerender(<CardRenderer card={error} studio={studio} settle={SETTLED} />);
    expect(screen.queryByRole('alert')).toBeNull();
    const row = container.querySelector('[data-settled="notice"]')!;
    expect(row).toHaveAttribute('aria-live', 'off');
    expect(row.textContent).toBe('Rendering failed for page 7. Nothing was charged.');
  });

  it('a notice with fix chips reads its words and how many fixes it offered — never a chip', () => {
    const notice: Card = {
      type: 'notice',
      id: 'n_fix',
      tone: 'info',
      text: 'Page 3 holds too much text.',
      fixes: [
        { label: 'Make it a caption', free: true, action: { type: 'patch', ops: [] } },
        { label: 'Draw it anyway', free: false, action: { type: 'render_pages', pageIds: ['pg_3'], quotedUsd: 0.07 } }
      ]
    };
    const { container } = render(<CardRenderer card={notice} studio={makeFakeStudio({ doc: docWith(notice) })} settle={SETTLED} />);
    expect(container.textContent).toBe('Page 3 holds too much text. · 2 fixes offered');
    expect(container.querySelectorAll(CONTROLS)).toHaveLength(0);
  });
});

describe('settled gate, options and the rest', () => {
  it('a gate the studio closed reads its stamp, never "Not now", and has no Approve', () => {
    const gate: GateCardStamped = { type: 'gate', id: 'cg', gateId: 'g_old', closed: { status: 'declined', by: 'system', at: 1 } };
    const { container } = render(<CardRenderer card={gate} studio={makeFakeStudio({ doc: docWith(gate) })} settle={{ state: 'settled', outcome: 'closed' }} />);
    expect(container.textContent).toBe('Closed — nothing spent');
    expect(container.textContent).not.toMatch(/Not now/);
    expect(container.querySelectorAll(CONTROLS)).toHaveLength(0);
  });

  it('a governed creator reads an approval as a share of their usage, never $', () => {
    showUsagePrices(2);
    const gate: GateCardStamped = { type: 'gate', id: 'cg', gateId: 'g_old', closed: gateClosedFor({ estimateUsd: 0.42, imageCount: 6, model: 'Nano Banana 2.1' }, 'approved', 'user', 1) };
    const { container } = render(<CardRenderer card={gate} studio={makeFakeStudio({ doc: docWith(gate) })} settle={{ state: 'settled', outcome: 'closed' }} />);
    expect(container.textContent).toMatch(/^Approved · .*of your usage · 6 images$/);
    expect(container.textContent).not.toMatch(/[$¢]/);
    expect(container.querySelector('[data-settle-mark="done"] svg')).not.toBeNull();
  });

  it('an options card the creator moved past is one quiet line with no chip, no box and no Done', () => {
    const q: Card = {
      type: 'options',
      id: 'q',
      question: 'Which look?',
      multi: true,
      allowCustom: true,
      choices: [
        { id: 'c1', label: 'Noir ink' },
        { id: 'c2', label: 'Crayon' }
      ]
    };
    const studio = makeFakeStudio({ doc: docWith(q) });
    const { container, rerender } = render(<CardRenderer card={q} studio={studio} settle={{ state: 'open' }} />);
    expect(container.querySelectorAll(CONTROLS).length).toBeGreaterThan(2);
    rerender(<CardRenderer card={q} studio={studio} settle={{ state: 'settled', outcome: 'skipped' }} />);
    expect(container.textContent).toBe('Not answered — you moved on');
    expect(container.querySelectorAll(CONTROLS)).toHaveLength(0);
    expect(container.querySelector('[data-settle-tone="quiet"]')).not.toBeNull();
  });

  it('a gate’s own breakdown folds into the gate’s line: nothing renders', () => {
    const bd: Card = { type: 'breakdown', id: 'bd_g', gateId: 'g_old', view: 'cost' };
    const { container } = render(<CardRenderer card={bd} studio={makeFakeStudio({ doc: docWith(bd) })} settle={{ state: 'settled', outcome: 'folded' }} />);
    expect(container.textContent).toBe('');
    expect(container.querySelector('[data-settled]')).toBeNull();
  });

  it('a card type this client does not know reads "Earlier card", never silent and never interactive', () => {
    const odd = { type: 'from_the_future', id: 'x1' } as unknown as Card;
    const { container } = render(<CardRenderer card={odd} studio={makeFakeStudio({ doc: docWith(odd) })} settle={SETTLED} />);
    expect(container.textContent).toBe('Earlier card');
  });

  it('without a settle (SETTLED_CARDS off, older hosts) the card renders live, exactly as before', () => {
    const q: Card = { type: 'options', id: 'q', question: 'Which look?', choices: [{ id: 'c1', label: 'Noir ink' }] };
    const { container } = render(<CardRenderer card={q} studio={makeFakeStudio({ doc: docWith(q) })} />);
    expect(screen.getByRole('button', { name: /Noir ink/ })).toBeEnabled();
    expect(container.querySelector('[data-card-state]')).toBeNull();
  });

  it('a feature card’s own settled words replace summaryOf’s line, and a throwing hook keeps it', () => {
    const doc = docWith({ type: 'share', id: 'sh' });
    const share: Card = { type: 'share', id: 'sh' };
    expect(settledSummaryFor(share, doc, SETTLED, null)?.text).toBe('Share link');
    expect(settledSummaryFor(share, doc, SETTLED, null, () => 'Shared the link with the team')?.text).toBe('Shared the link with the team');
    expect(
      settledSummaryFor(share, doc, SETTLED, null, () => {
        throw new Error('boom');
      })?.text
    ).toBe('Share link');
    expect(settledSummaryFor(share, doc, LIVE, null, () => 'never')).toBeNull();
  });
});
