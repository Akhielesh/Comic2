// Page editor lettering fixes from the v5 bug hunt (qa-verdicts, area lettering-editor), each written so it
// fails on the code before the fix:
//   LE-6  the Script panel's line text stops at the server's 600 characters and counts down near the cap;
//   LE-8  a width-grip resize and a tail aim are recorded as "Resize balloon" / "Aim tail", never "Move";
//   LE-9  moving a multi-selection in a translated edition is ONE undoable patch;
//   LE-11 clearing a balloon's text keeps the line empty, says so, and offers Delete.

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { PageEditor } from './PageEditor';
import { SAMPLE_NOW, makeSampleDoc, makeStudio } from './__fixtures__/sampleDoc';
import { lineSourceHash } from '../../../shared/comic/i18n';
import type { ComicDoc } from '../../../shared/comic/doc';
import type { StudioController } from '../types';
import type { DocOp } from '../../../shared/comic/ops';
import { makeQaDoc } from '../testing/qaFixtures';
import { estimateMeasure, letteringAspect, planLettering } from '../../../shared/comic/lettering/layout';

const allowance = vi.hoisted(() => ({ status: null as unknown }));
vi.mock('../../usage/useUsageAllowance', () => ({ useUsageAllowance: () => allowance.status }));

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(SAMPLE_NOW);
});
afterEach(() => {
  vi.restoreAllMocks();
});

const open = (doc: ComicDoc = makeSampleDoc()) => {
  const studio = makeStudio(doc, { focusedPageId: 'pg_1' });
  render(<PageEditor studio={studio} doc={doc} pageId="pg_1" />);
  return studio;
};
const hitOf = (lineId: string) => document.querySelector<HTMLElement>(`[data-testid="balloon-hit"][data-line-id="${lineId}"]`)!;
const calls = (studio: StudioController) => (studio.patch as ReturnType<typeof vi.fn>).mock.calls;
const click = (el: Element) => {
  fireEvent.pointerDown(el, { clientX: 5, clientY: 5, button: 0, pointerType: 'mouse' });
  fireEvent.pointerUp(window, { clientX: 5, clientY: 5 });
};
const drag = (el: Element, from: [number, number], to: [number, number], extra: Record<string, unknown> = {}) => {
  fireEvent.pointerDown(el, { clientX: from[0], clientY: from[1], button: 0, pointerType: 'mouse', ...extra });
  fireEvent.pointerMove(window, { clientX: to[0], clientY: to[1] });
  fireEvent.pointerUp(window, { clientX: to[0], clientY: to[1] });
};

const withTelugu = () =>
  makeSampleDoc((d) => {
    const line = d.pages[0].panels.flatMap((p) => p.lines).find((l) => l.id === 'pg_1_l2')!;
    d.i18n = {
      glossary: [],
      editions: { te: { lang: 'te', register: 'everyday', lines: { pg_1_l2: { text: 'పదండి!', status: 'reviewed', sourceHash: lineSourceHash(line), at: SAMPLE_NOW } }, balloons: {} } }
    };
  });

describe('LE-8: undo entries are named for the gesture', () => {
  it('a width-grip drag is "Resize balloon" and a tail-handle drag is "Aim tail", each with its own coalesce key', () => {
    const studio = open();
    click(hitOf('pg_1_l2'));
    drag(screen.getByTestId('width-handle'), [0, 0], [60, 0]);
    const [resizeOps, resizeOpts] = calls(studio).at(-1)!;
    expect(resizeOps[0]).toMatchObject({ op: 'balloon', lineId: 'pg_1_l2' });
    expect(resizeOps[0].patch.w).toBeDefined();
    expect(resizeOps[0].patch.x).toBeUndefined();
    expect(resizeOpts.label).toBe('Resize balloon');

    drag(screen.getByTestId('tail-handle'), [0, 0], [30, -45]);
    const [tailOps, tailOpts] = calls(studio).at(-1)!;
    expect(tailOps[0].patch.tailX).toBeDefined();
    expect(tailOpts.label).toBe('Aim tail');
    // A resize then an aim within the coalesce window stay two undo entries.
    expect(tailOpts.coalesce).not.toBe(resizeOpts.coalesce);
  });

  it('a plain move is still "Move balloon"', () => {
    const studio = open();
    fireEvent.keyDown(hitOf('pg_1_l2'), { key: 'ArrowUp' });
    expect(calls(studio).at(-1)![1]).toMatchObject({ undo: true, label: 'Move balloon' });
  });
});

describe('LE-9: a multi-selection move in a translated edition', () => {
  it('is one patch of edition_balloon ops (one undo entry), like in the original language', () => {
    const studio = open(withTelugu());
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Edit which language' })).getByRole('radio', { name: /తెలుగు/ }));
    click(hitOf('pg_1_l2'));
    fireEvent.pointerDown(hitOf('pg_1_l3'), { clientX: 5, clientY: 5, button: 0, pointerType: 'mouse', shiftKey: true });
    (studio.patch as ReturnType<typeof vi.fn>).mockClear();
    drag(hitOf('pg_1_l2'), [100, 100], [160, 100], { altKey: true });
    const made = calls(studio);
    expect(made).toHaveLength(1);
    const ops = made[0][0] as { op: string; lineId: string }[];
    expect(ops.every((o) => o.op === 'edition_balloon')).toBe(true);
    expect(ops.map((o) => o.lineId).sort()).toEqual(['pg_1_l2', 'pg_1_l3']);
    expect(made[0][1]).toMatchObject({ undo: true, label: 'Move balloons' });
  });
});

