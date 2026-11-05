// @vitest-environment node
// A2 TURN (agent-editor plan §3 A2, §4 wave 1): the director reads steer notes between rounds, buys at most
// STEER_LIMITS.extraRounds extra rounds for a note that arrives during its final answer, and answers for every note
// it never read (never silent).

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '../ai/providers/types.js';
import { STEER_LIMITS } from '../../../shared/comic/events.js';
import { createEmptyDoc } from '../../../shared/comic/doc.js';
import { MAX_TOOL_ROUNDS, runDirectorTurn, steerNoteText, unreadSteerReply } from './director.js';
import { newSession, plannedDoc, scriptedLlm, testContext, type ScriptStep } from './orchestrator.fakes.js';
import { LONG_MESSAGE_CHARS, type StudioSession, type SteerNote } from './session.js';
import { outageNextSteps, R5_FAILURES } from './tools/models.js';

/** A model_options verdict for the turn (R5 / outage), standing in for the models tool; unset = the real one. */
const advice = vi.hoisted(() => ({ override: undefined as unknown }));
vi.mock('./tools/models.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./tools/models.js')>();
  return {
    ...real,
    modelAdviceOf: (turn: Parameters<typeof real.modelAdviceOf>[0]) => (advice.override as ReturnType<typeof real.modelAdviceOf>) ?? real.modelAdviceOf(turn)
  };
});

afterEach(() => {
  advice.override = undefined;
  vi.restoreAllMocks();
});

let seq = 0;
/** What POST /steer does once a note is screened: commit it as a steered user message, then queue it. */
const steer = (session: StudioSession, text: string, extra: Partial<SteerNote> = {}): boolean => {
  if (session.steerRefusal()) return false;
  const msgId = `msg_steer_${(seq += 1)}`;
  session.commit([{ op: 'message', msg: { id: msgId, role: 'user', text, at: Date.now(), steered: true } }]);
  return session.pushSteer({ msgId, text, at: Date.now(), ...extra });
};
const isNote = (m: ChatMessage) => m.role === 'user' && String(m.content).startsWith('(The user added while you were working:)');
const toolCall = (id: string, title: string) => ({ text: '', toolCalls: [{ id, name: 'update_brief', arguments: JSON.stringify({ title }) }] });
const lastReply = (session: StudioSession) => session.doc.conversation.filter((m) => m.role === 'assistant').at(-1)!;

describe('a note sent during a tool round joins before the next model call', () => {
  it('appears as one user message after the tool result, before round 2 (and the steered message is in the conversation)', async () => {
    const session = newSession(createEmptyDoc('proj-steer'));
    const llm = scriptedLlm({
      director: [
        () => {
          // The creator presses Send now while round 1 is out.
          expect(steer(session, 'and make it a whisper')).toBe(true);
          return toolCall('c1', 'Spice Run');
        },
        { text: 'Renamed it, and noted the whisper.' }
      ]
    });
    await runDirectorTurn(testContext(session, { llm }), { text: 'Call it Spice Run', attachments: [] });
    expect(llm.calls).toHaveLength(2);
    const round2 = llm.calls[1].messages;
    expect(round2.at(-1)).toEqual({ role: 'user', content: '(The user added while you were working:) and make it a whisper' });
    expect(round2.at(-2)).toMatchObject({ role: 'tool', tool_call_id: 'c1' });
    // Round 1 never saw it (it was sent while round 1 ran).
    expect(llm.calls[0].messages.some(isNote)).toBe(false);
    const texts = session.doc.conversation.map((m) => [m.role, m.text, m.steered ?? false]);
    expect(texts).toEqual([
      ['user', 'Call it Spice Run', false],
      ['user', 'and make it a whisper', true],
      ['assistant', 'Renamed it, and noted the whisper.', false]
    ]);
    // Read, so the reply has no "send again" chip.
    expect(lastReply(session).nextSteps?.some((s) => s.label.startsWith('Send my note'))).toBeFalsy();
  });

  it('the inbox is open only while the loop runs: before and after the turn a steer is NOT_RUNNING', async () => {
    const session = newSession(createEmptyDoc('proj-steer'));
    expect(session.steerRefusal()).toBe('NOT_RUNNING');
    let during: string | null = 'unset';
    const llm = scriptedLlm({
      director: [
        () => {
          during = session.steerRefusal();
          return { text: 'Done.' };
        }
      ]
    });
    await runDirectorTurn(testContext(session, { llm }), { text: 'hi', attachments: [] });
    expect(during).toBeNull();
    expect(session.steerRefusal()).toBe('NOT_RUNNING');
    expect(session.pushSteer({ msgId: 'm', text: 'late', at: 1 })).toBe(false);
  });

  it("the note carries the creator's focus and the screen's safety note to the model", async () => {
    const doc = plannedDoc();
    const session = newSession(doc);
    const page = doc.pages.find((p) => p.panels.some((panel) => panel.lines.length))!;
    const line = page.panels.flatMap((panel) => panel.lines)[0];
    const llm = scriptedLlm({
      director: [
        () => {
          steer(session, 'bigger', { focus: { pageId: page.id, lineIds: [line.id] }, safetyNote: 'SAFETY NOTE: keep it PG-13.' });
          return toolCall('c1', 'X');
        },
        { text: 'Ok.' }
      ]
    });
    await runDirectorTurn(testContext(session, { llm }), { text: 'hi', attachments: [] });
    const note = String(llm.calls[1].messages.at(-1)!.content);
    expect(note.split('\n')[0]).toBe('(The user added while you were working:) bigger');
    expect(note).toContain(`Focus: the user is looking at page ${page.n}`);
    expect(note).toContain(`“${line.text.slice(0, 20)}`);
    expect(note).toContain('SAFETY NOTE: keep it PG-13.');
  });
});

