// @vitest-environment node
// The director's side of the conflict guard (agent-editor plan §3 A3.2): with COMIC_CONFLICT_GUARD on for this user,
// the model hears the "ask once" rule, reads what the creator DECIDED before the open question, and is asked about a
// contradiction of it; its history reads what each conflict card became. Off, every prompt is exactly as before.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CAPS, type StudioCaps } from '../../../shared/comic/capabilities.js';
import type { ComicDoc, Msg } from '../../../shared/comic/doc.js';
import { CONFLICT_PROMPT_LINE, decidedLine } from './decided.js';
import { HISTORY_WINDOW, conversationForDirector, runDirectorTurn, summarizeDocForDirector } from './director.js';
import { newSession, plannedDoc, scriptedLlm, testContext } from './orchestrator.fakes.js';

beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

const GUARD_ON: StudioCaps = { ...DEFAULT_CAPS, liveAgent: { queue: false, steer: false, conflicts: true } };
const GUARD_OFF: StudioCaps = { ...DEFAULT_CAPS, liveAgent: { queue: true, steer: false, conflicts: false } };

/** An approved 3-page plan: the page count is settled, so "make it 5 pages" contradicts it. */
const approved = (): ComicDoc => ({ ...plannedDoc(), planStatus: 'approved' });
const PAGES_QUESTION = 'OPEN QUESTIONS: the user asked for 5 pages, but the approved plan has 3 pages';

const systemPromptFor = async (caps: StudioCaps, text: string): Promise<string> => {
  const session = newSession(approved());
  const llm = scriptedLlm({ director: [{ text: 'Sure.' }] });
  await runDirectorTurn(testContext(session, { llm, caps }), { text, attachments: [] });
  return String(llm.calls[0].messages[0].content);
};

describe('director.ts with the conflict guard (A3 wave note 1)', () => {
  it('on: the system prompt carries the ask-once rule, the DECIDED line, then the contradiction as the open question', async () => {
    const system = await systemPromptFor(GUARD_ON, 'make it 5 pages');
    const decided = decidedLine(approved());
    expect(decided).toMatch(/^DECIDED \(the creator's; ask once before changing any\): plan approved \(3 pages/);
    expect(system).toContain(CONFLICT_PROMPT_LINE);
    expect(system).toContain(decided);
    expect(system).toContain(PAGES_QUESTION);
    // DECIDED sits in the never-clipped tail, right before OPEN QUESTIONS.
    expect(system.indexOf(decided)).toBeLessThan(system.indexOf(PAGES_QUESTION));
  });

  it('off: no rule, no DECIDED line, no contradiction question; the classic prompt is unchanged', async () => {
    for (const caps of [GUARD_OFF, DEFAULT_CAPS]) {
      const system = await systemPromptFor(caps, 'make it 5 pages');
      expect(system).not.toContain(CONFLICT_PROMPT_LINE);
      expect(system).not.toContain('DECIDED (');
      expect(system).not.toContain('the user asked for 5 pages');
    }
  });

  it('summarizeDocForDirector: contradictions adds DECIDED before OPEN QUESTIONS; without it the summary is as before', () => {
    const doc = approved();
    const on = summarizeDocForDirector(doc, false, [], { userText: 'make it 5 pages', contradictions: true });
    const tail = on.split('\n').slice(-2);
    expect(tail[0]).toBe(decidedLine(doc));
    expect(tail[1]).toMatch(new RegExp(`^${PAGES_QUESTION.replace(/[()]/g, '\\$&')}`));
    const off = summarizeDocForDirector(doc, false, [], { userText: 'make it 5 pages' });
    expect(off).not.toContain('DECIDED (');
    expect(off).not.toContain('the user asked for 5 pages');
    expect(summarizeDocForDirector(doc, false, [], { userText: 'make it 5 pages', contradictions: false })).toBe(off);
    // Nothing settled: no DECIDED line even with the guard on.
    expect(summarizeDocForDirector(plannedDoc(), false, [], { userText: 'hi', contradictions: true })).not.toContain('DECIDED (');
  });

  it("a conflict card in the history reads as what each held-back change became", () => {
    const doc = approved();
    const history: Msg[] = [
      { id: 'u1', role: 'user', text: 'tidy the balloons', at: 1 },
      {
        id: 'a1',
        role: 'assistant',
        text: 'Done.',
        at: 2,
        cards: [
          {
            type: 'conflict',
            id: 'card_cf',
            items: [
              { id: 'cf_1', where: { pageId: 'pg_1', lineId: 'ln_1_2', label: 'page 1 · panel 2 · line 1' }, mine: 'Mine', theirs: 'Theirs', proposed: [], resolved: 'mine' },
              { id: 'cf_2', where: { pageId: 'pg_2', label: 'page 2 · panel 1' }, mine: 'A', theirs: 'B', proposed: [] }
            ]
          }
        ]
      }
    ];
    expect(JSON.stringify(conversationForDirector(history, HISTORY_WINDOW, doc))).toContain(
      "[conflict: page 1 · panel 2 · line 1 — kept the creator's; page 2 · panel 1 — waiting for an answer]"
    );
  });
});
