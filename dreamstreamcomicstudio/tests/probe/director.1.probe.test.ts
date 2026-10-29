// @vitest-environment node
// Probe: approving a gate whose quote no longer holds, under the DEFAULT confirm policy ('big').
// Expected (jobs.ts approveGate comment + sibling test with confirm 'always'): "never run a bigger or
// different spend on an old approval — re-quote instead". Observed: with confirm 'big' the re-quote
// path calls startSpend(confirmed:false) with no forceGate, so a new price under bigSpendUsd runs at
// once — on the pricier model — while the gate card flips to 'declined' ("Not now — nothing was spent.").
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { estimateSpendAction, runAction, startAction } from '../../server/src/comic/jobs.js';
import { newSession, plannedDoc, testContext } from '../../server/src/comic/orchestrator.fakes.js';

beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

describe('approve_gate when the quote went stale (confirm "big", the default)', () => {
  it('re-quotes instead of running the pricier spend on the old approval', async () => {
    const doc = plannedDoc();
    doc.settings = { ...doc.settings, confirm: 'big', bigSpendUsd: 0.5 };
    const session = newSession(doc);
    const ctx = testContext(session);
    // The director quoted the cover (no draw intent → forced gate), Standard quality.
    const quoted = await startAction(ctx, { type: 'render_cover' }, { confirmed: false, forceGate: 'no_intent', collectCard: () => undefined });
    expect(quoted.outcome.status).toBe('gated');
    const first = session.doc.gate!;
    expect(first).toMatchObject({ status: 'open', reason: 'no_intent', model: 'Nano Banana 2.1' });
    // The user switches quality to Pro (quality chip) and then taps Approve on the old card.
    session.commit([{ op: 'settings', patch: { quality: 'pro' } }], { origin: 'user' });
    const proUsd = estimateSpendAction(session.doc, { type: 'render_cover' }, false).usd;
    await runAction(ctx, { type: 'approve_gate', gateId: first.id }, { confirmed: true, origin: 'user' });
    const gate = session.doc.gate!;
    process.stderr.write(`probe1 ${JSON.stringify({ firstUsd: first.estimateUsd, firstModel: first.model, proUsd, gateStatus: gate.status, sameGate: gate.id === first.id, model: gate.model, images: ctx.imagesFake.calls.length, imageModel: ctx.imagesFake.calls[0]?.spec.nickname, spent: session.doc.spend.totalUsd, lastText: session.doc.conversation.at(-1)?.text })}\n`);
    // Expected: a NEW open gate at the Pro price, nothing drawn.
    expect(ctx.imagesFake.calls).toHaveLength(0);
    expect(gate.id).not.toBe(first.id);
    expect(gate.status).toBe('open');
  });
});
