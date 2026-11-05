/**
 * Gates (plan §5.6): one pure decision, `decideGate`, for every tool call and every flow run, under the HOST's own
 * policy. Hosts own consent and money; the platform only says what a call needs before it may run.
 *
 * Floors no policy can lower (checked before the policy is read):
 * - an `external-write` (mode, gate or target) → `confirm` (a human click plus a `ConsentRecord`; see consent.ts);
 * - an edit of user content (any mode but `read`) → `propose`, and so does every `propose`-mode tool;
 * - a flow with `maxModelCalls > 1` → `propose` (its plan is approved once per run) unless the user explicitly chose
 *   `never` (Atlas: `none`). Without this floor, a `big` policy would let an autonomous flow of up to 6 calls under
 *   the threshold run with no approval at all;
 * - anything unknown or malformed (a mode such as `send`, a gate class, a target, a policy, a negative or non-finite
 *   amount) → `deny`.
 */
import { TOOL_MODES } from '../tools/types.js';

/** What a tool or capability needs before it runs (plan §5.3, §5.5). */
export const GATE_CLASSES = ['none', 'quota', 'spend', 'confirm', 'external-write'] as const;
export type GateClass = (typeof GATE_CLASSES)[number];

/** What a call writes to: the agent's own draft, the user's content, or something outside the platform. */
export const GATE_TARGETS = ['own-draft', 'user-content', 'external'] as const;
export type GateTarget = (typeof GATE_TARGETS)[number];

export const GATE_DECISIONS = ['run', 'quota-check', 'spend-confirm', 'propose', 'confirm', 'deny'] as const;
/**
 * - `run`: go ahead (the host still meters what it spends);
 * - `quota-check`: go ahead once the host's count quota and ledger reservation say yes;
 * - `spend-confirm`: ask the person to approve the spend first;
 * - `propose`: show the change (or the flow's plan) for approval; apply nothing yet;
 * - `confirm`: a human click and a matching `ConsentRecord` before anything leaves the platform;
 * - `deny`: never.
 */
export type GateDecision = (typeof GATE_DECISIONS)[number];

export const DREAMSTREAM_CONFIRM_POLICIES = ['always', 'big', 'never'] as const;
export type DreamStreamConfirm = (typeof DREAMSTREAM_CONFIRM_POLICIES)[number];

export const ATLAS_APPROVAL_POLICIES = ['none', 'before_write', 'before_execute', 'always'] as const;
export type AtlasApproval = (typeof ATLAS_APPROVAL_POLICIES)[number];

/** The host's approval policy. DreamStream: the per-comic confirm policy; Atlas: its agent approval policy. */
export type HostPolicy =
  | { app: 'dreamstream'; confirm: DreamStreamConfirm; bigSpendUsd?: number }
  | { app: 'atlas'; approval: AtlasApproval };

/** `big` confirms once a turn's spend reaches this (DreamStream's per-comic default; Atlas `before_execute` too). */
export const DEFAULT_BIG_SPEND_USD = 0.5;

/**
 * Every policy a host can hold: DreamStream `always`, `big` (at the default threshold) and `never`; Atlas `none`,
 * `before_write`, `before_execute` and `always`. The floor tests run under all seven.
 */
export const ALL_POLICIES: readonly HostPolicy[] = [
  { app: 'dreamstream', confirm: 'always' },
  { app: 'dreamstream', confirm: 'big', bigSpendUsd: DEFAULT_BIG_SPEND_USD },
  { app: 'dreamstream', confirm: 'never' },
  { app: 'atlas', approval: 'none' },
  { app: 'atlas', approval: 'before_write' },
  { app: 'atlas', approval: 'before_execute' },
  { app: 'atlas', approval: 'always' },
];

/** The tool fields a gate reads (a `PlatformTool` has them). */
export interface GateTool {
  mode: string;
  gate: string;
}

/** The flow fields a gate reads (a `FlowDefinition`'s limits). */
export interface GateFlow {
  maxModelCalls: number;
}

export interface GateInput {
  /** The tool being called; omit it when gating a whole flow run. */
  tool?: GateTool;
  /** The flow being run; its plan is the thing approved. */
  flow?: GateFlow;
  policy: HostPolicy;
  /** What this call may cost (USD, host-side). Omitted: free for a tool, unknown for a `spend` tool or a flow. */
  estimateUsd?: number;
  /** What this turn has already spent (USD); `big` sums the turn. */
  turnSpendUsd?: number;
  target: GateTarget;
}

