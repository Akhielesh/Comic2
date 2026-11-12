/**
 * Dialog and AlertDialog (Radix, lead decision D6): the Atlas classes on the tokens (SCRIM on the dialog layer above
 * the sheets, OVERLAY, DIALOG_TITLE), the modal keyboard contract (focus moves in and is trapped, Tab loops, Esc closes
 * and focus returns to the trigger, the page behind is hidden from assistive tech; a caller's onEscapeKeyDown can keep
 * it open), always modal, the back gesture closing it first, AlertDialog's destructive action on DANGER_FILL, Cancel
 * focused first and a real press on its scrim leaving it open (where the same press closes a Dialog), 44 px controls
 * under a coarse pointer, and no entrance animation under reduced motion. Inside a sheet: overlays.sheets.test.tsx.
 */
import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DIALOG_LAYER,
  DIALOG_PANEL,
  DIALOG_SCRIM,
  DIALOG_SIZE,
  DIALOG_TITLE_CLASSES
} from './Dialog';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from './AlertDialog';
import { Button } from './Button';
import { DIALOG_TITLE, OVERLAY, SCRIM } from '../chat/studioDesign';
import { DANGER_FILL, DENSITY, Z } from './recipes';
import { expectClasses } from './ds.testkit';
import { openLayers, resetBackStack } from '../comicstudio/mobile/backStack';
import { openOverlayLayers } from './overlayLayer';

let reducedMotion = false;
let entryNo = 0;
beforeEach(() => {
  reducedMotion = false;
  // Each test opens its dialogs from a history entry of its own (the back gesture's layers live in history.state).
  resetBackStack();
  entryNo += 1;
  window.history.pushState({ dialogTest: entryNo }, '');
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
  resetBackStack();
  vi.unstubAllGlobals();
});

