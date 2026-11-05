// Panelization on the server (pro plan §4.3 B2). STUB with fixed export names (K2b): B2 replaces the bodies in place and
// owns this file from the moment K2b merges (pro plan §10 stub rule). Every body is a no-op, so behaviour is unchanged.
//
// Seam: jobs.ts letterPage calls panelizeAfterLetter after it committed a fresh page check (never on a reused image).
// The ops it returns are committed as the job's own ('job' origin): server-stamped cuts on the CURRENT drawing in
// shadow mode, plus frames and artMode 'panels' only when COMIC_AUTO_PANELIZE is on and the cuts are clean (PD-4).
// It must never throw and never hang a paid run: jobs.ts catches and logs whatever it does.

import type { QcReport } from '../../../../shared/comic/doc.js';
import type { DocOp } from '../../../../shared/comic/ops.js';
import type { StudioContext } from '../types.js';

/** The rollout flag (pro plan §4.8; off: shadow mode stores cuts only). */
export const AUTO_PANELIZE_FLAG = 'COMIC_AUTO_PANELIZE';

/** Whether new pages switch to panels mode by themselves (PD-4: off until the hidden test shows ≥ 80% clean detection). */
export const autoPanelizeEnabled = (env: Record<string, string | undefined> = process.env): boolean => env[AUTO_PANELIZE_FLAG] === '1';

export interface PanelizeInput {
  pageId: string;
  /** The drawing the check just read (render.asset.path): cuts are stamped for this path only. */
  path: string;
  /** The drawing itself (the data URL letterPage already holds; detection works on a 640 px grey copy). */
  dataUrl: string;
  /** The page check that just landed (seeds the detector with its panel boxes). */
  qc?: QcReport;
  signal: AbortSignal;
}

/** Detect → map → tidy the drawing's panels; the ops to commit (none = nothing to do). STUB: nothing. */
export async function panelizeAfterLetter(_ctx: StudioContext, _input: PanelizeInput): Promise<DocOp[]> {
  return [];
}
