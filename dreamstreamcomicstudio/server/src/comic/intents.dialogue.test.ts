// @vitest-environment node
// The free dialogue fast path (agent-editor plan §3 B3; COMIC_DIALOGUE_FAST → caps.dialogueFast): a clear dialogue edit
// is applied by the deterministic engine with NO model call and answered with its own sentence and an Undo chip.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CAPS, type StudioCaps } from '../../../shared/comic/capabilities.js';
import { dialogueFastIntent } from './intents.js';
import { newSession, plannedDoc, scriptedLlm, testContext } from './orchestrator.fakes.js';

beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

const FAST_ON: StudioCaps = { ...DEFAULT_CAPS, dialogueFast: true };
const SELECTED = { pageId: 'pg_2', lineIds: ['ln_2_2'] };

const setup = (caps: StudioCaps = FAST_ON) => {
  const llm = scriptedLlm();
  const ctx = testContext(newSession(plannedDoc()), { llm, caps });
  return { ctx, llm, line: () => ctx.session.doc.pages[1].panels[1].lines[0] };
};

describe('dialogueFastIntent', () => {
  it('"make it a whisper" with a selection: applied with 0 LLM calls, one undoable director step, an Undo chip first', () => {
    const { ctx, llm, line } = setup();
    const rev = ctx.session.doc.rev;
    const out = dialogueFastIntent(ctx, 'make it a whisper', SELECTED);
    expect(llm.calls).toHaveLength(0);
    expect(out).toMatchObject({ kind: 'dialogue_fast', ops: 1, cards: [] });
    expect(out!.reply).toMatch(/whisper/i);
    expect(out!.reply).not.toContain('$');
    expect(out!.nextSteps[0]).toEqual({ label: 'Undo', client: { type: 'undo' } });
    expect(out!.nextSteps.every((s) => !s.action)).toBe(true);
    expect(line()).toMatchObject({ id: 'ln_2_2', kind: 'whisper', speakerId: 'c_maya' });
    expect(ctx.session.doc.rev).toBe(rev + 1);
    expect(ctx.events.filter((e) => e.type === 'ops').at(-1)).toMatchObject({ origin: 'director' });
  });

  it('flag off (the default): null, nothing changes', () => {
    for (const caps of [DEFAULT_CAPS, { ...DEFAULT_CAPS, dialogueFast: false }]) {
      const { ctx, line } = setup(caps);
      expect(dialogueFastIntent(ctx, 'make it a whisper', SELECTED)).toBeNull();
      expect(line().kind).toBe('speech');
    }
  });

  it('anything less than certain goes to the director: no selection and two candidates, a non-dialogue sentence, an open gate', () => {
    const { ctx, line } = setup();
    // "it" with nothing selected, Maya has two lines → the director (it asks "Which line?").
    expect(dialogueFastIntent(ctx, "make Maya's line a whisper")).toBeNull();
    expect(dialogueFastIntent(ctx, 'draw page 2 again', SELECTED)).toBeNull();
    ctx.session.commit([{ op: 'gate', gate: { id: 'g1', status: 'open', reason: 'big', action: { type: 'render_pages' }, estimateUsd: 1, createdAt: 1 } as never }]);
    expect(dialogueFastIntent(ctx, 'make it a whisper', SELECTED)).toBeNull();
    expect(line().kind).toBe('speech');
  });
});
