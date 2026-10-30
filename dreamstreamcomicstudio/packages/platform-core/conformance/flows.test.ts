// @vitest-environment node
//
// Flows and plan tokens (plan §5.7; W1.4). One host request per run; an approval is a host-signed planToken
// {sub, exp ≤ 15 min, reservationId, planHash}, good for ONE run:
// - a tampered token is rejected (401), an expired one gets 403, a second resume against the ledger gets 409;
// - with the ledger down a governed user fails closed (503) and nothing runs;
// - runFlow can never pass an unconfirmed external write or change the person's content; every limit (steps, model
//   calls, seconds, estimate) holds;
// - an approval that will never run (expired, stale, other parameters, a higher estimate, cancelled) releases its hold;
// - every gate reads the user's policy: a flow's own policy can only tighten it, never grant the never exemption.
import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { s } from '../src/schema/index.js';
import { base64urlEncode, canonicalJson, hmacSha256, utf8Bytes } from '../src/audit/inputHash.js';
import type { HostPolicy } from '../src/gates/gates.js';
import {
  FLOW_ESTIMATE_MAX_USD,
  PLAN_TOKEN_TTL_MAX_S,
  PlanTokenError,
  assertFlowDefinition,
  canTransition,
  cancelPlan,
  decideFlowGate,
  mintPlanToken,
  nextFlowStatus,
  planHash,
  runFlow,
  stricterGate,
  verifyPlanToken,
  type FlowDefinition,
  type FlowModelReply,
  type FlowPorts,
} from '../src/flows/index.js';
import { FAKE_PLAN_KEY, createFakeApprover, createFakeAudit, createFakeClock, createFakeLedger, createIdSequence, scriptedModel } from '../src/testing/fakePorts.js';
import { isInputHash } from '../src/audit/inputHash.js';
import type { DraftAction } from '../src/gates/consent.js';
import { createDraftAction } from '../src/gates/consent.js';

const KEY = FAKE_PLAN_KEY;
const NOW = Date.UTC(2026, 10, 2, 9, 0, 0);
const HASH = planHash({ any: 'plan' });

describe('planToken', () => {
  const mint = (over: Partial<Parameters<typeof mintPlanToken>[0]> = {}) => mintPlanToken({ sub: 'u1', reservationId: 'res-1', planHash: HASH, nowMs: NOW, ...over }, KEY);
  const verify = (token: unknown, over: Partial<{ nowMs: number; sub: string; planHash: string }> = {}, key: string = KEY) =>
    verifyPlanToken(token, key, { nowMs: NOW + 1000, sub: 'u1', planHash: HASH, ...over });

  it('carries {sub, exp ≤ 15 min, reservationId, planHash} and verifies for that user and plan', () => {
    const r = verify(mint());
    expect(r).toEqual({ ok: true, payload: { v: 1, sub: 'u1', iat: NOW / 1000, exp: NOW / 1000 + 900, reservationId: 'res-1', planHash: HASH } });
    expect(PLAN_TOKEN_TTL_MAX_S).toBe(900);
  });

  it('is a stable HMAC over the canonical payload (golden vector)', () => {
    const token = mint();
    const [body, sig] = token.split('.');
    expect(JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))).toMatchObject({ sub: 'u1', reservationId: 'res-1', planHash: HASH });
    // Recompute with node:crypto: k = HMAC(key, "platform-plan-v1"); sig = HMAC(k, "platform-plan-v1." + body).
    const k = createHmac('sha256', KEY).update('platform-plan-v1').digest();
    expect(sig).toBe(createHmac('sha256', k).update(`platform-plan-v1.${body}`).digest('base64url'));
  });

  it('rejects a tampered token (401)', () => {
    const token = mint();
    const [body, sig] = token.split('.');
    const forged = base64urlEncode(canonicalJson({ v: 1, sub: 'u1', iat: NOW / 1000, exp: NOW / 1000 + 900, reservationId: 'res-OTHER', planHash: HASH }));
    expect(verify(`${forged}.${sig}`)).toMatchObject({ ok: false, status: 401, reason: 'signature' });
    const flipped = sig[0] === 'A' ? `B${sig.slice(1)}` : `A${sig.slice(1)}`;
    expect(verify(`${body}.${flipped}`)).toMatchObject({ ok: false, status: 401, reason: 'signature' });
    expect(verify(token, {}, `${KEY}-other`)).toMatchObject({ ok: false, status: 401, reason: 'signature' });
    for (const bad of ['', 'x', `${body}`, `${body}.`, `${body}.${sig}.x`, `${body}.${sig}!`, 42, null]) expect(verify(bad)).toMatchObject({ ok: false, status: 401 });
  });

  it('refuses an expired token with 403, and a token for another user or plan with 403', () => {
    const token = mint();
    // An expired refusal still names this user's reservation, so the host can release the hold.
    expect(verify(token, { nowMs: NOW + 900 * 1000 })).toMatchObject({ ok: false, code: 'forbidden', status: 403, reason: 'expired', payload: { reservationId: 'res-1', sub: 'u1' } });
    // …but never to another user: the subject is checked before expiry.
    const otherExpired = verify(token, { nowMs: NOW + 900 * 1000, sub: 'u2' });
    expect(otherExpired).toMatchObject({ ok: false, status: 403, reason: 'subject' });
    expect(otherExpired.payload).toBeUndefined();
    expect(verify(token, { nowMs: NOW + 899 * 1000 }).ok).toBe(true);
    expect(verify(token, { sub: 'u2' })).toMatchObject({ ok: false, status: 403, reason: 'subject' });
    expect(verify(token, { planHash: planHash({ another: 'plan' }) })).toMatchObject({ ok: false, status: 403, reason: 'plan' });
  });

  it('never lasts longer than 15 minutes, even when the host signs a longer one', () => {
    expect(() => mint({ ttlSeconds: 901 })).toThrow(PlanTokenError);
    expect(() => mint({ ttlSeconds: 0 })).toThrow(PlanTokenError);
    // A correctly signed payload whose exp is more than 15 min after iat is still refused.
    const body = base64urlEncode(canonicalJson({ v: 1, sub: 'u1', iat: NOW / 1000, exp: NOW / 1000 + 3600, reservationId: 'res-1', planHash: HASH }));
    const k = hmacSha256(utf8Bytes(KEY), 'platform-plan-v1');
    const sig = base64urlEncode(hmacSha256(k, `platform-plan-v1.${body}`));
    expect(verify(`${body}.${sig}`)).toMatchObject({ ok: false, status: 403, reason: 'lifetime' });
  });

  it('needs an injected key of at least 32 bytes and a real plan hash', () => {
    expect(() => mintPlanToken({ sub: 'u1', reservationId: 'res-1', planHash: HASH, nowMs: NOW }, 'short-key')).toThrow(PlanTokenError);
    expect(() => mint({ planHash: 'not-a-hash' })).toThrow(PlanTokenError);
    expect(() => mint({ sub: '' })).toThrow(PlanTokenError);
    expect(isInputHash(HASH)).toBe(true);
  });
});

