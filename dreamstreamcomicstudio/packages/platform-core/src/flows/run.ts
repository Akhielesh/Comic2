/**
 * `runFlow` (plan §5.7): a pure step machine over injected ports. One host request per run:
 *
 * 1. First request: validate the parameters, estimate, reserve the estimate on the host's ledger. If the gate wants
 *    approval (every flow with `maxModelCalls > 1` unless the user chose `never`), stop at `awaiting_approval` with
 *    the plan and a signed, single-use `planToken` bound to the reservation.
 * 2. Resume (a new request carrying `{plan, planToken}`): verify the token (401 tampered, 403 expired / other user /
 *    other plan), re-validate the plan against the definition, re-estimate, then CLAIM the reservation; a second
 *    resume finds it used (409). With the ledger down the run fails closed (503). A refusal of the user's own
 *    authentic approval (expired, stale, other parameters, a higher estimate) RELEASES its hold, so an unrun plan never
 *    keeps counting against the allowance.
 * 3. Run: one model completion per step, within `maxSteps`, `maxModelCalls`, `maxSeconds` and the reserved estimate.
 *    Each tool call is checked, gated and executed by the host. The first `external-write` stops the run at
 *    `awaiting_confirm` with a `DraftAction`, and the first proposal on the person's content (or a spend no approved
 *    plan covers) stops it with a `FlowProposal`: a flow never performs an unconfirmed external write or change.
 * 4. Settle what was spent (or release when nothing was), and record ONE content-free audit event for the run (plus
 *    one `settle-failed` / `release-failed` event when the ledger could not close a hold).
 *
 * Every gate reads the USER's policy (`ports.policy`); a flow's own policy can only make it stricter.
 */
import type { CheckError, ObjectSchema, Schema } from '../contract/schema.js';
import { check, s } from '../schema/index.js';
import type { PlatformErrorCode } from '../errors.js';
import { PLATFORM_ERRORS } from '../errors.js';
import { decideGate, isExplicitNever, isHostPolicy } from '../gates/gates.js';
import type { GateDecision, GateInput, HostPolicy } from '../gates/gates.js';
import type { DraftAction } from '../gates/consent.js';
import type { MeterClaimResult, MeterReserveResult, MeterSettleResult } from '../gates/ports.js';
import { auditEvent } from '../audit/event.js';
import type { AuditDecision, AuditOutcome } from '../audit/event.js';
import { canonicalJson, inputHash } from '../audit/inputHash.js';
import { getPlatformTool, isPlatformToolName } from '../tools/registry.js';
import { checkToolInput, toChatSpec } from '../tools/projections.js';
import { FORBIDDEN_NAME } from '../tools/types.js';
import { mintPlanToken, planHash, verifyPlanToken } from './planToken.js';
import type { PlanTokenCheck } from './planToken.js';
import type {
  ApprovedPlan,
  FlowDefinition,
  FlowError,
  FlowParams,
  FlowPlan,
  FlowPorts,
  FlowRunResult,
  FlowStatus,
  FlowStepRecord,
  FlowToolSpec,
  FlowTranscriptEntry,
} from './types.js';
import { FLOW_LIMITS_MAX, FLOW_PARAMS_MAX, FLOW_PARAM_TEXT_MAX } from './types.js';

/**
 * A flow may never reserve more than this. PROVISIONAL, not a plan number (owner W3.2; ADR 0008 to confirm): a fifth
 * of the governed $10 allowance, far above §10's ≈ $0.02 for a 5-step flow, so one unapproved plan can never hold the
 * whole allowance.
 */
export const FLOW_ESTIMATE_MAX_USD = 2;

// ── Gating: the user's policy, tightened (never loosened) by the flow's ─────────────────────────────────────────

const GATE_RANK: { readonly [D in GateDecision]: number } = { run: 0, 'quota-check': 1, 'spend-confirm': 2, propose: 3, confirm: 4, deny: 5 };

