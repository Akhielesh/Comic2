// Pro Edit client part "kit" (master plan §2.12). STUB with fixed export names (PE-0): PE-SHELL replaces it in place.
//
// Builds: The Pro editor kit on components/ds and the studio recipes: ToolButton, PropertyRow, ScrubField, SliderField,
// SwatchPopover, PresetCard and the stacking recipe (zLayers).
//
// The stub renders nothing and nothing mounts it: the shell (PE-SHELL) mounts a part only when `part.ready` is true and
// its flag is on, so the editor is exactly what it was. Every Pro edit is free software: this folder never imports
// editActionFor and never calls studio.act (proEdit.contract.test.ts scans it).

import type { ProEditPart } from '../../../../shared/comic/pro/types';

export const part: ProEditPart = { id: 'kit', ready: false };
