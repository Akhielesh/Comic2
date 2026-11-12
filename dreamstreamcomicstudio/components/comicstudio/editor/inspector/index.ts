// Pro Edit client part "inspector" (master plan §2.12; PE-INSPECT fills the PE-0 stub, PE-PROPS adds the effect,
// sticker, blend and border-style sections in S3).
//
// Builds: the docked inspector (≥ 1024 px, the Pro workspace's Properties tab): with nothing selected, the comic's
// lettering style and the page's facts; with a selection, the kind row (keys 1–6), the typed transform, typed fields
// beside every slider, align and distribute, Copy / Paste style (⌘⌥C / ⌘⌥V) and — behind PRO_EDIT_OPS_PATCHABLE — the
// Pro lettering controls and saved styles.
//
// The shell (PE-SHELL, editor/useProEditor.ts) mounts `Panel` only when `part.ready` is true and COMIC_PRO_EDITOR_V2 is
// on. Every Pro edit is free software: this folder never imports editActionFor and never calls studio.act
// (proEdit.contract.test.ts scans it).

import type { ProEditPart } from '../../../../shared/comic/pro/types';
import { InspectorPanel } from './InspectorPanel';

export const part: ProEditPart = { id: 'inspector', ready: true };

/** The part's panel (the shell's mount contract: `Panel: React.ComponentType<ProPanelProps>`). */
export const Panel = InspectorPanel;

export { InspectorPanel, EmptySelection, pageFacts, INSPECTOR_EMPTY_HINT } from './InspectorPanel';
export type { PartPanelProps } from './types';
export { proFieldsWritable, stripProFields, writablePatch, proLooks, proFontIds, PRO_SFX_DRAWN, WARP_SCRIPTS, warpAllowed, type ProLook } from './proGate';
export { styleClip, setStyleClip, useStyleClip, styleClipboardKey } from './styleClipboard';
export { kindForKey, isTypingTarget } from './keys';
export { LENGTH_UNITS, TRIM_WIDTH_IN, unitScale, unitStep, type LengthUnit } from './units';
