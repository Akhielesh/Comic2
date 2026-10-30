import React from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { emptyRender, type Card, type Character, type ComicDoc, type Gate } from '../../../../shared/comic/doc';
import { estimateJobs, formatUsd } from '../../../../shared/comic/models';
import { quoteRenderPages } from '../../../../shared/comic/plan';
import { CARD_TYPES, CardRenderer } from './CardRenderer';
import { gateBreakdownCard, gateModelName, gateReasonCopy, messageHasGateBreakdown } from './GateCard';
import { OptionsCard, joinChoices } from './OptionsCard';
import { PlanList, estimatePlanRender, pagesToDraw, sheetsNeededFor } from './PlanCard';
import { failureSummary, retryAllFailed } from './RendersCard';
import { lockedOptionId } from './StyleChoiceCard';
import { RenderThumb } from './renderTile';
import { quoteStyleOptions } from '../panels/StylePanel';
import { castStatusLine } from './CastCard';
import { castRoleLabel } from './castVisual';
import { recapRows } from './recap';
import { makeFakeStudio, makeSampleDoc, resetUsageStatus, showDollarPrices } from '../testing/fixtures';

// Dollar figures below are what admins / own-key users see; the governed wording has its own tests.
beforeEach(showDollarPrices);
afterEach(resetUsageStatus);

const renderCard = (card: Card, doc: ComicDoc = makeSampleDoc(), extra: Parameters<typeof makeFakeStudio>[0] = {}) => {
  const studio = makeFakeStudio({ doc, ...extra });
  const utils = render(<CardRenderer card={card} studio={studio} />);
  return Object.assign(studio, { container: utils.container });
};

const ducklings = (extra: Partial<Character> = {}): Character => ({
  id: 'c_duck',
  name: 'Ducklings',
  tier: 'support',
  kind: 'animal',
  count: 3,
  look: { summary: 'Three fluffy yellow ducklings' },
  refs: [],
  sheet: emptyRender(),
  ...extra
});

describe('OptionsCard', () => {
  const card: Card = {
    type: 'options',
    id: 'card_o',
    question: 'What tone should it have?',
    choices: [
      { id: 'a', label: 'Moody noir', reply: 'Make it moody noir' },
      { id: 'b', label: 'Playful' },
      { id: 'c', label: 'Epic', description: 'Big, cinematic' }
    ]
  };

  it('a tap sends the choice reply and locks the card', () => {
    const studio = renderCard(card);
    expect(screen.getByText('What tone should it have?')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Moody noir/ }));
    expect(studio.send).toHaveBeenCalledWith('Make it moody noir', { card: { id: 'card_o', choiceIds: ['a'] } });
    expect(screen.getByRole('button', { name: /Playful/ })).toBeDisabled();
  });

  it('falls back to the label when there is no reply', () => {
    const studio = renderCard(card);
    fireEvent.click(screen.getByRole('button', { name: /Playful/ }));
    expect(studio.send).toHaveBeenCalledWith('Playful', { card: { id: 'card_o', choiceIds: ['b'] } });
  });

  it('multi-select collects picks until Done', () => {
    const studio = renderCard({ ...card, multi: true });
    fireEvent.click(screen.getByRole('button', { name: /Playful/ }));
    fireEvent.click(screen.getByRole('button', { name: /Epic/ }));
    expect(studio.send).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Done (2)' }));
    expect(studio.send).toHaveBeenCalledWith('Playful and Epic', { card: { id: 'card_o', choiceIds: ['b', 'c'] } });
  });

  it('accepts a custom answer', () => {
    const studio = renderCard({ ...card, allowCustom: true });
    fireEvent.change(screen.getByLabelText('Your own answer'), { target: { value: '  Bittersweet ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send answer' }));
    // A typed answer is recorded on the card too (DIR-8), not only matched by its text.
    expect(studio.send).toHaveBeenCalledWith('Bittersweet', { card: { id: 'card_o', custom: 'Bittersweet' } });
    expect(screen.getByText(/You answered/)).toHaveTextContent('Bittersweet');
  });

  it('two open cards sharing a label record the one that was tapped', () => {
    const studio = makeFakeStudio({ doc: makeSampleDoc() });
    const yesNo = (id: string, question: string): Card => ({ type: 'options', id, question, choices: [{ id: `${id}_y`, label: 'Yes' }, { id: `${id}_n`, label: 'No' }] });
    render(
      <>
        <CardRenderer card={yesNo('card_first', 'Keep the rain?')} studio={studio} />
        <CardRenderer card={yesNo('card_second', 'Add a cat?')} studio={studio} />
      </>
    );
    const first = screen.getByRole('region', { name: 'Keep the rain?' });
    fireEvent.click(within(first).getByRole('button', { name: /Yes/ }));
    expect(studio.send).toHaveBeenCalledTimes(1);
    expect(studio.send).toHaveBeenCalledWith('Yes', { card: { id: 'card_first', choiceIds: ['card_first_y'] } });
  });

  it('a server-answered card is disabled and marks the answer; busy turns disable it too', () => {
    renderCard({ ...card, answered: ['b'] });
    expect(screen.getByRole('button', { name: /Playful/ })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: /Epic/ })).toBeDisabled();
  });

  it('is disabled while a director turn streams', () => {
    renderCard(card, makeSampleDoc(), { messageBusy: true });
    expect(screen.getByRole('button', { name: /Playful/ })).toBeDisabled();
  });

  it('joinChoices reads naturally', () => {
    expect(joinChoices(['a'])).toBe('a');
    expect(joinChoices(['a', 'b'])).toBe('a and b');
    expect(joinChoices(['a', 'b', 'c'])).toBe('a, b and c');
  });

  describe('visual tiles', () => {
    const visualCard: Card = {
      type: 'options',
      id: 'card_v',
      question: 'How busy should page 1 be?',
      choices: [
        { id: 'l4', label: '4 panels', reply: 'Four panels', visual: { kind: 'layout', panels: 4 } },
        { id: 'p3', label: 'Three pages', visual: { kind: 'pages', count: 3 } },
        { id: 'st', label: 'Noir ink', visual: { kind: 'preset', presetId: 'noir-ink' } },
        { id: 'ca', label: 'Maya leads', visual: { kind: 'cast', characterId: 'c_maya' } },
        { id: 'le', label: 'Classic balloons', visual: { kind: 'lettering', presetId: 'classic' } }
      ]
    };

    it('renders picture tiles (layout glyph, page stack, preset, cast, balloon) and a tap answers', () => {
      const studio = renderCard(visualCard);
      const group = screen.getByRole('group', { name: 'Choices' });
      const tiles = within(group).getAllByRole('button');
      expect(tiles).toHaveLength(5);
      // layout glyph: one rect per panel plus the page outline
      expect(tiles[0].querySelectorAll('svg rect').length).toBe(5);
      // the page stack prints the count
      expect(within(tiles[1]).getByText('3')).toBeInTheDocument();
      // the cast tile shows the sheet art
      expect(tiles[3].querySelector('img')).toHaveAttribute('src', 'https://cdn.test/u/x/p/maya.webp');
      // the lettering swatch
      expect(tiles[4].querySelector('svg')).not.toBeNull();
      fireEvent.click(tiles[0]);
      expect(studio.send).toHaveBeenCalledWith('Four panels', { card: { id: 'card_v', choiceIds: ['l4'] } });
      expect(tiles[0]).toHaveAttribute('aria-pressed', 'true');
      expect(tiles[1]).toBeDisabled();
    });

    it('long labels wrap inside the tile (no overflow) and unknown visuals still render a tile', () => {
      const long = 'A'.repeat(120);
      render(
        <OptionsCard
          card={{ type: 'options', id: 'x', question: 'Q', choices: [{ id: 'z', label: long, visual: { kind: 'preset', presetId: 'nope' } }] }}
          studio={makeFakeStudio()}
        />
      );
      const label = screen.getByText(long);
      expect(label.className).toMatch(/line-clamp-2/);
      expect(label.className).toMatch(/overflow-wrap:anywhere/);
    });
  });
});

