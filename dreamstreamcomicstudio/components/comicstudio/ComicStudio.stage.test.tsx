// The stage strip in the studio shell (SH-A): from 768 px it sits under the header (the header itself is unchanged); on a
// phone it is the top of the board's scrolling panel, so it adds no fixed chrome. Every stage opens its board tab and
// reveals the board; the next step opens the board, brings the approval or the draft into view with focus on it (also on
// a desktop split where the chat already shows), focuses the composer, or opens the Share sheet. Nothing here spends:
// the fake studio's act and send are never called.
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { ComicStudioController } from './useStudio';
import { makeFakeStudio, resetUsageStatus, showDollarPrices } from './conversation/testing/fixtures';
import { createEmptyDoc, type ComicDoc, type Gate } from '../../shared/comic/doc';

vi.mock('./board/BoardPane', () => ({
  // The real pane puts `lead` at the top of its scrolling panel (BoardPane.tsx).
  BoardPane: ({ studio, lead }: { studio: ComicStudioController; lead?: React.ReactNode }) => (
    <div data-testid="board">
      {lead}Board · {studio.tab}
    </div>
  )
}));
vi.mock('./features', async (importOriginal) => ({ ...(await importOriginal<typeof import('./features')>()), registeredCard: () => undefined }));

import { ComicStudioShell } from './ComicStudio';
import { FormFactorProvider, formFactorFor } from './mobile/useFormFactor';
import { resetBackStack } from './mobile/backStack';
import type { FormFactor } from './mobile/formFactor';

const PHONE = formFactorFor({ w: 360, h: 740, coarse: true });
const DESK = formFactorFor({ w: 1280, h: 800 });

const mountAt = (ff: FormFactor, studio: ReturnType<typeof makeFakeStudio>) =>
  render(
    <FormFactorProvider value={ff}>
      <ComicStudioShell studio={studio} onBack={vi.fn()} />
    </FormFactorProvider>
  );

const strip = () => screen.getByRole('navigation', { name: 'Comic stages' });
const pane = (id: 'chat' | 'board') => document.querySelector(`[data-pane="${id}"]`) as HTMLElement;
const toBoard = () => fireEvent.click(within(screen.getByRole('navigation', { name: 'Studio views' })).getByRole('button', { name: /^Board/ }));

const gate = (id: string): Gate => ({ id, action: { type: 'render_style_options' }, title: 'Draw looks', summary: '', estimateUsd: 0.1, imageCount: 3, model: 'm', createdAt: 1, status: 'open', reason: 'policy' });
/** A story and an open approval, with its card in the conversation. */
const awaitingApproval = (): ComicDoc => {
  const doc = createEmptyDoc('c1', 'Night ferry', 1);
  doc.brief.premise = 'A ferry after midnight.';
  doc.gate = gate('g1');
  doc.conversation = [
    { id: 'm1', role: 'user', text: 'Show me three looks', at: 1 },
    { id: 'm2', role: 'assistant', text: 'Here is the estimate.', at: 2, cards: [{ type: 'gate', id: 'card_g1', gateId: 'g1' }] }
  ];
  return doc;
};

beforeEach(() => {
  window.localStorage.clear();
  resetBackStack();
  showDollarPrices();
});
afterEach(() => resetUsageStatus());

