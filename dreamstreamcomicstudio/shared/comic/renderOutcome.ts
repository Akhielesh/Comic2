// What one run did to one target, read from the stored doc. Shared by the live renders card
// (components/comicstudio/conversation/cards/renderProgress.ts) and its settled one-line summary (settle.ts), so the
// card and its settled line always agree.
//
// "Drawn" means this run drew a picture the owner can see. A take the content check blocked is stored as ready, but
// it reads "withheld"; a ready target whose picture predates the run (the card's `since`: a stopped redraw put the
// earlier one back, an earlier take was reused, a failed redraw kept the old one) reads "kept" (an earlier picture).

import type { RenderState } from './doc.js';
import { canServeToOwner } from './safety.js';

/** One target's place in the run. */
export type ProgressState = 'drawn' | 'withheld' | 'kept' | 'drawing' | 'queued' | 'failed' | 'idle';

/** The run drew this target's picture: its current picture, or one in its history (since swapped), is from `since` on. */
const drewSince = (render: RenderState, since: number): boolean =>
  [render.asset, ...(Array.isArray(render.history) ? render.history : [])].some((v) => !!v && typeof v.at === 'number' && v.at >= since);

/** `since`: when the run queued its targets (the card's own time); without it every ready target counts as drawn. */
export const progressState = (render?: RenderState, since?: number): ProgressState => {
  switch (render?.status) {
    case 'ready':
    case 'stale':
      // Blocked by the content check: never shown, so never "drawn".
      if (render.asset && !canServeToOwner(render.asset)) return 'withheld';
      if (typeof since === 'number' && render.asset && !drewSince(render, since)) return 'kept';
      return 'drawn';
    case 'rendering':
      return 'drawing';
    case 'queued':
      return 'queued';
    case 'failed':
      return 'failed';
    default:
      // Never started, or put back by Stop.
      return 'idle';
  }
};
