// FX-15: the approval strip on a phone. Closed it is one line ("Draw the re… · ≈ $1.…"); one tap opens it and the
// whole label and the whole price are on screen (a phone has no hover title). A governed user reads usage words,
// never "$" or "¢". Enter on Approve keeps focus on Approve and a second Enter sends nothing.
import React from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CAPS } from '../../../shared/comic/capabilities';
import { BoardPane } from './BoardPane';
import { SAMPLE_NOW, makeSampleDoc, makeStudio } from './__fixtures__/sampleDoc';
import { FormFactorProvider, formFactorFor } from '../mobile/useFormFactor';
import { resetBackStack } from '../mobile/backStack';

const TITLE = 'Draw the remaining 5 pages in the painted style, with the new rooftop chase';
const gated = (status: 'open' | 'approved' | 'declined' = 'open') =>
  makeSampleDoc((d) => {
    d.gate = {
      id: 'gate_7',
      action: { type: 'render_pages' },
      title: TITLE,
      summary: '5 pages',
      estimateUsd: 1.31,
      imageCount: 5,
      model: 'Nano Banana 2.1',
      createdAt: SAMPLE_NOW,
      status,
      reason: 'budget'
    };
  });

const atWidthEl = (w: number, studio: ReturnType<typeof makeStudio>) => (
  <FormFactorProvider value={formFactorFor({ w, h: 780, coarse: true })}>
    <BoardPane studio={studio} />
  </FormFactorProvider>
);
const atWidth = (w: number, studio: ReturnType<typeof makeStudio>) => render(atWidthEl(w, studio));

const cls = (el: Element) => (el.getAttribute('class') || '').split(/\s+/);
/** Text that is cut to one line (an ellipsis) instead of shown whole. */
const isCut = (el: Element) => cls(el).some((c) => c === 'truncate' || c.startsWith('max-w-[') || c === 'line-clamp-1');

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(SAMPLE_NOW);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetBackStack();
});

describe.each([360, 390])('the approval strip at %i px', (w) => {
  it('one tap shows the full label and the full price', () => {
    atWidth(w, makeStudio(gated(), { caps: { ...DEFAULT_CAPS, byok: true } }));
    const banner = screen.getByRole('region', { name: 'Waiting for your approval' });
    expect(banner).toHaveAttribute('data-gate-banner', 'compact');
    const title = within(banner).getByText(TITLE);
    const price = within(banner).getByText('· ≈ $1.31');
    // Closed: one calm line, both cut.
    expect(isCut(title)).toBe(true);
    expect(isCut(price)).toBe(true);
    fireEvent.click(within(banner).getByRole('button', { name: /Show details/ }));
    // Opened: the same words, whole, wrapping onto as many lines as they need.
    expect(isCut(title)).toBe(false);
    expect(isCut(price)).toBe(false);
    expect(cls(title)).toContain('[overflow-wrap:anywhere]');
    expect(cls(price)).toContain('[overflow-wrap:anywhere]');
    expect(title.closest('button')).toHaveAttribute('data-gate-summary', 'open');
    expect(cls(title.closest('button')!)).toContain('flex-wrap');
    // The price may wrap onto its own line when open, so it never starts with a dangling "·".
    expect(price.textContent).toBe('≈ $1.31');
    expect(banner).toHaveTextContent('5 images on Nano Banana 2.1 · over your budget cap');
    // And a second tap closes it back to one line.
    fireEvent.click(within(banner).getByRole('button', { name: /Hide details/ }));
    expect(isCut(title)).toBe(true);
    expect(price.textContent).toBe('· ≈ $1.31');
  });

  it('a governed user: the opened strip shows usage words and never "$" or "¢"', () => {
    const caps = { ...DEFAULT_CAPS, usage: { governed: true, pctLeft: 50, exhausted: false, pctPerStandardPage: 1 } };
    atWidth(w, makeStudio(gated(), { caps }));
    const banner = screen.getByRole('region', { name: 'Waiting for your approval' });
    fireEvent.click(within(banner).getByRole('button', { name: /Show details/ }));
    expect(banner).toHaveTextContent(/of your usage/);
    expect(banner.textContent).not.toMatch(/[$¢]/);
    expect(banner.innerHTML).not.toMatch(/[$¢]/); // not even in a title attribute
    const usage = within(banner).getByText(/of your usage/);
    expect(isCut(usage)).toBe(false);
    expect(usage.textContent).not.toMatch(/^·/);
  });
});

describe('Approve keeps focus while it is sent', () => {
  it('Enter on Approve: 0.3 s and 5 s later focus is still on Approve; a second Enter sends nothing', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const studio = makeStudio(gated(), { caps: { ...DEFAULT_CAPS, byok: true } });
    atWidth(390, studio);
    const approve = within(screen.getByRole('region', { name: 'Waiting for your approval' })).getByRole('button', { name: 'Approve' });
    approve.focus();
    // Enter on a button = a click (the browser's activation behaviour).
    fireEvent.keyDown(approve, { key: 'Enter' });
    fireEvent.click(approve);
    expect(studio.act).toHaveBeenCalledTimes(1);
    expect(studio.act).toHaveBeenCalledWith({ type: 'approve_gate', gateId: 'gate_7' });
    act(() => {
      vi.advanceTimersByTime(300);
    });
    // Busy, but focusable: aria-disabled instead of disabled (a disabled button drops focus to <body> in Chromium).
    expect(approve).toHaveAttribute('aria-busy', 'true');
    expect(approve).toHaveAttribute('aria-disabled', 'true');
    expect(approve).not.toBeDisabled();
    expect(document.activeElement).toBe(approve);
    // The second Enter, while the first is in flight: its default is prevented and the click is swallowed.
    expect(fireEvent.keyDown(approve, { key: 'Enter' })).toBe(false);
    fireEvent.click(approve);
    expect(studio.act).toHaveBeenCalledTimes(1);
    act(() => {
      vi.advanceTimersByTime(4700);
    });
    expect(document.activeElement).toBe(approve);
    expect(studio.act).toHaveBeenCalledTimes(1);
  });
});

