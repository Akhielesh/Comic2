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
//
// The page editor's Easy path reads only keys.ts (re-exported here); this file — the tools' names and hints and the
// shortcut sheet — is for the rail, the sheet (both lazy) and tests (master plan §2.8).

import { PRO_TOOL_KEYS, type ProTool } from './keys';

// The core (ids, keys, the typing test, the shell shortcut, the arrow guard) is keys.ts, the Easy path's only part.
export {
  PRO_TOOL_IDS,
  PRO_TOOL_KEYS,
  TOOL_LINE_KIND,
  isEditableTarget,
  isLetteringTool,
  selectionHoldsArrows,
  shellShortcut,
  type KeyLike,
  type LetteringTool,
  type ProTool,
  type ShellShortcut,
  type ShortcutContext
} from './keys';

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
  { id: 'select', key: PRO_TOOL_KEYS.select, label: 'Select', hint: 'Select and move balloons' },
  { id: 'text', key: PRO_TOOL_KEYS.text, label: 'Text', hint: 'Click the page to add a caption', letters: true },
  { id: 'balloon', key: PRO_TOOL_KEYS.balloon, label: 'Balloon', hint: 'Click the page to add a speech balloon', letters: true },
  { id: 'sfx', key: PRO_TOOL_KEYS.sfx, label: 'Sound effect', hint: 'Click the page to add a sound effect', letters: true },
  { id: 'shapes', key: PRO_TOOL_KEYS.shapes, label: 'Shapes', hint: 'Click the page to add a rectangle' },
  { id: 'markup', key: PRO_TOOL_KEYS.markup, label: 'Mark up', hint: 'Drag a box on the art to show the AI what to change' },
  { id: 'hand', key: PRO_TOOL_KEYS.hand, label: 'Hand', hint: 'Drag to pan the page' },
  { id: 'zoom', key: PRO_TOOL_KEYS.zoom, label: 'Zoom', hint: 'Zoom controls; pinch or Ctrl + scroll also zoom' }
];

export const toolSpec = (id: ProTool): ProToolSpec => PRO_TOOLS.find((t) => t.id === id) ?? PRO_TOOLS[0];

/** The next id in reading order (wrapping): a leaf module, so the balloon layer can read it without this table. */
export { cycleReadingOrder } from './readingCycle';

/** One row of the shortcut sheet. */
export interface ShortcutRow {
  keys: string;
  label: string;
}

/** The shortcut sheet (?), grouped. Only rows that work in this build are listed. */
export const SHORTCUT_SHEET: readonly { title: string; rows: readonly ShortcutRow[] }[] = [
  { title: 'Tools', rows: /* @__PURE__ */ PRO_TOOLS.map((t) => ({ keys: t.key, label: t.label })) },
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
