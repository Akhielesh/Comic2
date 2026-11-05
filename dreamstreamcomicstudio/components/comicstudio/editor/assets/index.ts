// Pro Edit client part "assets" (master plan §2.12). STUB with fixed export names (PE-0): PE-ASSETS (then PE-STICKERS) replaces it in place.
//
// Builds: Assets: effects, looks, SFX words, recipes and samples; stickers once COMIC_PRO_STICKERS is on.
//
// The stub renders nothing and nothing mounts it: the shell (PE-SHELL) mounts a part only when `part.ready` is true and
// its flag is on, so the editor is exactly what it was. Every Pro edit is free software: this folder never imports
// editActionFor and never calls studio.act (proEdit.contract.test.ts scans it).

import type { ProEditPart } from '../../../../shared/comic/pro/types';

export const part: ProEditPart = { id: 'assets', ready: false };