// ── runFlow ─────────────────────────────────────────────────────────────────────────────────────────────────────

const twoCalls: FlowDefinition<{ summary: string }> = {
  id: 'meeting_followup_pack',
  version: '1.0.0',
  title: 'Meeting follow-up pack',
  instructions: 'Write the follow-up pack for the meeting notes.',
  parameters: [
    { key: 'notes', input_type: 'string', requirement: 'required', max: 2000 },
    { key: 'tone', input_type: 'select', requirement: 'optional', options: ['warm', 'formal'], default: 'warm' },
  ],
  tools: ['doc_create', 'email_handoff', 'pdf_fill'],
  limits: { maxSteps: 4, maxModelCalls: 3, maxSeconds: 60, maxEstimateUsd: 0.2 },
  output: s.object({ summary: s.text({ max: 500 }) }),
};

const BIG: HostPolicy = { app: 'dreamstream', confirm: 'big', bigSpendUsd: 0.5 };
const NEVER: HostPolicy = { app: 'dreamstream', confirm: 'never' };

const setup = (options: { governed?: boolean; policy?: HostPolicy; budgetUsd?: number; replies?: FlowModelReply[]; estimate?: number; draft?: boolean } = {}) => {
  const clock = createFakeClock(NOW);
  const ledger = createFakeLedger({ governed: options.governed, budgetUsd: options.budgetUsd });
  const audit = createFakeAudit();
  const approver = createFakeApprover();
  const toolCalls: { name: string; input: unknown }[] = [];
  const ids = createIdSequence('flow');
  const model = scriptedModel(options.replies || [{ kind: 'final', output: { summary: 'Done.' }, usd: 0.01 }]);
  const ports: FlowPorts = {
    callModel: model,
    meter: ledger,
    tools: {
      run: async (name, input) => {
        toolCalls.push({ name, input });
        return { ok: true, output: { draftId: 'd1', sections: 0, blocks: 0 }, usd: 0.002 };
      },
      ...(options.draft === false
        ? {}
        : { draft: async (name: string, input: unknown): Promise<DraftAction> => createDraftAction({ id: ids(), kind: 'provider-draft', summary: `Save the draft (${name})`, target: 'gmail', payload: input, now: clock() }) }),
    },
    approver,
    audit,
    clock,
    newId: ids,
    planKey: KEY,
    sub: 'u1',
    app: 'dreamstream',
    product: 'chat',
    actorId: 'user-1',
    policy: options.policy || BIG,
    estimate: () => (options.estimate === undefined ? 0.1 : options.estimate),
  };
  return { clock, ledger, audit, approver, toolCalls, model, ports };
};

