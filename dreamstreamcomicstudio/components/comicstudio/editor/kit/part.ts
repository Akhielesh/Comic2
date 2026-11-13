// The kit's PE-0 part flag on its own (no imports but the type): the shell reads `part.ready` on the Easy path, and the
// kit's controls (ScrubField, SwatchPopover, SliderField, …) must not ride along into the page editor's first load
// (master plan §2.8: Easy path cost ≤ 5 KB gz). index.ts re-exports it.

import type { ProEditPart } from '../../../../shared/comic/pro/types';

export const part: ProEditPart = { id: 'kit', ready: true };