describe('the studio stage strip', () => {
  it('sits right under the header and its banners, outside the header, before the workspace', () => {
    mountAt(DESK, makeFakeStudio());
    const header = screen.getByRole('banner');
    expect(header.contains(strip())).toBe(false);
    expect(header.compareDocumentPosition(strip()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(strip().nextElementSibling?.id).toBe('studio-main');
  });

  it('on a phone it is the top of the board, not a fixed row: the conversation keeps its room', () => {
    mountAt(PHONE, makeFakeStudio());
    // Not under the header, and not in the conversation (whose activity line already reports drawing).
    expect(screen.queryByRole('navigation', { name: 'Comic stages' })).toBeNull();
    expect(document.getElementById('studio-main')?.previousElementSibling?.getAttribute('aria-label')).not.toBe('Comic stages');
    toBoard();
    expect(pane('board').contains(strip())).toBe(true);
    expect(pane('chat').contains(strip())).toBe(false);
  });

  it('on a phone, a stage opens its tab and shows the board', () => {
    const studio = makeFakeStudio();
    mountAt(PHONE, studio);
    toBoard();
    const stages = within(strip()).getByRole('button', { name: /^Stages:/ });
    fireEvent.click(stages);
    fireEvent.click(within(strip()).getByRole('button', { name: /^Style/ }));
    expect(studio.setTab).toHaveBeenLastCalledWith('style');
    expect(pane('board')).not.toHaveAttribute('inert');
    fireEvent.click(within(strip()).getByRole('button', { name: /^Stages:/ }));
    fireEvent.click(within(strip()).getByRole('button', { name: /^Publish/ }));
    expect(studio.setTab).toHaveBeenLastCalledWith('read');
    expect(studio.act).not.toHaveBeenCalled();
    expect(studio.send).not.toHaveBeenCalled();
  });

  it('on a phone, an approval waiting brings the chat back from the board and focuses the approval, approving nothing', () => {
    const studio = makeFakeStudio({ doc: awaitingApproval() });
    mountAt(PHONE, studio);
    toBoard();
    expect(pane('chat')).toHaveAttribute('inert');
    fireEvent.click(within(strip()).getByRole('button', { name: 'Style · Not chosen yet · Next: review the estimate' }));
    expect(pane('chat')).not.toHaveAttribute('inert');
    const card = within(pane('chat')).getByRole('region', { name: 'Spend approval' });
    expect(card).toHaveFocus();
    expect(studio.act).not.toHaveBeenCalled();
  });

  it('on a desktop split, where the chat already shows, the next step still brings the approval into view and focuses it', () => {
    const studio = makeFakeStudio({ doc: awaitingApproval() });
    mountAt(DESK, studio);
    const scrolled = vi.fn();
    const card = within(pane('chat')).getByRole('region', { name: 'Spend approval' });
    card.scrollIntoView = scrolled;
    const next = within(strip()).getByRole('button', { name: 'Next: review the estimate' });
    next.focus();
    fireEvent.click(next);
    expect(scrolled).toHaveBeenCalledTimes(1);
    expect(card).toHaveFocus();
    // Focus lands on the card, never on its Approve: one more Enter cannot spend.
    expect(document.activeElement?.tagName).toBe('SECTION');
    expect(studio.act).not.toHaveBeenCalled();
  });

  it('on a desktop split, "follow the Director" and "resume the draft" move focus to the draft’s own control', () => {
    for (const status of ['planning', 'interrupted'] as const) {
      const doc = createEmptyDoc('c1', 'Night ferry', 1);
      doc.brief.premise = 'A ferry after midnight.';
      doc.directorDraft = { status, idea: 'A ferry' };
      const studio = makeFakeStudio({ doc });
      const view = mountAt(DESK, studio);
      fireEvent.click(within(strip()).getByRole('button', { name: status === 'planning' ? 'Next: follow the Director' : 'Next: resume the draft' }));
      expect(screen.getByRole('button', { name: /^Drafting ·\s*Director-led$/ })).toHaveFocus();
      expect(studio.act).not.toHaveBeenCalled();
      view.unmount();
    }
  });

  it('a paused publication’s next step opens the Share sheet, which says why', () => {
    const doc = createEmptyDoc('c1', 'Night ferry', 1);
    doc.brief.premise = 'A ferry after midnight.';
    doc.style = { ...doc.style, status: 'drafted', spec: 'Ink' };
    doc.pages = [{ id: 'pg_1', n: 1, summary: '', layout: '', panels: [], render: { status: 'ready', history: [], asset: { path: 'u/p/a.webp', source: 'generated', at: 1 } }, balloons: [] }];
    doc.planStatus = 'approved';
    doc.publication = { visibility: 'unlisted', status: 'suspended', slug: 'night-ferry', publishedRev: 1, publishedAt: 2, languages: ['en'] };
    const studio = makeFakeStudio({ doc });
    mountAt(DESK, studio);
    fireEvent.click(within(strip()).getByRole('button', { name: 'Next: see why it is paused' }));
    expect(studio.runClientAction).toHaveBeenCalledWith({ type: 'open_share' });
    expect(studio.act).not.toHaveBeenCalled();
  });

  it('a new comic’s next step focuses the composer', () => {
    const studio = makeFakeStudio({ doc: createEmptyDoc('c0', 'Untitled comic', 1) });
    mountAt(DESK, studio);
    fireEvent.click(within(strip()).getByRole('button', { name: 'Next: tell the Director your idea' }));
    expect(screen.getByRole('textbox', { name: 'Message the Comic Director' })).toHaveFocus();
    expect(studio.send).not.toHaveBeenCalled();
  });

  it('the navigation’s list is labelled as the board it is, not as stages', () => {
    mountAt(DESK, makeFakeStudio());
    fireEvent.click(screen.getByRole('button', { name: 'Expand project navigation' }));
    const nav = screen.getByRole('navigation', { name: 'Project navigation' });
    expect(within(nav).queryByText('Project stages')).toBeNull();
    expect(within(nav).getByText('Board')).toBeInTheDocument();
    expect(within(nav).getByRole('tablist', { name: 'Board' })).toBeInTheDocument();
  });
});
