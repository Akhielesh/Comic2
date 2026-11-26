// The studio header's own-key balance (credit-safety.md MN-3): who sees it, when it reads, what it says, and that it
// carries no colour beside money. Synthetic owner, key and readings.
import React from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComicDoc } from '../../../shared/comic/doc';
import { DEFAULT_CAPS, type StudioCaps } from '../../../shared/comic/capabilities';
import type { ProviderBalanceReport } from '../../../shared/providerBalances';
import { checkPersonalProviderBalance } from '../../../services/accountProviderUsage';
import { getProviderKeyValue } from '../../../services/apiKeys';
import { __resetKeyBalanceForTests, seedKeyBalance } from '../../../services/keyBalance';
import { makeFakeStudio, makeSampleDoc } from '../conversation/testing/fixtures';
import { StudioHeader } from '../ComicStudio';
import { FormFactorProvider, formFactorFor } from '../mobile/useFormFactor';
import { KeyBalanceSheetLine } from './KeyBalanceSheetLine';
import { KEY_BALANCE_PILL_MIN_WIDTH, KeyBalanceSlot } from './KeyBalanceSlot';

const auth = vi.hoisted(() => ({ user: { id: 'owner-synthetic' } as { id: string } | null }));
vi.mock('../../../contexts/AuthContext', () => ({ useAuth: () => ({ user: auth.user }) }));
vi.mock('../../../services/accountProviderUsage', () => ({ checkPersonalProviderBalance: vi.fn() }));
vi.mock('../../../services/apiKeys', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../services/apiKeys')>()),
  getProviderKeyValue: vi.fn(),
  getAccountKeyMeta: vi.fn(() => [])
}));

const check = vi.mocked(checkPersonalProviderBalance);
const OWN: StudioCaps = { ...DEFAULT_CAPS, byok: true };
const GOVERNED: StudioCaps = { ...DEFAULT_CAPS, byok: false, usage: { governed: true, pctLeft: 40, exhausted: false, pctPerStandardPage: 1 } };
const reading = (remaining: number | null, checkedAt = Date.now()): ProviderBalanceReport => ({
  provider: 'openrouter', status: 'reported', checkedAt, accountBalances: null, keyQuotaUsd: { limit: 20, remaining, usage: 1 }
});
const idle = () => makeSampleDoc({ style: { ...makeSampleDoc().style, options: [] } });
const drawing = (): ComicDoc => {
  const doc = idle();
  return { ...doc, pages: doc.pages.map((p, i) => (i === 1 ? { ...p, render: { ...p.render, status: 'rendering' } } : p)) };
};
const slot = (caps: StudioCaps, doc: ComicDoc = idle(), compact = false) => <KeyBalanceSlot studio={{ doc, caps }} compact={compact} />;

beforeEach(() => {
  __resetKeyBalanceForTests();
  auth.user = { id: 'owner-synthetic' };
  vi.mocked(getProviderKeyValue).mockImplementation((p) => (p === 'openrouter' ? 'sk-or-v1-synthetic-owner-key' : null));
  check.mockResolvedValue({ report: reading(12.4), saved: true });
});
afterEach(() => vi.clearAllMocks());

