// Translation seams (contract §12.8, i18n.md). Wave-0 stub by P0-B; owned in wave 1 by
// P1-I18N, which replaces both functions IN PLACE (same names, same signatures).
//
// `translate` is a SPEND action: actions/i18n.ts calls estimateTranslation for the quote
// and runTranslation once the gate clears (writer-class translator + automated linguist
// review, always). Stub behaviour: both throw StudioError NOT_AVAILABLE (501).

import type { SpendAction } from '../../../../shared/comic/ops.js';
import type { SpendEstimate } from '../../../../shared/comic/models.js';
import type { TranslationPlan } from '../../../../shared/comic/translationPlan.js';
import { notAvailableError } from '../extensions.js';
import type { RunActionOptions, StartedAction } from '../jobs.js';
import type { StudioContext } from '../types.js';

const TRANSLATION_UNAVAILABLE = "Translation isn't available yet.";

/** Quote a translation (per-language plans; $0 lines are free). */
export async function estimateTranslation(
  _ctx: StudioContext,
  _action: Extract<SpendAction, { type: 'translate' }>
): Promise<SpendEstimate & { plans: TranslationPlan[] }> {
  throw notAvailableError(TRANSLATION_UNAVAILABLE);
}

/** Run an approved translation (background; `done` settles when every edition finished). */
export async function runTranslation(
  _ctx: StudioContext,
  _action: Extract<SpendAction, { type: 'translate' }>,
  _opts: RunActionOptions
): Promise<StartedAction> {
  throw notAvailableError(TRANSLATION_UNAVAILABLE);
}
