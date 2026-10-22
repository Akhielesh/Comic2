// A tiny window-event bus so anything in the studio (empty state, cards, the board, the
// header's Cmd/Ctrl+K) can drive the composer without prop drilling: focus it, prefill a
// draft with a hint, or open the file picker. The composer is the only listener.

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
}

export const composeInStudio = (request: ComposeRequest = {}): void => {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<ComposeRequest>(COMPOSE_EVENT, { detail: request }));
};
