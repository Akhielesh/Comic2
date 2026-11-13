/**
 * The overlays inside the studio's sheets (./overlayLayer). On phones the sheets are where menus, confirm dialogs and
 * popovers open, and Radix portals each overlay to <body>, outside the sheet. An open overlay is the top layer:
 * - it is drawn above the sheet (the dialog layer is above Z.sheet; menus, popovers and tooltips too);
 * - Esc closes the overlay and nothing beneath it, then the next Esc closes the sheet;
 * - a press inside the overlay never reads as a press outside the sheet (PopSheet closes on one): a menu row is
 *   chosen, an AlertDialog's answer lands, a popover's control works, and the sheet stays open;
 * - Tab inside a dialog loops inside the dialog, never pulled back into a modal sheet's focus trap;
 * - the back gesture closes the dialog before the sheet.
 * Each case fails without the layer (the sheet acting on the overlay's events) or without the dialog layer.
 */
import React, { useState } from 'react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from './Dialog';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogTitle, AlertDialogTrigger } from './AlertDialog';
import { Menu, MenuContent, MenuItem, MenuTrigger } from './Menu';
import { Popover, PopoverContent, PopoverTrigger } from './Popover';
import { Tooltip, TooltipContent, TooltipTrigger } from './Tooltip';
import { Button } from './Button';
import { openOverlayLayers } from './overlayLayer';
import { BottomSheet } from '../comicstudio/mobile/sheets/BottomSheet';
import { PopSheet } from '../comicstudio/conversation/PopSheet';
import { FormFactorProvider, formFactorFor } from '../comicstudio/mobile/useFormFactor';
import { openLayers, resetBackStack } from '../comicstudio/mobile/backStack';

const PHONE = formFactorFor({ w: 390, h: 844, coarse: true });

let entryNo = 0;
beforeEach(() => {
  resetBackStack();
  entryNo += 1;
  window.history.pushState({ overlaysInSheets: entryNo }, '');
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
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
  resetBackStack();
  vi.unstubAllGlobals();
});

const flush = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));
const back = () =>
  act(async () => {
    window.history.back();
    await new Promise((r) => setTimeout(r, 40));
  });
const esc = () => fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
/** A whole tap: down, up, click (a sheet that closes on an outside press acts on the down). */
const tap = (el: Element) => {
  fireEvent.pointerDown(el, { pointerType: 'touch', button: 0 });
  fireEvent.pointerUp(el, { pointerType: 'touch', button: 0 });
  fireEvent.click(el);
};

/** A modal phone bottom sheet (its own Esc, focus trap and back layer), open until it closes itself. */
function PhoneSheet({ children, onClose }: { children: React.ReactNode; onClose?: () => void }) {
  const [open, setOpen] = useState(true);
  return (
    <FormFactorProvider value={PHONE}>
      <BottomSheet
        open={open}
        onClose={() => {
          onClose?.();
          setOpen(false);
        }}
        label="Page 3"
      >
        {children}
      </BottomSheet>
    </FormFactorProvider>
  );
}

/** An anchored PopSheet, which also closes on a press outside itself. */
function Pop({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div style={{ position: 'relative' }}>
      <PopSheet open onClose={onClose} label="Page tools">
        {children}
      </PopSheet>
    </div>
  );
}

function PageMenu({ onSelect }: { onSelect: (what: string) => void }) {
  return (
    <Menu>
      <MenuTrigger asChild>
        <Button variant="outline">Page actions</Button>
      </MenuTrigger>
      <MenuContent>
        <MenuItem onSelect={() => onSelect('rename')}>Rename</MenuItem>
        <MenuItem onSelect={() => onSelect('delete')}>Delete page</MenuItem>
      </MenuContent>
    </Menu>
  );
}

function Confirm({ onDelete }: { onDelete: () => void }) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="outline">Delete page 3</Button>
      </AlertDialogTrigger>
      <AlertDialogContent aria-describedby={undefined}>
        <AlertDialogTitle>Delete page 3?</AlertDialogTitle>
        <AlertDialogCancel>Keep it</AlertDialogCancel>
        <AlertDialogAction variant="destructive" onClick={onDelete}>
          Delete page
        </AlertDialogAction>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function Details() {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="outline">Comic details</Button>
      </DialogTrigger>
      <DialogContent aria-describedby={undefined}>
        <DialogTitle>Comic details</DialogTitle>
        <input aria-label="Title" defaultValue="Spice Market" />
      </DialogContent>
    </Dialog>
  );
}

