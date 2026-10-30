// Comic Studio v5 extension seams (contract §12.1; created in wave 0 by P0-B, FROZEN).
//
// Every feature plugs into the director, the job runner and the patch validator through
// three registries — one file each, every feature listed there exactly once:
//
//   tools/index.ts     TOOL_GROUPS      director tool groups (phase-gated, priority-trimmed)
//   actions/index.ts   ACTION_HANDLERS  non-core StudioAction types (jobs.ts startAction)
//   sanitize/index.ts  OP_SANITIZERS    non-core client-patchable ops (jobs.ts sanitizePatchOps)
//
// Feature modules replace their stub IN PLACE (same exported name and type), so consumers
// integrate automatically and typecheck stays green at every merge.
//
// Import rule for feature modules (ESM cycles): import RUNTIME helpers from this file, the
// shared contract and leaf modules freely. Importing `../jobs.js` / `../tools.js` at runtime
// is allowed (the registries resolve lazily, so a cycle can never hit an uninitialised
// binding), but never read another module's exports at the TOP LEVEL of a feature module.

import type { Request, RequestHandler, Response } from 'express';
import { newId, type Card, type ComicDoc, type Msg } from '../../../shared/comic/doc.js';
import type { DocOp, StudioAction } from '../../../shared/comic/ops.js';
import type { SpendEstimate } from '../../../shared/comic/models.js';
import type { StudioCaps } from '../../../shared/comic/capabilities.js';
import type { ContentRating } from '../../../shared/comic/safety.js';
import type { ToolSpec } from '../ai/providers/types.js';
import { logger } from '../lib/logger.js';
import type { RunActionOptions, StartedAction } from './jobs.js';
import type { DirectorTurn } from './tools.js';
import { StudioError, type StudioContext } from './types.js';

// ── Director tools ───────────────────────────────────────────────────────────

export type ToolCost = 'free' | 'text' | 'paid';

/**
 * One director tool. `define()` / `defineTool()` prefix the description with its cost
 * ("FREE — …", "TEXT ≈$0.01 — …", "PAID (quoted) — …") so the model can follow the
 * "free first" rule without a lookup table.
 */
export interface DirectorTool {
  spec: ToolSpec;
  cost: ToolCost;
  execute(args: Record<string, unknown>): Promise<string>;
}

export type ToolGroupId = 'core' | 'lettering' | 'timeline' | 'breakdown' | 'safety' | 'publish' | 'i18n' | 'refs' | 'library' | 'reader' | 'models' | 'history';

export interface ToolGroup {
  id: ToolGroupId;
  /** Phase gate (keeps the per-turn tool list ≤ MAX_TOOLS_PER_TURN for the Flash-class director). */
  when?(ctx: StudioContext, turn: DirectorTurn): boolean;
  /** Lower = kept first when trimming. Core is 0 and always kept. */
  priority: number;
  tools(ctx: StudioContext, turn: DirectorTurn): DirectorTool[];
  /** Appended to DIRECTOR_SYSTEM_PROMPT when the group is active. */
  promptRules?(doc: ComicDoc): string | undefined;
  /** Extra DOC SUMMARY lines ("Lettering: preset storybook…", "Published: unlisted · 1 edit behind"). */
  summaryLines?(doc: ComicDoc, turn: DirectorTurn): string[];
  /** TOOL_ACTIVITY labels for the live status line. */
  activity?: Record<string, string>;
}

/** Hard ceiling on tools offered in one director turn (core included). */
export const MAX_TOOLS_PER_TURN = 30;

/** Description prefixes per cost class (contract §12.1). */
export const TOOL_COST_PREFIX: Readonly<Record<ToolCost, string>> = {
  free: 'FREE — ',
  text: 'TEXT ≈$0.01 — ',
  paid: 'PAID (quoted) — '
};

/** The description the model sees for a tool of this cost (idempotent). */
export const withCostPrefix = (description: string, cost: ToolCost): string => {
  const prefix = TOOL_COST_PREFIX[cost] ?? '';
  return !prefix || description.startsWith(prefix) ? description : `${prefix}${description}`;
};

/** A bad tool argument: comes back to the model as "Error: <message>" so it can correct itself. */
export class ToolArgError extends Error {}
export const toolArgError = (message: string): ToolArgError => new ToolArgError(message);

/** What a failed tool call says to the model. Never leaks internals. */
export const toolErrorText = (err: unknown): string => {
  if (err instanceof ToolArgError) return `Error: ${err.message}`;
  if (err instanceof StudioError) return `Error: ${err.userMessage}`;
  logger.warn('comic_tool_unexpected_error', { message: (err as Error)?.message });
  return 'Error: that did not work. Try again with simpler arguments.';
};

const isPlainObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/**
 * Build a director tool. Tools never throw: argument problems (ToolArgError) and studio
 * errors become an "Error: …" sentence the model can act on.
 * `prefix: false` keeps the description verbatim (core tools until P1-DIRECTOR switches them).
 */
