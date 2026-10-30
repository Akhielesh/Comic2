// "Make panels editable" (panelize_page; pro plan §4.3 B2). STUB with fixed export names (K2b): B2 replaces it in place
// and owns this file from the moment K2b merges (pro plan §10 stub rule).
//
// Free (no AI, no new asset): loads the stored drawing, seeds detection with its stored panel boxes and commits
// server-stamped cuts and frames as one undoable editor moment. The stub says it isn't available yet (nothing changes).

import type { ActionHandler } from '../extensions.js';
import { notAvailableAction } from '../extensions.js';

export const PANELIZE_NOT_AVAILABLE = "Making a page's panels editable isn't available yet. Nothing was changed.";

/** panelize_page (free). STUB: not available. */
export const panelizePageAction = notAvailableAction('panelize_page' as never, false, PANELIZE_NOT_AVAILABLE) as unknown as ActionHandler;

export const PANELS_ACTIONS: ActionHandler[] = [panelizePageAction];
