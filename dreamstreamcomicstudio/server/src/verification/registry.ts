// Built-in check registry. User-defined checks reference these via config.builtin.

import type { CheckImpl } from './types.js';
import { freeLabelIntegrity } from './checks/freeLabelIntegrity.js';
import { autorouterFreeInvariant } from './checks/autorouterFreeInvariant.js';
import { pricingFreshness } from './checks/pricingFreshness.js';
import { costReconciliation } from './checks/costReconciliation.js';
import { multiProviderCost } from './checks/multiProviderCost.js';
import { telemetryFailureSpike } from './checks/telemetryFailureSpike.js';

const BUILTINS: CheckImpl[] = [
  freeLabelIntegrity,
  autorouterFreeInvariant,
  pricingFreshness,
  costReconciliation,
  multiProviderCost,
  telemetryFailureSpike
];

export const getBuiltin = (id: string): CheckImpl | undefined =>
  BUILTINS.find((c) => c.builtinId === id);

export const listBuiltins = (): CheckImpl[] => [...BUILTINS];
