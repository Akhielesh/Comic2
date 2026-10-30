// NoticeCard fix chips (plan §5.1, §6; K1 contract): free first, paid ones quoted in the user's terms and sent
// through the spend gate with their quote. Synthetic fixtures only.
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { emptyRender, pageSpecHash, type Card, type ComicDoc, type NoticeFix, type Page } from '../../../../shared/comic/doc';
import { formatUsd } from '../../../../shared/comic/models';
import { applyOps, type DocOp } from '../../../../shared/comic/ops';
import { DEFAULT_CAPS } from '../../../../shared/comic/capabilities';
import type { ComicStudioController } from '../../useStudio';
import { makeFakeStudio, makeSampleDoc, resetUsageStatus, showDollarPrices, showUsagePrices } from '../testing/fixtures';
import { NoticeCard, noticeChipState, noticeChips, noticePrice, type NoticeCardStudio } from './NoticeCard';

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

/** A synthetic 6-panel page 2 (the ids the notices above target): undrawn unless `drawn` is applied. */
const page2 = (): Page => ({
  id: 'pg_2',
  n: 2,
  summary: 'Maya spots the carrier.',
  layout: 'Row 1: two equal panels. Row 2: one wide panel. Row 3: three small panels.',
  panels: [1, 2, 3, 4, 5, 6].map((n) => ({
    id: `pg_2_p${n}`,
    n,
    size: n === 3 ? ('wide' as const) : n >= 4 ? ('small' as const) : ('medium' as const),
    shot: 'medium' as const,
    action: `Beat ${n}.`,
    castIds: ['c_maya'],
    lines: n === 6 ? [{ id: 'ln_6', kind: 'speech' as const, speakerId: 'c_maya', text: 'We wait until dark.' }] : []
  })),
  render: emptyRender(),
  balloons: []
});
const docWithPage2 = (over: Partial<ComicDoc> = {}): ComicDoc => {
  const doc = makeSampleDoc(over);
  doc.pages = doc.pages.map((p) => (p.id === 'pg_2' ? page2() : p));
  return doc;
};
/** Page 2 drawn and current (its render carries the spec hash it was drawn from). */
const drawnPage2 = (doc: ComicDoc): ComicDoc => ({
  ...doc,
  pages: doc.pages.map((p) =>
    p.id === 'pg_2' ? { ...p, render: { status: 'ready', history: [], asset: { path: 'u/x/pg_2.webp', source: 'generated', at: 1 }, specHash: pageSpecHash(doc, p) } } : p
  )
});
const withRender = (doc: ComicDoc, status: Page['render']['status']): ComicDoc => ({
  ...doc,
  pages: doc.pages.map((p) => (p.id === 'pg_2' ? { ...p, render: { ...p.render, status } } : p))
});

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

  it('a free chip dispatches its patch exactly (layoutFixOps, never a bare layout patch); "Done" is read from the live doc', async () => {
    const doc = docWithPage2();
    const studio = fakeStudio({ doc });
    const { rerender } = render(<NoticeCard card={heldBackNotice()} studio={studio} />);
    const chip = () => screen.getByRole('button', { name: /^Use the layout that fits/ });
    fireEvent.click(chip());
    await flush();
    expect(studio.act).toHaveBeenCalledTimes(1);
    expect(studio.act).toHaveBeenCalledWith({ type: 'patch', ops: layoutOps });
    // the tap alone proves nothing (the patch may still be rejected): the chip stays as it was
    expect(chip()).toBeEnabled();
    expect(chip()).toHaveAccessibleName('Use the layout that fits, Free');
    // the doc now carries the layout (the optimistic edit, the server's echo, or a reload): Done, disabled
    rerender(<NoticeCard card={heldBackNotice()} studio={{ ...studio, doc: applyOps(doc, layoutOps) }} />);
    expect(chip()).toBeDisabled();
    expect(chip()).toHaveAccessibleName('Use the layout that fits, Done');
    expect(chip()).toHaveAttribute('data-state', 'done');
    // the server rejected it and the doc rolled back: offered again
    rerender(<NoticeCard card={heldBackNotice()} studio={{ ...studio, doc }} />);
    expect(chip()).toBeEnabled();
    expect(chip()).toHaveAccessibleName('Use the layout that fits, Free');
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

  it('a "free" flag on a spend action never makes it free: priced when quoted, not offered when unquoted', async () => {
    const sneaky: NoticeFix = { label: 'Redraw page 2', free: true, action: { type: 'render_pages', pageIds: ['pg_2'], force: true, quotedUsd: 0.0845 } };
    const unquoted: NoticeFix = { label: 'Redraw page 3', free: true, action: { type: 'render_pages', pageIds: ['pg_3'], force: true } };
    const chips = noticeChips([sneaky, unquoted, { label: 'Use the layout that fits', free: true, action: { type: 'patch', ops: layoutOps } }]);
    expect(chips.map((c) => [c.fix.label, c.paid, c.usd])).toEqual([
      ['Use the layout that fits', false, undefined],
      ['Redraw page 2', true, 0.0845]
    ]);
    const studio = fakeStudio();
    render(<NoticeCard card={{ type: 'notice', id: 'n_s', tone: 'info', text: 'Check page 2.', fixes: [sneaky, unquoted] }} studio={studio} />);
    const chip = screen.getByRole('button', { name: `Redraw page 2, ≈${formatUsd(0.0845)}` });
    expect(chip).not.toHaveTextContent('Free');
    expect(screen.queryByRole('button', { name: /Redraw page 3/ })).toBeNull();
    fireEvent.click(chip);
    await flush();
    expect(studio.act).toHaveBeenCalledWith({ type: 'render_pages', pageIds: ['pg_2'], force: true, quotedUsd: 0.0845 });
  });

  it('a paid fix quoted at 0 is never badged "Free": it is not offered (nothing is left to draw)', () => {
    const zero: NoticeFix = { label: 'Draw page 2 anyway', free: false, action: { type: 'render_pages', pageIds: ['pg_2'], quotedUsd: 0 } };
    const free: NoticeFix = { label: 'Use the layout that fits', free: true, action: { type: 'patch', ops: layoutOps } };
    expect(noticeChips([zero])).toEqual([]);
    expect(noticeChips([zero, free]).map((c) => c.fix.label)).toEqual(['Use the layout that fits']);
    // a negative or non-finite quote is no quote either
    expect(noticeChips([{ ...zero, action: { ...zero.action, quotedUsd: -1 } as NoticeFix['action'] }])).toEqual([]);
    expect(noticeChips([{ ...zero, action: { ...zero.action, quotedUsd: Number.NaN } as NoticeFix['action'] }])).toEqual([]);
    for (const byok of [false, true]) {
      const { container, unmount } = render(<NoticeCard card={{ type: 'notice', id: 'n_z', tone: 'info', text: 'Page 2.', fixes: [zero, free] }} studio={fakeStudio({ byok })} />);
      expect(screen.queryByRole('button', { name: /Draw page 2 anyway/ })).toBeNull();
      expect(container.textContent).not.toMatch(/Draw page 2 anyway/);
      // "Free" is on the free chip only
      expect(screen.getAllByText('Free')).toHaveLength(1);
      expect(screen.getByRole('button', { name: 'Use the layout that fits, Free' })).toBeInTheDocument();
      unmount();
    }
    // the one price helper never writes "Free" for a positive amount (it is the breakdown card's paidAmount too)
    expect(noticePrice({ governed: false, badge: (u: number) => (u === 0 ? 'Free' : `≈${formatUsd(u)}`) } as never, 0.004, true)).toBe(`≈${formatUsd(0.004)} on your key`);
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
      // The badge never breaks inside a word ("Fr / ee" at 320 px): no anywhere-wrap, no shrinking below its word.
      const badge = chip.querySelector('[data-fix-badge]')!;
      expect(badge.className).not.toMatch(/overflow-wrap:anywhere|\bmin-w-0\b/);
      if (!/\s/.test(badge.textContent!.trim())) expect(badge.className).toMatch(/\bshrink-0\b.*\bwhitespace-nowrap\b|\bwhitespace-nowrap\b.*\bshrink-0\b/);
    }
    expect(within(group).getAllByRole('button').map((b) => b.querySelector('[data-fix-badge]')!.textContent)).toContain('Free');
    expect(group.parentElement!.className).toMatch(/\bmin-w-0\b/);
  });

  it('a layout fix after the page was drawn anyway is hidden (it would put a drawn page out of date); so is its Draw anyway', () => {
    const doc = drawnPage2(docWithPage2());
    // the free layout fix would change page.layout and panel sizes — both in pageSpecHash
    const [layoutChip, anywayChip] = noticeChips(heldBackNotice().fixes);
    expect(noticeChipState(doc, layoutChip)).toBe('hidden');
    expect(noticeChipState(docWithPage2(), layoutChip)).toBe('live');
    // "Draw page 2 anyway (with the rest)": page 2 needs no drawing now
    expect(noticeChipState(doc, anywayChip)).toBe('hidden');
    const { container } = render(<NoticeCard card={heldBackNotice()} studio={fakeStudio({ doc })} />);
    expect(container.querySelector('button')).toBeNull();
    expect(screen.queryByRole('group', { name: 'Fixes' })).toBeNull();
    // the words stay
    expect(screen.getByRole('status')).toHaveTextContent('Page 2 is held back');
  });

  it('a caption fix on a drawn overlay page stays free and offered (overlay lines are not in the drawing); a patch whose target is gone is hidden', () => {
    const doc = drawnPage2(docWithPage2());
    expect(doc.format.lettering).not.toBe('in_art');
    render(<NoticeCard card={qcNotice()} studio={fakeStudio({ doc })} />);
    expect(screen.getByRole('button', { name: "Make Meera's line in panel 6 a caption, Free" })).toBeEnabled();
    expect(screen.getByRole('button', { name: /^Redraw panel 6 with Meera/ })).toBeEnabled();
    expect(screen.getByRole('button', { name: /^Redraw page 2/ })).toBeEnabled();
    // in-art lettering is part of the picture: the same patch would put the page out of date, so it is not offered free
    const inArt = drawnPage2(docWithPage2({ format: { ...makeSampleDoc().format, lettering: 'in_art' } }));
    expect(noticeChipState(inArt, noticeChips(qcNotice().fixes)[0])).toBe('hidden');
    // already a caption: Done
    const captioned = applyOps(doc, (qcNotice().fixes![0].action as { ops: DocOp[] }).ops);
    expect(noticeChipState(captioned, noticeChips(qcNotice().fixes)[0])).toBe('done');
    // the page (or the line) is gone: nothing to fix
    const gone = { ...doc, pages: doc.pages.filter((p) => p.id !== 'pg_2') };
    expect(noticeChips(qcNotice().fixes).map((c) => noticeChipState(gone, c))).toEqual(['hidden', 'hidden', 'hidden']);
  });

  it('a paid Draw-page chip is hidden once the page is drawn and current (quoteRenderPages says nothing is left)', () => {
    const notice: Notice = {
      type: 'notice',
      id: 'n_one',
      tone: 'info',
      text: 'Page 2 is held back.',
      fixes: [{ label: 'Draw page 2 anyway', free: false, action: { type: 'render_pages', pageIds: ['pg_2'], quotedUsd: 0.0845 } }]
    };
    const { rerender } = render(<NoticeCard card={notice} studio={fakeStudio({ doc: docWithPage2() })} />);
    expect(screen.getByRole('button', { name: `Draw page 2 anyway, ≈${formatUsd(0.0845)}` })).toBeEnabled();
    rerender(<NoticeCard card={notice} studio={fakeStudio({ doc: drawnPage2(docWithPage2()) })} />);
    expect(screen.queryByRole('button', { name: /Draw page 2 anyway/ })).toBeNull();
    // drawn but out of date again: offered again
    const stale = drawnPage2(docWithPage2());
    stale.pages = stale.pages.map((p) => (p.id === 'pg_2' ? { ...p, layout: 'Row 1: three equal panels. Row 2: three equal panels.' } : p));
    rerender(<NoticeCard card={notice} studio={fakeStudio({ doc: stale })} />);
    expect(screen.getByRole('button', { name: /^Draw page 2 anyway/ })).toBeEnabled();
  });

  it('a paid chip whose page is drawing reads "Started" and cannot be tapped again', () => {
    const doc = withRender(docWithPage2(), 'rendering');
    const studio = fakeStudio({ doc });
    render(<NoticeCard card={qcNotice()} studio={studio} />);
    for (const name of [/^Redraw panel 6 with Meera/, /^Redraw page 2/]) {
      const chip = screen.getByRole('button', { name });
      expect(chip).toBeDisabled();
      expect(chip).toHaveAttribute('data-state', 'started');
      expect(chip).toHaveTextContent('Started');
      expect(chip).not.toHaveTextContent(formatUsd(0.0845));
    }
    expect(noticeChipState(withRender(docWithPage2(), 'queued'), noticeChips(qcNotice().fixes)[2])).toBe('started');
  });

  it('a paid chip that ran reads "Started" until the doc changes; one that opened an approval card, or failed, stays offered', async () => {
    const doc = docWithPage2();
    const ok = { ok: true, aborted: false, retryable: false, gated: false };
    const studio = fakeStudio({ doc, act: vi.fn(async () => ok) });
    const { rerender, unmount } = render(<NoticeCard card={qcNotice()} studio={studio} />);
    const chip = () => screen.getByRole('button', { name: /^Redraw page 2/ });
    fireEvent.click(chip());
    await waitFor(() => expect(chip()).toHaveAttribute('data-state', 'started'));
    expect(chip()).toBeDisabled();
    expect(chip()).toHaveAccessibleName('Redraw page 2, Started');
    expect(studio.act).toHaveBeenCalledTimes(1);
    // a re-render with the same doc keeps it
    rerender(<NoticeCard card={qcNotice()} studio={{ ...studio }} />);
    await flush();
    expect(chip()).toBeDisabled();
    // the doc changed: re-checked against it (still something to draw here), priced again
    rerender(<NoticeCard card={qcNotice()} studio={{ ...studio, doc: { ...doc, rev: doc.rev + 1 } }} />);
    await waitFor(() => expect(chip()).toBeEnabled());
    expect(chip()).toHaveAccessibleName(`Redraw page 2, ≈${formatUsd(0.0845)}`);
    unmount();

    for (const outcome of [{ ...ok, gated: true }, { ...ok, ok: false }]) {
      const s2 = fakeStudio({ doc, act: vi.fn(async () => outcome) });
      const r = render(<NoticeCard card={qcNotice()} studio={s2} />);
      fireEvent.click(chip());
      await waitFor(() => expect(s2.act).toHaveBeenCalledTimes(1));
      await flush();
      await flush();
      expect(chip()).toBeEnabled();
      expect(chip()).toHaveAttribute('data-state', 'live');
      r.unmount();
    }
  });

  it('the live controller is a NoticeCardStudio: CardRenderer only has to pass it (wave note), with its doc', async () => {
    // compile-time: ComicStudioController satisfies the card's studio contract (act, byok, caps, doc)
    const asNoticeStudio = (c: ComicStudioController): NoticeCardStudio => c;
    const controller = makeFakeStudio({ doc: drawnPage2(docWithPage2()) });
    const { container } = render(<NoticeCard card={heldBackNotice()} studio={asNoticeStudio(controller)} />);
    // its doc is read: page 2 is drawn and current, so the held-back fixes are gone
    expect(container.querySelector('button')).toBeNull();
    const live = makeFakeStudio({ doc: docWithPage2() });
    render(<NoticeCard card={qcNotice()} studio={asNoticeStudio(live)} />);
    const group = screen.getByRole('group', { name: 'Fixes' });
    expect(within(group).getAllByRole('button').map((b) => b.getAttribute('data-fix'))).toEqual(['free', 'paid', 'paid']);
    fireEvent.click(within(group).getByRole('button', { name: /^Redraw page 2/ }));
    await flush();
    expect(live.act).toHaveBeenCalledWith({ type: 'render_pages', pageIds: ['pg_2'], force: true, quotedUsd: 0.0845 });
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
