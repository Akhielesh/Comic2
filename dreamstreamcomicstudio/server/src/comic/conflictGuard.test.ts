// @vitest-environment node
// The conflict guard (agent-editor plan §3 A3.1, owner decision D3: the creator's edit always wins). The session's
// recent-commit ring is A2's; here it is the session's own `ops` events, so the guard reads exactly what commit() saw.

import { describe, expect, it, vi } from 'vitest';
import { CONFLICT_LIMITS, type ComicDoc } from '../../../shared/comic/doc.js';
import { DEFAULT_CAPS, type StudioCaps } from '../../../shared/comic/capabilities.js';
import type { DocOp } from '../../../shared/comic/ops.js';
import { conflictCardFor, conflictCardText, conflictToolNote, guardUserEdits, recordConflicts, styleWords, type BlockedEdit } from './conflictGuard.js';
import { newSession, plannedDoc, testContext } from './orchestrator.fakes.js';
import type { RecentCommit, StudioSession } from './session.js';
import { createDirectorTurn } from './tools.js';

const ON: StudioCaps = { ...DEFAULT_CAPS, liveAgent: { queue: false, steer: false, conflicts: true } };
const OFF: StudioCaps = { ...DEFAULT_CAPS, liveAgent: { queue: true, steer: false, conflicts: false } };

/** Page 1, panel 2 holds two lines with placed balloons; panel 3 is empty. */
const docWithBalloons = (): ComicDoc => {
  const doc = plannedDoc();
  const p1 = doc.pages[0];
  p1.panels[1].lines = [
    { id: 'ln_a', kind: 'speech', speakerId: 'c_maya', text: 'Line A' },
    { id: 'ln_b', kind: 'speech', speakerId: 'c_maya', text: 'Line B' }
  ];
  p1.balloons = [
    { lineId: 'ln_a', x: 0.1, y: 0.1, w: 0.2 },
    { lineId: 'ln_b', x: 0.6, y: 0.6, w: 0.2 }
  ];
  return doc;
};

/** A2's ring, stood in for by the session's own ops events (rev, origin, ops), filtered by rev like recentCommits. */
const withRing = (session: StudioSession): RecentCommit[] => {
  const ring: RecentCommit[] = [];
  session.subscribe((e) => {
    if (e.type === 'ops') ring.push({ rev: e.rev, ops: e.ops, at: 0, ...(e.origin ? { origin: e.origin } : {}) });
  });
  vi.spyOn(session, 'recentCommits').mockImplementation((since: number) => ring.filter((c) => c.rev > since));
  return ring;
};

const setup = (caps: StudioCaps = ON) => {
  const session = newSession(docWithBalloons());
  withRing(session);
  const ctx = testContext(session, { caps });
  const turn = createDirectorTurn({ startRev: session.doc.rev });
  return { session, ctx, turn };
};

const text = (id: string, t: string): DocOp => ({ op: 'line', pageId: 'pg_1', panelId: 'pn_1_2', id, patch: { text: t } });
const move = (lineId: string, x: number, y = 0.5): DocOp => ({ op: 'balloon', pageId: 'pg_1', lineId, patch: { x, y, pinned: true } });

