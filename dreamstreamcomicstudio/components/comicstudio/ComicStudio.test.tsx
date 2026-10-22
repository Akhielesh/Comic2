import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { ComicStudioController } from './useStudio';
import { makeFakeStudio, makeSampleDoc, type FakeStudio } from './conversation/testing/fixtures';

const state = vi.hoisted(() => ({ studio: null as unknown as ComicStudioController, wide: true }));

vi.mock('./useStudio', () => ({ useStudio: () => state.studio }));
vi.mock('./board/BoardPane', () => ({
  BoardPane: ({ studio }: { studio: ComicStudioController }) => <div data-testid="board">Board · {studio.tab}</div>
}));
vi.mock('../studio/kit/useMediaQuery', () => ({ useIsWide: () => state.wide, useMediaQuery: () => state.wide }));

import { ComicStudio, SPLIT_STORAGE_KEY } from './ComicStudio';

const mount = (studio: FakeStudio, onBack = vi.fn()) => {
  state.studio = studio;
  const utils = render(<ComicStudio projectId="proj_1" onBack={onBack} />);
  return { ...utils, onBack };
};

beforeEach(() => {
  state.wide = true;
  window.localStorage.clear();
});

describe('ComicStudio shell', () => {
  it('shows a skeleton while loading, then the studio once the doc arrives', () => {
    const loading = makeFakeStudio({ doc: null, loading: true });
    const { rerender, onBack } = mount(loading);
    expect(screen.getByLabelText('Opening your comic')).toHaveAttribute('aria-busy', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Back to your projects' }));
    expect(onBack).toHaveBeenCalled();

    state.studio = makeFakeStudio();
    rerender(<ComicStudio projectId="proj_1" onBack={onBack} />);
    expect(screen.queryByLabelText('Opening your comic')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Comic title')).toHaveValue('Rooftop Heist');
    expect(screen.getByRole('region', { name: 'Conversation' })).toBeInTheDocument();
    expect(screen.getByTestId('board')).toBeInTheDocument();
    expect(screen.getByRole('separator', { name: 'Resize conversation and board' })).toBeInTheDocument();
  });

  it('a fatal load error offers retry and back', () => {
    const studio = makeFakeStudio({ doc: null, loading: false, loadError: "This comic doesn't exist or you don't have access to it." });
    const { onBack } = mount(studio);
    expect(screen.getByRole('alert')).toHaveTextContent("Couldn’t open this comic");
    fireEvent.click(screen.getByRole('button', { name: /Try again/ }));
    expect(studio.refresh).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /Back/ }));
    expect(onBack).toHaveBeenCalled();
  });

  it('renaming the title patches the brief on blur; Escape reverts', () => {
    const studio = makeFakeStudio();
    mount(studio);
    const title = screen.getByLabelText('Comic title');
    fireEvent.focus(title);
    fireEvent.change(title, { target: { value: 'Night Heist' } });
    fireEvent.blur(title);
    expect(studio.patch).toHaveBeenCalledWith([{ op: 'brief', patch: { title: 'Night Heist' } }]);

    fireEvent.focus(title);
    fireEvent.change(title, { target: { value: 'Oops' } });
    fireEvent.keyDown(title, { key: 'Escape' });
    expect(title).toHaveValue('Rooftop Heist');
    expect(studio.patch).toHaveBeenCalledTimes(1);
  });

  it('Read opens the read tab', () => {
    const studio = makeFakeStudio();
    mount(studio);
    fireEvent.click(screen.getByRole('button', { name: 'Read the comic' }));
    expect(studio.setTab).toHaveBeenCalledWith('read');
  });

  it('the quality pill opens the quality panel', () => {
    const studio = makeFakeStudio();
    mount(studio);
    fireEvent.click(screen.getByTitle('Quality'));
    const panel = screen.getByRole('dialog', { name: 'Quality' });
    fireEvent.click(within(panel).getByRole('radio', { name: /Draft/ }));
    expect(studio.patch).toHaveBeenCalledWith([{ op: 'settings', patch: { quality: 'draft' } }]);
  });

  it('the spend chip breaks spending down by kind and notes BYOK spend', () => {
    const doc = makeSampleDoc({
      spend: {
        totalUsd: 0.42,
        byKind: { page: 0.3, chat: 0.12 },
        entries: [
          { id: 's1', at: 1, kind: 'page', label: 'Page 1', usd: 0.3, byok: true, estimated: false },
          { id: 's2', at: 2, kind: 'chat', label: 'Director', usd: 0.12, byok: false, estimated: true }
        ]
      },
      settings: { quality: 'standard', confirm: 'big', bigSpendUsd: 0.5, budgetUsd: 5 }
    });
    mount(makeFakeStudio({ doc }));
    fireEvent.click(screen.getByRole('button', { name: 'Spent $0.42 on this comic' }));
    const panel = screen.getByRole('dialog', { name: 'Spending' });
    expect(within(panel).getByText('Pages')).toBeInTheDocument();
    expect(within(panel).getByText('Director')).toBeInTheDocument();
    expect(within(panel).getByText(/\$0\.42 of your \$5\.00 budget/)).toBeInTheDocument();
    expect(within(panel).getByText(/\$0\.30 of this was paid with your own API key/)).toBeInTheDocument();
    expect(within(panel).getByText(/estimates/)).toBeInTheDocument();
  });

  it('settings: confirm policy, threshold, budget cap, lettering and direction all patch the doc', () => {
    const studio = makeFakeStudio();
    mount(studio);
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Settings/ }));
    const sheet = screen.getByRole('dialog', { name: 'Comic settings' });

    fireEvent.click(within(sheet).getByRole('radio', { name: /Always ask/ }));
    expect(studio.patch).toHaveBeenLastCalledWith([{ op: 'settings', patch: { confirm: 'always' } }]);

    const threshold = within(sheet).getByLabelText('Big spend threshold');
    fireEvent.change(threshold, { target: { value: '1.25' } });
    fireEvent.blur(threshold);
    expect(studio.patch).toHaveBeenLastCalledWith([{ op: 'settings', patch: { bigSpendUsd: 1.25 } }]);

    const budget = within(sheet).getByLabelText('Budget cap');
    fireEvent.change(budget, { target: { value: '$10' } });
    fireEvent.keyDown(budget, { key: 'Enter' });
    expect(studio.patch).toHaveBeenLastCalledWith([{ op: 'settings', patch: { budgetUsd: 10 } }]);

    fireEvent.click(within(sheet).getByRole('radio', { name: /Drawn by the model/ }));
    expect(studio.patch).toHaveBeenLastCalledWith([{ op: 'format', patch: { lettering: 'in_art' } }]);

    fireEvent.click(within(sheet).getByRole('radio', { name: /Right → left/ }));
    expect(studio.patch).toHaveBeenLastCalledWith([{ op: 'format', patch: { readingDirection: 'rtl' } }]);

    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Comic settings' })).not.toBeInTheDocument();
  });

  it('clearing the budget cap sends a clear', () => {
    const studio = makeFakeStudio({ doc: makeSampleDoc({ settings: { quality: 'standard', confirm: 'big', bigSpendUsd: 0.5, budgetUsd: 8 } }) });
    mount(studio);
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Settings/ }));
    const budget = screen.getByLabelText('Budget cap');
    expect(budget).toHaveValue('8');
    fireEvent.change(budget, { target: { value: '' } });
    fireEvent.blur(budget);
    expect(studio.patch).toHaveBeenLastCalledWith([{ op: 'settings', patch: { budgetUsd: null } }]);
  });

  it('the split is keyboard-resizable and persisted', () => {
    mount(makeFakeStudio());
    const gutter = screen.getByRole('separator', { name: 'Resize conversation and board' });
    expect(gutter).toHaveAttribute('aria-valuenow', '40');
    fireEvent.keyDown(gutter, { key: 'ArrowRight' });
    expect(Number(gutter.getAttribute('aria-valuenow'))).toBeGreaterThan(40);
    expect(JSON.parse(window.localStorage.getItem(SPLIT_STORAGE_KEY) || '[]')[0]).toBeGreaterThan(40);
  });
});

