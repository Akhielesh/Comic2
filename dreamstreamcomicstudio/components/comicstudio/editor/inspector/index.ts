// Pro Edit client part "inspector" (master plan §2.12). STUB with fixed export names (PE-0): PE-INSPECT (then PE-PROPS) replaces it in place.
//
// Builds: The docked inspector (≥ 1024 px) with its empty-selection state, numeric fields and the effect, sticker, blend and
// border-style sections.
//
// The stub renders nothing and nothing mounts it: the shell (PE-SHELL) mounts a part only when `part.ready` is true and
// its flag is on, so the editor is exactly what it was. Every Pro edit is free software: this folder never imports
// editActionFor and never calls studio.act (proEdit.contract.test.ts scans it).

import type { ProEditPart } from '../../../../shared/comic/pro/types';

export const part: ProEditPart = { id: 'inspector', ready: false };