describe('a note sent during the final round buys one extra round (≤ STEER_LIMITS.extraRounds)', () => {
  it('exactly one extra round: the answer so far stays, the note follows it, and the turn then ends', async () => {
    const session = newSession(createEmptyDoc('proj-steer'));
    const llm = scriptedLlm({
      director: [
        () => {
          steer(session, 'oh, and call it Night Market');
          return { text: 'Here is your plan.' };
        },
        toolCall('c2', 'Night Market'),
        { text: 'Renamed it to Night Market.' }
      ]
    });
    await runDirectorTurn(testContext(session, { llm }), { text: 'Plan it', attachments: [] });
    // Round 1 (final answer) → extra round (tool) → its reply: one extension, not two.
    expect(llm.calls).toHaveLength(3);
    const extra = llm.calls[1].messages;
    expect(extra.at(-2)).toEqual({ role: 'assistant', content: 'Here is your plan.' });
    expect(extra.at(-1)).toEqual({ role: 'user', content: '(The user added while you were working:) oh, and call it Night Market' });
    expect(session.doc.brief.title).toBe('Night Market');
    // Both answers reach the creator, in order.
    expect(lastReply(session).text).toBe('Here is your plan.\n\nRenamed it to Night Market.');
  });

  it('without a late note the final round ends the turn (no extra model call)', async () => {
    const session = newSession(createEmptyDoc('proj-steer'));
    const llm = scriptedLlm({ director: [{ text: 'Done.' }] });
    await runDirectorTurn(testContext(session, { llm }), { text: 'hi', attachments: [] });
    expect(llm.calls).toHaveLength(1);
  });

  it(`stops extending after ${STEER_LIMITS.extraRounds}: a note arriving in the last allowed answer is answered for, never stranded`, async () => {
    const session = newSession(createEmptyDoc('proj-steer'));
    const answer = (n: number, note: string): ScriptStep => () => {
      steer(session, note);
      return { text: `Answer ${n}.` };
    };
    const llm = scriptedLlm({ director: [answer(1, 'first'), answer(2, 'second'), answer(3, 'third')] });
    await runDirectorTurn(testContext(session, { llm }), { text: 'go', attachments: [] });
    expect(llm.calls).toHaveLength(1 + STEER_LIMITS.extraRounds);
    const reply = lastReply(session);
    expect(reply.text).toContain("Your added note came in as I was finishing, so I haven't done it yet.");
    expect(reply.nextSteps?.[0]).toEqual({ label: 'Send my note', say: 'third' });
    expect(session.steerRefusal()).toBe('NOT_RUNNING');
  });

  it('at the tool limit, the extra round may still act once, then answers in words', async () => {
    const session = newSession(createEmptyDoc('proj-steer'));
    const steps: ScriptStep[] = Array.from({ length: MAX_TOOL_ROUNDS }, (_, i) => toolCall(`c${i}`, `T${i}`));
    steps.push(() => {
      steer(session, 'rename it Last Call');
      return { text: 'I hit my limit.' };
    });
    steps.push(toolCall('late', 'Last Call'));
    steps.push({ text: 'Renamed it Last Call.' });
    const llm = scriptedLlm({ director: steps });
    await runDirectorTurn(testContext(session, { llm }), { text: 'go', attachments: [] });
    expect(llm.calls).toHaveLength(MAX_TOOL_ROUNDS + 3);
    expect(session.doc.brief.title).toBe('Last Call');
    // The reply after the extra tool round is a forced word answer.
    expect(String(llm.calls.at(-1)!.messages.at(-1)!.content)).toMatch(/Tool limit reached/);
  });

  it(`a note sent during the ${MAX_TOOL_ROUNDS}th (last allowed) tool round buys one more tool round, so it can act`, async () => {
    const session = newSession(createEmptyDoc('proj-steer'));
    const steps: ScriptStep[] = Array.from({ length: MAX_TOOL_ROUNDS - 1 }, (_, i) => toolCall(`c${i}`, `T${i}`));
    steps.push(() => {
      steer(session, 'rename it Last Call');
      return toolCall('c_last', 'T_last');
    });
    steps.push(toolCall('late', 'Last Call'));
    steps.push({ text: 'Renamed it Last Call.' });
    const llm = scriptedLlm({ director: steps });
    await runDirectorTurn(testContext(session, { llm }), { text: 'go', attachments: [] });
    expect(llm.calls).toHaveLength(MAX_TOOL_ROUNDS + 2);
    // The call after the cap round reads the note right after its tool result, with tools still allowed.
    const extra = llm.calls[MAX_TOOL_ROUNDS].messages;
    expect(extra.at(-1)).toEqual({ role: 'user', content: '(The user added while you were working:) rename it Last Call' });
    expect(extra.at(-2)).toMatchObject({ role: 'tool', tool_call_id: 'c_last' });
    expect(extra.some((m) => /Tool limit reached/.test(String(m.content)))).toBe(false);
    expect(session.doc.brief.title).toBe('Last Call');
    // Then the forced word answer, and no resend chip (the note was read and acted on).
    expect(String(llm.calls.at(-1)!.messages.at(-1)!.content)).toMatch(/Tool limit reached/);
    expect(lastReply(session).nextSteps?.some((s) => s.label.startsWith('Send my note'))).toBeFalsy();
  });

  it(`at the tool limit with the ${STEER_LIMITS.extraRounds} extra rounds used up, a note is left unread and answered for (never read where it cannot act)`, async () => {
    const session = newSession(createEmptyDoc('proj-steer'));
    const steerThen = (note: string, id: string): ScriptStep => () => {
      steer(session, note);
      return toolCall(id, id);
    };
    const steps: ScriptStep[] = Array.from({ length: MAX_TOOL_ROUNDS - 1 }, (_, i) => toolCall(`c${i}`, `T${i}`));
    // Rounds MAX, MAX+1: each takes a note at the cap (two extra rounds). Round MAX+2: a third note, no extension left.
    steps.push(steerThen('first', 'R1'), steerThen('second', 'R2'), steerThen('third', 'R3'));
    steps.push({ text: 'All done.' });
    const llm = scriptedLlm({ director: steps });
    await runDirectorTurn(testContext(session, { llm }), { text: 'go', attachments: [] });
    expect(llm.calls).toHaveLength(MAX_TOOL_ROUNDS + 3);
    expect(session.doc.brief.title).toBe('R3');
    // The last (forced word) call never saw the third note: it is not taken into a call that cannot act on it.
    const lastCall = llm.calls.at(-1)!.messages;
    expect(lastCall.some((m) => String(m.content).includes('third'))).toBe(false);
    expect(String(lastCall.at(-1)!.content)).toMatch(/Tool limit reached/);
    const reply = lastReply(session);
    expect(reply.text).toContain("Your added note came in as I was finishing, so I haven't done it yet.");
    expect(reply.nextSteps?.[0]).toEqual({ label: 'Send my note', say: 'third' });
  });
});

