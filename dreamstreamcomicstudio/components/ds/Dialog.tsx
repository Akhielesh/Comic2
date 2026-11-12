/**
 * Dialog — Atlas `ui-generated/dialog.tsx` on Radix (`@radix-ui/react-dialog`, lead decision D6) and the `--ds-*`
 * tokens (docs/design/design-system.md). Radix supplies the modal behaviour: focus moves into the panel and is trapped
 * there, Esc and a press on the scrim close it, focus goes back to whatever opened it, the page behind is hidden from
 * assistive tech and stops scrolling, and the title and description name and describe it.
 *
 * Mapped onto the recipes: the scrim is SCRIM (a dim, no blur) on the Z.scrim layer; the panel is OVERLAY (the raised
 * step, the overlay edge and shadow, the panel radius); the title is DIALOG_TITLE (20 px semibold in the body face,
 * the centred-modal title). The scrim centres the panel as a grid instead of a translate, so the entrance (the scrim's
 * `ds-fade-in`, the panel's `ds-scale-in`, both ending on `transform: none`) never fights a transform; neither runs
 * under reduced motion (the hook drops the classes and styles/ds-motion.css stops them too). A panel taller than the
 * screen scrolls inside itself. The close button is the 44 × 44 coarse IconButton.
 *
 * Use: <Dialog><DialogTrigger asChild><Button>Details</Button></DialogTrigger><DialogContent><DialogHeader>
 * <DialogTitle>…</DialogTitle><DialogDescription>…</DialogDescription></DialogHeader>…<DialogFooter>…</DialogFooter>
 * </DialogContent></Dialog>. Every dialog has a title; pass `aria-describedby={undefined}` to DialogContent when it
 * has no description.
 */
import React from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { cn } from '../../lib/utils';
// Not in components/ds/recipes.ts yet (a wave note adds them); from the single source.
import { DIALOG_TITLE, OVERLAY, SCRIM } from '../chat/studioDesign';
import { Z } from './recipes';
import { IconButton } from './IconButton';
import { useReducedMotion } from './useReducedMotion';

export type DialogSize = 'sm' | 'default' | 'lg';

/** The dim behind a modal, and the grid that centres its panel (scrolls when the panel is taller than the screen). */
export const DIALOG_SCRIM = `fixed inset-0 ${Z.scrim} ${SCRIM} grid place-items-center overflow-y-auto p-4`;
/** The panel: the overlay recipe, Atlas's padding and gap, a ceiling of the visible height (it scrolls itself). */
export const DIALOG_PANEL = `${OVERLAY} relative grid w-full min-w-0 gap-4 p-6 max-h-[calc(var(--app-h,100dvh)-2rem)] overflow-y-auto outline-none [overflow-wrap:anywhere]`;
export const DIALOG_SIZE: Record<DialogSize, string> = {
  sm: 'max-w-sm',
  default: 'max-w-lg',
  lg: 'max-w-2xl'
};
/** Title block: leaves room for the close button at the top right. */
export const DIALOG_HEADER = 'flex min-w-0 flex-col gap-2 pr-8 text-left';
/** Actions: stacked full width on phones (primary on top), a right-aligned row from `sm` up. */
export const DIALOG_FOOTER = 'flex flex-col-reverse gap-2 sm:flex-row sm:justify-end';
export const DIALOG_TITLE_CLASSES = `m-0 ${DIALOG_TITLE}`;
export const DIALOG_DESCRIPTION = 'm-0 text-[length:var(--ds-text-base)] leading-6 text-[var(--ds-muted)]';
export const DIALOG_CLOSE = 'absolute right-3 top-3 text-[var(--ds-muted)]';

/**
 * The entrance classes of the dialog surfaces (Dialog, AlertDialog): none under reduced motion. Both keyframes end on
 * `transform: none`; there is no exit animation, so a closing dialog leaves at once.
 */
export function dialogMotion(reduce: boolean): { scrim: string; panel: string } {
  return reduce ? { scrim: '', panel: '' } : { scrim: 'ds-fade-in', panel: 'ds-scale-in' };
}

export { Root as Dialog } from '@radix-ui/react-dialog';
export type DialogProps = React.ComponentPropsWithoutRef<typeof DialogPrimitive.Root>;

export const DialogTrigger = /* @__PURE__ */ React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Trigger>
>(function DialogTrigger(props, ref) {
  return <DialogPrimitive.Trigger ref={ref} data-slot="dialog-trigger" {...props} />;
});

export const DialogClose = /* @__PURE__ */ React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Close>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Close>
>(function DialogClose(props, ref) {
  return <DialogPrimitive.Close ref={ref} data-slot="dialog-close" {...props} />;
});

export interface DialogContentProps extends React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> {
  /** Width: sm 384 px, default 512 px (Atlas), lg 672 px; never wider than the screen less 2 rem. */
  size?: DialogSize;
  /** Hides the top-right close button (keep another way out: a Cancel in the footer; Esc always works). */
  hideClose?: boolean;
  /** The close button's name; "Close" by default. */
  closeLabel?: string;
  /** Classes for the scrim. */
  scrimClassName?: string;
}

export const DialogContent = /* @__PURE__ */ React.forwardRef<React.ElementRef<typeof DialogPrimitive.Content>, DialogContentProps>(function DialogContent(
  { className, children, size = 'default', hideClose = false, closeLabel = 'Close', scrimClassName, ...props },
  ref
) {
  const motion = dialogMotion(useReducedMotion());
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay data-slot="dialog-scrim" className={cn(DIALOG_SCRIM, motion.scrim, scrimClassName)}>
        <DialogPrimitive.Content ref={ref} data-slot="dialog-content" className={cn(DIALOG_PANEL, DIALOG_SIZE[size], motion.panel, className)} {...props}>
          {children}
          {hideClose ? null : (
            <DialogPrimitive.Close asChild>
              <IconButton label={closeLabel} title={null} size="sm" data-slot="dialog-close-button" className={DIALOG_CLOSE}>
                <X />
              </IconButton>
            </DialogPrimitive.Close>
          )}
        </DialogPrimitive.Content>
      </DialogPrimitive.Overlay>
    </DialogPrimitive.Portal>
  );
});

export function DialogHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div data-slot="dialog-header" className={cn(DIALOG_HEADER, className)} {...props} />;
}

export function DialogFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div data-slot="dialog-footer" className={cn(DIALOG_FOOTER, className)} {...props} />;
}

/** The dialog's name: an <h2> with DIALOG_TITLE (no colour of its own; the panel's ink). */
export const DialogTitle = /* @__PURE__ */ React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(function DialogTitle({ className, ...props }, ref) {
  return <DialogPrimitive.Title ref={ref} data-slot="dialog-title" className={cn(DIALOG_TITLE_CLASSES, className)} {...props} />;
});

export const DialogDescription = /* @__PURE__ */ React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(function DialogDescription({ className, ...props }, ref) {
  return <DialogPrimitive.Description ref={ref} data-slot="dialog-description" className={cn(DIALOG_DESCRIPTION, className)} {...props} />;
});