/** The stricter of two decisions: `deny` > `confirm` > `propose` > `spend-confirm` > `quota-check` > `run`. */
export const stricterGate = (a: GateDecision, b: GateDecision): GateDecision => (GATE_RANK[b] > GATE_RANK[a] ? b : a);

/**
 * Gate a flow run, or one tool call inside it, under the USER's policy; a flow's own policy is checked too and the
 * stricter answer wins. Only the user's explicit never lifts the flow floor: a definition's policy cannot.
 */
export const decideFlowGate = (input: Omit<GateInput, 'policy'>, userPolicy: HostPolicy, flowPolicy?: HostPolicy): GateDecision => {
  const mine = decideGate({ tool: input.tool, flow: input.flow, estimateUsd: input.estimateUsd, turnSpendUsd: input.turnSpendUsd, target: input.target, policy: userPolicy });
  if (flowPolicy === undefined) return mine;
  return stricterGate(mine, decideGate({ tool: input.tool, flow: input.flow, estimateUsd: input.estimateUsd, turnSpendUsd: input.turnSpendUsd, target: input.target, policy: flowPolicy }));
};

// ── The FlowRun reducer ─────────────────────────────────────────────────────────────────────────────────────────

const TRANSITIONS: { readonly [S in FlowStatus]: readonly FlowStatus[] } = {
  planned: ['awaiting_approval', 'running', 'failed', 'cancelled'],
  awaiting_approval: ['running', 'failed', 'cancelled'],
  running: ['running', 'awaiting_confirm', 'done', 'failed', 'cancelled'],
  awaiting_confirm: ['running', 'done', 'failed', 'cancelled'],
  done: [],
  failed: [],
  cancelled: [],
};

export class FlowStateError extends Error {
  constructor(from: FlowStatus, to: FlowStatus) {
    super(`a flow run cannot go from ${from} to ${to}`);
    this.name = 'FlowStateError';
  }
}

export const canTransition = (from: FlowStatus, to: FlowStatus): boolean => !!TRANSITIONS[from] && TRANSITIONS[from].indexOf(to) !== -1;

/** The next status, or `FlowStateError` for a move the run's lifecycle does not allow (a finished run stays finished). */
export const nextFlowStatus = (from: FlowStatus, to: FlowStatus): FlowStatus => {
  if (!canTransition(from, to)) throw new FlowStateError(from, to);
  return to;
};

// ── Definitions and parameters ──────────────────────────────────────────────────────────────────────────────────

export class FlowDefinitionError extends Error {
  constructor(flow: string, message: string) {
    super(`flow ${flow}: ${message}`);
    this.name = 'FlowDefinitionError';
  }
}

const FLOW_ID = /^[a-z][a-z0-9_]{2,63}$/;
const PARAM_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const INSTRUCTIONS_MAX = 20000;

const isInt = (v: unknown, lo: number, hi: number): boolean => typeof v === 'number' && Number.isSafeInteger(v) && v >= lo && v <= hi;

