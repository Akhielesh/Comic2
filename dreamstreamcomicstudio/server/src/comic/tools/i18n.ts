// Director tool group "i18n" (contract §12.1/§12.2). Wave-0 stub by P0-B; owned in wave 1 by P1-I18N,
// which replaces the implementation IN PLACE (keep the export name and type).
//
// Final tools: translate_comic, set_comic_language, edit_translation, read_translation, set_glossary.
// Phase gate (when): language words in the turn, or editions exist.
// Stub behaviour: contributes no tools, prompt rules or summary lines.

import type { ToolGroup } from '../extensions.js';

export const i18nToolGroup: ToolGroup = {
  id: 'i18n',
  priority: 50,
  tools: () => []
};