describe('ComicStudio on narrow screens', () => {
  it('switches between chat and board with the composer docked, and points at renders with a pill', () => {
    state.wide = false;
    const doc = makeSampleDoc();
    doc.pages = doc.pages.map((p) => ({ ...p, render: { ...p.render, status: 'rendering' as const } }));
    const studio = makeFakeStudio({ doc });
    mount(studio);
    expect(screen.queryByTestId('board')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /3 pages rendering/ }));
    expect(studio.setTab).toHaveBeenCalledWith('pages');
    expect(screen.getByTestId('board')).toBeInTheDocument();
    expect(screen.getByLabelText('Message the Comic Director')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: /Chat/ }));
    expect(screen.queryByTestId('board')).not.toBeInTheDocument();
  });

  it('opening a page from a card reveals the board', () => {
    state.wide = false;
    const studio = makeFakeStudio({
      doc: makeSampleDoc({ conversation: [{ id: 'a1', role: 'assistant', text: 'Here is the plan', at: 1, cards: [{ type: 'plan', id: 'cp' }] }] })
    });
    mount(studio);
    fireEvent.click(screen.getByText(/^Page 2:/));
    expect(studio.openPage).toHaveBeenCalledWith('pg_2');
    expect(screen.getByTestId('board')).toBeInTheDocument();
  });
});
