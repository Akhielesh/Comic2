// "Flatten page" (flatten_page; pro plan §4.4 B8). STUB with fixed export names (K2b): B8 replaces it in place and owns
// this file from the moment K2b merges (pro plan §10 stub rule).
//
// Free, server-side: bakes the frames, the art and the printed overlays into one raster (raster.bakeComposition) with
// cuts equal to the frames; the lettering stays live. One undoable editor moment. The stub says it isn't available yet.

import type { ActionHandler } from '../extensions.js';
import { notAvailableAction } from '../extensions.js';

export const FLATTEN_NOT_AVAILABLE = "Flattening a page isn't available yet. Nothing was changed.";

/** flatten_page (free). STUB: not available. */
export const flattenPageAction = notAvailableAction('flatten_page' as never, false, FLATTEN_NOT_AVAILABLE) as unknown as ActionHandler;

export const EDITOR_ACTIONS: ActionHandler[] = [flattenPageAction];
