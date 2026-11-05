// Read tab → Share & export → "Pitch deck (.pptx)" (platform plan §12 W1.8). The entry is a shared-platform surface:
// it shows only when the build's kill switch is on (VITE_PLATFORM_DOCS 'on') AND the stage admits the viewer
// (PLATFORM_DOCS_STAGE 'admins' in wave 1: platformDocsVisible(useIsAdmin())). It sits with the other downloads,
// reports progress with a Cancel, and every failure reads as the export's own friendly sentence.
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { ComicDoc } from '../../../shared/comic/doc';
import { PLATFORM_DOCS_STAGE } from '../../../shared/platform/flags';
import { CANCELLED, ExportError } from '../export/errors';

const ex = vi.hoisted(() => ({ admin: false, adminCalls: 0, deck: vi.fn() }));
vi.mock('../../../hooks/useIsAdmin', () => ({
  useIsAdmin: () => {
    ex.adminCalls += 1;
    return ex.admin;
  }
}));
vi.mock('../export/pitchDeck', () => ({ exportComicPitchDeck: ex.deck }));

import { ReaderTab } from './ReaderTab';
import { SAMPLE_NOW, makeSampleDoc, makeStudio } from './__fixtures__/sampleDoc';

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(SAMPLE_NOW);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new TypeError('offline');
    })
  );
  ex.admin = false;
  ex.adminCalls = 0;
  ex.deck.mockReset();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const openSheet = () => {
  fireEvent.click(screen.getByRole('button', { name: 'Share & export' }));
  return screen.getByTestId('share-export-sheet');
};
const deckRow = (sheet: HTMLElement) => within(sheet).queryByRole('button', { name: /^Pitch deck \(\.pptx\)/ });

const renderTab = (doc: ComicDoc = makeSampleDoc()) => {
  const studio = makeStudio(doc);
  render(<ReaderTab studio={studio} doc={doc} />);
  return { doc, studio };
};

describe('ReaderTab: Pitch deck (.pptx)', () => {
  it('wave 1 stage is admins', () => {
    expect(PLATFORM_DOCS_STAGE).toBe('admins');
  });

  it('is hidden for a non-admin at stage admins, even with VITE_PLATFORM_DOCS on', () => {
    vi.stubEnv('VITE_PLATFORM_DOCS', 'on');
    ex.admin = false;
    renderTab();
    const sheet = openSheet();
    expect(within(sheet).getByRole('button', { name: /^PDF/ })).toBeInTheDocument();
    expect(deckRow(sheet)).toBeNull();
    expect(ex.adminCalls).toBeGreaterThan(0); // the stage asked who the viewer is
  });

  it('is hidden for everyone, admins too, with VITE_PLATFORM_DOCS unset or not exactly "on"', () => {
    for (const value of [undefined, '', 'off', 'ON']) {
      for (const admin of [true, false]) {
        vi.stubEnv('VITE_PLATFORM_DOCS', value);
        ex.admin = admin;
        const { unmount } = render(<ReaderTab studio={makeStudio(makeSampleDoc())} doc={makeSampleDoc()} />);
        expect(deckRow(openSheet())).toBeNull();
        unmount();
      }
    }
    // With the switch off nothing changes, not even the admin probe (/api/admin/me).
    expect(ex.adminCalls).toBe(0);
  });

  it('shows for an admin with the switch on, among the downloads, as a 44 px row; exports the source doc with the edition', async () => {
    vi.stubEnv('VITE_PLATFORM_DOCS', 'on');
    ex.admin = true;
    ex.deck.mockResolvedValue({ fileName: 'the-saffron-thief-pitch-deck.pptx', slides: 4, pages: 2, bytes: 1234, failed: [], skipped: ['Page 2 (not drawn yet)'] });
    const { doc, studio } = renderTab();
    const sheet = openSheet();
    const row = deckRow(sheet)!;
    expect(row).toBeInTheDocument();
    expect(row.className).toContain('min-h-[44px]');
    // It sits with the other downloads: after the PNG pages, before the motion comic.
    const buttons = within(sheet).getAllByRole('button');
    const at = (re: RegExp) => buttons.findIndex((b) => re.test(b.textContent || ''));
    expect(at(/^Pitch deck/)).toBeGreaterThan(at(/^PNG pages/));
    expect(at(/^Pitch deck/)).toBeLessThan(buttons.findIndex((b) => /Motion comic/.test(b.getAttribute('aria-label') || '')));

    fireEvent.click(row);
    const status = await screen.findByText(/Downloaded the-saffron-thief-pitch-deck\.pptx \(4 slides\)\./);
    expect(status).toHaveTextContent('Left out — Page 2 (not drawn yet).');
    const [passedDoc, urlFor, opts] = ex.deck.mock.calls[0] as [ComicDoc, unknown, { lang?: string; signal?: AbortSignal; onProgress?: unknown }];
    expect(passedDoc).toBe(doc);
    expect(urlFor).toBe(studio.urlFor);
    expect(opts.lang).toBe('en');
    expect(opts.signal).toBeInstanceOf(AbortSignal);
    expect(typeof opts.onProgress).toBe('function');
  });

  it('shows progress with a Cancel; Cancel stops the export and says so', async () => {
    vi.stubEnv('VITE_PLATFORM_DOCS', 'on');
    ex.admin = true;
    ex.deck.mockImplementation(
      (_doc: ComicDoc, _urlFor: unknown, opts: { signal: AbortSignal; onProgress: (p: { done: number; total: number; label: string }) => void }) =>
        new Promise((_resolve, reject) => {
          opts.onProgress({ done: 1, total: 4, label: 'Rendering page 1 (2 of 3)…' });
          opts.signal.addEventListener('abort', () => reject(new ExportError(CANCELLED)));
        })
    );
    renderTab();
    fireEvent.click(deckRow(openSheet())!);
    expect(await screen.findByText('Rendering page 1 (2 of 3)…')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(CANCELLED);
    expect((ex.deck.mock.calls[0][2] as { signal: AbortSignal }).signal.aborted).toBe(true);
  });

  it('a failure shows the friendly ExportError text (and any other error as a friendly sentence)', async () => {
    vi.stubEnv('VITE_PLATFORM_DOCS', 'on');
    ex.admin = true;
    ex.deck.mockRejectedValueOnce(new ExportError('This pitch deck would be over 40 MB (41 MB so far), too big to make safely on this device. Download the PDF instead.', 'too_big'));
    renderTab();
    fireEvent.click(deckRow(openSheet())!);
    expect(await screen.findByRole('alert')).toHaveTextContent('This pitch deck would be over 40 MB (41 MB so far), too big to make safely on this device. Download the PDF instead.');

    ex.deck.mockRejectedValueOnce(new TypeError('boom'));
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    fireEvent.click(deckRow(openSheet())!);
    expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong: boom');
  });
});
