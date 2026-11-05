// Client feature module "editor" (pro plan §10 Wave 3; C7 SHELL (with C1 STAGE, C3 SAVE's editor/history and C4–C6 mounts)). STUB with a fixed export name (K2b): its package replaces
// it in place and owns this folder from the moment K2b merges (pro plan §10 stub rule).
//
// Builds: the pro editor: stage, panels, inspector, layers, asset bin, template picker (pro plan §4.5).
// The stub registers nothing, so features.ts leaves it out of featureModules() and every registry is exactly what it
// was: no card, tab, header slot or admin section, no UI rendered, every Ship 2 flag off.

import type { FeatureModule } from '../extensions';

export const feature: FeatureModule = {};
