// Feature actions "history" (versions plan §3.3, §6; package H0 STUB — H3 replaces it in place, keeping the export
// name and type).
//
//   history_save          name the current state ("Draft 2"); free
//   history_restore       bring a version back for a scope (§6.1 protocol, under the session lock); free, undoable
//   history_undo_ai       "Undo the last AI change" (§6.4); free
//   history_forget_photo  remove a reference photo from History too (V-4: the default when removing a real person)
//
// Every history action is NON-SPEND and free: the handlers are built without LLM, image or billing clients. Until
// H3 lands each one refuses honestly — NOT_AVAILABLE, nothing committed, nothing spent. The client never sends them
// while StudioCaps.history is off (COMIC_HISTORY unset), so nothing observable changes.

import type { ActionHandler } from '../extensions.js';
import { historyNotAvailable } from '../history/hooks.js';

const notYet = (type: 'history_save' | 'history_restore' | 'history_undo_ai' | 'history_forget_photo'): ActionHandler => ({
  type,
  spend: false,
  async run() {
    throw historyNotAvailable();
  }
});

export const HISTORY_ACTIONS: ActionHandler[] = [notYet('history_save'), notYet('history_restore'), notYet('history_undo_ai'), notYet('history_forget_photo')];
