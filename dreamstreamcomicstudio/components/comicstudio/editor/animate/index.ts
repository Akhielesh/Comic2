// Pro Edit client part "animate" (master plan §2.12). STUB with fixed export names (PE-0): PE-ANIMATE replaces it in place.
//
// Builds: Animate: the Easy Animate row, the timeline (lanes, clips, keyframes), the preset picker, the phone clip list and
// "Export this page as video". Behind COMIC_PRO_MOTION (caps.proMotion).
//
// The stub renders nothing and nothing mounts it: the shell (PE-SHELL) mounts a part only when `part.ready` is true and
// its flag is on, so the editor is exactly what it was. Every Pro edit is free software: this folder never imports
// editActionFor and never calls studio.act (proEdit.contract.test.ts scans it).

import type { ProEditPart } from '../../../../shared/comic/pro/types';

export const part: ProEditPart = { id: 'animate', ready: false };
