// The Pro shell's key table core (master plan §2.7 "Tools" and "Shortcuts"; agent-editor plan §3 C1): the tool ids and
// their keys, the "typing?" test, the shell shortcut for a key press and the arrow guard. The page editor reads only
// this on the Easy path (master plan §2.8); the tools' names, hints and the shortcut sheet live in shortcuts.ts, which
// re-exports everything here (the rail, the sheet and tests import it).

import type { StudioSelection } from '../types';

export type ProTool = 'select' | 'text' | 'balloon' | 'sfx' | 'shapes' | 'markup' | 'hand' | 'zoom';

/** Each tool's single key, in rail order: V select · T text · B balloon · S sound effect · U shapes · M mark up · H hand · Z zoom. */
export const PRO_TOOL_KEYS: Readonly<Record<ProTool, string>> = { select: 'V', text: 'T', balloon: 'B', sfx: 'S', shapes: 'U', markup: 'M', hand: 'H', zoom: 'Z' };

/** The tool ids in rail order. */
export const PRO_TOOL_IDS: readonly ProTool[] = ['select', 'text', 'balloon', 'sfx', 'shapes', 'markup', 'hand', 'zoom'];

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
  const k = e.key.toUpperCase();
  const tool = PRO_TOOL_IDS.find((t) => PRO_TOOL_KEYS[t] === k);
  return tool && ctx.tools.has(tool) ? { kind: 'tool', tool } : null;
}

/**
 * The arrow-key page turn's guard (graft 4): never turn the page while anything on it is selected — balloons
 * (lineIds), overlays (layerIds) or panels (panelIds). Arrows then nudge the selection instead.
 */
export const selectionHoldsArrows = (sel: Pick<StudioSelection, 'lineIds' | 'layerIds' | 'panelIds'> | null | undefined): boolean =>
  !!sel && ((sel.lineIds?.length ?? 0) > 0 || (sel.layerIds?.length ?? 0) > 0 || (sel.panelIds?.length ?? 0) > 0);