describe('StyleChoiceCard', () => {
  const card: Card = { type: 'style_choice', id: 'card_s' };

  it('shows each option with its live status; tapping a ready one picks it', () => {
    const studio = renderCard(card);
    expect(screen.getByText('Drawing 1 of 3…')).toBeInTheDocument();
    expect(screen.getByAltText('Inky noir')).toHaveAttribute('src', 'https://cdn.test/u/x/p/opt_a.webp');
    expect(screen.getByText('Drawing…')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Use the Inky noir style' }));
    expect(studio.act).toHaveBeenCalledWith({ type: 'pick_style', optionId: 'opt_a' });
  });

  it('a failed option reads calm: when + why, details on tap, retry the same direction', () => {
    // While another option is still drawing, Retry waits (the server draws one batch at a time).
    const busy = renderCard(card);
    expect(screen.getByRole('button', { name: 'Retry Retro' })).toBeDisabled();
    busy.container.remove();
    const doc = makeSampleDoc();
    doc.style.options = doc.style.options.map((o) => (o.id === 'opt_b' ? { ...o, render: { ...o.render, status: 'ready', asset: { path: 'u/x/p/opt_b.webp', source: 'generated', at: 1 } } } : o));
    const studio = renderCard(card, doc);
    // no red wall of text: the provider's words are behind "Details"
    expect(screen.getAllByText(/failed .*· the model declined/).length).toBeGreaterThan(0);
    const frame = document.querySelector('[data-failed]')!;
    expect(frame.className).toMatch(/justify-\[safe_center\]/);
    expect(frame.className).not.toMatch(/red-/);
    // small 4:5 tiles keep only icon + Retry in the frame (visualqa P1-5); the reason is in the caption
    expect(Array.from(frame.querySelectorAll('span:not(.sr-only)')).map((n) => n.textContent).join('')).not.toMatch(/declined/);
    fireEvent.click(screen.getByRole('button', { name: 'Details' }));
    expect(screen.getAllByText(/The model refused this one\./).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: 'Retry Retro' }));
    // the same direction is redrawn in place, with its own quote (no writer call: directions are passed)
    expect(studio.act).toHaveBeenCalledWith({
      type: 'render_style_options',
      directions: [{ name: 'Retro', spec: 'Halftone' }],
      quotedUsd: quoteStyleOptions(makeSampleDoc(), 1, false, true)
    });
  });

  it('retries every failed style option at once (the 2026-10-22 outage case)', async () => {
    const doc = makeSampleDoc();
    doc.style.options = doc.style.options.map((o) =>
      o.id === 'opt_b' ? { ...o, render: { status: 'failed', history: [], error: 'busy (rate limited) 429', updatedAt: Date.now() } } : o
    );
    const studio = renderCard(card, doc);
    const usd = estimateJobs([{ kind: 'style_option', count: 2 }], 'standard', { byok: false }).usd;
    fireEvent.click(screen.getByRole('button', { name: /Retry 2 failed styles/ }));
    await waitFor(() => expect(studio.act).toHaveBeenCalledTimes(1));
    expect(studio.act).toHaveBeenCalledWith({
      type: 'render_style_options',
      directions: [
        { name: 'Pastel', spec: 'Soft pastel' },
        { name: 'Retro', spec: 'Halftone' }
      ],
      quotedUsd: usd
    });
    expect(screen.getByText(/2 images didn’t finish/)).toBeInTheDocument();
  });

  it('marks the locked option and offers more options when idle', async () => {
    const doc = makeSampleDoc();
    doc.style = {
      ...doc.style,
      status: 'locked',
      board: { path: 'u/x/p/opt_a.webp', source: 'generated', at: 1 },
      options: doc.style.options.filter((o) => o.id !== 'opt_b')
    };
    expect(lockedOptionId(doc)).toBe('opt_a');
    const studio = renderCard(card, doc);
    expect(screen.getByText('Locked: Noir ink')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Use the Inky noir style' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /More options/ }));
    // the quote includes the writer call that proposes fresh directions, like the server gate
    const usd = quoteStyleOptions(doc, 3, false);
    expect(usd).toBeGreaterThan(estimateJobs([{ kind: 'style_option', count: 3 }], 'standard', { byok: false }).usd);
    expect(studio.act).toHaveBeenCalledWith({ type: 'render_style_options', quotedUsd: usd });
    expect(screen.getByRole('button', { name: /More options/ })).toHaveTextContent(formatUsd(usd));
  });

  it('explains when the options were replaced', () => {
    const doc = makeSampleDoc();
    doc.style = { ...doc.style, options: [] };
    renderCard(card, doc);
    expect(screen.getByText(/were replaced/)).toBeInTheDocument();
  });
});

