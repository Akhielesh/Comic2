// @vitest-environment node
// Probe: a governed user (included usage, never dollars) watches the director's reply STREAM.
// The committed message is run through governDollars, but the live `delta` events carry the model's
// raw words, so a "$0.12" the model writes is on screen until the final message replaces it.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createEmptyDoc } from '../../shared/comic/doc.js';
import { DEFAULT_CAPS } from '../../shared/comic/capabilities.js';
import { runDirectorTurn } from '../../server/src/comic/director.js';
import { newSession, scriptedLlm, testContext } from '../../server/src/comic/orchestrator.fakes.js';

beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

describe('governed user: streamed deltas', () => {
  it('never carry a dollar amount', async () => {
    const session = newSession(createEmptyDoc('gov-1'));
    const llm = scriptedLlm({ director: [{ text: 'The cover would be about $0.12 — want it?' }] });
    const caps = { ...DEFAULT_CAPS, usage: { governed: true, pctLeft: 50, exhausted: false, pctPerStandardPage: 1 } };
    const ctx = testContext(session, { llm, caps });
    await runDirectorTurn(ctx, { text: 'how much is the cover?', attachments: [] });
    const deltas = ctx.events.filter((e) => e.type === 'delta').map((e) => (e as { text: string }).text).join('');
    const final = session.doc.conversation.at(-1)!.text;
    // eslint-disable-next-line no-console
    console.log('probe3', { deltas, final });
    expect(final).not.toMatch(/\$/);
    expect(deltas).not.toMatch(/\$/);
  });
});
