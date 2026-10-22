import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ComicStudioController } from './useStudio';
import { makeFakeStudio, makeSampleDoc, type FakeStudio } from './conversation/testing/fixtures';

const state = vi.hoisted(() => ({ studio: null as unknown as ComicStudioController, wide: true }));

vi.mock('./useStudio', () => ({ useStudio: () => state.studio }));
vi.mock('./board/BoardPane', () => ({
  BoardPane: ({ studio }: { studio: ComicStudioController }) => <div data-testid="board">Board · {studio.tab}</div>
}));
vi.mock('../studio/kit/useMediaQuery', () => ({ useIsWide: () => state.wide, useMediaQuery: () => state.wide }));
// Feature cards render through their own packages; the shell tests use the built-in fallbacks
// (e.g. the plan card's page list) so they only exercise the shell.
vi.mock('./features', async (importOriginal) => ({ ...(await importOriginal<typeof import('./features')>()), registeredCard: () => undefined }));
vi.mock('./immersive/ImmersiveReader', () => ({
  ImmersiveReader: ({ onExit, intro }: { onExit: () => void; intro: boolean }) => (
    <div role="dialog" aria-label="Full-screen reader" data-intro={String(intro)}>
      <button type="button" onClick={onExit}>
        Close reader
      </button>
    </div>
  )
}));

import { ComicStudio, ComicStudioShell, SPLIT_STORAGE_KEY } from './ComicStudio';
import { FormFactorProvider, formFactorFor } from './mobile/useFormFactor';
import { resetBackStack } from './mobile/backStack';
import type { FormFactor } from './mobile/formFactor';

const mount = (studio: FakeStudio, onBack = vi.fn()) => {
  state.studio = studio;
  const utils = render(<ComicStudio projectId="proj_1" onBack={onBack} />);
  return { ...utils, onBack };
};

const PHONE = formFactorFor({ w: 390, h: 844, coarse: true });
const FOLD_COVER = formFactorFor({ w: 344, h: 882, coarse: true });
const PHONE_LANDSCAPE = formFactorFor({ w: 852, h: 393, coarse: true });
const IPAD_PORTRAIT = formFactorFor({ w: 820, h: 1180, coarse: true });

/** Mount the shell under a pinned form factor (the QA harness does the same). */
const mountAt = (ff: FormFactor, studio: FakeStudio, onBack = vi.fn()) => {
  const ui = (s: FakeStudio) => (
    <FormFactorProvider value={ff}>
      <ComicStudioShell studio={s} onBack={onBack} />
    </FormFactorProvider>
  );
  const utils = render(ui(studio));
  return { ...utils, onBack, rerenderWith: (s: FakeStudio) => utils.rerender(ui(s)) };
};

const pane = (id: 'chat' | 'board') => document.querySelector(`[data-pane="${id}"]`) as HTMLElement;