/** The phone sheet (by its element: a modal overlay hides it from assistive tech while open, but it is still there). */
const sheet = () => document.querySelector<HTMLElement>('[data-sheet="bottom"]');
const openMenu = () => {
  const trigger = screen.getByRole('button', { name: 'Page actions' });
  trigger.focus();
  fireEvent.keyDown(trigger, { key: 'Enter' });
  return screen.getByRole('menu');
};

describe('drawn above the sheet', () => {
  const css = readFileSync(path.join(process.cwd(), 'index.css'), 'utf8');
  /** A --ds-z-* step as index.css defines it (every skin block repeats the :root ladder). */
  const zToken = (name: string) => {
    const values = [...css.matchAll(new RegExp(`${name}:\\s*(\\d+)\\s*;`, 'g'))].map((m) => Number(m[1]));
    expect(values.length, name).toBeGreaterThan(0);
    expect(new Set(values).size, `${name} has one value`).toBe(1);
    return values[0];
  };
  /** The z-index an element's z class resolves to (a literal step or a --ds-z-* token from index.css). */
  const zOf = (el: Element): number => {
    const cls = Array.from(el.classList).find((c) => /^z-\[/.test(c));
    expect(cls, `<${el.tagName.toLowerCase()} class="${el.className}"> has a z class`).toBeTruthy();
    const inner = cls!.slice(2).replace(/^\[|\]$/g, '');
    const token = /^var\((--[\w-]+)\)$/.exec(inner);
    const value = token ? zToken(token[1]) : Number(inner);
    expect(Number.isFinite(value)).toBe(true);
    return value;
  };

  it('a Dialog’s and an AlertDialog’s scrim sit above a BottomSheet and its scrim; a menu above too', () => {
    render(
      <PhoneSheet>
        <Details />
        <Confirm onDelete={() => undefined} />
        <PageMenu onSelect={() => undefined} />
      </PhoneSheet>
    );
    const bottom = document.querySelector('[data-sheet="bottom"]')!;
    const sheetScrim = document.querySelector('[data-sheet-scrim]')!;
    fireEvent.click(screen.getByRole('button', { name: 'Comic details' }));
    const dialogScrim = document.querySelector('[data-slot="dialog-scrim"]')!;
    expect(zOf(dialogScrim)).toBeGreaterThan(zOf(bottom));
    expect(zOf(dialogScrim)).toBeGreaterThan(zOf(sheetScrim));
    esc();
    fireEvent.click(screen.getByRole('button', { name: 'Delete page 3' }));
    expect(zOf(document.querySelector('[data-slot="alert-dialog-scrim"]')!)).toBeGreaterThan(zOf(bottom));
    esc();
    expect(zOf(openMenu())).toBeGreaterThan(zOf(bottom));
  });
});

describe('a Menu inside a sheet', () => {
  it('Esc closes the menu and leaves the sheet open; the next Esc closes the sheet', () => {
    const onClose = vi.fn();
    render(
      <PhoneSheet onClose={onClose}>
        <PageMenu onSelect={() => undefined} />
      </PhoneSheet>
    );
    openMenu();
    expect(openOverlayLayers()).toBe(1);
    esc();
    expect(screen.queryByRole('menu')).toBeNull();
    expect(sheet()).not.toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    expect(openOverlayLayers()).toBe(0);
    esc();
    expect(sheet()).toBeNull();
  });

  it('a tapped row is chosen and the PopSheet that opened the menu stays open', () => {
    const onClose = vi.fn();
    const onSelect = vi.fn();
    render(
      <Pop onClose={onClose}>
        <PageMenu onSelect={onSelect} />
      </Pop>
    );
    openMenu();
    tap(screen.getByRole('menuitem', { name: 'Rename' }));
    expect(onSelect).toHaveBeenCalledWith('rename');
    expect(onClose).not.toHaveBeenCalled();
    // With the menu gone the sheet acts again: a press outside it closes it.
    fireEvent.pointerDown(document.body);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('an AlertDialog inside a sheet', () => {
  it('a press on its answer lands and the PopSheet stays open (the delete runs)', () => {
    const onClose = vi.fn();
    const onDelete = vi.fn();
    render(
      <Pop onClose={onClose}>
        <Confirm onDelete={onDelete} />
      </Pop>
    );
    fireEvent.click(screen.getByRole('button', { name: 'Delete page 3' }));
    tap(screen.getByRole('button', { name: 'Delete page' }));
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('one open from the start (mounted together with its sheet) is still above it: its answer lands, the PopSheet stays', () => {
    const onClose = vi.fn();
    const onDelete = vi.fn();
    render(
      <Pop onClose={onClose}>
        <AlertDialog defaultOpen>
          <AlertDialogContent aria-describedby={undefined}>
            <AlertDialogTitle>Delete page 3?</AlertDialogTitle>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={onDelete}>
              Delete page
            </AlertDialogAction>
          </AlertDialogContent>
        </AlertDialog>
      </Pop>
    );
    tap(screen.getByRole('button', { name: 'Delete page' }));
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('Esc cancels the dialog only; the bottom sheet stays open until the next Esc', () => {
    const onDelete = vi.fn();
    render(
      <PhoneSheet>
        <Confirm onDelete={onDelete} />
      </PhoneSheet>
    );
    fireEvent.click(screen.getByRole('button', { name: 'Delete page 3' }));
    esc();
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(sheet()).not.toBeNull();
    esc();
    expect(sheet()).toBeNull();
    expect(onDelete).not.toHaveBeenCalled();
  });

  it('a caller that keeps it open on Esc keeps the sheet open as well', () => {
    render(
      <PhoneSheet>
        <AlertDialog defaultOpen>
          <AlertDialogContent aria-describedby={undefined} onEscapeKeyDown={(event) => event.preventDefault()}>
            <AlertDialogTitle>Deleting…</AlertDialogTitle>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
          </AlertDialogContent>
        </AlertDialog>
      </PhoneSheet>
    );
    esc();
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect(sheet()).not.toBeNull();
  });
});

describe('a Dialog inside a sheet', () => {
  it('Tab loops inside the dialog, never pulled back into the modal sheet’s focus trap', async () => {
    render(
      <PhoneSheet>
        <Details />
      </PhoneSheet>
    );
    fireEvent.click(screen.getByRole('button', { name: 'Comic details' }));
    await flush();
    const dialog = screen.getByRole('dialog', { name: 'Comic details' });
    const field = screen.getByRole('textbox', { name: 'Title' });
    const close = screen.getByRole('button', { name: 'Close' });
    act(() => close.focus());
    fireEvent.keyDown(close, { key: 'Tab' });
    expect(document.activeElement).toBe(field);
    fireEvent.keyDown(field, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(close);
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it('the back gesture closes the dialog, then the sheet', async () => {
    render(
      <PhoneSheet>
        <Details />
      </PhoneSheet>
    );
    fireEvent.click(screen.getByRole('button', { name: 'Comic details' }));
    expect(openLayers()).toEqual(['sheet:Page 3', 'ds-dialog']);
    await back();
    expect(screen.queryByRole('dialog', { name: 'Comic details' })).toBeNull();
    expect(sheet()).not.toBeNull();
    await back();
    expect(sheet()).toBeNull();
  });
});

describe('a Popover and a Tooltip inside a sheet', () => {
  it('a press on a popover control works and the PopSheet stays open; Esc closes the popover only', () => {
    const onClose = vi.fn();
    const onKids = vi.fn();
    render(
      <Pop onClose={onClose}>
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="outline">Filters</Button>
          </PopoverTrigger>
          <PopoverContent aria-label="Filters">
            <label>
              Kids only <input type="checkbox" onChange={onKids} />
            </label>
          </PopoverContent>
        </Popover>
      </Pop>
    );
    fireEvent.click(screen.getByRole('button', { name: 'Filters' }));
    tap(screen.getByRole('checkbox', { name: 'Kids only' }));
    expect(onKids).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    esc();
    expect(screen.queryByRole('dialog', { name: 'Filters' })).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('Esc with a tooltip showing closes the tooltip only; the sheet stays open', () => {
    render(
      <PhoneSheet>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="outline">Share</Button>
          </TooltipTrigger>
          <TooltipContent>Share a read-only link</TooltipContent>
        </Tooltip>
      </PhoneSheet>
    );
    act(() => screen.getByRole('button', { name: 'Share' }).focus());
    expect(screen.getByRole('tooltip')).toBeInTheDocument();
    esc();
    expect(screen.queryByRole('tooltip')).toBeNull();
    expect(sheet()).not.toBeNull();
    esc();
    expect(sheet()).toBeNull();
  });
});
