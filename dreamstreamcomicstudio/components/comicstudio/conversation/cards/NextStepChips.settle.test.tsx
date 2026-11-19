// Q-SETTLE: the chips under the newest reply settle the moment the creator picks one. A chip that does something
// collapses the row to one line ("You chose: …") while it runs; the message it posts takes the row away; a refused tap
// brings the chips back; a free edit already in the comic is not offered again (after a reload too); a text chip
// waiting in Up next keeps the row collapsed. Navigation chips answer nothing and never collapse it.

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
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

  it('(d) a free edit already in the comic is not offered again, after a reload too', () => {
    const fix: NextStep = { label: 'Use the layout that fits page 1', action: { type: 'patch', ops: layoutFix }, usd: 0 };
    const list = [fix, steps[0]];
    const before = render(<NextStepChips chips={chipsOf(list)} studio={makeFakeStudio({ doc })} />);
    expect(within(row()).getByRole('button', { name: /Use the layout that fits page 1/ })).toBeEnabled();
    before.unmount();
    const applied: ComicDoc = JSON.parse(JSON.stringify(applyOps(doc, layoutFix)));
    render(<NextStepChips chips={chipsOf(list)} studio={makeFakeStudio({ doc: applied })} />);
    expect(within(row()).queryByRole('button', { name: /Use the layout that fits/ })).toBeNull();
    expect(within(row()).getByRole('button', { name: 'Make it funnier' })).toBeEnabled();
  });

  it('(b) a text chip already waiting in Up next keeps the row at one line', () => {
    const studio = makeFakeStudio({ doc, queue: [{ id: 'n1', text: 'make it  FUNNIER', at: 1 }], turnLocked: true });
    render(<NextStepChips chips={chipsOf(steps)} studio={studio} />);
    expect(row().textContent).toBe('You chose: Make it funnier · Up next');
    expect(within(row()).queryAllByRole('button')).toHaveLength(0);
  });
});
