/**
 * Tooltip — Atlas `ui-generated/tooltip.tsx` on Radix (`@radix-ui/react-tooltip`) and the `--ds-*` tokens: a short
 * label for a control (an icon button's name, a shortcut), in inverted ink (INVERSE_SURFACE: ink panel, paper words;
 * under the dark skin a raised dark panel with a light rim), on the Z.tooltip layer.
 *
 * When it shows:
 * - a mouse or pen resting on the trigger: after 300 ms (TOOLTIP_DELAY_MS, the skin's `--ds-tooltip-delay`); moving
 *   on to a neighbour inside a TooltipProvider skips the wait;
 * - keyboard focus on the trigger: at once (Radix);
 * - touch: hover does not exist there, so it never depends on it. A long press (TOOLTIP_LONG_PRESS_MS) shows the
 *   label and holds it TOOLTIP_TOUCH_HOLD_MS after the finger lifts; that press does not also press the control
 *   (its click is swallowed). A plain tap is a plain tap: it presses the control and shows nothing.
 * Esc, a press elsewhere or leaving closes it. Radix gives the open tooltip `role` tooltip and points the trigger's
 * `aria-describedby` at it. A tooltip repeats or adds to a name, never replaces one: an icon-only trigger still needs
 * its own label (IconButton's `label`; pass `title={null}` so the native title does not double it).
 *
 * Use: <Tooltip><TooltipTrigger asChild><IconButton label="Undo" title={null}>…</IconButton></TooltipTrigger>
 * <TooltipContent>Undo · Ctrl+Z</TooltipContent></Tooltip>. One TooltipProvider near the root shares the skip-delay
 * across tooltips; a Tooltip outside any provider brings its own.
 */
import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { cn } from '../../lib/utils';
// Not in components/ds/recipes.ts yet (a wave note adds it); from the single source.
import { INVERSE_SURFACE } from '../chat/studioDesign';
import { Z } from './recipes';
import { useReducedMotion } from './useReducedMotion';

/** The hover delay: Atlas's tooltip delay (index.css `--ds-tooltip-delay`, 300 ms). */
export const TOOLTIP_DELAY_MS = 300;
/** After one tooltip closes, another opens at once within this window (Radix skip-delay). */
export const TOOLTIP_SKIP_DELAY_MS = 300;
/** How long a finger rests on the trigger before its tooltip shows (the platforms' long press). */
export const TOOLTIP_LONG_PRESS_MS = 500;
/** How long a long-pressed tooltip stays after the finger lifts. */
export const TOOLTIP_TOUCH_HOLD_MS = 1500;
/** A finger that travels this far is scrolling, not pressing. */
const PRESS_SLOP_PX = 10;

/** The panel's shape and type (INVERSE_SURFACE is added at render: its hand-written class lives in index.css). */
export const TOOLTIP_PANEL = `${Z.tooltip} w-fit max-w-[min(20rem,calc(100vw-1rem))] rounded-[var(--ds-radius-control,8px)] px-3 py-1.5 text-xs leading-4 text-balance [overflow-wrap:anywhere] origin-[var(--radix-tooltip-content-transform-origin)]`;
/** The arrow takes the panel's ink (the inverse surface restates it in the dark skin). */
export const TOOLTIP_ARROW = 'fill-[var(--ds-ink)]';

const InProvider = /* @__PURE__ */ createContext(false);
const PressContext = /* @__PURE__ */ createContext<((open: boolean) => void) | null>(null);

export type TooltipProviderProps = React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Provider>;

/** Shares the delay and skip-delay across the tooltips inside it. */
export function TooltipProvider({ delayDuration = TOOLTIP_DELAY_MS, skipDelayDuration = TOOLTIP_SKIP_DELAY_MS, ...props }: TooltipProviderProps) {
  return (
    <InProvider.Provider value>
      <TooltipPrimitive.Provider delayDuration={delayDuration} skipDelayDuration={skipDelayDuration} {...props} />
    </InProvider.Provider>
  );
}

export type TooltipProps = React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Root>;

