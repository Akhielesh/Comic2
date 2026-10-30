// Comic History — the session seam (versions plan §4.1; package H0 stub, H2 replaces the body of createHistoryHooks).
//
// StudioSession holds one HistoryHooks per open comic:
//   onCommit(before, next, ops, origin, label)  called in commit(); SYNCHRONOUS bookkeeping only (touchedKeys, actor,
//                                               AI-run coalescing). Holding `before` costs nothing: docs are immutable.
//   onFlush(doc, {final})                       awaited at the end of flush(); final:true from the sweeper's eviction
//                                               and from shutdown ("Where you left off").
//   onLoad(doc)                                 after getStudioSession hydrated the doc ("History starts here").
//   onImported(info)                            once, when POST /projects imported a classic comic (H6).
// Failures are logged as `comic_history_capture_failed` and NEVER throw into a save, a turn or a render (the session
// wraps every call). Restore is the only history path that requires a successful write (H3).
//
// With COMIC_HISTORY unset (the default) the hooks are the no-op NOOP_HISTORY_HOOKS: behaviour is byte-identical to
// a studio without history. Nothing here imports a store, an LLM, an image client or billing.

import { HISTORY_ENV, historyFlagOn } from '../../../../shared/comic/capabilities.js';
import type { ComicDoc } from '../../../../shared/comic/doc.js';
import { normalizeTimeZone, type OpsOrigin } from '../../../../shared/comic/events.js';
import type { DocOp } from '../../../../shared/comic/ops.js';
import { StudioError } from '../types.js';

/** Whose history: every history read and write is scoped by project AND user (§12). */
export interface HistoryScope {
  projectId: string;
  userId: string;
}

/** POST /projects imported a classic comic (optionally one of its snapshots). */
export interface HistoryImported extends HistoryScope {
  doc: ComicDoc;
  fromProjectId: string;
  fromVersionId?: string;
}

export interface HistoryHooks {
  /** True once these hooks really record rows (H2). The archive-eviction notice says "History still keeps them"
   *  only then — never a claim the stub can't keep. */
  readonly recording: boolean;
  onCommit(before: ComicDoc, next: ComicDoc, ops: DocOp[], origin: OpsOrigin | undefined, label: string | undefined): void;
  onFlush(doc: ComicDoc, opts: { final: boolean }): void | Promise<void>;
  onLoad(doc: ComicDoc): void | Promise<void>;
  onImported?(info: HistoryImported): void | Promise<void>;
}

/** The hooks of a studio without history: every call is a no-op (H0). */
export const NOOP_HISTORY_HOOKS: HistoryHooks = Object.freeze({
  recording: false,
  onCommit() {},
  onFlush() {},
  onLoad() {},
  onImported() {}
});

/** Comic History is on for this server (env COMIC_HISTORY=1 / true; set only after the client ships and H1's SQL). */
export const isHistoryEnabled = (env: Readonly<Record<string, string | undefined>> = process.env): boolean => historyFlagOn(env[HISTORY_ENV]);

/**
 * The history hooks of one comic session. H0 STUB: always NOOP_HISTORY_HOOKS. H2 returns the recorder when
 * isHistoryEnabled() and a store is configured (keep this name and signature).
 */
export function createHistoryHooks(_scope: HistoryScope): HistoryHooks {
  return NOOP_HISTORY_HOOKS;
}

/** What a history path that is not built yet answers: nothing changed, nothing spent (code NOT_AVAILABLE, 501). */
export const HISTORY_NOT_AVAILABLE_MESSAGE = "History isn't available yet — nothing in your comic changed.";
export const historyNotAvailable = (): StudioError => new StudioError('NOT_AVAILABLE', HISTORY_NOT_AVAILABLE_MESSAGE, { status: 501 });

// ── The request's time zone, on the turn context ─────────────────────────────
// routes/comic.ts remembers the stream request's validated `tz` on the turn's StudioContext; the director's history
// tools (H4) read it for "this morning" / "yesterday" (shared/comic/history/when.ts). A WeakMap, so it never leaks
// past the request and no shared type had to grow a field.

const turnZones = new WeakMap<object, string>();

/** Remember the request's IANA time zone on its context (an invalid zone is ignored). Returns the zone kept. */
export const rememberTurnTimeZone = (ctx: object | null | undefined, tz: unknown): string | undefined => {
  const zone = normalizeTimeZone(tz);
  if (ctx && zone) turnZones.set(ctx, zone);
  return zone;
};

/** The time zone the request that created `ctx` sent (undefined: use UTC and say so). */
export const turnTimeZone = (ctx: object | null | undefined): string | undefined => (ctx ? turnZones.get(ctx) : undefined);
