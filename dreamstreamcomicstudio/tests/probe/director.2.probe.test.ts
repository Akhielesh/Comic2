// @vitest-environment node
// Probe: a gate approved after its target vanished (user deleted the quoted page in the timeline).
// approveGate commits status 'approved' first and only re-opens on a 'blocked' outcome; the 'nothing'
// outcome ($0, nothing drawn) leaves the gate 'approved', so the GateCard reads "Approved — drawing now."
// while the sibling message says nothing was spent.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runAction, startAction } from '../../server/src/comic/jobs.js';
import { newSession, plannedDoc, testContext } from '../../server/src/comic/orchestrator.fakes.js';

beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

describe('approve_gate after the quoted page was deleted', () => {
  it('does not leave the card saying "Approved — drawing now." when nothing was drawn', async () => {
    const doc = plannedDoc();
    doc.settings = { ...doc.settings, confirm: 'always' };
    // Sheets ready so the quote is page-only.
    for (const c of doc.cast) c.sheet = { ...c.sheet, status: 'ready', asset: { path: `${c.id}.webp`, source: 'generated', at: 1 } };
    const session = newSession(doc);
    const ctx = testContext(session);
    await startAction(ctx, { type: 'render_pages', pageIds: ['pg_3'] }, { confirmed: false, collectCard: () => undefined });
    const gate = session.doc.gate!;
    expect(gate.status).toBe('open');
    // The user deletes page 3 in the timeline, then taps Approve on the still-visible card.
    session.commit([{ op: 'page_delete', id: 'pg_3', deletedAt: Date.now() }], { origin: 'user' });
    await runAction(ctx, { type: 'approve_gate', gateId: gate.id }, { confirmed: true, origin: 'user' });
    const after = session.doc.gate!;
    const last = session.doc.conversation.at(-1);
    // eslint-disable-next-line no-console
    console.log('probe2', { status: after.status, images: ctx.imagesFake.calls.length, lastText: last?.text });
    expect(ctx.imagesFake.calls).toHaveLength(0);
    // Expected: the gate is not left 'approved' (the card would claim "Approved — drawing now.").
    expect(after.status).not.toBe('approved');
  });
});