const PARAMS = { notes: 'We agreed on the launch date.' };

describe('runFlow: one request per run, approval by a single-use plan token', () => {
  it('stops at awaiting_approval with the plan and a token bound to a fresh reservation; no model call yet', async () => {
    const { ports, ledger, model, audit } = setup();
    const r = await runFlow(twoCalls, PARAMS, ports);
    expect(r.status).toBe('awaiting_approval');
    expect(r.plan).toMatchObject({ v: 1, flowId: 'meeting_followup_pack', params: { notes: PARAMS.notes, tone: 'warm' }, estimateUsd: 0.1, tools: twoCalls.tools });
    expect(typeof r.planToken).toBe('string');
    expect(model.requests).toHaveLength(0);
    expect(ledger.reservations).toEqual([expect.objectContaining({ operation: 'platform_flow', estimateUsd: 0.1, status: 'reserved', metadata: { platform: expect.objectContaining({ flow: 'meeting_followup_pack' }) } })]);
    const payload = verifyPlanToken(r.planToken, KEY, { nowMs: NOW, sub: 'u1', planHash: planHash(r.plan) });
    expect(payload).toMatchObject({ ok: true, payload: { reservationId: ledger.reservations[0].id } });
    expect(audit.events).toEqual([expect.objectContaining({ kind: 'flow', outcome: 'pending', flow: 'meeting_followup_pack' })]);
  });

  it('runs once on resume, then refuses a second resume with 409', async () => {
    const { ports, ledger, model } = setup();
    const first = await runFlow(twoCalls, PARAMS, ports);
    const approved = { plan: first.plan!, planToken: first.planToken! };
    const once = await runFlow(twoCalls, undefined, ports, approved);
    expect(once).toMatchObject({ status: 'done', output: { summary: 'Done.' }, modelCalls: 1, spentUsd: 0.01 });
    expect(ledger.reservations[0]).toMatchObject({ status: 'settled', actualUsd: 0.01 });
    const again = await runFlow(twoCalls, undefined, ports, approved);
    expect(again).toMatchObject({ status: 'failed', error: { code: 'conflict', status: 409, reason: 'reservation-used' } });
    expect(model.requests).toHaveLength(1);
  });

  it('refuses an expired approval with 403, runs nothing, and releases its hold', async () => {
    const { ports, clock, model, ledger } = setup({ budgetUsd: 2, estimate: 1.9 });
    const big = { ...twoCalls, limits: { ...twoCalls.limits, maxEstimateUsd: 2 } };
    const first = await runFlow(big, PARAMS, ports);
    expect(first.status).toBe('awaiting_approval');
    expect(ledger.remainingUsd()).toBeCloseTo(0.1);
    clock.advance(15 * 60 * 1000);
    const late = await runFlow(big, undefined, ports, { plan: first.plan!, planToken: first.planToken! });
    expect(late).toMatchObject({ status: 'failed', error: { code: 'forbidden', status: 403, reason: 'plan-expired' } });
    expect(model.requests).toHaveLength(0);
    expect(ledger.reservations[0].status).toBe('released');
    expect(ledger.remainingUsd()).toBe(2);
    // The same user can plan again: the expired plan no longer holds the allowance.
    const again = await runFlow(big, PARAMS, ports);
    expect(again.status).toBe('awaiting_approval');
    expect(ledger.reservations[1]).toMatchObject({ status: 'reserved', estimateUsd: 1.9 });
  });

  it('rejects a tampered token, an edited plan or another user, never runs them, and keeps the genuine hold', async () => {
    const { ports, model, ledger } = setup();
    const first = await runFlow(twoCalls, PARAMS, ports);
    const [body, sig] = first.planToken!.split('.');
    const tampered = await runFlow(twoCalls, undefined, ports, { plan: first.plan!, planToken: `${body}.${sig.slice(0, -2)}AA` });
    expect(tampered).toMatchObject({ status: 'failed', error: { status: 401, reason: 'plan-signature' } });
    const richer = await runFlow(twoCalls, undefined, ports, { plan: { ...first.plan!, estimateUsd: 5 }, planToken: first.planToken! });
    expect(richer).toMatchObject({ status: 'failed', error: { status: 403, reason: 'plan-plan' } });
    const moreTools = await runFlow(twoCalls, undefined, ports, { plan: { ...first.plan!, tools: [...first.plan!.tools, 'doc_propose_changes'] }, planToken: first.planToken! });
    expect(moreTools).toMatchObject({ status: 'failed', error: { status: 403 } });
    const otherUser = await runFlow(twoCalls, undefined, { ...ports, sub: 'u2' }, { plan: first.plan!, planToken: first.planToken! });
    expect(otherUser).toMatchObject({ status: 'failed', error: { status: 403, reason: 'plan-subject' } });
    // An expired token of another user cannot release this user's hold either.
    const later = { ...ports, sub: 'u2', clock: () => NOW + 16 * 60 * 1000 };
    expect(await runFlow(twoCalls, undefined, later, { plan: first.plan!, planToken: first.planToken! })).toMatchObject({ error: { status: 403, reason: 'plan-subject' } });
    expect(model.requests).toHaveLength(0);
    expect(ledger.reservations[0].status).toBe('reserved'); // still open for the genuine approval
    expect((await runFlow(twoCalls, undefined, ports, { plan: first.plan!, planToken: first.planToken! })).status).toBe('done');
  });

  it('refuses the user’s own approval with other parameters (403) and releases its hold', async () => {
    const { ports, model, ledger } = setup();
    const first = await runFlow(twoCalls, PARAMS, ports);
    const otherParams = await runFlow(twoCalls, { notes: 'Something else entirely.' }, ports, { plan: first.plan!, planToken: first.planToken! });
    expect(otherParams).toMatchObject({ status: 'failed', error: { status: 403, reason: 'plan-params' } });
    expect(model.requests).toHaveLength(0);
    expect(ledger.reservations[0].status).toBe('released');
    expect(ledger.remainingUsd()).toBe(10);
    expect(await runFlow(twoCalls, undefined, ports, { plan: first.plan!, planToken: first.planToken! })).toMatchObject({ error: { status: 409 } });
  });

  it('refuses a plan whose flow definition changed since approval (409) and releases its hold', async () => {
    const { ports, ledger } = setup();
    const first = await runFlow(twoCalls, PARAMS, ports);
    const changed = { ...twoCalls, version: '1.0.1' };
    expect(await runFlow(changed, undefined, ports, { plan: first.plan!, planToken: first.planToken! })).toMatchObject({ status: 'failed', error: { status: 409, reason: 'plan-stale' } });
    expect(ledger.reservations[0].status).toBe('released');
    expect(ledger.remainingUsd()).toBe(10);
    const second = await runFlow(twoCalls, PARAMS, ports);
    expect(ledger.reservations[1].status).toBe('reserved');
    const pricier = await runFlow(twoCalls, undefined, { ...ports, estimate: () => 0.15 }, { plan: second.plan!, planToken: second.planToken! });
    expect(pricier).toMatchObject({ status: 'failed', error: { status: 409, reason: 'estimate-changed' } });
    expect(ledger.reservations[1].status).toBe('released');
    expect(ledger.remainingUsd()).toBe(10);
  });
});