describe('CastCard', () => {
  it('lists characters with sheet status and opens the cast tab', () => {
    const studio = renderCard({ type: 'cast', id: 'card_c', characterIds: ['c_maya', 'c_arjun', 'c_vendor', 'gone'] });
    expect(screen.getByText('1 of 2 sheets ready')).toBeInTheDocument();
    expect(screen.getByText('Lead · cat burglar · Sheet ready')).toBeInTheDocument();
    expect(screen.getByText('Support · detective · No sheet yet')).toBeInTheDocument();
    expect(screen.getByText('Extra · Described in text')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^Maya/ }));
    expect(studio.setTab).toHaveBeenCalledWith('cast');
  });

  it('the status text truncates in its own span, not on the flex row (visualqa P1-4)', () => {
    renderCard({ type: 'cast', id: 'card_c', characterIds: ['c_maya'] });
    const status = screen.getByText('Lead · cat burglar · Sheet ready');
    expect(status.className).toMatch(/\btruncate\b/);
    expect(status.className).toMatch(/\bmin-w-0\b/);
    expect(status.parentElement!.className).toMatch(/\bflex\b/);
    expect(status.parentElement!.className).not.toMatch(/\btruncate\b/);
  });

  it('non-human cast is first-class: kind icon, ×count, Companion label', () => {
    const doc = makeSampleDoc();
    doc.cast = [...doc.cast, ducklings(), { ...ducklings({ id: 'c_kite', name: 'Red kite', kind: 'object', tier: 'extra', count: undefined }) }];
    renderCard({ type: 'cast', id: 'card_c', characterIds: ['c_duck', 'c_kite'] }, doc);
    expect(screen.getByText('×3')).toBeInTheDocument();
    expect(screen.getByText('Companion · group of 3 · No sheet yet')).toBeInTheDocument();
    expect(screen.getByText('Prop · Described in text')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Ducklings, group of 3 animals, Companion/ })).toBeInTheDocument();
    // the kind icon stands in for initials when there is no art
    expect(screen.getByRole('button', { name: /Ducklings/ }).querySelector('svg.lucide-paw-print')).not.toBeNull();
    expect(screen.getByText(/The companion gets a reference sheet too, so it looks the same on every page/)).toBeInTheDocument();
  });

  it('castRoleLabel: leads stay leads; non-human supports are companions', () => {
    expect(castRoleLabel(ducklings())).toBe('Companion');
    expect(castRoleLabel(ducklings({ tier: 'lead' }))).toBe('Lead');
    expect(castRoleLabel(ducklings({ kind: 'person' }))).toBe('Support');
    expect(castRoleLabel(ducklings({ tier: 'extra', kind: 'object' }))).toBe('Prop');
    expect(castStatusLine(ducklings({ count: 1 }))).toBe('Companion · animal · No sheet yet');
  });

  it('an unknown kind (newer server, bad write) reads as a person instead of breaking the card', () => {
    const doc = makeSampleDoc();
    doc.cast = [...doc.cast, ducklings({ id: 'c_odd', name: 'Glorp', kind: 'hologram' as never, count: 1 })];
    renderCard({ type: 'cast', id: 'card_c', characterIds: ['c_odd'] }, doc);
    expect(screen.queryByText(/couldn’t be shown/)).toBeNull();
    expect(screen.getByRole('button', { name: /^Glorp, Companion/ })).toBeInTheDocument();
  });

  it('draws missing sheets for leads and supports only, with the quote', () => {
    const studio = renderCard({ type: 'cast', id: 'card_c', characterIds: ['c_maya', 'c_arjun', 'c_vendor'] });
    fireEvent.click(screen.getByRole('button', { name: /Draw 1 sheet/ }));
    expect(studio.act).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'render_sheets', characterIds: ['c_arjun'], force: false, quotedUsd: expect.any(Number) })
    );
  });
});