describe('guardUserEdits', () => {
  it("a user op committed after startRev blocks a director op on the same key and allows the others", () => {
    const { session, ctx, turn } = setup();
    session.commit([text('ln_a', 'We have to go')], { origin: 'user' });
    const planned: DocOp[] = [text('ln_a', 'Run!'), move('ln_b', 0.7), { op: 'brief', patch: { title: 'Y' } }];
    const result = guardUserEdits(ctx, turn, planned);
    expect(result.allowed).toEqual([move('ln_b', 0.7), { op: 'brief', patch: { title: 'Y' } }]);
    expect(result.blocked).toEqual([
      {
        where: { pageId: 'pg_1', panelId: 'pn_1_2', lineId: 'ln_a', label: 'page 1 · panel 2 · line 1' },
        mine: 'We have to go',
        theirs: 'Run!',
        proposed: [text('ln_a', 'Run!')]
      }
    ]);
    expect(conflictToolNote(result.blocked)).toBe(
      'Conflict: you changed page 1 · panel 2 · line 1 ("We have to go") while I was working, so I left it. Do not redo it; the studio will ask.'
    );
  });

  it('two different balloons on one page never conflict; the same balloon does, with both spots in words', () => {
    const { session, ctx, turn } = setup();
    session.commit([move('ln_a', 0.05, 0.05)], { origin: 'user' });
    expect(guardUserEdits(ctx, turn, [move('ln_b', 0.7)]).blocked).toEqual([]);
    const { allowed, blocked } = guardUserEdits(ctx, turn, [move('ln_a', 0.7, 0.8)]);
    expect(allowed).toEqual([]);
    expect(blocked[0].mine).toBe('“Line A”, balloon where you put it, at the top left of the page');
    expect(blocked[0].theirs).toBe('“Line A”, balloon moved to the bottom right of the page');
  });

  it('allows everything when the conflict guard is off, before anything was committed, and for the director’s own commits', () => {
    const off = setup(OFF);
    off.session.commit([text('ln_a', 'Mine')], { origin: 'user' });
    expect(guardUserEdits(off.ctx, off.turn, [text('ln_a', 'Theirs')])).toEqual({ allowed: [text('ln_a', 'Theirs')], blocked: [] });

    const { session, ctx } = setup();
    session.commit([text('ln_a', 'Before the turn')], { origin: 'user' });
    const turn = createDirectorTurn({ startRev: session.doc.rev });
    session.commit([text('ln_a', 'The director, earlier this turn')], { origin: 'director' });
    expect(guardUserEdits(ctx, turn, [text('ln_a', 'Theirs')]).blocked).toEqual([]);
    // A turn that predates startRev is never guarded.
    session.commit([text('ln_a', 'Mine')], { origin: 'user' });
    expect(guardUserEdits(ctx, createDirectorTurn(), [text('ln_a', 'Theirs')]).blocked).toEqual([]);
  });

  it('a restyle of several lines applies to the lines the creator did not restyle', () => {
    const { session, ctx, turn } = setup();
    session.commit([{ op: 'line_style', pageId: 'pg_1', lineIds: ['ln_b'], patch: { textColor: '#aa0000' } }], { origin: 'user' });
    const restyle: DocOp = { op: 'line_style', pageId: 'pg_1', lineIds: ['ln_a', 'ln_b'], patch: { font: 'bangers', sizeScale: 1.2 } };
    const { allowed, blocked } = guardUserEdits(ctx, turn, [restyle]);
    expect(allowed).toEqual([{ ...restyle, lineIds: ['ln_a'] }]);
    expect(blocked).toHaveLength(1);
    expect(blocked[0].proposed).toEqual([{ ...restyle, lineIds: ['ln_b'] }]);
    expect(blocked[0].where.lineId).toBe('ln_b');
    expect(blocked[0].mine).toBe('“Line B”, your look (text colour)');
    expect(blocked[0].theirs).toBe('“Line B”, restyled (font and size)');
  });

  it("a page-wide balloon layout keeps the creator's balloon where they put it and moves the rest", () => {
    const { session, ctx, turn } = setup();
    session.commit([move('ln_a', 0.05, 0.05)], { origin: 'user' });
    const layout: DocOp = { op: 'balloons', pageId: 'pg_1', balloons: [{ lineId: 'ln_a', x: 0.4, y: 0.4, w: 0.3 }, { lineId: 'ln_b', x: 0.5, y: 0.8, w: 0.3 }] };
    const { allowed, blocked } = guardUserEdits(ctx, turn, [layout]);
    const live = session.doc.pages[0].balloons.find((b) => b.lineId === 'ln_a')!;
    expect(allowed).toEqual([{ op: 'balloons', pageId: 'pg_1', balloons: [live, { lineId: 'ln_b', x: 0.5, y: 0.8, w: 0.3 }] }]);
    expect(blocked.map((b) => b.proposed)).toEqual([[{ op: 'balloon', pageId: 'pg_1', lineId: 'ln_a', patch: { x: 0.4, y: 0.4, w: 0.3 } }]]);
  });

  it('a line the creator deleted mid-turn: the director’s edit of it is held, never re-creating the line', () => {
    const { session, ctx, turn } = setup();
    session.commit([{ op: 'line', pageId: 'pg_1', panelId: 'pn_1_2', id: 'ln_a', patch: null }], { origin: 'user' });
    const { allowed, blocked } = guardUserEdits(ctx, turn, [text('ln_a', 'Run!')]);
    expect(allowed).toEqual([]);
    expect(blocked[0]).toMatchObject({ where: { pageId: 'pg_1', lineId: 'ln_a', label: 'page 1 · a line you removed' }, mine: 'You removed this line.' });
  });

  it("a preset switch is held when the creator restyled a kind; a speaker's look is not touched by it", () => {
    const { session, ctx, turn } = setup();
    session.commit([{ op: 'letter_style', patch: { kinds: { shout: { textColor: '#cc0000' } } } }], { origin: 'user' });
    const preset: DocOp = { op: 'letter_style', patch: { presetId: 'manga' } };
    const speaker: DocOp = { op: 'letter_style', patch: { speakers: { c_maya: { italic: true } } } };
    const { allowed, blocked } = guardUserEdits(ctx, turn, [preset, speaker]);
    expect(allowed).toEqual([speaker]);
    expect(blocked).toEqual([{ where: { label: 'the lettering preset' }, mine: 'Your choices for the lettering preset.', theirs: 'Switch to the Manga lettering.', proposed: [preset] }]);
  });
});