describe('cancelPlan releases the hold of a plan that will not run', () => {
  it('releases a live plan, which then can never run', async () => {
    const { ports, ledger, model } = setup();
    const first = await runFlow(twoCalls, PARAMS, ports);
    const approved = { plan: first.plan!, planToken: first.planToken! };
    expect(await cancelPlan(approved, ports)).toEqual({ ok: true });
    expect(ledger.reservations[0].status).toBe('released');
    expect(await runFlow(twoCalls, undefined, ports, approved)).toMatchObject({ error: { status: 409, reason: 'reservation-used' } });
    expect(await cancelPlan(approved, ports)).toMatchObject({ ok: false, error: { status: 409 } });
    expect(model.requests).toHaveLength(0);
  });

  it('releases an expired plan’s hold too, and the user can plan again', async () => {
    const { ports, ledger, clock } = setup({ budgetUsd: 2, estimate: 1.9 });
    const big = { ...twoCalls, limits: { ...twoCalls.limits, maxEstimateUsd: 2 } };
    const first = await runFlow(big, PARAMS, ports);
    clock.advance(16 * 60 * 1000);
    expect(await cancelPlan({ plan: first.plan!, planToken: first.planToken! }, ports)).toEqual({ ok: true });
    expect(ledger.reservations[0].status).toBe('released');
    expect(ledger.remainingUsd()).toBe(2);
    expect((await runFlow(big, PARAMS, ports)).status).toBe('awaiting_approval');
    expect(ledger.reservations[1].status).toBe('reserved');
  });

  it('refuses a tampered or foreign token, and reports a release the ledger refused', async () => {
    const { ports, ledger } = setup();
    const first = await runFlow(twoCalls, PARAMS, ports);
    const [body] = first.planToken!.split('.');
    expect(await cancelPlan({ plan: first.plan!, planToken: `${body}.AAAA` }, ports)).toMatchObject({ ok: false, error: { status: 401 } });
    expect(await cancelPlan({ plan: first.plan!, planToken: first.planToken! }, { ...ports, sub: 'u2' })).toMatchObject({ ok: false, error: { status: 403 } });
    expect(ledger.reservations[0].status).toBe('reserved');
    const refusing = Object.assign(Object.create(ledger), { release: async () => ({ ok: false as const, code: 'unavailable' as const, message: 'down' }) });
    expect(await cancelPlan({ plan: first.plan!, planToken: first.planToken! }, { ...ports, meter: refusing })).toMatchObject({ ok: false, error: { reason: 'release-failed' } });
  });
});

