/**
 * Projections (plan §5.5): one tool definition, every agent surface.
 *
 * - `toChatSpec(tool)`: `{name, description, parameters}`, the shape a chat tool registers (OpenAI-compatible;
 *   `toToolSpec` wraps it as `{type:'function', function}`).
 * - `toDirectorSpec(tool)`: the same with the cost prefix a studio director's model reads ("FREE — ", "TEXT ≈$0.01 — ",
 *   "PAID (quoted) — "). Model-facing only: never shown to a governed user.
 * - `toMcpTool(tool)`: an MCP tool. External writes are never exposed over MCP.
 * - `bindTools(manifest, ports)`: the host's executable tools, each call checked, gated, metered and audited.
 *
 * Every model-facing schema is the `llm` projection (flat, no `oneOf`), so a field with two JSON types across
 * variants throws at definition time, not in a model call.
 */
import type { CheckError, JsonSchema } from '../contract/schema.js';
import { check, toJsonSchema } from '../schema/index.js';
import type { ProductManifest } from '../products.js';
import { decideGate, mayRunNow } from '../gates/gates.js';
import type { GateDecision, HostPolicy } from '../gates/gates.js';
import { JOB_FLOOR_HEAVY_USD, JOB_FLOOR_USD } from '../gates/ports.js';
import type { MeterPort, MeterReserveResult, MeterSettleResult } from '../gates/ports.js';
import { auditEvent } from '../audit/event.js';
import type { AuditDecision, AuditOutcome, AuditPort } from '../audit/event.js';
import { inputHash } from '../audit/inputHash.js';
import { getPlatformTool } from './registry.js';
import type { AnyPlatformTool, PlatformToolName, PlatformWave, ToolCost } from './types.js';
import { CURRENT_WAVE } from './types.js';

// ── Specs ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** What a chat tool registers: `{name, description, parameters}`. */
export interface ChatToolSpec {
  name: string;
  description: string;
  parameters: JsonSchema;
}

/** The OpenAI-compatible function spec. */
export interface FunctionToolSpec {
  type: 'function';
  function: ChatToolSpec;
}

const LLM_CACHE = new WeakMap<object, JsonSchema>();

const llmParameters = (tool: AnyPlatformTool): JsonSchema => {
  let out = LLM_CACHE.get(tool);
  if (!out) {
    out = toJsonSchema(tool.input, { target: 'llm' });
    LLM_CACHE.set(tool, out);
  }
  return JSON.parse(JSON.stringify(out)) as JsonSchema; // a fresh copy: callers may annotate it
};

export const toChatSpec = (tool: AnyPlatformTool): ChatToolSpec => ({ name: tool.name, description: tool.description, parameters: llmParameters(tool) });

export const toToolSpec = (tool: AnyPlatformTool): FunctionToolSpec => ({ type: 'function', function: toChatSpec(tool) });

/** A studio director's cost classes and their description prefixes (the director registry's own wording). */
export type DirectorCost = 'free' | 'text' | 'paid';

export const DIRECTOR_COST_PREFIX: { readonly [C in DirectorCost]: string } = {
  free: 'FREE — ',
  text: 'TEXT ≈$0.01 — ',
  paid: 'PAID (quoted) — ',
};

/** Engine jobs reserve and settle through the ledger, so a director quotes them like any paid call. */
export const directorCostOf = (cost: ToolCost): DirectorCost => (cost === 'free' ? 'free' : cost === 'text' ? 'text' : 'paid');

export interface DirectorToolSpec {
  spec: FunctionToolSpec;
  cost: DirectorCost;
}

export const toDirectorSpec = (tool: AnyPlatformTool): DirectorToolSpec => {
  const cost = directorCostOf(tool.cost);
  const prefix = DIRECTOR_COST_PREFIX[cost];
  const spec = toToolSpec(tool);
  if (!spec.function.description.startsWith(prefix)) spec.function.description = `${prefix}${spec.function.description}`;
  return { spec, cost };
};

export interface McpTool {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  annotations: { readOnlyHint: boolean; destructiveHint: false; openWorldHint: false };
}

export class ToolProjectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolProjectionError';
  }
}

