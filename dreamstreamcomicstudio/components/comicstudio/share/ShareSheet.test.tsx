// Share sheet, link card, QR and the share model (sharing.md §11 #32).
import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PublicationOwnerView } from '../../../shared/comic/publication';
import { makeFakeStudio, makeSampleDoc } from '../conversation/testing/fixtures';
import { qrMatrix, QrCode } from './QrCode';
import { ShareSheet, sheetLayout } from './ShareSheet';
import { ShareButton } from './ShareButton';
import { embedSnippet, fileNameFor, intentUrl, isInAppBrowser, middleEllipsis, shareLinkFor, statusLine } from './shareModel';
import { ShareLinkCard } from './ShareLinkCard';
import { encode } from 'uqr';

vi.mock('../studioApi', async (orig) => {
  const mod = await orig<typeof import('../studioApi')>();
  return { ...mod, publishComic: vi.fn(), updatePublication: vi.fn(), unpublishComic: vi.fn(), regeneratePublicationLink: vi.fn() };
});
import * as api from '../studioApi';

const SLUG = 'Ab3dEf6hIj9kLm2nP';
const view = (over: Partial<PublicationOwnerView> = {}): PublicationOwnerView => ({
  visibility: 'unlisted',
  status: 'live',
  slug: SLUG,
  url: `https://comics.dreamstreamstudio.ai/c/${SLUG}`,
  ogImageUrl: `https://comics.dreamstreamstudio.ai/og/K1234567890abcdefghijk/og-en-0123456789ab.jpg`,
  languages: ['en'],
  defaultLang: 'en',
  allowDownload: true,
  allowEmbed: true,
  showCreator: false,
  publishedRev: 4,
  docRev: 4,
  behind: false,
  readiness: { ok: true, drawnPages: 1, plannedPages: 3, missing: [], stalePages: [], safety: { status: 'cleared', blockedPages: [], reasons: [] }, languages: [{ lang: 'en', publishable: true, blocking: [] }] },
  stats: { views: 12, uniques7d: 5, completes7d: 2, byChannel7d: { whatsapp: 4, direct: 1 }, daily: [{ day: '2026-10-20', views: 3 }, { day: '2026-10-21', views: 9 }] },
  ...over
});

const setViewport = (maxWidth639: boolean, shortLandscape = false) => {
  window.matchMedia = ((q: string) => ({
    matches: q.includes('max-width: 639px') ? maxWidth639 : q.includes('max-height: 480px') ? shortLandscape : q.includes('min-width: 1024px') ? !maxWidth639 : false,
    media: q,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    onchange: null,
    dispatchEvent: () => false
  })) as unknown as typeof window.matchMedia;
};

const studioWith = (v: PublicationOwnerView | null) => {
  const doc = makeSampleDoc();
  if (v?.slug) doc.publication = { visibility: v.visibility as 'unlisted', status: 'live', slug: v.slug, publishedRev: 4, publishedAt: 1, languages: ['en'] };
  return makeFakeStudio({ doc, publication: v });
};