describe('the studio header balance', () => {
  it('shows what the own key has left and when it was read, after reading it once when the studio opens', async () => {
    render(slot(OWN));
    expect(await screen.findByText('$12.40 left')).toBeInTheDocument();
    expect(screen.getByText('· just now')).toBeInTheDocument();
    expect(check).toHaveBeenCalledTimes(1);
    expect(check).toHaveBeenCalledWith('owner-synthetic', 'openrouter', expect.any(AbortSignal));
    expect(screen.getByRole('button', { name: 'OpenRouter balance: $12.40 left, read just now. Read it again.' })).toBeInTheDocument();
  });

  it('a fresh reading is shown without a request; a stale one is read again when the studio opens', async () => {
    seedKeyBalance(reading(3));
    const { unmount } = render(slot(OWN));
    expect(screen.getByText('$3.00 left')).toBeInTheDocument();
    expect(check).not.toHaveBeenCalled();
    unmount();
    __resetKeyBalanceForTests();
    seedKeyBalance(reading(3, Date.now() - 20 * 60_000));
    render(slot(OWN));
    expect(screen.getByText('· 20 min ago')).toBeInTheDocument();
    expect(await screen.findByText('$12.40 left')).toBeInTheDocument();
    expect(check).toHaveBeenCalledTimes(1);
  });

  it('a tap reads it again and says what it found', async () => {
    seedKeyBalance(reading(3));
    render(slot(OWN));
    check.mockResolvedValueOnce({ report: reading(2.5), saved: true });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /OpenRouter balance/ }));
    });
    expect(check).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('$2.50 left')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Balance read: $2.50 left.');
  });

  it('reads it again once a drawing run settles, never while it draws and never on a timer', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      seedKeyBalance(reading(3));
      const { rerender } = render(slot(OWN, drawing()));
      await act(async () => {
        vi.advanceTimersByTime(60 * 60_000);
      });
      expect(check).not.toHaveBeenCalled();
      await act(async () => {
        rerender(slot(OWN, idle()));
      });
      expect(check).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('phone headers up to 559 px have no room for it: nothing in the header, but it is still read when the studio opens', async () => {
    for (const w of [320, 360, 390, 430, KEY_BALANCE_PILL_MIN_WIDTH - 1]) {
      __resetKeyBalanceForTests();
      check.mockClear();
      const { container, unmount } = render(<FormFactorProvider value={formFactorFor({ w, h: 800, coarse: true })}>{slot(OWN, idle(), true)}</FormFactorProvider>);
      await act(async () => undefined);
      expect(container.querySelector('[data-key-balance]'), `${w}px`).toBeNull();
      // The Spending sheet shows this reading, so it is current when the sheet opens.
      expect(check).toHaveBeenCalledTimes(1);
      unmount();
    }
  });

  it('a wide phone and the tablet header show the figure with a short age; the full sentence stays in the label', async () => {
    seedKeyBalance(reading(12.4, Date.now() - 5 * 60_000));
    const phone = render(<FormFactorProvider value={formFactorFor({ w: 600, h: 900, coarse: true })}>{slot(OWN, idle(), true)}</FormFactorProvider>);
    const flat = screen.getByRole('button', { name: /\$12\.40 left, read 5 minutes ago/ });
    expect(flat).toHaveTextContent('$12.40· 5m');
    // The phone header's flat icon family: no filled pill between flat icons.
    expect(flat.className).not.toMatch(/surface-soft/);
    phone.unmount();
    render(<FormFactorProvider value={formFactorFor({ w: 820, h: 1180, coarse: true })}>{slot(OWN, idle(), true)}</FormFactorProvider>);
    expect(screen.getByRole('button', { name: /\$12\.40 left, read 5 minutes ago/ })).toHaveTextContent('$12.40· 5m');
  });

  it('an old reading that could not be read again still says how old it is', async () => {
    check.mockResolvedValue({ report: { ...reading(null), status: 'unavailable', keyQuotaUsd: null }, saved: false });
    seedKeyBalance(reading(12.4, Date.now() - 3 * 60 * 60_000));
    render(<FormFactorProvider value={formFactorFor({ w: 820, h: 1180, coarse: true })}>{slot(OWN, idle(), true)}</FormFactorProvider>);
    await act(async () => undefined);
    expect(check).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: /OpenRouter balance/ })).toHaveTextContent('$12.40· 3h');
  });

  it('governed people, signed-out views and keys with no reported balance show nothing (no request for the governed)', async () => {
    const { container, rerender } = render(slot(GOVERNED));
    expect(container.querySelector('[data-key-balance]')).toBeNull();
    expect(check).not.toHaveBeenCalled();
    auth.user = null;
    rerender(slot(OWN));
    expect(container.querySelector('[data-key-balance]')).toBeNull();
    auth.user = { id: 'owner-synthetic' };
    check.mockResolvedValue({ report: reading(null), saved: true });
    __resetKeyBalanceForTests();
    rerender(slot({ ...OWN }));
    await act(async () => undefined);
    expect(container.querySelector('[data-key-balance]')).toBeNull();
  });

  it('carries no colour: ink and muted only beside the money', async () => {
    seedKeyBalance(reading(0));
    render(slot(OWN));
    const button = screen.getByRole('button', { name: /OpenRouter balance/ });
    expect(button.textContent).toContain('$0.00 left');
    expect(button.outerHTML).not.toMatch(/--ds-(?:hue|spark|accent|success|warning|danger|art)|STATUS|text-(?:red|amber|green)-/);
  });
});

