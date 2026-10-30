// Client feature module: Comic History (versions plan §8; package H0 STUB — H5 replaces it in place, keeping every
// export name and signature, and registers the History header slot, tab (order 510) and `history` card here; the
// alternatives sheet under history/alternatives/** belongs to H7).
//
// Registered in features.ts. Registers nothing in H0: with StudioCaps.history off nothing in the studio changes.
// The panel opens on OPEN_HISTORY_EVENT (useStudio's typed intents and chips raise it; the mounted panel answers it,
// the same pattern as the Share sheet and the model picker).

import type { FeatureModule } from '../extensions';
import type { HistoryCardView } from '../../../shared/comic/history/types';

export const feature: FeatureModule = {};

/** Window event the mounted History panel answers (preventDefault = handled). */
export const OPEN_HISTORY_EVENT = 'ds:open-history';

export interface OpenHistoryRequest {
  view?: HistoryCardView;
  versionId?: string;
  pageId?: string;
}

/** Ask the mounted History panel to open; true when something handled it (H0: nothing listens). */
export const requestOpenHistory = (request: OpenHistoryRequest = {}): boolean => {
  if (typeof window === 'undefined' || typeof CustomEvent !== 'function') return false;
  return !window.dispatchEvent(new CustomEvent(OPEN_HISTORY_EVENT, { cancelable: true, detail: request }));
};

export { matchHistoryIntent, handleHistoryIntent, historyUndoFallback } from './intents';
export type { HistoryIntent, HistoryIntentHost } from './intents';
