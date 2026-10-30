/**
 * Flow types (plan §5.7). A flow is a named, versioned, parameterised agent workflow: instructions, typed
 * parameters (a superset of a DreamStream recipe's), an allowlist of platform tools, hard limits and an output
 * schema. `runFlow` (run.ts) executes one inside ONE host request, with the host's ports; an approval is a signed,
 * single-use `planToken` (planToken.ts), so there is no run table.
 */
import type { CheckError, Schema } from '../contract/schema.js';
import type { PlatformErrorCode } from '../errors.js';
import type { ApproverPort, MeterPort } from '../gates/ports.js';
import type { AuditPort } from '../audit/event.js';
import type { DraftAction } from '../gates/consent.js';
import type { GateDecision, HostPolicy } from '../gates/gates.js';
import type { PlatformToolName, PlatformWave } from '../tools/types.js';

/** The flows the platform ships (plan §5.7); definitions arrive with their wave. */
export const FLOW_IDS = [
  'comic_pitch_deck',
  'meeting_followup_pack',
  'reply_with_context',
  'comic_print_book',
  'reply_with_proposal_pdf',
  'contract_review_tracked',
  'press_kit',
] as const;
export type FlowId = (typeof FLOW_IDS)[number];

/**
 * The shipped flows and their waves (plan §5.7). The titles are PROVISIONAL working names, not plan copy: each flow's
 * owning package (waves 3–4) writes the final UI title with its definition.
 */
export const FLOW_CATALOG: readonly { id: FlowId; wave: PlatformWave; title: string }[] = [
  { id: 'comic_pitch_deck', wave: 3, title: 'Turn this comic into a pitch deck' },
  { id: 'meeting_followup_pack', wave: 3, title: 'Meeting follow-up pack' },
  { id: 'reply_with_context', wave: 3, title: 'Reply with context' },
  { id: 'comic_print_book', wave: 3, title: 'Print my book' },
  { id: 'reply_with_proposal_pdf', wave: 4, title: 'Reply with a proposal PDF' },
  { id: 'contract_review_tracked', wave: 4, title: 'Review this contract as tracked changes' },
  { id: 'press_kit', wave: 3, title: 'Press kit' },
];

export const isFlowId = (value: unknown): value is FlowId => typeof value === 'string' && (FLOW_IDS as readonly string[]).indexOf(value) !== -1;

/** The ceilings no flow may raise (plan §5.7). */
export const FLOW_LIMITS_MAX = { maxSteps: 8, maxModelCalls: 6, maxSeconds: 60 } as const;

export interface FlowLimits {
  /** Tool calls plus the final answer. At most `FLOW_LIMITS_MAX.maxSteps`. */
  maxSteps: number;
  /** Model completions (a repair retry counts). At most `FLOW_LIMITS_MAX.maxModelCalls`. */
  maxModelCalls: number;
  /** Wall-clock seconds for the whole run. At most `FLOW_LIMITS_MAX.maxSeconds`. */
  maxSeconds: number;
  /** The most the run may cost (USD, host-side); the plan's estimate is reserved up to this. */
  maxEstimateUsd: number;
}

/** A recipe parameter (`server/src/ai/recipes/schema.ts` shape), with caps. */
export interface FlowParameter {
  key: string;
  input_type: 'string' | 'number' | 'boolean' | 'select';
  requirement: 'required' | 'optional' | 'user_prompt';
  description?: string;
  default?: string | number | boolean;
  options?: string[];
  /** For `string`: at most this many characters (default `FLOW_PARAM_TEXT_MAX`). */
  max?: number;
}

export const FLOW_PARAM_TEXT_MAX = 4000;
export const FLOW_PARAMS_MAX = 20;

export interface FlowDefinition<O = unknown> {
  id: string;
  version: string;
  title: string;
  /** Model-facing instructions. Parameters are passed as data next to them, never spliced in. */
  instructions: string;
  parameters: FlowParameter[];
  tools: PlatformToolName[];
  /**
   * A stricter policy the flow itself requires. It can only TIGHTEN the user's own policy (`FlowPorts.policy`): the
   * run is gated under both and the stricter answer wins. It may never be an explicit never (`assertFlowDefinition`
   * refuses it), so a definition can never grant itself the user's exemption from the flow floor.
   */
  policy?: HostPolicy;
  limits: FlowLimits;
  output: Schema<O>;
}

export type FlowParams = { [key: string]: string | number | boolean };

/** `planned → awaiting_approval → running(i) → awaiting_confirm(i) → done | failed | cancelled`. */
export const FLOW_STATUSES = ['planned', 'awaiting_approval', 'running', 'awaiting_confirm', 'done', 'failed', 'cancelled'] as const;
export type FlowStatus = (typeof FLOW_STATUSES)[number];

/**
 * What a person approves. The token signs its canonical hash; at resume the host re-validates it against the flow
 * definition, so a plan edited on the client (more tools, higher limits, other parameters) no longer matches.
 */
