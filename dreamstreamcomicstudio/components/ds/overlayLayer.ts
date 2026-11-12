/**
 * The overlay layer (DS-1c): what makes an open ds overlay (Dialog, AlertDialog, Menu, Popover, Tooltip) the top layer
 * of the app, above the studio's sheets (BottomSheet, SideSheet and PopSheet share `useSheetBehaviour`,
 * components/comicstudio/conversation/PopSheet.tsx) and other overlays. Radix portals each overlay to <body>, outside
 * the sheet that opened it, and the sheets listen on `document` in the capture phase while they are the top of their
 * stack; without this layer a press on a menu row or on a dialog's answer read as a press outside the sheet (closing
 * it, and the dialog with it), Esc closed the sheet instead of the overlay, and Tab inside a dialog was pulled back
 * into the sheet.
 *
 * - Esc belongs to the newest open overlay, and only to it. While any overlay is open one capture listener on
 *   `window` (it runs before every listener on `document`) hands the key to the top layer and stops it there, so
 *   neither the sheet beneath, an overlay beneath, nor the page acts on it too. The layer runs the caller's
 *   `onEscapeKeyDown` first (`event.preventDefault()` there keeps the overlay open, as with Radix) and otherwise
 *   closes the overlay. No listener exists while nothing is open.
 * - The sheets' stack. While an overlay that takes presses or focus is open (all but the Tooltip) it joins the sheets'
 *   stack as its top entry: `useSheetBehaviour` with every behaviour of its own off (no outside press, no focus trap,
 *   no autofocus; its Esc never fires, the window listener has the key first). A sheet acts only while it is the top
 *   of that stack, so the sheet beneath stands down until the overlay closes. The overlay joins one commit after it
 *   opens, so one that opens together with its sheet (a sheet mounted with an open confirm in it: children's effects
 *   run before their parent's) still lands above it; it leaves in the commit that closes it, while its content still
 *   holds focus, so the sheet hook's focus hand-back never runs (Radix gives focus back to the trigger).
 *
 * Each overlay root (Dialog, AlertDialog, Menu, Popover, Tooltip) owns its `open` state (`useOpenState`), so the
 * layer, the back gesture (Dialog, AlertDialog: useBackLayer) and a touch tap (Menu) can close or open it.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { useSheetBehaviour } from '../comicstudio/conversation/PopSheet';

interface Layer {
  escape(event: KeyboardEvent): void;
}

/** The open overlay layers, oldest first. */
const layers: Layer[] = [];

const onWindowKeyDown = (event: KeyboardEvent) => {
  if (event.key !== 'Escape') return;
  const top = layers[layers.length - 1];
  if (!top) return;
  // The key is the top overlay's: nothing beneath it (a sheet, an overlay under it, the page) acts on it as well.
  event.stopPropagation();
  top.escape(event);
};

function addLayer(layer: Layer): () => void {
  layers.push(layer);
  if (layers.length === 1) window.addEventListener('keydown', onWindowKeyDown, true);
  return () => {
    const at = layers.lastIndexOf(layer);
    if (at >= 0) layers.splice(at, 1);
    if (!layers.length) window.removeEventListener('keydown', onWindowKeyDown, true);
  };
}

/** How many overlay layers are open (tests and diagnostics). */
export const openOverlayLayers = (): number => layers.length;

const NO_SHEET: RefObject<HTMLElement | null> = { current: null };
const NOOP = () => undefined;
const JOIN_ONLY = { closeOnOutside: false, trapFocus: false, autoFocus: false };

export interface OverlayLayerOptions {
  /** The caller's `onEscapeKeyDown`: runs first; `event.preventDefault()` keeps the overlay open. */
  onEscapeKeyDown?: (event: KeyboardEvent) => void;
  /** Join the sheets' stack while open (default true; the Tooltip, which takes no press or focus, does not). */
  joinSheets?: boolean;
}

/**
 * Makes an overlay a layer while `open`: Esc closes it (`close`) before anything beneath sees the key, and the sheet
 * beneath stands down. Call it from the overlay's content component with the root's `open`.
 */
export function useOverlayLayer(open: boolean, close: () => void, { onEscapeKeyDown, joinSheets = true }: OverlayLayerOptions = {}): void {
  const latest = useRef({ close, onEscapeKeyDown });
  latest.current = { close, onEscapeKeyDown };
  useLayoutEffect(() => {
    if (!open || typeof window === 'undefined') return;
    return addLayer({
      escape(event) {
        latest.current.onEscapeKeyDown?.(event);
        if (event.defaultPrevented) return;
        event.preventDefault();
        latest.current.close();
      }
    });
  }, [open]);
  const join = open && joinSheets;
  const [joined, setJoined] = useState(false);
  useEffect(() => setJoined(join), [join]);
  useSheetBehaviour(join && joined, NOOP, NO_SHEET, undefined, JOIN_ONLY);
}

/**
 * An overlay root's open state, controlled (`open` + `onOpenChange`) or its own (`defaultOpen`). The setter tells
 * `onOpenChange` only when the value changes, however many paths ask for the same change in one event.
 */
export function useOpenState(open: boolean | undefined, defaultOpen: boolean | undefined, onOpenChange?: (open: boolean) => void): [boolean, (open: boolean) => void] {
  const [own, setOwn] = useState(defaultOpen ?? false);
  const controlled = open !== undefined;
  const value = controlled ? open : own;
  const current = useRef(value);
  current.current = value;
  const onChange = useRef(onOpenChange);
  onChange.current = onOpenChange;
  const setOpen = useCallback(
    (next: boolean) => {
      if (next === current.current) return;
      current.current = next;
      if (!controlled) setOwn(next);
      onChange.current?.(next);
    },
    [controlled]
  );
  return [value, setOpen];
}

/** What an overlay root hands its parts: whether it is open, and the setter. */
export interface OverlayState {
  open: boolean;
  setOpen(open: boolean): void;
}

/** The value a part reads outside its root: closed, and nothing to set. */
export const NO_OVERLAY: OverlayState = { open: false, setOpen: NOOP };
