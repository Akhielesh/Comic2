// The settled row (PROGRAM3 SETTLE-UI; settle.md §5.3, §5.8; lead decision D3, CHANGED): one line, a mark, at most
// one plain link; no button, input or toggle; aria-live off; and the focus hand-off when a focused card settles.

import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Card, Msg } from '../../../../shared/comic/doc';
import type { CardSettle, SettledSummary } from '../../../../shared/comic/settle';
import { TONE_TEXT } from '../../../chat/studioDesign';
import { makeFakeStudio, makeSampleDoc, resetUsageStatus, showDollarPrices } from '../testing/fixtures';
import { CardRenderer } from './CardRenderer';
import { SettledCard } from './SettledCard';

beforeEach(showDollarPrices);
afterEach(resetUsageStatus);

const FOCUSABLE = 'button, input, select, textarea, a[href], [tabindex]:not([tabindex="-1"])';
const card = (type: Card['type'], extra: Record<string, unknown> = {}): Card => ({ type, id: `c_${type}`, ...extra }) as Card;

describe('SettledCard', () => {
  it('done: a ✓ in the success ink; quiet: a dot and muted words; plain: the card’s own icon in ink', () => {
    const { container, rerender } = render(<SettledCard card={card('options')} summary={{ text: 'You picked Noir ink', tone: 'done' }} />);
    const mark = container.querySelector('[data-settle-mark="done"] svg')!;
    expect(mark.getAttribute('class')).toContain(TONE_TEXT.success);
    expect(screen.getByText('You picked Noir ink').className).toContain('text-[var(--ds-ink)]');

    rerender(<SettledCard card={card('options')} summary={{ text: 'Not answered — you moved on', tone: 'quiet' }} />);
    expect(container.querySelector('[data-settle-mark="quiet"] svg')).toBeNull();
    expect(container.querySelector('[data-settle-mark="quiet"] span')).not.toBeNull();
    expect(screen.getByText('Not answered — you moved on').className).toContain('text-[var(--ds-muted)]');

    rerender(<SettledCard card={card('cast')} summary={{ text: 'Cast: Maya, Arjun', tone: 'plain' }} />);
    expect(container.querySelector('[data-settle-mark="plain"] svg')).not.toBeNull();
    expect(screen.getByText('Cast: Maya, Arjun').className).toContain('text-[var(--ds-ink)]');
  });

  it('has no control: the words are not a tab stop, and the one link is the only focusable thing', () => {
    const onLink = vi.fn();
    const summary: SettledSummary = { text: 'Drew 6 pages and the cover', tone: 'plain', link: { label: 'Open the pages', client: { type: 'open_tab', tab: 'pages' } } };
    const { container } = render(<SettledCard card={card('renders')} summary={summary} onLink={onLink} />);
    const row = container.querySelector('[data-settled="renders"]')!;
    expect(row).toHaveAttribute('aria-live', 'off');
    expect(row.querySelectorAll('button, input, select, textarea, [role="button"]')).toHaveLength(0);
    const focusable = [...row.querySelectorAll(FOCUSABLE)];
    expect(focusable).toHaveLength(1);
    expect(focusable[0].tagName).toBe('A');
    expect(screen.getByText('Drew 6 pages and the cover')).toHaveAttribute('tabindex', '-1');
    const link = screen.getByRole('link', { name: 'Open the pages' });
    expect(link).toHaveAttribute('href', '#pages');
    // A plain navigation link: the click opens the place in the studio and never changes the page's address.
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    link.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    expect(onLink).toHaveBeenCalledWith({ type: 'open_tab', tab: 'pages' });
  });

  it('without a way to open it (no onLink), the link is left out rather than shown dead', () => {
    const summary: SettledSummary = { text: 'Drew 2 pages', tone: 'plain', link: { label: 'Open page 3', client: { type: 'open_page', pageId: 'pg_3' } } };
    const { container } = render(<SettledCard card={card('renders')} summary={summary} />);
    expect(container.querySelector('a')).toBeNull();
  });

  it('runs no animation: no entrance on the row, and the link’s hover ink is off under reduced motion', () => {
    const summary: SettledSummary = { text: 'Drew 2 pages', tone: 'plain', link: { label: 'Open the pages', client: { type: 'open_tab', tab: 'pages' } } };
    const { container } = render(<SettledCard card={card('renders')} summary={summary} onLink={() => undefined} />);
    const row = container.querySelector('[data-settled]')!;
    expect(row.className).not.toMatch(/\b(?:ds-rise-in|ds-stagger|studio-reveal|animate-)/);
    expect(screen.getByRole('link').className).toContain('motion-reduce:transition-none');
  });

  it('a folded line renders nothing', () => {
    const { container } = render(<SettledCard card={card('breakdown')} summary={{ text: '', tone: 'plain', folded: true }} />);
    expect(container.innerHTML).toBe('');
  });
});

describe('focus on settle (settle.md §5.8)', () => {
  const q = card('options', { question: 'Which look?', choices: [{ id: 'c1', label: 'Noir ink' }, { id: 'c2', label: 'Crayon' }] });
  const doc = makeSampleDoc({ conversation: [{ id: 'm1', role: 'assistant', text: '', at: 1, cards: [q] } as Msg] });
  const OPEN: CardSettle = { state: 'open' };
  const PICKED: CardSettle = { state: 'settled', outcome: 'picked', pending: true, picked: ['c1'] };

  it('moves focus to the summary, without scrolling, when the focused card settles', () => {
    const studio = makeFakeStudio({ doc });
    const { rerender } = render(<CardRenderer card={q} studio={studio} settle={OPEN} />);
    const chip = screen.getByRole('button', { name: /Noir ink/ });
    chip.focus();
    expect(document.activeElement).toBe(chip);
    const focus = vi.spyOn(HTMLElement.prototype, 'focus');
    rerender(<CardRenderer card={q} studio={studio} settle={PICKED} />);
    const words = screen.getByText('You picked Noir ink');
    expect(document.activeElement).toBe(words);
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    focus.mockRestore();
  });

  it('never steals focus: a card that settles while focus is elsewhere, or mounts settled, leaves it there', () => {
    const studio = makeFakeStudio({ doc });
    const outside = document.createElement('input');
    document.body.appendChild(outside);
    outside.focus();
    const { rerender, unmount } = render(<CardRenderer card={q} studio={studio} settle={OPEN} />);
    rerender(<CardRenderer card={q} studio={studio} settle={PICKED} />);
    expect(document.activeElement).toBe(outside);
    unmount();
    outside.blur();
    render(<CardRenderer card={q} studio={studio} settle={PICKED} />);
    expect(document.activeElement).toBe(document.body);
    outside.remove();
  });

  it('a click elsewhere after the focus hand-off is never undone by a later re-render', () => {
    const studio = makeFakeStudio({ doc });
    const { rerender } = render(<CardRenderer card={q} studio={studio} settle={OPEN} />);
    screen.getByRole('button', { name: /Noir ink/ }).focus();
    rerender(<CardRenderer card={q} studio={studio} settle={PICKED} />);
    const other = document.createElement('button');
    document.body.appendChild(other);
    other.focus();
    rerender(<CardRenderer card={q} studio={{ ...studio }} settle={{ ...PICKED, pending: undefined }} />);
    expect(document.activeElement).toBe(other);
    fireEvent.blur(other);
    other.remove();
  });
});
