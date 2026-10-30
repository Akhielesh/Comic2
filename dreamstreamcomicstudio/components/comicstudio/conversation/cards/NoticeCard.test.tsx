// NoticeCard fix chips (plan §5.1, §6; K1 contract): free first, paid ones quoted in the user's terms and sent
// through the spend gate with their quote. Synthetic fixtures only.
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { Card, NoticeFix } from '../../../../shared/comic/doc';
import { formatUsd } from '../../../../shared/comic/models';
import type { DocOp } from '../../../../shared/comic/ops';
import { DEFAULT_CAPS } from '../../../../shared/comic/capabilities';
import { resetUsageStatus, showDollarPrices, showUsagePrices } from '../testing/fixtures';
import { NoticeCard, noticeChips, type NoticeCardStudio } from './NoticeCard';

type Notice = Extract<Card, { type: 'notice' }>;

const NO_DOLLARS = /\$\s?\d|\$0\b|<\$/;
const layoutOps: DocOp[] = [
  { op: 'page', id: 'pg_2', patch: { layout: 'Row 1: three small panels. Row 2: two equal panels. Row 3: one wide panel.' } },
  { op: 'panel', pageId: 'pg_2', id: 'pg_2_p3', patch: { size: 'medium' } },
  { op: 'panel', pageId: 'pg_2', id: 'pg_2_p6', patch: { size: 'wide' } }
];

/** A held-back notice as jobs.ts heldBackNotice posts it next to an open Render-all gate — paid listed FIRST on
 *  purpose, so the test proves the card puts the free fix first. */
const heldBackNotice = (): Notice => ({
  type: 'notice',
  id: 'n_held',
  tone: 'info',
  text: 'Page 2 is held back: panel 6 has 29 words in 8% of the page (it holds about 9). Free fixes: use the layout that fits, split the page, move a line, make it a caption — or draw it anyway.',
  fixes: [
    { label: 'Draw page 2 anyway (with the rest)', free: false, action: { type: 'render_pages', drawOverfull: ['pg_2'], includeCover: true, quotedUsd: 0.2795 } },
    { label: 'Use the layout that fits', free: true, action: { type: 'patch', ops: layoutOps } }
  ]
});

/** A page-check notice as qcNotice.ts builds it (free caption fix, then paid redraws, one a safer take). */
const qcNotice = (): Notice => ({
  type: 'notice',
  id: 'n_qc',
  tone: 'warn',
  text: 'Check panels on page 2: Meera may not be drawn in panel 6, but she speaks there.',
  fixes: [
    { label: "Make Meera's line in panel 6 a caption", free: true, action: { type: 'patch', ops: [{ op: 'line', pageId: 'pg_2', panelId: 'pg_2_p6', id: 'ln_6', patch: { kind: 'caption' } }] } },
    {
      label: 'Redraw panel 6 with Meera',
      free: false,
      action: { type: 'edit_page', pageId: 'pg_2', panelN: 6, instruction: 'In panel 6 only, draw MEERA clearly.', safe: true, quotedUsd: 0.0845 }
    },
    { label: 'Redraw page 2', free: false, action: { type: 'render_pages', pageIds: ['pg_2'], force: true, quotedUsd: 0.0845 } }
  ]
});

const fakeStudio = (over: Partial<NoticeCardStudio> = {}): NoticeCardStudio & { act: ReturnType<typeof vi.fn> } =>
  ({ act: vi.fn(async () => undefined), byok: false, caps: DEFAULT_CAPS, ...over }) as NoticeCardStudio & { act: ReturnType<typeof vi.fn> };

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(showDollarPrices);
afterEach(resetUsageStatus);

