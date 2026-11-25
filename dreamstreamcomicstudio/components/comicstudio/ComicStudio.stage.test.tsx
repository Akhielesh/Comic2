// The stage strip in the studio shell (SH-A): it sits under the header (the header itself is unchanged), every stage
// opens its board tab and reveals the board, and the next step opens the board, the conversation or the composer.
// Nothing here spends: the fake studio's act and send are never called.
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { ComicStudioController } from './useStudio';
import { makeFakeStudio, resetUsageStatus, showDollarPrices } from './conversation/testing/fixtures';
import { createEmptyDoc } from '../../shared/comic/doc';

vi.mock('./board/BoardPane', () => ({
  BoardPane: ({ studio }: { studio: ComicStudioController }) => <div data-testid="board">Board · {studio.tab}</div>
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

  it('on a phone, a stage opens its tab and shows the board; the next step can bring the chat back', () => {
    const studio = makeFakeStudio();
    mountAt(PHONE, studio);
    expect(pane('board')).toHaveAttribute('inert');
    fireEvent.click(within(strip()).getByRole('button', { name: /^Style/ }));
    expect(studio.setTab).toHaveBeenLastCalledWith('style');
    expect(pane('board')).not.toHaveAttribute('inert');
    fireEvent.click(within(strip()).getByRole('button', { name: /^Publish/ }));
    expect(studio.setTab).toHaveBeenLastCalledWith('read');
    expect(studio.act).not.toHaveBeenCalled();
    expect(studio.send).not.toHaveBeenCalled();
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