describe('every gate reads the user’s policy; a flow’s own policy only tightens it', () => {
  const ALWAYS: HostPolicy = { app: 'dreamstream', confirm: 'always' };

  it('a definition can never claim the user’s explicit never', async () => {
    for (const never of [NEVER, { app: 'atlas', approval: 'none' } as HostPolicy]) {
      expect(() => assertFlowDefinition({ ...twoCalls, policy: never })).toThrow(/tighten/);
    }
    expect(() => assertFlowDefinition({ ...twoCalls, policy: { app: 'dreamstream', confirm: 'sometimes' } as never })).toThrow();
    const { ports, model, ledger } = setup({ policy: ALWAYS, estimate: 0.1 });
    const r = await runFlow({ ...twoCalls, policy: NEVER }, PARAMS, ports);
    expect(r).toMatchObject({ status: 'failed', error: { reason: 'definition' } });
    expect(r.planToken).toBeUndefined();
    expect(model.requests).toHaveLength(0);
    expect(ledger.reservations).toHaveLength(0);
  });

  it('gates under both and takes the stricter answer: a flow’s never never lifts the floor', () => {
    const flow = { maxModelCalls: 3 };
    expect(decideFlowGate({ flow, estimateUsd: 9, target: 'own-draft' }, ALWAYS, NEVER)).toBe('propose');
    expect(decideFlowGate({ flow, estimateUsd: 9, target: 'own-draft' }, NEVER, ALWAYS)).toBe('propose');
    expect(decideFlowGate({ flow, estimateUsd: 9, target: 'own-draft' }, NEVER)).toBe('run');
    expect(decideFlowGate({ flow: { maxModelCalls: 1 }, estimateUsd: 0.05, target: 'own-draft' }, ALWAYS, { app: 'dreamstream', confirm: 'big', bigSpendUsd: 100 })).toBe('spend-confirm');
    expect(stricterGate('spend-confirm', 'propose')).toBe('propose');
    expect(stricterGate('run', 'quota-check')).toBe('quota-check');
    expect(stricterGate('deny', 'confirm')).toBe('deny');
  });

  it('a laxer flow policy cannot skip the user’s spend confirmation', async () => {
    const lax = { ...twoCalls, limits: { ...twoCalls.limits, maxModelCalls: 1 }, policy: { app: 'dreamstream', confirm: 'big', bigSpendUsd: 100 } as HostPolicy };
    const { ports, model } = setup({ policy: ALWAYS, estimate: 0.05 });
    const r = await runFlow(lax, PARAMS, ports);
    expect(r.status).toBe('awaiting_approval');
    expect(typeof r.planToken).toBe('string');
    expect(model.requests).toHaveLength(0);
  });

  it('a stricter flow policy holds even for a user who chose never', async () => {
    const strict = { ...twoCalls, policy: { app: 'dreamstream', confirm: 'always' } as HostPolicy };
    const { ports, model } = setup({ policy: NEVER });
    const r = await runFlow(strict, PARAMS, ports);
    expect(r.status).toBe('awaiting_approval');
    expect(model.requests).toHaveLength(0);
  });

  it('caps a single flow’s hold well under the whole allowance', () => {
    expect(FLOW_ESTIMATE_MAX_USD).toBeLessThan(10);
    expect(() => assertFlowDefinition({ ...twoCalls, limits: { ...twoCalls.limits, maxEstimateUsd: FLOW_ESTIMATE_MAX_USD + 0.01 } })).toThrow();
  });
});

