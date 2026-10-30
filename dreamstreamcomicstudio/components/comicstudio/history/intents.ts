// Comic History — typed intents handled locally at no cost (versions plan §8 "Typed intents"; package H0 STUB, H5
// replaces it in place, keeping every export name and signature).
//
// useStudio calls these only while StudioCaps.history is on (COMIC_HISTORY=1):
//   matchHistoryIntent(text)        "history" / "show history" → open the panel; "undo last AI change" → history_undo_ai
//   handleHistoryIntent(intent, h)  carries an intent out through the host (free; never sent to the director)
//   historyUndoFallback(h)          a typed "undo" whose newest change the local stack can't invert (an AI re-plan,
//                                   a translation run, a render run): offer "Restore what you had just before it
//                                   (free)" — history_undo_ai — instead of the dead end
// H0: no intent matches and the fallback declines, so the studio behaves exactly as before.
// Leaf module: no React components (useStudio imports it without import cycles).

import type { StudioCaps } from '../../../shared/comic/capabilities';
import type { ComicDoc } from '../../../shared/comic/doc';
import type { StudioAction } from '../../../shared/comic/ops';
import type { HistoryCardView } from '../../../shared/comic/history/types';

export type HistoryIntent =
  /** Open the History panel (optionally at a view). */
  | { kind: 'open'; view?: HistoryCardView }
  /** "Undo the last AI change" (§6.4). */
  | { kind: 'undo_ai' };

/** What useStudio lends the history intents (no network of their own). */
export interface HistoryIntentHost {
  caps: StudioCaps;
  doc: ComicDoc | null;
  /** Run a StudioAction through the controller (streams like every other action). */
  act(action: StudioAction): Promise<unknown>;
  /** Ask the mounted History panel to open; true when one handled it. */
  openHistory(request?: { view?: HistoryCardView }): boolean;
  /** A calm notice in the studio's toast. */
  say(text: string): void;
}

/** The history intent a typed message names, or null (H0: always null). */
export function matchHistoryIntent(_text: string): HistoryIntent | null {
  return null;
}

/** Carry out an intent; true when it was handled locally (H0: never). */
export function handleHistoryIntent(_intent: HistoryIntent, _host: HistoryIntentHost): boolean {
  return false;
}

/** A typed "undo" with no locally invertible newest change: offer history_undo_ai; true when offered (H0: never). */
export function historyUndoFallback(_host: HistoryIntentHost): boolean {
  return false;
}
