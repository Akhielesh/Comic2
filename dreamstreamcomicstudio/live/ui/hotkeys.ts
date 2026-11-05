/**
 * Keyboard guards for Stream Studio.
 *
 * Studio hotkeys are single keys that end streams, toggle the mic and cut scenes, so one
 * may only act on a plain key press aimed at the studio itself — never on:
 *  - a browser or OS shortcut: ⌘/Ctrl/Alt + key (⌘G is Find next, Ctrl+R reload, ⌘V paste,
 *    AltGr and ⌥ type characters). Shift alone is fine: Shift+G is still G.
 *  - a held-down key's auto-repeat (one press, one action);
 *  - a keystroke an IME is still composing (Japanese, Chinese, Korean… input);
 *  - typing in a field or a rich-text editor;
 *  - a key another handler already claimed (`preventDefault`).
 *
 * `isImeComposing` is the same composition test for every "Enter submits" field: the Enter
 * that confirms an IME candidate must pick the word, not send a half-typed message.
 */

/** The keyboard-event fields the guards read: a DOM KeyboardEvent, or a plain stand-in. */
export type HotkeyEventLike = Partial<
  Pick<KeyboardEvent, 'metaKey' | 'ctrlKey' | 'altKey' | 'repeat' | 'isComposing' | 'keyCode' | 'defaultPrevented' | 'target'>
>;

/** A DOM or React keyboard event (React keeps `isComposing` on `nativeEvent`). */
export interface ComposingEventLike {
  isComposing?: boolean;
  keyCode?: number;
  nativeEvent?: { isComposing?: boolean };
}

/**
 * True while an IME is composing this keystroke. `keyCode` 229 covers the browsers that
 * report the composition-ending Enter after `compositionend` (Safari) or never set
 * `isComposing` (older Chromium / Android keyboards).
 */
export function isImeComposing(e: ComposingEventLike): boolean {
  return !!(e.isComposing || e.nativeEvent?.isComposing || e.keyCode === 229);
}

const asElement = (target: EventTarget | null | undefined): Element | null =>
  target && typeof (target as Element).closest === 'function' ? (target as Element) : null;

/** A text field, a select, or anything inside a contentEditable region. */
export function isEditableTarget(target: EventTarget | null | undefined): boolean {
  const el = asElement(target);
  if (!el) return false;
  const tag = el.tagName.toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
  if ((el as HTMLElement).isContentEditable) return true;
  // Read the attribute too: the nearest `contenteditable` decides (an inner "false" island is
  // not editable), and isContentEditable is not computed everywhere (jsdom, detached nodes).
  const host = el.closest('[contenteditable]');
  return !!host && host.getAttribute('contenteditable')?.trim().toLowerCase() !== 'false';
}

/** Controls whose own activation key is Space: pressing Space there must only activate them. */
const SPACE_ACTIVATES = [
  'button',
  'a[href]',
  'summary',
  ...['button', 'link', 'switch', 'checkbox', 'radio', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab', 'option'].map(
    (r) => `[role="${r}"]`,
  ),
].join(', ');

/** The focused element is a button, link, toggle, tab, menu item or <summary>. */
export function isSpaceActivatable(target: EventTarget | null | undefined): boolean {
  return !!asElement(target)?.closest(SPACE_ACTIVATES);
}

/*
 * How the focused control got focus. Chrome and Edge everywhere, and Firefox on Windows and
 * Linux, leave focus on a <button> after a mouse click, so "a button has focus" doesn't mean
 * the host is driving the page by keyboard: after clicking Record, Space must still mute the
 * mic, not press Record again. Only a control reached by the keyboard (Tab, arrow keys, or
 * focus moved right after a keystroke) gets Space as its own press. `:focus-visible` can't
 * tell the two apart: Chromium turns it on at the Space keydown itself.
 */
let lastInputKeyboard = false;
let keyboardFocused: EventTarget | null = null;
let focusWatchers = 0;

const onAnyKeyDown = (e: KeyboardEvent) => {
  // ⌘/Ctrl/Alt chords (⌘Tab, Ctrl+L, Alt+Tab) are the browser or OS, not the host moving focus here.
  if (!e.metaKey && !e.ctrlKey && !e.altKey) lastInputKeyboard = true;
};
const onAnyPointerDown = () => {
  lastInputKeyboard = false;
  // Clicking the control that already has focus fires no focusin: it's a clicked control now.
  keyboardFocused = null;
};
const onAnyFocusIn = (e: FocusEvent) => {
  keyboardFocused = lastInputKeyboard ? e.target : null;
};
const FOCUS_EVENTS: [string, EventListener][] = [
  ['keydown', onAnyKeyDown as EventListener],
  ['pointerdown', onAnyPointerDown],
  ['mousedown', onAnyPointerDown],
  ['focusin', onAnyFocusIn as EventListener],
];

/**
 * Start telling keyboard focus from pointer focus (see above) for as long as a hotkey surface is
 * mounted; returns the stop function, so it drops straight into a `useEffect`. Counted, so two
 * surfaces can share it.
 */
export function watchFocusOrigin(win: Window | null = typeof window === 'undefined' ? null : window): () => void {
  if (!win) return () => undefined;
  if (focusWatchers++ === 0) for (const [type, fn] of FOCUS_EVENTS) win.addEventListener(type, fn, true);
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    if (--focusWatchers > 0) return;
    for (const [type, fn] of FOCUS_EVENTS) win.removeEventListener(type, fn, true);
    lastInputKeyboard = false;
    keyboardFocused = null;
  };
}

/** Did the keyboard put focus on this element (rather than a click or tap)? Needs `watchFocusOrigin`. */
export function focusedByKeyboard(target: EventTarget | null | undefined): boolean {
  return !!target && target === keyboardFocused;
}

/**
 * Space here is the focused control's own press (a button, toggle or tab the host reached by
 * keyboard), not the studio's mute hotkey.
 */
export function spaceBelongsToControl(target: EventTarget | null | undefined): boolean {
  return isSpaceActivatable(target) && focusedByKeyboard(target);
}

/**
 * Some modal sheet or dialog is open over the page. Every live/** sheet and full-screen
 * surface sets aria-modal (the call ring and call screen included; the call's floating
 * mini window doesn't, so the studio still answers its keys).
 */
export function isModalOpen(doc: Document | null = typeof document === 'undefined' ? null : document): boolean {
  return !!doc?.querySelector('[aria-modal="true"]');
}

/** May a single-key studio hotkey act on this keydown? (See the rules at the top.) */
export function shouldHandleStudioHotkey(e: HotkeyEventLike): boolean {
  if (e.defaultPrevented) return false;
  if (e.metaKey || e.ctrlKey || e.altKey) return false;
  if (e.repeat) return false;
  if (isImeComposing(e)) return false;
  return !isEditableTarget(e.target);
}
