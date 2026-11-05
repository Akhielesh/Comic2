// Conflict keys (agent-editor plan §3 A3.1, A3 CONFLICT): which doc entity an op changes, fine enough that two
// different balloons on one page never collide.

import { describe, expect, it } from 'vitest';
import { collidingKeys, entityKeys, keysCollide, lineIdOfKey } from './conflicts';
import type { DocOp } from './ops';

const text = (id: string, t: string): DocOp => ({ op: 'line', pageId: 'pg_1', panelId: 'pn_1', id, patch: { text: t } });
const move = (lineId: string, x: number): DocOp => ({ op: 'balloon', pageId: 'pg_1', lineId, patch: { x, y: 0.2, pinned: true } });

describe('entityKeys', () => {
  it('line: words, kind and speaker are the line; its style is lstyle; a delete takes the balloon and the style too', () => {
    expect(entityKeys(text('ln_a', 'Run!'))).toEqual(['line:ln_a']);
    expect(entityKeys({ op: 'line', pageId: 'pg_1', panelId: 'pn_1', id: 'ln_a', patch: { kind: 'whisper', speakerId: 'c_mira' } })).toEqual(['line:ln_a']);
    expect(entityKeys({ op: 'line', pageId: 'pg_1', panelId: 'pn_1', id: 'ln_a', patch: { style: { color: '#ff0000' } } })).toEqual(['lstyle:ln_a']);
    expect(entityKeys({ op: 'line', pageId: 'pg_1', panelId: 'pn_1', id: 'ln_a', patch: { text: 'Hi', styleId: 'st_1' } })).toEqual(['line:ln_a', 'lstyle:ln_a']);
    expect(entityKeys({ op: 'line', pageId: 'pg_1', panelId: 'pn_1', id: 'ln_a', patch: null })).toEqual(['line:ln_a', 'balloon:ln_a', 'lstyle:ln_a']);
  });

  it('a new line placed at an index also changes its panel order', () => {
    expect(entityKeys({ op: 'line', pageId: 'pg_1', panelId: 'pn_1', id: 'ln_new', patch: { kind: 'speech', text: 'Hey' }, index: 0 })).toEqual(['line:ln_new', 'order:pn_1']);
  });

  it('balloon, balloons and line_style name each line they touch', () => {
    expect(entityKeys(move('ln_a', 0.1))).toEqual(['balloon:ln_a']);
    expect(entityKeys({ op: 'balloons', pageId: 'pg_1', balloons: [{ lineId: 'ln_a', x: 0, y: 0, w: 0.2 }, { lineId: 'ln_b', x: 0.5, y: 0, w: 0.2 }] })).toEqual(['balloon:ln_a', 'balloon:ln_b']);
    expect(entityKeys({ op: 'line_style', pageId: 'pg_1', lineIds: ['ln_a', 'ln_b', 'ln_a'], patch: { weight: 400 } })).toEqual(['lstyle:ln_a', 'lstyle:ln_b']);
  });

  it('line_move: the line (which panel it sits in) and the order of the panel it goes to', () => {
    expect(entityKeys({ op: 'line_move', pageId: 'pg_1', id: 'ln_a', toPanelId: 'pn_2', index: 0 })).toEqual(['line:ln_a', 'order:pn_2']);
  });

  it('letter_style: the scopes it touches; a preset switch without keepOverrides and a reset are wildcards', () => {
    expect(entityKeys({ op: 'letter_style', patch: { kinds: { shout: { color: '#c00' } }, speakers: { c_mira: { italic: true } } } })).toEqual([
      'letter:kind:shout',
      'letter:speaker:c_mira'
    ]);
    expect(entityKeys({ op: 'letter_style', patch: { base: { sizeScale: 1.1 } } })).toEqual(['letter:base']);
    expect(entityKeys({ op: 'letter_style', patch: { presetId: 'manga' } })).toEqual(['letter:preset', 'letter:base', 'letter:kind:*']);
    expect(entityKeys({ op: 'letter_style', patch: { presetId: 'manga', keepOverrides: true } })).toEqual(['letter:preset']);
    expect(entityKeys({ op: 'letter_style', patch: null })).toEqual(['letter:*']);
  });

  it('panel snapshots carry every line inside them; untracked ops change no tracked entity', () => {
    const panel = { id: 'pn_9', n: 1, size: 'medium' as const, shot: 'wide' as const, action: '', castIds: [], lines: [{ id: 'ln_z', kind: 'speech' as const, text: 'Yo' }] };
    expect(entityKeys({ op: 'panel_add', pageId: 'pg_1', panel })).toEqual(['panel:pn_9', 'order:pn_9', 'line:ln_z', 'lstyle:ln_z']);
    expect(entityKeys({ op: 'page_panels', id: 'pg_1', panels: [panel] })).toEqual(['panel:pn_9', 'order:pn_9', 'line:ln_z', 'lstyle:ln_z']);
    expect(entityKeys({ op: 'panel', pageId: 'pg_1', id: 'pn_9', patch: { action: 'Rain' } })).toEqual(['panel:pn_9']);
    expect(entityKeys({ op: 'brief', patch: { title: 'X' } })).toEqual([]);
    expect(entityKeys({ op: 'message', msg: { id: 'm', role: 'user', text: 'hi', at: 1 } })).toEqual([]);
    expect(entityKeys({ op: 'some_future_op' } as unknown as DocOp)).toEqual([]);
  });
});

