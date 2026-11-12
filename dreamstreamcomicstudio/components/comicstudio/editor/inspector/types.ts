// What the Pro shell (PE-SHELL, editor/useProEditor.ts `ProPanelProps`) hands a mounted Pro panel: the same fields,
// declared here so the inspector and Layers parts build in parallel with the shell. The shell reads a part's
// `loadPanel` (its `Panel: React.ComponentType<ProPanelProps>`); this shape is field-for-field the shell's.

import type { ComicDoc, Page } from '../../../../shared/comic/doc';
import type { DocOp } from '../../../../shared/comic/ops';
import type { LetterPlan } from '../../../../shared/comic/lettering/layout';
import type { StudioMode } from '../../../../shared/comic/capabilities';
import type { PatchOptions, StudioController, StudioPresence } from '../../types';
import type { EditorLayoutKind } from '../../mobile/editor/editorModel';
import type { Placements } from '../../lettering/useLetterPlans';

export interface PartPanelProps {
  studio: StudioController;
  /** The doc as shown (a translated edition applied when one is being edited). */
  doc: ComicDoc;
  /** The stored doc (writes go to it; editions through `apply`). */
  sourceDoc: ComicDoc;
  /** The page as shown, and as stored. */
  page: Page;
  sourcePage: Page;
  /** Page aspect (width / height) and the plan height (width is 1000). */
  aspect: number;
  H: number;
  /** The drawn plans (not drafts) and the placements behind them (useLetterPlans). */
  plans: readonly LetterPlan[];
  placements: Placements;
  /** The selected balloons (reading order, primary first). */
  selection: { ids: readonly string[]; set(ids: string[]): void; clear(): void };
  /**
   * Select overlays (the Layers panel; PE-SHELL's ProPanelProps.selectLayers): the balloon selection is cleared first,
   * then the studio selection becomes {pageId, lineIds: [], layerIds}, so the arrows nudge them. [] clears. Optional
   * here so a host without overlay selection still mounts the panels.
   */
  selectLayers?(ids: readonly string[]): void;
  /** Free, undoable, labelled edits (in an edition they land in it). Never editActionFor, never studio.act. */
  apply(ops: DocOp[], opts?: PatchOptions): void;
  /** Open the inline text editor on a balloon. */
  onEditText(lineId: string): void;
  /** The translated edition being edited (undefined for the original). */
  editionLang?: string;
  /** The editor's view and layout. */
  mode: StudioMode;
  layout: EditorLayoutKind;
  /** Where the director is editing (A4), for the Layers badge. */
  presence?: StudioPresence | null;
  /** The footer every Pro panel reads (PRO_FREE_FOOTER); the shell draws it under the panel. */
  footer: string;
}
