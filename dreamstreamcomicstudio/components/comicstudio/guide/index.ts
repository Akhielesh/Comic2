// Client feature module "guide" (pro plan §10 Wave 3; C6 GUIDE). STUB with a fixed export name (K2b): its package replaces
// it in place and owns this folder from the moment K2b merges (pro plan §10 stub rule).
//
// Builds: the guided first comic and the editor tour (pro plan §4.6).
// The stub registers nothing, so features.ts leaves it out of featureModules() and every registry is exactly what it
// was: no card, tab, header slot or admin section, no UI rendered, every Ship 2 flag off.

import type { FeatureModule } from '../extensions';

export const feature: FeatureModule = {};
