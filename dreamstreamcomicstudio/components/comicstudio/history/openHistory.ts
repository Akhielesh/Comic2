// Comic History — open the History panel from anywhere (package H5). A leaf module: no React, no components, so
// useStudio, the intents and every entry link can import it without import cycles. index.ts re-exports it under the
// names H0 gave it (OPEN_HISTORY_EVENT, OpenHistoryRequest, requestOpenHistory).
//
// The mounted History panel (the header slot) answers the window event and calls preventDefault, so
// requestOpenHistory() says whether anything handled it — with Comic History off nothing listens and it is false.

import type { HistoryCardView } from '../../../shared/comic/history/types';

/** Window event the mounted History panel answers (preventDefault = handled). */
export const OPEN_HISTORY_EVENT = 'ds:open-history';

export interface OpenHistoryRequest {
  view?: HistoryCardView;
  versionId?: string;
  pageId?: string;
}

/** Ask the mounted History panel to open; true when something handled it. */
export const requestOpenHistory = (request: OpenHistoryRequest = {}): boolean => {
  if (typeof window === 'undefined' || typeof CustomEvent !== 'function') return false;
  return !window.dispatchEvent(new CustomEvent(OPEN_HISTORY_EVENT, { cancelable: true, detail: request }));
};
