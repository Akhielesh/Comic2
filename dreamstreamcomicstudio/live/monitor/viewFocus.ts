/**
 * The nursery hub can open the watch screen at a section (sessionStorage
 * FOCUS_KEY, e.g. "alerts"). Some sections exist only in the All layout — on
 * a phone the default Monitor layout would leave the jump with nothing to
 * scroll to — so the screen switches layout for that visit (not saved as the
 * preferred one).
 */

const ALL_ONLY = new Set(['share', 'alerts', 'people', 'settings']);

/** The layout a focus needs, or null when the current one shows it. */
export function focusLayout(focus: string | null | undefined): 'all' | null {
  return focus && ALL_ONLY.has(focus) ? 'all' : null;
}