function Example({ onSave }: { onSave?: () => void }) {
  return (
    <>
      <button type="button">Outside</button>
      <Dialog>
        <DialogTrigger asChild>
          <Button>Comic details</Button>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Comic details</DialogTitle>
            <DialogDescription>The title shows on the cover.</DialogDescription>
          </DialogHeader>
          <input aria-label="Title" defaultValue="Spice Market" />
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <Button onClick={onSave}>Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** Radix returns focus on close in a timer (FocusScope's unmount): let it run. */
const flush = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));

const openDialog = () => {
  fireEvent.click(screen.getByRole('button', { name: 'Comic details' }));
  return screen.getByRole('dialog', { name: 'Comic details' });
};

describe('Dialog', () => {
  it('renders the Atlas classes: SCRIM on the dialog layer, the OVERLAY panel, the DIALOG_TITLE heading', () => {
    render(<Example />);
    const dialog = openDialog();
    expectClasses(dialog, OVERLAY, DIALOG_PANEL, DIALOG_SIZE.default, 'ds-scale-in');
    const scrim = document.querySelector('[data-slot="dialog-scrim"]')!;
    // The dialog layer sits above the sheets (Z.sheet): Z.popover until --ds-z-dialog exists (a wave note).
    expect(DIALOG_LAYER).toBe(Z.popover);
    expectClasses(scrim, SCRIM, DIALOG_LAYER, DIALOG_SCRIM, 'ds-fade-in');
    expect(scrim.className).not.toContain(Z.scrim);
    expect(scrim.className).not.toContain(Z.sheet);
    expect(scrim.contains(dialog)).toBe(true); // the scrim centres the panel (a grid, no translate to fight the entrance)
    const title = screen.getByRole('heading', { level: 2, name: 'Comic details' });
    expectClasses(title, DIALOG_TITLE, DIALOG_TITLE_CLASSES);
    expect(dialog).toHaveAccessibleDescription('The title shows on the cover.');
    // Portalled to <body>, outside the tree that rendered it.
    expect(scrim.parentElement).toBe(document.body);
  });

  it('moves focus in, traps it (Tab loops; focus that escapes comes back) and hides the page behind', () => {
    render(<Example />);
    const dialog = openDialog();
    expect(dialog.contains(document.activeElement)).toBe(true);
    const close = screen.getByRole('button', { name: 'Close' });
    // The close button is the panel's last tabbable: Tab from it loops to the first.
    close.focus();
    fireEvent.keyDown(close, { key: 'Tab' });
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Title' }));
    const first = document.activeElement as HTMLElement;
    fireEvent.keyDown(first, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(close);
    // Focus moved outside programmatically is pulled back in.
    const outside = screen.getByText('Outside');
    act(() => outside.focus());
    expect(dialog.contains(document.activeElement)).toBe(true);
    // The page behind is hidden from assistive tech while the dialog is open.
    expect(outside.closest('[aria-hidden="true"]')).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'Outside' })).toBeNull();
  });

  it('Esc closes it and focus returns to the trigger; so does the close button', async () => {
    render(<Example />);
    const trigger = screen.getByRole('button', { name: 'Comic details' });
    const dialog = openDialog();
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    await flush();
    expect(document.activeElement).toBe(trigger);
    openDialog();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    await flush();
    expect(document.activeElement).toBe(trigger);
  });

  it('44 px under a coarse pointer: the close button is a 44 × 44 target', () => {
    render(<Example />);
    openDialog();
    const close = screen.getByRole('button', { name: 'Close' });
    expectClasses(close, DENSITY.coarseSquare);
    expect(close).not.toHaveAttribute('title'); // the name only, no native hover title
  });

  it('a caller’s onEscapeKeyDown runs first, and preventDefault there keeps the dialog open', () => {
    const onEscapeKeyDown = vi.fn((event: KeyboardEvent) => event.preventDefault());
    render(
      <Dialog defaultOpen>
        <DialogContent aria-describedby={undefined} onEscapeKeyDown={onEscapeKeyDown}>
          <DialogTitle>Saving</DialogTitle>
        </DialogContent>
      </Dialog>
    );
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onEscapeKeyDown).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('dialog', { name: 'Saving' })).toBeInTheDocument();
  });

  it('a controlled dialog follows open / onOpenChange, and tells onOpenChange once per change', () => {
    const onOpenChange = vi.fn();
    const { rerender } = render(
      <Dialog open onOpenChange={onOpenChange}>
        <DialogContent aria-describedby={undefined}>
          <DialogTitle>Controlled</DialogTitle>
        </DialogContent>
      </Dialog>
    );
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onOpenChange).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(screen.getByRole('dialog')).toBeInTheDocument(); // the caller decides
    rerender(
      <Dialog open={false} onOpenChange={onOpenChange}>
        <DialogContent aria-describedby={undefined}>
          <DialogTitle>Controlled</DialogTitle>
        </DialogContent>
      </Dialog>
    );
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(openOverlayLayers()).toBe(0);
  });

  it('is always modal: there is no modal prop, and modal={false} cannot make it render nothing', () => {
    // @ts-expect-error The Dialog is modal only (a non-modal panel is a Popover).
    const notModal = <Dialog defaultOpen modal={false}><DialogContent aria-describedby={undefined}><DialogTitle>Still modal</DialogTitle></DialogContent></Dialog>;
    render(
      <>
        <button type="button">Outside</button>
        {notModal}
      </>
    );
    const dialog = screen.getByRole('dialog', { name: 'Still modal' });
    expect(document.querySelector('[data-slot="dialog-scrim"]')!.contains(dialog)).toBe(true);
    expect(screen.getByText('Outside').closest('[aria-hidden="true"]')).not.toBeNull();
  });

  it('the back gesture closes the dialog first (a layer of the back stack while open)', async () => {
    render(<Example />);
    openDialog();
    expect(openLayers()).toEqual(['ds-dialog']);
    await act(async () => {
      window.history.back();
      await new Promise((r) => setTimeout(r, 40));
    });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(openLayers()).toEqual([]);
  });

  it('sizes: sm and lg; hideClose drops the corner button (Esc still closes)', () => {
    render(
      <Dialog defaultOpen>
        <DialogContent size="lg" hideClose aria-describedby={undefined}>
          <DialogTitle>Wide</DialogTitle>
        </DialogContent>
      </Dialog>
    );
    const dialog = screen.getByRole('dialog', { name: 'Wide' });
    expectClasses(dialog, DIALOG_SIZE.lg);
    expect(dialog.className).not.toContain(DIALOG_SIZE.default);
    expect(screen.queryByRole('button', { name: 'Close' })).toBeNull();
  });

  it('under reduced motion nothing animates: no entrance on the scrim or the panel', () => {
    reducedMotion = true;
    render(<Example />);
    const dialog = openDialog();
    expect(dialog.className).not.toContain('ds-scale-in');
    expect(document.querySelector('[data-slot="dialog-scrim"]')!.className).not.toContain('ds-fade-in');
  });
});

