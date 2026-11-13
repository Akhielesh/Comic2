// Program 5 server flags (PROGRAM5 C-5): each is a stage, off | admins | all, read once per request from the server
// env. Unset or unreadable = 'off' = today's behaviour byte for byte (the Ramayana golden suite pins that). The words
// follow the house parser (shared/comic/capabilities.ts parseFlagStage): case and spaces ignored, 'everyone' = 'all',
// a bare switch ('on', 'true', '1', 'yes') admits admins only, and anything else reads as off.
//
// The client never reads these: a studio surface that needs one gets it through the caps access.ts fills (from W2,
// P5-K moves the studio's P5 stages into StudioCaps). Share-link readers have no caps, so they keep today's behaviour.
import { parseFlagStage, stageAllows, type FlagStage } from '../../../shared/comic/capabilities.js';

/** The env var behind each Program 5 server flag. */
export const P5_FLAG_ENV = {
  /** P5-TRUTH items 1–7: prompt and writer truth fixes (no fixed expression, colour words with codes, …). */
  storyFixes: 'COMIC_STORY_FIXES',
  /** P5-TRUTH item 8: pages of one scene draw one after another, each from the page before it. */
  runChains: 'COMIC_RUN_CHAINS',
  /** P5-QC: the page check, version 2 (acting, gaze, left/right, inscriptions; heads never collapse). */
  qcV2: 'COMIC_QC_V2'
} as const;
export type P5Flag = keyof typeof P5_FLAG_ENV;
export const P5_FLAGS = Object.keys(P5_FLAG_ENV) as P5Flag[];

type Env = Readonly<Record<string, string | undefined>>;

/**
 * The furthest stage a flag may reach in this build. Scene chains stop at 'admins' until three things hold: the owner
 * has accepted the longer wait (about +2 minutes for 10 pages in one scene), a colour check shows that drawing each page
 * from the one before does not drift (today pages 2 to 10 all share page 1 as their reference), and a chained page is
 * never drawn from a page whose safety verdict is still pending. Lifting this cap is a code change that comes with
 * those checks; setting COMIC_RUN_CHAINS=all alone admits admins only.
 */
export const P5_FLAG_MAX: Readonly<Partial<Record<P5Flag, FlagStage>>> = Object.freeze({ runChains: 'admins' });

/** One flag's stage. Unset, empty or unknown → 'off'; never past P5_FLAG_MAX. Pure; never throws. */
export const p5StageOf = (flag: P5Flag, env: Env = process.env): FlagStage => {
  const stage = parseFlagStage(env?.[P5_FLAG_ENV[flag]], 'off');
  return stage === 'all' && P5_FLAG_MAX[flag] === 'admins' ? 'admins' : stage;
};

/** Whether one flag is on for this user ('admins' needs isAdmin === true). */
export const p5FlagOn = (flag: P5Flag, isAdmin: boolean, env: Env = process.env): boolean =>
  stageAllows(p5StageOf(flag, env), isAdmin === true);

export type P5Flags = Readonly<Record<P5Flag, boolean>>;

/** Every Program 5 flag for one request, read once (pass the result down; never re-read env mid-job). */
export const p5FlagsFor = (isAdmin: boolean, env: Env = process.env): P5Flags =>
  Object.freeze(Object.fromEntries(P5_FLAGS.map((f) => [f, p5FlagOn(f, isAdmin, env)])) as Record<P5Flag, boolean>);

/** All off: today's behaviour. The default wherever no request (and so no user) is known. */
export const P5_FLAGS_OFF: P5Flags = Object.freeze(Object.fromEntries(P5_FLAGS.map((f) => [f, false])) as Record<P5Flag, boolean>);
