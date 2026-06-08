// Global kill switch + enablement gate for the Autopilot loop. Epic A0.
//
// The entire Autopilot layer is OFF unless VENTURES_ENABLED is true AND the kill switch is
// off. The default kill state comes from env (VENTURES_KILL); an in-process override lets an
// admin flip it at runtime (a future /api/ventures/admin/kill route) without a redeploy.
// The scheduler MUST consult isVentureLoopHalted() before every tick.

import { VENTURES_ENABLED, VENTURES_KILL } from '../config.js';

let killOverride: boolean | null = null; // null = use the env default

/** Set a runtime kill override (true = kill, false = force-allow, null = use env default). */
export const setKillSwitch = (value: boolean | null): void => {
  killOverride = value;
};

/** Current effective kill state (runtime override wins over env default). */
export const getKillSwitch = (): boolean => (killOverride === null ? VENTURES_KILL : killOverride);

/** Clear the runtime override and fall back to the env default. */
export const resetKillSwitch = (): void => {
  killOverride = null;
};

export interface LoopGateState {
  enabled: boolean; // VENTURES_ENABLED
  killed: boolean; // kill switch on
}

/** Pure: may the autonomous loop run given this gate state? */
export const isVentureLoopAllowed = (state: LoopGateState): boolean =>
  state.enabled === true && state.killed !== true;

/** Live check against current config + runtime override. The scheduler calls this per tick. */
export const isVentureLoopHalted = (): boolean =>
  !isVentureLoopAllowed({ enabled: VENTURES_ENABLED, killed: getKillSwitch() });
