/**
 * Popover — Atlas `ui-generated/popover.tsx` on Radix (`@radix-ui/react-popover`) and the `--ds-*` tokens: a small
 * non-modal panel anchored to its trigger (a filter, a quick setting, a "what is this" explanation with a link).
 *
 * Radix supplies the behaviour: the trigger toggles it (it reports `aria-expanded` and controls the panel); on open
 * focus moves into the panel, Tab leaves it, Esc or a press outside closes it and focus returns to the trigger. It is
 * portalled, flips to stay on screen and scrolls inside when the space left is short. Unlike a Tooltip it may hold
 * controls, and it never opens on hover, so it works the same on touch.
 *
 * Mapped onto the recipes: OVERLAY on the Z.popover layer (above sheets, below toasts and tooltips), Atlas's 288 px
 * width and 16 px padding, never wider than the screen; it enters with `ds-scale-in` from the trigger's side (none
 * under reduced motion).
 */
import React from 'react';
import * as PopoverPrimitive from '@radix-ui/react-popover';
import { cn } from '../../lib/utils';
// Not in components/ds/recipes.ts yet (a wave note adds it); from the single source.
import { OVERLAY } from '../chat/studioDesign';
import { Z } from './recipes';
import { useReducedMotion } from './useReducedMotion';

export const POPOVER_PANEL = `${OVERLAY} ${Z.popover} w-72 max-w-[calc(100vw-1rem)] max-h-[var(--radix-popover-content-available-height)] overflow-y-auto p-4 outline-none origin-[var(--radix-popover-content-transform-origin)] [overflow-wrap:anywhere]`;

export { Root as Popover, Anchor as PopoverAnchor } from '@radix-ui/react-popover';
export type PopoverProps = React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Root>;

export const PopoverTrigger = /* @__PURE__ */ React.forwardRef<
  React.ElementRef<typeof PopoverPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Trigger>
>(function PopoverTrigger(props, ref) {
  return <PopoverPrimitive.Trigger ref={ref} data-slot="popover-trigger" {...props} />;
});

export const PopoverClose = /* @__PURE__ */ React.forwardRef<
  React.ElementRef<typeof PopoverPrimitive.Close>,
  React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Close>
>(function PopoverClose(props, ref) {
  return <PopoverPrimitive.Close ref={ref} data-slot="popover-close" {...props} />;
});

export const PopoverContent = /* @__PURE__ */ React.forwardRef<
  React.ElementRef<typeof PopoverPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Content>
>(function PopoverContent({ className, align = 'center', sideOffset = 6, collisionPadding = 8, ...props }, ref) {
  const reduce = useReducedMotion();
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        ref={ref}
        data-slot="popover-content"
        align={align}
        sideOffset={sideOffset}
        collisionPadding={collisionPadding}
        className={cn(POPOVER_PANEL, reduce ? '' : 'ds-scale-in', className)}
        {...props}
      />
    </PopoverPrimitive.Portal>
  );
});
