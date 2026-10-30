// Feature action "history_alternative" — "Try another version" inside one comic (versions plan §7; decision V-1:
// at most MAX_ALTERNATIVES lines per comic). Package H0 STUB — H7 replaces it in place, keeping the export name and type.
//
// create / switch / rename / remove a line. Free; a switch saves the current line's head first (awaited, pinned) and
// restores the target in exact mode. Until H7 lands it refuses honestly — NOT_AVAILABLE, nothing changed or spent.

import type { ActionHandler } from '../extensions.js';
import { historyNotAvailable } from '../history/hooks.js';

export const HISTORY_ALTERNATIVE_ACTIONS: ActionHandler[] = [
  {
    type: 'history_alternative',
    spend: false,
    async run() {
      throw historyNotAvailable();
    }
  }
];