function Confirm({ onDelete }: { onDelete: () => void }) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="outline">Delete page 3</Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete page 3?</AlertDialogTitle>
          <AlertDialogDescription>It stays in Assets › Deleted for 30 days.</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep it</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={onDelete}>
            Delete page
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

describe('AlertDialog', () => {
  const open = () => {
    fireEvent.click(screen.getByRole('button', { name: 'Delete page 3' }));
    return screen.getByRole('alertdialog', { name: 'Delete page 3?' });
  };

  it('renders the dialog surfaces and the destructive action on DANGER_FILL; Cancel is the outline button', () => {
    render(<Confirm onDelete={() => undefined} />);
    const dialog = open();
    expectClasses(dialog, OVERLAY, DIALOG_PANEL, DIALOG_SIZE.sm);
    expectClasses(document.querySelector('[data-slot="alert-dialog-scrim"]')!, SCRIM, DIALOG_LAYER, DIALOG_SCRIM);
    expectClasses(screen.getByRole('heading', { level: 2, name: 'Delete page 3?' }), DIALOG_TITLE);
    expect(dialog).toHaveAccessibleDescription('It stays in Assets › Deleted for 30 days.');
    const action = screen.getByRole('button', { name: 'Delete page' });
    expectClasses(action, DANGER_FILL);
    expect(action).toHaveAttribute('data-variant', 'destructive');
    const cancel = screen.getByRole('button', { name: 'Keep it' });
    expect(cancel.className).not.toContain('bg-[var(--ds-danger)]');
    expectClasses(cancel, 'border-[var(--ds-hairline)]');
  });

  it('a default action is not a danger fill', () => {
    render(
      <AlertDialog defaultOpen>
        <AlertDialogContent aria-describedby={undefined}>
          <AlertDialogTitle>Publish now?</AlertDialogTitle>
          <AlertDialogAction>Publish</AlertDialogAction>
        </AlertDialogContent>
      </AlertDialog>
    );
    expect(screen.getByRole('button', { name: 'Publish' }).className).not.toContain('bg-[var(--ds-danger)]');
  });

  it('focus starts on Cancel (Enter never confirms by accident); the action confirms and closes; focus returns', async () => {
    const onDelete = vi.fn();
    render(<Confirm onDelete={onDelete} />);
    const trigger = screen.getByRole('button', { name: 'Delete page 3' });
    open();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Keep it' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete page' }));
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('alertdialog')).toBeNull();
    await flush();
    expect(document.activeElement).toBe(trigger);
  });

  /** A whole press on a scrim, once Radix has armed its outside-press listener (it does so in a timer). */
  const pressScrim = async (slot: string) => {
    await flush();
    const scrim = document.querySelector(`[data-slot="${slot}"]`)!;
    fireEvent.pointerDown(scrim, { pointerType: 'mouse', button: 0 });
    fireEvent.pointerUp(scrim, { pointerType: 'mouse', button: 0 });
    fireEvent.click(scrim);
  };

  it('the same whole press on the scrim closes a Dialog (the control for the next case)', async () => {
    render(<Example />);
    openDialog();
    await pressScrim('dialog-scrim');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('Esc cancels; a whole press on the scrim does not (the question waits for an answer)', async () => {
    const onDelete = vi.fn();
    render(<Confirm onDelete={onDelete} />);
    const dialog = open();
    await pressScrim('alert-dialog-scrim');
    expect(screen.getByRole('alertdialog')).toBe(dialog);
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(onDelete).not.toHaveBeenCalled();
  });

  it('the back gesture cancels it first', async () => {
    const onDelete = vi.fn();
    render(<Confirm onDelete={onDelete} />);
    open();
    expect(openLayers()).toEqual(['ds-alert-dialog']);
    await act(async () => {
      window.history.back();
      await new Promise((r) => setTimeout(r, 40));
    });
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(onDelete).not.toHaveBeenCalled();
  });

  it('44 px under a coarse pointer: both answers', () => {
    render(<Confirm onDelete={() => undefined} />);
    open();
    expectClasses(screen.getByRole('button', { name: 'Delete page' }), DENSITY.coarse);
    expectClasses(screen.getByRole('button', { name: 'Keep it' }), DENSITY.coarse);
  });

  it('under reduced motion nothing animates', () => {
    reducedMotion = true;
    render(<Confirm onDelete={() => undefined} />);
    const dialog = open();
    expect(dialog.className).not.toContain('ds-scale-in');
    expect(document.querySelector('[data-slot="alert-dialog-scrim"]')!.className).not.toContain('ds-fade-in');
  });
});
