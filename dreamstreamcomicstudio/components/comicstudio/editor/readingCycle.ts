// Tab / Shift+Tab in reading order (agent-editor plan §3 C1). A leaf module with no imports: the balloon layer reads it,
// and the balloon layer is in every reader's first load (master plan §2.8: no Pro editor code there), so this file must
// never import anything. shortcuts.ts re-exports it for the shell.

/** The next id in reading order from `current` (wrapping); the first (or last) when nothing is selected. */
export function cycleReadingOrder(order: readonly string[], current: string | undefined, dir: 1 | -1): string | undefined {
  if (!order.length) return undefined;
  const at = current ? order.indexOf(current) : -1;
  if (at < 0) return dir > 0 ? order[0] : order[order.length - 1];
  return order[(at + dir + order.length) % order.length];
}
