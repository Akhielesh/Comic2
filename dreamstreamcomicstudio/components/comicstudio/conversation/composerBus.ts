// A tiny window-event bus so anything in the studio (empty state, cards, the board, the
// header's Cmd/Ctrl+K) can drive the composer without prop drilling: focus it, prefill a
// draft with a hint, or open the file picker. The composer is the only listener.

import { sendOutcomeOf } from '../messageQueue';
import type { ComicResearchResult } from '../../../shared/comic/research';

export const COMPOSE_EVENT = 'comicstudio:compose';

export interface ComposeRequest {
  /** Replace the draft with this text (focus + caret at end). */
  text?: string;
  /** Append to the existing draft instead of replacing it. */
  append?: boolean;
  /** Temporary placeholder hint ("Paste your script…"), cleared on the next send. */
  hint?: string;
  /** Focus the textarea (default true). */
  focus?: boolean;
  /** Open the attachment file picker. */
  pickFiles?: boolean;
  /** Open one of the composer's option panels (format / style / quality). Additive: composers
   *  that don't handle it just focus, so callers must never rely on it as their only path. */
  openPanel?: ComposerPanel;
  /** Explicit research selection, scoped to the comic that requested it. */
  research?: { projectId: string; result: ComicResearchResult; file?: File };
}

export type ComposerPanel = 'format' | 'style' | 'quality';

export const composeInStudio = (request: ComposeRequest = {}): void => {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<ComposeRequest>(COMPOSE_EVENT, { detail: request }));
};

/**
 * A message sent from outside the composer (the board's and the timeline's "Write this page with AI", the lettering
 * inspector's ask box) that the studio refused — the director is busy and Up next is off or full, or the comic is not
 * ready — goes to the message box instead of being dropped (agent-editor plan §3 A1), after any draft already there, so
 * the creator can send it once the director is free. `result` is what `studio.send(text, …)` returned.
 */
export const keepRefusedInComposer = (result: unknown, text: string): Promise<void> =>
  Promise.resolve(result)
    .then(sendOutcomeOf, () => 'refused' as const)
    .then((outcome) => {
      if (outcome === 'refused') composeInStudio({ text, append: true });
    });
