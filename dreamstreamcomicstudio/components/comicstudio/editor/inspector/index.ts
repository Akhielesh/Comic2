// Pro Edit client part "inspector" (master plan §2.12; PE-INSPECT fills the PE-0 stub, PE-PROPS adds the effect,
// sticker, blend and border-style sections in S3).
//
// Builds: the docked inspector (≥ 1024 px, the Pro workspace's Properties tab): with nothing selected, the comic's
// lettering style and the page's facts; with a selection, the kind row (keys 1–6), the typed transform, typed fields
// beside every slider, align and distribute, Copy / Paste style (⌘⌥C / ⌘⌥V) and — behind PRO_EDIT_OPS_PATCHABLE — the
// Pro lettering controls and saved styles.
//
// The shell (PE-SHELL, editor/useProEditor.ts) imports this file on the Easy path, so it stays tiny: `part` (the flag
// the shell reads) and `loadPanel` (its lazy mount contract, collisions B-16). The panel and everything it draws load
// only when the shell mounts the Properties tab, together with the Pro extras, so the tab opens complete. Import the
// panel's helpers from their own modules (./InspectorPanel, ./proGate, ./styleClipboard, ./keys, ./units), never
// through here. Every Pro edit is free software: this folder never imports editActionFor and never calls studio.act
// (proEdit.contract.test.ts scans it).

import type { ComponentType } from 'react';
import type { ProEditPart } from '../../../../shared/comic/pro/types';
import { loadProExtras } from '../../lettering/pro/proExtras';
import type { PartPanelProps } from './types';

export const part: ProEditPart = { id: 'inspector', ready: true };

/** The part's panel, loaded lazily (the shell's mount contract: the module exports `Panel: ComponentType<ProPanelProps>`). */
export const loadPanel = (): Promise<{ Panel: ComponentType<PartPanelProps> }> =>
  Promise.all([import('./InspectorPanel'), loadProExtras()]).then(([m]) => ({ Panel: m.InspectorPanel }));

export type { PartPanelProps } from './types';
