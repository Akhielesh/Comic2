// Client feature module: provider/model health (reliability.md §3 — useModelStatus, ModelStatusBanner, the
// `model_outage` chat card, the quiet failed-tile state, ModelHealthDot; §4 admin "Provider status"; owner
// M1-RELIABILITY). W-M seam: registered in ../features.ts by the lead; empty until M1-RELIABILITY fills it.
// When filled: the card registers as `{ type: 'model_outage' }`; nothing here polls while every model is ok.

import type { FeatureModule } from '../extensions';

export const feature: FeatureModule = {};