const has = (list: readonly string[], value: unknown): boolean => typeof value === 'string' && list.indexOf(value) !== -1;

const isAmount = (v: unknown): v is number => typeof v === 'number' && isFinite(v) && v >= 0;

/** Is `policy` one of the shapes above (with a finite, non-negative `bigSpendUsd` when present)? */
export const isHostPolicy = (policy: unknown): policy is HostPolicy => {
  if (typeof policy !== 'object' || policy === null) return false;
  const p = policy as { app?: unknown; confirm?: unknown; approval?: unknown; bigSpendUsd?: unknown };
  if (p.app === 'dreamstream') return has(DREAMSTREAM_CONFIRM_POLICIES, p.confirm) && (p.bigSpendUsd === undefined || isAmount(p.bigSpendUsd));
  if (p.app === 'atlas') return has(ATLAS_APPROVAL_POLICIES, p.approval);
  return false;
};

/** The user explicitly chose never to be asked: DreamStream `never`, Atlas `none`. */
export const isExplicitNever = (policy: HostPolicy): boolean =>
  (policy.app === 'dreamstream' && policy.confirm === 'never') || (policy.app === 'atlas' && policy.approval === 'none');

/** The spend threshold a policy confirms at, or `null` when it never confirms spend (`0` = every spend). */
export const spendThresholdUsd = (policy: HostPolicy): number | null => {
  if (policy.app === 'dreamstream') {
    if (policy.confirm === 'never') return null;
    if (policy.confirm === 'always') return 0;
    return policy.bigSpendUsd !== undefined ? policy.bigSpendUsd : DEFAULT_BIG_SPEND_USD;
  }
  if (policy.approval === 'always') return 0;
  if (policy.approval === 'before_execute') return DEFAULT_BIG_SPEND_USD;
  return null; // none; before_write means the floors only
};

/** Decide what a tool call or a flow run needs. Pure; never throws. */
export const decideGate = (input: GateInput): GateDecision => {
  if (typeof input !== 'object' || input === null) return 'deny';
  const { tool, flow, policy, target } = input;
  if (!isHostPolicy(policy) || !has(GATE_TARGETS, target)) return 'deny';
  if (!tool && !flow) return 'deny';
  if (tool && (typeof tool !== 'object' || !has(TOOL_MODES, tool.mode) || !has(GATE_CLASSES, tool.gate))) return 'deny';
  if (flow && (typeof flow !== 'object' || typeof flow.maxModelCalls !== 'number' || !(flow.maxModelCalls >= 0) || flow.maxModelCalls % 1 !== 0)) return 'deny';
  if (input.estimateUsd !== undefined && !isAmount(input.estimateUsd)) return 'deny';
  if (input.turnSpendUsd !== undefined && !isAmount(input.turnSpendUsd)) return 'deny';

  // ── Floors ──
  if (target === 'external' || (tool && (tool.mode === 'external-write' || tool.gate === 'external-write'))) return 'confirm';
  if (tool && tool.gate === 'confirm') return 'confirm';
  if (target === 'user-content' && (!tool || tool.mode !== 'read')) return 'propose';
  if (tool && tool.mode === 'propose') return 'propose';
  if (flow && flow.maxModelCalls > 1 && !isExplicitNever(policy)) return 'propose';

  // ── The policy: money ──
  const threshold = spendThresholdUsd(policy);
  const unknownCost = input.estimateUsd === undefined && (!!flow || (tool !== undefined && tool.gate === 'spend'));
  const estimate = input.estimateUsd !== undefined ? input.estimateUsd : 0;
  if (threshold !== null && (unknownCost || (estimate > 0 && (input.turnSpendUsd || 0) + estimate >= threshold))) return 'spend-confirm';
  if (tool && tool.gate === 'quota') return 'quota-check';
  return 'run';
};

/** Decisions under which the host may execute the call now (after its quota check, for `quota-check`). */
export const mayRunNow = (decision: GateDecision): boolean => decision === 'run' || decision === 'quota-check';