/** An MCP tool. Throws `ToolProjectionError` for an external write: those never reach MCP. */
export const toMcpTool = (tool: AnyPlatformTool): McpTool => {
  if (tool.mode === 'external-write' || tool.gate === 'external-write' || tool.target === 'external') {
    throw new ToolProjectionError(`${tool.name} is an external write and is never exposed over MCP`);
  }
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: toJsonSchema(tool.input, { target: 'mcp' }),
    annotations: { readOnlyHint: tool.mode === 'read', destructiveHint: false, openWorldHint: false },
  };
};

/** The tools a product lists that have shipped by `wave` (default: this package's wave). */
export const toolsForProduct = (manifest: ProductManifest, wave: PlatformWave = CURRENT_WAVE): AnyPlatformTool[] => {
  const out: AnyPlatformTool[] = [];
  for (const name of manifest.tools) {
    const tool = getPlatformTool(name);
    if (tool && tool.wave <= wave) out.push(tool);
  }
  return out;
};

/** `tools/list` for a product: its shipped tools, external writes left out. */
export const mcpToolsFor = (manifest: ProductManifest, wave: PlatformWave = CURRENT_WAVE): McpTool[] =>
  toolsForProduct(manifest, wave)
    .filter((t) => t.mode !== 'external-write')
    .map(toMcpTool);

// ── Agent ops: the host owns `actor` ────────────────────────────────────────────────────────────────────────────

const isRecord = (v: unknown): v is { [k: string]: unknown } => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Before checking a model's arguments: for a tool whose input carries agent ops, delete every `actor` the model
 * wrote (a model can never claim to be the user). Returns a copy; the raw arguments are untouched.
 */
export const prepareAgentInput = (tool: AnyPlatformTool, raw: unknown): unknown => {
  if (!tool.agentOps || !isRecord(raw) || !Array.isArray(raw.ops)) return raw;
  const ops = raw.ops.map((op) => {
    if (!isRecord(op)) return op;
    const copy: { [k: string]: unknown } = {};
    for (const k of Object.keys(op)) if (k !== 'actor') copy[k] = op[k];
    return copy;
  });
  const out: { [k: string]: unknown } = {};
  for (const k of Object.keys(raw)) out[k] = raw[k];
  out.ops = ops;
  return out;
};

/** After checking: stamp `actor: 'agent'` on every op, host-side. */
export const stampAgentOps = <T>(tool: AnyPlatformTool, value: T): T => {
  if (!tool.agentOps || !isRecord(value) || !Array.isArray(value.ops)) return value;
  const out: { [k: string]: unknown } = {};
  for (const k of Object.keys(value)) out[k] = (value as { [k: string]: unknown })[k];
  out.ops = (value.ops as unknown[]).map((op) => (isRecord(op) ? { ...op, actor: 'agent' } : op));
  return out as T;
};

/** Parse (when a string), strip agent `actor`s, `check()` against the tool's input, run its `refine`, stamp ops. */
export const checkToolInput = (
  tool: AnyPlatformTool,
  raw: unknown,
): { ok: true; value: unknown; errors?: undefined } | { ok: false; errors: CheckError[]; value?: undefined } => {
  let args = raw;
  if (typeof raw === 'string') {
    try {
      args = raw.trim() ? JSON.parse(raw) : {};
    } catch {
      return { ok: false, errors: [{ path: '', code: 'type', message: 'The arguments are not valid JSON.' }] };
    }
  }
  const r = check(tool.input, prepareAgentInput(tool, args));
  if (r.ok === false) return { ok: false, errors: r.errors };
  const refined = tool.refine ? tool.refine(r.value) : [];
  if (refined.length) return { ok: false, errors: refined };
  return { ok: true, value: stampAgentOps(tool, r.value) };
};

// ── bindTools ───────────────────────────────────────────────────────────────────────────────────────────────────

export interface ToolHandlerContext {
  tool: PlatformToolName;
  decision: GateDecision;
  inputHash: string;
  userId?: string;
  reservationId?: string;
  /** Report what the call really cost (USD); the reservation settles to it (default: the reserved floor). */
  reportCostUsd(usd: number): void;
  signal?: { readonly aborted: boolean };
}

/**
 * The host's own implementation of a tool. For an external write it PREPARES the draft action a person approves
 * later and never writes (the write happens only in the host's click route, through `executeExternalWrite`).
 */
