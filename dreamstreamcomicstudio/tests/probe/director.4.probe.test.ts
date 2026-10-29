// @vitest-environment node
// Probe: the user's included usage is exhausted (billing denies the director's text call).
// What does the director say, and does it offer an honest next step?
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runDirectorTurn } from '../../server/src/comic/director.js';
import { fakeBilling, newSession, plannedDoc, scriptedLlm, testContext } from '../../server/src/comic/orchestrator.fakes.js';

beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

describe('director turn when the text allowance is exhausted', () => {
  it('says why and does not promise that trying again in a moment will work', async () => {
    const session = newSession(plannedDoc());
    const llm = scriptedLlm({ director: [{ text: 'never reached' }] });
    const ctx = testContext(session, { llm, billing: fakeBilling(0) });
    await runDirectorTurn(ctx, { text: 'make page 1 funnier', attachments: [] });
    const reply = session.doc.conversation.at(-1)!;
    process.stderr.write(`probe4 ${JSON.stringify({ text: reply.text, cards: reply.cards, nextSteps: reply.nextSteps })}\n`);
    expect(reply.role).toBe('assistant');
    // The reason (allowance used up) must be in the words the user reads, not only on a card.
    expect(reply.text).toMatch(/allowance|usage/i);
    expect(reply.text).not.toMatch(/try again in a moment/i);
  });
});
