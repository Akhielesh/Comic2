/**
 * The Toast host and the app's ONE toast slot (redesign plan §2 "Toasts", §11.3 M1b): a second claim evicts the first
 * and tells it once (claimUndoToast's rule, which the timeline now re-exports from here); one card at a time, above
 * the tab bar and the safe area; the Atlas card (TOAST recipes); the dismiss clock that holds while hovered or
 * focused; 44 px controls under a coarse pointer; nothing animates under reduced motion; no timer while idle.
 */
import React from 'react';
import { createRequire } from 'node:module';
import path from 'node:path';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  claimToast,
  dismissToast,
  resetToastsForTests,
  subscribeToastSlot,
  toast,
  TOAST_DURATION_MS,
  TOAST_HOST,
  ToastCard,
  ToastHost,
  toastSlotOwner,
  useToastSlot
} from './Toast';
import { claimUndoToast, UNDO_TOAST_MS } from '../comicstudio/timeline/UndoToast';
import { TOAST, TOAST_COUNTDOWN, TOAST_EDGE, TOAST_ENTER, TOAST_EXIT, TOAST_EXIT_FALLBACK_MS, TOAST_MESSAGE, TOAST_TITLE } from '../chat/studioDesign';
import { DENSITY, STATUS_DOT, STATUS_INK, Z } from './recipes';
import { expectClasses } from './ds.testkit';

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
});
afterEach(() => {
  cleanup();
  act(() => resetToastsForTests());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const host = () => document.querySelector<HTMLElement>('[data-slot="toast-host"]');
const status = () => document.querySelector<HTMLElement>('[data-slot="toast-host"] > [data-slot="toast-status"]');
/** The live regions around an element (itself excluded). */
const liveAncestors = (el: Element) => {
  const out: Element[] = [];
  for (let at = el.parentElement; at; at = at.parentElement) if (at.matches('[role="status"],[role="alert"],[aria-live]')) out.push(at);
  return out;
};
const cards = () => Array.from(document.querySelectorAll<HTMLElement>('[data-slot="toast"]'));

describe('the one slot (claimToast; the timeline re-exports it as claimUndoToast)', () => {
  it('a second claim evicts the first and tells it once; ids only grow', () => {
    const lostA = vi.fn();
    const lostB = vi.fn();
    const a = claimToast(lostA);
    expect(toastSlotOwner()).toBe(a);
    const b = claimToast(lostB);
    expect(b).toBeGreaterThan(a);
    expect(toastSlotOwner()).toBe(b);
    expect(lostA).toHaveBeenCalledTimes(1);
    expect(lostB).not.toHaveBeenCalled();
    claimToast();
    claimToast();
    expect(lostA).toHaveBeenCalledTimes(1); // told once
    expect(lostB).toHaveBeenCalledTimes(1);
  });

  it('is the timeline’s slot: claimUndoToast is this claim, and a timeline claim evicts an app toast', () => {
    expect(claimUndoToast).toBe(claimToast);
    expect(UNDO_TOAST_MS).toBe(TOAST_DURATION_MS);
    render(<ToastHost />);
    const lost = vi.fn();
    const dismissed = vi.fn();
    act(() => void toast({ title: 'Invite accepted', onLost: lost, onDismiss: dismissed }));
    expect(cards()).toHaveLength(1);
    act(() => void claimUndoToast());
    expect(cards()).toHaveLength(0); // gone at once: no exit animation overlapping the newer toast
    expect(lost).toHaveBeenCalledTimes(1);
    expect(dismissed).not.toHaveBeenCalled();
  });

  it('a dismissed toast lets go of the slot: a later claim never tells it it was lost', () => {
    const onLost = vi.fn();
    const onDismiss = vi.fn();
    const handle = toast({ title: 'Copied the link', onLost, onDismiss });
    handle.dismiss();
    expect(onDismiss).toHaveBeenCalledTimes(1);
    claimToast();
    act(() => void toast({ title: 'Saved' }));
    expect(onLost).not.toHaveBeenCalled();
  });

  it('useToastSlot follows the slot live, and listeners can unsubscribe', () => {
    const seen: boolean[] = [];
    let mine = 0;
    function Probe() {
      seen.push(useToastSlot(mine));
      return null;
    }
    mine = claimToast();
    render(<Probe />);
    expect(seen.at(-1)).toBe(true);
    act(() => void claimToast());
    expect(seen.at(-1)).toBe(false);
    const listener = vi.fn();
    const off = subscribeToastSlot(listener);
    claimToast();
    off();
    claimToast();
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe('ToastHost', () => {
  it('shows one toast at a time: a newer toast replaces the shown one (its onLost, never its onDismiss)', () => {
    render(<ToastHost />);
    const first = { onLost: vi.fn(), onDismiss: vi.fn() };
    act(() => void toast({ title: 'Page 3 deleted', ...first }));
    act(() => void toast({ title: 'Saved to your library' }));
    expect(cards()).toHaveLength(1);
    expect(screen.getByText('Saved to your library')).toBeInTheDocument();
    expect(screen.queryByText('Page 3 deleted')).toBeNull();
    expect(first.onLost).toHaveBeenCalledTimes(1);
    expect(first.onDismiss).not.toHaveBeenCalled();
  });

  it('a toast evicts a component toast that claimed the slot (History’s restore toast), and that one is told', () => {
    render(<ToastHost />);
    const restoreLost = vi.fn();
    claimUndoToast(restoreLost);
    act(() => void toast({ title: 'Back online' }));
    expect(restoreLost).toHaveBeenCalledTimes(1);
  });

  it('sits above the phone tab bar and the safe area, on the toast layer; its polite status region is there while idle', () => {
    render(<ToastHost />);
    const el = host()!;
    expect(el.parentElement).toBe(document.body); // portalled: no sheet transform can move or clip it
    expectClasses(el, TOAST_HOST, Z.toast);
    expect(el.className).toContain('bottom-[calc(var(--tabbar-h,56px)+var(--sa-bottom-eff,0px)+12px)]');
    // The host itself is no live region (an error card inside it would nest one in another).
    expect(el).not.toHaveAttribute('role');
    expect(el).not.toHaveAttribute('aria-live');
    const region = status()!;
    expect(region.parentElement).toBe(el);
    expect(region).toHaveAttribute('role', 'status');
    expect(region).toHaveAttribute('aria-live', 'polite');
    expect(region).toBeEmptyDOMElement(); // in the page before any toast, so the first one is heard
  });

  it('the position compiles to calc(--tabbar-h + --sa-bottom-eff + 12px) under this app’s Tailwind', async () => {
    const req = createRequire(import.meta.url);
    const postcss = req('postcss');
    const tailwind = req('tailwindcss');
    const config = req(path.join(process.cwd(), 'tailwind.config.cjs'));
    const out = await postcss([tailwind({ ...config, content: [{ raw: TOAST_HOST, extension: 'html' }], corePlugins: { preflight: false } })]).process('@tailwind utilities;', { from: undefined });
    const css = out.css.replace(/\s+/g, ' ');
    expect(css).toMatch(/bottom: calc\(var\(--tabbar-h,\s?56px\) \+ var\(--sa-bottom-eff,\s?0px\) \+ 12px\)/);
    expect(css).toContain('z-index: var(--ds-z-toast)');
  });

  it('renders the Atlas card: TOAST, the status edge, the icon ink, title and message, the time-left bar', () => {
    render(<ToastHost />);
    act(() => void toast({ title: 'Invite accepted', message: 'Welcome to the beta.', tone: 'healthy' }));
    const card = cards()[0];
    expectClasses(card, TOAST, TOAST_ENTER);
    expectClasses(card.querySelector('[data-toast-edge]')!, TOAST_EDGE, STATUS_DOT.healthy);
    expect(card.querySelector(`.${STATUS_INK.healthy.replace(/[[\]()\-:]/g, '\\$&')}`)).not.toBeNull();
    expectClasses(screen.getByText('Invite accepted'), TOAST_TITLE);
    expectClasses(screen.getByText('Welcome to the beta.'), TOAST_MESSAGE);
    const bar = card.querySelector<HTMLElement>('[data-toast-countdown]')!;
    expectClasses(bar, TOAST_COUNTDOWN, STATUS_DOT.healthy);
    expect(bar.style.getPropertyValue('--ds-toast-duration')).toBe(`${TOAST_DURATION_MS}ms`);
    expect(card).not.toHaveAttribute('role'); // polite, through the host's status region
    expect(liveAncestors(card)).toEqual([status()]);
  });

  it('an error is announced at once (role alert), outside the polite region (live regions never nest); a toast that stays has no time-left bar', () => {
    render(<ToastHost />);
    act(() => void toast({ title: 'That invite has expired', tone: 'error', duration: 0 }));
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('That invite has expired');
    expect(alert).toBe(cards()[0]);
    expect(liveAncestors(alert)).toEqual([]);
    expect(status()).toBeEmptyDOMElement();
    expect(cards()[0].querySelector('[data-toast-countdown]')).toBeNull();
    // A polite toast that replaces it lands back in the region.
    act(() => void toast({ title: 'Invite accepted' }));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(status()).toHaveTextContent('Invite accepted');
  });

  it('dismisses itself after its duration; the clock holds while hovered or focused and resumes with what was left', () => {
    vi.useFakeTimers();
    render(<ToastHost />);
    const onDismiss = vi.fn();
    act(() => void toast({ title: 'Copied the link', duration: 4000, onDismiss }));
    act(() => void vi.advanceTimersByTime(3000));
    const card = cards()[0];
    fireEvent.pointerEnter(card);
    expect(card).toHaveAttribute('data-paused');
    act(() => void vi.advanceTimersByTime(60_000));
    expect(onDismiss).not.toHaveBeenCalled();
    fireEvent.pointerLeave(card);
    expect(card).not.toHaveAttribute('data-paused');
    act(() => void vi.advanceTimersByTime(999));
    expect(onDismiss).not.toHaveBeenCalled();
    act(() => void vi.advanceTimersByTime(1));
    expect(onDismiss).toHaveBeenCalledTimes(1);
    // Focus holds it too.
    act(() => void toast({ title: 'Saved', duration: 1000 }));
    const next = cards().at(-1)!;
    act(() => screen.getByRole('button', { name: 'Dismiss' }).focus());
    expect(next).toHaveAttribute('data-paused');
    act(() => void vi.advanceTimersByTime(5000));
    expect(screen.getByText('Saved')).toBeInTheDocument();
  });

  it('a toast with duration 0 stays until dismissed; Esc and the Dismiss button dismiss it (onDismiss once)', () => {
    vi.useFakeTimers();
    render(<ToastHost />);
    const onDismiss = vi.fn();
    act(() => void toast({ title: 'Your invite could not be used', tone: 'attention', duration: 0, onDismiss }));
    act(() => void vi.advanceTimersByTime(10 * 60_000));
    expect(screen.getByText('Your invite could not be used')).toBeInTheDocument();
    fireEvent.keyDown(cards()[0], { key: 'Escape' });
    expect(onDismiss).toHaveBeenCalledTimes(1);
    act(() => void vi.advanceTimersByTime(TOAST_EXIT_FALLBACK_MS));
    expect(cards()).toHaveLength(0);
    const second = vi.fn();
    act(() => void toast({ title: 'Again', duration: 0, onDismiss: second }));
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(second).toHaveBeenCalledTimes(1);
    expect(dismissToast()).toBe(false); // nothing left to dismiss
  });

  it('its action runs and dismisses the toast', () => {
    render(<ToastHost />);
    const onClick = vi.fn();
    const onDismiss = vi.fn();
    act(() => void toast({ title: 'Cast updated', action: { label: 'View', onClick }, onDismiss }));
    fireEvent.click(screen.getByRole('button', { name: 'View' }));
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('the handle dismisses only its own toast', () => {
    render(<ToastHost />);
    let first!: ReturnType<typeof toast>;
    act(() => void (first = toast({ title: 'One' })));
    act(() => void toast({ title: 'Two' }));
    act(() => first.dismiss());
    expect(screen.getByText('Two')).toBeInTheDocument();
  });

  it('leaves with TOAST_EXIT, removed on its animationend or after the fallback', () => {
    vi.useFakeTimers();
    render(<ToastHost />);
    let handle!: ReturnType<typeof toast>;
    act(() => void (handle = toast({ title: 'Leaving' })));
    act(() => handle.dismiss());
    const card = cards()[0];
    expectClasses(card, TOAST_EXIT);
    expect(card.className).not.toContain(TOAST_ENTER);
    expect(screen.queryByRole('button', { name: 'Dismiss' })).toBeNull(); // a leaving toast takes no more presses
    fireEvent.animationEnd(card);
    expect(cards()).toHaveLength(0);
    act(() => void (handle = toast({ title: 'Leaving again' })));
    act(() => handle.dismiss());
    act(() => void vi.advanceTimersByTime(TOAST_EXIT_FALLBACK_MS));
    expect(cards()).toHaveLength(0);
  });

  it('under reduced motion nothing animates: no entrance, and a dismissed toast goes at once', () => {
    reducedMotion = true;
    render(<ToastHost />);
    let handle!: ReturnType<typeof toast>;
    act(() => void (handle = toast({ title: 'Calm' })));
    const card = cards()[0];
    expect(card.className).not.toContain(TOAST_ENTER);
    act(() => handle.dismiss());
    expect(cards()).toHaveLength(0);
  });

  it('44 px under a coarse pointer: the action and the Dismiss button', () => {
    render(<ToastHost />);
    act(() => void toast({ title: 'Page 3 deleted', action: { label: 'Undo', onClick: () => undefined } }));
    expectClasses(screen.getByRole('button', { name: 'Undo' }), DENSITY.coarse);
    expectClasses(screen.getByRole('button', { name: 'Dismiss' }), DENSITY.coarseSquare);
  });

  it('a second mounted host renders nothing, so a toast never shows twice', () => {
    render(
      <>
        <ToastHost />
        <ToastHost />
      </>
    );
    expect(document.querySelectorAll('[data-slot="toast-host"]')).toHaveLength(1);
    act(() => void toast({ title: 'Once' }));
    expect(screen.getAllByText('Once')).toHaveLength(1);
  });

  it('idle, it runs no timer (the page stays quiet)', () => {
    vi.useFakeTimers();
    render(<ToastHost />);
    expect(vi.getTimerCount()).toBe(0);
    let handle!: ReturnType<typeof toast>;
    act(() => void (handle = toast({ title: 'Briefly', duration: 2000 })));
    expect(vi.getTimerCount()).toBe(1);
    act(() => handle.dismiss());
    act(() => void vi.advanceTimersByTime(TOAST_EXIT_FALLBACK_MS));
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('ToastCard (static)', () => {
  it('without onDismiss it has no close button and no clock', () => {
    vi.useFakeTimers();
    render(<ToastCard title="Draft saved" tone="waiting" duration={3000} />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });
});
