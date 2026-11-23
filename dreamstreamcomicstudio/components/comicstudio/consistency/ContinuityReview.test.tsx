import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { applyOp, type DocOp } from '../../../shared/comic/ops';
import { pageOf } from '../../../shared/comic/__fixtures__/consistencyBooks';
import { PageCard } from '../board/PagesTab';
import { makeFakeStudio, makeSampleDoc } from '../conversation/testing/fixtures';
import { ContinuityReview } from './ContinuityReview';

it('shows earlier artwork actually used by the drawing and omits unrecognized project references', () => {
  const doc = makeSampleDoc();
  const page = doc.pages[1];
  page.render = { ...doc.pages[0].render, anchorKeys:['prev:pg_1','prev:unknown','style:board'] };
  render(<ContinuityReview studio={makeFakeStudio({doc})} doc={doc} page={page} onClose={vi.fn()} />);
  expect(screen.getByText('This drawing used artwork from page 1 as a visual reference.')).toBeVisible();
  expect(screen.queryByText(/prev:|unknown/)).toBeNull();
});

it('shows the actual drawing check, inspects original art and undoes a change to an existing writer direction', async () => {
  const doc = makeSampleDoc();
  doc.pages[0].continuity = { by:'writer', cast:{c_maya:{outfit:'Wool coat'}} };
  doc.pages[0].render.qc = { score:0.8, issues:['The sleeve color changed.'], checkedAt:0 };
  const studio = makeFakeStudio({doc, urlFor: (_asset, opts) => opts?.width ? '/private-thumb' : '/private-original' });
  const review = (current: typeof doc) => <ContinuityReview studio={studio} doc={current} page={current.pages[0]} onClose={vi.fn()} />;
  const {rerender} = render(review(doc));
  expect(screen.getByText('The sleeve color changed.')).toBeVisible();
  fireEvent.click(screen.getByRole('button',{name:'Inspect artwork'}));
  expect(screen.getByRole('img',{name:'Current drawing of page 1'})).toHaveAttribute('src','/private-original');
  fireEvent.change(screen.getByLabelText('Correct detail'), {target:{value:'Coat with a blue cuff'}});
  fireEvent.click(screen.getByRole('button',{name:'Save correction'}));
  await screen.findByText('Correction saved to this comic.');
  const changed = applyOp(doc, studio.patch.mock.calls[0][0][0] as DocOp);
  rerender(review(changed));
  fireEvent.click(screen.getByRole('button',{name:'Undo last correction'}));
  await screen.findByText('Previous details restored.');
  const restored = applyOp(changed, studio.patch.mock.calls[1][0][0] as DocOp);
  expect(restored.pages[0].continuity).toEqual(doc.pages[0].continuity);
  expect(studio.act).not.toHaveBeenCalled();
});

it('opens from a normal page card, saves once, shows where the artist will use the correction, and supports removal', async () => {
  const doc = makeSampleDoc();
  doc.pages = Array.from({length: 14}, (_, i) => pageOf(i + 1, [{cast:['c_maya']}]));
  const studio = makeFakeStudio({ doc });
  const control = { onToggleSelect:vi.fn(), selected:false, byok:true, studio };
  const card = (value: typeof doc, n: number) => <PageCard {...control} doc={value} page={value.pages[n-1]} />;
  const {rerender} = render(card(doc, 11));
  fireEvent.click(screen.getByRole('button', {name:'Review continuity on page 11'}));
  const dialog = within(screen.getByRole('dialog', {name:'Continuity · Page 11'}));
  fireEvent.change(dialog.getByLabelText('Correct detail'), {target:{value:'Teal jacket with one brass button'}});
  fireEvent.click(dialog.getByRole('button', {name:'Save correction'}));
  await dialog.findByText('Correction saved to this comic.');
  expect(studio.patch).toHaveBeenCalledTimes(1);
  const saved = applyOp(doc, studio.patch.mock.calls[0][0][0] as DocOp);
  rerender(card(saved,11));
  expect(dialog.getByText('From page 11 · Used when drawing pages 11–14')).toBeVisible();
  expect(dialog.getByRole('button',{name:'Save correction'})).toBeDisabled();
  fireEvent.click(dialog.getByRole('button',{name:'Close'}));
  rerender(card(saved,12));
  fireEvent.click(screen.getByRole('button', {name:'Review continuity on page 12'}));
  expect(screen.getByLabelText('Correct detail')).toHaveValue('Teal jacket with one brass button');
  expect(screen.queryByRole('button',{name:'Remove page correction'})).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:'Close'}));
  rerender(card(saved,11));
  fireEvent.click(screen.getByRole('button',{name:'Review continuity on page 11'}));
  fireEvent.click(screen.getByRole('button',{name:'Remove page correction'}));
  await screen.findByText('Page correction removed.');
  expect(studio.patch).toHaveBeenCalledTimes(2);
  expect(studio.act).not.toHaveBeenCalled();
});

it('keeps a rejected edit visible and never tells the creator it was saved', async () => {
  const doc = makeSampleDoc();
  const studio = makeFakeStudio({doc});
  studio.patch.mockImplementation(async (_ops, options) => { options.onFailed(false); });
  render(<ContinuityReview studio={studio} doc={doc} page={doc.pages[0]} onClose={vi.fn()} />);
  fireEvent.change(screen.getByLabelText('Correct detail'), {target:{value:'Plaid coat'}});
  fireEvent.click(screen.getByRole('button',{name:'Save correction'}));
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('save could not be confirmed'));
  expect(screen.getByLabelText('Correct detail')).toHaveValue('Plaid coat');
  expect(screen.queryByText('Correction saved to this comic.')).toBeNull();
  expect(studio.act).not.toHaveBeenCalled();
});