export type ToolHandler = (input: unknown, ctx: ToolHandlerContext) => Promise<unknown>;

export interface BindToolsPorts {
  handlers: { [name: string]: ToolHandler | undefined };
  /** The user's policy (default: the manifest's). */
  policy?: HostPolicy;
  /**
   * The user's ledger. REQUIRED when any bound tool reserves (`needsMeter`: gate `quota` or `spend`, cost `job`,
   * `job-heavy` or `paid`): `bindTools` throws without it, so such a tool can never run unmetered. Fails closed for a
   * governed user.
   */
  meter?: MeterPort;
  audit?: AuditPort;
  /** Unix ms. */
  now(): number;
  newId(): string;
}

export interface ToolCallContext {
  /** The signed-in user, stamped by the host. */
  userId?: string;
  /** Calls of this tool already made in this model turn. */
  callsThisTurn?: number;
  /** What this call may cost (USD). */
  estimateUsd?: number;
  /** What this turn has spent so far (USD). */
  turnSpendUsd?: number;
  /**
   * The person approved exactly this call (the host's approve route re-runs it with the same arguments). Unlocks
   * `spend-confirm` and `propose` for the same input hash; never `confirm` (an external write needs a consent record).
   */
  approved?: { decision: 'spend-confirm' | 'propose'; inputHash: string };
  signal?: { readonly aborted: boolean };
}

/**
 * `settleFailed`: the ledger could not settle or release this call's reservation (it threw or answered `{ok:false}`),
 * so the hold is stranded until the host's reconciliation closes it; audited as `settle-failed` / `release-failed`.
 */
export type ToolCallOutcome =
  | { status: 'ok'; output: unknown; decision: GateDecision; inputHash: string; settleFailed?: true }
  | { status: 'invalid'; errors: CheckError[] }
  /** Nothing ran (or, for an external write, only the draft action was prepared): ask the person. */
  | { status: 'needs-approval'; decision: 'spend-confirm' | 'propose' | 'confirm'; inputHash: string; input: unknown; output?: unknown }
  | { status: 'refused'; code: 'forbidden' | 'quota' | 'disabled'; reason: string; message: string }
  | { status: 'failed'; code: 'engine-failed' | 'invalid'; message: string; settleFailed?: true };

export interface BoundTool {
  name: PlatformToolName;
  tool: AnyPlatformTool;
  spec: ChatToolSpec;
  run(args: unknown, ctx?: ToolCallContext): Promise<ToolCallOutcome>;
}

const opIdsOf = (value: unknown): string[] => {
  if (!isRecord(value) || !Array.isArray(value.ops)) return [];
  const out: string[] = [];
  for (const op of value.ops) if (isRecord(op) && typeof op.id === 'string') out.push(op.id);
  return out;
};

const floorFor = (cost: ToolCost): number => (cost === 'job-heavy' ? JOB_FLOOR_HEAVY_USD : JOB_FLOOR_USD);

/**
 * Does a call of `tool` reserve on the user's ledger before it runs? Engine jobs (`job`, `job-heavy`), quoted paid
 * calls (`paid`) and every `quota` or `spend` gate: their spend must reach the ledger, and with it down a governed user
 * fails closed (plan §5.6). Text and free tools ride on the already metered model turn.
 */
export const needsMeter = (tool: { cost: string; gate: string }): boolean =>
  tool.gate === 'quota' || tool.gate === 'spend' || tool.cost === 'job' || tool.cost === 'job-heavy' || tool.cost === 'paid';

/**
 * The host's executable tools for `manifest`: every tool the product lists, shipped by `options.wave`, that has a
 * handler. A handler for a tool the product does not list, or a metered tool (`needsMeter`) bound without
 * `ports.meter`, is a configuration error (throws). Each call: parse → strip agent `actor`s → `check()` + refine →
 * stamp ops → `maxPerTurn` → `decideGate` → (metered: reserve the floor or the estimate) → handler → `check()` the
 * output → settle/release (a failure is flagged and audited) → one content-free audit event.
 */
