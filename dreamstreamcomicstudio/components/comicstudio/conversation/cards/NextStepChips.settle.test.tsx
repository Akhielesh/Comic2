// Q-SETTLE: the chips under the newest reply settle the moment the creator picks one. A chip that does something
// collapses the row to one line ("You chose: …") while it runs; the message it posts takes the row away; a refused tap
// brings the chips back; a free edit already in the comic is the row's choice, read from the doc (after a reload too),
// and one whose page is gone is not offered; a text chip waiting in Up next keeps the row collapsed. Navigation chips
// answer nothing and never collapse it. Chip keys survive a doc update that retires another chip.

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { ComicDoc, NextStep } from '../../../../shared/comic/doc';
import type { DocOp } from '../../../../shared/comic/ops';
import { applyOps } from '../../../../shared/comic/ops';
import { makeFakeStudio, makeSampleDoc, resetUsageStatus, showDollarPrices } from '../testing/fixtures';
import { NextStepChips, chipsFor } from './NextStepChips';

beforeEach(showDollarPrices);
afterEach(resetUsageStatus);

const deferred = <T,>() => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const doc = makeSampleDoc();
const page = doc.pages[0];
const layoutFix: DocOp[] = [{ op: 'page', id: page.id, patch: { layout: 'Row 1: one splash panel.' } }];
const steps: NextStep[] = [
  { label: 'Make it funnier', say: 'Make it funnier' },
  { label: 'Make the cover', action: { type: 'render_cover', quotedUsd: 0.07 }, usd: 0.07 },
  { label: 'Read it', client: { type: 'open_reader' }, usd: 0 }
];
const row = () => screen.getByRole('group', { name: 'Next steps' });
const chipsOf = (list: NextStep[]) => chipsFor({ id: 'a1', role: 'assistant', text: '', at: 1, nextSteps: list }, doc);

