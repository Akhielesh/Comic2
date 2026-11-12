// The inspector's keys (agent-editor plan §3 C3, C8): 1–6 set the selected balloons' kind (Speech, Thought, Whisper,
// Shout, Caption, SFX), ⌘⌥C / ⌘⌥V copy and paste a style. They never fire while typing (a field, a select, a
// contentEditable) or with Ctrl/⌘/Alt held for the kind keys (⌘1 belongs to the browser).

import type { LineKind } from '../../../../shared/comic/doc';
import { KIND_ROW } from '../../lettering/styleOps';

/** Typing in a field, a select or editable text: shortcuts stay out of the way. */
export const isTypingTarget = (el: EventTarget | null): boolean => {
  const node = el as HTMLElement | null;
  if (!node || !node.tagName) return false;
  const tag = node.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || node.isContentEditable === true || node.getAttribute?.('contenteditable') === 'true';
};

/** The kind a 1–6 key sets, or undefined (modifiers held, another key, typing). */
export const kindForKey = (e: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'target'>): LineKind | undefined => {
  if (e.metaKey || e.ctrlKey || e.altKey || isTypingTarget(e.target)) return undefined;
  const n = /^[1-6]$/.test(e.key) ? Number(e.key) : 0;
  return n ? KIND_ROW[n - 1] : undefined;
};
