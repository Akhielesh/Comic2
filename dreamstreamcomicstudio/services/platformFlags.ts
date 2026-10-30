// Client edge of the shared-platform flags (shared/platform/flags.ts). VITE_PLATFORM_DOCS is a build var:
// unset on a Pages build means every platform surface (pitch deck, Word download, draft cards) stays hidden,
// for admins too. Pair it with the server's PLATFORM_DOCS when rolling out.
import { platformDocsAllowed, type PlatformStage } from '../shared/platform/flags';

export const platformDocsVisible = (isAdmin: boolean, stage?: PlatformStage): boolean =>
  platformDocsAllowed({ killSwitch: import.meta.env.VITE_PLATFORM_DOCS, isAdmin, stage });
