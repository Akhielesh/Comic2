// Pro Edit client part "layers" (master plan §2.12; PE-INSPECT fills the PE-0 stub, PE-PROPS adds effect rows in S3).
//
// Builds: Layers — the page's objects in the scene's bands (lettering always on top), lettering rows grouped by panel
// in reading order, eye (hide in this view only), lock, drag restack within the band (zOrderEdit), drag to another
// panel (line_move), touch checkboxes, the "Director is editing" badge, a polite live region (master §2.9).
//
// The shell (PE-SHELL, editor/useProEditor.ts) imports this file on the Easy path, so it stays tiny: `part` and the
// lazy `loadPanel` (collisions B-16). The canvas reads the eye's store from ./viewHidden directly (a few lines, no
// panel code); everything else is imported from its own module, never through here. Every Pro edit is free software:
// this folder never imports editActionFor and never calls studio.act (proEdit.contract.test.ts scans it).

import type { ComponentType } from 'react';
import type { ProEditPart } from '../../../../shared/comic/pro/types';
import type { PartPanelProps } from '../inspector/types';

export const part: ProEditPart = { id: 'layers', ready: true };

/** The part's panel, loaded lazily (the shell's mount contract: the module exports `Panel: ComponentType<ProPanelProps>`). */
export const loadPanel = (): Promise<{ Panel: ComponentType<PartPanelProps> }> => import('./LayersPanel').then((m) => ({ Panel: m.LayersPanel }));