describe('NoticeCard fix chips', () => {
  it('renders card.fixes as chips, free first, each paid one with its quote', () => {
    render(<NoticeCard card={heldBackNotice()} studio={fakeStudio()} />);
    const group = screen.getByRole('group', { name: 'Fixes' });
    const chips = within(group).getAllByRole('button');
    expect(chips.map((c) => c.getAttribute('data-fix'))).toEqual(['free', 'paid']);
    expect(chips[0]).toHaveAccessibleName('Use the layout that fits, Free');
    expect(chips[1]).toHaveAccessibleName(`Draw page 2 anyway (with the rest), ≈${formatUsd(0.2795)}`);
    // the words stay in the live region; the chips sit beside it
    expect(screen.getByRole('status')).toHaveTextContent('Page 2 is held back');
    expect(within(screen.getByRole('status')).queryByRole('button')).toBeNull();
  });

  it('a free chip dispatches its patch exactly (layoutFixOps, never a bare layout patch) and then reads Done', async () => {
    const studio = fakeStudio();
    render(<NoticeCard card={heldBackNotice()} studio={studio} />);
    fireEvent.click(screen.getByRole('button', { name: /^Use the layout that fits/ }));
    await flush();
    expect(studio.act).toHaveBeenCalledTimes(1);
    expect(studio.act).toHaveBeenCalledWith({ type: 'patch', ops: layoutOps });
    const done = screen.getByRole('button', { name: /^Use the layout that fits/ });
    expect(done).toBeDisabled();
    expect(done).toHaveTextContent('Done');
  });

  it('a paid chip goes through the spend gate: its action as is, with its quotedUsd (and safe: true kept)', async () => {
    const studio = fakeStudio();
    render(<NoticeCard card={heldBackNotice()} studio={studio} />);
    fireEvent.click(screen.getByRole('button', { name: /^Draw page 2 anyway/ }));
    await flush();
    expect(studio.act).toHaveBeenCalledWith({ type: 'render_pages', drawOverfull: ['pg_2'], includeCover: true, quotedUsd: 0.2795 });

    const s2 = fakeStudio();
    render(<NoticeCard card={qcNotice()} studio={s2} />);
    const group = screen.getAllByRole('group', { name: 'Fixes' })[1];
    expect(within(group).getAllByRole('button').map((b) => b.getAttribute('data-fix'))).toEqual(['free', 'paid', 'paid']);
    fireEvent.click(within(group).getByRole('button', { name: /^Redraw panel 6 with Meera/ }));
    await flush();
    expect(s2.act).toHaveBeenCalledWith({
      type: 'edit_page',
      pageId: 'pg_2',
      panelN: 6,
      instruction: 'In panel 6 only, draw MEERA clearly.',
      safe: true,
      quotedUsd: 0.0845
    });
    fireEvent.click(within(group).getByRole('button', { name: /^Make Meera's line in panel 6 a caption/ }));
    await flush();
    expect(s2.act).toHaveBeenLastCalledWith(qcNotice().fixes![0].action);
  });

  it('governed users see a share of their usage and never dollars; BYOK users see "on your key"', () => {
    showUsagePrices(1);
    const { container, unmount } = render(<NoticeCard card={qcNotice()} studio={fakeStudio()} />);
    expect(container.textContent).not.toMatch(NO_DOLLARS);
    expect(screen.getByRole('button', { name: /^Redraw panel 6 with Meera, (≈[\d.]+%|<0\.1%) of your usage$/ })).toBeInTheDocument();
    unmount();

    resetUsageStatus();
    render(<NoticeCard card={qcNotice()} studio={fakeStudio({ byok: true })} />);
    expect(screen.getByRole('button', { name: `Redraw panel 6 with Meera, ≈${formatUsd(0.0845)} on your key` })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: "Make Meera's line in panel 6 a caption, Free" })).toBeInTheDocument();
  });

  it('a "free" flag on a spend action never makes it free: it is priced, and an unquoted one is sent at quotedUsd 0', async () => {
    const sneaky: NoticeFix = { label: 'Redraw page 2', free: true, action: { type: 'render_pages', pageIds: ['pg_2'], force: true } };
    const chips = noticeChips([sneaky, { label: 'Use the layout that fits', free: true, action: { type: 'patch', ops: layoutOps } }]);
    expect(chips.map((c) => [c.fix.label, c.paid])).toEqual([
      ['Use the layout that fits', false],
      ['Redraw page 2', true]
    ]);
    const studio = fakeStudio();
    render(<NoticeCard card={{ type: 'notice', id: 'n_s', tone: 'info', text: 'Check page 2.', fixes: [sneaky] }} studio={studio} />);
    const chip = screen.getByRole('button', { name: 'Redraw page 2' });
    expect(chip).not.toHaveTextContent('Free');
    fireEvent.click(chip);
    await flush();
    expect(studio.act).toHaveBeenCalledWith({ type: 'render_pages', pageIds: ['pg_2'], force: true, quotedUsd: 0 });
  });

  it('a price a server wrote into the label reads once, in the badge', () => {
    render(
      <NoticeCard
        card={{ type: 'notice', id: 'n_l', tone: 'info', text: 'x', fixes: [{ label: 'Draw page 2 anyway · ≈$0.08', free: false, action: { type: 'render_pages', pageIds: ['pg_2'], quotedUsd: 0.0845 } }] }}
        studio={fakeStudio()}
      />
    );
    expect(screen.getByRole('button', { name: `Draw page 2 anyway, ≈${formatUsd(0.0845)}` })).toBeInTheDocument();
  });

  it('phone layout: chips wrap inside the card, long labels wrap, 44 px touch targets', () => {
    const long: Notice = {
      ...qcNotice(),
      fixes: [{ label: `Make ${'Supercalifragilistic'.repeat(4)}'s line a caption`, free: true, action: { type: 'patch', ops: [] } }, ...qcNotice().fixes!]
    };
    render(<NoticeCard card={long} studio={fakeStudio()} />);
    const group = screen.getByRole('group', { name: 'Fixes' });
    expect(group.className).toMatch(/\bflex-wrap\b/);
    expect(group.className).toMatch(/\bmin-w-0\b/);
    for (const chip of within(group).getAllByRole('button')) {
      expect(chip.className).toMatch(/coarse:min-h-\[44px\]/);
      expect(chip.className).toMatch(/\bmax-w-full\b/);
      expect(chip.className).toMatch(/\bmin-w-0\b/);
      expect(chip.querySelector('span')!.className).toMatch(/overflow-wrap:anywhere/);
    }
    expect(group.parentElement!.className).toMatch(/\bmin-w-0\b/);
  });

  it('back-compat: a notice without fixes, or rendered without a controller, is the same calm line as before', () => {
    const { container, unmount } = render(<NoticeCard card={{ type: 'notice', id: 'n_plain', tone: 'error', text: 'Connect a Gemini key.' }} studio={fakeStudio()} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Connect a Gemini key.');
    expect(container.querySelector('button')).toBeNull();
    unmount();
    // CardRenderer passes no controller today (wave note): the text shows, no dead buttons.
    const r = render(<NoticeCard card={heldBackNotice()} />);
    expect(screen.getByRole('status')).toHaveTextContent('Page 2 is held back');
    expect(r.container.querySelector('button')).toBeNull();
  });
});