describe('collidingKeys', () => {
  it('two different balloons on one page never collide; the same balloon does', () => {
    expect(collidingKeys([move('ln_a', 0.1)], [move('ln_b', 0.4)])).toEqual([]);
    expect(collidingKeys([move('ln_a', 0.1)], [move('ln_a', 0.4)])).toEqual(['balloon:ln_a']);
  });

  it("the creator's text edit and the director's balloon move of the same line are different entities", () => {
    expect(collidingKeys([text('ln_a', 'Mine')], [move('ln_a', 0.3)])).toEqual([]);
    expect(collidingKeys([text('ln_a', 'Mine')], [text('ln_a', 'Theirs')])).toEqual(['line:ln_a']);
  });

  it('a line delete collides with a balloon move or a restyle of that line', () => {
    const del: DocOp = { op: 'line', pageId: 'pg_1', panelId: 'pn_1', id: 'ln_a', patch: null };
    expect(collidingKeys([del], [move('ln_a', 0.2)])).toEqual(['balloon:ln_a']);
    expect(collidingKeys([{ op: 'line_style', pageId: 'pg_1', lineIds: ['ln_a'], patch: { weight: 400 } }], [del])).toEqual(['lstyle:ln_a']);
  });

  it('a lettering reset covers every scope; a preset switch covers the kind overrides but not a speaker', () => {
    const shout: DocOp = { op: 'letter_style', patch: { kinds: { shout: { color: '#c00' } } } };
    const mira: DocOp = { op: 'letter_style', patch: { speakers: { c_mira: { italic: true } } } };
    expect(collidingKeys([{ op: 'letter_style', patch: null }], [shout])).toEqual(['letter:*']);
    expect(collidingKeys([shout], [{ op: 'letter_style', patch: null }])).toEqual(['letter:kind:shout']);
    expect(collidingKeys([{ op: 'letter_style', patch: { presetId: 'manga' } }], [shout])).toEqual(['letter:kind:*']);
    expect(collidingKeys([{ op: 'letter_style', patch: { presetId: 'manga' } }], [mira])).toEqual([]);
  });

  it('keysCollide and lineIdOfKey', () => {
    expect(keysCollide('letter:kind:*', 'letter:kind:whisper')).toBe(true);
    expect(keysCollide('letter:kind:*', 'letter:speaker:c_1')).toBe(false);
    expect(keysCollide('balloon:a', 'line:a')).toBe(false);
    expect(lineIdOfKey('balloon:ln_a')).toBe('ln_a');
    expect(lineIdOfKey('order:pn_1')).toBeUndefined();
  });
});