/** One tooltip (its trigger and content inside). Controlled with `open` / `onOpenChange`, or on its own. */
export function Tooltip({ open: openProp, defaultOpen = false, onOpenChange, ...props }: TooltipProps) {
  const inProvider = useContext(InProvider);
  const [ownOpen, setOwnOpen] = useState(defaultOpen);
  const controlled = openProp !== undefined;
  const open = controlled ? openProp : ownOpen;
  const onChangeRef = useRef(onOpenChange);
  onChangeRef.current = onOpenChange;
  const setOpen = useCallback(
    (next: boolean) => {
      if (!controlled) setOwnOpen(next);
      onChangeRef.current?.(next);
    },
    [controlled]
  );
  const root = <TooltipPrimitive.Root open={open} onOpenChange={setOpen} {...props} />;
  return <PressContext.Provider value={setOpen}>{inProvider ? root : <TooltipProvider>{root}</TooltipProvider>}</PressContext.Provider>;
}

/** The trigger (usually `asChild` around a button). Adds the long-press path for touch. */
export const TooltipTrigger = /* @__PURE__ */ React.forwardRef<
  React.ElementRef<typeof TooltipPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Trigger>
>(function TooltipTrigger({ onPointerDown, onPointerMove, onPointerUp, onPointerCancel, onContextMenu, onClickCapture, ...props }, ref) {
  const setOpen = useContext(PressContext);
  const press = useRef<{ timer: number; x: number; y: number } | null>(null);
  const shownByPress = useRef(false);
  const holdTimer = useRef(0);
  const cancelPress = () => {
    if (!press.current) return;
    window.clearTimeout(press.current.timer);
    press.current = null;
  };
  useEffect(
    () => () => {
      if (press.current) window.clearTimeout(press.current.timer);
      window.clearTimeout(holdTimer.current);
    },
    []
  );
  return (
    <TooltipPrimitive.Trigger
      ref={ref}
      data-slot="tooltip-trigger"
      {...props}
      onPointerDown={(event) => {
        onPointerDown?.(event);
        // A new press starts clean: a tap after a long press is an ordinary tap again.
        shownByPress.current = false;
        if (event.pointerType !== 'touch' || !setOpen) return;
        cancelPress();
        window.clearTimeout(holdTimer.current);
        const { clientX: x, clientY: y } = event;
        press.current = {
          x,
          y,
          timer: window.setTimeout(() => {
            press.current = null;
            shownByPress.current = true;
            setOpen(true);
          }, TOOLTIP_LONG_PRESS_MS)
        };
      }}
      onPointerMove={(event) => {
        onPointerMove?.(event);
        const at = press.current;
        if (at && Math.hypot(event.clientX - at.x, event.clientY - at.y) > PRESS_SLOP_PX) cancelPress();
      }}
      onPointerUp={(event) => {
        onPointerUp?.(event);
        cancelPress();
        if (shownByPress.current && setOpen) holdTimer.current = window.setTimeout(() => setOpen(false), TOOLTIP_TOUCH_HOLD_MS);
      }}
      onPointerCancel={(event) => {
        onPointerCancel?.(event);
        cancelPress();
      }}
      onContextMenu={(event) => {
        onContextMenu?.(event);
        // The long press showed the tooltip: no system menu on top of it.
        if (shownByPress.current) event.preventDefault();
      }}
      onClickCapture={(event) => {
        onClickCapture?.(event);
        // The long press was for the tooltip, not the control: its click never reaches the button.
        if (!shownByPress.current) return;
        shownByPress.current = false;
        event.preventDefault();
        event.stopPropagation();
      }}
    />
  );
});

/** The label: portalled, inverted ink, with an arrow; enters with a fade (none under reduced motion). */
export const TooltipContent = /* @__PURE__ */ React.forwardRef<
  React.ElementRef<typeof TooltipPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>
>(function TooltipContent({ className, sideOffset = 6, collisionPadding = 8, children, ...props }, ref) {
  const reduce = useReducedMotion();
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        ref={ref}
        data-slot="tooltip-content"
        sideOffset={sideOffset}
        collisionPadding={collisionPadding}
        className={cn(INVERSE_SURFACE, TOOLTIP_PANEL, reduce ? '' : 'ds-fade-in', className)}
        {...props}
      >
        {children}
        <TooltipPrimitive.Arrow className={TOOLTIP_ARROW} width={10} height={5} />
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  );
});
