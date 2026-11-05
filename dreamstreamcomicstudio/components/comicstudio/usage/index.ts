// Client feature module: the "usage left" meter in the Comic Studio header (P1-LIMITS).
// Registered through ../features.ts (contract §13.2) — the lead adds this folder there.

import type { FeatureModule } from '../extensions';
import { USAGE_SLOT_ORDER, UsageSlot } from './UsageSlot';

export const feature: FeatureModule = {
  headerSlots: [{ id: 'usage', order: USAGE_SLOT_ORDER, Component: UsageSlot }]
};

export { USAGE_SLOT_ORDER, UsageSlot } from './UsageSlot';