/** Throws `FlowDefinitionError` unless `def` holds every rule (limits within the ceilings, known tools…). */
export const assertFlowDefinition = (def: FlowDefinition<unknown>): void => {
  const id = def && typeof def.id === 'string' ? def.id : '(unnamed)';
  const fail = (message: string): never => {
    throw new FlowDefinitionError(id, message);
  };
  if (!FLOW_ID.test(id) || FORBIDDEN_NAME.test(id)) fail('id must be a snake_case id');
  if (typeof def.version !== 'string' || !/^[0-9A-Za-z.+-]{1,32}$/.test(def.version)) fail('version is required');
  if (typeof def.title !== 'string' || !def.title.trim() || def.title.length > 120) fail('title is required (at most 120 characters)');
  if (typeof def.instructions !== 'string' || !def.instructions.trim() || def.instructions.length > INSTRUCTIONS_MAX) fail(`instructions are required (at most ${INSTRUCTIONS_MAX} characters)`);
  const l = def.limits;
  if (!l) fail('limits are required');
  if (!isInt(l.maxSteps, 1, FLOW_LIMITS_MAX.maxSteps)) fail(`maxSteps must be 1 to ${FLOW_LIMITS_MAX.maxSteps}`);
  if (!isInt(l.maxModelCalls, 1, FLOW_LIMITS_MAX.maxModelCalls)) fail(`maxModelCalls must be 1 to ${FLOW_LIMITS_MAX.maxModelCalls}`);
  if (!isInt(l.maxSeconds, 1, FLOW_LIMITS_MAX.maxSeconds)) fail(`maxSeconds must be 1 to ${FLOW_LIMITS_MAX.maxSeconds}`);
  if (typeof l.maxEstimateUsd !== 'number' || !isFinite(l.maxEstimateUsd) || l.maxEstimateUsd <= 0 || l.maxEstimateUsd > FLOW_ESTIMATE_MAX_USD) {
    fail(`maxEstimateUsd must be above 0 and at most ${FLOW_ESTIMATE_MAX_USD}`);
  }
  if (!Array.isArray(def.tools) || def.tools.length > 20) fail('tools must be a list of at most 20');
  for (const t of def.tools) if (!isPlatformToolName(t)) fail(`unknown tool ${String(t)}`);
  if (!Array.isArray(def.parameters) || def.parameters.length > FLOW_PARAMS_MAX) fail(`parameters must be a list of at most ${FLOW_PARAMS_MAX}`);
  const keys: string[] = [];
  for (const p of def.parameters) {
    if (!p || !PARAM_KEY.test(p.key) || keys.indexOf(p.key) !== -1) fail(`parameter key ${p && p.key} must be a unique identifier`);
    keys.push(p.key);
    if (['string', 'number', 'boolean', 'select'].indexOf(p.input_type) === -1) fail(`parameter ${p.key} has an unknown input_type`);
    if (['required', 'optional', 'user_prompt'].indexOf(p.requirement) === -1) fail(`parameter ${p.key} has an unknown requirement`);
    if (p.input_type === 'select' && (!Array.isArray(p.options) || !p.options.length || p.options.length > 50)) fail(`select parameter ${p.key} needs 1 to 50 options`);
    if (p.max !== undefined && !isInt(p.max, 1, FLOW_PARAM_TEXT_MAX)) fail(`parameter ${p.key} max must be 1 to ${FLOW_PARAM_TEXT_MAX}`);
  }
  if (!def.output || typeof def.output !== 'object') fail('output schema is required');
  if (def.policy !== undefined) {
    if (!isHostPolicy(def.policy)) fail('policy must be a host policy');
    else if (isExplicitNever(def.policy)) fail('a flow policy can only tighten the user’s policy: never / none is the user’s choice alone');
  }
};

/** The parameters as a capped schema: strings, numbers, booleans and selects; `optional` ones may be absent. */
export const flowParamsSchema = (def: FlowDefinition<unknown>): ObjectSchema<FlowParams> => {
  const fields: { [key: string]: Schema<unknown> } = {};
  for (const p of def.parameters) {
    let node: Schema<unknown>;
    if (p.input_type === 'number') node = s.number();
    else if (p.input_type === 'boolean') node = s.bool();
    else if (p.input_type === 'select') node = s.enum((p.options || []).slice() as string[]);
    else node = s.text({ max: p.max || FLOW_PARAM_TEXT_MAX });
    fields[p.key] = p.requirement === 'optional' ? s.optional(node) : node;
  }
  return s.object(fields) as unknown as ObjectSchema<FlowParams>;
};

/** Check `params` against the definition; absent optional parameters take their `default`. */
export const checkFlowParams = (
  def: FlowDefinition<unknown>,
  params: unknown,
): { ok: true; value: FlowParams; errors?: undefined } | { ok: false; errors: CheckError[]; value?: undefined } => {
  const r = check(flowParamsSchema(def), params === undefined ? {} : params);
  if (r.ok === false) return { ok: false, errors: r.errors };
  const value: FlowParams = {};
  for (const k of Object.keys(r.value)) value[k] = r.value[k];
  for (const p of def.parameters) if (value[p.key] === undefined && p.default !== undefined) value[p.key] = p.default;
  return { ok: true, value };
};

