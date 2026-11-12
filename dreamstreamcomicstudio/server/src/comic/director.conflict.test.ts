// @vitest-environment node
// End to end (agent-editor plan §4 Wave 2 B-TOOL): the creator commits a change to a line while the director's turn is
// running; the director's edit_panel_text on the same line is held back, the creator's text survives, and the reply
// carries ONE conflict card. Also: the activity events say where the director works (presence, A2/A4).

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CAPS, type StudioCaps } from '../../../shared/comic/capabilities.js';
import { runDirectorTurn } from './director.js';
import { newSession, plannedDoc, scriptedLlm, testContext } from './orchestrator.fakes.js';

beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

const GUARD_ON: StudioCaps = { ...DEFAULT_CAPS, liveAgent: { queue: false, steer: false, conflicts: true } };
const MINE = { op: 'line' as const, pageId: 'pg_1', panelId: 'pn_1_2', id: 'ln_1_2', patch: { text: 'My own words.' } };

const runTurn = async (caps: StudioCaps) => {
  const session = newSession(plannedDoc());
  const llm = scriptedLlm({
    director: [
      () => {
        // The creator edits the line in the page editor while the model is thinking (after the turn's startRev).
        session.commit([MINE], { origin: 'user' });
        return {
          text: 'Rewriting the panel.',
          toolCalls: [{ id: 't1', name: 'edit_panel_text', arguments: JSON.stringify({ page: 1, panel: 2, lines: [{ kind: 'speech', speaker: 'Maya', text: 'Director words.' }] }) }]
        };
      },
      { text: 'Done.' }
    ]
  });
  const ctx = testContext(session, { llm, caps });
  await runDirectorTurn(ctx, { text: 'rewrite page 1 panel 2', attachments: [] });
  const reply = [...session.doc.conversation].reverse().find((m) => m.role === 'assistant')!;
  return { session, llm, ctx, reply };
};

describe('director: a mid-turn user edit wins over edit_panel_text', () => {
  it('the creator\'s text survives, the tool told the model "Conflict:", and the reply has one conflict card', async () => {
    const { session, llm, reply } = await runTurn(GUARD_ON);
    expect(session.doc.pages[0].panels[1].lines[0]).toMatchObject({ id: 'ln_1_2', text: 'My own words.' });
    const toolResult = llm.calls[1].messages.find((m) => m.role === 'tool');
    expect(String(toolResult?.content)).toMatch(/^Conflict: you changed page 1 · panel 2/);
    const cards = (reply.cards ?? []).filter((c) => c.type === 'conflict');
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ type: 'conflict', items: [{ where: { pageId: 'pg_1', lineId: 'ln_1_2' }, mine: 'My own words.' }] });
  });

  it('with the guard off the director overwrites as before (no card): the flag is the only switch', async () => {
    const { session, reply } = await runTurn(DEFAULT_CAPS);
    expect(session.doc.pages[0].panels[1].lines[0].text).toBe('Director words.');
    expect((reply.cards ?? []).some((c) => c.type === 'conflict')).toBe(false);
  });

  it('presence: the activity start and end events carry where: {pageId, lineIds} for the call', async () => {
    const { ctx } = await runTurn(GUARD_ON);
    const acts = ctx.events.filter((e) => e.type === 'activity' && e.label === 'Editing dialogue');
    expect(acts.map((e) => (e.type === 'activity' ? e.phase : ''))).toEqual(['start', 'end']);
    for (const e of acts) expect(e).toMatchObject({ where: { pageId: 'pg_1', lineIds: ['ln_1_2'] } });
  });
});