describe('notes the turn never read are answered for, with a one-tap resend', () => {
  it('a turn that ends on ask_user takes no note, and its reply says so with a Send my note chip', async () => {
    const session = newSession(createEmptyDoc('proj-steer'));
    const ask = { question: 'Which look?', options: ['Bright', 'Moody'] };
    const llm = scriptedLlm({
      director: [
        () => {
          steer(session, 'make it rain');
          return { text: '', toolCalls: [{ id: 'c1', name: 'ask_user', arguments: JSON.stringify(ask) }] };
        }
      ]
    });
    await runDirectorTurn(testContext(session, { llm }), { text: 'Make a comic', attachments: [] });
    expect(llm.calls).toHaveLength(1);
    const reply = lastReply(session);
    expect(reply.cards?.some((c) => c.type === 'options')).toBe(true);
    expect(reply.text).toContain('Tap “Send my note” to send it now.');
    expect(reply.nextSteps?.[0]).toEqual({ label: 'Send my note', say: 'make it rain' });
  });

  it('a Stopped turn with nothing said still answers for the unread notes (it never ends silently)', async () => {
    const session = newSession(createEmptyDoc('proj-steer'));
    const controller = new AbortController();
    const llm = scriptedLlm({
      director: [
        () => {
          steer(session, 'red');
          steer(session, 'and bigger');
          controller.abort();
          return { text: '', toolCalls: [{ id: 'c1', name: 'update_brief', arguments: JSON.stringify({ title: 'Z' }) }] };
        }
      ]
    });
    await runDirectorTurn(testContext(session, { llm, signal: controller.signal }), { text: 'go', attachments: [] });
    const reply = lastReply(session);
    expect(reply.text).toBe('Stopped.\n\nI stopped before reading the 2 notes you added. Tap “Send my notes” to send them now.');
    expect(reply.nextSteps).toEqual([{ label: 'Send my notes', say: '(Sent while you were working:)\n1. red\n2. and bigger' }]);
  });

  it('a Stopped turn without notes stays as quiet as before', async () => {
    const session = newSession(createEmptyDoc('proj-steer'));
    const controller = new AbortController();
    const llm = scriptedLlm({
      director: [
        () => {
          controller.abort();
          return { text: '', toolCalls: [{ id: 'c1', name: 'update_brief', arguments: JSON.stringify({ title: 'Z' }) }] };
        }
      ]
    });
    await runDirectorTurn(testContext(session, { llm, signal: controller.signal }), { text: 'go', attachments: [] });
    expect(session.doc.conversation.filter((m) => m.role === 'assistant')).toEqual([]);
  });

  it('a failed model call closes the inbox and keeps the unread chip first, ahead of Try again', async () => {
    const session = newSession(createEmptyDoc('proj-steer'));
    const llm = scriptedLlm({
      director: [
        () => {
          steer(session, 'blue');
          return new Error('provider down');
        }
      ]
    });
    await runDirectorTurn(testContext(session, { llm }), { text: 'paint it', attachments: [] });
    const reply = lastReply(session);
    expect(reply.nextSteps?.[0]).toEqual({ label: 'Send my note', say: 'blue' });
    expect(session.steerRefusal()).toBe('NOT_RUNNING');
  });
});

