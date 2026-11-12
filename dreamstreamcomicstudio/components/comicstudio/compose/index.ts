// Pro Edit client part "compose" (master plan §2.12). STUB with fixed export names (PE-0): PE-COMPOSE (= Ship 2 B1) replaces it in place.
//
// Builds: One page node tree (paper, frames, overlays: images, shapes, effects through renderFx, stickers by URL, as
// g[data-layer-id]; then lettering) used by the screen, print, PNG, PDF and ZIP. Guide-only and opaque layers are never
// drawn. A page without Pro or Ship 2 data must give a byte-identical DOM and export.
//
// The stub renders nothing and nothing mounts it: the shell (PE-SHELL) mounts a part only when `part.ready` is true and
// its flag is on, so the editor is exactly what it was. Every Pro edit is free software: this folder never imports
// editActionFor and never calls studio.act (proEdit.contract.test.ts scans it).

import type { ProEditPart } from '../../../shared/comic/pro/types';

export const part: ProEditPart = { id: 'compose', ready: false };