describe('the Spending sheet balance (phone headers without room for the pill)', () => {
  const line = (w: number, caps: StudioCaps = OWN) => (
    <FormFactorProvider value={formFactorFor({ w, h: 800, coarse: true })}>
      <KeyBalanceSheetLine studio={{ caps }} />
    </FormFactorProvider>
  );

  it('shows what is left, when it was read, and Check now reads it again', async () => {
    seedKeyBalance(reading(12.4, Date.now() - 20 * 60_000));
    render(line(360));
    // Opening the sheet reads a stale reading.
    expect(await screen.findByText(/just now/)).toBeInTheDocument();
    const region = screen.getByRole('region', { name: 'Your OpenRouter balance' });
    expect(region).toHaveTextContent('$12.40 left');
    expect(check).toHaveBeenCalledTimes(1);
    check.mockResolvedValueOnce({ report: reading(7.25), saved: true });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Check now/ }));
    });
    expect(check).toHaveBeenCalledTimes(2);
    expect(await screen.findByText('$7.25')).toBeInTheDocument();
    // Ink and muted only: the money carries no colour, and Check now is the plain outline control (only its shared
    // invalid-state edge names a status token).
    expect(region.outerHTML.replace(/aria-\[invalid=true\]:border-\[var\(--ds-danger-mark\)\]/g, '')).not.toMatch(
      /--ds-(?:hue|spark|accent|success|warning|danger|art)|text-(?:red|amber|green)-/
    );
  });

  it('nothing where the header shows the pill, for governed people, or while the balance is unknown', async () => {
    seedKeyBalance(reading(12.4));
    const { container, rerender } = render(line(1280));
    expect(container.querySelector('[data-key-balance-line]')).toBeNull();
    rerender(line(KEY_BALANCE_PILL_MIN_WIDTH));
    expect(container.querySelector('[data-key-balance-line]')).toBeNull();
    rerender(line(360, GOVERNED));
    expect(container.querySelector('[data-key-balance-line]')).toBeNull();
    __resetKeyBalanceForTests();
    check.mockResolvedValue({ report: reading(null), saved: true });
    rerender(line(360));
    await act(async () => undefined);
    expect(container.querySelector('[data-key-balance-line]')).toBeNull();
  });
});

describe('the real studio header at phone width', () => {
  // The Spending sheet is the phone's only home for the balance below KEY_BALANCE_PILL_MIN_WIDTH. StudioHeader renders
  // it there; this pins it, so a merge of the header that drops the line fails here.
  it('360 px: no balance pill in the header, and the Spending sheet carries the balance line', async () => {
    seedKeyBalance(reading(12.4));
    const ff = formFactorFor({ w: 360, h: 780, coarse: true });
    const studio = makeFakeStudio({ doc: idle(), caps: OWN });
    render(
      <FormFactorProvider value={ff}>
        <StudioHeader studio={studio} doc={studio.doc!} ff={ff} onBack={vi.fn()} onRead={vi.fn()} onOpenSettings={vi.fn()} paneMode="both" onPaneMode={vi.fn()} />
      </FormFactorProvider>
    );
    const header = screen.getByRole('banner');
    expect(within(header).queryByRole('button', { name: /OpenRouter balance/ })).toBeNull();
    fireEvent.click(within(header).getByRole('button', { name: /^Spent / }));
    const sheet = await screen.findByRole('dialog', { name: 'Spending' });
    expect(sheet.querySelector('[data-key-balance-line]')).not.toBeNull();
    expect(within(sheet).getByRole('region', { name: 'Your OpenRouter balance' })).toHaveTextContent('$12.40 left');
    expect(within(sheet).getByRole('button', { name: /Check now/ })).toBeInTheDocument();
  });
});