const sameJson = (a: unknown, b: unknown): boolean => {
  try {
    return canonicalJson(a) === canonicalJson(b);
  } catch {
    return false;
  }
};

// ── runFlow ─────────────────────────────────────────────────────────────────────────────────────────────────────

const errorOf = (code: PlatformErrorCode, reason: string, message: string, status?: number): FlowError => ({
  code,
  status: status !== undefined ? status : PLATFORM_ERRORS[code].status,
  reason,
  message,
});

const usdOf = (v: unknown): number => (typeof v === 'number' && isFinite(v) && v > 0 ? v : 0);

/**
 * Run (or plan, or resume) a flow. Never throws: every failure is a `failed` result with a platform error code and
 * the HTTP status the host answers with.
 */
export const runFlow = async <O>(def: FlowDefinition<O>, params: unknown, ports: FlowPorts, approvedPlan?: ApprovedPlan): Promise<FlowRunResult<O>> => {
  let status: FlowStatus = 'planned';
  const steps: FlowStepRecord[] = [];
  let modelCalls = 0;
  let spent = 0;
  let plan: FlowPlan | undefined;
  let reservationId: string | undefined;
  let settleFailed = false;
  const approvedRun = !!approvedPlan;
  const move = (to: FlowStatus): void => {
    status = nextFlowStatus(status, to);
  };
  const result = (extra: Partial<FlowRunResult<O>>): FlowRunResult<O> => {
    const out: FlowRunResult<O> = { status, steps, modelCalls, spentUsd: spent };
    if (plan) out.plan = plan;
    if (settleFailed) out.settleFailed = true;
    for (const k of Object.keys(extra) as (keyof FlowRunResult<O>)[]) (out as unknown as { [k: string]: unknown })[k] = extra[k];
    return out;
  };
  const record = (decision: AuditDecision, outcome: AuditOutcome, errorCode?: string): void => {
    if (!ports.audit) return;
    try {
      const event = auditEvent({
        id: ports.newId(),
        at: ports.clock(),
        kind: 'flow',
        app: ports.app,
        product: ports.product,
        actor: ports.actorId ? { kind: 'user', id: ports.actorId } : { kind: 'user' },
        flow: def && typeof def.id === 'string' ? def.id : undefined,
        decision,
        inputHash: plan ? planHash(plan) : inputHash(null),
        opIds: [],
        outcome,
        errorCode,
        costMicros: spent > 0 ? Math.round(spent * 1000000) : undefined,
      });
      void Promise.resolve(ports.audit.record(event)).catch(() => undefined);
    } catch {
      // auditing never breaks the run
    }
  };
  const fail = (error: FlowError, decision: AuditDecision = 'auto'): FlowRunResult<O> => {
    status = canTransition(status, 'failed') ? 'failed' : status;
    record(decision, 'failed', error.reason);
    return result({ error });
  };
  /**
   * Close one hold with the ledger: settle `settleUsd` when it is above 0, release it otherwise. A throw or an
   * `{ok:false}` answer leaves the hold stranded: flagged on the result and audited, never retried here.
   */
  const closeHold = async (id: string, how: { settleUsd?: number; reason: string }): Promise<void> => {
    const settling = how.settleUsd !== undefined && how.settleUsd > 0;
    let closed: MeterSettleResult | undefined;
    try {
      closed = settling
        ? await ports.meter.settle(id, { actualUsd: how.settleUsd as number, metadata: { platform: { app: ports.app, product: ports.product, flow: def.id, inputHash: plan ? planHash(plan) : undefined } } })
        : await ports.meter.release(id, { reason: how.reason });
    } catch {
      closed = undefined;
    }
    if (!closed || closed.ok === false) {
      settleFailed = true;
      record(approvedRun ? 'confirmed' : 'auto', 'failed', settling ? 'settle-failed' : 'release-failed');
    }
  };
  /** Close the run's reservation: settle what was spent, release when nothing was. */
  const close = async (): Promise<void> => {
    if (!reservationId) return;
    const id = reservationId;
    reservationId = undefined;
    await closeHold(id, spent > 0 ? { settleUsd: spent, reason: 'flow-spent' } : { reason: 'flow-unspent' });
  };
  const claimHold = async (id: string): Promise<MeterClaimResult> => {
    try {
      return await ports.meter.claim(id);
    } catch {
      return 'unavailable'; // a claim must not throw; one that does is a ledger that could not be asked
    }
  };
  /**
   * Release the hold of a plan that will never run (expired, stale, other parameters, a higher estimate). It is
   * claimed first, so its token can never start a run afterwards. Never throws; with the ledger down the hold stays
   * open and unclaimed, and the ledger's sweep must RELEASE it (never settle it at its held cost).
   */
  const releaseHold = async (id: string, reason: string): Promise<void> => {
    if ((await claimHold(id)) === 'claimed') await closeHold(id, { reason });
  };

  // ── Validate ──
  try {
    assertFlowDefinition(def);
  } catch (error) {
    return fail(errorOf('invalid', 'definition', error instanceof Error ? error.message : 'Invalid flow definition.'));
  }
  const gateOf = (input: Omit<GateInput, 'policy'>): GateDecision => decideFlowGate(input, ports.policy, def.policy);
  const params0 = checkFlowParams(def, approvedPlan ? approvedPlan.plan && approvedPlan.plan.params : params);
  if (params0.ok === false) return fail(errorOf('invalid', 'params', params0.errors.map((e) => `${e.path || '(root)'}: ${e.message}`).join('; ')));
  const p = params0.value;
  let estimate: number;
  try {
    estimate = ports.estimate ? ports.estimate(def, p) : def.limits.maxEstimateUsd;
  } catch {
    return fail(errorOf('engine-failed', 'estimate', 'The run could not be estimated.'));
  }
  if (typeof estimate !== 'number' || !isFinite(estimate) || estimate < 0) return fail(errorOf('invalid', 'estimate', 'The run could not be estimated.'));
  if (estimate > def.limits.maxEstimateUsd) return fail(errorOf('invalid', 'limit-estimate', 'This run would cost more than the flow allows.'));
  const gate = gateOf({ flow: def.limits, estimateUsd: estimate, target: 'own-draft' });
  if (gate === 'deny') return fail(errorOf('forbidden', 'gate-deny', 'This flow is not allowed under the current policy.'), 'blocked');

  const startMs = ports.clock();
  const cost = { app: ports.app, product: ports.product, flow: def.id };
  const ledgerDown = (): FlowRunResult<O> => fail(errorOf('disabled', 'ledger-down', 'Usage could not be checked right now, so nothing ran. Try again in a moment.'), 'blocked');

  if (!approvedPlan) {
    // ── Plan and reserve ──
    plan = { v: 1, flowId: def.id, version: def.version, title: def.title, params: p, tools: def.tools.slice(), limits: { ...def.limits }, estimateUsd: estimate, createdAt: startMs };
    let reserved: MeterReserveResult;
    try {
      reserved = await ports.meter.reserve({ operation: 'platform_flow', estimateFloorUsd: estimate, metadata: { platform: { ...cost, inputHash: planHash(plan) } } });
    } catch {
      reserved = { ok: false, code: 'unavailable', message: 'The usage ledger did not answer.' };
    }
    if (reserved.ok === false) {
      return reserved.code === 'quota' ? fail(errorOf('quota', 'quota', 'Not enough usage left for this run.'), 'blocked') : ledgerDown();
    }
    const held = reserved.reservationId;
    reservationId = held;
    if (gate !== 'run' && gate !== 'quota-check') {
      let planToken: string;
      try {
        planToken = mintPlanToken({ sub: ports.sub, reservationId: held, planHash: planHash(plan), nowMs: startMs }, ports.planKey);
      } catch (error) {
        reservationId = undefined;
        await closeHold(held, { reason: 'plan-token' });
        return fail(errorOf('engine-failed', 'plan-token', error instanceof Error ? error.message : 'The plan could not be signed.'));
      }
      move('awaiting_approval');
      record('auto', 'pending');
      return result({ planToken });
    }
    // No approval needed (the user chose never): claim our own reservation, the same single-use path as a resume.
    const claim = await claimHold(held);
    if (claim !== 'claimed') {
      reservationId = undefined;
      return claim === 'unavailable' ? ledgerDown() : fail(errorOf('conflict', 'reservation-used', 'This run was already started.'), 'blocked');
    }
    move('running');
  } else {
    // ── Resume an approved plan ──
    const approved = approvedPlan.plan;
    let token: PlanTokenCheck;
    try {
      token = verifyPlanToken(approvedPlan.planToken, ports.planKey, { nowMs: startMs, sub: ports.sub, planHash: planHash(approved) });
    } catch (error) {
      return fail(errorOf('engine-failed', 'plan-key', error instanceof Error ? error.message : 'The plan key is misconfigured.'));
    }
    if (token.ok === false) {
      // This user's own approval, expired: release the hold it was paying for.
      if (token.reason === 'expired' && token.payload) await releaseHold(token.payload.reservationId, 'plan-expired');
      return fail(
        errorOf(token.code, `plan-${token.reason}`, token.reason === 'expired' ? 'This approval has expired. Review the plan again.' : 'This approval is not valid for this plan.', token.status),
        'blocked',
      );
    }
    // From here the token is authentic, this user's and this plan's: a refusal below releases its hold.
    const held = token.payload.reservationId;
    if (
      !approved ||
      approved.v !== 1 ||
      approved.flowId !== def.id ||
      approved.version !== def.version ||
      !sameJson(approved.tools, def.tools) ||
      !sameJson(approved.limits, def.limits) ||
      typeof approved.estimateUsd !== 'number'
    ) {
      await releaseHold(held, 'plan-stale');
      return fail(errorOf('conflict', 'plan-stale', 'The flow changed after this plan was approved. Review it again.'), 'blocked');
    }
    if (params !== undefined) {
      const given = checkFlowParams(def, params);
      if (given.ok === false || !sameJson(given.value, p)) {
        await releaseHold(held, 'plan-params');
        return fail(errorOf('forbidden', 'plan-params', 'These parameters are not the ones that were approved.', 403), 'blocked');
      }
    }
    if (estimate > approved.estimateUsd + 1e-9) {
      await releaseHold(held, 'estimate-changed');
      return fail(errorOf('conflict', 'estimate-changed', 'This run now costs more than was approved. Review it again.'), 'blocked');
    }
    plan = approved;
    const claim = await claimHold(held);
    if (claim === 'unavailable') return ledgerDown();
    if (claim !== 'claimed') return fail(errorOf('conflict', claim === 'used' ? 'reservation-used' : 'reservation-unknown', 'This approved plan has already run.'), 'blocked');
    reservationId = held;
    move('running');
  }

  // ── Run ──
  const budget = plan.estimateUsd;
  const deadline = startMs + def.limits.maxSeconds * 1000;
  const toolSpecs: FlowToolSpec[] = [];
  for (const name of def.tools) {
    const t = getPlatformTool(name);
    if (t) toolSpecs.push(toChatSpec(t));
  }
  const transcript: FlowTranscriptEntry[] = [];
  const finishFailed = async (error: FlowError, decision: AuditDecision = approvedRun ? 'confirmed' : 'auto'): Promise<FlowRunResult<O>> => {
    await close();
    return fail(error, decision);
  };

  let stepIndex = 0;
  for (;;) {
    if (stepIndex >= def.limits.maxSteps) return finishFailed(errorOf('invalid', 'limit-steps', `The flow stopped after ${def.limits.maxSteps} steps without an answer.`, 422));
    if (modelCalls >= def.limits.maxModelCalls) return finishFailed(errorOf('invalid', 'limit-model-calls', `The flow stopped after ${def.limits.maxModelCalls} model calls.`, 422));
    if (ports.clock() > deadline) return finishFailed(errorOf('timeout', 'limit-seconds', `The flow ran past ${def.limits.maxSeconds} seconds.`));

    let reply;
    try {
      reply = await ports.callModel({ flowId: def.id, instructions: def.instructions, params: p, tools: toolSpecs, transcript: transcript.slice(), call: modelCalls });
    } catch {
      modelCalls++;
      return finishFailed(errorOf('engine-failed', 'model-failed', 'The model call failed.'));
    }
    modelCalls++;
    spent += usdOf(reply && reply.usd);
    if (spent > budget + 1e-9) return finishFailed(errorOf('invalid', 'limit-estimate', 'The flow reached the usage it was approved for.', 422));
    if (ports.clock() > deadline) return finishFailed(errorOf('timeout', 'limit-seconds', `The flow ran past ${def.limits.maxSeconds} seconds.`));
    const step = stepIndex++;

    if (!reply || (reply.kind !== 'tool' && reply.kind !== 'final')) {
      steps.push({ step, kind: 'error', outcome: 'failed' });
      return finishFailed(errorOf('engine-failed', 'model-error', reply && reply.kind === 'error' ? reply.message.slice(0, 200) : 'The model gave no usable answer.'));
    }

    if (reply.kind === 'final') {
      const out = check(def.output, reply.output);
      if (out.ok === false) {
        steps.push({ step, kind: 'final', outcome: 'invalid' });
        transcript.push({ step, kind: 'error', errors: out.errors });
        continue; // the next call repairs it, within the limits
      }
      steps.push({ step, kind: 'final', outcome: 'ok' });
      move('done');
      await close();
      record(approvedRun ? 'confirmed' : 'auto', 'ok');
      return result({ output: out.value as O });
    }

    // A tool call.
    const name = reply.tool;
    const tool = typeof name === 'string' && def.tools.indexOf(name as never) !== -1 ? getPlatformTool(name) : undefined;
    if (!tool) {
      steps.push({ step, kind: 'tool', tool: typeof name === 'string' ? name.slice(0, 64) : undefined, outcome: 'refused' });
      transcript.push({ step, kind: 'error', tool: typeof name === 'string' ? name.slice(0, 64) : undefined, errors: [{ path: 'tool', code: 'enum', message: 'That tool is not part of this flow.' }] });
      continue;
    }
    const checked = checkToolInput(tool, reply.args);
    if (checked.ok === false) {
      steps.push({ step, kind: 'tool', tool: tool.name, outcome: 'invalid' });
      transcript.push({ step, kind: 'error', tool: tool.name, errors: checked.errors });
      continue;
    }
    const decision = gateOf({ tool, target: tool.target });
    if (decision === 'confirm') {
      // The first external write ends the run here: prepare the draft action; a person approves it in the host.
      let action: DraftAction | undefined;
      try {
        action = ports.tools.draft ? await ports.tools.draft(tool.name, checked.value) : undefined;
      } catch {
        action = undefined;
      }
      if (!action) {
        steps.push({ step, kind: 'tool', tool: tool.name, decision, outcome: 'refused' });
        return finishFailed(errorOf('forbidden', 'external-write', 'This flow needs your approval to write outside the app, and the app could not prepare it.'), 'blocked');
      }
      if (ports.approver) await Promise.resolve(ports.approver.draft(action)).catch(() => undefined);
      steps.push({ step, kind: 'tool', tool: tool.name, decision, outcome: 'pending' });
      move('awaiting_confirm');
      await close();
      record(approvedRun ? 'confirmed' : 'auto', 'pending');
      return result({ draftAction: action });
    }
    if (decision === 'deny') {
      steps.push({ step, kind: 'tool', tool: tool.name, decision, outcome: 'refused' });
      transcript.push({ step, kind: 'error', tool: tool.name, errors: [{ path: 'tool', code: 'enum', message: 'That tool is not allowed under the current policy.' }] });
      continue;
    }
    if (decision === 'propose' || (decision === 'spend-confirm' && !approvedRun)) {
      // A change to the person's own content (or a spend no approved plan covers) is only ever PROPOSED: the run
      // stops here with the checked call, nothing runs, and the host asks the person (plan §5.5, §5.6).
      steps.push({ step, kind: 'tool', tool: tool.name, decision, outcome: 'pending' });
      move('awaiting_confirm');
      await close();
      record(approvedRun ? 'confirmed' : 'auto', 'pending');
      return result({ proposal: { tool: tool.name, decision, input: checked.value, inputHash: inputHash(checked.value) } });
    }
    // run / quota-check / spend-confirm covered by the approved, reserved plan
    let ran;
    try {
      ran = await ports.tools.run(tool.name, checked.value, { decision, inputHash: inputHash(checked.value) });
    } catch {
      ran = { ok: false as const, code: 'engine-failed' as const, message: 'The tool failed.' };
    }
    if (ran.ok) {
      spent += usdOf(ran.usd);
      steps.push({ step, kind: 'tool', tool: tool.name, decision, outcome: 'ok' });
      transcript.push({ step, kind: 'tool', tool: tool.name, result: ran.output });
    } else {
      steps.push({ step, kind: 'tool', tool: tool.name, decision, outcome: 'failed' });
      transcript.push({ step, kind: 'error', tool: tool.name, errors: [{ path: '', code: 'type', message: `${ran.code}: ${String(ran.message).slice(0, 200)}` }] });
    }
    if (spent > budget + 1e-9) return finishFailed(errorOf('invalid', 'limit-estimate', 'The flow reached the usage it was approved for.', 422));
  }
};

