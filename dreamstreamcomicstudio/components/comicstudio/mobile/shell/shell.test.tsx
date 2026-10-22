// The studio shell pieces (mobile.md §3, §10.1): layout per form factor, both panes mounted with the
// hidden one inert, the tab bar hiding with the keyboard, the rail, the pane switcher and DualScreen.

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { formFactorFor } from '../useFormFactor';
import { StudioLayout, readSplit, SPLIT_STORAGE_KEY } from './StudioLayout';
import { MobileTabBar, type StudioNavItem } from './MobileTabBar';
import { PaneSwitcher, readPaneMode, writePaneMode } from './PaneSwitcher';
import { DualScreen, segmentSizes } from './DualScreen';
import { CompactHeaderMenu } from './CompactHeaderMenu';
import type { Segments } from '../formFactor';

const rect = (left: number, top: number, width: number, height: number): DOMRectReadOnly =>
  ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRectReadOnly;

const nav = (over: Partial<Record<'chat' | 'board' | 'read', Partial<StudioNavItem>>> = {}): StudioNavItem[] => [
  { id: 'chat', label: 'Chat', icon: null, current: true, onSelect: vi.fn(), ...over.chat },
  { id: 'board', label: 'Board', icon: null, current: false, onSelect: vi.fn(), ...over.board },
  { id: 'read', label: 'Read', icon: null, current: false, onSelect: vi.fn(), ...over.read }
];

const layout = (ff: ReturnType<typeof formFactorFor>, view: 'chat' | 'board' = 'chat', extra: Partial<React.ComponentProps<typeof StudioLayout>> = {}) =>
  render(<StudioLayout ff={ff} chat={<p>chat pane</p>} board={<p>board pane</p>} view={view} navItems={nav()} onBack={vi.fn()} {...extra} />);

const paneOf = (id: string) => document.querySelector(`[data-pane="${id}"]`) as HTMLElement;

beforeEach(() => window.localStorage.clear());
afterEach(() => document.documentElement.classList.remove('kb-open'));

describe('StudioLayout', () => {
  it('phones: one visible pane, both mounted, the hidden one hidden + inert, a bottom tab bar', () => {
    layout(formFactorFor({ w: 390, h: 844, coarse: true }), 'board');
    expect(document.querySelector('[data-layout="single"]')).not.toBeNull();
    expect(screen.getByText('chat pane')).toBeInTheDocument();
    expect(paneOf('chat')).toHaveAttribute('hidden');
    expect(paneOf('chat')).toHaveAttribute('inert');
    expect(paneOf('board')).not.toHaveAttribute('hidden');
    expect(screen.getByRole('navigation', { name: 'Studio views' })).toHaveAttribute('data-tabbar');
  });

  it('the tab bar hides while the keyboard is open (html.kb-open) and pads the bottom safe area', () => {
    layout(formFactorFor({ w: 390, h: 844, coarse: true }));
    const bar = screen.getByRole('navigation', { name: 'Studio views' });
    expect(bar.className).toContain('[html.kb-open_&]:hidden');
    expect(bar.style.paddingBottom).toBe('var(--sa-bottom-eff, 0px)');
  });

  it('phone landscape: a left rail with Back instead of the tab bar', () => {
    const onBack = vi.fn();
    layout(formFactorFor({ w: 852, h: 393, coarse: true }), 'chat', { onBack });
    const rail = screen.getByRole('navigation', { name: 'Studio views' });
    expect(rail).toHaveAttribute('data-rail');
    fireEvent.click(within(rail).getByRole('button', { name: 'Back to your projects' }));
    expect(onBack).toHaveBeenCalled();
  });

  it('tablets split with a resizable gutter that has a 24 px touch strip and a grabber', () => {
    layout(formFactorFor({ w: 820, h: 1180, coarse: true }));
    const gutter = screen.getByRole('separator', { name: 'Resize conversation and board' });
    expect(gutter.className).toContain('w-6');
    expect(gutter).toHaveAttribute('aria-valuenow', '42');
    fireEvent.keyDown(gutter, { key: 'ArrowRight' });
    expect(Number(gutter.getAttribute('aria-valuenow'))).toBeGreaterThan(42);
    fireEvent.keyDown(gutter, { key: 'Home' });
    expect(gutter).toHaveAttribute('aria-valuenow', '42');
  });

  it('desktop keeps a thin gutter (fine pointer) at 40/60', () => {
    layout(formFactorFor({ w: 1440, h: 900 }));
    const gutter = screen.getByRole('separator', { name: 'Resize conversation and board' });
    expect(gutter.className).toContain('w-2');
    expect(gutter).toHaveAttribute('aria-valuenow', '40');
  });

  it('pane mode collapses one side of the split (inert, not unmounted)', () => {
    layout(formFactorFor({ w: 820, h: 1180, coarse: true }), 'chat', { paneMode: 'chat' });
    expect(paneOf('board')).toHaveAttribute('inert');
    expect(screen.getByText('board pane')).toBeInTheDocument();
    expect(screen.queryByRole('separator')).toBeNull();
  });

  it('tabletop posture (vertical segments): board on top, chat with the composer below', () => {
    const segments: Segments = { count: 2, axis: 'vertical', rects: [rect(0, 0, 900, 500), rect(0, 520, 900, 480)], hinge: { start: 500, end: 520 } };
    layout(formFactorFor({ w: 900, h: 1000, coarse: true, segments }));
    expect(document.querySelector('[data-layout="tabletop"]')).not.toBeNull();
    expect(document.querySelector('[data-segment="0"] [data-pane="board"]')).not.toBeNull();
    expect(document.querySelector('[data-segment="1"] [data-pane="chat"]')).not.toBeNull();
  });

  it('readSplit ignores garbage and falls back', () => {
    window.localStorage.setItem(SPLIT_STORAGE_KEY, '{"bad":1}');
    expect(readSplit([40, 60])).toEqual([40, 60]);
    window.localStorage.setItem(SPLIT_STORAGE_KEY, '[30,70]');
    expect(readSplit([40, 60])).toEqual([30, 70]);
  });
});