describe('runFlow fails closed with the ledger down', () => {
  it('a governed user cannot even plan a run: 503, nothing reserved, no model call', async () => {
    const { ports, ledger, model } = setup();
    ledger.setDown(true);
    const r = await runFlow(twoCalls, PARAMS, ports);
    expect(r).toMatchObject({ status: 'failed', error: { code: 'disabled', status: 503, reason: 'ledger-down' } });
    expect(ledger.reservations).toHaveLength(0);
    expect(model.requests).toHaveLength(0);
  });

  it('a resume with the ledger down fails closed (503) and the approval still works once it is back', async () => {
    const { ports, ledger, model } = setup();
    const first = await runFlow(twoCalls, PARAMS, ports);
    ledger.setDown(true);
    const down = await runFlow(twoCalls, undefined, ports, { plan: first.plan!, planToken: first.planToken! });
    expect(down).toMatchObject({ status: 'failed', error: { status: 503, reason: 'ledger-down' } });
    expect(model.requests).toHaveLength(0);
    ledger.setDown(false);
    expect((await runFlow(twoCalls, undefined, ports, { plan: first.plan!, planToken: first.planToken! })).status).toBe('done');
  });

  it('a host claim that answers unavailable (or throws) is 503 ledger-down, never 409', async () => {
    for (const claim of [async () => 'unavailable' as const, async (): Promise<never> => Promise.reject(new Error('socket hang up'))]) {
      const { ports, ledger, model } = setup();
      const first = await runFlow(twoCalls, PARAMS, ports);
      const flaky = Object.assign(Object.create(ledger), { claim });
      const r = await runFlow(twoCalls, undefined, { ...ports, meter: flaky }, { plan: first.plan!, planToken: first.planToken! });
      expect(r).toMatchObject({ status: 'failed', error: { code: 'disabled', status: 503, reason: 'ledger-down' } });
      expect(model.requests).toHaveLength(0);
      expect(ledger.reservations[0].status).toBe('reserved');
      // and on the no-approval path (the user chose never)
      const never = setup({ policy: NEVER });
      const n = await runFlow(twoCalls, PARAMS, { ...never.ports, meter: Object.assign(Object.create(never.ledger), { claim }) });
      expect(n).toMatchObject({ status: 'failed', error: { status: 503, reason: 'ledger-down' } });
      expect(never.model.requests).toHaveLength(0);
    }
    const down = createFakeLedger();
    down.setDown(true);
    expect(await down.claim('res-1')).toBe('unavailable'); // the fake answers; it never throws
  });

  it('an ungoverned user’s resume also fails closed: single use cannot be proven without the ledger', async () => {
    const { ports, ledger } = setup({ governed: false });
    const first = await runFlow(twoCalls, PARAMS, ports);
    ledger.setDown(true);
    expect(await runFlow(twoCalls, undefined, ports, { plan: first.plan!, planToken: first.planToken! })).toMatchObject({ status: 'failed', error: { status: 503 } });
  });

  it('a budget that cannot cover the estimate answers 429', async () => {
    const { ports } = setup({ budgetUsd: 0.05 });
    expect(await runFlow(twoCalls, PARAMS, ports)).toMatchObject({ status: 'failed', error: { code: 'quota', status: 429 } });
  });
});

