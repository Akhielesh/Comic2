// Comic History — typed intents handled locally at no cost (versions plan §8 "Typed intents"; package H5, replacing
// the H0 stub in place, keeping every export name and signature).
//
// useStudio calls these only while StudioCaps.history is on (COMIC_HISTORY=1):
//   matchHistoryIntent(text)        "history" / "show history" → open the panel; "undo last AI change" → history_undo_ai
//   handleHistoryIntent(intent, h)  carries an intent out through the host (free; never sent to the director)
//   historyUndoFallback(h)          a typed "undo" whose newest change the local stack can't invert (an AI re-plan,
//                                   a translation run, a render run): offer "Restore what you had just before it
//                                   (free)" — the Undo-the-last-AI-change sheet — instead of the dead end
// Only short, exact commands match: anything richer ("show me yesterday's version", "go back to how page 3 looked")
// goes to the director, whose history tools understand times and pages.
// Leaf module: no React components (useStudio imports it without import cycles).

import type { StudioCaps } from '../../../shared/comic/capabilities';
import { historyEnabled } from '../../../shared/comic/capabilities';
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

/** Lowercase, straight quotes, no trailing punctuation or polite words around the command. */
const normalize = (text: string): string =>
  (typeof text === 'string' ? text : '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[’‘`]/g, "'")
    .replace(/[.!?…]+$/g, '')
    .replace(/^(?:please|pls|ok|okay|hey)[, ]+/, '')
    .replace(/[, ]+(?:please|pls|thanks|thank you)$/, '')
    .replace(/\s+/g, ' ')
    .trim();

const OPEN_RE = /^(?:(?:open|show|show me|see|view|go to) (?:the |my )?)?(?:version |comic |book )?history$/;
const OPEN_VERSIONS_RE = /^(?:open|show|show me|see|view) (?:the |my |all )?(?:saved )?versions(?: of (?:the|my) (?:comic|book))?$/;
const UNDO_AI_RE = /^undo (?:the |that |this )?(?:last |latest )?(?:ai|a\.i\.) (?:change|edit|changes|edits|revision|rewrite)$|^undo what the ai (?:just )?did$/;

/** The history intent a typed message names, or null. */
export function matchHistoryIntent(text: string): HistoryIntent | null {
  const t = normalize(text);
  if (!t || t.length > 60) return null;
  if (OPEN_RE.test(t) || OPEN_VERSIONS_RE.test(t)) return { kind: 'open', view: 'list' };
  if (UNDO_AI_RE.test(t)) return { kind: 'undo_ai' };
  return null;
}

/** Carry out an intent; true when it was handled locally (free). */
export function handleHistoryIntent(intent: HistoryIntent, host: HistoryIntentHost): boolean {
  if (!intent || !historyEnabled(host.caps) || !host.doc) return false;
  if (intent.kind === 'open') return host.openHistory({ view: intent.view ?? 'list' });
  if (intent.kind === 'undo_ai') {
    // Sent as typed: the server reverts only the AI's pieces you haven't touched since, and asks (a history card)
    // about the ones you have. Free.
    void host.act({ type: 'history_undo_ai' });
    host.say('Undoing the last AI change — free. Anything you changed since is asked about first.');
    return true;
  }
  return false;
}

/** A typed "undo" with no locally invertible newest change: offer history_undo_ai; true when offered. */
export function historyUndoFallback(host: HistoryIntentHost): boolean {
  if (!historyEnabled(host.caps) || !host.doc) return false;
  // The sheet shows what would come back and asks about later edits; nothing happens without a tap.
  return host.openHistory({ view: 'undo_ai' });
}