describe('MobileTabBar', () => {
  it('items are ≥ 64×44, announce badges and dots, and say why Read is disabled', () => {
    render(
      <MobileTabBar
        items={nav({
          board: { badge: '2/5', badgeLabel: '2 of 5 pages ready', dot: 'pulse' },
          read: { disabled: true, disabledReason: 'Read opens once a page is drawn' },
          chat: { dot: 'amber' }
        })}
      />
    );
    const chat = screen.getByRole('button', { name: 'Chat, waiting for your approval' });
    expect(chat).toHaveAttribute('aria-current', 'page');
    expect(chat.className).toContain('min-h-[44px]');
    expect(chat.className).toContain('min-w-[64px]');
    expect(screen.getByRole('button', { name: 'Board, 2 of 5 pages ready, drawing' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Read, Read opens once a page is drawn/ })).toBeDisabled();
  });
});

describe('PaneSwitcher', () => {
  it('remembers the choice per window class; storage failures fall back to both', () => {
    writePaneMode('medium', 'board');
    expect(readPaneMode('medium')).toBe('board');
    expect(readPaneMode('expanded')).toBe('both');
    const onChange = vi.fn();
    render(<PaneSwitcher value="both" onChange={onChange} />);
    fireEvent.click(screen.getByRole('radio', { name: 'Chat only' }));
    expect(onChange).toHaveBeenCalledWith('chat');
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(readPaneMode('medium')).toBe('both');
    spy.mockRestore();
  });
});

describe('DualScreen', () => {
  const book: Segments = { count: 2, axis: 'horizontal', rects: [rect(0, 0, 540, 1000), rect(560, 0, 540, 1000)], hinge: { start: 540, end: 560 } };

  it('segmentSizes: the first pane fills segment 0 and the gap equals the hinge', () => {
    expect(segmentSizes(book)).toEqual({ first: 540, gap: 20 });
    expect(segmentSizes(book, 24)).toEqual({ first: 516, gap: 20 });
    expect(segmentSizes({ count: 1, axis: null, rects: [] })).toBeNull();
  });

  it('no interactive element straddles the hinge: the hinge is an empty spacer', () => {
    render(<DualScreen segments={book} first={<button type="button">left</button>} second={<button type="button">right</button>} />);
    const hinge = document.querySelector('[data-hinge]') as HTMLElement;
    expect(hinge.style.width).toBe('20px');
    expect(hinge.children.length).toBe(0);
    expect(hinge).toHaveAttribute('aria-hidden', 'true');
  });

  it('without segment rects it falls back to the CSS env() variables', () => {
    render(<DualScreen segments={{ count: 2, axis: 'horizontal', rects: [] }} first={<p>a</p>} second={<p>b</p>} />);
    expect((document.querySelector('[data-segment="0"]') as HTMLElement).style.width).toContain('viewport-segment-width');
  });
});

describe('CompactHeaderMenu', () => {
  it('rows are 44 px menu items; disabled rows say why; picking closes the menu first', () => {
    const onClose = vi.fn();
    const onSettings = vi.fn();
    const anchor = { current: document.body };
    render(
      <CompactHeaderMenu
        open
        onClose={onClose}
        anchorRef={anchor}
        rows={[
          { id: 'read', label: 'Read the comic', icon: null, disabled: true, hint: 'Read opens once a page is drawn', onSelect: vi.fn() },
          { id: 'settings', label: 'Settings', icon: null, onSelect: onSettings }
        ]}
      />
    );
    expect(screen.getByRole('menuitem', { name: /Read the comic/ })).toBeDisabled();
    expect(screen.getByText('Read opens once a page is drawn')).toBeInTheDocument();
    const settings = screen.getByRole('menuitem', { name: 'Settings' });
    expect(settings.className).toContain('min-h-[44px]');
    fireEvent.click(settings);
    expect(onClose).toHaveBeenCalled();
    expect(onSettings).toHaveBeenCalled();
  });
});
