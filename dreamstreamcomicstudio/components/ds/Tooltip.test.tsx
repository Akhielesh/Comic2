/**
 * Tooltip (Radix): opens after 300 ms of hover (fake timers) in inverted ink on the tooltip layer, at once on keyboard
 * focus, and never needs hover on touch: a touch "hover" opens nothing, a long press shows it (and does not press the
 * control), a plain tap presses the control and shows nothing. Esc closes it; under reduced motion it does not fade.
 */
import React from 'react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Undo2 } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger, TOOLTIP_ARROW, TOOLTIP_DELAY_MS, TOOLTIP_LONG_PRESS_MS, TOOLTIP_PANEL, TOOLTIP_TOUCH_HOLD_MS } from './Tooltip';
import { IconButton } from './IconButton';
import { INVERSE_SURFACE } from '../chat/studioDesign';
import { Z } from './recipes';
import { expectClasses } from './ds.testkit';

let reducedMotion = false;
beforeEach(() => {
  reducedMotion = false;
  vi.useFakeTimers();
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
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function UndoButton({ onUndo = () => undefined }: { onUndo?: () => void }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <IconButton label="Undo" title={null} onClick={onUndo}>
          <Undo2 />
        </IconButton>
      </TooltipTrigger>
      <TooltipContent>Undo · Ctrl+Z</TooltipContent>
    </Tooltip>
  );
}

const trigger = () => screen.getByRole('button', { name: 'Undo' });
const tip = () => screen.queryByRole('tooltip');
const advance = (ms: number) => act(() => void vi.advanceTimersByTime(ms));

describe('Tooltip', () => {
  it('the delay is the skin’s --ds-tooltip-delay (300 ms)', () => {
    expect(TOOLTIP_DELAY_MS).toBe(300);
    const css = readFileSync(path.join(process.cwd(), 'index.css'), 'utf8');
    expect(css).toMatch(/--ds-tooltip-delay:\s*300ms/);
  });

  it('opens after 300 ms of hover, in inverted ink on the tooltip layer, and describes its trigger', () => {
    render(<UndoButton />);
    fireEvent.pointerMove(trigger(), { pointerType: 'mouse' });
    advance(TOOLTIP_DELAY_MS - 1);
    expect(tip()).toBeNull();
    advance(1);
    const content = document.querySelector<HTMLElement>('[data-slot="tooltip-content"]')!;
    expect(tip()).toHaveTextContent('Undo · Ctrl+Z');
    expectClasses(content, INVERSE_SURFACE, TOOLTIP_PANEL, Z.tooltip, 'ds-fade-in');
    expectClasses(content.querySelector('svg')!, TOOLTIP_ARROW);
    expect(trigger()).toHaveAccessibleDescription('Undo · Ctrl+Z');
    // Leaving closes it.
    fireEvent.pointerLeave(trigger(), { pointerType: 'mouse' });
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    expect(tip()).toBeNull();
  });

  it('keyboard focus opens it at once; Esc closes it', () => {
    render(<UndoButton />);
    act(() => trigger().focus());
    expect(tip()).toHaveTextContent('Undo · Ctrl+Z');
    fireEvent.keyDown(trigger(), { key: 'Escape' });
    expect(tip()).toBeNull();
  });

  it('touch never needs hover: a touch "hover" opens nothing; a long press shows it and does not press the button', () => {
    const onUndo = vi.fn();
    render(<UndoButton onUndo={onUndo} />);
    fireEvent.pointerMove(trigger(), { pointerType: 'touch' });
    advance(5000);
    expect(tip()).toBeNull();

    fireEvent.pointerDown(trigger(), { pointerType: 'touch', clientX: 10, clientY: 10 });
    advance(TOOLTIP_LONG_PRESS_MS - 1);
    expect(tip()).toBeNull();
    advance(1);
    expect(tip()).toHaveTextContent('Undo · Ctrl+Z');
    fireEvent.pointerUp(trigger(), { pointerType: 'touch' });
    fireEvent.click(trigger());
    expect(onUndo).not.toHaveBeenCalled(); // the long press was for the label
    expect(tip()).not.toBeNull();
    advance(TOOLTIP_TOUCH_HOLD_MS);
    expect(tip()).toBeNull();

    // A plain tap is a plain tap: it presses the button and shows nothing.
    fireEvent.pointerDown(trigger(), { pointerType: 'touch', clientX: 10, clientY: 10 });
    advance(120);
    fireEvent.pointerUp(trigger(), { pointerType: 'touch' });
    fireEvent.click(trigger());
    expect(onUndo).toHaveBeenCalledTimes(1);
    advance(TOOLTIP_LONG_PRESS_MS);
    expect(tip()).toBeNull();
  });

  it('a finger that moves is scrolling: no tooltip', () => {
    render(<UndoButton />);
    fireEvent.pointerDown(trigger(), { pointerType: 'touch', clientX: 10, clientY: 10 });
    fireEvent.pointerMove(trigger(), { pointerType: 'touch', clientX: 10, clientY: 40 });
    advance(TOOLTIP_LONG_PRESS_MS * 2);
    expect(tip()).toBeNull();
  });

  it('inside a TooltipProvider the neighbour opens without the wait (skip delay)', () => {
    render(
      <TooltipProvider>
        <UndoButton />
        <Tooltip>
          <TooltipTrigger asChild>
            <IconButton label="Redo" title={null}>
              <Undo2 />
            </IconButton>
          </TooltipTrigger>
          <TooltipContent>Redo</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
    fireEvent.pointerMove(trigger(), { pointerType: 'mouse' });
    advance(TOOLTIP_DELAY_MS);
    expect(tip()).toHaveTextContent('Undo');
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(tip()).toBeNull();
    // Within the skip window the neighbour needs no wait.
    fireEvent.pointerMove(screen.getByRole('button', { name: 'Redo' }), { pointerType: 'mouse' });
    expect(tip()).toHaveTextContent('Redo');
  });

  it('a controlled tooltip follows open / onOpenChange', () => {
    const onOpenChange = vi.fn();
    const { rerender } = render(
      <Tooltip open={false} onOpenChange={onOpenChange}>
        <TooltipTrigger>Info</TooltipTrigger>
        <TooltipContent>More</TooltipContent>
      </Tooltip>
    );
    act(() => screen.getByRole('button', { name: 'Info' }).focus());
    expect(onOpenChange).toHaveBeenCalledWith(true);
    expect(tip()).toBeNull();
    rerender(
      <Tooltip open onOpenChange={onOpenChange}>
        <TooltipTrigger>Info</TooltipTrigger>
        <TooltipContent>More</TooltipContent>
      </Tooltip>
    );
    expect(tip()).toHaveTextContent('More');
  });

  it('under reduced motion it does not fade in', () => {
    reducedMotion = true;
    render(<UndoButton />);
    act(() => trigger().focus());
    expect(document.querySelector('[data-slot="tooltip-content"]')!.className).not.toContain('ds-fade-in');
  });
});
