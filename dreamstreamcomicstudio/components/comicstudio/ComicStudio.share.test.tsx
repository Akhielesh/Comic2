// One Share sheet, wherever the request comes from (the shell with the real useStudio, the real header Share slot and the
// real Read tab): My comics' "Publish your changes" / "See why it is paused" (task target 'share'), the strip's next step,
// and the Director's "Update the published version" chip all send `open_share`. The header's Share button answers it, so
// the Read tab never opens a second sheet over the first. Synthetic doc; the studio API is faked, nothing is sent.
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { normalizeDoc } from '../../shared/comic/doc';
import { makeSampleDoc } from './board/__fixtures__/sampleDoc';
import { resetUsageStatus, showDollarPrices } from './conversation/testing/fixtures';

const api = vi.hoisted(() => ({
  loadStudioProject: vi.fn(),
  streamStudio: vi.fn(async () => undefined),
  signStudioUrls: vi.fn(async () => ({})),
  cancelStudio: vi.fn(async () => undefined),
  uploadStudioRef: vi.fn(),
  getPublication: vi.fn(async () => null)
}));
vi.mock('./studioApi', async (importOriginal) => ({ ...(await importOriginal<typeof import('./studioApi')>()), ...api }));
vi.mock('../../contexts/AuthContext', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../contexts/AuthContext')>()),
  useAuth: () => ({ user: { id: 'author-1' } })
}));
// The board shows only its Read tab (the one that owns the second Share sheet); every other tab is a stand-in.
vi.mock('./board/BoardPane', async () => {
  const { ReaderTab } = await import('./board/ReaderTab');
  return {
    BoardPane: ({ studio }: { studio: import('./useStudio').ComicStudioController }) =>
      studio.tab === 'read' && studio.doc ? <ReaderTab studio={studio} doc={studio.doc} /> : <div data-testid="board">Board · {studio.tab}</div>
  };
});

import { useStudio } from './useStudio';
import { ComicStudioShell } from './ComicStudio';
import { FormFactorProvider, formFactorFor } from './mobile/useFormFactor';
import { resetBackStack } from './mobile/backStack';
import { requestTaskTarget } from './home/workspaceTaskTarget';

const DESK = formFactorFor({ w: 1280, h: 800 });
const PHONE = formFactorFor({ w: 360, h: 740, coarse: true });

/** A comic with a live, unlisted publication and a page drawn after it (the strip's "Publish your changes"). */
const publishedDoc = () =>
  normalizeDoc(
    makeSampleDoc((d) => {
      d.publication = { visibility: 'unlisted', status: 'live', slug: 'Ab3dEf6hIj9kLm2nOp5q', publishedRev: 1, publishedAt: 1, languages: ['en'] };
    })
  );

let studioRef: ReturnType<typeof useStudio> | null = null;
function Harness() {
  const studio = useStudio('proj_1');
  studioRef = studio;
  return <ComicStudioShell studio={studio} onBack={() => undefined} />;
}

const mount = async (ff = DESK) => {
  const doc = publishedDoc();
  api.loadStudioProject.mockImplementation(async () => ({ doc: { ...doc, id: 'proj_1' }, urls: {} }));
  const utils = render(
    <FormFactorProvider value={ff}>
      <Harness />
    </FormFactorProvider>
  );
  await waitFor(() => expect(studioRef?.doc).not.toBeNull());
  return utils;
};

const shareSheets = () => screen.queryAllByRole('dialog', { name: /^Share/ });

beforeEach(() => {
  window.localStorage.clear();
  resetBackStack();
  showDollarPrices();
  studioRef = null;
});
afterEach(() => resetUsageStatus());

describe('open_share opens exactly one Share sheet', () => {
  it('My comics’ next step (task target "share"): the header’s sheet, and the Read tab stays closed', async () => {
    requestTaskTarget('author-1', 'proj_1', 'share');
    await mount();
    await waitFor(() => expect(shareSheets()).toHaveLength(1));
    // The board stays where it was: the Read tab (and its own Share sheet) never opened.
    expect(studioRef?.tab).not.toBe('read');
    expect(studioRef?.readerRequest ?? null).toBeNull();
  });

  it('on a phone too (the compact header carries the same Share button)', async () => {
    requestTaskTarget('author-1', 'proj_1', 'share');
    await mount(PHONE);
    await waitFor(() => expect(shareSheets()).toHaveLength(1));
  });

  it('the Director’s "Update the published version" chip, and the strip’s next step, open one sheet each time', async () => {
    await mount();
    // The header's Share button is what answers the request. Wait for it: fired before it is on screen, the request
    // rightly falls back to the Read tab's own sheet (a separate chunk), which is not what this test is about.
    await screen.findByRole('button', { name: /^Share \(/ }, { timeout: 5_000 });
    expect(shareSheets()).toHaveLength(0);
    act(() => studioRef!.runClientAction({ type: 'open_share' }));
    await waitFor(() => expect(shareSheets()).toHaveLength(1), { timeout: 5_000 });
    // Closed once, it is gone: no second sheet waits under it.
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    await waitFor(() => expect(shareSheets()).toHaveLength(0), { timeout: 5_000 });
    act(() => studioRef!.runClientAction({ type: 'open_share' }));
    await waitFor(() => expect(shareSheets()).toHaveLength(1), { timeout: 5_000 });
    // Both times the header's sheet answered: the board never moved to the Read tab.
    expect(studioRef?.tab).not.toBe('read');
  });
});
