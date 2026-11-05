// B-RESOLVE compile.ts (agent-editor plan §3 B2, B4): free ops for each act, and the rules the compiler never bends —
// never invent a speaker, never re-assign one when moving a line, locks hold, never silent, every edit undoable.
import { describe, expect, it } from 'vitest';
import type { ComicDoc } from '../doc';
import { applyOps, type DocOp } from '../ops';
import { inverseOps } from '../undo';
import { IN_ART_REFUSAL, compileDialogue, compileIntent, compileWith, mergeLineOps } from './compile';
import { hitOf } from './resolve';
import type { DialogueIntent, LineHit } from './types';
import { apply, dialogueDoc, line } from './__fixtures__/dialogueDoc';

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
    expect(kind.note).toBe('Page 1 is lettered in the art, so it is now out of date (redrawing is paid and quoted first).');
  });

  it('never re-assigns a speaker when moving a line: a speaker not drawn there asks; an off-panel voice moves it', () => {
    const ask = opsOf(doc, { act: 'move_to_panel', target: {}, panel: 3 }, 'l_leo1');
    expect(ask.ops).toEqual([]);
    expect(ask.ask?.question).toBe("Leo isn't drawn in panel 3. Move the line there as an off-panel voice, or add Leo to the panel?");
    expect(ask.followUps.map((f) => f.say)).toEqual(['Move “Wait for me” to panel 3 as an off-panel voice', 'Add Leo to panel 3 on page 1, then move “Wait for me” there']);
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
    expect(r.note).toBe("I can make the whole balloon bold now; bold on single words like “never” isn't available yet.");
    expect(r.followUps).toEqual([{ label: 'Make the balloon bold', say: 'Make “Wait for me” bold' }]);
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
