// @vitest-environment node
// Probe: after the director has started a render, the server releases the turn lock (a new message is
// accepted), but the message stream only closes once every render the turn started has settled — and the
// client's composer is locked (Send → Stop) for as long as that stream is open (isMessageBusy).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runDirectorTurn } from '../../server/src/comic/director.js';
import { fakeImages, newSession, plannedDoc, scriptedLlm, testContext } from '../../server/src/comic/orchestrator.fakes.js';

beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

const toolCall = (id: string, name: string, args: unknown) => ({ id, name, arguments: JSON.stringify(args) });

describe('message stream lifetime vs the turn lock', () => {
  it('the stream the client waits on stays open until the renders land, long after the director is free', async () => {
    const doc = plannedDoc(); // confirm 'never', so the render starts without a gate
    doc.planStatus = 'approved';
    doc.settings = { ...doc.settings, reviewFirstRender: false };
    const session = newSession(doc);
    let releaseImage!: () => void;
    const gate = new Promise<void>((r) => { releaseImage = r; });
    const images = fakeImages(async () => { await gate; return undefined; });
    const llm = scriptedLlm({ director: [{ text: 'Drawing page 1 now.', toolCalls: [toolCall('c1', 'render_pages', { pages: [1] })] }, { text: 'On its way.' }] });
    const ctx = testContext(session, { llm, images });
    const turn = session.runExclusive(() => runDirectorTurn(ctx, { text: 'draw page 1', attachments: [] }));
    await turn;
    // The director turn is over: the server would accept the next message (no BUSY).
    expect(session.turnRunning).toBe(false);
    expect(session.doc.conversation.at(-1)?.text).toContain('On its way');
    // …but the stream the client is holding open (it awaits ctx.settled() before `done`) has not closed.
    let settled = false;
    const wait = ctx.settled().then(() => { settled = true; });
    await new Promise((r) => setTimeout(r, 50));
    process.stderr.write(`probe5 ${JSON.stringify({ turnRunning: session.turnRunning, streamSettled: settled, pageStatus: session.doc.pages[0].render.status })}\n`);
    expect(settled).toBe(false); // the client's composer is locked (Send → Stop) during this whole window
    releaseImage();
    await wait;
    expect(settled).toBe(true);
  });
});
