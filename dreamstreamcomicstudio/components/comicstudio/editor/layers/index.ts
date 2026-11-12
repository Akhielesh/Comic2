// Pro Edit client part "layers" (master plan §2.12; PE-INSPECT fills the PE-0 stub, PE-PROPS adds effect rows in S3).
//
// Builds: Layers — the page's objects in the scene's bands (lettering always on top), lettering rows grouped by panel
// in reading order, eye (hide in this view only), lock, drag restack within the band (zOrderEdit), drag to another
// panel (line_move), touch checkboxes, the "Director is editing" badge, a polite live region (master §2.9).
//
// The shell (PE-SHELL, editor/useProEditor.ts) mounts `Panel` only when `part.ready` is true and COMIC_PRO_EDITOR_V2 is
// on. Every Pro edit is free software: this folder never imports editActionFor and never calls studio.act
// (proEdit.contract.test.ts scans it).

import type { ProEditPart } from '../../../../shared/comic/pro/types';
import { LayersPanel } from './LayersPanel';

export const part: ProEditPart = { id: 'layers', ready: true };

/** The part's panel (the shell's mount contract: `Panel: React.ComponentType<ProPanelProps>`). */
export const Panel = LayersPanel;

export { LayersPanel, DIRECTOR_EDITING, type LayersPanelProps } from './LayersPanel';
export { layersModel, balloonRows, clipText, type LayerBand, type LayerGroup, type LayerRow, type LayersOptions } from './layersModel';
export { viewHidden, setViewHidden, clearViewHidden, subscribeViewHidden, useViewHidden } from './viewHidden';
