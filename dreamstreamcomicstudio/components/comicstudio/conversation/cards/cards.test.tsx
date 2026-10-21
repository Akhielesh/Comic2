import React from 'react';
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { Card, ComicDoc, Gate } from '../../../../shared/comic/doc';
import { estimateJobs, formatUsd } from '../../../../shared/comic/models';
import { CardRenderer } from './CardRenderer';
import { joinChoices } from './OptionsCard';
import { estimatePlanRender, pagesToDraw, sheetsNeededFor } from './PlanCard';
import { lockedOptionId } from './StyleChoiceCard';
import { makeFakeStudio, makeSampleDoc } from '../testing/fixtures';

const renderCard = (card: Card, doc: ComicDoc = makeSampleDoc(), extra: Parameters<typeof makeFakeStudio>[0] = {}) => {
  const studio = makeFakeStudio({ doc, ...extra });
  render(<CardRenderer card={card} studio={studio} />);
  return studio;
};

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
    expect(studio.send).toHaveBeenCalledWith('Make it moody noir');
    expect(screen.getByRole('button', { name: /Playful/ })).toBeDisabled();
  });

  it('falls back to the label when there is no reply', () => {
    const studio = renderCard(card);
    fireEvent.click(screen.getByRole('button', { name: /Playful/ }));
    expect(studio.send).toHaveBeenCalledWith('Playful');
  });

  it('multi-select collects picks until Done', () => {
    const studio = renderCard({ ...card, multi: true });
    fireEvent.click(screen.getByRole('button', { name: /Playful/ }));
    fireEvent.click(screen.getByRole('button', { name: /Epic/ }));
    expect(studio.send).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Done (2)' }));
    expect(studio.send).toHaveBeenCalledWith('Playful and Epic');
  });

  it('accepts a custom answer', () => {
    const studio = renderCard({ ...card, allowCustom: true });
    fireEvent.change(screen.getByLabelText('Your own answer'), { target: { value: 'Bittersweet' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send answer' }));
    expect(studio.send).toHaveBeenCalledWith('Bittersweet');
    expect(screen.getByText(/You answered/)).toHaveTextContent('Bittersweet');
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
});

describe('StyleChoiceCard', () => {
  const card: Card = { type: 'style_choice', id: 'card_s' };

  it('shows each option with its live status; tapping a ready one picks it', () => {
    const studio = renderCard(card);
    expect(screen.getByText('Drawing 1 of 3…')).toBeInTheDocument();
    expect(screen.getByAltText('Inky noir')).toHaveAttribute('src', 'https://cdn.test/u/x/p/opt_a.webp');
    expect(screen.getByText('Drawing…')).toBeInTheDocument();
    expect(screen.getByText('The model refused this one.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Use the Inky noir style' }));
    expect(studio.act).toHaveBeenCalledWith({ type: 'pick_style', optionId: 'opt_a' });
  });

  it('a failed option retries the same direction', () => {
    const studio = renderCard(card);
    fireEvent.click(screen.getByRole('button', { name: /Retry/ }));
    expect(studio.act).toHaveBeenCalledWith({ type: 'render_style_options', directions: [{ name: 'Retro', spec: 'Halftone' }] });
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
    expect(studio.act).toHaveBeenCalledWith({ type: 'render_style_options' });
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
    expect(screen.getByText(/Lead · cat burglar · Sheet ready/)).toBeInTheDocument();
    expect(screen.getByText(/Support · detective · No sheet yet/)).toBeInTheDocument();
    expect(screen.getByText(/Extra · Described in text/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Maya/ }));
    expect(studio.setTab).toHaveBeenCalledWith('cast');
  });

  it('draws missing sheets for leads and supports only', () => {
    const studio = renderCard({ type: 'cast', id: 'card_c', characterIds: ['c_maya', 'c_arjun', 'c_vendor'] });
    fireEvent.click(screen.getByRole('button', { name: /Draw 1 sheet/ }));
    expect(studio.act).toHaveBeenCalledWith({ type: 'render_sheets', characterIds: ['c_arjun'], force: false });
  });
});

describe('PlanCard', () => {
  const card: Card = { type: 'plan', id: 'card_p' };

  it('lists pages and approves + renders with the honest estimate', async () => {
    const doc = makeSampleDoc();
    const studio = renderCard(card, doc);
    expect(screen.getByText('3 pages · 6 panels')).toBeInTheDocument();
    expect(screen.getByText('Drawn')).toBeInTheDocument();
    expect(screen.getByText('Failed')).toBeInTheDocument();

    const expected = estimateJobs(
      [
        { kind: 'page', count: 2, label: 'pages' },
        { kind: 'sheet', count: 1, label: 'character sheets' }
      ],
      'standard'
    );
    const button = screen.getByRole('button', { name: `Approve & render all (≈ ${formatUsd(expected.usd)})` });
    fireEvent.click(button);
    await waitFor(() => expect(studio.act).toHaveBeenCalledTimes(2));
    expect(studio.act.mock.calls.map((c) => c[0])).toEqual([{ type: 'approve_plan' }, { type: 'render_pages' }]);
  });

  it('an approved plan offers to draw what is left; a finished one offers to read', () => {
    const approved = makeSampleDoc({ planStatus: 'approved' });
    const studio = renderCard(card, approved);
    fireEvent.click(screen.getByRole('button', { name: /Draw 2 pages \+ 1 sheet/ }));
    expect(studio.act).toHaveBeenCalledWith({ type: 'render_pages' });
  });

  it('opens a page or the plan on the board', () => {
    const studio = renderCard(card);
    fireEvent.click(screen.getByText(/^Page 2:/));
    expect(studio.openPage).toHaveBeenCalledWith('pg_2');
    fireEvent.click(screen.getByRole('button', { name: 'Open plan' }));
    expect(studio.setTab).toHaveBeenCalledWith('pages');
  });

  it('estimate helpers mirror the server targets', () => {
    const doc = makeSampleDoc();
    expect(pagesToDraw(doc).map((p) => p.id)).toEqual(['pg_2', 'pg_3']);
    expect(sheetsNeededFor(doc, pagesToDraw(doc)).map((c) => c.id)).toEqual(['c_arjun']);
    expect(estimatePlanRender(doc, true).estimate.usd).toBeLessThan(estimatePlanRender(doc, false).estimate.usd);
  });

  it('a cleared plan offers to plan again', () => {
    const studio = renderCard(card, makeSampleDoc({ pages: [], planStatus: 'none' }));
    fireEvent.click(screen.getByRole('button', { name: 'Plan the pages' }));
    expect(studio.act).toHaveBeenCalledWith({ type: 'plan_pages' });
  });
});

describe('GateCard', () => {
  const gate: Gate = {
    id: 'gate_1',
    action: { type: 'render_pages' },
    title: 'Draw 6 pages?',
    summary: '6 pages on Nano Banana 2.1 (2K) · ≈ $0.42.',
    estimateUsd: 0.42,
    imageCount: 6,
    model: 'Nano Banana 2.1',
    createdAt: 1,
    status: 'open',
    reason: 'policy'
  };
  const card: Card = { type: 'gate', id: 'card_g', gateId: 'gate_1' };

  it('approves or declines the open gate', () => {
    const studio = renderCard(card, makeSampleDoc({ gate }));
    expect(screen.getByText('Draw 6 pages?')).toBeInTheDocument();
    expect(screen.getByText('6 images · Nano Banana 2.1')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Approve · $0.42' }));
    expect(studio.act).toHaveBeenCalledWith({ type: 'approve_gate', gateId: 'gate_1' });
  });

  it('decline sends decline_gate', () => {
    const studio = renderCard(card, makeSampleDoc({ gate }));
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
    expect(studio.act).toHaveBeenCalledWith({ type: 'decline_gate', gateId: 'gate_1' });
  });

  it('shows the resolved and replaced states and flags budget gates', () => {
    const { unmount } = render(<CardRenderer card={card} studio={makeFakeStudio({ doc: makeSampleDoc({ gate: { ...gate, status: 'approved' } }) })} />);
    expect(screen.getByText(/Approved — drawing now/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Approve/ })).not.toBeInTheDocument();
    unmount();
    const r2 = render(<CardRenderer card={card} studio={makeFakeStudio({ doc: makeSampleDoc({ gate: { ...gate, status: 'declined' } }) })} />);
    expect(screen.getByText(/nothing was spent/)).toBeInTheDocument();
    r2.unmount();
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
    fireEvent.click(within(screen.getByLabelText('Drawing 3 pages')).getByRole('button', { name: /Retry/ }));
    expect(studio.act).toHaveBeenCalledWith({ type: 'render_pages', pageIds: ['pg_3'], force: true });
  });

  it('shows progress while drawing', () => {
    const doc = makeSampleDoc();
    doc.pages[1] = { ...doc.pages[1], render: { ...doc.pages[1].render, status: 'rendering' } };
    renderCard(card, doc);
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '1');
    expect(screen.getByText('Drawing…')).toBeInTheDocument();
  });

  it('retries all failed pages at once', () => {
    const doc = makeSampleDoc();
    doc.pages[1] = { ...doc.pages[1], render: { ...doc.pages[1].render, status: 'failed', error: 'Timed out' } };
    const studio = renderCard(card, doc);
    fireEvent.click(screen.getByRole('button', { name: /Retry 2 failed pages/ }));
    expect(studio.act).toHaveBeenCalledWith({ type: 'render_pages', pageIds: ['pg_2', 'pg_3'], force: true });
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

  it('ignores unknown card types', () => {
    const { container } = render(<CardRenderer card={{ type: 'mystery', id: 'x' } as unknown as Card} studio={makeFakeStudio()} />);
    expect(container).toBeEmptyDOMElement();
  });
});