describe('on an outage or R5 turn the retry chips lead (models.md §3.6 G); the note chip follows the first of them', () => {
  it('a note left unread on a troubled turn: the first outage chip, then Send my note', async () => {
    const doc = plannedDoc();
    // Three page drawings that failed upstream (429) in the last few minutes: the studio's retry chip applies.
    doc.pages.slice(-3).forEach((p, i) => {
      p.render = { ...p.render, status: 'failed', error: 'Rate-limited.', errorDetail: { code: 'RATE_LIMIT', provider: 'OpenRouter', at: Date.now() - (3 - i) * 60_000, text: '429' } };
    });
    const session = newSession(doc);
    advice.override = { streak: { count: R5_FAILURES } };
    const answer = (n: number, note: string): ScriptStep => () => {
      steer(session, note);
      return { text: `Answer ${n}.` };
    };
    const llm = scriptedLlm({ director: [answer(1, 'first'), answer(2, 'second'), answer(3, 'third')] });
    await runDirectorTurn(testContext(session, { llm }), { text: 'go', attachments: [] });
    const outage = outageNextSteps(session.doc, false);
    expect(outage.map((s) => s.label)).toEqual(['Try again', 'See other models']);
    const labels = lastReply(session).nextSteps!.map((s) => s.label);
    expect(labels[0]).toBe(outage[0].label);
    expect(labels[1]).toBe('Send my note');
  });

  it('without an outage the note chip leads', async () => {
    const session = newSession(plannedDoc());
    const answer = (n: number, note: string): ScriptStep => () => {
      steer(session, note);
      return { text: `Answer ${n}.` };
    };
    const llm = scriptedLlm({ director: [answer(1, 'first'), answer(2, 'second'), answer(3, 'third')] });
    await runDirectorTurn(testContext(session, { llm }), { text: 'go', attachments: [] });
    expect(lastReply(session).nextSteps?.[0]).toEqual({ label: 'Send my note', say: 'third' });
  });
});

