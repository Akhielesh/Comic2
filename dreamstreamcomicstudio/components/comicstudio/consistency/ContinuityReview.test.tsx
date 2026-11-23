import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { applyOp, type DocOp } from '../../../shared/comic/ops';
import { pageOf } from '../../../shared/comic/__fixtures__/consistencyBooks';
import { PageCard } from '../board/PagesTab';
import { makeFakeStudio, makeSampleDoc } from '../conversation/testing/fixtures';
import { ContinuityReview } from './ContinuityReview';

it('reads saved style and panel observations in a named list and resolves only known visual references', () => {
  const doc = makeSampleDoc();
  const page = doc.pages[1];
  page.render.anchorKeys = ['prev:pg_1'];
  page.render.qc = {
    score: 0.724,
    checkedAt: 1,
    findings: [
      { id: 'style', kind: 'style', panel: 0, severity: 'minor', note: 'The line weight changes from fine ink to thick outlines.' },
      { id: 'color', kind: 'continuity', panel: 2, severity: 'minor', note: 'The scarf changes color.' },
      { id: 'old', kind: 'style', panel: 2, severity: 'minor', note: 'Earlier palette concern.', dismissed: true }
    ],
    issues: [
      'The line weight changes from fine ink to thick outlines.', 'The scarf changes color.', 'Earlier palette concern.',
      'The shadows differ from prev:pg_1.', 'Check prev:pg_other.', 'Check u/member/p/book/ref/source.webp.',
      'Open https://example.invalid/art?token=example', '<img src=x>', 'QC score: 0.724'
    ]
  };
  const studio = makeFakeStudio({ doc });
  render(<ContinuityReview studio={studio} doc={doc} page={page} onClose={vi.fn()} />);
  const section = within(screen.getByRole('region', { name: 'Review notes on this drawing' }));
  expect(section.getByRole('heading', { level: 3 })).toBeVisible();
  const list = within(section.getByRole('list', { name: 'Review notes on this drawing' }));
  expect(list.getAllByRole('listitem').map(item => item.textContent)).toEqual([
    'The line weight changes from fine ink to thick outlines.',
    'Panel 2 · The scarf changes color.',
    'The shadows differ from reference page 1.'
  ]);
  expect(section.queryByRole('link')).toBeNull();
  expect(studio.act).not.toHaveBeenCalled();
});

it('does not infer a clean result or print a score when the saved check has no displayable observations', () => {
  const doc = makeSampleDoc();
  doc.pages[0].render.qc = { score: 0.948, checkedAt: 1, issues: ['token=private', 'See file:///root/reference.png'] };
  render(<ContinuityReview studio={makeFakeStudio({doc})} doc={doc} page={doc.pages[0]} onClose={vi.fn()} />);
  expect(screen.queryByRole('region', { name: 'Review notes on this drawing' })).toBeNull();
  expect(screen.getByRole('dialog')).not.toHaveTextContent(/0\.948|94\.8|token=|reference\.png|passed the check/i);
});

it('withholds a quarantined drawing and its review notes together', () => {
  const doc = makeSampleDoc();
  const page = doc.pages[0];
  page.render.asset!.safety = { quarantined:true, at:1 };
  page.render.qc = { score:0.4, checkedAt:1, issues:['A drawing detail withheld with the image.'] };
  const studio = makeFakeStudio({doc});
  render(<ContinuityReview studio={studio} doc={doc} page={page} onClose={vi.fn()} />);
  expect(screen.queryByRole('img')).toBeNull();
  expect(screen.queryByRole('region', { name: 'Review notes on this drawing' })).toBeNull();
  expect(screen.queryByText('A drawing detail withheld with the image.')).toBeNull();
});

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
