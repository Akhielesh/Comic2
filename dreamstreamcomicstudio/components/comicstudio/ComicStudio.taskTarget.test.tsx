// A list's next step arriving in the studio (SH-B): My comics asks the studio to open at a place (a board tab, the
// conversation, or the Share sheet) and the shell does exactly that when the comic loads. It never starts a step: the
// fake studio's act and send are never called.
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import type { ComicStudioController } from './useStudio';
import { makeFakeStudio, resetUsageStatus, showDollarPrices } from './conversation/testing/fixtures';
import { createEmptyDoc } from '../../shared/comic/doc';

vi.mock('../../contexts/AuthContext', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../contexts/AuthContext')>()),
  useAuth: () => ({ user: { id: 'author-1' } })
}));
vi.mock('./board/BoardPane', () => ({
  BoardPane: ({ studio }: { studio: ComicStudioController }) => <div data-testid="board">Board · {studio.tab}</div>
}));
vi.mock('./features', async (importOriginal) => ({ ...(await importOriginal<typeof import('./features')>()), registeredCard: () => undefined }));

import { ComicStudioShell } from './ComicStudio';
import { FormFactorProvider, formFactorFor } from './mobile/useFormFactor';
import { resetBackStack } from './mobile/backStack';
import { requestTaskTarget } from './home/workspaceTaskTarget';

const PHONE = formFactorFor({ w: 360, h: 740, coarse: true });

const mount = (studio: ReturnType<typeof makeFakeStudio>) =>
  render(
    <FormFactorProvider value={PHONE}>
      <ComicStudioShell studio={studio} onBack={vi.fn()} />
    </FormFactorProvider>
  );
const pane = (id: 'chat' | 'board') => document.querySelector(`[data-pane="${id}"]`) as HTMLElement;

beforeEach(() => {
  window.localStorage.clear();
  resetBackStack();
  showDollarPrices();
});
afterEach(() => resetUsageStatus());

describe('a next step from My comics, arriving in the studio', () => {
  it('the Story tab: the board opens on it', () => {
    const studio = makeFakeStudio({ doc: createEmptyDoc('c1', 'Night ferry', 1) });
    requestTaskTarget('author-1', 'c1', 'story');
    mount(studio);
    expect(studio.setTab).toHaveBeenCalledWith('story');
    expect(pane('board')).not.toHaveAttribute('inert');
    expect(studio.act).not.toHaveBeenCalled();
  });

  it('the Share sheet ("Publish your changes", "See why it is paused")', () => {
    const studio = makeFakeStudio({ doc: createEmptyDoc('c1', 'Night ferry', 1) });
    requestTaskTarget('author-1', 'c1', 'share');
    mount(studio);
    expect(studio.runClientAction).toHaveBeenCalledWith({ type: 'open_share' });
    expect(studio.setTab).not.toHaveBeenCalledWith('share');
    expect(studio.act).not.toHaveBeenCalled();
  });

  it('the conversation (an approval, the Director’s draft, a question): the chat shows, nothing is approved or sent', () => {
    const studio = makeFakeStudio({ doc: createEmptyDoc('c1', 'Night ferry', 1) });
    requestTaskTarget('author-1', 'c1', 'conversation');
    mount(studio);
    expect(pane('chat')).not.toHaveAttribute('inert');
    expect(studio.act).not.toHaveBeenCalled();
    expect(studio.send).not.toHaveBeenCalled();
  });

  it('a target for another comic, or another account, is left alone', () => {
    const studio = makeFakeStudio({ doc: createEmptyDoc('c1', 'Night ferry', 1) });
    requestTaskTarget('someone-else', 'c1', 'story');
    mount(studio);
    expect(studio.setTab).not.toHaveBeenCalledWith('story');
  });
});
