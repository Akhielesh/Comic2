// B-RESOLVE phrase corpus (agent-editor plan §3 B4): every row of the table → the expected intents, the resolved line
// ids and the ops (golden), through grammar → resolve → compile on the synthetic dialogue comic. Hindi and Telugu rows
// are the director's structured dialogue_edit arguments (LLM-arg fixtures), not grammar.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyOps, type DocOp } from '../ops';
import { inverseOps } from '../undo';
import { compileDialogue, intentFromArgs, parseDialogue, type DialogueIntent } from './index';
import { dialogueDoc } from './__fixtures__/dialogueDoc';

interface Row {
  id: string;
  /** The B4 table row this phrase covers. */
  b4: string;
  say: string;
  lang?: string;
  args?: Record<string, unknown>;
  selected?: string[];
  focus?: { pageId?: string; panelN?: number };
  expect: {
    intents: DialogueIntent[];
    confident?: boolean;
    status: 'apply' | 'ask' | 'none';
    lines: string[][];
    ops: DocOp[];
    label?: string;
    note?: string;
    ask?: string;
    options?: string[];
    followUps?: string[];
  };
}

const { rows } = JSON.parse(readFileSync(join(__dirname, '__fixtures__', 'phrases.json'), 'utf8')) as { rows: Row[] };

/** The 38 rows of the plan's B4 table: each must be covered by at least one phrase. */
const B4_ROWS = [
  'make it a whisper', 'turn that into a thought bubble', 'this is narration', "Mira should shout 'Run!'", 'the second panel needs a shout',
  'add BOOM in panel 3', "Leo says 'wait for me' in the last panel", "move Mira's line to the top left", 'put it at the top left of the page',
  'put the narration in a caption box at the bottom', 'caption across the top', 'move it up a bit', 'a lot higher', "put it above Mira's head",
  'put it between them', 'the tail should point at the robot', 'point the tail at her mouth', 'no tail', 'lightning tail', 'swap these two lines',
  'Mira speaks first', 'move this line to panel 3', "that's Leo talking, not Mira", 'the voice comes from off-panel', "change it to 'We have to go'",
  'delete this bubble', 'make all the shouts red', "make Leo's lines italic", 'make this bubble bigger', 'yellow box, a bit see-through',
  'cloud / burst / jagged bubble', 'use a handwritten font for Leo', 'make it sound like a radio', 'same style as this one for every caption',
  'bring it to the front', 'send it back', 'lock it', "don't move this one", 'join these two balloons', 'tidy the bubbles', "make 'never' bold",
  "um so move Mira's line up top and like make it a whisper", 'make it a caption'
];

describe('B4 phrase corpus', () => {
  const doc = dialogueDoc();

  it('covers every row of the B4 table, with Hindi and Telugu structured rows', () => {
    const covered = new Set(rows.map((r) => r.b4));
    expect(B4_ROWS.filter((b) => !covered.has(b))).toEqual([]);
    expect(rows.filter((r) => r.args).map((r) => r.lang).sort()).toEqual(['hi', 'hi', 'hi', 'te', 'te', 'te']);
    expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);
  });

  for (const row of rows) {
    it(`${row.id}: ${row.lang ? `[${row.lang}] ` : ''}“${row.say}”`, () => {
      let intents: DialogueIntent[];
      if (row.args) {
        const m = intentFromArgs(row.args);
        expect('intent' in m && m.intent).toBeTruthy();
        intents = 'intent' in m ? [m.intent] : [];
      } else {
        const g = parseDialogue(row.say, { selected: !!row.selected?.length });
        expect(g.confident, 'confident').toBe(row.expect.confident);
        intents = g.intents;
      }
      expect(intents, 'intents').toEqual(row.expect.intents);
      const run = compileDialogue(doc, intents, { ...(row.selected?.length ? { lineIds: row.selected } : {}), ...(row.focus ?? {}) });
      expect(run.status, 'status').toBe(row.expect.status);
      expect(run.steps.map((s) => s.lines.map((h) => h.lineId)), 'resolved lines').toEqual(row.expect.lines);
      expect(run.ops, 'ops').toEqual(row.expect.ops);
      expect(run.label || undefined, 'label').toBe(row.expect.label);
      expect(run.note, 'note').toBe(row.expect.note);
      expect(run.ask?.question, 'question').toBe(row.expect.ask);
      expect(run.ask?.options?.map((o) => o.id), 'options').toEqual(row.expect.options);
      expect(run.followUps.length ? run.followUps.map((f) => f.label) : undefined, 'chips').toEqual(row.expect.followUps);
      // Every applied phrase is undone exactly by the inverse-op undo; a question changes nothing.
      if (run.status === 'apply') expect(applyOps(applyOps(doc, run.ops), inverseOps(doc, run.ops)).pages).toEqual(doc.pages);
      else expect(run.ops).toEqual([]);
    });
  }

  it('the fast path would run only for confident, single-line, applied phrases', () => {
    const fast = rows.filter((r) => !r.args && r.expect.confident && r.expect.status === 'apply' && r.expect.lines.every((l) => l.length <= 1));
    // Never for a question, a refusal or a sentence the grammar only partly understood.
    expect(fast.some((r) => r.id === 'panel-needs-shout' || r.id === 'whisper-ask' || r.id === 'tidy')).toBe(false);
    expect(fast.length).toBeGreaterThan(25);
  });
});
