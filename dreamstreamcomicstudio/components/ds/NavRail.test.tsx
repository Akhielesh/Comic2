/**
 * NavRail (redesign plan §11.3 M1c): the landscape-phone rail takes a leading Back item, then the same
 * items as TabBar (generic ids, 44 px, aria-current, the disabled reason).
 */
import React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Compass, Library, Search } from 'lucide-react';
import { DENSITY } from './recipes';
import { expectClasses } from './ds.testkit';
import { NAV_RAIL, NavRail } from './NavRail';
import type { TabBarItem } from './TabBar';

type Place = 'library' | 'discover' | 'search';
const items = (onSelect: (id: Place) => void = () => undefined): TabBarItem<Place>[] => [
  { id: 'library', label: 'Library', icon: <Library />, current: true, onSelect: () => onSelect('library') },
  { id: 'discover', label: 'Discover', icon: <Compass />, current: false, onSelect: () => onSelect('discover') },
  { id: 'search', label: 'Search', icon: <Search />, current: false, disabled: true, disabledReason: 'Search needs a connection', onSelect: () => onSelect('search') }
];

describe('NavRail', () => {
  it('leads with a Back item, apart from the places, that goes back', () => {
    const onBack = vi.fn();
    render(<NavRail<Place> label="Places" items={items()} back={{ label: 'Back to your comics', onBack }} />);
    const nav = screen.getByRole('navigation', { name: 'Places' });
    const buttons = within(nav).getAllByRole('button');
    expect(buttons.map((b) => b.getAttribute('aria-label'))).toEqual(['Back to your comics', 'Library', 'Discover', 'Search, Search needs a connection']);
    expect(buttons[0]).toHaveAttribute('data-nav-back');
    expect(buttons[0]).toHaveTextContent('Back');
    expect(buttons[0]).not.toHaveAttribute('aria-current');
    fireEvent.click(buttons[0]);
    expect(onBack).toHaveBeenCalledTimes(1);
    // The hairline between Back and the places.
    expect(buttons[0].nextElementSibling?.getAttribute('aria-hidden')).toBe('true');
  });

  it('a Back label that does not start with "Back" still says it', () => {
    render(<NavRail label="Places" items={items()} back={{ label: 'Your comics', onBack: () => undefined }} />);
    expect(screen.getByRole('button', { name: 'Back, Your comics' })).toHaveAttribute('data-nav-back');
  });

  it('without a place to go back to, the rail starts with the places', () => {
    render(<NavRail label="Places" items={items()} />);
    const buttons = screen.getAllByRole('button');
    expect(buttons[0]).toHaveAttribute('data-nav', 'library');
    expect(document.querySelector('[data-nav-back]')).toBeNull();
  });

  it('rail items are 44 px columns in the rail token width; the current one is marked; a disabled one never selects', () => {
    const picked: Place[] = [];
    render(<NavRail label="Places" items={items((id) => picked.push(id))} back={{ label: 'Back', onBack: () => undefined }} />);
    const nav = screen.getByRole('navigation', { name: 'Places' });
    expectClasses(nav, NAV_RAIL);
    expect(NAV_RAIL).toContain('w-[calc(var(--rail-w,72px)+var(--sa-left,0px))]');
    for (const b of within(nav).getAllByRole('button')) expectClasses(b, 'w-14', DENSITY.touch);
    expect(screen.getByRole('button', { name: 'Library' })).toHaveAttribute('aria-current', 'page');
    fireEvent.click(screen.getByRole('button', { name: 'Discover' }));
    fireEvent.click(screen.getByRole('button', { name: 'Search, Search needs a connection' }));
    expect(picked).toEqual(['discover']);
    expect(screen.getByRole('status')).toHaveTextContent('Search needs a connection');
  });
});
