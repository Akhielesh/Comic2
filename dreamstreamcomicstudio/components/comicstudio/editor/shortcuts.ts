// The Pro workspace's keyboard (master plan §2.7 "Tools" and "Shortcuts"; agent-editor plan §3 C1, C8). Pure: no DOM
// beyond reading an event's target, so every rule is unit-tested and the page editor, the tool rail and the
// shortcut sheet agree on one table.
//
//   Tools      V select · T text · B balloon · S sound effect · U shapes · M mark up · H hand · Z zoom
//              (E effects and A assets arrive with PE-ASSETS in S3, K stickers in S4, F frames with PE-FRAMES)
//   Selection  Tab / Shift+Tab: the next / previous balloon in reading order (wrapping); ⌘A / Ctrl+A: every balloon
//   View       Shift+P: Easy | Pro;  ?: the shortcut sheet (and the Pro tips again)
//   Kept       the balloon layer's own keys (⌘Z / ⇧⌘Z, ⌘D, [ ], L, Enter, Esc, arrows, R / Shift+R rotate 15°)
//
// Nothing here fires while typing (isEditableTarget): a field, a textarea, a select or contentEditable text keeps
// every key, so "Shift+P" in the Edit-with-AI box types a P.

import type { StudioSelection } from '../types';

export type ProTool = 'select' | 'text' | 'balloon' | 'sfx' | 'shapes' | 'markup' | 'hand' | 'zoom';

export interface ProToolSpec {
  id: ProTool;
  /** The single key that picks it (shown on the rail and in the sheet). */
  key: string;
  label: string;
  /** One line for the tooltip and the shortcut sheet. */
  hint: string;
  /** Adds lettering (off on in-art comics, IN_ART_LETTERING_NOTE). */
  letters?: boolean;
}

/** The rail, in order (master plan §2.7). */
export const PRO_TOOLS: readonly ProToolSpec[] = [
  { id: 'select', key: 'V', label: 'Select', hint: 'Select and move balloons' },
  { id: 'text', key: 'T', label: 'Text', hint: 'Click the page to add a caption', letters: true },
  { id: 'balloon', key: 'B', label: 'Balloon', hint: 'Click the page to add a speech balloon', letters: true },
  { id: 'sfx', key: 'S', label: 'Sound effect', hint: 'Click the page to add a sound effect', letters: true },
  { id: 'shapes', key: 'U', label: 'Shapes', hint: 'Click the page to add a rectangle' },
  { id: 'markup', key: 'M', label: 'Mark up', hint: 'Drag a box on the art to show the AI what to change' },
  { id: 'hand', key: 'H', label: 'Hand', hint: 'Drag to pan the page' },
  { id: 'zoom', key: 'Z', label: 'Zoom', hint: 'Zoom controls; pinch or Ctrl + scroll also zoom' }
];

export const toolSpec = (id: ProTool): ProToolSpec => PRO_TOOLS.find((t) => t.id === id) ?? PRO_TOOLS[0];

/** The line kind a lettering tool places (Text = a caption box, Balloon = speech, Sound effect = SFX). */
export const TOOL_LINE_KIND = { text: 'caption', balloon: 'speech', sfx: 'sfx' } as const;
export type LetteringTool = keyof typeof TOOL_LINE_KIND;
export const isLetteringTool = (t: ProTool): t is LetteringTool => t === 'text' || t === 'balloon' || t === 'sfx';

/** A field, a textarea, a select or editable text: keys there are typing, never shortcuts. */
export const isEditableTarget = (el: EventTarget | null): boolean => {
  if (!el || typeof (el as HTMLElement).tagName !== 'string') return false;
  const node = el as HTMLElement;
  const tag = node.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || node.isContentEditable === true;
};

/** What a key press asks the Pro shell for (null: not a shell shortcut, let it through). */
export type ShellShortcut =
  | { kind: 'tool'; tool: ProTool }
  | { kind: 'toggle-mode' }
  | { kind: 'help' }
  | { kind: 'cycle'; dir: 1 | -1 }
  | { kind: 'select-all' };

export interface KeyLike {
  key: string;
  shiftKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
  ctrlKey?: boolean;
  target?: EventTarget | null;
}