beforeEach(() => {
  state.wide = true;
  window.localStorage.clear();
  resetBackStack();
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

describe('ComicStudio on phones (single)', () => {
  it('keeps both panes mounted and switches with the bottom tab bar; the hidden pane is inert', () => {
    const studio = makeFakeStudio();
    mountAt(PHONE, studio);
    expect(document.querySelector('[data-layout="single"]')).not.toBeNull();
    const nav = screen.getByRole('navigation', { name: 'Studio views' });
    expect(within(nav).getByRole('button', { name: /^Chat/ })).toHaveAttribute('aria-current', 'page');
    // The board is mounted but hidden + inert (scroll and drafts survive a switch).
    expect(screen.getByTestId('board')).toBeInTheDocument();
    expect(pane('board')).toHaveAttribute('hidden');
    expect(pane('board')).toHaveAttribute('inert');
    fireEvent.click(within(nav).getByRole('button', { name: /^Board/ }));
    expect(pane('board')).not.toHaveAttribute('hidden');
    expect(pane('chat')).toHaveAttribute('inert');
    expect(within(nav).getByRole('button', { name: /^Board/ })).toHaveAttribute('aria-current', 'page');
    // The composer draft lives on in the hidden chat pane.
    expect(screen.getByLabelText('Message the Comic Director')).toBeInTheDocument();
  });

  it('the Board tab announces page progress; the pill points at renders and switches to the board', () => {
    const doc = makeSampleDoc();
    doc.pages = doc.pages.map((p) => ({ ...p, render: { ...p.render, status: 'rendering' as const } }));
    const studio = makeFakeStudio({ doc });
    mountAt(PHONE, studio);
    const nav = screen.getByRole('navigation', { name: 'Studio views' });
    expect(within(nav).getByRole('button', { name: /^Board, 0 of 3 pages ready, drawing/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /3 pages rendering/ }));
    expect(studio.setTab).toHaveBeenCalledWith('pages');
    expect(pane('board')).not.toHaveAttribute('hidden');
  });

  it('opening a page from a card reveals the board', () => {
    const studio = makeFakeStudio({
      doc: makeSampleDoc({ conversation: [{ id: 'a1', role: 'assistant', text: 'Here is the plan', at: 1, cards: [{ type: 'plan', id: 'cp' }] }] })
    });
    mountAt(PHONE, studio);
    fireEvent.click(screen.getByText(/^Page 2:/));
    expect(studio.openPage).toHaveBeenCalledWith('pg_2');
    expect(pane('board')).not.toHaveAttribute('hidden');
  });

  it('a reply that lands while the board is showing puts a dot on Chat; an open gate shows amber', () => {
    const studio = makeFakeStudio();
    const { rerenderWith } = mountAt(PHONE, studio);
    const nav = screen.getByRole('navigation', { name: 'Studio views' });
    fireEvent.click(within(nav).getByRole('button', { name: /^Board/ }));
    expect(within(nav).getByRole('button', { name: /^Chat$/ })).toBeInTheDocument();
    const replied = makeFakeStudio({ doc: makeSampleDoc({ conversation: [{ id: 'a9', role: 'assistant', text: 'Done — page 2 is moodier.', at: 2 }] }) });
    rerenderWith(replied);
    expect(within(nav).getByRole('button', { name: 'Chat, new reply' })).toBeInTheDocument();
    fireEvent.click(within(nav).getByRole('button', { name: 'Chat, new reply' }));
    expect(within(nav).getByRole('button', { name: /^Chat$/ })).toBeInTheDocument();

    const gated = makeSampleDoc({ conversation: replied.doc!.conversation });
    gated.gate = { id: 'g1', status: 'open', title: 'Draw 3 pages', estimateUsd: 0.4, imageCount: 3, model: 'nano-banana-2.1', at: 3 } as never;
    rerenderWith(makeFakeStudio({ doc: gated }));
    expect(within(nav).getByRole('button', { name: 'Chat, waiting for your approval' })).toBeInTheDocument();
  });

  it('the phone header keeps Back · title · $ · ⋯ and moves quality, spending, Read and Easy/Pro into ⋯', () => {
    const studio = makeFakeStudio();
    mountAt(PHONE, studio);
    const header = screen.getByRole('banner');
    expect(within(header).queryByTitle('Quality')).toBeNull();
    expect(within(header).queryByRole('button', { name: 'Read the comic' })).toBeNull();
    expect(within(header).getByRole('button', { name: /^Spent / })).toBeInTheDocument();
    fireEvent.click(within(header).getByRole('button', { name: 'More' }));
    const menu = screen.getByRole('menu', { name: 'More' });
    for (const name of [/Quality/, /Spending/, /Read the comic/, /Settings/, /Resync/]) expect(within(menu).getByRole('menuitem', { name })).toBeInTheDocument();
    // On phones the ⋯ menu is a bottom sheet with the Easy/Pro view on top.
    expect(document.querySelector('[data-sheet="bottom"]')).not.toBeNull();
    fireEvent.click(screen.getByRole('radio', { name: 'Pro' }));
    expect(studio.setMode).toHaveBeenCalledWith('pro');
    fireEvent.click(within(menu).getByRole('menuitem', { name: /Quality/ }));
    expect(screen.getByRole('dialog', { name: 'Quality' })).toHaveAttribute('data-sheet', 'bottom');
  });

  it('Read opens the full-screen reader as a layer and the back gesture closes it', async () => {
    const studio = makeFakeStudio();
    mountAt(PHONE, studio);
    const nav = screen.getByRole('navigation', { name: 'Studio views' });
    fireEvent.click(within(nav).getByRole('button', { name: /^Read/ }));
    const reader = await screen.findByRole('dialog', { name: 'Full-screen reader' });
    expect(reader).toHaveAttribute('data-intro', 'true');
    expect(studio.setTab).not.toHaveBeenCalledWith('read');
    // Android back / browser back: the history entry pops and the reader closes first.
    await act(async () => {
      window.history.back();
      await new Promise((r) => setTimeout(r, 30));
    });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Full-screen reader' })).toBeNull());
  });

  it('Read stays unavailable until a page is drawn (and says why)', () => {
    const doc = makeSampleDoc();
    doc.pages = doc.pages.map((p) => ({ ...p, render: { ...p.render, status: 'none' as const, asset: undefined } }));
    mountAt(PHONE, makeFakeStudio({ doc }));
    const read = within(screen.getByRole('navigation', { name: 'Studio views' })).getByRole('button', { name: /^Read/ });
    expect(read).toBeDisabled();
    expect(read).toHaveAccessibleName(/Read opens once a page is drawn/);
  });

  it('"Ask the Director…" on the board opens a composer sheet that closes after sending', () => {
    const studio = makeFakeStudio();
    mountAt(PHONE, studio);
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Studio views' })).getByRole('button', { name: /^Board/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Ask the Director…' }));
    const sheet = screen.getByRole('dialog', { name: 'Ask the Director' });
    const box = within(sheet).getByLabelText('Message the Comic Director');
    expect(document.activeElement).toBe(box);
    fireEvent.change(box, { target: { value: 'Make page 2 moodier' } });
    // Touch: Enter is a newline; the Send button sends.
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(studio.send).not.toHaveBeenCalled();
    fireEvent.click(within(sheet).getByRole('button', { name: 'Send' }));
    expect(studio.send).toHaveBeenCalledWith('Make page 2 moodier', []);
    expect(screen.queryByRole('dialog', { name: 'Ask the Director' })).toBeNull();
  });

  it('settings open as a bottom sheet on phones', () => {
    mountAt(PHONE, makeFakeStudio());
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Settings/ }));
    expect(screen.getByRole('dialog', { name: 'Comic settings' })).toHaveAttribute('data-sheet', 'bottom');
  });

  it('below 360 px the spend chip moves into the ⋯ menu so the title keeps its room', () => {
    mountAt(FOLD_COVER, makeFakeStudio());
    const header = screen.getByRole('banner');
    expect(within(header).queryByRole('button', { name: /^Spent / })).toBeNull();
    fireEvent.click(within(header).getByRole('button', { name: 'More' }));
    expect(screen.getByRole('menuitem', { name: /Spending/ })).toBeInTheDocument();
  });
});