describe('Approve answers a gate once, however long the answer takes', () => {
  // Approve keeps focus while it is sent, so a second Enter lands on it again. The click guard alone lasts 4 s; the
  // gate's own Approve must stay inert until the gate closes, or the user sends a second approval that the server
  // refuses with "That approval is no longer open".
  const pressEnter = (el: HTMLElement) => {
    const notPrevented = fireEvent.keyDown(el, { key: 'Enter' });
    if (notPrevented) fireEvent.click(el);
  };
  const approveIn = () => within(screen.getByRole('region', { name: 'Waiting for your approval' })).getByRole('button', { name: 'Approve' });

  it('a second Enter after the 4 s guard, with the gate still open, sends nothing', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const studio = makeStudio(gated(), { caps: { ...DEFAULT_CAPS, byok: true } });
    atWidth(390, studio);
    const approve = approveIn();
    approve.focus();
    pressEnter(approve);
    expect(studio.act).toHaveBeenCalledTimes(1);
    await act(async () => {
      vi.advanceTimersByTime(4100);
    });
    expect(document.activeElement).toBe(approve);
    expect(approve).toHaveAttribute('aria-disabled', 'true');
    pressEnter(approve);
    fireEvent.click(approve);
    expect(studio.act).toHaveBeenCalledTimes(1);
    // Not now stays held too, so the two answers never race.
    expect(within(screen.getByRole('region', { name: 'Waiting for your approval' })).getByRole('button', { name: 'Not now' })).toBeDisabled();
  });

  it('an approval that failed can be sent again once the guard ends', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const act1 = vi.fn(async () => ({ ok: false, aborted: false, retryable: true, gated: false, error: 'offline' }));
    const studio = { ...makeStudio(gated(), { caps: { ...DEFAULT_CAPS, byok: true } }), act: act1 };
    atWidth(390, studio);
    const approve = approveIn();
    approve.focus();
    pressEnter(approve);
    await act(async () => {
      vi.advanceTimersByTime(4100);
    });
    expect(approve).not.toHaveAttribute('aria-disabled');
    pressEnter(approve);
    expect(act1).toHaveBeenCalledTimes(2);
  });

  it('a new gate gets a fresh Approve', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const studio = makeStudio(gated(), { caps: { ...DEFAULT_CAPS, byok: true } });
    const view = atWidth(390, studio);
    pressEnter(approveIn());
    await act(async () => {
      vi.advanceTimersByTime(4100);
    });
    const next = gated();
    next.gate!.id = 'gate_8';
    view.rerender(atWidthEl(390, { ...studio, doc: next }));
    pressEnter(approveIn());
    expect(studio.act).toHaveBeenCalledTimes(2);
    expect(studio.act).toHaveBeenLastCalledWith({ type: 'approve_gate', gateId: 'gate_8' });
  });
});

describe('when the approved gate closes, focus lands on the board, not <body>', () => {
  it.each([390, 1280])('at %i px: Approve, the gate closes, focus is on the board tab panel', (w) => {
    const studio = makeStudio(gated(), { caps: { ...DEFAULT_CAPS, byok: true } });
    const view = atWidth(w, studio);
    const approve = within(screen.getByRole('region', { name: 'Waiting for your approval' })).getByRole('button', { name: 'Approve' });
    approve.focus();
    fireEvent.click(approve);
    expect(studio.act).toHaveBeenCalledWith({ type: 'approve_gate', gateId: 'gate_7' });
    // The server answers: the gate is approved, the banner and its Approve unmount.
    view.rerender(atWidthEl(w, { ...studio, doc: gated('approved') }));
    expect(screen.queryByRole('region', { name: 'Waiting for your approval' })).toBeNull();
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement?.id).toBe('board-panel');
  });

  it('focus the user moved elsewhere stays where they put it', () => {
    const studio = makeStudio(gated(), { caps: { ...DEFAULT_CAPS, byok: true } });
    const view = atWidth(1280, studio);
    const approve = within(screen.getByRole('region', { name: 'Waiting for your approval' })).getByRole('button', { name: 'Approve' });
    approve.focus();
    const tab = screen.getAllByRole('tab')[0];
    tab.focus();
    view.rerender(atWidthEl(1280, { ...studio, doc: gated('approved') }));
    expect(document.activeElement).toBe(tab);
  });

  it('a gate that closes while focus was never in it does not take focus', () => {
    const studio = makeStudio(gated(), { caps: { ...DEFAULT_CAPS, byok: true } });
    const view = atWidth(1280, studio);
    (document.activeElement as HTMLElement | null)?.blur();
    view.rerender(atWidthEl(1280, { ...studio, doc: gated('declined') }));
    expect(document.activeElement).toBe(document.body);
  });
});

describe('board tab counts (FX-15)', () => {
  it('read at the 11 px chrome step (--ds-text-xs), never the old 10 px', () => {
    render(<BoardPane studio={makeStudio(makeSampleDoc())} />);
    const badges = screen.getAllByRole('tab').map((t) => t.querySelector(':scope > span.tabular-nums')).filter(Boolean) as HTMLElement[];
    expect(badges.length).toBeGreaterThan(0);
    for (const b of badges) {
      expect(cls(b)).toContain('text-[length:var(--ds-text-xs)]');
      expect(cls(b)).not.toContain('text-[10px]');
    }
  });
});