describe('recordConflicts and conflictCardFor', () => {
  const blocked = (lineId: string, theirs: string, proposed: DocOp[] = [text(lineId, theirs)]): BlockedEdit => ({
    where: { pageId: 'pg_1', lineId, label: `line ${lineId}` },
    mine: 'Mine',
    theirs,
    proposed
  });

  it('no card while nothing was held back; one card with every held item otherwise', () => {
    const turn = createDirectorTurn();
    expect(conflictCardFor(turn)).toBeNull();
    recordConflicts(turn, []);
    expect(turn.conflicts).toBeUndefined();
    recordConflicts(turn, [blocked('ln_a', 'Run!'), blocked('ln_b', 'Go!')]);
    const card = conflictCardFor(turn)!;
    expect(card.type).toBe('conflict');
    expect(card.items.map((i) => [i.where.lineId, i.theirs])).toEqual([
      ['ln_a', 'Run!'],
      ['ln_b', 'Go!']
    ]);
    expect(card.items.every((i) => /^cf_/.test(i.id))).toBe(true);
  });

  it('the same line held back twice in one turn stays one item: ops in order, the latest version, the first id', () => {
    const turn = createDirectorTurn();
    recordConflicts(turn, [blocked('ln_a', 'Run!')]);
    const id = turn.conflicts![0].id;
    recordConflicts(turn, [blocked('ln_a', 'Run now!', [move('ln_a', 0.3)])]);
    expect(turn.conflicts).toHaveLength(1);
    expect(turn.conflicts![0]).toMatchObject({ id, theirs: 'Run now!', proposed: [text('ln_a', 'Run!'), move('ln_a', 0.3)] });
  });

  it('an item a card cannot apply (a server-only op) is tooBig with no ops; collisions past the cap are counted in more', () => {
    const turn = createDirectorTurn();
    recordConflicts(turn, [blocked('ln_a', 'Rewritten', [{ op: 'page_panels', id: 'pg_1', panels: [] }])]);
    expect(turn.conflicts![0]).toMatchObject({ proposed: [], tooBig: true });
    recordConflicts(turn, Array.from({ length: CONFLICT_LIMITS.items + 2 }, (_, i) => blocked(`ln_${i}`, `v${i}`)));
    const card = conflictCardFor(turn)!;
    expect(card.items).toHaveLength(CONFLICT_LIMITS.items);
    expect(card.more).toBe(3);
  });

  it('conflictCardText tells the director what was answered and what still waits', () => {
    const turn = createDirectorTurn();
    recordConflicts(turn, [blocked('ln_a', 'Run!'), blocked('ln_b', 'Go!')]);
    const card = conflictCardFor(turn)!;
    card.items[0] = { ...card.items[0], resolved: 'mine' };
    expect(conflictCardText(card)).toBe("[conflict: line ln_a — kept the creator's; line ln_b — waiting for an answer]");
    expect(conflictCardText({ ...card, more: 2 })).toBe("[conflict: line ln_a — kept the creator's; line ln_b — waiting for an answer; and 2 more left alone]");
    expect(conflictCardText({ type: 'conflict', id: 'x', items: [] })).toBe('');
  });

  it('styleWords names what a restyle changes', () => {
    expect(styleWords({ font: 'x', sizeScale: 1, textColor: '#000', fill: '#fff', shape: 'cloud' })).toBe('font, size, text colour, fill and 1 more');
    expect(styleWords({ border: '#000', borderWidth: 2 })).toBe('border');
    expect(styleWords(null)).toBe('its look');
  });
});