describe('runFlow never passes an unconfirmed external write', () => {
  it('stops at awaiting_confirm with a DraftAction; the write tool is never run', async () => {
    const replies: FlowModelReply[] = [
      { kind: 'tool', tool: 'doc_create', args: { title: 'Follow-up', sections: [] }, usd: 0.01 },
      { kind: 'tool', tool: 'email_handoff', args: { draftId: 'd1', kind: 'provider-draft' }, usd: 0.01 },
      { kind: 'final', output: { summary: 'Sent it.' } },
    ];
    const { ports, toolCalls, approver, ledger } = setup({ policy: NEVER, replies });
    const r = await runFlow(twoCalls, PARAMS, ports);
    expect(r.status).toBe('awaiting_confirm');
    expect(r.draftAction).toMatchObject({ kind: 'provider-draft', target: 'gmail' });
    expect(toolCalls.map((c) => c.name)).toEqual(['doc_create']);
    expect(approver.drafts).toEqual([r.draftAction]);
    expect(r.steps.map((s) => [s.tool, s.outcome])).toEqual([
      ['doc_create', 'ok'],
      ['email_handoff', 'pending'],
    ]);
    expect(ledger.reservations[0]).toMatchObject({ status: 'settled' });
  });

  it('fails (and writes nothing) when the host cannot prepare a draft action', async () => {
    const replies: FlowModelReply[] = [{ kind: 'tool', tool: 'email_handoff', args: { draftId: 'd1', kind: 'provider-draft' } }];
    const { ports, toolCalls } = setup({ policy: NEVER, replies, draft: false });
    expect(await runFlow(twoCalls, PARAMS, ports)).toMatchObject({ status: 'failed', error: { code: 'forbidden', reason: 'external-write' } });
    expect(toolCalls).toEqual([]);
  });

  it('stops at a proposal on the person’s content: the tool never runs, under every policy', async () => {
    for (const policy of [NEVER, BIG, { app: 'atlas', approval: 'none' } as HostPolicy]) {
      const replies: FlowModelReply[] = [
        { kind: 'tool', tool: 'doc_propose_changes', args: { documentId: 'doc1', ops: [] } },
        { kind: 'tool', tool: 'pdf_fill', args: { fileRef: 'f-1', fields: [{ name: 'Name', value: 'Ada' }] }, usd: 0.01 },
        { kind: 'final', output: { summary: 'Filled.' } },
      ];
      const { ports, toolCalls, model, ledger, audit } = setup({ policy, replies });
      let r = await runFlow(twoCalls, PARAMS, ports);
      if (r.status === 'awaiting_approval') r = await runFlow(twoCalls, undefined, ports, { plan: r.plan!, planToken: r.planToken! });
      expect(r.status).toBe('awaiting_confirm');
      expect(r.proposal).toEqual({ tool: 'pdf_fill', decision: 'propose', input: { fileRef: 'f-1', fields: [{ name: 'Name', value: 'Ada' }] }, inputHash: expect.stringMatching(/^sha256:/) });
      expect(r.steps.map((s) => [s.tool, s.outcome])).toEqual([
        ['doc_propose_changes', 'refused'], // not part of this flow
        ['pdf_fill', 'pending'],
      ]);
      expect(toolCalls).toEqual([]); // the copy is never produced inside the flow
      expect(model.requests).toHaveLength(2);
      expect(model.requests[1].transcript[0]).toMatchObject({ kind: 'error', errors: [{ message: 'That tool is not part of this flow.' }] });
      expect(ledger.reservations[0]).toMatchObject({ status: 'settled', actualUsd: 0.01 });
      expect(audit.events[audit.events.length - 1]).toMatchObject({ outcome: 'pending' });
      expect(JSON.stringify(audit.events)).not.toContain('Ada');
    }
  });
});

describe('a ledger that cannot close a hold is reported, never hidden', () => {
  it('flags settleFailed and audits settle-failed when settle answers {ok:false}', async () => {
    const { ports, ledger, audit } = setup({ policy: NEVER });
    const meter = Object.assign(Object.create(ledger), { settle: async () => ({ ok: false as const, code: 'unavailable' as const, message: 'down' }) });
    const r = await runFlow(twoCalls, PARAMS, { ...ports, meter });
    expect(r).toMatchObject({ status: 'done', settleFailed: true, spentUsd: 0.01 });
    expect(audit.events).toContainEqual(expect.objectContaining({ kind: 'flow', outcome: 'failed', errorCode: 'settle-failed', costMicros: 10000 }));
    expect(ledger.reservations[0].status).toBe('claimed'); // stranded, for reconciliation
  });

  it('flags settleFailed and audits release-failed when release throws', async () => {
    const replies: FlowModelReply[] = [{ kind: 'error', code: 'engine-failed', message: 'no' }];
    const { ports, ledger, audit } = setup({ policy: NEVER, replies });
    const meter = Object.assign(Object.create(ledger), { release: async () => Promise.reject(new Error('socket hang up')) });
    const r = await runFlow(twoCalls, PARAMS, { ...ports, meter });
    expect(r).toMatchObject({ status: 'failed', settleFailed: true, error: { reason: 'model-error' } });
    expect(audit.events.map((e) => e.errorCode)).toEqual(['release-failed', 'model-error']);
  });

  it('a healthy ledger leaves no flag', async () => {
    const { ports } = setup({ policy: NEVER });
    expect((await runFlow(twoCalls, PARAMS, ports)).settleFailed).toBeUndefined();
  });
});

