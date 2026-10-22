// Feature actions "library" (contract §12.1): use_preset, library_save, library_use, import_classic_cast.
// Wave-0 stub by P0-B; owned in wave 1 by P1-LIBRARY (wave 3: library_save, library_use, import_classic_cast), which replaces the handlers IN PLACE
// (keep the export name; one handler per action type).
// Stub behaviour: every action answers `blocked` with code NOT_AVAILABLE and an honest notice.

import type { StudioAction } from '../../../../shared/comic/ops.js';
import { notAvailableAction, type ActionHandler } from '../extensions.js';

export const LIBRARY_ACTIONS: ActionHandler[] = [
  notAvailableAction<Extract<StudioAction, { type: 'use_preset' }>>('use_preset', false, "Style presets from the library aren't available yet."),
  notAvailableAction<Extract<StudioAction, { type: 'library_save' }>>('library_save', false, "Saving to your library isn't available yet."),
  notAvailableAction<Extract<StudioAction, { type: 'library_use' }>>('library_use', false, "Your library isn't available yet."),
  notAvailableAction<Extract<StudioAction, { type: 'import_classic_cast' }>>('import_classic_cast', false, "Importing a classic comic's cast isn't available yet.")
];