export interface ShortcutContext {
  /** COMIC_PRO_EDITOR_V2 is on (Shift+P and ? exist). */
  flag: boolean;
  /** The Pro view is showing (tools, Tab cycling and ⌘A). */
  pro: boolean;
  /** Tools the rail offers right now (a hidden or disabled tool's key does nothing). */
  tools: ReadonlySet<ProTool>;
}

const TOOL_BY_KEY: ReadonlyMap<string, ProTool> = new Map(PRO_TOOLS.map((t) => [t.key.toLowerCase(), t.id]));

/** The shell shortcut for a key press, or null. Pure. */
export function shellShortcut(e: KeyLike, ctx: ShortcutContext): ShellShortcut | null {
  if (!ctx.flag || isEditableTarget(e.target ?? null)) return null;
  const mod = !!(e.metaKey || e.ctrlKey);
  if (!mod && !e.altKey && e.shiftKey && (e.key === 'P' || e.key === 'p')) return { kind: 'toggle-mode' };
  if (!mod && !e.altKey && e.key === '?') return { kind: 'help' };
  if (!ctx.pro) return null;
  if (e.key === 'Tab' && !mod && !e.altKey) return { kind: 'cycle', dir: e.shiftKey ? -1 : 1 };
  if (mod && !e.altKey && !e.shiftKey && (e.key === 'a' || e.key === 'A')) return { kind: 'select-all' };
  if (mod || e.altKey || e.shiftKey) return null;
  const tool = TOOL_BY_KEY.get(e.key.toLowerCase());
  return tool && ctx.tools.has(tool) ? { kind: 'tool', tool } : null;
}

/** The next id in reading order from `current` (wrapping); the first (or last) when nothing is selected. */
export function cycleReadingOrder(order: readonly string[], current: string | undefined, dir: 1 | -1): string | undefined {
  if (!order.length) return undefined;
  const at = current ? order.indexOf(current) : -1;
  if (at < 0) return dir > 0 ? order[0] : order[order.length - 1];
  return order[(at + dir + order.length) % order.length];
}

/**
 * The arrow-key page turn's guard (graft 4): never turn the page while anything on it is selected — balloons
 * (lineIds), overlays (layerIds) or panels (panelIds). Arrows then nudge the selection instead.
 */
export const selectionHoldsArrows = (sel: Pick<StudioSelection, 'lineIds' | 'layerIds' | 'panelIds'> | null | undefined): boolean =>
  !!sel && ((sel.lineIds?.length ?? 0) > 0 || (sel.layerIds?.length ?? 0) > 0 || (sel.panelIds?.length ?? 0) > 0);

/** One row of the shortcut sheet. */
export interface ShortcutRow {
  keys: string;
  label: string;
}

/** The shortcut sheet (?), grouped. Only rows that work in this build are listed. */
export const SHORTCUT_SHEET: readonly { title: string; rows: readonly ShortcutRow[] }[] = [
  { title: 'Tools', rows: PRO_TOOLS.map((t) => ({ keys: t.key, label: t.label })) },
  {
    title: 'Selection',
    rows: [
      { keys: 'Tab / Shift+Tab', label: 'Next or previous balloon, in reading order' },
      { keys: '⌘A', label: 'Select every balloon on the page' },
      { keys: 'Shift+click', label: 'Add to the selection' },
      { keys: 'Esc', label: 'Clear the selection' }
    ]
  },
  {
    title: 'Balloons',
    rows: [
      { keys: 'Arrows', label: 'Nudge (Shift: bigger steps; Alt: the tail)' },
      { keys: 'R / Shift+R', label: 'Rotate 15° clockwise / back' },
      { keys: '[ ]', label: 'Send backward / bring forward (Shift: to back / front)' },
      { keys: '⌘D', label: 'Duplicate' },
      { keys: 'L', label: 'Lock or unlock' },
      { keys: 'Enter', label: 'Edit the text' },
      { keys: 'Delete', label: 'Delete' }
    ]
  },
  {
    title: 'Editor',
    rows: [
      { keys: '⌘Z / ⇧⌘Z', label: 'Undo / redo' },
      { keys: 'Shift+P', label: 'Switch Easy | Pro' },
      { keys: '← →', label: 'Previous / next page (nothing selected)' },
      { keys: '?', label: 'This sheet' }
    ]
  }
];