/**
 * Cancel an approved-but-unused plan: claim its reservation (so the token can never run) and release it. An expired
 * token of this user still names its reservation, so cancelling it releases the hold too.
 */
export const cancelPlan = async (approvedPlan: ApprovedPlan, ports: Pick<FlowPorts, 'meter' | 'planKey' | 'sub' | 'clock'>): Promise<{ ok: true } | { ok: false; error: FlowError }> => {
  let token: PlanTokenCheck;
  try {
    token = verifyPlanToken(approvedPlan && approvedPlan.planToken, ports.planKey, { nowMs: ports.clock(), sub: ports.sub, planHash: planHash(approvedPlan && approvedPlan.plan) });
  } catch (error) {
    return { ok: false, error: errorOf('engine-failed', 'plan-key', error instanceof Error ? error.message : 'The plan key is misconfigured.') };
  }
  if (token.ok === false && token.reason !== 'expired') return { ok: false, error: errorOf(token.code, `plan-${token.reason}`, 'This approval is not valid for this plan.', token.status) };
  const payload = token.payload;
  if (!payload) return { ok: false, error: errorOf('forbidden', 'plan-expired', 'This approval is not valid for this plan.', 403) };
  let claim: MeterClaimResult;
  try {
    claim = await ports.meter.claim(payload.reservationId);
  } catch {
    claim = 'unavailable';
  }
  if (claim === 'unavailable') return { ok: false, error: errorOf('disabled', 'ledger-down', 'Usage could not be checked right now. Try again in a moment.') };
  if (claim !== 'claimed') return { ok: false, error: errorOf('conflict', 'reservation-used', 'This plan already ran or was cancelled.') };
  let released: MeterSettleResult | undefined;
  try {
    released = await ports.meter.release(payload.reservationId, { reason: token.ok ? 'cancelled' : 'plan-expired' });
  } catch {
    released = undefined;
  }
  // Claimed, so the plan can never run; the hold itself is stranded until the host's reconciliation releases it.
  if (!released || released.ok === false) return { ok: false, error: errorOf('disabled', 'release-failed', 'The plan was cancelled, but its usage hold could not be released yet.') };
  return { ok: true };
};