describe('ComicStudio on other form factors', () => {
  it('phone landscape uses a navigation rail that carries Back (the header drops it)', () => {
    const { onBack } = mountAt(PHONE_LANDSCAPE, makeFakeStudio());
    expect(document.querySelector('[data-layout="single-rail"]')).not.toBeNull();
    expect(within(screen.getByRole('banner')).queryByRole('button', { name: 'Back to your projects' })).toBeNull();
    const rail = screen.getByRole('navigation', { name: 'Studio views' });
    fireEvent.click(within(rail).getByRole('button', { name: 'Back to your projects' }));
    expect(onBack).toHaveBeenCalled();
  });

  it('touch tablets split from 720 px with a Chat | Both | Board switcher remembered per window class', () => {
    mountAt(IPAD_PORTRAIT, makeFakeStudio());
    expect(document.querySelector('[data-layout="split"]')).not.toBeNull();
    expect(screen.queryByRole('navigation', { name: 'Studio views' })).toBeNull();
    const panes = screen.getByRole('radiogroup', { name: 'Panes' });
    fireEvent.click(within(panes).getByRole('radio', { name: 'Board only' }));
    expect(pane('chat')).toHaveAttribute('inert');
    expect(window.localStorage.getItem('cs.split.mode.medium')).toBe('board');
    // The touch gutter is gone while one pane is shown; back to both brings it back.
    expect(screen.queryByRole('separator')).toBeNull();
    fireEvent.click(within(panes).getByRole('radio', { name: 'Chat and board' }));
    expect(screen.getByRole('separator', { name: 'Resize conversation and board' })).toBeInTheDocument();
  });

  it('a foldable spanning two segments puts chat and board each in their own segment', () => {
    const rect = (x: number, w: number) => ({ left: x, top: 0, width: w, height: 1000, right: x + w, bottom: 1000, x, y: 0, toJSON: () => ({}) }) as DOMRectReadOnly;
    const ff = formFactorFor({
      w: 1100,
      h: 1000,
      coarse: true,
      segments: { count: 2, axis: 'horizontal', rects: [rect(0, 540), rect(560, 540)], hinge: { start: 540, end: 560 } }
    });
    mountAt(ff, makeFakeStudio());
    expect(document.querySelector('[data-layout="dual-screen"]')).not.toBeNull();
    expect(document.querySelector('[data-segment="0"] [data-pane="chat"]')).not.toBeNull();
    expect(document.querySelector('[data-segment="1"] [data-pane="board"]')).not.toBeNull();
    expect((document.querySelector('[data-hinge]') as HTMLElement).style.width).toBe('20px');
  });

  it('desktop keeps the classic header: quality, spend, Read and no pane switcher', () => {
    mountAt(formFactorFor({ w: 1440, h: 900 }), makeFakeStudio());
    const header = screen.getByRole('banner');
    expect(within(header).getByTitle('Quality')).toHaveTextContent('Standard');
    expect(within(header).getByRole('button', { name: 'Read the comic' })).toHaveTextContent('Read');
    expect(within(header).queryByRole('radiogroup', { name: 'Panes' })).toBeNull();
    expect(screen.getByRole('main')).toHaveAttribute('id', 'studio-main');
  });
});
