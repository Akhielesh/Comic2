/**
 * TabBar (redesign plan §11.3 M1c): generic over its ids, `flex-1 min-w-0` items at least 44 px tall, badges,
 * dots, the disabled-reason bubble, and the studio MobileTabBar's naming rule — without being a wrapper over
 * MobileTabBar.
 */
import React from 'react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BookOpen, Compass, Library, Search } from 'lucide-react';
import { navItemName as studioNavItemName } from '../comicstudio/mobile/shell/MobileTabBar';
import { DENSITY } from './recipes';
import { expectClasses } from './ds.testkit';
import { navItemName, TAB_BAR, TAB_HINT_MS, TAB_ITEM, TabBar, type TabBarItem } from './TabBar';

type Place = 'library' | 'discover' | 'search' | 'saved';

const items = (over: Partial<Record<Place, Partial<TabBarItem<Place>>>> = {}, onSelect: (id: Place) => void = () => undefined): TabBarItem<Place>[] =>
  (
    [
      { id: 'library', label: 'Library', icon: <Library /> },
      { id: 'discover', label: 'Discover', icon: <Compass /> },
      { id: 'search', label: 'Search', icon: <Search /> },
      { id: 'saved', label: 'Saved', icon: <BookOpen /> }
    ] as const
  ).map((base) => ({ current: base.id === 'library', onSelect: () => onSelect(base.id), ...base, ...over[base.id] }));

afterEach(() => vi.useRealTimers());

describe('TabBar is generic over its ids', () => {
  it('takes any string union: each item calls back with its own typed id', () => {
    const picked: Place[] = [];
    render(<TabBar<Place> label="Places" items={items({}, (id) => picked.push(id))} />);
    const nav = screen.getByRole('navigation', { name: 'Places' });
    fireEvent.click(within(nav).getByRole('button', { name: 'Discover' }));
    fireEvent.click(within(nav).getByRole('button', { name: 'Saved' }));
    expect(picked).toEqual(['discover', 'saved']);
    // An id outside the union does not type-check (npm run typecheck fails if TabBar stops being generic).
    // @ts-expect-error 'chat' is not a Place
    const wrong: TabBarItem<Place> = { id: 'chat', label: 'Chat', icon: null, current: false, onSelect: () => undefined };
    expect(wrong.id).toBe('chat');
  });

  it('marks the current place (aria-current="page") and only that one', () => {
    render(<TabBar label="Places" items={items()} />);
    const current = screen.getAllByRole('button').filter((b) => b.getAttribute('aria-current') === 'page');
    expect(current.map((b) => b.getAttribute('data-nav'))).toEqual(['library']);
  });
});

describe('TabBar items: flex-1 min-w-0, 44 px tall', () => {
  it('every item shares the row (flex-1 min-w-0, no 64 px floor) and is a 44 px target on any pointer', () => {
    render(<TabBar label="Places" items={items()} />);
    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(4);
    for (const b of buttons) {
      expectClasses(b, 'flex-1', 'min-w-0', DENSITY.touch);
      expect(b.className).not.toMatch(/min-w-\[64px\]/);
    }
    expect(DENSITY.touch).toBe('min-h-[var(--ds-density-touch)]');
    expect(TAB_ITEM).toContain(DENSITY.touch);
  });

  it('the bar is the tab-bar token tall plus the safe area, capped at 560 px, and hides with the keyboard', () => {
    render(<TabBar label="Places" items={items()} />);
    const nav = screen.getByRole('navigation', { name: 'Places' });
    expectClasses(nav, TAB_BAR);
    expectClasses(nav.firstElementChild!, 'h-[var(--tabbar-h,56px)]', 'max-w-[560px]', 'mx-auto');
    expect(TAB_BAR).toContain('[html.kb-open_&]:hidden');
    expect(TAB_BAR).toContain('pb-[var(--sa-bottom-eff,0px)]');
  });
});

describe('TabBar badges and dots', () => {
  it('shows a badge and says what it means, label first (WCAG 2.5.3)', () => {
    render(<TabBar label="Places" items={items({ library: { badge: '3/6', badgeLabel: '3 of 6 pages ready' } })} />);
    const lib = screen.getByRole('button', { name: 'Library 3/6, 3 of 6 pages ready' });
    expect(within(lib).getByText('3/6')).toBeInTheDocument();
  });

  it('a dot is drawn and spoken: new reply, waiting for approval, and live drawing (the LiveDot)', () => {
    render(<TabBar label="Places" items={items({ library: { dot: 'accent' }, discover: { dot: 'amber' }, search: { dot: 'pulse' } })} />);
    const reply = screen.getByRole('button', { name: 'Library, new reply' });
    const waiting = screen.getByRole('button', { name: 'Discover, waiting for your approval' });
    const drawing = screen.getByRole('button', { name: 'Search, drawing' });
    expect(reply.querySelector('[data-dot="accent"]')).not.toBeNull();
    expect(waiting.querySelector('[data-dot="amber"]')!.className).toContain('bg-[var(--ds-warning)]');
    expect(drawing.querySelector('[data-dot="pulse"] [data-slot="live-dot"]')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Saved' }).querySelector('[data-dot]')).toBeNull();
  });

  it('names items exactly as the studio MobileTabBar does (one rule for both navigations)', () => {
    const cases = [
      { label: 'Board', badge: '6/12', badgeLabel: '6 of 12 pages ready', dot: 'pulse' as const },
      { label: 'Board', badge: '6/12', badgeLabel: 'pages ready: 6' },
      { label: 'Chat', dot: 'accent' as const },
      { label: 'Read', disabled: true, disabledReason: 'Nothing to read yet' },
      { label: 'Read', dot: 'amber' as const, disabled: true, disabledReason: 'Approve the plan first' }
    ];
    for (const c of cases) expect(navItemName(c)).toBe(studioNavItemName(c));
  });
});

describe('TabBar: an unavailable item says why', () => {
  it('stays focusable (aria-disabled), ignores the select, and shows the reason in a calm bubble for a while', () => {
    vi.useFakeTimers();
    const onSelect = vi.fn();
    render(<TabBar label="Places" items={items({ saved: { disabled: true, disabledReason: 'Sign in to keep comics', onSelect } })} />);
    const saved = screen.getByRole('button', { name: 'Saved, Sign in to keep comics' });
    expect(saved).toHaveAttribute('aria-disabled', 'true');
    expect(saved).not.toBeDisabled();
    expect(saved).toHaveAttribute('title', 'Sign in to keep comics');
    fireEvent.click(saved);
    expect(onSelect).not.toHaveBeenCalled();
    const bubble = screen.getByRole('status');
    expect(bubble).toHaveTextContent('Sign in to keep comics');
    expect(bubble).toHaveAttribute('data-nav-hint');
    act(() => {
      vi.advanceTimersByTime(TAB_HINT_MS - 1);
    });
    expect(screen.queryByRole('status')).not.toBeNull();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('an unavailable item with no reason stays silent', () => {
    render(<TabBar label="Places" items={items({ saved: { disabled: true } })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Saved' }));
    expect(screen.queryByRole('status')).toBeNull();
  });
});

describe('TabBar is its own primitive, not a MobileTabBar wrapper', () => {
  it('imports nothing from the studio shell', () => {
    const src = readFileSync(path.join(__dirname, 'TabBar.tsx'), 'utf8');
    expect(src).not.toMatch(/from ['"][^'"]*comicstudio/);
  });
});
