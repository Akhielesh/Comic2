// Client feature module: the image-model picker, lock line and change confirm (models.md §3.6–§3.7, owner
// M1-PICKER-UI) and the admin-only Model Lab (M1-MODEL-LAB, under ./lab/**, registered as an admin section).
// W-M seam: registered in ../features.ts by the lead; empty until those packages fill it. The hotspot files
// never import from here directly — everything reaches them through the FeatureModule registries.

import type { FeatureModule } from '../extensions';

export const feature: FeatureModule = {};
