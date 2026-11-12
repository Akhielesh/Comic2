// B-RESOLVE compile.ts (agent-editor plan §3 B2, B4): free ops for each act, and the rules the compiler never bends —
// never invent a speaker, never re-assign one when moving a line, locks hold, never silent, every edit undoable.
import { describe, expect, it } from 'vitest';
import type { ComicDoc } from '../doc';
import { applyOps, type DocOp } from '../ops';
import { inverseOps } from '../undo';
import { FREE_DIALOGUE_OPS, IN_ART_REFUSAL, compileDialogue, compileIntent, compileWith, dialogueFastPath, mergeLineOps } from './compile';
import { intentFromArgs, parseDialogue } from './grammar';
import { hitOf } from './resolve';
import type { DialogueIntent, LineHit } from './types';
import { apply, dialogueDoc, line, panel } from './__fixtures__/dialogueDoc';

const doc = dialogueDoc();
const hits = (d: ComicDoc, ...ids: string[]): LineHit[] => ids.map((id) => hitOf(d, id)!);
const opsOf = (d: ComicDoc, intent: DialogueIntent, ...ids: string[]) => compileWith(d, intent, hits(d, ...ids));
const lineIn = (d: ComicDoc, id: string) => d.pages.flatMap((p) => p.panels.flatMap((pn) => pn.lines)).find((l) => l.id === id);

