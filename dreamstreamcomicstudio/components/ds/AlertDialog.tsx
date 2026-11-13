/**
 * AlertDialog — Atlas `ui-generated/alert-dialog.tsx` on Radix (`@radix-ui/react-alert-dialog`) and the dialog
 * surfaces of ./Dialog (the same scrim, panel, title and entrance). It is the app's confirm step: it replaces
 * `window.confirm` as each surface moves onto the design system (redesign plan §4; no caller moves in DS-1c).
 *
 * Radix supplies the behaviour: it is modal (focus trapped, the page behind hidden and still), a press on the scrim
 * does NOT close it (the person answers the question), and focus starts on Cancel, so Enter never confirms a
 * destructive step by accident; on close focus goes back to whatever opened it. Like the Dialog it is the top layer
 * while open (./overlayLayer): Esc cancels it and nothing beneath it, the sheet that opened it stands down (a press
 * on an answer never reads as a press outside the sheet), and the back gesture cancels it first. The confirm button is
 * `AlertDialogAction`: `variant="destructive"` paints it with DANGER_FILL (the Button's destructive variant, the label
 * on `--ds-on-danger`), and its words say what happens ("Delete page"), never "OK". Both buttons are 44 px tall under
 * a coarse pointer.
 */
import React from 'react';
import * as AlertDialogPrimitive from '@radix-ui/react-alert-dialog';
import { cn } from '../../lib/utils';
import { buttonClasses, labelChildren } from './Button';
import { DIALOG_DESCRIPTION, DIALOG_FOOTER, DIALOG_HEADER, DIALOG_PANEL, DIALOG_SCRIM, DIALOG_SIZE, DIALOG_TITLE_CLASSES, dialogMotion, type DialogSize } from './Dialog';
import { NO_OVERLAY, useOpenState, useOverlayLayer, type OverlayState } from './overlayLayer';
import { useReducedMotion } from './useReducedMotion';
import { useBackLayer } from '../comicstudio/mobile/backStack';

export type AlertDialogActionVariant = 'default' | 'destructive';

/** The alert panel's header has no close button to leave room for. */
export const ALERT_DIALOG_HEADER = 'pr-0';

const AlertDialogState = /* @__PURE__ */ React.createContext<OverlayState>(NO_OVERLAY);

export type AlertDialogProps = React.ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Root>;

/** The confirm step's root: open with `open` + `onOpenChange`, or on its own (`defaultOpen`). */
export function AlertDialog({ open, defaultOpen, onOpenChange, ...props }: AlertDialogProps): React.ReactElement {
  const [isOpen, setOpen] = useOpenState(open, defaultOpen, onOpenChange);
  const state = React.useMemo(() => ({ open: isOpen, setOpen }), [isOpen, setOpen]);
  return (
    <AlertDialogState.Provider value={state}>
      <AlertDialogPrimitive.Root {...props} open={isOpen} onOpenChange={setOpen} />
    </AlertDialogState.Provider>
  );
}

export const AlertDialogTrigger = /* @__PURE__ */ React.forwardRef<
  React.ElementRef<typeof AlertDialogPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Trigger>
>(function AlertDialogTrigger(props, ref) {
  return <AlertDialogPrimitive.Trigger ref={ref} data-slot="alert-dialog-trigger" {...props} />;
});

export interface AlertDialogContentProps extends React.ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Content> {
  /** sm (384 px, the default for a question) or the Dialog widths. */
  size?: DialogSize;
  scrimClassName?: string;
}

export const AlertDialogContent = /* @__PURE__ */ React.forwardRef<React.ElementRef<typeof AlertDialogPrimitive.Content>, AlertDialogContentProps>(
  function AlertDialogContent({ className, size = 'sm', scrimClassName, onEscapeKeyDown, ...props }, ref) {
    const motion = dialogMotion(useReducedMotion());
    const { open, setOpen } = React.useContext(AlertDialogState);
    const cancel = React.useCallback(() => setOpen(false), [setOpen]);
    useOverlayLayer(open, cancel, { onEscapeKeyDown });
    useBackLayer(open, cancel, 'ds-alert-dialog');
    return (
      <AlertDialogPrimitive.Portal>
        <AlertDialogPrimitive.Overlay data-slot="alert-dialog-scrim" className={cn(DIALOG_SCRIM, motion.scrim, scrimClassName)}>
          <AlertDialogPrimitive.Content
            ref={ref}
            data-slot="alert-dialog-content"
            className={cn(DIALOG_PANEL, DIALOG_SIZE[size], motion.panel, className)}
            onEscapeKeyDown={onEscapeKeyDown}
            {...props}
          />
        </AlertDialogPrimitive.Overlay>
      </AlertDialogPrimitive.Portal>
    );
  }
);

export function AlertDialogHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div data-slot="alert-dialog-header" className={cn(DIALOG_HEADER, ALERT_DIALOG_HEADER, className)} {...props} />;
}

export function AlertDialogFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div data-slot="alert-dialog-footer" className={cn(DIALOG_FOOTER, className)} {...props} />;
}

export const AlertDialogTitle = /* @__PURE__ */ React.forwardRef<
  React.ElementRef<typeof AlertDialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Title>
>(function AlertDialogTitle({ className, ...props }, ref) {
  return <AlertDialogPrimitive.Title ref={ref} data-slot="alert-dialog-title" className={cn(DIALOG_TITLE_CLASSES, className)} {...props} />;
});

export const AlertDialogDescription = /* @__PURE__ */ React.forwardRef<
  React.ElementRef<typeof AlertDialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Description>
>(function AlertDialogDescription({ className, ...props }, ref) {
  return <AlertDialogPrimitive.Description ref={ref} data-slot="alert-dialog-description" className={cn(DIALOG_DESCRIPTION, className)} {...props} />;
});

export interface AlertDialogActionProps extends React.ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Action> {
  /** `destructive` for a step that removes or replaces something (DANGER_FILL). */
  variant?: AlertDialogActionVariant;
}

/** The confirm button: closes the dialog after its onClick (call `event.preventDefault()` there to keep it open). */
export const AlertDialogAction = /* @__PURE__ */ React.forwardRef<React.ElementRef<typeof AlertDialogPrimitive.Action>, AlertDialogActionProps>(
  function AlertDialogAction({ className, variant = 'default', children, ...props }, ref) {
    return (
      <AlertDialogPrimitive.Action
        ref={ref}
        data-slot="alert-dialog-action"
        data-variant={variant}
        className={buttonClasses({ variant, className })}
        {...props}
      >
        {labelChildren(children)}
      </AlertDialogPrimitive.Action>
    );
  }
);

/** Cancel: the outline button, focused when the dialog opens. */
export const AlertDialogCancel = /* @__PURE__ */ React.forwardRef<
  React.ElementRef<typeof AlertDialogPrimitive.Cancel>,
  React.ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Cancel>
>(function AlertDialogCancel({ className, children, ...props }, ref) {
  return (
    <AlertDialogPrimitive.Cancel ref={ref} data-slot="alert-dialog-cancel" className={buttonClasses({ variant: 'outline', className })} {...props}>
      {labelChildren(children)}
    </AlertDialogPrimitive.Cancel>
  );
});