export interface FlowPlan {
  v: 1;
  flowId: string;
  version: string;
  title: string;
  params: FlowParams;
  tools: PlatformToolName[];
  limits: FlowLimits;
  /** The estimate reserved for this run (USD; host-side, never shown to a governed user in dollars). */
  estimateUsd: number;
  /** Unix ms. */
  createdAt: number;
}

/** A tool spec the model sees during the flow (`toChatSpec`). */
export interface FlowToolSpec {
  name: string;
  description: string;
  parameters: { [k: string]: unknown };
}

export interface FlowTranscriptEntry {
  step: number;
  kind: 'tool' | 'final' | 'error';
  tool?: string;
  /** The tool's checked output, or the check errors the model must repair. */
  result?: unknown;
  errors?: CheckError[];
}

export interface FlowModelRequest {
  flowId: string;
  instructions: string;
  params: FlowParams;
  tools: FlowToolSpec[];
  transcript: FlowTranscriptEntry[];
  /** The model call number (0-based). */
  call: number;
}

/** One JSON completion: call a tool, or give the final output. `usd` is what the call cost the host. */
export type FlowModelReply =
  | { kind: 'tool'; tool: string; args: unknown; usd?: number }
  | { kind: 'final'; output: unknown; usd?: number }
  | { kind: 'error'; code: 'invalid' | 'engine-failed' | 'timeout' | 'quota'; message: string; usd?: number };

/** The host's executor for the flow's tools (its own handlers, auth and storage). */
export interface FlowToolPort {
  /**
   * Run a tool call the gate allows now: `run`, `quota-check`, or `spend-confirm` inside an approved plan. Never called
   * for `propose` (a change to the person's content stops the run with a `FlowProposal`), `confirm` (an external
   * write stops it with a `DraftAction`) or an unapproved `spend-confirm`.
   */
  run(name: PlatformToolName, input: unknown, ctx: { decision: GateDecision; inputHash: string }): Promise<{ ok: true; output: unknown; usd?: number } | { ok: false; code: PlatformErrorCode; message: string }>;
  /** Prepare (never perform) an external write: the draft action a person approves later in the host. */
  draft?(name: PlatformToolName, input: unknown): Promise<DraftAction>;
}

export interface FlowPorts {
  callModel(request: FlowModelRequest): Promise<FlowModelReply>;
  meter: MeterPort;
  tools: FlowToolPort;
  approver?: ApproverPort;
  audit?: AuditPort;
  /** Unix ms. */
  clock(): number;
  newId(): string;
  /** The host's plan-token key (injected; at least 32 bytes). */
  planKey: string | Uint8Array;
  /** The user's pseudonymous id (`sub`), as the host's claims carry it. */
  sub: string;
  /** Who the run is for, for audit and cost metadata. */
  app: string;
  product: string;
  actorId?: string;
  /** The user's own policy. Every gate in the run reads it; a flow's own policy can only make it stricter. */
  policy: HostPolicy;
  /** The host's estimate for this run (USD); absent: the flow's `maxEstimateUsd`. */
  estimate?(def: FlowDefinition<unknown>, params: FlowParams): number;
}

export interface FlowStepRecord {
  step: number;
  kind: 'tool' | 'final' | 'error';
  tool?: string;
  decision?: GateDecision;
  outcome: 'ok' | 'invalid' | 'refused' | 'failed' | 'pending';
}

export interface FlowError {
  code: PlatformErrorCode;
  /** The HTTP status the host answers with (403 expired token, 409 used reservation…). */
  status: number;
  /** A stable machine reason (`plan-expired`, `reservation-used`, `ledger-down`, `limit-steps`…). */
  reason: string;
  message: string;
}

/**
 * A tool call the run stopped at because a person must approve it first: a proposal on the person's own content, or
 * a spend no approved plan covers. Nothing ran; the host shows it and, on approval, runs it through its own route.
 */
export interface FlowProposal {
  tool: PlatformToolName;
  decision: 'propose' | 'spend-confirm';
  /** The checked arguments (host-side only; never audited). */
  input: unknown;
  inputHash: string;
}

export interface FlowRunResult<O = unknown> {
  status: FlowStatus;
  plan?: FlowPlan;
  planToken?: string;
  draftAction?: DraftAction;
  proposal?: FlowProposal;
  output?: O;
  error?: FlowError;
  steps: FlowStepRecord[];
  modelCalls: number;
  spentUsd: number;
  /**
   * The ledger could not settle or release this run's reservation (it threw or answered `{ok:false}`): the hold is
   * stranded until the host's reconciliation closes it. Audited as `settle-failed` / `release-failed`.
   */
  settleFailed?: true;
}

/** A resume request: the plan the person approved and its token. */
export interface ApprovedPlan {
  plan: FlowPlan;
  planToken: string;
}
