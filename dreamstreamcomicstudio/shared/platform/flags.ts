// Shared-platform rollout flags (docs/platform/README.md). Pure: no env reads here, so the server and the
// client can both import it. The kill switches are read at the edges: the server's PLATFORM_DOCS env
// (server/src/ai/tools/platformDocs.ts) and the client's VITE_PLATFORM_DOCS build var
// (services/platformFlags.ts). A kill switch that is not exactly 'on' hides every platform surface,
// whatever the stage.
import type { PlatformStage } from '../../packages/platform-core/src/capabilities.js';

export type { PlatformStage };

/** Who sees platform surfaces once a kill switch is on. Wave 1 ships to admins only. */
export const PLATFORM_DOCS_STAGE: PlatformStage = 'admins';

/** A kill-switch value turns platform surfaces on only when it is exactly 'on'. */
export const platformKillSwitchOn = (value: string | null | undefined): boolean => value === 'on';

/** Whether one user may see platform surfaces: the kill switch is on and the stage admits them. */
export const platformDocsAllowed = (input: {
  killSwitch: string | null | undefined;
  isAdmin: boolean;
  stage?: PlatformStage;
}): boolean => {
  if (!platformKillSwitchOn(input.killSwitch)) return false;
  const stage = input.stage ?? PLATFORM_DOCS_STAGE;
  return stage === 'everyone' || (stage === 'admins' && input.isAdmin);
};
