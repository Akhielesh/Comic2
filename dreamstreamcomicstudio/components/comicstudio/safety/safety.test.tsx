// Client safety UI (safety.md §10 tests): the veil never renders a blocked <img>, the picker
// respects the ceiling, the report dialog sends one honest report, the admin queue resolves.
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { AssetRef, ComicDoc } from '../../../shared/comic/doc';
import { createEmptyDoc } from '../../../shared/comic/doc';
import { RatingBadge } from './RatingBadge';
import { RatingPicker, ratingPickerState } from './RatingPicker';
import { SafetyVeil } from './SafetyVeil';
import { ReportDialog } from './ReportDialog';
import { SafetyCasesSection, type ComicCase } from './SafetyCasesSection';
import { feature } from './index';

const asset = (safety?: AssetRef['safety']): AssetRef => ({ path: 'u/x/p/y/img/a.webp', source: 'generated', at: 1, ...(safety ? { safety } : {}) });
const pic = <img src="https://cdn.test/a.webp" alt="page art" />;

describe('SafetyVeil', () => {
  it('blocked: a neutral tile with Redraw safer / Check again — and never an <img>', () => {
    const redraw = vi.fn();
    const check = vi.fn();
    const { container } = render(
      <SafetyVeil asset={asset({ assessed: 'X', quarantined: true, at: 1 })} rating="PG-13" onRedrawSafer={redraw} onCheckAgain={check}>
        {pic}
      </SafetyVeil>
    );
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByRole('img', { name: 'Image withheld' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Redraw safer' }));
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    expect(redraw).toHaveBeenCalledTimes(1);
    expect(check).toHaveBeenCalledTimes(1);
  });

  it('blocked without handlers still shows no image and no dead buttons', () => {
    const { container } = render(<SafetyVeil asset={asset({ assessed: 'X', at: 1 })} rating="G">{pic}</SafetyVeil>);
    expect(container.querySelector('img')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('over the rating: blurred behind a note until "Show"; redraw and change rating are offered', () => {
    const change = vi.fn();
    const { container } = render(
      <SafetyVeil asset={asset({ assessed: 'PG-13', at: 1 })} rating="PG" onChangeRating={change} onRedrawSafer={vi.fn()}>
        {pic}
      </SafetyVeil>
    );
    expect(screen.getByText('Rated PG-13 — your comic is PG')).toBeInTheDocument();
    expect(container.querySelector('[aria-hidden="true"] img')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Change rating' }));
    expect(change).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Show' }));
    expect(screen.queryByText('Rated PG-13 — your comic is PG')).toBeNull();
    expect(screen.getByAltText('page art')).toBeInTheDocument();
  });

  it('over the rating: controls inside the blurred art are inert (no keyboard focus) until "Show"', () => {
    const onBalloon = vi.fn();
    const { container } = render(
      <SafetyVeil asset={asset({ assessed: 'PG-13', at: 1 })} rating="PG" onRedrawSafer={vi.fn()}>
        <div>
          {pic}
          <button type="button" onClick={onBalloon}>
            Balloon 1
          </button>
        </div>
      </SafetyVeil>
    );
    const blurred = container.querySelector('[data-safety-blurred]') as HTMLElement & { inert?: boolean };
    expect(blurred).toHaveAttribute('inert');
    expect(blurred).toHaveAttribute('aria-hidden', 'true');
    // Not in the accessibility tree, and the only reachable buttons are the veil's own.
    expect(screen.queryByRole('button', { name: 'Balloon 1' })).toBeNull();
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['Show', 'Redraw safer']);
    // Shown: the art and its controls are live again.
    fireEvent.click(screen.getByRole('button', { name: 'Show' }));
    expect(container.querySelector('[inert]')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Balloon 1' }));
    expect(onBalloon).toHaveBeenCalledTimes(1);
  });

  it('"Redraw safer" carries its price when the caller knows it (a paid redraw is never a surprise)', () => {
    const redraw = vi.fn();
    const { rerender } = render(
      <SafetyVeil asset={asset({ assessed: 'X', at: 1 })} rating="PG" onRedrawSafer={redraw} redrawPrice="≈2% of your usage">
        {pic}
      </SafetyVeil>
    );
    fireEvent.click(screen.getByRole('button', { name: 'Redraw safer · ≈2% of your usage' }));
    expect(redraw).toHaveBeenCalledTimes(1);
    rerender(
      <SafetyVeil asset={asset({ assessed: 'PG-13', at: 1 })} rating="PG" onRedrawSafer={redraw} redrawPrice="  ">
        {pic}
      </SafetyVeil>
    );
    expect(screen.getByRole('button', { name: 'Redraw safer' })).toBeInTheDocument();
  });

  it('pending shows "Checking…"; pass and unchecked pass straight through', () => {
    const { rerender } = render(<SafetyVeil asset={asset({ pending: true, at: 1 })} rating="PG">{pic}</SafetyVeil>);
    expect(screen.getByRole('status')).toHaveTextContent('Checking…');
    rerender(<SafetyVeil asset={asset({ assessed: 'G', at: 1 })} rating="PG">{pic}</SafetyVeil>);
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.getByAltText('page art')).toBeInTheDocument();
    rerender(<SafetyVeil asset={asset()} rating="PG">{pic}</SafetyVeil>);
    expect(screen.getByAltText('page art')).toBeInTheDocument();
  });
});

describe('RatingPicker', () => {
  const docWith = (audience: string, rating?: 'G' | 'PG' | 'PG-13'): ComicDoc => {
    const d = createEmptyDoc('d', 'T', 1);
    d.brief.audience = audience;
    if (rating) d.settings.rating = rating;
    return d;
  };

  it('disables ratings above the ceiling and says why', () => {
    const state = ratingPickerState(docWith('kids 8-10', 'PG-13'));
    expect(state).toMatchObject({ value: 'PG', ceiling: 'PG', ceilingReason: 'Kids audience → up to PG', chosen: 'PG-13' });
    const onChange = vi.fn();
    render(<RatingPicker {...state} onChange={onChange} />);
    const radios = screen.getAllByRole('radio');
    expect(radios.map((r) => r.querySelector('span')?.textContent)).toEqual(['G', 'PG', 'PG-13']);
    expect(screen.getByRole('radio', { name: /^PG-13:/ })).toBeDisabled();
    expect(screen.getByRole('radio', { name: /^PG: All/ })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByText(/Kids audience → up to PG \(you chose PG-13\)\./)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: /^PG-13:/ }));
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('radio', { name: /^G: / }));
    expect(onChange).toHaveBeenCalledWith('G');
  });

  it('arrow keys move between the allowed ratings only (roving focus, one tab stop)', () => {
    const onChange = vi.fn();
    render(<RatingPicker value="G" ceiling="PG" ceilingReason="Kids audience → up to PG" onChange={onChange} />);
    const radios = screen.getAllByRole('radio');
    expect(radios.map((r) => r.getAttribute('tabindex'))).toEqual(['0', '-1', '-1']);
    fireEvent.keyDown(radios[0], { key: 'ArrowRight' });
    expect(onChange).toHaveBeenLastCalledWith('PG');
    expect(document.activeElement).toBe(radios[1]);
    onChange.mockClear();
    fireEvent.keyDown(radios[0], { key: 'End' });
    expect(onChange).toHaveBeenLastCalledWith('PG');
    expect(onChange).not.toHaveBeenCalledWith('PG-13');
  });

  it('little kids cap at G; an under-13 account caps at PG; adults can pick PG-13', () => {
    expect(ratingPickerState(docWith('kids 2–6'))).toMatchObject({ value: 'G', ceiling: 'G', ceilingReason: 'Little-kids audience → up to G' });
    expect(ratingPickerState(docWith('teens and adults'), { ratingCeiling: 'PG' })).toMatchObject({ ceiling: 'PG', ceilingReason: 'Your account → up to PG' });
    expect(ratingPickerState(docWith('teens and adults'))).toMatchObject({ value: 'PG-13', ceiling: 'PG-13' });
  });
});

describe('RatingBadge', () => {
  it('renders the rating pill with the reason as its description', () => {
    render(<RatingBadge rating="PG" reason="Kids audience → up to PG" />);
    const badge = screen.getByLabelText('Rated PG');
    expect(badge).toHaveTextContent('PG');
    expect(badge).toHaveAttribute('title', expect.stringContaining('Kids audience → up to PG'));
  });
});

describe('ReportDialog', () => {
  it('needs a reason, sends the page and note once, then thanks the reader', async () => {
    const submit = vi.fn(async () => undefined);
    render(<ReportDialog slug="AbCdEfGhIjKlMnOpQ" open onClose={vi.fn()} page={4} submit={submit} />);
    const send = screen.getByRole('button', { name: 'Send report' });
    expect(send).toBeDisabled();
    fireEvent.click(screen.getByLabelText('Graphic violence or gore'));
    fireEvent.change(screen.getByLabelText(/Anything else/), { target: { value: 'x'.repeat(400) } });
    expect(screen.getByText('300/300')).toBeInTheDocument();
    fireEvent.click(send);
    await waitFor(() => expect(screen.getByText("Thanks — we'll take a look.")).toBeInTheDocument());
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledWith('AbCdEfGhIjKlMnOpQ', { reason: 'violent', pageN: 4, note: 'x'.repeat(300) });
  });

  it('can leave the page out and shows an honest error when sending fails', async () => {
    const submit = vi.fn(async () => {
      throw new Error('offline');
    });
    render(<ReportDialog slug="AbCdEfGhIjKlMnOpQ" open onClose={vi.fn()} page={2} submit={submit} />);
    fireEvent.click(screen.getByLabelText('Something else'));
    fireEvent.click(screen.getByLabelText('About page 2'));
    fireEvent.click(screen.getByRole('button', { name: 'Send report' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent("Couldn't send the report"));
    expect(submit).toHaveBeenCalledWith('AbCdEfGhIjKlMnOpQ', { reason: 'other' });
  });
});

describe('SafetyCasesSection (admin)', () => {
  const kase: ComicCase = {
    id: 'c1',
    kind: 'report',
    status: 'open',
    projectId: 'p1',
    projectName: 'Spice Run',
    reason: 'violent',
    note: '<b>page 3</b>',
    reporter: 'anonymous',
    target: { kind: 'page', page: 3, label: 'Page 3', hasAsset: true, check: { assessed: 'X', categories: ['graphic_gore'] } },
    createdAt: Date.UTC(2026, 9, 22)
  };

  it('lists cases, renders notes as text, and is registered as an admin section', async () => {
    const load = vi.fn(async () => [kase]);
    render(<SafetyCasesSection load={load} />);
    const card = await screen.findByText('Graphic violence or gore');
    const item = card.closest('li')!;
    expect(within(item).getByText('“<b>page 3</b>”')).toBeInTheDocument();
    expect(within(item).getByText(/an anonymous reader · check: X \(graphic_gore\)/)).toBeInTheDocument();
    expect(item.querySelector('b')).toBeNull();
    // A decision other than dismiss needs a reason.
    fireEvent.click(within(item).getByRole('button', { name: 'Withhold' }));
    expect(within(item).getByRole('alert')).toHaveTextContent('Add a short reason first.');
    expect(feature.adminSections?.map((s) => s.id)).toEqual(['comic-safety']);
  });

  it('a failed load says so — it never claims the queue is clear', async () => {
    render(
      <SafetyCasesSection
        load={async () => {
          throw new Error('offline');
        }}
      />
    );
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't load the safety queue");
    expect(screen.queryByText('Nothing waiting — the queue is clear.')).toBeNull();
  });

  it('an empty queue says so', async () => {
    render(<SafetyCasesSection load={async () => []} />);
    expect(await screen.findByText('Nothing waiting — the queue is clear.')).toBeInTheDocument();
  });
});
