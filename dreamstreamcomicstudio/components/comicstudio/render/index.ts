// Pro Edit client part "render" (master plan §2.12). STUB with fixed export names (PE-0): PE-ANIMATE replaces it in place.
//
// Builds: The motion preview: MotionPlayer (one requestAnimationFrame loop, only while playing or scrubbing; transform and
// opacity on g[data-line-id] / g[data-layer-id], no React re-render; 30 fps on phones; paused when hidden) and
// useMotionPreview.
//
// The stub renders nothing and nothing mounts it: the shell (PE-SHELL) mounts a part only when `part.ready` is true and
// its flag is on, so the editor is exactly what it was. Every Pro edit is free software: this folder never imports
// editActionFor and never calls studio.act (proEdit.contract.test.ts scans it).

import type { ProEditPart } from '../../../shared/comic/pro/types';

export const part: ProEditPart = { id: 'render', ready: false };