describe('a turn that crashes after its loop still answers for the notes it never read', () => {
  it('the crash reply carries the unread line, the note chip first and then Try again', async () => {
    const session = newSession(createEmptyDoc('proj-steer'));
    const ask = { question: 'Which look?', options: ['Bright', 'Moody'] };
    const llm = scriptedLlm({
      director: [
        () => {
          steer(session, 'make it rain');
          return { text: '', toolCalls: [{ id: 'c1', name: 'ask_user', arguments: JSON.stringify(ask) }] };
        }
      ]
    });
    // The final reply's commit fails once (a seam that throws after the loop).
    const commit = session.commit.bind(session);
    let thrown = false;
    vi.spyOn(session, 'commit').mockImplementation((ops, opts) => {
      if (!thrown && ops.some((o) => o.op === 'message' && o.msg.role === 'assistant')) {
        thrown = true;
        throw new Error('store hiccup');
      }
      return commit(ops, opts);
    });
    await runDirectorTurn(testContext(session, { llm }), { text: 'Make a comic', attachments: [] });
    expect(thrown).toBe(true);
    const reply = lastReply(session);
    expect(reply.text).toBe(
      "Sorry — I couldn't finish that just now. Try again in a moment.\n\nYour added note came in as I was finishing, so I haven't done it yet. Tap “Send my note” to send it now."
    );
    expect(reply.nextSteps).toEqual([
      { label: 'Send my note', say: 'make it rain' },
      { label: 'Try again', say: 'Make a comic' }
    ]);
  });
});

describe('pure helpers', () => {
  it('steerNoteText keeps the wave 0 format; a safety note always follows its note, a focus line only with the doc', () => {
    const doc = plannedDoc();
    const page = doc.pages[0];
    const notes: SteerNote[] = [
      { msgId: 'a', text: 'red', at: 1, focus: { pageId: page.id } },
      { msgId: 'b', text: 'bigger', at: 2, safetyNote: 'IP NOTE: an original hero.' }
    ];
    expect(steerNoteText(notes.map(({ safetyNote: _s, ...n }) => n))).toBe('(The user added while you were working:)\n1. red\n2. bigger');
    expect(steerNoteText(notes)).toBe('(The user added while you were working:)\n1. red\n2. bigger\n   IP NOTE: an original hero.');
    expect(steerNoteText(notes, doc)).toBe(
      `(The user added while you were working:)\n1. red\n   Focus: the user is looking at page ${page.n}\n2. bigger\n   IP NOTE: an original hero.`
    );
    expect(steerNoteText([{ msgId: 'c', text: '  ', at: 3 }, notes[1]], doc)).toBe('(The user added while you were working:) bigger\nIP NOTE: an original hero.');
  });

  it('unreadSteerReply: nothing for no notes; short notes go as one numbered message', () => {
    expect(unreadSteerReply([], 'ended')).toEqual({ line: '', steps: [] });
    const three = ['a', 'b', 'c'].map((t, i) => ({ msgId: t, text: `note ${t}`, at: i }));
    const out = unreadSteerReply(three, 'ended');
    expect(out.line).toBe("Your 3 added notes came in as I was finishing, so I haven't done them yet. Tap “Send my notes” to send them now.");
    expect(out.steps).toEqual([{ label: 'Send my notes', say: '(Sent while you were working:)\n1. note a\n2. note b\n3. note c' }]);
  });

  it(`unreadSteerReply: every chip says at most ${LONG_MESSAGE_CHARS} characters, so a resent note is never saved as a pasted script`, () => {
    // Two 3500-character notes: together they would cross the pasted-script threshold, so each gets its own chip.
    const notes = ['a', 'b'].map((t, i) => ({ msgId: t, text: t.repeat(3500), at: i }));
    const out = unreadSteerReply(notes, 'ended');
    expect(out.steps.map((s) => s.label)).toEqual(['Send note 1', 'Send note 2']);
    expect(out.steps.map((s) => s.say)).toEqual(['a'.repeat(3500), 'b'.repeat(3500)]);
    for (const step of out.steps) expect(step.say!.length).toBeLessThanOrEqual(LONG_MESSAGE_CHARS);
    expect(out.line).toBe(
      "Your 2 added notes came in as I was finishing, so I haven't done them yet. They're too long for one message, so each has its own chip — tap “Send note 1” and the others to send them now."
    );
    // Three notes at the steer cap: three chips, each within the threshold.
    const full = unreadSteerReply(['x', 'y', 'z'].map((t, i) => ({ msgId: t, text: t.repeat(LONG_MESSAGE_CHARS), at: i })), 'stopped');
    expect(full.steps).toHaveLength(3);
    for (const step of full.steps) expect(step.say!.length).toBeLessThanOrEqual(LONG_MESSAGE_CHARS);
    // One note is its own message.
    expect(unreadSteerReply([notes[0]], 'ended').steps).toEqual([{ label: 'Send my note', say: 'a'.repeat(3500) }]);
  });
});
