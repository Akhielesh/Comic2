// Probes (publish-share-reader, Share sheet once a comic is live):
//  a. Once published, the sheet never shows the PublishPanel again (ShareSheet.tsx:187 `if (!live) return
//     setPublishAs(v)`; choosing the current visibility is a no-op at :183), so "Readers can download",
//     "Allow embedding", "Show my username" and the language list are one-shot at first publish. The only
//     other caller of updatePublication is the visibility flip; the director's update tool has no
//     embed/username argument (tools/publish.ts:199-206). Changing them later means unpublishing (new link).
//  b. "Update" (changes since publishing) republishes without the excluded page ids; when the gate blocks
//     the page again the sheet shows the 422 message but offers no "Publish without page N" — the owner is
//     stuck (the PublishCard in the conversation does offer it on failure; the sheet does not).
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PublicationOwnerView } from '../../shared/comic/publication';
import { makeFakeStudio, makeSampleDoc } from '../../components/comicstudio/conversation/testing/fixtures';
import { ShareSheet } from '../../components/comicstudio/share/ShareSheet';

vi.mock('../../components/comicstudio/studioApi', async (orig) => {
  const mod = await orig<typeof import('../../components/comicstudio/studioApi')>();
  return { ...mod, publishComic: vi.fn(), updatePublication: vi.fn(), unpublishComic: vi.fn(), regeneratePublicationLink: vi.fn() };
});
import * as api from '../../components/comicstudio/studioApi';

const SLUG = 'Ab3dEf6hIj9kLm2nP';
const view = (over: Partial<PublicationOwnerView> = {}): PublicationOwnerView => ({
  visibility: 'unlisted',
  status: 'live',
  slug: SLUG,
  url: `https://comics.dreamstreamstudio.ai/c/${SLUG}`,
  languages: ['en'],
  defaultLang: 'en',
  allowDownload: true,
  allowEmbed: true,
  showCreator: false,
  publishedRev: 4,
  docRev: 4,
  behind: false,
  readiness: { ok: true, drawnPages: 3, plannedPages: 3, missing: [], stalePages: [], safety: { status: 'cleared', blockedPages: [], reasons: [] }, languages: [{ lang: 'en', publishable: true, blocking: [] }] },
  ...over
});

const setViewport = () => {
  window.matchMedia = ((q: string) => ({
    matches: q.includes('min-width: 1024px'),
    media: q,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    onchange: null,
    dispatchEvent: () => false
  })) as unknown as typeof window.matchMedia;
};

const studioWith = (v: PublicationOwnerView) => {
  const doc = makeSampleDoc();
  doc.publication = { visibility: v.visibility as 'unlisted', status: 'live', slug: v.slug, publishedRev: 4, publishedAt: 1, languages: ['en'] };
  return makeFakeStudio({ doc, publication: v });
};

beforeEach(() => setViewport());
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('Share sheet after publishing', () => {
  it('still lets the owner change downloads / embedding / username (the settings the server accepts in PATCH)', () => {
    render(<ShareSheet studio={studioWith(view())} open onClose={vi.fn()} />);
    // Nothing to tap: the sheet has no PublishPanel and no settings toggles once live.
    expect(screen.queryByRole('checkbox', { name: /Readers can download/ })).not.toBeNull();
    expect(screen.queryByRole('checkbox', { name: /Allow embedding/ })).not.toBeNull();
    expect(screen.queryByRole('checkbox', { name: /Show my username/ })).not.toBeNull();
  });

  it('"Update" refused as SAFETY_BLOCKED (the consented exclusion was not resent) offers "Publish without page N"', async () => {
    const blocked = view({
      behind: true,
      readiness: { ok: false, drawnPages: 3, plannedPages: 3, missing: [], stalePages: [], safety: { status: 'blocked', blockedPages: [3], reasons: ['violence'] }, languages: [{ lang: 'en', publishable: true, blocking: [] }] }
    });
    // The server's 422 for ShareSheet.updateNow's request (publication.ts interpretGate).
    (api.publishComic as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("Page 3 doesn't fit the content rules. Publish without it, or redraw it first."));
    render(<ShareSheet studio={studioWith(blocked)} open onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Update' }));
    await waitFor(() => expect(api.publishComic).toHaveBeenCalled());
    const [, request] = (api.publishComic as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, Record<string, unknown>];
    expect(request).not.toHaveProperty('excludePageIds');
    expect(await screen.findByRole('alert')).toHaveTextContent(/Page 3 doesn't fit/);
    // The honest next step the PublishPanel / PublishCard offer:
    expect(screen.queryByRole('button', { name: /Publish without page 3/ })).not.toBeNull();
  });
});
