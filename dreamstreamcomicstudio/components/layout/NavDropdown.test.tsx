// NavDropdown (components/layout): the header's disclosure menu. The bug it fixes: a mouse hover opened the
// menu and the click that followed toggled it shut under the cursor (UX map §0 item 2). Also covered: touch
// (no hover-open, a tap toggles), keyboard (arrows, Home/End, Escape back to the trigger, Tab out), a press
// outside, choosing a row, a crossing that waits (busy row) and real links.
import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HOVER_CLOSE_MS, NavDropdown, type NavDropdownItem } from './NavDropdown';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const items = (overrides: Partial<NavDropdownItem>[] = []): NavDropdownItem[] =>
  [
    { label: 'Comic Studio', description: 'Turn a script into a finished comic', onClick: vi.fn() },
    { label: 'Chat Studio', description: 'Chat with leading AI models', onClick: vi.fn() },
    { label: 'Atlas Studio', href: 'https://atlas.dreamstreamstudio.ai', external: true }
  ].map((item, i) => ({ ...item, ...overrides[i] }));

const setup = (list = items()) => {
  render(
    <div>
      <NavDropdown label="Studios" caption="Studios" items={list} />
      <button type="button">Elsewhere</button>
    </div>
  );
  return { trigger: screen.getByRole('button', { name: 'Studios' }), list };
};

const mouse = { pointerType: 'mouse' };
const isOpen = () => screen.getByRole('button', { name: 'Studios' }).getAttribute('aria-expanded') === 'true';
const root = () => screen.getByRole('button', { name: 'Studios' }).parentElement!;