describe('PlanCard', () => {
  const card: Card = { type: 'plan', id: 'card_p' };

  it('renders the page breakdown ABOVE the kept approve-all button (decisions-final #3)', async () => {
    const studio = renderCard(card);
    const breakdown = screen.getByRole('region', { name: 'Page breakdown' });
    const filmstrip = within(breakdown).getByRole('list');
    const approve = within(breakdown).getByRole('button', { name: /Approve & (draw|render) all/ });
    // the filmstrip comes first in reading order, then the button
    expect(filmstrip.compareDocumentPosition(approve) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(approve);
    await waitFor(() => expect(studio.act).toHaveBeenCalledTimes(2));
    expect(studio.act.mock.calls[0][0]).toEqual({ type: 'approve_plan' });
    expect(studio.act.mock.calls[1][0]).toMatchObject({ type: 'render_pages' });
  });

  describe('fallback list (no breakdown feature)', () => {
    it('lists pages and approves + renders with the honest estimate', async () => {
      const doc = makeSampleDoc();
      const studio = makeFakeStudio({ doc });
      render(<PlanList card={card as Extract<Card, { type: 'plan' }>} studio={studio} />);
      expect(screen.getByText('3 pages · 6 panels')).toBeInTheDocument();
      expect(screen.getByText('Drawn')).toBeInTheDocument();
      expect(screen.getByText('Didn’t finish')).toBeInTheDocument();
      const q = quoteRenderPages(doc, { byok: false, tier: 'standard' });
      fireEvent.click(screen.getByRole('button', { name: `Approve & render all (≈ ${formatUsd(q.usd)})` }));
      await waitFor(() => expect(studio.act).toHaveBeenCalledTimes(2));
      expect(studio.act.mock.calls.map((c) => c[0])).toEqual([{ type: 'approve_plan' }, { type: 'render_pages', quotedUsd: q.usd }]);
    });

    it('an approved plan offers to draw what is left; opens pages and the plan', () => {
      const studio = makeFakeStudio({ doc: makeSampleDoc({ planStatus: 'approved' }) });
      render(<PlanList card={card as Extract<Card, { type: 'plan' }>} studio={studio} />);
      fireEvent.click(screen.getByRole('button', { name: /Draw 2 pages \+ 1 sheet/ }));
      expect(studio.act).toHaveBeenCalledWith(expect.objectContaining({ type: 'render_pages' }));
      fireEvent.click(screen.getByText(/^Page 2:/));
      expect(studio.openPage).toHaveBeenCalledWith('pg_2');
      fireEvent.click(screen.getByRole('button', { name: 'Open plan' }));
      expect(studio.setTab).toHaveBeenCalledWith('pages');
    });

    it('a cleared plan offers to plan again', () => {
      const studio = makeFakeStudio({ doc: makeSampleDoc({ pages: [], planStatus: 'none' }) });
      render(<PlanList card={card as Extract<Card, { type: 'plan' }>} studio={studio} />);
      fireEvent.click(screen.getByRole('button', { name: 'Plan the pages' }));
      expect(studio.act).toHaveBeenCalledWith({ type: 'plan_pages' });
    });
  });

  it('estimate helpers mirror the server targets', () => {
    const doc = makeSampleDoc();
    expect(pagesToDraw(doc).map((p) => p.id)).toEqual(['pg_2', 'pg_3']);
    expect(sheetsNeededFor(doc, pagesToDraw(doc)).map((c) => c.id)).toEqual(['c_arjun']);
    expect(estimatePlanRender(doc, true).estimate.usd).toBeLessThan(estimatePlanRender(doc, false).estimate.usd);
    expect(estimatePlanRender(doc, false).estimate.usd).toBe(quoteRenderPages(doc, { byok: false, tier: 'standard' }).usd);
  });
});

describe('GateCard', () => {
  const gate: Gate = {
    id: 'gate_1',
    action: { type: 'render_cover' },
    title: 'Draw the cover?',
    summary: 'The cover on Nano Banana 2.1 (2K) · ≈ $0.09.',
    estimateUsd: 0.09,
    imageCount: 1,
    model: 'Nano Banana 2.1',
    createdAt: 1,
    status: 'open',
    reason: 'policy'
  };
  const card: Card = { type: 'gate', id: 'card_g', gateId: 'gate_1' };

  it('approves or declines the open gate', () => {
    const studio = renderCard(card, makeSampleDoc({ gate }));
    expect(screen.getByText('Draw the cover?')).toBeInTheDocument();
    expect(screen.getByText('1 image · Nano Banana 2.1')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Approve · $0.09' }));
    expect(studio.act).toHaveBeenCalledWith({ type: 'approve_gate', gateId: 'gate_1' });
  });

  it('decline sends decline_gate', () => {
    const studio = renderCard(card, makeSampleDoc({ gate }));
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
    expect(studio.act).toHaveBeenCalledWith({ type: 'decline_gate', gateId: 'gate_1' });
  });

  it('a 60-character model id never collapses the summary (visualqa P0-1)', () => {
    const longId = 'openrouter/some-vendor/an-extremely-long-experimental-image-v9';
    expect(longId.length).toBeGreaterThanOrEqual(60);
    renderCard(card, makeSampleDoc({ gate: { ...gate, model: longId } }));
    const model = screen.getByTestId('gate-model');
    expect(model.className).toMatch(/\btruncate\b/);
    expect(model.className).toMatch(/max-w-\[16rem\]/);
    expect(model).toHaveAttribute('title', longId);
    const summary = screen.getByText(gate.summary);
    expect(summary.className).toMatch(/\bflex-1\b/);
    expect(summary.className).toMatch(/basis-\[14rem\]/);
    expect(summary.className).toMatch(/overflow-wrap:anywhere/);
    expect(summary.parentElement!.className).toMatch(/\bflex-wrap\b/);
    // the price column may shrink (min-w-0) instead of eating the summary
    expect(model.parentElement!.className).toMatch(/\bmin-w-0\b/);
  });

  it('shows the registry nickname for a known route id, the raw id otherwise', () => {
    expect(gateModelName('google/gemini-nano-banana-2.1')).toBe('Nano Banana 2.1');
    expect(gateModelName('mystery/model')).toBe('mystery/model');
    expect(gateModelName(undefined)).toBe('');
  });

  it('says why it stopped, for every reason', () => {
    const doc = makeSampleDoc({ settings: { ...makeSampleDoc().settings, budgetUsd: 2 } });
    const copy = (reason: Gate['reason']) => gateReasonCopy({ ...gate, reason }, doc);
    expect(copy('budget')).toMatch(/past your \$2\.00 budget/);
    expect(copy('first_render')).toMatch(/Nothing is spent until you approve/);
    expect(copy('plan_review')).toMatch(/page plan is new/);
    expect(copy('redraw')).toMatch(/stay in history/);
    expect(copy('no_intent')).toMatch(/didn’t ask me to draw/);
    // the threshold is only blamed when this spend is really over it (a $0.09 gate is a re-quote)
    expect(copy('policy')).toBe('Here’s the up-to-date price first — nothing is spent until you approve.');
    expect(gateReasonCopy({ ...gate, reason: 'policy', estimateUsd: 0.84 }, doc)).toMatch(/check before spends over \$0\.50/);
    expect(gateReasonCopy(gate, makeSampleDoc({ settings: { ...doc.settings, confirm: 'always' } }))).toBe('You asked me to check before every spend.');
    renderCard(card, makeSampleDoc({ gate: { ...gate, reason: 'first_render' } }));
    expect(screen.getByText(/Your first pages cost real money/)).toBeInTheDocument();
  });

  it('embeds the page breakdown for page renders, above the approve row', () => {
    const pagesGate: Gate = { ...gate, action: { type: 'render_pages', pageIds: ['pg_2'] }, reason: 'first_render' };
    expect(gateBreakdownCard(pagesGate, 'card_g')).toEqual({ type: 'breakdown', id: 'card_g__breakdown', gateId: 'gate_1', pageIds: ['pg_2'], view: 'plan' });
    expect(gateBreakdownCard(gate, 'card_g')).toBeNull();
    renderCard(card, makeSampleDoc({ gate: pagesGate }));
    const approval = screen.getByRole('region', { name: 'Spend approval' });
    const breakdown = within(approval).getByRole('region', { name: 'Page breakdown' });
    const approve = within(approval).getByRole('button', { name: /^Approve ·/ });
    expect(breakdown.compareDocumentPosition(approve) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // the gate owns approval: the embedded breakdown offers no spend buttons of its own
    expect(within(breakdown).queryByRole('button', { name: /Approve & (draw|render) all/ })).toBeNull();
  });

  it('never shows the breakdown twice: a v5 message carries it as a sibling card above the gate', () => {
    const pagesGate: Gate = { ...gate, action: { type: 'render_pages', pageIds: ['pg_2'] }, reason: 'first_render' };
    const sibling: Card = { type: 'breakdown', id: 'card_b', pageIds: ['pg_2'], view: 'cost', gateId: 'gate_1' };
    const doc = makeSampleDoc({
      gate: pagesGate,
      conversation: [{ id: 'm1', role: 'assistant', text: 'Here is what I would draw.', at: 1, cards: [sibling, card] }]
    });
    expect(messageHasGateBreakdown(doc.conversation[0], 'gate_1')).toBe(true);
    expect(messageHasGateBreakdown(doc.conversation[0], 'gate_9')).toBe(false);
    expect(messageHasGateBreakdown(undefined, 'gate_1')).toBe(false);
    renderCard(card, doc);
    const approval = screen.getByRole('region', { name: 'Spend approval' });
    expect(within(approval).queryByRole('region', { name: 'Page breakdown' })).toBeNull();
    expect(within(approval).getByRole('button', { name: /^Approve ·/ })).toBeInTheDocument();
  });

  it('a gate with no images (e.g. a translation) does not say "0 images"', () => {
    renderCard(card, makeSampleDoc({ gate: { ...gate, imageCount: 0, model: 'Gemini Flash', action: { type: 'translate', languages: ['te'] } as Gate['action'] } }));
    expect(screen.getByTestId('gate-model')).toHaveTextContent(/^Gemini Flash$/);
  });

  it('shows the resolved and replaced states and flags budget gates', () => {
    const { unmount } = render(<CardRenderer card={card} studio={makeFakeStudio({ doc: makeSampleDoc({ gate: { ...gate, status: 'approved' } }) })} />);
    expect(screen.getByText(/Approved — drawing now/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Approve/ })).not.toBeInTheDocument();
    unmount();
    const r2 = render(<CardRenderer card={card} studio={makeFakeStudio({ doc: makeSampleDoc({ gate: { ...gate, status: 'declined' } }) })} />);
    expect(screen.getByText(/Not now — nothing was spent\./)).toBeInTheDocument();
    r2.unmount();
    // Approved after its target vanished (DIR-6): the card names why it closed, not a "Not now" the user never said.
    const closed = render(<CardRenderer card={card} studio={makeFakeStudio({ doc: makeSampleDoc({ gate: { ...gate, status: 'declined', closedReason: 'nothing_to_draw' } }) })} />);
    expect(screen.getByText(/Nothing left to draw — nothing was spent\./)).toBeInTheDocument();
    expect(screen.queryByText(/Not now/)).not.toBeInTheDocument();
    closed.unmount();
    const r3 = render(<CardRenderer card={card} studio={makeFakeStudio({ doc: makeSampleDoc({ gate: { ...gate, id: 'gate_2' } }) })} />);
    expect(screen.getByText(/replaced by a newer one/)).toBeInTheDocument();
    r3.unmount();
    render(<CardRenderer card={card} studio={makeFakeStudio({ doc: makeSampleDoc({ gate: { ...gate, reason: 'budget' } }) })} />);
    expect(screen.getByText('Over budget')).toBeInTheDocument();
  });
});

describe('RendersCard', () => {
  const card: Card = {
    type: 'renders',
    id: 'card_r',
    label: 'Drawing 3 pages',
    targets: [
      { kind: 'page', id: 'pg_1' },
      { kind: 'page', id: 'pg_2' },
      { kind: 'page', id: 'pg_3' },
      { kind: 'page', id: 'deleted' }
    ]
  };

  it('shows each target honestly and opens ready pages', () => {
    const studio = renderCard(card);
    expect(screen.getByText('1 ready · 1 failed')).toBeInTheDocument();
    expect(screen.getByText('Not drawn yet')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Open Page 1' }));
    expect(studio.openPage).toHaveBeenCalledWith('pg_1');
  });

  it('retries a failed page with force', () => {
    const studio = renderCard(card);
    fireEvent.click(screen.getByRole('button', { name: 'Retry Page 3' }));
    const q = quoteRenderPages(makeSampleDoc(), { pageIds: ['pg_3'], force: true, byok: false, tier: 'standard' });
    expect(studio.act).toHaveBeenCalledWith({ type: 'render_pages', pageIds: ['pg_3'], force: true, quotedUsd: q.usd });
  });

  it('shows progress while drawing', () => {
    const doc = makeSampleDoc();
    doc.pages[1] = { ...doc.pages[1], render: { ...doc.pages[1].render, status: 'rendering' } };
    renderCard(card, doc);
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '1');
    // A progressbar always has a name (renders-progressbar-name).
    expect(screen.getByRole('progressbar')).toHaveAccessibleName(/ready/);
    expect(screen.getByText('Drawing…')).toBeInTheDocument();
  });

  it('failed tiles say when and why; the summary line is calm', () => {
    const doc = makeSampleDoc();
    const at = new Date();
    at.setHours(16, 52, 0, 0);
    doc.pages[2] = { ...doc.pages[2], render: { ...doc.pages[2].render, status: 'failed', error: 'Provider said 429: rate limited', updatedAt: at.getTime() } };
    renderCard(card, doc);
    expect(screen.getByText('failed 16:52 · rate limited')).toBeInTheDocument();
    expect(screen.getByText(/1 image didn’t finish \(16:52 · rate limited\)/)).toBeInTheDocument();
    // the frame never paints a red error wall
    const frame = document.querySelector('[data-failed]')!;
    const visible = Array.from(frame.childNodes)
      .filter((n) => !(n instanceof Element && n.classList.contains('sr-only')))
      .map((n) => n.textContent)
      .join(' ');
    expect(visible).not.toMatch(/Provider said/);
    // …but screen readers get the whole story
    expect(frame.querySelector('.sr-only')!.textContent).toMatch(/Page 3: failed 16:52 · rate limited\. Provider said 429/);
    const details = screen.getByRole('button', { name: 'Details' });
    fireEvent.click(details);
    expect(details).toHaveAttribute('aria-expanded', 'true');
    expect(document.getElementById(details.getAttribute('aria-controls')!)).toHaveTextContent(/Provider said 429: rate limited\s*Failed at 16:52\./);
  });

  it('uses errorDetail when the server sets it: exact time, provider facts under Details', () => {
    const now = new Date(2026, 9, 22, 18, 0).getTime();
    const at = new Date(2026, 9, 22, 16, 52).getTime();
    render(
      <RenderThumb
        label="Retro"
        aspect="4 / 5"
        now={now}
        onRetry={() => undefined}
        render={
          {
            status: 'failed',
            history: [],
            error: 'The image service is busy right now.',
            updatedAt: at + 60_000,
            attempts: 2,
            errorDetail: { code: '429', provider: 'OpenRouter', at, text: 'upstream Google throttled' }
          } as unknown as Parameters<typeof RenderThumb>[0]['render']
        }
      />
    );
    // classified from the provider code even though the user-facing sentence says "busy"
    expect(screen.getByText('failed 16:52 · rate limited')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Details' }));
    const details = document.getElementById(screen.getByRole('button', { name: 'Hide' }).getAttribute('aria-controls')!)!;
    expect(details).toHaveTextContent('The image service is busy right now. — upstream Google throttled — 429');
    expect(details).toHaveTextContent('OpenRouter · 429');
    expect(details).toHaveTextContent('Failed at 16:52 after 2 tries.');
  });

  it('a string errorDetail (older amendment shape) still shows under Details', () => {
    render(
      <RenderThumb
        label="Page 3"
        aspect="2 / 3"
        render={{ status: 'failed', history: [], errorDetail: 'OpenRouter · 503 · upstream Google · 17:42 UTC' } as unknown as Parameters<typeof RenderThumb>[0]['render']}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Details' }));
    expect(screen.getByText('OpenRouter · 503 · upstream Google · 17:42 UTC')).toBeInTheDocument();
  });

  it('an out-of-date page with a quality warning shows both badges in one row (no overlap)', () => {
    render(
      <RenderThumb
        label="Page 1"
        aspect="2 / 3"
        stale
        url="https://cdn.test/p1.webp"
        render={{ status: 'ready', history: [], error: 'Lettering may overlap a face', asset: { path: 'p1.webp', source: 'generated', at: 1 } }}
      />
    );
    const stale = screen.getByText('Out of date');
    const warn = screen.getByRole('img', { name: 'Lettering may overlap a face' });
    expect(stale.parentElement).toBe(warn.parentElement);
    expect(stale.parentElement!.className).toMatch(/\bflex-wrap\b/);
  });

  it('retries all failed images at once — pages AND style options, with the quote', async () => {
    const doc = makeSampleDoc();
    doc.pages[1] = { ...doc.pages[1], render: { ...doc.pages[1].render, status: 'failed', error: 'Timed out' } };
    const mixed: Card = { ...card, targets: [...(card as Extract<Card, { type: 'renders' }>).targets, { kind: 'style_option', id: 'opt_c' }] };
    const studio = renderCard(mixed, doc);
    const expected = retryAllFailed(
      doc,
      [
        { target: { kind: 'page', id: 'pg_2' } },
        { target: { kind: 'page', id: 'pg_3' } },
        { target: { kind: 'style_option', id: 'opt_c' } }
      ],
      false
    );
    fireEvent.click(screen.getByRole('button', { name: /Retry 3 failed images/ }));
    await waitFor(() => expect(studio.act).toHaveBeenCalledTimes(2));
    expect(studio.act.mock.calls.map((c) => c[0])).toEqual(expected.actions);
    expect(expected.actions[0]).toMatchObject({ type: 'render_pages', pageIds: ['pg_2', 'pg_3'], force: true });
    expect(expected.actions[1]).toMatchObject({ type: 'render_style_options', directions: [{ name: 'Retro', spec: 'Halftone' }] });
    expect(screen.getByRole('button', { name: /Retry 3 failed images/ })).toHaveTextContent(formatUsd(expected.usd));
  });

  it('retry-all never draws (or bills) a sheet twice: the page retry already draws the missing sheets', () => {
    const doc = makeSampleDoc();
    // Arjun's sheet failed, and page 2 (which shows Arjun) failed with it.
    doc.cast = doc.cast.map((c) => (c.id === 'c_arjun' ? { ...c, sheet: { status: 'failed', history: [], error: '429' } } : c));
    doc.pages[1] = { ...doc.pages[1], render: { ...doc.pages[1].render, status: 'failed', error: '429' } };
    const r = retryAllFailed(doc, [{ target: { kind: 'sheet', id: 'c_arjun' } }, { target: { kind: 'page', id: 'pg_2' } }], false);
    const pages = quoteRenderPages(doc, { pageIds: ['pg_2'], force: true, byok: false, tier: 'standard' });
    expect(pages.sheetIds).toEqual(['c_arjun']);
    expect(r.actions).toEqual([{ type: 'render_pages', pageIds: ['pg_2'], force: true, quotedUsd: pages.usd }]);
    expect(r.usd).toBe(Math.round(pages.usd * 10000) / 10000);
    expect(r.count).toBe(2);
    // a failed sheet nobody on those pages needs is still retried on its own
    const other = retryAllFailed(doc, [{ target: { kind: 'sheet', id: 'c_arjun' } }, { target: { kind: 'page', id: 'pg_3' } }], false);
    expect(other.actions.map((a) => a.type)).toEqual(['render_pages', 'render_sheets']);
  });

  it('retryAllFailed covers sheets and the cover too; failureSummary names the main reason', () => {
    const doc = makeSampleDoc();
    const r = retryAllFailed(doc, [{ target: { kind: 'sheet', id: 'c_arjun' } }, { target: { kind: 'cover' } }], true);
    expect(r.actions.map((a) => a.type)).toEqual(['render_sheets', 'render_cover']);
    expect(r.usd).toBeGreaterThan(0);
    expect(
      failureSummary([
        { target: { kind: 'cover' }, render: { status: 'failed', history: [], error: '429' } },
        { target: { kind: 'sheet', id: 'x' }, render: { status: 'failed', history: [], error: 'Too many requests' } }
      ])
    ).toBe('2 images didn’t finish (rate limited). Retry when you’re ready — only these are redrawn.');
  });
});

describe('RecapCard', () => {
  const card: Card = { type: 'recap', id: 'card_rc' };
  const lakeDoc = () =>
    makeSampleDoc({
      brief: { title: 'The Baby at the Lake', logline: 'A baby meets three ducklings by a lake. They play all day.', audience: 'kids 2–6', setting: 'by a quiet lake', notes: [] },
      format: { ...makeSampleDoc().format, kind: 'storybook', pageCount: 1, pageAspect: '4:5' },
      cast: [
        { id: 'c_baby', name: 'The Baby', tier: 'lead', look: { summary: 'A toddler' }, refs: [], sheet: emptyRender() },
        ducklings()
      ],
      pages: []
    });

  it('is a built-in card type', () => {
    expect(CARD_TYPES).toContain('recap');
  });

  it('shows what the studio understood, live: story, format, audience, setting, look and cast', () => {
    renderCard(card, lakeDoc());
    const recap = screen.getByRole('region', { name: 'What I understood' });
    expect(within(recap).getByText('“The Baby at the Lake” — A baby meets three ducklings by a lake.')).toBeInTheDocument();
    expect(within(recap).getByText('Storybook · 1 page · 4:5')).toBeInTheDocument();
    expect(within(recap).getByText('Kids 2–6')).toBeInTheDocument();
    expect(within(recap).getByText('By a quiet lake')).toBeInTheDocument();
    expect(within(recap).getByText('Noir ink')).toBeInTheDocument();
    expect(within(recap).getByText('×3')).toBeInTheDocument();
    expect(within(recap).getByText('companion')).toBeInTheDocument();
    expect(within(recap).getByText(/nothing is drawn until you say so/)).toBeInTheDocument();
  });

  it('"Change" opens the format panel right in the card, and the cast/story tabs', () => {
    const studio = renderCard(card, lakeDoc());
    const change = screen.getByRole('button', { name: 'Change the format' });
    expect(change).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(change);
    expect(change).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Page shape' })).getByRole('radio', { name: /1:1/ }));
    expect(studio.patch).toHaveBeenCalledWith([{ op: 'format', patch: { pageAspect: '1:1' } }]);
    fireEvent.click(screen.getByRole('button', { name: 'Change the cast' }));
    expect(studio.setTab).toHaveBeenCalledWith('cast');
    fireEvent.click(screen.getByRole('button', { name: 'Change the story' }));
    expect(studio.setTab).toHaveBeenCalledWith('story');
  });

  it('rows follow the card’s width, not the window’s: Change wraps under a row that is too narrow, cast chips never overflow it (recap-change-chips)', () => {
    renderCard(card, lakeDoc());
    const recap = screen.getByRole('region', { name: 'What I understood' });
    // No viewport breakpoints in the row layout: an iPad's narrow split pane at Text size XL is ≥ sm
    // wide as a window while the card is 170 px — the value got 0 px and its avatars ran under Change.
    expect(recap.querySelector('[class*="sm:"]')).toBeNull();
    for (const change of within(recap).getAllByRole('button', { name: /^Change the / })) {
      const row = change.parentElement!;
      expect(row.className).toContain('flex-wrap');
      expect(change.className).toContain('shrink-0');
      // The main block gives way first (it has a basis, Change does not grow over it).
      expect(row.firstElementChild!.className).toMatch(/flex-\[1_1_/);
    }
    const chip = within(recap).getByText('×3').parentElement!;
    expect(chip.className).toContain('max-w-[min(13rem,100%)]');
  });

  it('an empty brief asks for the story instead of showing blanks', () => {
    renderCard(card, makeSampleDoc({ brief: { title: 'Untitled comic', notes: [] }, cast: [], pages: [] }));
    expect(screen.getByText(/Nothing yet — tell me what your comic is about/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Describe your story/ })).toBeInTheDocument();
  });

  it('recapRows marks undecided essentials as open prompts', () => {
    const doc = lakeDoc();
    doc.style = { ...doc.style, status: 'empty', name: '' };
    const rows = recapRows(doc);
    expect(rows.find((r) => r.key === 'style')).toMatchObject({ open: true });
    expect(rows.find((r) => r.key === 'format')?.value).toBe('Storybook · 1 page · 4:5');
  });
});

describe('NoticeCard and CardRenderer', () => {
  it('errors are announced as alerts; info as status', () => {
    renderCard({ type: 'notice', id: 'n1', tone: 'error', text: 'Connect a Gemini key.' });
    expect(screen.getByRole('alert')).toHaveTextContent('Connect a Gemini key.');
  });

  it('info notices are polite status lines', () => {
    renderCard({ type: 'notice', id: 'n2', tone: 'info', text: 'Saved.' });
    expect(screen.getByRole('status')).toHaveTextContent('Saved.');
  });

  it('long URLs and tokens wrap anywhere (visualqa P1-3)', () => {
    const url = `https://example.com/${'x'.repeat(200)}`;
    renderCard({ type: 'notice', id: 'n3', tone: 'warn', text: url });
    expect(screen.getByText(url).className).toMatch(/overflow-wrap:anywhere/);
  });

  it('notice fix chips render through the renderer: free first; a paid chip sends its exact action with quotedUsd (A5)', async () => {
    const card: Card = {
      type: 'notice',
      id: 'n_fix',
      tone: 'info',
      text: 'Page 2 is held back.',
      fixes: [
        { label: 'Draw page 2 anyway', free: false, action: { type: 'render_pages', pageIds: ['pg_2'], quotedUsd: 0.0845 } },
        { label: 'Make it a caption', free: true, action: { type: 'patch', ops: [{ op: 'line', pageId: 'pg_2', panelId: 'pg_2_p2', id: 'pg_2_l1', patch: { kind: 'caption' } }] } }
      ]
    };
    const studio = renderCard(card);
    const chips = within(screen.getByRole('group', { name: 'Fixes' })).getAllByRole('button');
    expect(chips.map((c) => c.getAttribute('data-fix'))).toEqual(['free', 'paid']);
    expect(chips[0]).toHaveAccessibleName('Make it a caption, Free');
    expect(chips[1]).toHaveAccessibleName(`Draw page 2 anyway, ≈${formatUsd(0.0845)}`);
    fireEvent.click(chips[1]);
    await waitFor(() => expect(studio.act).toHaveBeenCalledWith({ type: 'render_pages', pageIds: ['pg_2'], quotedUsd: 0.0845 }));
  });

  it('ignores unknown and malformed card types', () => {
    const { container } = render(<CardRenderer card={{ type: 'mystery', id: 'x' } as unknown as Card} studio={makeFakeStudio()} />);
    expect(container).toBeEmptyDOMElement();
    const r2 = render(<CardRenderer card={null as unknown as Card} studio={makeFakeStudio()} />);
    expect(r2.container).toBeEmptyDOMElement();
  });
});