export const bindTools = (manifest: ProductManifest, ports: BindToolsPorts, options: { wave?: PlatformWave } = {}): BoundTool[] => {
  for (const name of Object.keys(ports.handlers)) {
    if (ports.handlers[name] && manifest.tools.indexOf(name as PlatformToolName) === -1) {
      throw new ToolProjectionError(`a handler for ${name}, which product ${manifest.id} does not list`);
    }
  }
  const policy = ports.policy || manifest.policy;
  const tools = toolsForProduct(manifest, options.wave === undefined ? CURRENT_WAVE : options.wave);
  for (const tool of tools) {
    if (ports.handlers[tool.name] && needsMeter(tool) && !ports.meter) {
      throw new ToolProjectionError(`${tool.name} reserves on the user's ledger (gate ${tool.gate}, cost ${tool.cost}); bind it with ports.meter`);
    }
  }
  const bound: BoundTool[] = [];
  for (const tool of tools) {
    const handler = ports.handlers[tool.name];
    if (!handler) continue;
    const audit = (ctx: ToolCallContext, hash: string, value: unknown, decision: AuditDecision, outcome: AuditOutcome, errorCode?: string, costUsd?: number): void => {
      if (!ports.audit) return;
      try {
        const event = auditEvent({
          id: ports.newId(),
          at: ports.now(),
          app: manifest.app,
          product: manifest.id,
          actor: ctx.userId ? { kind: 'agent', id: ctx.userId } : { kind: 'agent' },
          tool: tool.name,
          capability: tool.capability,
          decision,
          inputHash: hash,
          opIds: opIdsOf(value),
          outcome,
          errorCode,
          costMicros: costUsd !== undefined && costUsd > 0 ? Math.round(costUsd * 1000000) : undefined,
        });
        void Promise.resolve(ports.audit.record(event)).catch(() => undefined);
      } catch {
        // auditing never breaks the call
      }
    };

    const run = async (args: unknown, ctx: ToolCallContext = {}): Promise<ToolCallOutcome> => {
      const checked = checkToolInput(tool, args);
      if (checked.ok === false) {
        audit(ctx, inputHash(null), undefined, 'auto', 'refused', 'invalid');
        return { status: 'invalid', errors: checked.errors };
      }
      const value = checked.value;
      const hash = inputHash(value);
      if (tool.maxPerTurn !== undefined && (ctx.callsThisTurn || 0) >= tool.maxPerTurn) {
        audit(ctx, hash, value, 'blocked', 'refused', 'max-per-turn');
        return { status: 'refused', code: 'forbidden', reason: 'max-per-turn', message: `${tool.title}: at most ${tool.maxPerTurn} per turn.` };
      }
      const decision = decideGate({ tool, policy, estimateUsd: ctx.estimateUsd, turnSpendUsd: ctx.turnSpendUsd, target: tool.target });
      if (decision === 'deny') {
        audit(ctx, hash, value, 'blocked', 'refused', 'gate-deny');
        return { status: 'refused', code: 'forbidden', reason: 'gate-deny', message: 'This action is not allowed.' };
      }
      const approved = !!ctx.approved && ctx.approved.inputHash === hash && ctx.approved.decision === decision;
      const handlerCtx = (reservationId?: string) => {
        let reported: number | undefined;
        const c: ToolHandlerContext = {
          tool: tool.name,
          decision,
          inputHash: hash,
          reportCostUsd: (usd: number) => {
            if (typeof usd === 'number' && isFinite(usd) && usd >= 0) reported = usd;
          },
        };
        if (ctx.userId) c.userId = ctx.userId;
        if (reservationId) c.reservationId = reservationId;
        if (ctx.signal) c.signal = ctx.signal;
        return { c, cost: () => reported };
      };

      if (decision === 'confirm') {
        // An external write: the handler may only PREPARE the draft action; nothing is written here.
        if (tool.mode !== 'external-write') {
          audit(ctx, hash, value, 'auto', 'pending');
          return { status: 'needs-approval', decision, inputHash: hash, input: value };
        }
        try {
          const prepared = await handler(value, handlerCtx().c);
          const out = check(tool.output, prepared);
          if (out.ok === false) return { status: 'failed', code: 'invalid', message: `${tool.name} prepared an invalid draft action.` };
          audit(ctx, hash, value, 'auto', 'pending');
          return { status: 'needs-approval', decision, inputHash: hash, input: value, output: out.value };
        } catch (error) {
          audit(ctx, hash, value, 'auto', 'failed', 'engine-failed');
          return { status: 'failed', code: 'engine-failed', message: error instanceof Error && error.message ? error.message.slice(0, 200) : 'The tool failed.' };
        }
      }
      if (!mayRunNow(decision) && !approved) {
        audit(ctx, hash, value, 'auto', 'pending');
        return { status: 'needs-approval', decision: decision as 'spend-confirm' | 'propose', inputHash: hash, input: value };
      }

      let reservationId: string | undefined;
      const metered = needsMeter(tool);
      const heldUsd = Math.max(floorFor(tool.cost), typeof ctx.estimateUsd === 'number' && isFinite(ctx.estimateUsd) && ctx.estimateUsd > 0 ? ctx.estimateUsd : 0);
      const decidedBy: AuditDecision = approved ? 'confirmed' : 'auto';
      /** Settle (or release) the hold; false when the ledger threw or answered {ok:false}: audited, never hidden. */
      const closeHold = async (id: string, settleUsd: number | undefined): Promise<boolean> => {
        const meter = ports.meter as MeterPort;
        let closed: MeterSettleResult | undefined;
        try {
          closed =
            settleUsd !== undefined
              ? await meter.settle(id, { actualUsd: settleUsd, metadata: { platform: { app: manifest.app, product: manifest.id, tool: tool.name, capability: tool.capability, inputHash: hash } } })
              : await meter.release(id, { reason: 'tool-failed' });
        } catch {
          closed = undefined;
        }
        if (closed && closed.ok !== false) return true;
        audit(ctx, hash, value, decidedBy, 'failed', settleUsd !== undefined ? 'settle-failed' : 'release-failed', settleUsd);
        return false;
      };
      if (metered && ports.meter) {
        let r: MeterReserveResult;
        try {
          r = await ports.meter.reserve({
            operation: `platform_${tool.name}`,
            estimateFloorUsd: heldUsd,
            metadata: { platform: { app: manifest.app, product: manifest.id, tool: tool.name, capability: tool.capability, inputHash: hash } },
          });
        } catch {
          r = { ok: false, code: 'unavailable', message: 'The usage ledger did not answer.' };
        }
        if (r.ok === false) {
          if (r.code === 'quota' || ports.meter.governed) {
            audit(ctx, hash, value, 'blocked', 'refused', r.code === 'quota' ? 'quota' : 'ledger-down');
            return r.code === 'quota'
              ? { status: 'refused', code: 'quota', reason: 'quota', message: 'Not enough usage left for this.' }
              : { status: 'refused', code: 'disabled', reason: 'ledger-down', message: 'Usage could not be checked right now. Try again in a moment.' };
          }
        } else reservationId = r.reservationId;
      }

      const h = handlerCtx(reservationId);
      let output: unknown;
      try {
        output = await handler(value, h.c);
      } catch (error) {
        const released = reservationId ? await closeHold(reservationId, undefined) : true;
        audit(ctx, hash, value, decidedBy, 'failed', 'engine-failed');
        const failed: ToolCallOutcome = { status: 'failed', code: 'engine-failed', message: error instanceof Error && error.message ? error.message.slice(0, 200) : 'The tool failed.' };
        if (!released) failed.settleFailed = true;
        return failed;
      }
      const out = check(tool.output, output);
      // What the call cost: what the handler reported, else the whole hold (the quote it ran under).
      const spent = h.cost() !== undefined ? (h.cost() as number) : reservationId ? heldUsd : undefined;
      const settled = reservationId ? await closeHold(reservationId, spent || 0) : true;
      if (out.ok === false) {
        audit(ctx, hash, value, decidedBy, 'failed', 'invalid-output', spent);
        const failed: ToolCallOutcome = { status: 'failed', code: 'invalid', message: `${tool.name} returned an output that does not match its schema.` };
        if (!settled) failed.settleFailed = true;
        return failed;
      }
      audit(ctx, hash, value, decidedBy, 'ok', undefined, spent);
      const ok: ToolCallOutcome = { status: 'ok', output: out.value, decision, inputHash: hash };
      if (!settled) ok.settleFailed = true;
      return ok;
    };

    bound.push({ name: tool.name, tool, spec: toChatSpec(tool), run });
  }
  return bound;
};
