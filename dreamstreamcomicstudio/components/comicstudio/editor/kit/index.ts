// Pro Edit client part "kit" (master plan §2.12; PE-SHELL fills the PE-0 stub): the Pro editor kit on components/ds and
// the studio recipes — ToolButton, PropertyRow, ScrubField, SliderField, SwatchPopover, PresetCard and the stacking
// recipe (zLayers). The other Pro parts build their panels from it.
//
// Every Pro edit is free software: this folder never imports editActionFor and never calls studio.act
// (proEdit.contract.test.ts scans it).

import type { ProEditPart } from '../../../../shared/comic/pro/types';

export const part: ProEditPart = { id: 'kit', ready: true };

export { ToolButton, TOOL_BUTTON_BASE, TOOL_BUTTON_IDLE, type ToolButtonProps } from './ToolButton';
export { PropertyRow, type PropertyRowProps } from './PropertyRow';
export { ScrubField, clampToStep, parseNumber, type ScrubFieldProps } from './ScrubField';
export { SliderField, type SliderFieldProps } from './SliderField';
export { SwatchPopover, normalizeHex, type SwatchPopoverProps } from './SwatchPopover';
export { PresetCard, type PresetCardProps } from './PresetCard';
export { EDITOR_Z, editorZ, type EditorZLayer } from './zLayers';
