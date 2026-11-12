// Pro Edit client part "stage" (master plan §2.12). STUB with fixed export names (PE-0): PE-STAGE replaces it in place.
//
// Builds: The stage for overlays: hit layer, handles, smart guides, drag (one op on release), carry and the clipboard.
//
// The stub renders nothing and nothing mounts it: the shell (PE-SHELL) mounts a part only when `part.ready` is true and
// its flag is on, so the editor is exactly what it was. Every Pro edit is free software: this folder never imports
// editActionFor and never calls studio.act (proEdit.contract.test.ts scans it).

import type { ProEditPart } from '../../../../shared/comic/pro/types';

export const part: ProEditPart = { id: 'stage', ready: false };
