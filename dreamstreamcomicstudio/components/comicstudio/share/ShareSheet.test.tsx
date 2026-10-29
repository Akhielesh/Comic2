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
    const trigger = screen.getByRole('button', { name: /Share \(unlisted\)/ });
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

  it('private comic: choosing "Anyone with link" opens the publish panel; Publish posts the request and refreshes', async () => {
    const studio = studioWith(view({ visibility: 'private', status: null, slug: undefined, url: undefined, stats: undefined }));
    vi.mocked(api.publishComic).mockResolvedValue(view());
    render(<ShareSheet studio={studio} open onClose={vi.fn()} />);
    expect(screen.getByText(/Only you can see this comic/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: 'Anyone with link' }));
    expect(screen.getByRole('checkbox', { name: /Readers can download/ })).toBeChecked(); // addendum default
    fireEvent.click(screen.getByRole('button', { name: 'Publish' }));
    await waitFor(() => expect(api.publishComic).toHaveBeenCalledWith(studio.doc!.id, expect.objectContaining({ visibility: 'unlisted', allowDownload: true, showCreator: false })));
    await waitFor(() => expect(studio.refresh).toHaveBeenCalled());
  });

  it('a refused publish shows the honest server message', async () => {
    const studio = studioWith(view({ visibility: 'private', status: null, slug: undefined, url: undefined }));
    vi.mocked(api.publishComic).mockRejectedValue(new Error("Safety checks are unavailable right now, so nothing was published — your comic stays private."));
    render(<ShareSheet studio={studio} open onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('radio', { name: 'Public gallery' }));
    fireEvent.click(screen.getByRole('button', { name: 'Publish' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Safety checks are unavailable');
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

  it('going PUBLIC from a live unlisted link asks first; "Keep it unlisted" changes nothing', async () => {
    const studio = studioWith(view());
    vi.mocked(api.updatePublication).mockResolvedValue(view({ visibility: 'public' }));
    render(<ShareSheet studio={studio} open onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('radio', { name: 'Public gallery' }));
    const dialog = screen.getByRole('alertdialog', { name: 'List it in the public gallery?' });
    // Focus lands on the safe choice so the question is announced.
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Keep it unlisted' }));
    expect(api.updatePublication).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep it unlisted' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(api.updatePublication).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('radio', { name: 'Public gallery' }));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Make it public' }));
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
    expect(statusLine(view()).label).toMatch(/Anyone with the link/);
    expect(statusLine(null).label).toMatch(/Private/);
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
    expect(screen.getByRole('button', { name: 'Share (public)' })).toBeInTheDocument();
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