describe('NavDropdown', () => {
  it('a hover opens it and the click that follows keeps it open (it used to close it)', () => {
    const { trigger } = setup();
    fireEvent.pointerEnter(root(), mouse);
    expect(isOpen()).toBe(true);
    fireEvent.click(trigger);
    expect(isOpen()).toBe(true);
    expect(screen.getByRole('link', { name: /Atlas Studio/ })).toBeInTheDocument();
    // The click pinned it: leaving with the mouse no longer closes it.
    vi.useFakeTimers();
    fireEvent.pointerLeave(root(), mouse);
    act(() => void vi.advanceTimersByTime(HOVER_CLOSE_MS * 3));
    expect(isOpen()).toBe(true);
    // A second click closes it.
    fireEvent.click(trigger);
    expect(isOpen()).toBe(false);
  });

  it('a hover-opened menu closes after the grace period when the mouse leaves, and not if it comes back', () => {
    vi.useFakeTimers();
    setup();
    fireEvent.pointerEnter(root(), mouse);
    fireEvent.pointerLeave(root(), mouse);
    act(() => void vi.advanceTimersByTime(HOVER_CLOSE_MS / 2));
    fireEvent.pointerEnter(root(), mouse);
    act(() => void vi.advanceTimersByTime(HOVER_CLOSE_MS * 2));
    expect(isOpen()).toBe(true);
    fireEvent.pointerLeave(root(), mouse);
    act(() => void vi.advanceTimersByTime(HOVER_CLOSE_MS + 1));
    expect(isOpen()).toBe(false);
  });

  it('touch: the emulated hover does not open it, a tap toggles it', () => {
    const { trigger } = setup();
    fireEvent.pointerEnter(root(), { pointerType: 'touch' });
    expect(isOpen()).toBe(false);
    fireEvent.click(trigger);
    expect(isOpen()).toBe(true);
    fireEvent.click(trigger);
    expect(isOpen()).toBe(false);
  });

  it('keyboard: ArrowDown opens on the first row, arrows wrap, Home/End jump, Escape returns to the trigger', () => {
    const { trigger } = setup();
    trigger.focus();
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    const comic = screen.getByRole('button', { name: /Comic Studio/ });
    const chat = screen.getByRole('button', { name: /Chat Studio/ });
    const atlas = screen.getByRole('link', { name: /Atlas Studio/ });
    expect(comic).toHaveFocus();
    fireEvent.keyDown(comic, { key: 'ArrowDown' });
    expect(chat).toHaveFocus();
    fireEvent.keyDown(chat, { key: 'End' });
    expect(atlas).toHaveFocus();
    fireEvent.keyDown(atlas, { key: 'ArrowDown' });
    expect(comic).toHaveFocus();
    fireEvent.keyDown(comic, { key: 'ArrowUp' });
    expect(atlas).toHaveFocus();
    fireEvent.keyDown(atlas, { key: 'Home' });
    expect(comic).toHaveFocus();
    fireEvent.keyDown(comic, { key: 'Escape' });
    expect(isOpen()).toBe(false);
    expect(trigger).toHaveFocus();
  });

  it('ArrowUp opens on the last row', () => {
    const { trigger } = setup();
    trigger.focus();
    fireEvent.keyDown(trigger, { key: 'ArrowUp' });
    expect(screen.getByRole('link', { name: /Atlas Studio/ })).toHaveFocus();
  });

  it('a press outside or focus moving elsewhere closes it', () => {
    const { trigger } = setup();
    fireEvent.click(trigger);
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Elsewhere' }));
    expect(isOpen()).toBe(false);
    fireEvent.click(trigger);
    fireEvent.focusIn(screen.getByRole('button', { name: 'Elsewhere' }));
    expect(isOpen()).toBe(false);
  });

  it('a press inside does not close it', () => {
    const { trigger } = setup();
    fireEvent.click(trigger);
    fireEvent.pointerDown(screen.getByText('Turn a script into a finished comic'));
    expect(isOpen()).toBe(true);
  });

  it('choosing a row runs it and closes the menu', () => {
    const { trigger, list } = setup();
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('button', { name: /Chat Studio/ }));
    expect(list[1].onClick).toHaveBeenCalledTimes(1);
    expect(isOpen()).toBe(false);
  });

  it('a row whose action waits stays open, marked busy with its busy label, until it settles', async () => {
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => (finish = resolve));
    const { trigger } = setup(items([{ onClick: () => pending, busyLabel: 'Opening Comic Studio…' }]));
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('button', { name: /Comic Studio/ }));
    const row = screen.getByRole('button', { name: /Comic Studio/ });
    expect(row).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByText('Opening Comic Studio…')).toBeInTheDocument();
    expect(isOpen()).toBe(true);
    await act(async () => {
      finish();
      await pending;
    });
    expect(isOpen()).toBe(false);
  });

  it('a row with an address is a real link: a plain click runs the in-app action, a new-tab click follows the link', () => {
    const open = vi.fn();
    const { trigger } = setup(items([{ href: '/?view=dashboard', onClick: open }]));
    fireEvent.click(trigger);
    const link = screen.getByRole('link', { name: /Comic Studio/ });
    expect(link).toHaveAttribute('href', '/?view=dashboard');
    const modified = fireEvent.click(link, { metaKey: true });
    expect(modified).toBe(true); // not prevented: the browser opens a new tab
    expect(open).not.toHaveBeenCalled();
    const plain = fireEvent.click(link);
    expect(plain).toBe(false); // prevented: the app opens the page itself
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('marks the page on screen and an external destination', () => {
    const { trigger } = setup(items([{ current: true }]));
    fireEvent.click(trigger);
    expect(screen.getByRole('button', { name: /Comic Studio/ })).toHaveAttribute('aria-current', 'page');
    const atlas = screen.getByRole('link', { name: /Atlas Studio/ });
    expect(atlas).toHaveAttribute('href', 'https://atlas.dreamstreamstudio.ai');
    expect(atlas).toHaveAttribute('rel', 'noopener');
  });

  it('uses the disclosure pattern (aria-expanded, aria-controls) and draws no legacy comic chrome', () => {
    const { trigger } = setup();
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(trigger).not.toHaveAttribute('aria-haspopup');
    fireEvent.click(trigger);
    const panel = document.getElementById(trigger.getAttribute('aria-controls')!)!;
    expect(panel).toBeInTheDocument();
    expect(panel.className).not.toMatch(/shadow-comic|border-black|brand-/);
    expect(panel.className).toContain('ds-scale-in');
  });
});