describe('NextStepChips settle on a tap', () => {
  it('(a) an action chip collapses the row to one line while it runs: no other chip stays tappable', async () => {
    const run = deferred<void>();
    const studio = makeFakeStudio({ doc, runNextStep: vi.fn(() => run.promise) });
    render(<NextStepChips chips={chipsOf(steps)} studio={studio} />);
    fireEvent.click(within(row()).getByRole('button', { name: /Make the cover/ }));
    expect(studio.runNextStep).toHaveBeenCalledTimes(1);
    expect(within(row()).queryAllByRole('button')).toHaveLength(0);
    expect(row().textContent).toBe('You chose: Make the cover');
    expect(row()).toHaveAttribute('aria-busy', 'true');
    // The price never sits on the settled line.
    expect(row().textContent).not.toMatch(/\$/);
    await act(async () => run.resolve());
  });

  it('(a) a refused tap brings the chips back (nothing was posted)', async () => {
    const run = deferred<void>();
    const studio = makeFakeStudio({ doc, runNextStep: vi.fn(() => run.promise) });
    render(<NextStepChips chips={chipsOf(steps)} studio={studio} />);
    fireEvent.click(within(row()).getByRole('button', { name: /Make the cover/ }));
    expect(within(row()).queryAllByRole('button')).toHaveLength(0);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await act(async () => run.reject(new Error('refused')));
    warn.mockRestore();
    expect(within(row()).getAllByRole('button')).toHaveLength(3);
  });

  it('(a) a text chip collapses the row the same way', () => {
    const studio = makeFakeStudio({ doc, runNextStep: vi.fn(() => new Promise<void>(() => undefined)) });
    render(<NextStepChips chips={chipsOf(steps)} studio={studio} />);
    fireEvent.click(within(row()).getByRole('button', { name: 'Make it funnier' }));
    expect(row().textContent).toBe('You chose: Make it funnier');
  });

  it('a navigation chip answers nothing: the row stays as it is', () => {
    const studio = makeFakeStudio({ doc, runNextStep: vi.fn(async () => undefined) });
    render(<NextStepChips chips={chipsOf(steps)} studio={studio} />);
    fireEvent.click(within(row()).getByRole('button', { name: /Read it/ }));
    expect(within(row()).getAllByRole('button')).toHaveLength(3);
  });

  it('(d) a free edit whose page is gone is not offered (after a reload too); the other chips stay', () => {
    const fix: NextStep = { label: 'Use the layout that fits page 1', action: { type: 'patch', ops: layoutFix }, usd: 0 };
    const list = [fix, steps[0]];
    const before = render(<NextStepChips chips={chipsOf(list)} studio={makeFakeStudio({ doc })} />);
    expect(within(row()).getByRole('button', { name: /Use the layout that fits page 1/ })).toBeEnabled();
    before.unmount();
    const without: ComicDoc = JSON.parse(JSON.stringify({ ...doc, pages: doc.pages.filter((p) => p.id !== page.id) }));
    render(<NextStepChips chips={chipsOf(list)} studio={makeFakeStudio({ doc: without })} />);
    expect(within(row()).queryByRole('button', { name: /Use the layout that fits/ })).toBeNull();
    expect(within(row()).getByRole('button', { name: 'Make it funnier' })).toBeEnabled();
  });

  it('(a)+(d) a free edit chip posts no message: once its edit is in the comic the whole row reads it, alternatives gone, after a reload too', async () => {
    const fix: NextStep = { label: 'Use the layout that fits page 1', action: { type: 'patch', ops: layoutFix }, usd: 0 };
    const other: NextStep = { label: 'Draw page 1 anyway', action: { type: 'render_pages', pageIds: [page.id], quotedUsd: 0.07 }, usd: 0.07 };
    const list = [fix, other, steps[0]];
    const run = deferred<void>();
    const studio = makeFakeStudio({ doc, runNextStep: vi.fn(() => run.promise) });
    const view = render(<NextStepChips chips={chipsOf(list)} studio={studio} />);
    fireEvent.click(within(row()).getByRole('button', { name: /Use the layout that fits page 1/ }));
    expect(row().textContent).toBe('You chose: Use the layout that fits page 1');
    // The patch lands (applyPatch commits it and posts nothing), then the tap finishes: the row stays at its one line.
    const applied = applyOps(doc, layoutFix);
    view.rerender(<NextStepChips chips={chipsOf(list)} studio={{ ...studio, doc: applied }} />);
    await act(async () => run.resolve());
    expect(row().textContent).toBe('You chose: Use the layout that fits page 1');
    expect(within(row()).queryAllByRole('button')).toHaveLength(0);
    view.unmount();
    // A reload (the stored doc, a fresh row): the same line, nothing tappable.
    render(<NextStepChips chips={chipsOf(list)} studio={makeFakeStudio({ doc: JSON.parse(JSON.stringify(applied)) as ComicDoc })} />);
    expect(row().textContent).toBe('You chose: Use the layout that fits page 1');
    expect(within(row()).queryAllByRole('button')).toHaveLength(0);
  });

  it('(a) a comic-wide switch chip ("Switch to Standard quality") reads as chosen once the setting is in the comic', () => {
    const quality: NextStep = { label: 'Switch to Standard quality', action: { type: 'patch', ops: [{ op: 'settings', patch: { quality: 'standard' } }] }, usd: 0 };
    const draft = applyOps(doc, [{ op: 'settings', patch: { quality: 'draft' } }] as DocOp[]);
    render(<NextStepChips chips={chipsOf([quality, steps[0]])} studio={makeFakeStudio({ doc: draft })} />);
    expect(within(row()).getByRole('button', { name: /Switch to Standard quality/ })).toBeEnabled();
    cleanup();
    render(<NextStepChips chips={chipsOf([quality, steps[0]])} studio={makeFakeStudio({ doc: applyOps(draft, quality.action!.type === 'patch' ? quality.action!.ops : []) })} />);
    expect(row().textContent).toBe('You chose: Switch to Standard quality');
  });

  it('a chip that leaves the row while another runs never brings the tapped one back (stable keys)', () => {
    const fix: NextStep = { label: 'Use the layout that fits page 1', action: { type: 'patch', ops: [{ op: 'page', id: page.id, patch: { layout: 'Row 1: two panels.' } }] }, usd: 0 };
    const list = [fix, steps[1], steps[2]];
    const studio = makeFakeStudio({ doc, runNextStep: vi.fn(() => new Promise<void>(() => undefined)) });
    const view = render(<NextStepChips chips={chipsOf(list)} studio={studio} />);
    fireEvent.click(within(row()).getByRole('button', { name: /Make the cover/ }));
    expect(row().textContent).toBe('You chose: Make the cover');
    // Another tab removes page 1 while the cover runs: the free edit for it is retired, so the chips after it move up.
    const without: ComicDoc = { ...doc, pages: doc.pages.filter((p) => p.id !== page.id) };
    view.rerender(<NextStepChips chips={chipsOf(list)} studio={{ ...studio, doc: without }} />);
    expect(row().textContent).toBe('You chose: Make the cover');
    expect(within(row()).queryAllByRole('button')).toHaveLength(0);
    expect(studio.runNextStep).toHaveBeenCalledTimes(1);
  });

  it('(b) a text chip already waiting in Up next keeps the row at one line', () => {
    const studio = makeFakeStudio({ doc, queue: [{ id: 'n1', text: 'make it  FUNNIER', at: 1 }], turnLocked: true });
    render(<NextStepChips chips={chipsOf(steps)} studio={studio} />);
    expect(row().textContent).toBe('You chose: Make it funnier · Up next');
    expect(within(row()).queryAllByRole('button')).toHaveLength(0);
  });
});
