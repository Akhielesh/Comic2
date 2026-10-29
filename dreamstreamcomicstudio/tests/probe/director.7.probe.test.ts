// @vitest-environment node
// Probe: the comic is at its budget cap. The director's writer calls refuse (guardPaidText: "The comic is
// at its budget cap"), but the UI's plan_pages action (the "Plan the pages" chip / PlanCard "Re-plan")
// runs the paid writer anyway — planPages() never looks at settings.budgetUsd.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runAction } from '../../server/src/comic/jobs.js';
import { newSession, plannedDoc, scriptedLlm, testContext } from '../../server/src/comic/orchestrator.fakes.js';

beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

describe('plan_pages action at the budget cap', () => {
  it('does not run the paid writer past the budget', async () => {
    const doc = plannedDoc();
    doc.settings = { ...doc.settings, budgetUsd: 0.05 };
    doc.spend = { ...doc.spend, totalUsd: 0.09 };
    const session = newSession(doc);
    const llm = scriptedLlm({ writer: [{ text: '{}' }] });
    const ctx = testContext(session, { llm });
    let error: string | undefined;
    try {
      await runAction(ctx, { type: 'plan_pages', instructions: 'make it funnier' }, { confirmed: true, origin: 'user' });
    } catch (err) {
      error = (err as Error).message;
    }
    const writerReserves = ctx.billingFake.reserves.filter((r) => r.stage === 'plan');
    process.stderr.write(`probe7 ${JSON.stringify({ error, writerCalls: llm.calls.filter((c) => c.role === 'writer').length, writerReserves: writerReserves.length, spent: session.doc.spend.totalUsd, last: session.doc.conversation.at(-1)?.text })}\n`);
    expect(writerReserves).toHaveLength(0);
  });
});
