// Client feature module "consistency" (pro plan §10 Wave 3; C5 LOOKBOOK). STUB with a fixed export name (K2b): its package replaces
// it in place and owns this folder from the moment K2b merges (pro plan §10 stub rule).
//
// Builds: the look book: anchor chips, the breakdown's ticked anchor line items, findings, panel details, continuity, scene bands, the Enrich card (pro plan §4.6).
// The stub registers nothing, so features.ts leaves it out of featureModules() and every registry is exactly what it
// was: no card, tab, header slot or admin section, no UI rendered, every Ship 2 flag off.

import type { FeatureModule } from '../extensions';

export const feature: FeatureModule = {};
