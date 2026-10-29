// @vitest-environment node
// Probe: the director asks a question (options card); the user taps an option (the client sends the
// reply text). Is the answer recorded on the card (Card.answered) so a reload / second device shows it
// answered and the model's history reads "answered: …"?
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createEmptyDoc } from '../../shared/comic/doc.js';
import { runDirectorTurn } from '../../server/src/comic/director.js';
import { newSession, scriptedLlm, testContext } from '../../server/src/comic/orchestrator.fakes.js';

beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

const toolCall = (id: string, name: string, args: unknown) => ({ id, name, arguments: JSON.stringify(args) });

describe('options card answers', () => {
  it('are recorded on the card once the user picks one', async () => {
    const session = newSession(createEmptyDoc('q-1'));
    const llm = scriptedLlm({
      director: [
        { text: 'What tone?', toolCalls: [toolCall('q1', 'ask_user', { question: 'What tone?', options: [{ label: 'Funny' }, { label: 'Tense' }] })] },
        { text: 'Funny it is.' }
      ]
    });
    const ctx = testContext(session, { llm });
    await runDirectorTurn(ctx, { text: 'A story about a cat.', attachments: [] });
    const asked = session.doc.conversation.at(-1)!;
    const card = asked.cards!.find((c) => c.type === 'options')!;
    // The user taps "Funny": the OptionsCard sends the reply text as the next message.
    await runDirectorTurn(ctx, { text: 'Funny', attachments: [] });
    const after = session.doc.conversation.find((m) => m.id === asked.id)!.cards!.find((c) => c.type === 'options') as { answered?: string[] };
    process.stderr.write(`probe6 ${JSON.stringify({ answered: after.answered, cardId: card.id })}\n`);
    expect(after.answered?.length).toBeGreaterThan(0);
  });
});