describe('LE-6: the Script panel line text', () => {
  it('stops at 600 characters (the server cap) and counts down near it', () => {
    const studio = open();
    const row = document.querySelector<HTMLElement>('[data-testid="line-row"][data-line-id="pg_1_l2"]')!;
    const field = within(row).getByLabelText(/^Line text/) as HTMLTextAreaElement;
    expect(field.maxLength).toBe(600);
    expect(within(row).queryByTestId('line-text-count')).toBeNull();
    fireEvent.focus(field);
    const long = 'The vendor shouts across the lane. '.repeat(22).trim(); // 769 characters
    // A paste past the cap: the browser's maxLength stops it in a real field; the count shows the cap.
    fireEvent.input(field, { target: { value: long.slice(0, 590) } });
    expect(within(row).getByTestId('line-text-count').textContent).toBe('590 / 600');
    fireEvent.change(field, { target: { value: long } });
    fireEvent.blur(field);
    const [ops] = calls(studio).at(-1)!;
    expect(ops[0]).toMatchObject({ op: 'line', id: 'pg_1_l2' });
    // What the editor stores is what the server keeps: never longer than 600.
    expect(ops[0].patch.text.length).toBe(600);
  });
});

describe('LE-11: clearing a balloon’s text in the inline editor', () => {
  it('keeps the line empty (no silent restore), says so, and offers Delete while it is empty', () => {
    const studio = open();
    fireEvent.keyDown(hitOf('pg_1_l2'), { key: 'Enter' });
    const ta = screen.getByTestId('balloon-text-editor');
    fireEvent.change(ta, { target: { value: '   ' } });
    // While empty the editor says what Enter does and offers the delete.
    expect(screen.getByTestId('balloon-text-hint').textContent).toMatch(/empty/i);
    expect(screen.getByTestId('balloon-text-delete')).toBeTruthy();
    fireEvent.keyDown(ta, { key: 'Enter' });
    const [ops, opts] = calls(studio).at(-1)!;
    expect(ops).toEqual([{ op: 'line', pageId: 'pg_1', panelId: expect.any(String), id: 'pg_1_l2', patch: { text: '' } }]);
    expect(opts).toMatchObject({ undo: true, label: 'Clear balloon text' });
    expect(document.body.textContent).toMatch(/text is empty, so it is hidden/);
  });

  it('the Delete offered in the emptied editor removes the line in one undoable step', () => {
    const studio = open();
    fireEvent.keyDown(hitOf('pg_1_l2'), { key: 'Enter' });
    fireEvent.change(screen.getByTestId('balloon-text-editor'), { target: { value: '' } });
    fireEvent.click(screen.getByTestId('balloon-text-delete'));
    const [ops, opts] = calls(studio).at(-1)!;
    expect(ops[0]).toMatchObject({ op: 'line', id: 'pg_1_l2', patch: null });
    expect(opts).toMatchObject({ undo: true, label: 'Delete balloon' });
  });
});

describe('dense page: the balloon menu Lock keeps the size the balloon is drawn at', () => {
  it('stress pg_11: Lock sends the lock and a line_style sizeScale override in ONE patch (the touch path)', () => {
    const doc = makeQaDoc('stress');
    const page = doc.pages.find((p) => p.id === 'pg_11')!;
    const plans = planLettering(doc, page, letteringAspect(doc, page), estimateMeasure);
    const target = plans.find((p) => p.densityScale && !p.locked && !page.balloons.find((b) => b.lineId === p.lineId)?.pinned)!;
    expect(target, 'pg_11 letters an unpinned balloon smaller').toBeTruthy();
    const studio = makeStudio(doc, { focusedPageId: 'pg_11' });
    render(<PageEditor studio={studio} doc={doc} pageId="pg_11" />);
    fireEvent.contextMenu(hitOf(target.lineId), { clientX: 120, clientY: 300 });
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: /^Lock/ }));
    const [ops, opts] = calls(studio).at(-1)!;
    expect(opts).toMatchObject({ undo: true, label: 'Lock balloon' });
    expect(ops.some((o: DocOp) => o.op === 'balloon' && o.lineId === target.lineId && (o.patch as { locked?: boolean }).locked === true)).toBe(true);
    const size = ops.find((o: DocOp) => o.op === 'line_style' && o.lineIds.includes(target.lineId));
    expect(size, 'the drawn size rides along with the lock').toBeTruthy();
    expect(size.patch.sizeScale).toBeCloseTo(target.style.sizeScale * target.densityScale!, 2);
  });
});
