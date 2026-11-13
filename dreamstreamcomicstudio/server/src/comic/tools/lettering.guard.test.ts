// @vitest-environment node
// Every lettering writer goes through the conflict guard (A3 fixer wave note 6, built in wave 2 B-TOOL): the creator's
// mid-turn change wins, the rest applies, the tool result says "Conflict:" and the turn keeps the held part for the card.
// Also: arrange_balloons places on the whole page and next to a character through the shared dialogue placement.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CAPS, type StudioCaps } from '../../../../shared/comic/capabilities.js';
import type { ComicDoc } from '../../../../shared/comic/doc.js';
import { newSession, plannedDoc, testContext, type TestContext } from '../orchestrator.fakes.js';
import { createDirectorTurn, type DirectorTurn } from '../tools.js';
import { letteringToolGroup } from './lettering.js';

beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

const GUARD_ON: StudioCaps = { ...DEFAULT_CAPS, liveAgent: { queue: false, steer: false, conflicts: true } };

/** Page 1 panel 2 holds two of Maya's lines; overlay lettering. */
const twoLines = (): ComicDoc => {
  const doc = plannedDoc();
  doc.format = { ...doc.format, lettering: 'overlay' };
  doc.pages[0].panels[1].lines = [
    { id: 'ln_a', kind: 'speech', speakerId: 'c_maya', text: 'Line A' },
    { id: 'ln_b', kind: 'speech', speakerId: 'c_maya', text: 'Line B' }
  ];
  return doc;
};

let ctx: TestContext;
let turn: DirectorTurn;
const tool = (name: string) => letteringToolGroup.tools(ctx, turn).find((t) => t.spec.function.name === name)!;
const setup = (caps: StudioCaps = GUARD_ON) => {
  ctx = testContext(newSession(twoLines()), { caps });
  turn = createDirectorTurn({ startRev: ctx.session.doc.rev });
};

describe('lettering writers behind the conflict guard', () => {
  it('restyle_balloons: the line the creator restyled keeps its look; the other is restyled; "Conflict:" in the result', async () => {
    setup();
    ctx.session.commit([{ op: 'line_style', pageId: 'pg_1', lineIds: ['ln_a'], patch: { shape: 'burst' } }], { origin: 'user' });
    const out = await tool('restyle_balloons').execute({ target: { page: 1, speaker: 'Maya' }, style: { shape: 'cloud' } });
    expect(out).toMatch(/^Restyled 1 of 3 of Maya's balloon on page 1 \(cloud bubbles\)\./);
    expect(out).toMatch(/Conflict: you changed page 1 · panel 2/);
    const lines = ctx.session.doc.pages[0].panels[1].lines;
    expect(lines.find((l) => l.id === 'ln_a')?.style).toEqual({ shape: 'burst' });
    expect(lines.find((l) => l.id === 'ln_b')?.style).toEqual({ shape: 'cloud' });
    expect(turn.conflicts).toHaveLength(1);
  });

  it('set_lettering_style: a kind look the creator set mid-turn holds the director\'s change back entirely', async () => {
    setup();
    ctx.session.commit([{ op: 'letter_style', patch: { kinds: { shout: { textColor: '#111111' } } } }], { origin: 'user' });
    const rev = ctx.session.doc.rev;
    const out = await tool('set_lettering_style').execute({ scope: 'kind', kind: 'shout', style: { text_color: 'red' } });
    expect(out).toMatch(/^Conflict: you changed /);
    expect(ctx.session.doc.rev).toBe(rev);
    expect(turn.conflicts).toHaveLength(1);
  });

  it('arrange_balloons: a balloon the creator moved stays; the result says so', async () => {
    setup();
    ctx.session.commit([{ op: 'balloon', pageId: 'pg_1', lineId: 'ln_a', patch: { x: 0.5, y: 0.5, w: 0.2, pinned: true } }], { origin: 'user' });
    const out = await tool('arrange_balloons').execute({ page: 1, action: 'nudge', target: { line_ids: ['ln_a'] }, dy: -0.05 });
    expect(out).toMatch(/^Conflict: /);
    expect(ctx.session.doc.pages[0].balloons.find((b) => b.lineId === 'ln_a')).toMatchObject({ x: 0.5, y: 0.5 });
  });

  it('guard off: every writer behaves exactly as before', async () => {
    setup(DEFAULT_CAPS);
    ctx.session.commit([{ op: 'line_style', pageId: 'pg_1', lineIds: ['ln_a'], patch: { shape: 'burst' } }], { origin: 'user' });
    const out = await tool('restyle_balloons').execute({ target: { page: 1, panel: 2 }, style: { shape: 'cloud' } });
    expect(out).not.toContain('Conflict');
    expect(ctx.session.doc.pages[0].panels[1].lines.every((l) => l.style?.shape === 'cloud')).toBe(true);
  });
});

describe('arrange_balloons move through the shared dialogue placement (plan §3 B3)', () => {
  it('frame "page": a spot of the whole page (top-left of the page, not of the panel), pinned', async () => {
    setup(DEFAULT_CAPS);
    const out = await tool('arrange_balloons').execute({ page: 1, action: 'move', target: { line_ids: ['ln_b'] }, position: 'top-left', frame: 'page' });
    expect(out).toMatch(/^Moved the speech balloon “Line B” to the top left of page 1, inside the safe margin\. Pinned/);
    const b = ctx.session.doc.pages[0].balloons.find((x) => x.lineId === 'ln_b')!;
    expect(b.pinned).toBe(true);
    expect(b.x).toBeLessThan(0.2);
    expect(b.y).toBeLessThan(0.2);
    expect(await tool('arrange_balloons').execute({ page: 1, action: 'move', target: { page: 1, panel: 2 }, position: 'top', frame: 'page' })).toMatch(/^Error: Place one balloon at a time/);
  });

  it('near: next to a character, or a plain refusal when they are not in the panel', async () => {
    setup(DEFAULT_CAPS);
    const out = await tool('arrange_balloons').execute({ page: 1, action: 'move', target: { line_ids: ['ln_a'] }, near: 'Maya', position: 'top' });
    expect(out).toMatch(/^Moved the speech balloon “Line A” to /);
    expect(ctx.session.doc.pages[0].balloons.find((x) => x.lineId === 'ln_a')?.pinned).toBe(true);
    const away = await tool('arrange_balloons').execute({ page: 1, action: 'move', target: { line_ids: ['ln_a'] }, near: 'Arjun', position: 'top' });
    expect(away).toMatch(/Nothing was moved\.$/);
  });
});