describe('compileIntent', () => {
  it('keeps the stub contract: ops, an undo label and follow-up chips', () => {
    const r = compileIntent(doc, { act: 'set_kind', target: { selected: true }, kind: 'whisper' }, hits(doc, 'l_leo1'));
    expect(r.ops).toEqual([{ op: 'line', pageId: 'pg_1', panelId: 'pn_2', id: 'l_leo1', patch: { kind: 'whisper' } }]);
    expect(r.label).toBe('Make it a whisper');
    expect(r.followUps.map((f) => f.label)).toEqual(['Make it a shout', 'Try another font', 'Move it']);
    expect(r.followUps[0].say).toBe('Make “Wait for me” a shout');
  });

  it('never invents a speaker: a caption turned into a thought asks "Who\'s thinking it?" with cast chips, panel cast first', () => {
    const r = opsOf(doc, { act: 'set_kind', target: {}, kind: 'thought' }, 'l_sfx');
    expect(r.ops).toEqual([]);
    expect(r.ask?.question).toBe("Who's thinking it?");
    expect(r.followUps.map((f) => f.label)).toEqual(['Bolt', 'Mira Patel', 'Leo', 'Asha Patel']);
    expect(r.followUps[0].say).toBe('Make “BEEP” a thought balloon by Bolt');
    // A new spoken line without a speaker asks the same way.
    const add = compileWith(doc, { act: 'add', panel: { page: 1, panel: 2 }, kind: 'speech', text: 'Hello' }, []);
    expect(add.ops).toEqual([]);
    expect(add.ask?.question).toBe('Who says it?');
    expect(add.followUps[0]).toEqual({ label: 'Mira Patel', say: 'Add a speech balloon by Mira Patel in panel 2 on page 1 saying “Hello”' });
  });

  it('a caption or sound effect drops its speaker; speech gets one only when named', () => {
    const r = opsOf(doc, { act: 'set_kind', target: {}, kind: 'caption' }, 'l_bolt1');
    expect(r.ops).toHaveLength(1);
    const op = r.ops[0] as Extract<DocOp, { op: 'line' }>;
    expect(op.patch).toHaveProperty('speakerId', undefined);
    expect(lineIn(applyOps(doc, r.ops), 'l_bolt1')).toEqual({ id: 'l_bolt1', kind: 'caption', text: 'Intruder detected' });
    // "Make it a thought by Leo": the speaker first, then the kind — one merged line op.
    const run = compileDialogue(doc, [
      { act: 'set_speaker', target: { selected: true }, speaker: 'Leo' },
      { act: 'set_kind', target: { selected: true }, kind: 'thought' }
    ], { lineIds: ['l_cap'] });
    expect(run.status).toBe('apply');
    expect(run.ops).toEqual([{ op: 'line', pageId: 'pg_1', panelId: 'pn_1', id: 'l_cap', patch: { speakerId: 'c_leo', kind: 'thought' } }]);
    expect(run.note).toMatch(/“The lab, midnight\.” was a caption; it's a speech balloon now\. Leo isn't drawn in panel 1/);
  });

  it('adds a line with a fresh id and its auto-placed (unpinned) balloon; a full panel refuses', () => {
    const r = compileWith(doc, { act: 'add', panel: { page: 1, panel: 3 }, kind: 'sfx', text: 'BOOM' }, []);
    const [lineOp, balloonOp] = r.ops as [Extract<DocOp, { op: 'line' }>, Extract<DocOp, { op: 'balloon' }>];
    expect(lineOp).toMatchObject({ op: 'line', pageId: 'pg_1', panelId: 'pn_3', patch: { kind: 'sfx', text: 'BOOM' }, index: 3 });
    expect(lineIn(doc, lineOp.id)).toBeUndefined();
    expect(balloonOp.op).toBe('balloon');
    expect(Object.keys(balloonOp.patch).sort()).toEqual(['w', 'x', 'y']);
    expect(balloonOp.patch.pinned).toBeUndefined();
    const full = dialogueDoc((d) => {
      d.pages[0].panels[2].lines.push(...Array.from({ length: 5 }, (_, i) => line(`l_f${i}`, 'speech', `Filler ${i}`, 'c_bolt')));
    });
    const refused = compileWith(full, { act: 'add', panel: { page: 1, panel: 3 }, kind: 'sfx', text: 'BOOM' }, []);
    expect(refused.ops).toEqual([]);
    expect(refused.note).toBe('Panel 3 on page 1 already has 8 lines, the most a panel holds. Shorten or move one first.');
  });

  it('locks hold: a locked balloon is never moved, re-aimed or restyled, and says so', () => {
    const move = opsOf(doc, { act: 'move', target: {}, place: { frame: 'panel', cell: 'top' } }, 'l_sfx');
    expect(move.ops).toEqual([]);
    expect(move.note).toBe('This balloon is locked. Unlock it to change it.');
    expect(opsOf(doc, { act: 'aim_tail', target: {}, to: 'Bolt' }, 'l_sfx').note).toBe('This balloon is locked. Unlock it to change it.');
    expect(opsOf(doc, { act: 'restyle', target: {}, scope: 'line', style: { italic: true } }, 'l_sfx').note).toBe('1 locked balloon stayed as it is.');
    // Unlock first, and the move goes through.
    const unlock = opsOf(doc, { act: 'unlock', target: {} }, 'l_sfx');
    expect(unlock.ops).toEqual([{ op: 'balloon', pageId: 'pg_1', lineId: 'l_sfx', patch: { locked: false } }]);
    expect(opsOf(applyOps(doc, unlock.ops), { act: 'move', target: {}, place: { frame: 'panel', cell: 'top' } }, 'l_sfx').ops).toHaveLength(1);
  });

  it('in-art comics: balloon moves, tails and styles are refused in plain words; words and kinds apply and say the page is out of date', () => {
    const inArt = dialogueDoc((d) => {
      d.format = { ...d.format, lettering: 'in_art' };
    });
    for (const intent of [
      { act: 'move', target: {}, place: { frame: 'panel', cell: 'top' } },
      { act: 'aim_tail', target: {}, to: 'Mira' },
      { act: 'tail_style', target: {}, tail: 'none' },
      { act: 'restyle', target: {}, scope: 'line', style: { italic: true } }
    ] as DialogueIntent[]) {
      const r = opsOf(inArt, intent, 'l_leo1');
      expect([r.ops, r.note], intent.act).toEqual([[], IN_ART_REFUSAL]);
    }
    const kind = opsOf(inArt, { act: 'set_kind', target: {}, kind: 'whisper' }, 'l_leo1');
    expect(kind.ops).toHaveLength(1);
    expect(kind.note).toBe('Made “Wait for me” a whisper. Page 1 is lettered in the art, so it is now out of date (redrawing is paid and quoted first).');
  });

  it('never re-assigns a speaker when moving a line: a speaker not drawn there asks; an off-panel voice moves it', () => {
    const ask = opsOf(doc, { act: 'move_to_panel', target: {}, panel: 3 }, 'l_leo1');
    expect(ask.ops).toEqual([]);
    expect(ask.ask?.question).toBe("Leo isn't drawn in panel 3. Move the line there as an off-panel voice, add Leo to the panel, or give the line to someone drawn there?");
    // Plan B4's three options: an off-panel voice, add the speaker to the panel, change the speaker.
    expect(ask.followUps.map((f) => f.say)).toEqual([
      'Move “Wait for me” to panel 3 as an off-panel voice',
      'Add Leo to panel 3 on page 1, then move “Wait for me” there',
      'Move “Wait for me” to panel 3 and give it to Bolt'
    ]);
    const ok = compileWith(doc, { act: 'move_to_panel', target: {}, panel: 3 }, hits(doc, 'l_leo1'), { offPanelOk: true });
    expect(ok.ops[0]).toEqual({ op: 'line_move', pageId: 'pg_1', id: 'l_leo1', toPanelId: 'pn_3' });
    // Its stored balloon is placed fresh in the new panel.
    expect(ok.ops[1]).toMatchObject({ op: 'balloons', pageId: 'pg_1' });
    expect((ok.ops[1] as Extract<DocOp, { op: 'balloons' }>).balloons.map((b) => b.lineId)).not.toContain('l_leo1');
    const after = applyOps(doc, ok.ops);
    expect(lineIn(after, 'l_leo1')?.speakerId).toBe('c_leo');
    expect(after.pages[0].panels[2].lines.map((l) => l.id)).toEqual(['l_bolt1', 'l_mira3', 'l_sfx', 'l_leo1']);
    // Bolt is drawn in panel 3, so the caption-free robot line moves without a question.
    expect(opsOf(doc, { act: 'move_to_panel', target: {}, panel: 2 }, 'l_sfx').ops[0]).toEqual({ op: 'line_move', pageId: 'pg_1', id: 'l_sfx', toPanelId: 'pn_2' });
    // Another page is refused.
    expect(opsOf(doc, { act: 'move_to_panel', target: {}, panel: 1, page: 2 }, 'l_leo1').note).toBe('“Wait for me” is on page 1; a line moves between panels of one page only.');
  });

  it('swap: exactly two lines; across panels both move and their balloons are placed fresh', () => {
    const r = opsOf(doc, { act: 'swap', a: {}, b: {} }, 'l_leo1', 'l_bolt1');
    expect(r.ops.slice(0, 2)).toEqual([
      { op: 'line_move', pageId: 'pg_1', id: 'l_leo1', toPanelId: 'pn_3', index: 0 },
      { op: 'line_move', pageId: 'pg_1', id: 'l_bolt1', toPanelId: 'pn_2', index: 1 }
    ]);
    const after = applyOps(doc, r.ops);
    expect(after.pages[0].panels[1].lines.map((l) => l.id)).toEqual(['l_mira1', 'l_bolt1', 'l_mira2']);
    expect(after.pages[0].panels[2].lines.map((l) => l.id)).toEqual(['l_leo1', 'l_mira3', 'l_sfx']);
    expect(r.note).toMatch(/Leo isn't drawn in panel 3, so that line reads as an off-panel voice there\./);
    expect(opsOf(doc, { act: 'swap', a: {}, b: {} }, 'l_leo1').note).toBe('Swapping needs exactly two lines; that matched 1 line. Select the two balloons, or name them.');
  });

  it('set_speaker: an ambiguous name asks; a stored tail follows the new speaker', () => {
    const ask = opsOf(doc, { act: 'set_speaker', target: {}, speaker: 'Patel' }, 'l_leo1');
    expect(ask.ask?.question).toBe('“Patel” could be Mira Patel and Asha Patel. Which one?');
    expect(ask.followUps.map((f) => f.say)).toEqual(['Give “Wait for me” to Mira Patel', 'Give “Wait for me” to Asha Patel']);
    const r = opsOf(doc, { act: 'set_speaker', target: {}, speaker: 'Leo' }, 'l_mira1');
    expect(r.ops).toEqual([
      { op: 'line', pageId: 'pg_1', panelId: 'pn_2', id: 'l_mira1', patch: { speakerId: 'c_leo' } },
      { op: 'balloon', pageId: 'pg_1', lineId: 'l_mira1', patch: { tailX: 0.38, tailY: 0.76 } }
    ]);
  });

  it('restyle: "bigger" is relative to each line; kind and speaker scopes are one doc-level op', () => {
    const styled = dialogueDoc((d) => {
      d.pages[0].panels[1].lines[1].style = { sizeScale: 1.5 };
    });
    const bigger = { act: 'restyle', target: {}, scope: 'line', style: {}, scaleBy: 1.2 } as DialogueIntent;
    expect(opsOf(styled, bigger, 'l_leo1', 'l_mira1').ops).toEqual([
      { op: 'line_style', pageId: 'pg_1', lineIds: ['l_leo1'], patch: { sizeScale: 1.8 } },
      { op: 'line_style', pageId: 'pg_1', lineIds: ['l_mira1'], patch: { sizeScale: 1.2 } }
    ]);
    expect(compileWith(doc, { act: 'restyle', target: { kind: 'shout' }, scope: 'kind', style: { textColor: '#e63946' } }, []).ops).toEqual([
      { op: 'letter_style', patch: { kinds: { shout: { textColor: '#e63946' } } } }
    ]);
    expect(compileWith(doc, { act: 'restyle', target: { speaker: 'Leo' }, scope: 'speaker', style: { italic: true } }, []).ops).toEqual([
      { op: 'letter_style', patch: { speakers: { c_leo: { italic: true } } } }
    ]);
  });

  it('emphasis on one word is answered honestly with the whole-balloon chip', () => {
    const r = opsOf(doc, { act: 'emphasis', target: {}, words: ['never'], style: 'bold' }, 'l_leo1');
    expect(r.ops).toEqual([]);
    // Plan B4's exact copy.
    expect(r.note).toBe("I can bold the whole balloon now; single-word bold isn't available yet.");
    expect(r.followUps).toEqual([{ label: 'Bold the balloon', say: 'Make “Wait for me” bold' }]);
    const it = opsOf(doc, { act: 'emphasis', target: {}, words: ['never'], style: 'italic' }, 'l_leo1');
    expect(it.note).toBe("I can italicize the whole balloon now; single-word italics aren't available yet.");
    expect(it.followUps).toEqual([{ label: 'Italicize the balloon', say: 'Make “Wait for me” italic' }]);
  });

  it('"make \'Run!\' bold" when the balloon says just that word styles the whole balloon', () => {
    const run = dialogueDoc((d) => {
      d.pages[0].panels[2].lines[1].text = 'Run!';
    });
    const r = opsOf(run, { act: 'emphasis', target: {}, words: ['Run!'], style: 'bold' }, 'l_mira3');
    expect(r.ops).toEqual([{ op: 'line_style', pageId: 'pg_1', lineIds: ['l_mira3'], patch: { weight: 700 } }]);
  });

  it('several balloons sent to one spot of the page stack instead of covering each other', () => {
    const r = opsOf(doc, { act: 'move', target: {}, place: { frame: 'page', cell: 'top' } }, 'l_leo1', 'l_bolt1');
    expect(r.ops).toHaveLength(2);
    const after = applyOps(doc, r.ops);
    const [a, b] = ['l_leo1', 'l_bolt1'].map((id) => after.pages[0].balloons.find((x) => x.lineId === id)!);
    expect(b.y).toBeGreaterThan(a.y + 0.02);
  });

  it('the follow-up chips are sentences the grammar understands (the fast path can answer them)', () => {
    const chips = [
      ...opsOf(doc, { act: 'set_kind', target: {}, kind: 'thought' }, 'l_cap').followUps,
      ...opsOf(doc, { act: 'set_kind', target: {}, kind: 'whisper' }, 'l_leo1').followUps,
      ...opsOf(doc, { act: 'move', target: {}, place: { frame: 'panel', cell: 'top' } }, 'l_leo1').followUps,
      ...opsOf(doc, { act: 'move_to_panel', target: {}, panel: 3 }, 'l_leo1').followUps.slice(0, 1),
      ...opsOf(doc, { act: 'set_speaker', target: {}, speaker: 'Patel' }, 'l_leo1').followUps,
      ...opsOf(doc, { act: 'emphasis', target: {}, words: ['never'], style: 'bold' }, 'l_leo1').followUps
    ].filter((c) => !/another font/.test(c.label));
    expect(chips.length).toBeGreaterThan(8);
    for (const chip of chips) {
      const g = parseDialogue(chip.say!);
      expect([chip.say, g.confident], chip.say).toEqual([chip.say, true]);
      expect(compileDialogue(doc, g.intents, { pageId: 'pg_1' }).status, chip.say).toBe('apply');
    }
  });

  it('link chains in reading order within one panel; unlink clears both ends; across panels is refused', () => {
    const linked = opsOf(doc, { act: 'link', target: {} }, 'l_leo1', 'l_mira1');
    expect(linked.ops).toEqual([{ op: 'balloon', pageId: 'pg_1', lineId: 'l_leo1', patch: { linkTo: 'l_mira1' } }]);
    const after = applyOps(doc, linked.ops);
    const unlinked = opsOf(after, { act: 'unlink', target: {} }, 'l_mira1');
    expect(unlinked.ops).toHaveLength(1);
    expect((unlinked.ops[0] as Extract<DocOp, { op: 'balloons' }>).balloons.some((b) => b.linkTo)).toBe(false);
    expect(opsOf(doc, { act: 'link', target: {} }, 'l_leo1', 'l_bolt1').note).toBe('Linked balloons must be in the same panel; these are in panels 2 and 3.');
  });
});

describe('compileDialogue', () => {
  it('is all or nothing: a later question leaves the earlier parts unapplied', () => {
    const run = compileDialogue(doc, [
      { act: 'set_kind', target: { selected: true }, kind: 'whisper' },
      { act: 'move', target: { speaker: 'Mira' }, place: { frame: 'panel', cell: 'top' } }
    ], { lineIds: ['l_leo1'], pageId: 'pg_1', panelN: 2 });
    expect(run.status).toBe('ask');
    expect(run.ops).toEqual([]);
    expect(run.ask?.question).toBe('Which line?');
    expect(run.ask?.options?.map((o) => o.id)).toEqual(['l_mira1', 'l_mira2']);
  });

  it('merges consecutive patches of one line into one op', () => {
    expect(
      mergeLineOps([
        { op: 'line', pageId: 'p', panelId: 'q', id: 'l', patch: { kind: 'shout' } },
        { op: 'line', pageId: 'p', panelId: 'q', id: 'l', patch: { text: 'Run!' } },
        { op: 'line', pageId: 'p', panelId: 'q', id: 'm', patch: { text: 'Hi' } }
      ])
    ).toEqual([
      { op: 'line', pageId: 'p', panelId: 'q', id: 'l', patch: { kind: 'shout', text: 'Run!' } },
      { op: 'line', pageId: 'p', panelId: 'q', id: 'm', patch: { text: 'Hi' } }
    ]);
  });

  it('every applied edit is undoable through the inverse-op undo', () => {
    const cases: [DialogueIntent[], string[]][] = [
      [[{ act: 'set_kind', target: { selected: true }, kind: 'shout' }], ['l_mira1']],
      [[{ act: 'edit_text', target: { selected: true }, text: 'Go!' }], ['l_mira1']],
      [[{ act: 'delete', target: { selected: true } }], ['l_leo1']],
      [[{ act: 'move', target: { selected: true }, place: { frame: 'page', cell: 'bottom-right' } }], ['l_mira2']],
      [[{ act: 'aim_tail', target: { selected: true }, to: 'Leo' }], ['l_mira1']],
      [[{ act: 'tail_style', target: { selected: true }, tail: 'lightning' }], ['l_leo1']],
      [[{ act: 'reorder', target: { selected: true }, to: 'first' }], ['l_mira2']],
      [[{ act: 'lock', target: { selected: true } }], ['l_mira3']],
      [[{ act: 'z', target: { selected: true }, dir: 'back' }], ['l_mira2']],
      [[{ act: 'restyle', target: { selected: true }, scope: 'line', style: { shape: 'cloud' } }], ['l_leo1']],
      [[{ act: 'add', panel: { page: 2, panel: 2 }, kind: 'caption', text: 'Later.' }], []]
    ];
    for (const [intents, sel] of cases) {
      const run = compileDialogue(doc, intents, { lineIds: sel, pageId: 'pg_1' });
      expect(run.status, intents[0].act).toBe('apply');
      // Never silent: every applied act says what it did.
      expect(run.note?.trim(), `${intents[0].act} reply`).toBeTruthy();
      const undo = inverseOps(doc, run.ops);
      const back = applyOps(applyOps(doc, run.ops), undo);
      expect(back.pages, intents[0].act).toEqual(doc.pages);
    }
  });

  it('nothing matched stops with the inventory; an empty intent list says so', () => {
    expect(compileDialogue(doc, [{ act: 'delete', target: { kind: 'shout' } }], { pageId: 'pg_2' })).toMatchObject({ status: 'none', ops: [] });
    expect(compileDialogue(doc, [])).toMatchObject({ status: 'none', note: "I didn't find a dialogue edit in that." });
  });

  it('a new line added with apply() is resolvable right after (ids stay unique)', () => {
    const run = compileDialogue(doc, [{ act: 'add', panel: { page: 1, panel: 1 }, kind: 'caption', text: 'Later that night.' }]);
    const next = apply(doc, run.ops);
    const again = compileDialogue(next, [{ act: 'add', panel: { page: 1, panel: 1 }, kind: 'caption', text: 'Even later.' }]);
    const ids = [run.ops[0], again.ops[0]].map((op) => (op as Extract<DocOp, { op: 'line' }>).id);
    expect(new Set(ids).size).toBe(2);
  });
});

describe('dialogueFastPath (COMIC_DIALOGUE_FAST)', () => {
  it('answers only a confident sentence whose every intent is one line, applied whole, with free ops', () => {
    const run = dialogueFastPath(doc, 'make it a whisper', { lineIds: ['l_leo1'] });
    expect(run?.ops).toEqual([{ op: 'line', pageId: 'pg_1', panelId: 'pn_2', id: 'l_leo1', patch: { kind: 'whisper' } }]);
    expect(run?.label).toBe('Make it a whisper');
    expect(dialogueFastPath(doc, "make Leo's line a whisper", { pageId: 'pg_2' })?.ops).toEqual([
      { op: 'line', pageId: 'pg_2', panelId: 'pn_5', id: 'l_p2leo', patch: { kind: 'whisper' } }
    ]);
    expect(dialogueFastPath(doc, 'add BOOM in panel 3', { pageId: 'pg_1' })?.ops).toHaveLength(2);
    for (const op of dialogueFastPath(doc, "um so move Mira's line up top and like make it a whisper", { pageId: 'pg_1', panelN: 3 })!.ops) expect(FREE_DIALOGUE_OPS.has(op.op)).toBe(true);
  });

  it('leaves everything else to the director: questions, plurals, refusals and sentences it only half understood', () => {
    expect(dialogueFastPath(doc, 'make it a whisper', { pageId: 'pg_1', panelN: 2 })).toBeUndefined(); // which line?
    expect(dialogueFastPath(doc, 'the second panel needs a shout', { pageId: 'pg_1' })).toBeUndefined();
    expect(dialogueFastPath(doc, 'make all the shouts red')).toBeUndefined();
    expect(dialogueFastPath(doc, 'make it a whisper and draw a cat', { lineIds: ['l_leo1'] })).toBeUndefined();
    expect(dialogueFastPath(doc, 'make it bigger', { pageId: 'pg_1', panelN: 1 })).toBeUndefined();
    expect(dialogueFastPath(doc, "put it above Leo's head", { lineIds: ['l_bolt1'] })).toBeUndefined();
    expect(dialogueFastPath(doc, 'draw page 2')).toBeUndefined();
  });
});

/** Every chip of a question, re-said: it parses, and never asks the very same question again (no chip loops). */
const noLoop = (d: ComicDoc, question: string | undefined, say: string, ctx = { pageId: 'pg_1' }) => {
  const g = parseDialogue(say);
  expect(g.intents.length, say).toBeGreaterThan(0);
  const run = compileDialogue(d, g.intents, ctx);
  expect(run.ask?.question ?? '', say).not.toBe(question);
  return run;
};

describe('review fixes: confirm, reply text, unknown fonts, B4 asks', () => {
  const big = dialogueDoc((d) => {
    for (const n of [3, 4]) d.pages.push({ ...d.pages[1], id: `pg_${n}`, n, panels: [panel(`pn_${n}`, 1, ['c_leo'], [line(`l_w${n}`, 'whisper', `Psst ${n}`, 'c_leo')])], balloons: [] });
    d.pages[1].panels[0].lines.push(line('l_w2', 'whisper', 'Psst 2', 'c_mira'));
  });

  it('a big plural edit asks once; the confirmed re-run applies every match and undoes exactly', () => {
    const g = parseDialogue('make all the whispers shouts');
    const asked = compileDialogue(big, g.intents);
    expect(asked.status).toBe('ask');
    expect(asked.ask?.question).toBe("That changes 4 lines on 4 pages. Go ahead? It's free and undoable.");
    expect(asked.followUps).toEqual([{ label: 'Yes, all 4', say: 'Yes, change all 4 of them.' }]);
    // The answer: the same instruction with the confirmation (B-TOOL maps the chip to it).
    for (const intents of [g.intents, ['intent' in intentFromArgs({ action: 'set_kind', target: { kind: 'whisper', all: true }, kind: 'shout' }) ? (intentFromArgs({ action: 'set_kind', target: { kind: 'whisper', all: true }, kind: 'shout' }) as { intent: DialogueIntent }).intent : g.intents[0]]]) {
      const yes = compileDialogue(big, intents, { confirmed: true });
      expect(yes.status).toBe('apply');
      expect(yes.ops.map((op) => (op as Extract<DocOp, { op: 'line' }>).id)).toEqual(['l_mira2', 'l_w2', 'l_w3', 'l_w4']);
      expect(yes.note).toBe('Made 4 lines shouts.');
      expect(applyOps(applyOps(big, yes.ops), inverseOps(big, yes.ops)).pages).toEqual(big.pages);
    }
    // Explicit ids confirm too.
    const byIds = [{ act: 'set_kind', target: { lineIds: ['l_mira2', 'l_w2', 'l_w3', 'l_w4'] }, kind: 'shout' }] as DialogueIntent[];
    expect(compileDialogue(big, byIds).status).toBe('ask');
    expect(compileDialogue(big, byIds, { confirmed: true }).status).toBe('apply');
  });

  it('never silent: each step of a longer instruction is in the reply, and stale ids are named', () => {
    const run = compileDialogue(doc, parseDialogue("change the text to 'Hi' and make it red", { selected: true }).intents, { lineIds: ['l_leo1'] });
    expect(run.status).toBe('apply');
    expect(run.note).toBe('Changed “Wait for me” to “Hi”. Restyled “Wait for me” (red text).');
    expect(run.steps.map((s) => s.note)).toEqual(['Changed “Wait for me” to “Hi”.', 'Restyled “Wait for me” (red text).']);
    const stale = compileDialogue(doc, [{ act: 'set_kind', target: { lineIds: ['l_leo1', 'gone1'] }, kind: 'whisper' }]);
    expect(stale.note).toBe("Made “Wait for me” a whisper. 1 of those lines isn't in the comic any more, so it was left out.");
    for (const [intent, said] of [
      [{ act: 'tail_style', target: {}, tail: 'none' }, 'Removed the tail of “Wait for me”.'],
      [{ act: 'z', target: {}, dir: 'front' }, 'Brought “Wait for me” to the front.'],
      [{ act: 'set_speaker', target: {}, speaker: 'Mira' }, 'Gave “Wait for me” to Mira Patel.'],
      [{ act: 'edit_text', target: {}, text: 'Hi' }, 'Changed “Wait for me” to “Hi”.']
    ] as [DialogueIntent, string][]) {
      expect(opsOf(doc, intent, 'l_leo1').note, intent.act).toBe(said);
    }
  });

  it('a refusal stops the whole instruction (all or nothing); "already so" parts are skipped and said', () => {
    const refused = compileDialogue(doc, parseDialogue('make it a whisper and give it to Zed', { selected: true }).intents, { lineIds: ['l_leo1'] });
    expect(refused).toMatchObject({ status: 'none', ops: [] });
    expect(refused.note).toBe("There's no character called “zed”. The cast is Mira Patel, Leo, Bolt and Asha Patel. Nothing was changed.");
    const half = compileDialogue(doc, parseDialogue('make it a whisper and make it red', { selected: true }).intents, { lineIds: ['l_mira2'] });
    expect(half.status).toBe('apply');
    expect(half.note).toBe("It's already a whisper. Restyled “Quietly now” (red text).");
  });

  it('an unknown font asks with the 3 nearest; each chip applies that font with the rest of the request', () => {
    const m = intentFromArgs({ action: 'restyle', scope: 'speaker', target: { speaker: 'Leo' }, style: { font: 'Comic Sans', bold: true } });
    const run = compileDialogue(doc, ['intent' in m ? m.intent : (undefined as never)]);
    expect(run.status).toBe('ask');
    expect(run.ops).toEqual([]);
    expect(run.ask?.question).toBe("I don't have a font called “Comic Sans”. Use Comic Neue, Noto Sans or Patrick Hand for Leo's lines instead? Nothing changed yet: the bold comes with the font you pick.");
    expect(run.followUps.map((f) => f.label)).toEqual(['Use Comic Neue', 'Use Noto Sans', 'Use Patrick Hand']);
    for (const [chip, font] of run.followUps.map((f, i) => [f, ['comic-neue', 'noto-sans', 'patrick-hand'][i]] as const)) {
      const g = parseDialogue(chip.say!);
      expect(g.confident, chip.say).toBe(true);
      const picked = compileDialogue(doc, g.intents);
      expect(picked.status, chip.say).toBe('apply');
      expect(picked.ops, chip.say).toEqual([{ op: 'letter_style', patch: { speakers: { c_leo: { font, weight: 700 } } } }]);
    }
  });

  it('B4 asks: a character not in the panel, "between" with too few or too many people, and a tail at someone absent', () => {
    const above = compileDialogue(doc, parseDialogue("put it above Leo's head", { selected: true }).intents, { lineIds: ['l_bolt1'] });
    expect(above.status).toBe('ask');
    expect(above.followUps.map((f) => f.label)).toEqual(['Move it to panel 2', 'Above Bolt', 'Above Mira Patel', 'Top of the panel']);
    for (const f of above.followUps) noLoop(doc, above.ask?.question, f.say!);
    expect(noLoop(doc, above.ask?.question, above.followUps[1].say!).status).toBe('apply');

    const crowd = dialogueDoc((d) => d.pages[0].panels[1].castIds.push('c_asha'));
    const which = compileDialogue(crowd, parseDialogue('put it between them', { selected: true }).intents, { lineIds: ['l_leo1'] });
    expect(which.ask?.question).toBe('Panel 2 has 3 characters (Mira Patel, Leo and Asha Patel), so “between them” could mean any two. Which two?');
    expect(which.followUps.map((f) => f.say)).toEqual([
      'Put “Wait for me” between Mira Patel and Leo',
      'Put “Wait for me” between Mira Patel and Asha Patel',
      'Put “Wait for me” between Leo and Asha Patel'
    ]);
    // A pair chip keeps "between" (never "next to") and applies.
    const pair = parseDialogue(which.followUps[0].say!).intents;
    expect(pair[0]).toMatchObject({ act: 'move', place: { relation: 'between', near: 'mira patel', and: 'leo' } });
    expect(compileDialogue(crowd, pair).status).toBe('apply');

    const nobody = compileDialogue(doc, parseDialogue('put it between them', { selected: true }).intents, { lineIds: ['l_cap'] });
    expect(nobody.status).toBe('ask');
    expect(nobody.followUps.map((f) => f.label)).toEqual(['Top of the panel']);
    expect(noLoop(doc, nobody.ask?.question, nobody.followUps[0].say!).status).toBe('apply');

    const tail = compileDialogue(doc, parseDialogue('the tail should point at the robot', { selected: true }).intents, { lineIds: ['l_leo1'] });
    expect(tail.status).toBe('ask');
    expect(tail.followUps.map((f) => f.label)).toEqual(['Point at Mira Patel', 'Point at Leo', 'Move it to panel 3', 'Off-panel voice']);
    for (const f of tail.followUps) noLoop(doc, tail.ask?.question, f.say!);
    expect(noLoop(doc, tail.ask?.question, tail.followUps[0].say!).status).toBe('apply');
    expect(noLoop(doc, tail.ask?.question, tail.followUps[3].say!).status).toBe('apply');
  });

  it('move_to_panel offers the plan\'s third option, and "give it to" someone drawn there moves it without asking', () => {
    const ask = opsOf(doc, { act: 'move_to_panel', target: {}, panel: 3 }, 'l_leo1');
    const give = noLoop(doc, ask.ask?.question, ask.followUps[2].say!);
    expect(give.status).toBe('apply');
    expect(give.note).toBe('Moved “Wait for me” to panel 3. Its balloon is placed fresh in panel 3. Gave “Wait for me” to Bolt.');
    expect(noLoop(doc, ask.ask?.question, ask.followUps[0].say!).status).toBe('apply');
  });

  it('caption across the top squares a scroll caption into a rectangle bar, measured as drawn, and undoes exactly', () => {
    const scroll = dialogueDoc((d) => {
      d.letterStyle = { ...(d.letterStyle ?? { presetId: 'classic' }), presetId: 'storybook' };
    });
    const run = compileDialogue(scroll, parseDialogue('caption across the top').intents, { pageId: 'pg_1' });
    expect(run.status).toBe('apply');
    expect(run.ops[0]).toEqual({ op: 'line_style', pageId: 'pg_1', lineIds: ['l_cap'], patch: { shape: 'rect' } });
    expect(run.ops[1]).toMatchObject({ op: 'balloon', lineId: 'l_cap', patch: { pinned: true, w: expect.any(Number) } });
    expect(applyOps(applyOps(scroll, run.ops), inverseOps(scroll, run.ops)).pages).toEqual(scroll.pages);
    // Already a rectangle (classic): no style op.
    expect(compileDialogue(doc, parseDialogue('caption across the top').intents, { pageId: 'pg_1' }).ops.map((op) => op.op)).toEqual(['balloon']);
  });

  it('add questions: "needs a" offers lines, "New shout…" and cast; an explicit add asks only for the words; chips never loop', () => {
    const needs = compileDialogue(doc, parseDialogue('the second panel needs a shout').intents, { pageId: 'pg_1' });
    expect(needs.followUps.map((f) => f.label)).toEqual(['Make “We have to go” a shout', 'Make “Wait for me” a shout', 'Make “Quietly now” a shout', 'New shout…', 'New shout by Mira Patel', 'New shout by Leo']);
    for (const f of needs.followUps) noLoop(doc, needs.ask?.question, f.say!);
    const custom = noLoop(doc, needs.ask?.question, needs.followUps[3].say!);
    expect(custom.ask?.question).toBe('What should the shout in panel 2 say, and who shouts it? Type the words, or pick who first.');
    const byMira = noLoop(doc, needs.ask?.question, needs.followUps[4].say!);
    expect(byMira.ask?.question).toBe('What should Mira Patel shout? Type the words.');

    const sfx = compileDialogue(doc, parseDialogue('the first panel needs a sound effect').intents, { pageId: 'pg_1' });
    expect(sfx.followUps.map((f) => f.label)).toEqual(['Make “The lab, midnight.” a sound effect', 'New sound effect…']);
    const words = noLoop(doc, sfx.ask?.question, sfx.followUps[1].say!);
    expect(words.ask?.question).toBe('What should the sound effect in panel 1 say? Type the words.');
    expect(words.followUps).toEqual([]);
  });

  it('reorder at a 0-based position puts the line there (index 1 = second), not last', () => {
    const m = intentFromArgs({ action: 'reorder', target: { line_ids: ['l_mira2'] }, index: 1 });
    const run = compileDialogue(doc, ['intent' in m ? m.intent : (undefined as never)]);
    expect(run.status).toBe('apply');
    const after = applyOps(doc, run.ops);
    expect(after.pages[0].panels[1].lines.map((l) => l.id)).toEqual(['l_mira1', 'l_mira2', 'l_leo1']);
    expect(run.note).toBe('“Quietly now” now comes second in panel 2.');
    expect(applyOps(after, inverseOps(doc, run.ops)).pages).toEqual(doc.pages);
  });

  it('the fast path never takes a kind-, speaker- or comic-wide restyle, even with exactly one balloon selected', () => {
    for (const say of ['make every bubble cloud', 'make all bubbles see-through', 'make all the shouts red', 'same style as this one for every caption']) {
      expect(dialogueFastPath(doc, say, { lineIds: ['l_leo1'] }), say).toBeUndefined();
    }
    expect(dialogueFastPath(doc, 'make it a cloud bubble', { lineIds: ['l_leo1'] })?.ops).toEqual([{ op: 'line_style', pageId: 'pg_1', lineIds: ['l_leo1'], patch: { shape: 'cloud' } }]);
  });
});

