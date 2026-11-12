/**
 * The DS-1c overlays together, in the `ds-overlays` QA scene: it keeps the scene contract and opens every overlay;
 * nothing in it animates under reduced motion; every control it and its open overlays render is a 44 px target under a
 * coarse pointer. (Their sources' rules: overlays.hygiene.test.ts.)
 */
import React from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import scene from '../../qa/app/scenes/ds-overlays';
import { QaAppSurface } from '../../qa/app/index';
import { resetToastsForTests } from './Toast';
import { DENSITY } from './recipes';

let reducedMotion = false;
beforeEach(() => {
  reducedMotion = false;
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: reducedMotion && query.includes('prefers-reduced-motion'),
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false
  }));
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
});
afterEach(() => {
  cleanup();
  act(() => resetToastsForTests());
  vi.unstubAllGlobals();
});

const ENTRANCES = ['ds-fade-in', 'ds-scale-in', 'ds-toast-enter', 'ds-toast-exit'];
const animated = () => ENTRANCES.flatMap((c) => Array.from(document.querySelectorAll(`.${c}`)).map((el) => `${c} on <${el.tagName.toLowerCase()} data-slot="${el.getAttribute('data-slot')}">`));

/** Opens every overlay of the scene in turn and returns what each one rendered (closing the modal ones again). */
function openEach(): void {
  const section = (name: string) => document.querySelector<HTMLElement>(`[data-qa-overlay="${name}"]`)!;
  fireEvent.click(within(section('dialog')).getByRole('button', { name: 'Comic details' }));
  expect(screen.getByRole('dialog', { name: 'Comic details' })).toBeInTheDocument();
  fireEvent.keyDown(screen.getByRole('dialog', { name: 'Comic details' }), { key: 'Escape' });
  fireEvent.click(within(section('alert-dialog')).getByRole('button', { name: 'Delete page 3' }));
  expect(screen.getByRole('alertdialog', { name: 'Delete page 3?' })).toBeInTheDocument();
}

describe('the ds-overlays scene', () => {
  it('keeps the QA scene contract and is a whole page under the real harness (one <main>)', () => {
    expect(scene.id).toBe('ds-overlays');
    expect(scene.title).toMatch(/\S/);
    const { container } = render(<QaAppSurface scene="ds-overlays" theme="light" skin={null} index={{ scenes: [scene], problems: [] }} />);
    expect(container.querySelectorAll('main')).toHaveLength(1);
    expect(container.querySelector('[data-qa-app-scene="ds-overlays"] > main[data-qa-scene="ds-overlays"]')).not.toBeNull();
    for (const name of ['dialog', 'alert-dialog', 'menu', 'popover', 'tooltip', 'toast']) expect(container.querySelector(`[data-qa-overlay="${name}"]`), name).not.toBeNull();
    expect(container.querySelectorAll('[data-qa-toast-samples] [data-slot="toast"]')).toHaveLength(5);
  });

  it('every overlay opens from it: dialog, alert dialog, menu, popover, tooltip and a toast in the host', async () => {
    const { Scene } = scene;
    render(<Scene />);
    openEach();
    fireEvent.click(screen.getByRole('button', { name: 'Keep it' }));
    expect(screen.getByText('Kept page 3.')).toBeInTheDocument();
    const menuTrigger = screen.getByRole('button', { name: 'Page actions' });
    menuTrigger.focus();
    fireEvent.keyDown(menuTrigger, { key: 'Enter' });
    expect(screen.getByRole('menu')).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole('menuitem', { name: /Duplicate/ }), { key: 'Enter' });
    expect(screen.getByText(/Chose “Duplicate”/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Filters' }));
    expect(screen.getByRole('dialog', { name: 'Filters' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    act(() => screen.getByRole('button', { name: 'Share' }).focus());
    expect(screen.getByRole('tooltip')).toHaveTextContent('Share a read-only link');
    fireEvent.click(screen.getByRole('button', { name: 'Show a toast with Undo' }));
    const hostCard = document.querySelector('[data-slot="toast-host"] [data-slot="toast"]')!;
    expect(hostCard).toHaveTextContent('Page 3 deleted');
    fireEvent.click(within(hostCard as HTMLElement).getByRole('button', { name: 'Undo' }));
    expect(document.querySelector('[data-slot="toast-host"] [data-slot="toast"]')).toHaveTextContent('Page 3 is back');
  });

  it('under reduced motion nothing animates: no entrance on the cards, the dialogs, the menu, the popover, the tooltip or a toast', () => {
    reducedMotion = true;
    const { Scene } = scene;
    render(<Scene />);
    expect(animated()).toEqual([]);
    openEach();
    expect(animated()).toEqual([]);
    fireEvent.keyDown(screen.getByRole('alertdialog'), { key: 'Escape' });
    const menuTrigger = screen.getByRole('button', { name: 'Page actions' });
    menuTrigger.focus();
    fireEvent.keyDown(menuTrigger, { key: 'Enter' });
    expect(animated()).toEqual([]);
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: 'Filters' }));
    expect(animated()).toEqual([]);
    fireEvent.keyDown(screen.getByRole('dialog', { name: 'Filters' }), { key: 'Escape' });
    act(() => screen.getByRole('button', { name: 'Undo' }).focus());
    fireEvent.click(screen.getByRole('button', { name: 'Show a toast' }));
    expect(screen.getByRole('tooltip')).toBeInTheDocument();
    expect(animated()).toEqual([]);
    // With motion allowed the same surfaces do enter (the check above is not vacuous).
    cleanup();
    act(() => resetToastsForTests());
    reducedMotion = false;
    render(<Scene />);
    expect(animated().length).toBeGreaterThan(0);
  });

  it('44 px under a coarse pointer: every button and menu row the scene and its open overlays render', () => {
    const { Scene } = scene;
    render(<Scene />);
    const coarse = (el: Element) => el.classList.contains(DENSITY.coarse.split(' ')[0]);
    const check = () => {
      const controls = Array.from(document.querySelectorAll('button, [role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"]'));
      const small = controls.filter((el) => !coarse(el)).map((el) => el.getAttribute('aria-label') || el.textContent);
      expect(small).toEqual([]);
      return controls.length;
    };
    expect(check()).toBeGreaterThan(8);
    fireEvent.click(screen.getByRole('button', { name: 'Comic details' }));
    check();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    const menuTrigger = screen.getByRole('button', { name: 'Page actions' });
    menuTrigger.focus();
    fireEvent.keyDown(menuTrigger, { key: 'Enter' });
    check();
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: 'Show a toast with Undo' }));
    check();
  });
});