beforeEach(() => setViewport(false));
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('ShareSheet', () => {
  it('Copy writes the clipboard (with ?via=copy) and announces it', async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText }, userAgent: 'test' });
    render(<ShareSheet studio={studioWith(view())} open onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /^Copy$/ }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(`https://comics.dreamstreamstudio.ai/c/${SLUG}?via=copy`));
    expect(await screen.findByText('Link copied')).toBeInTheDocument();
  });

  it('Share… uses navigator.share({title,text,url}); without it the fallback lists encoded intents', async () => {
    const share = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', { ...navigator, share, userAgent: 'test' });
    const { unmount } = render(<ShareSheet studio={studioWith(view())} open onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /Share…/ }));
    await waitFor(() => expect(share).toHaveBeenCalledWith(expect.objectContaining({ title: expect.any(String), url: `https://comics.dreamstreamstudio.ai/c/${SLUG}?via=native` })));
    unmount();
    vi.stubGlobal('navigator', { ...navigator, share: undefined, userAgent: 'test' });
    render(<ShareSheet studio={studioWith(view())} open onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /Share…/ }));
    const wa = await screen.findByRole('link', { name: 'WhatsApp' });
    expect(wa.getAttribute('href')).toMatch(/^https:\/\/wa\.me\/\?text=/);
    expect(wa.getAttribute('href')).toContain(encodeURIComponent(`https://comics.dreamstreamstudio.ai/c/${SLUG}?via=whatsapp`));
    expect(wa.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('phone → bottom sheet with a drag handle; wide → centred dialog; Esc closes and focus returns to the trigger', async () => {
    setViewport(true);
    const studio = studioWith(view());
    const { unmount } = render(<ShareSheet studio={studio} open onClose={vi.fn()} />);
    expect(screen.getByRole('dialog')).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByTestId('share-drag-handle')).toBeInTheDocument();
    expect(document.querySelector('[data-share-layout="bottom"]')).not.toBeNull();
    unmount();
    setViewport(false);
    expect(sheetLayout()).toBe('wide');
    render(<ShareButton studio={studio} />);
    const trigger = screen.getByRole('button', { name: /Share \(Link only\)/ });
    trigger.focus();
    fireEvent.click(trigger);
    expect(screen.queryByTestId('share-drag-handle')).toBeNull();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(trigger);
  });

  it('short landscape phones get a side sheet', () => {
    setViewport(true, true);
    expect(sheetLayout()).toBe('side');
  });

  it('private comic: choosing "Link only" opens the publish panel; Publish posts the request and refreshes', async () => {
    const studio = studioWith(view({ visibility: 'private', status: null, slug: undefined, url: undefined, stats: undefined }));
    vi.mocked(api.publishComic).mockResolvedValue(view());
    render(<ShareSheet studio={studio} open onClose={vi.fn()} />);
    expect(screen.getByText(/Only you can see this comic/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: 'Link only' }));
    expect(screen.getByRole('checkbox', { name: /Readers can download/ })).toBeChecked(); // addendum default
    fireEvent.click(screen.getByRole('button', { name: 'Publish' }));
    await waitFor(() => expect(api.publishComic).toHaveBeenCalledWith(studio.doc!.id, expect.objectContaining({ visibility: 'unlisted', allowDownload: true, showCreator: false })));
    await waitFor(() => expect(studio.refresh).toHaveBeenCalled());
  });

  it('a refused publish shows the honest server message', async () => {
    const studio = studioWith(view({ visibility: 'private', status: null, slug: undefined, url: undefined }));
    vi.mocked(api.publishComic).mockRejectedValue(new Error("Safety checks are unavailable right now, so nothing was published — your comic stays private."));
    render(<ShareSheet studio={studio} open onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('radio', { name: 'Library + link' }));
    fireEvent.click(screen.getByRole('button', { name: 'Publish' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Safety checks are unavailable');
  });

  it('a refusal with no words of its own says so in the house style (typographic apostrophe)', async () => {
    const studio = studioWith(view({ visibility: 'private', status: null, slug: undefined, url: undefined }));
    vi.mocked(api.publishComic).mockRejectedValue(new Error(''));
    render(<ShareSheet studio={studio} open onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('radio', { name: 'Link only' }));
    fireEvent.click(screen.getByRole('button', { name: 'Publish' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('That didn’t work. Nothing changed — try again.');
  });

  it('Private on a live link asks first, then unpublishes; "Get a new link" confirms too', async () => {
    const studio = studioWith(view());
    vi.mocked(api.unpublishComic).mockResolvedValue(view({ visibility: 'private', status: 'unpublished', slug: undefined }));
    vi.mocked(api.regeneratePublicationLink).mockResolvedValue(view({ slug: 'Zz3dEf6hIj9kLm2nP' }));
    render(<ShareSheet studio={studio} open onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('radio', { name: 'Private' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Unpublish?' });
    expect(api.unpublishComic).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Unpublish' }));
    await waitFor(() => expect(api.unpublishComic).toHaveBeenCalledWith(studio.doc!.id));
    fireEvent.click(screen.getByRole('button', { name: /Get a new link/ }));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Get new link' }));
    await waitFor(() => expect(api.regeneratePublicationLink).toHaveBeenCalled());
  });

  it('listing a live Link only comic in the Library asks first; "Keep it link only" changes nothing', async () => {
    const studio = studioWith(view());
    vi.mocked(api.updatePublication).mockResolvedValue(view({ visibility: 'public' }));
    render(<ShareSheet studio={studio} open onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('radio', { name: 'Library + link' }));
    const dialog = screen.getByRole('alertdialog', { name: 'List it in the Library?' });
    // Focus lands on the safe choice so the question is announced.
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Keep it link only' }));
    expect(api.updatePublication).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep it link only' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(api.updatePublication).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('radio', { name: 'Library + link' }));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'List it in the Library' }));
    await waitFor(() => expect(api.updatePublication).toHaveBeenCalledWith(studio.doc!.id, { visibility: 'public' }));
  });

  it('a parent re-render with a new inline onClose never moves focus out of the field the user is in', async () => {
    const studio = studioWith(view());
    const { rerender } = render(<ShareSheet studio={studio} open onClose={() => undefined} />);
    await act(async () => new Promise((r) => setTimeout(r, 5)));
    const field = screen.getByLabelText('Read-only link');
    field.focus();
    expect(document.activeElement).toBe(field);
    rerender(<ShareSheet studio={studio} open onClose={() => undefined} />);
    await act(async () => new Promise((r) => setTimeout(r, 5)));
    expect(document.activeElement).toBe(field);
  });

  it('shows the preview mock, stats, embed (only when allowed) and an update banner when behind', () => {
    const { unmount } = render(<ShareSheet studio={studioWith(view({ behind: true }))} open onClose={vi.fn()} />);
    expect(screen.getByText('This is what people see before they tap.')).toBeInTheDocument();
    expect(screen.getByText('Embed on a website')).toBeInTheDocument();
    expect(screen.getByText(/changes since publishing/)).toBeInTheDocument();
    expect(screen.getByRole('list', { name: /Top channels/ })).toBeInTheDocument();
    unmount();
    render(<ShareSheet studio={studioWith(view({ allowEmbed: false }))} open onClose={vi.fn()} />);
    expect(screen.queryByText('Embed on a website')).toBeNull();
  });

  it('Update resends the page exclusion the owner consented to, and offers nothing else when no new page is blocked', async () => {
    const blockedReadiness = { ok: false, drawnPages: 3, plannedPages: 3, missing: [], stalePages: [], safety: { status: 'blocked' as const, blockedPages: [3], reasons: ['violence'] }, languages: [{ lang: 'en', publishable: true, blocking: [] }] };
    const studio = studioWith(view({ behind: true, excludedPageIds: ['pg_3'], readiness: blockedReadiness }));
    vi.mocked(api.publishComic).mockResolvedValue(view());
    render(<ShareSheet studio={studio} open onClose={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /Publish without page/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Update' }));
    await waitFor(() => expect(api.publishComic).toHaveBeenCalledWith(studio.doc!.id, { visibility: 'unlisted', languages: ['en'], excludePageIds: ['pg_3'] }));
  });

  it('an excluded page that was redrawn clean goes back in: Update sends no exclusion for it, even from a stale view', async () => {
    // The server stops listing it; an older view that still does must not keep the fix out forever.
    const studio = studioWith(view({ behind: true, excludedPageIds: ['pg_3'] }));
    vi.mocked(api.publishComic).mockResolvedValue(view());
    render(<ShareSheet studio={studio} open onClose={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /Publish without page/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Update' }));
    await waitFor(() => expect(api.publishComic).toHaveBeenCalledWith(studio.doc!.id, { visibility: 'unlisted', languages: ['en'] }));
  });

  it('a page blocked since publishing: Update is refused with the honest 422 and the sheet offers "Publish without page N"', async () => {
    const blockedReadiness = { ok: false, drawnPages: 3, plannedPages: 3, missing: [], stalePages: [], safety: { status: 'blocked' as const, blockedPages: [3], reasons: ['violence'] }, languages: [{ lang: 'en', publishable: true, blocking: [] }] };
    const studio = studioWith(view({ behind: true, readiness: blockedReadiness }));
    vi.mocked(api.publishComic).mockRejectedValueOnce(new Error("Page 3 doesn't fit the content rules. Publish without it, or redraw it first."));
    render(<ShareSheet studio={studio} open onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Update' }));
    await waitFor(() => expect(api.publishComic).toHaveBeenCalledWith(studio.doc!.id, { visibility: 'unlisted', languages: ['en'] }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/Page 3 doesn't fit/);
    vi.mocked(api.publishComic).mockResolvedValueOnce(view({ excludedPageIds: ['pg_3'] }));
    fireEvent.click(screen.getByRole('button', { name: 'Publish without page 3' }));
    await waitFor(() => expect(api.publishComic).toHaveBeenLastCalledWith(studio.doc!.id, { visibility: 'unlisted', languages: ['en'], excludePageIds: ['pg_3'] }));
  });

  it('once live, downloads / embedding / username change in place (one PATCH field each), and languages open the panel in update mode', async () => {
    const studio = studioWith(view());
    studio.doc!.i18n = { editions: { hi: { lang: 'hi', lines: {}, balloons: {}, register: 'everyday' } }, glossary: [] };
    vi.mocked(api.updatePublication).mockResolvedValue(view());
    render(<ShareSheet studio={studio} open onClose={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /Update published version/ })).toBeNull();
    fireEvent.click(screen.getByRole('checkbox', { name: /Allow embedding/ }));
    await waitFor(() => expect(api.updatePublication).toHaveBeenLastCalledWith(studio.doc!.id, { allowEmbed: false }));
    fireEvent.click(screen.getByRole('checkbox', { name: /Show my username/ }));
    await waitFor(() => expect(api.updatePublication).toHaveBeenLastCalledWith(studio.doc!.id, { showCreator: true }));
    fireEvent.click(screen.getByRole('checkbox', { name: /Readers can download/ }));
    await waitFor(() => expect(api.updatePublication).toHaveBeenLastCalledWith(studio.doc!.id, { allowDownload: false }));
    expect(api.updatePublication).toHaveBeenCalledTimes(3);
    expect(api.publishComic).not.toHaveBeenCalled();
    // Languages need a republish (the snapshot must carry the edition): the panel, in update mode.
    fireEvent.click(screen.getByRole('button', { name: /Edit languages/ }));
    expect(screen.getByRole('checkbox', { name: /हिन्दी/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Update published version' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
    expect(screen.queryByRole('button', { name: 'Update published version' })).toBeNull();
  });

  it('a published translation that went stale can be dropped from the sheet: "Edit languages…", untick it, Update publishes the original alone', async () => {
    const studio = studioWith(
      view({
        behind: true,
        languages: ['en', 'hi'],
        readiness: { ...view().readiness, ok: false, languages: [{ lang: 'en', publishable: true, blocking: [], requested: true }, { lang: 'hi', publishable: false, blocking: ['3 lines changed since translating.'], requested: true }] }
      })
    );
    studio.doc!.i18n = { editions: { hi: { lang: 'hi', lines: {}, balloons: {}, register: 'everyday' } }, glossary: [] };
    vi.mocked(api.publishComic).mockResolvedValue(view());
    render(<ShareSheet studio={studio} open onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /Edit languages/ }));
    const hindi = screen.getByRole('checkbox', { name: /हिन्दी/ });
    expect(hindi).toBeChecked();
    expect(hindi).not.toBeDisabled();
    fireEvent.click(hindi);
    fireEvent.click(screen.getByRole('button', { name: 'Update published version' }));
    await waitFor(() => expect(api.publishComic).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.publishComic).mock.calls[0][1]).toMatchObject({ visibility: 'unlisted', languages: ['en'] });
  });

  it('the preview mock shows the FROZEN card with its rating (what chat apps render), never the live, unpublished text', () => {
    const previewFigure = () => screen.getByText('This is what people see before they tap.').closest('figure') as HTMLElement;
    const studio = studioWith(view({ behind: true, rating: 'PG', card: { title: 'The Saffron Thief', description: 'A courier races through a spice market.' } }));
    studio.doc!.brief.title = 'Brand new title nobody has seen';
    studio.doc!.brief.logline = 'A logline that is not published yet.';
    const { unmount } = render(<ShareSheet studio={studio} open onClose={vi.fn()} />);
    expect(previewFigure()).toHaveTextContent('The Saffron Thief');
    expect(previewFigure()).toHaveTextContent('A courier races through a spice market. · Rated PG');
    expect(previewFigure()).not.toHaveTextContent('Brand new title nobody has seen');
    expect(previewFigure()).not.toHaveTextContent('A logline that is not published yet.');
    expect(previewFigure().querySelector('img')?.getAttribute('src')).toBe(view().ogImageUrl);
    unmount();
    // No software-made card (its render failed): the cover, as og:image falls back to it.
    const COVER = `https://bdjfmxfmhqhzvgrhbbzm.supabase.co/storage/v1/object/public/comic-assets/pub/K1234567890abcdefghijk/cover-abc-w1080.webp`;
    render(<ShareSheet studio={studioWith(view({ ogImageUrl: undefined, card: { title: 'T', description: '', coverUrl: COVER } }))} open onClose={vi.fn()} />);
    expect(previewFigure().querySelector('img')?.getAttribute('src')).toBe(COVER);
  });

  it('a long title at 360 px never forces horizontal scroll (truncating title, min-w-0 rows)', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 360 });
    setViewport(true);
    const studio = studioWith(view());
    studio.doc!.brief.title = 'A'.repeat(300);
    render(<ShareSheet studio={studio} open onClose={vi.fn()} />);
    const heading = screen.getByRole('heading', { level: 2 });
    expect(heading.className).toContain('truncate');
    const dialog = screen.getByRole('dialog');
    expect(dialog.className).toContain('overflow-hidden');
    expect(dialog.querySelector('.overflow-x-hidden')).not.toBeNull();
    expect(dialog.scrollWidth).toBeLessThanOrEqual(dialog.clientWidth);
  });
});

describe('ShareSheet: Library + link in one step (DS-R0)', () => {
  const privateView = () => view({ visibility: 'private', status: null, slug: undefined, url: undefined, stats: undefined });

  it('names the choices Private · Link only · Library + link, each with its hint, and never says "gallery"', () => {
    render(<ShareSheet studio={studioWith(privateView())} open onClose={vi.fn()} />);
    const radios = within(screen.getByRole('radiogroup', { name: 'Who can read it' })).getAllByRole('radio');
    expect(radios.map((r) => r.textContent)).toEqual(['Private', 'Link only', 'Library + link']);
    expect(screen.getByRole('radio', { name: 'Link only' })).toHaveAccessibleDescription('Anyone with the link can read it; it isn’t listed');
    expect(screen.getByRole('radio', { name: 'Library + link' })).toHaveAccessibleDescription('Listed in the Library, and you get a link to share');
    // Not published yet: the hint names both ways to publish.
    expect(screen.getByText(/Only you can see this comic/)).toHaveTextContent('Choose “Link only” for a read-only link people can open on any device, or “Library + link” to also list it in the Library.');
    expect(screen.getByRole('dialog').textContent).not.toMatch(/gallery/i);
    // Picking a way shows its hint under the choices and the panel's explainer.
    fireEvent.click(screen.getByRole('radio', { name: 'Library + link' }));
    expect(screen.getByText('Listed in the Library, and you get a link to share')).toBeVisible();
    expect(screen.getByText(/It’s listed in the Library, and anyone with the link can read it\./)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
    fireEvent.click(screen.getByRole('radio', { name: 'Link only' }));
    expect(screen.getByText('Anyone with the link can read it; it isn’t listed')).toBeVisible();
    expect(screen.getByText('Listed in the Library, and you get a link to share')).not.toBeVisible();
    expect(screen.getByText(/Anyone with the link can read it\. It isn’t listed or searchable\./)).toBeInTheDocument();
    expect(screen.getByRole('dialog').textContent).not.toMatch(/gallery/i);
  });

  it('choosing "Library + link" publishes ONE request with visibility public, then shows the link and the Library entry', async () => {
    const studio = studioWith(privateView());
    vi.mocked(api.publishComic).mockResolvedValue(view({ visibility: 'public' }));
    const onClose = vi.fn();
    const { rerender } = render(<ShareSheet studio={studio} open onClose={onClose} />);
    fireEvent.click(screen.getByRole('radio', { name: 'Library + link' }));
    fireEvent.click(screen.getByRole('button', { name: 'Publish' }));
    await waitFor(() => expect(api.publishComic).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.publishComic).mock.calls[0]).toEqual([studio.doc!.id, expect.objectContaining({ visibility: 'public', languages: ['en'], allowDownload: true })]);
    // The privacy confirm guards listing a LIVE link; from private, the panel is the one confirmation.
    expect(api.updatePublication).not.toHaveBeenCalled();
    await waitFor(() => expect(studio.refresh).toHaveBeenCalled());
    // The owner view comes back listed and live: the sheet leaves the panel and leads with the link.
    rerender(<ShareSheet studio={{ ...studio, publication: view({ visibility: 'public' }) }} open onClose={onClose} />);
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Publish' })).toBeNull());
    expect(screen.getByLabelText('Read-only link')).toHaveValue(`https://comics.dreamstreamstudio.ai/c/${SLUG}`);
    expect(screen.getByRole('link', { name: 'See it in the Library' })).toHaveAttribute('href', '/?view=gallery');
    expect(api.publishComic).toHaveBeenCalledTimes(1);
  });

  it('published as Library + link: the read-only link comes first, then a 44 px "See it in the Library" link to the public Library', () => {
    const studio = studioWith(view({ visibility: 'public' }));
    render(<ShareSheet studio={studio} open onClose={vi.fn()} />);
    expect(screen.getByText('Published · In the Library + link')).toBeInTheDocument();
    const link = screen.getByLabelText('Read-only link') as HTMLInputElement;
    expect(link.value).toBe(`https://comics.dreamstreamstudio.ai/c/${SLUG}`);
    expect(screen.getByRole('button', { name: /^Copy$/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Share…/ })).toBeInTheDocument();
    const library = screen.getByRole('link', { name: 'See it in the Library' });
    // The same view StaticSiteHeader's Library item opens (App restores ?view=gallery).
    expect(library).toHaveAttribute('href', '/?view=gallery');
    expect(library.className).toContain('min-h-[44px]');
    expect(library.getAttribute('rel')).toBe('noopener noreferrer');
    // Link first, then the Library entry, then the choices.
    const group = screen.getByRole('radiogroup', { name: 'Who can read it' });
    expect(link.compareDocumentPosition(library) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(library.compareDocumentPosition(group) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'Library + link' })).toHaveAttribute('aria-checked', 'true');
    // Readers still only read: downloads are the owner's toggle, nothing grants editing.
    expect(screen.getByRole('checkbox', { name: /Readers can download/ })).toBeChecked();
    expect(screen.getByRole('dialog').textContent).not.toMatch(/gallery|can edit/i);
  });

  it('published as Link only: the link comes first and there is no Library entry', () => {
    render(<ShareSheet studio={studioWith(view())} open onClose={vi.fn()} />);
    expect(screen.getByText('Published · Link only')).toBeInTheDocument();
    const link = screen.getByLabelText('Read-only link');
    expect(link.compareDocumentPosition(screen.getByRole('radiogroup', { name: 'Who can read it' })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'See it in the Library' })).toBeNull();
    expect(screen.getByText('Anyone with the link can read it; it isn’t listed')).toBeVisible();
  });

  it('on a phone the QR sits in the link block that shows first, ahead of the choices and the settings', () => {
    setViewport(true);
    render(<ShareSheet studio={studioWith(view({ visibility: 'public' }))} open onClose={vi.fn()} />);
    expect(document.querySelector('[data-share-layout="bottom"]')).not.toBeNull();
    const link = screen.getByLabelText('Read-only link');
    const showQr = screen.getByRole('button', { name: 'Show QR code' });
    const group = screen.getByRole('radiogroup', { name: 'Who can read it' });
    expect(link.compareDocumentPosition(showQr) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(showQr.compareDocumentPosition(group) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(showQr.compareDocumentPosition(screen.getByRole('region', { name: 'Link settings' })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Opened in place, the code itself is still ahead of the choices.
    fireEvent.click(showQr);
    const code = screen.getByRole('img', { name: /^QR code for / });
    expect(code.compareDocumentPosition(group) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getAllByRole('img', { name: /^QR code for / })).toHaveLength(1);
  });

  it('on a tablet dialog (640–1023 px) the QR shows in the first block too; the wide dialog keeps it in its left column', () => {
    window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener: () => undefined, removeEventListener: () => undefined, addListener: () => undefined, removeListener: () => undefined, onchange: null, dispatchEvent: () => false })) as unknown as typeof window.matchMedia;
    const { unmount } = render(<ShareSheet studio={studioWith(view())} open onClose={vi.fn()} />);
    expect(document.querySelector('[data-share-layout="dialog"]')).not.toBeNull();
    const group = () => screen.getByRole('radiogroup', { name: 'Who can read it' });
    expect(screen.getAllByRole('img', { name: /^QR code for / })).toHaveLength(1);
    expect(screen.getByRole('img', { name: /^QR code for / }).compareDocumentPosition(group()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    unmount();
    setViewport(false);
    render(<ShareSheet studio={studioWith(view())} open onClose={vi.fn()} />);
    expect(document.querySelector('[data-share-layout="wide"]')).not.toBeNull();
    expect(screen.getAllByRole('img', { name: /^QR code for / })).toHaveLength(1);
  });
});

// AH-1 (HONEST-PUBLISH): the sheet tells the truth while the owner view is on its way and when the check fails.
describe('ShareSheet: honest while the comic is being checked (AH-1)', () => {
  /** A refreshPublication the test settles by hand (the owner view is still on its way). */
  const deferred = () => {
    let resolve!: () => void;
    let reject!: (err: Error) => void;
    const promise = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };
  const privateView = () => view({ visibility: 'private', status: null, slug: undefined, url: undefined, stats: undefined });
  const mirrorOf = (over: Partial<NonNullable<ReturnType<typeof makeSampleDoc>['publication']>> = {}) => ({ visibility: 'unlisted' as const, status: 'live' as const, slug: SLUG, publishedRev: 4, publishedAt: 1, languages: ['en'], ...over });

  it('while the owner view is on its way, choosing "Link only" shows "Checking your comic…", never "Draw at least one page"', async () => {
    const pending = deferred();
    const studio = makeFakeStudio({ publication: null, refreshPublication: vi.fn(() => pending.promise) });
    const { rerender } = render(<ShareSheet studio={studio} open onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('radio', { name: 'Link only' }));
    const checking = screen.getByRole('button', { name: 'Checking your comic…' });
    expect(checking).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Publish' })).toBeNull();
    expect(screen.getByRole('dialog').textContent).not.toMatch(/Draw at least one page/);
    // The row and the button agree: the sample comic has one drawn page of three.
    expect(screen.getByText('1 of 3 pages drawn — undrawn pages are left out')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
    // The owner view arrives: the button is Publish, and it works.
    await act(async () => pending.resolve());
    rerender(<ShareSheet studio={{ ...studio, publication: privateView() }} open onClose={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Checking your comic…' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Publish' })).toBeEnabled();
  });

  it('the studio still fetching the owner view (publicationLoading) reads as checking too', async () => {
    const studio = makeFakeStudio({ publication: null, publicationLoading: true });
    render(<ShareSheet studio={studio} open onClose={vi.fn()} />);
    await act(async () => undefined);
    fireEvent.click(screen.getByRole('radio', { name: 'Link only' }));
    expect(screen.getByRole('button', { name: 'Checking your comic…' })).toBeDisabled();
    expect(screen.getByRole('dialog').textContent).not.toMatch(/Draw at least one page/);
  });

  it('a failed check says "Couldn’t check your comic." with Try again, which checks again', async () => {
    const refreshPublication = vi.fn<() => Promise<void>>().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined);
    const studio = makeFakeStudio({ publication: null, refreshPublication });
    const { rerender } = render(<ShareSheet studio={studio} open onClose={vi.fn()} />);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Couldn’t check your comic.');
    expect(refreshPublication).toHaveBeenCalledTimes(1);
    // Inside the publish panel the same alert shows, Publish waits, and nothing claims the comic has no pages.
    fireEvent.click(screen.getByRole('radio', { name: 'Link only' }));
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(screen.getByRole('alert')).toHaveTextContent('Couldn’t check your comic.');
    expect(screen.getByRole('button', { name: 'Publish' })).toBeDisabled();
    expect(screen.getByRole('dialog').textContent).not.toMatch(/Draw at least one page/);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(refreshPublication).toHaveBeenCalledTimes(2);
    // While it checks again the alert gives way to "Checking your comic…".
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('button', { name: 'Checking your comic…' })).toBeDisabled();
    await act(async () => undefined);
    rerender(<ShareSheet studio={{ ...studio, publication: privateView() }} open onClose={vi.fn()} />);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('button', { name: 'Publish' })).toBeEnabled();
  });

  it('a published comic never reads "Private" before its owner view arrives: the status line and the selected choice come from the doc’s own mirror', async () => {
    const pending = deferred();
    const doc = makeSampleDoc();
    doc.publication = mirrorOf();
    const studio = makeFakeStudio({ doc, publication: undefined as unknown as null, refreshPublication: vi.fn(() => pending.promise) });
    const { rerender } = render(<ShareSheet studio={studio} open onClose={vi.fn()} />);
    const dialog = screen.getByRole('dialog');
    expect(screen.getByText('Published · Link only')).toBeInTheDocument();
    expect(dialog.textContent).not.toMatch(/Private —|Only you can see/);
    expect(screen.getByRole('radio', { name: 'Link only' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: 'Private' })).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByText('Checking your comic…')).toBeInTheDocument();
    // Its own choice does nothing (it never offers to publish a published comic again)…
    fireEvent.click(screen.getByRole('radio', { name: 'Link only' }));
    expect(screen.queryByRole('button', { name: 'Publish' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Checking your comic…' })).toBeNull();
    // …and listing it in the Library still asks first.
    fireEvent.click(screen.getByRole('radio', { name: 'Library + link' }));
    expect(screen.getByRole('alertdialog', { name: 'List it in the Library?' })).toBeInTheDocument();
    expect(api.publishComic).not.toHaveBeenCalled();
    expect(api.updatePublication).not.toHaveBeenCalled();
    // The owner view arrives and takes over (link first, as before).
    await act(async () => pending.resolve());
    rerender(<ShareSheet studio={{ ...studio, publication: view() }} open onClose={vi.fn()} />);
    expect(screen.queryByText('Checking your comic…')).toBeNull();
    expect(screen.getByLabelText('Read-only link')).toHaveValue(`https://comics.dreamstreamstudio.ai/c/${SLUG}`);
  });

  it('the mirror also names a listed comic and a paused one, and a failed check on a published comic still never says "Private"', async () => {
    const doc = makeSampleDoc();
    doc.publication = mirrorOf({ visibility: 'public' });
    const failing = makeFakeStudio({ doc, publication: null, refreshPublication: vi.fn(async () => Promise.reject(new Error('offline'))) });
    const { unmount } = render(<ShareSheet studio={failing} open onClose={vi.fn()} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Couldn’t check your comic.');
    expect(screen.getByText('Published · In the Library + link')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Library + link' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('dialog').textContent).not.toMatch(/Private —|Only you can see/);
    unmount();
    const paused = makeSampleDoc();
    paused.publication = mirrorOf({ status: 'suspended' });
    render(<ShareSheet studio={makeFakeStudio({ doc: paused, publication: null, refreshPublication: vi.fn(() => new Promise<void>(() => undefined)) })} open onClose={vi.fn()} />);
    expect(screen.getByText(/Paused by review/)).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Library + link' })).toBeDisabled();
    expect(screen.getByRole('dialog').textContent).not.toMatch(/Private —|Only you can see/);
  });

  it('a private comic with no mirror still reads "Private" while it is checked (that is true), and a server view with no drawn page keeps today’s message', async () => {
    const pending = deferred();
    const studio = makeFakeStudio({ publication: null, refreshPublication: vi.fn(() => pending.promise) });
    const { rerender } = render(<ShareSheet studio={studio} open onClose={vi.fn()} />);
    expect(screen.getByText('Private — only you can see it')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Private' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByText(/Only you can see this comic/)).toBeInTheDocument();
    await act(async () => pending.resolve());
    const none = privateView();
    none.readiness = { ...none.readiness, ok: false, drawnPages: 0 };
    rerender(<ShareSheet studio={{ ...studio, publication: none }} open onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('radio', { name: 'Link only' }));
    expect(screen.getByText('Draw at least one page to publish.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Publish' })).toBeDisabled();
  });
});

describe('ShareLinkCard options', () => {
  it('language and start page chips update the link', () => {
    render(<ShareLinkCard view={view({ languages: ['en', 'hi'] })} title="T" pageCount={3} />);
    const input = screen.getByLabelText('Read-only link') as HTMLInputElement;
    expect(input.value).toBe(`https://comics.dreamstreamstudio.ai/c/${SLUG}`);
    fireEvent.click(screen.getByRole('button', { name: /Link options/ }));
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'hi' } });
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '2' } });
    expect(input.value).toBe(`https://comics.dreamstreamstudio.ai/c/${SLUG}?p=2&lang=hi`);
  });
});

describe('QrCode', () => {
  it('renders an <svg> whose module matrix round-trips the exact URL', () => {
    const url = `https://comics.dreamstreamstudio.ai/c/${SLUG}?via=qr`;
    render(<QrCode value={url} downloadable />);
    const svg = screen.getByRole('img', { name: `QR code for ${url}` });
    expect(svg.tagName.toLowerCase()).toBe('svg');
    expect(qrMatrix(url)).toEqual(encode(url, { ecc: 'M', border: 4 }).data);
    expect(Number(svg.getAttribute('data-qr-size'))).toBe(qrMatrix(url).length);
    expect(screen.getByRole('button', { name: /Download PNG/ })).toBeInTheDocument();
  });
});

describe('shareModel', () => {
  it('builds canonical links, intents and a safe embed snippet', () => {
    expect(shareLinkFor(view(), { via: 'x' })).toBe(`https://comics.dreamstreamstudio.ai/c/${SLUG}?via=x`);
    expect(shareLinkFor(view({ slug: undefined }))).toBeNull();
    expect(intentUrl('x', 'https://a.b/c?d=1', 'Hi & bye')).toBe('https://twitter.com/intent/tweet?url=https%3A%2F%2Fa.b%2Fc%3Fd%3D1&text=Hi%20%26%20bye');
    expect(intentUrl('email', 'https://a.b', 'T')).toMatch(/^mailto:\?subject=T&body=/);
    const snippet = embedSnippet(`https://comics.dreamstreamstudio.ai/c/${SLUG}`, '"><script>x</script>', '4:5');
    expect(snippet).toContain(`src="https://comics.dreamstreamstudio.ai/c/${SLUG}/embed"`);
    expect(snippet).toContain('title="&quot;&gt;&lt;script&gt;x&lt;/script&gt;"');
    expect(snippet).toContain('aspect-ratio:4/5');
    expect(statusLine(view()).label).toBe('Published · Link only');
    expect(statusLine(view({ visibility: 'public' })).label).toBe('Published · In the Library + link');
    expect(statusLine(null).label).toMatch(/Private/);
    // AH-1: with no owner view yet, the doc's own mirror names a published comic (absent mirror = private).
    const mirror = { visibility: 'unlisted' as const, status: 'live' as const, slug: SLUG, publishedRev: 4, publishedAt: 1, languages: ['en'] };
    expect(statusLine(null, mirror)).toEqual({ label: 'Published · Link only', tone: 'unlisted' });
    expect(statusLine(undefined, { ...mirror, visibility: 'public' })).toEqual({ label: 'Published · In the Library + link', tone: 'public' });
    expect(statusLine(null, { ...mirror, status: 'suspended' }).tone).toBe('warn');
    expect(statusLine(null, null).label).toBe('Private — only you can see it');
    // The owner view, once here, always wins over the mirror.
    expect(statusLine(view({ visibility: 'private', status: null, slug: undefined }), mirror).label).toBe('Private — only you can see it');
    expect(middleEllipsis('abcdefghijklmnopqrstuvwxyz', 10)).toHaveLength(10);
    expect(isInAppBrowser('Mozilla/5.0 Instagram 300.0')).toBe(true);
    expect(fileNameFor('../Spice: Run?/', 'pdf')).toBe('Spice-Run.pdf');
  });
});

describe('ShareButton', () => {
  it('opens on the global open-share event, shows the status dot, and works as a reader share button', async () => {
    const studio = studioWith(view({ visibility: 'public' }));
    studio.doc!.publication = { ...studio.doc!.publication!, visibility: 'public' };
    const { unmount } = render(<ShareButton studio={studio} compact />);
    expect(screen.getByRole('button', { name: 'Share (Library + link)' })).toBeInTheDocument();
    act(() => {
      window.dispatchEvent(new CustomEvent('ds:open-share'));
    });
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    unmount();
    vi.stubGlobal('navigator', { ...navigator, share: undefined, userAgent: 'test' });
    render(<ShareButton target={{ url: `https://comics.dreamstreamstudio.ai/c/${SLUG}`, title: 'T' }} />);
    fireEvent.click(screen.getByRole('button', { name: /Share/ }));
    expect(await screen.findByRole('menu')).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Telegram' }).getAttribute('href')).toContain('t.me/share/url');
  });
});