describe('runFlow enforces its limits', () => {
  const loop = (n: number, usd = 0): FlowModelReply[] => Array.from({ length: n }, () => ({ kind: 'tool', tool: 'doc_create', args: { title: 'x', sections: [] }, usd }) as FlowModelReply);

  it('maxSteps', async () => {
    const { ports } = setup({ policy: NEVER, replies: loop(10) });
    expect(await runFlow({ ...twoCalls, limits: { ...twoCalls.limits, maxModelCalls: 6, maxSteps: 3 } }, PARAMS, ports)).toMatchObject({
      status: 'failed',
      error: { reason: 'limit-steps' },
      modelCalls: 3,
    });
  });

  it('maxModelCalls (a repair retry counts)', async () => {
    const bad: FlowModelReply[] = Array.from({ length: 10 }, () => ({ kind: 'final', output: { wrong: true } }) as FlowModelReply);
    const { ports } = setup({ policy: NEVER, replies: bad });
    expect(await runFlow({ ...twoCalls, limits: { ...twoCalls.limits, maxSteps: 8, maxModelCalls: 2 } }, PARAMS, ports)).toMatchObject({
      status: 'failed',
      error: { reason: 'limit-model-calls' },
      modelCalls: 2,
    });
  });

  it('maxSeconds', async () => {
    const { ports, clock } = setup({ policy: NEVER });
    const slow = async () => {
      clock.advance(61 * 1000);
      return { kind: 'final', output: { summary: 'late' } } as FlowModelReply;
    };
    expect(await runFlow(twoCalls, PARAMS, { ...ports, callModel: slow })).toMatchObject({ status: 'failed', error: { code: 'timeout', status: 504, reason: 'limit-seconds' } });
  });

  it('the reserved estimate, and maxEstimateUsd at plan time', async () => {
    const { ports, ledger } = setup({ policy: NEVER, replies: loop(5, 0.06), estimate: 0.1 });
    expect(await runFlow(twoCalls, PARAMS, ports)).toMatchObject({ status: 'failed', error: { reason: 'limit-estimate' }, modelCalls: 2 });
    expect(ledger.reservations[0]).toMatchObject({ status: 'settled' });
    const over = setup({ estimate: 0.5 });
    expect(await runFlow(twoCalls, PARAMS, over.ports)).toMatchObject({ status: 'failed', error: { reason: 'limit-estimate' } });
    expect(over.ledger.reservations).toHaveLength(0);
  });

  it('refuses a definition past the ceilings (8 steps, 6 model calls, 60 s)', () => {
    expect(() => assertFlowDefinition(twoCalls)).not.toThrow();
    for (const limits of [
      { ...twoCalls.limits, maxSteps: 9 },
      { ...twoCalls.limits, maxModelCalls: 7 },
      { ...twoCalls.limits, maxSeconds: 61 },
      { ...twoCalls.limits, maxEstimateUsd: 0 },
    ]) {
      expect(() => assertFlowDefinition({ ...twoCalls, limits })).toThrow();
    }
    expect(() => assertFlowDefinition({ ...twoCalls, tools: ['email_send' as never] })).toThrow();
    expect(() => assertFlowDefinition({ ...twoCalls, id: 'send_everything' })).toThrow();
  });

  it('invalid parameters fail before anything is reserved', async () => {
    const { ports, ledger } = setup();
    expect(await runFlow(twoCalls, { notes: 42 }, ports)).toMatchObject({ status: 'failed', error: { code: 'invalid', status: 400, reason: 'params' } });
    expect(await runFlow(twoCalls, { notes: 'x', extra: 'y' }, ports)).toMatchObject({ status: 'failed', error: { reason: 'params' } });
    expect(ledger.reservations).toHaveLength(0);
  });
});

describe('the FlowRun reducer', () => {
  it('allows only the lifecycle moves', () => {
    expect(nextFlowStatus('planned', 'awaiting_approval')).toBe('awaiting_approval');
    expect(canTransition('awaiting_approval', 'running')).toBe(true);
    expect(canTransition('running', 'awaiting_confirm')).toBe(true);
    for (const done of ['done', 'failed', 'cancelled'] as const) expect(() => nextFlowStatus(done, 'running')).toThrow();
    expect(() => nextFlowStatus('planned', 'done')).toThrow();
    expect(() => nextFlowStatus('awaiting_approval', 'awaiting_confirm')).toThrow();
  });
});

describe('a flow’s audit trail is content-free', () => {
  it('records one event per request with the plan hash, never the parameters or output', async () => {
    const { ports, audit } = setup();
    const first = await runFlow(twoCalls, PARAMS, ports);
    await runFlow(twoCalls, undefined, ports, { plan: first.plan!, planToken: first.planToken! });
    expect(audit.events.map((e) => [e.decision, e.outcome])).toEqual([
      ['auto', 'pending'],
      ['confirmed', 'ok'],
    ]);
    const text = JSON.stringify(audit.events);
    expect(text).not.toContain('launch date');
    expect(text).not.toContain('Done.');
    expect(audit.events[1].inputHash).toBe(planHash(first.plan));
    expect(audit.events[1].costMicros).toBe(10000);
  });
});