export function defineTool(
  name: string,
  cost: ToolCost,
  description: string,
  parameters: Record<string, unknown>,
  run: (args: Record<string, unknown>) => Promise<string> | string,
  opts: { prefix?: boolean } = {}
): DirectorTool {
  return {
    spec: { type: 'function', function: { name, description: opts.prefix === false ? description : withCostPrefix(description, cost), parameters } },
    cost,
    async execute(args) {
      try {
        return await run(isPlainObject(args) ? args : {});
      } catch (err) {
        return toolErrorText(err);
      }
    }
  };
}

// ── Actions ──────────────────────────────────────────────────────────────────

export interface ActionHandler<A extends StudioAction = StudioAction> {
  type: A['type'];
  /** true for SPEND_ACTION_TYPES (they go through estimate → gateDecision → runner). */
  spend: boolean;
  estimate?(ctx: StudioContext, action: A): Promise<SpendEstimate>;
  run(ctx: StudioContext, action: A, opts: RunActionOptions): Promise<StartedAction>;
}

// ── Client patch sanitizers ──────────────────────────────────────────────────

export interface SanitizeCtx {
  userId: string;
  caps: StudioCaps;
  rating: ContentRating;
  now: number;
}

export interface OpSanitizer<O extends DocOp = DocOp> {
  op: O['op'];
  /** Return the op to commit (possibly rewritten: forced fields, stamps), or throw StudioError (400/409/422). */
  sanitize(doc: ComicDoc, op: O, ctx: SanitizeCtx): O;
}

/**
 * A whole-batch screen that runs AFTER every op was sanitized (P0-B addition to §12.1 for
 * the safety text pre-filter, which must see the ops of every feature). Returns the ops to
 * commit or throws StudioError (422 CONTENT_POLICY / 409 with a suggested rewrite).
 */
export type PatchScreen = (doc: ComicDoc, ops: DocOp[], ctx: SanitizeCtx) => DocOp[];

// ── Inert stub helpers (wave 0) ──────────────────────────────────────────────

export const NOT_AVAILABLE_MESSAGE = "That isn't available in the studio yet.";

/** StudioError NOT_AVAILABLE (default 501: not built yet; pass 503 when a dependency is down). */
export const notAvailableError = (message = NOT_AVAILABLE_MESSAGE, status = 501): StudioError =>
  new StudioError('NOT_AVAILABLE', message, { status });

/**
 * Inert action handler: tells the user (a notice in the director's message, or a new
 * assistant message for a UI tap) and resolves `blocked` with code NOT_AVAILABLE.
 */
export function notAvailableAction<A extends StudioAction>(type: A['type'], spend = false, message = NOT_AVAILABLE_MESSAGE): ActionHandler<A> {
  return {
    type,
    spend,
    async run(ctx, _action, opts) {
      const card: Card = { type: 'notice', id: newId('card'), tone: 'info', text: message };
      if (opts?.collectCard) opts.collectCard(card);
      else {
        const msg: Msg = { id: newId('msg'), role: 'assistant', text: message, at: Date.now(), cards: [card] };
        ctx.session.commit([{ op: 'message', msg }]);
      }
      return { outcome: { status: 'blocked', message, code: 'NOT_AVAILABLE' }, done: Promise.resolve() };
    }
  };
}

/** Inert sanitizer: the op is client-patchable in the contract but its feature isn't built yet (400). */
export function notAvailableSanitizer<O extends DocOp>(op: O['op']): OpSanitizer<O> {
  return {
    op,
    sanitize() {
      throw new StudioError('NOT_AVAILABLE', `“${op}” changes aren't available yet.`, { status: 400 });
    }
  };
}

/** Express handler answering 501 NOT_AVAILABLE in the studio's error shape. */
export const notAvailableHandler =
  (message = NOT_AVAILABLE_MESSAGE): RequestHandler =>
  (_req: Request, res: Response) => {
    res.status(501).json({ error: { message, code: 'NOT_AVAILABLE' } });
  };

// ── Registry plumbing (shared by the three index files) ──────────────────────

/**
 * A keyed registry that fills itself from feature lists. Filling is retried lazily when
 * a feature module is still initialising (an ESM import cycle), so a feature test that
 * imports its own module first can never crash the registry with a TDZ ReferenceError.
 */
export function createKeyedRegistry<T>(opts: {
  what: string;
  keyOf: (item: T) => string;
  lists: () => T[][];
  reserved?: ReadonlySet<string>;
}): { table: Record<string, T>; get(key: string): T | undefined; ensure(): void } {
  const table: Record<string, T> = Object.create(null);
  let ready = false;
  const ensure = () => {
    if (ready) return;
    for (const list of opts.lists()) {
      for (const item of list) {
        const key = opts.keyOf(item);
        if (opts.reserved?.has(key)) throw new Error(`[comic ${opts.what}] "${key}" is core and cannot be registered by a feature.`);
        const existing = table[key];
        if (existing && existing !== item) throw new Error(`[comic ${opts.what}] "${key}" is registered twice.`);
        table[key] = item;
      }
    }
    ready = true;
  };
  try {
    ensure();
  } catch (err) {
    if (!(err instanceof ReferenceError)) throw err;
    // Cyclic import still initialising a feature module: completes on first lookup.
  }
  return {
    table,
    get(key) {
      ensure();
      return typeof key === 'string' && Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;
    },
    ensure
  };
}
