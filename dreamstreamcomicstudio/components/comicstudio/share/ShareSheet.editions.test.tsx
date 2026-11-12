// AH-2 (EDITIONS-ON-LINK): a finished language reaches the live link in one tap, never silently, and a first
// publish starts with every finished language ticked. Staged by EDITION_ON_LINK ('admins' by default): an account
// the stage does not admit gets today's sheet.
import React from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CAPS } from '../../../shared/comic/capabilities';
import type { ComicDoc } from '../../../shared/comic/doc';
import { lineSourceHash } from '../../../shared/comic/i18n';
import type { PublicationOwnerView, PublishReadiness } from '../../../shared/comic/publication';
import { makeFakeStudio, makeSampleDoc } from '../conversation/testing/fixtures';
import { ShareButton } from './ShareButton';
import { ShareSheet } from './ShareSheet';
import { EDITION_ON_LINK, editionOnLinkOn, languageNames, MAX_LINK_LANGUAGES, readyOffLink } from './shareModel';

vi.mock('../studioApi', async (orig) => {
  const mod = await orig<typeof import('../studioApi')>();
  return { ...mod, publishComic: vi.fn(), updatePublication: vi.fn(), unpublishComic: vi.fn(), regeneratePublicationLink: vi.fn() };
});
import * as api from '../studioApi';

const SLUG = 'Ab3dEf6hIj9kLm2nP';
type LangRow = PublishReadiness['languages'][number];
const EN: LangRow = { lang: 'en', publishable: true, blocking: [], requested: true };
const HI_READY: LangRow = { lang: 'hi', publishable: true, blocking: [], requested: false };
const TE_READY: LangRow = { lang: 'te', publishable: true, blocking: [], requested: false };

const readiness = (languages: LangRow[]): PublishReadiness => ({ ok: true, drawnPages: 1, plannedPages: 3, missing: [], stalePages: [], safety: { status: 'cleared', blockedPages: [], reasons: [] }, languages });

/** A live Link only comic whose link carries English; the owner view lists every edition the comic holds. */
const liveView = (languages: LangRow[], over: Partial<PublicationOwnerView> = {}): PublicationOwnerView => ({
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
  readiness: readiness(languages),
  ...over
});

const privateView = (languages: LangRow[]): PublicationOwnerView => ({ ...liveView(languages), visibility: 'private', status: null, slug: undefined, url: undefined, publishedRev: 0 });

/** The sample comic with finished (reviewed) editions in the given languages. */
const docWith = (langs: string[], published = true): ComicDoc => {
  const doc = makeSampleDoc();
  doc.format = { ...doc.format, language: 'en', lettering: 'overlay' };
  const lines = doc.pages.flatMap((p) => p.panels.flatMap((pn) => pn.lines)).filter((l) => l.text.trim());
  const edition = (lang: string) => ({ lang, lines: Object.fromEntries(lines.map((l) => [l.id, { text: `${lang}:${l.text}`, status: 'reviewed' as const, sourceHash: lineSourceHash(l), at: 1 }])), balloons: {}, register: 'everyday' as const });
  doc.i18n = { editions: Object.fromEntries(langs.map((l) => [l, edition(l)])), glossary: [] };
  if (published) doc.publication = { visibility: 'unlisted', status: 'live', slug: SLUG, publishedRev: 4, publishedAt: 1, languages: ['en'] };
  return doc;
};

const ADMIN = { ...DEFAULT_CAPS, admin: true };
const studioFor = (doc: ComicDoc, publication: PublicationOwnerView | null, admin = true) => makeFakeStudio({ doc, publication, caps: admin ? ADMIN : DEFAULT_CAPS });

/** The sheet's markup with React's generated ids taken out (they differ between two mounts of the same tree). */
const markup = () => document.querySelector('[data-share-layout]')!.outerHTML.replace(/(id|for|aria-describedby|aria-labelledby)="[^"]*"/g, '$1=""');

beforeEach(() => {
  // A wide desktop dialog.
  window.matchMedia = ((q: string) => ({ matches: q.includes('min-width: 1024px'), media: q, addEventListener: () => undefined, removeEventListener: () => undefined, addListener: () => undefined, removeListener: () => undefined, onchange: null, dispatchEvent: () => false })) as unknown as typeof window.matchMedia;
  vi.mocked(api.publishComic).mockResolvedValue(liveView([EN, HI_READY], { languages: ['en', 'hi'] }));
});
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('the stage (EDITION_ON_LINK)', () => {
  it('ships for admins: off = nobody, admins = admin accounts, all = everyone', () => {
    expect(EDITION_ON_LINK).toBe('admins');
    expect(editionOnLinkOn(true)).toBe(true);
    expect(editionOnLinkOn(false)).toBe(false);
    expect(editionOnLinkOn(undefined)).toBe(false);
    expect(editionOnLinkOn(true, 'off')).toBe(false);
    expect(editionOnLinkOn(false, 'all')).toBe(true);
  });

  it('readyOffLink lists the finished editions the link does not carry, and languageNames words them', () => {
    const doc = docWith(['hi', 'te']);
    expect(readyOffLink(liveView([EN, HI_READY, TE_READY]), doc)).toEqual(['hi', 'te']);
    // Already on the link, not finished, or no longer in the comic: never offered.
    expect(readyOffLink(liveView([EN, { ...HI_READY, requested: true }, TE_READY], { languages: ['en', 'hi'] }), doc)).toEqual(['te']);
    expect(readyOffLink(liveView([EN, { ...HI_READY, publishable: false, blocking: ['2 lines waiting for review.'] }]), doc)).toEqual([]);
    expect(readyOffLink(liveView([EN, HI_READY]), docWith([]))).toEqual([]);
    expect(readyOffLink(null, doc)).toEqual([]);
    // Only as many as the link has room for (one publication carries 12 languages, the original included).
    expect(MAX_LINK_LANGUAGES).toBe(12);
    // The number is the server's own cap: if that moves, this one must move with it.
    const server = readFileSync(resolve(__dirname, '../../../server/src/comic/publication/publication.ts'), 'utf8');
    expect(Number(server.match(/const MAX_LANGUAGES = (\d+);/)?.[1])).toBe(MAX_LINK_LANGUAGES);
    const eleven = ['en', 'ta', 'kn', 'ml', 'mr', 'bn', 'gu', 'pa', 'ur', 'es', 'fr'];
    expect(readyOffLink(liveView([EN, HI_READY, TE_READY], { languages: eleven }), doc)).toEqual(['hi']);
    expect(readyOffLink(liveView([EN, HI_READY, TE_READY], { languages: [...eleven, 'de'] }), doc)).toEqual([]);
    expect(languageNames(['en'])).toBe('English');
    expect(languageNames(['hi', 'te'])).toBe('हिन्दी and తెలుగు');
    expect(languageNames(['hi', 'te', 'ta'])).toBe('3 languages');
  });
});

describe('ShareSheet: a finished language reaches the live link in one tap (AH-2)', () => {
  it('says "हिन्दी is ready" with what readers get today, and "Add हिन्दी to the link" sends ONE republish with English and Hindi', async () => {
    const studio = studioFor(docWith(['hi']), liveView([EN, HI_READY]));
    render(<ShareSheet studio={studio} open onClose={vi.fn()} />);
    const row = screen.getByRole('group', { name: 'Languages ready for your link' });
    expect(row).toHaveTextContent('हिन्दी is ready. Readers of your link still get English only.');
    const add = within(row).getByRole('button', { name: 'Add हिन्दी to the link' });
    expect(add.className).toContain('min-h-[44px]');
    expect(api.publishComic).not.toHaveBeenCalled(); // never silently: nothing is sent until the tap
    fireEvent.click(add);
    await waitFor(() => expect(api.publishComic).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.publishComic).mock.calls[0]).toEqual([studio.doc!.id, { visibility: 'unlisted', languages: ['en', 'hi'] }]);
    expect(api.updatePublication).not.toHaveBeenCalled();
    await waitFor(() => expect(studio.refresh).toHaveBeenCalled());
  });

  it('with changes since publishing: "Update with हिन्दी" carries both languages; the plain Update still sends English only and says so under it', async () => {
    const studio = studioFor(docWith(['hi']), liveView([EN, HI_READY], { behind: true }));
    render(<ShareSheet studio={studio} open onClose={vi.fn()} />);
    expect(screen.getByText(/changes since publishing/)).toBeInTheDocument();
    const plain = screen.getByRole('button', { name: 'Update' });
    expect(plain).toHaveAccessibleDescription('Readers still get English only');
    expect(screen.getByText('Readers still get English only')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Update with हिन्दी' }));
    await waitFor(() => expect(api.publishComic).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.publishComic).mock.calls[0]).toEqual([studio.doc!.id, { visibility: 'unlisted', languages: ['en', 'hi'] }]);
    // One offer, not two: the "ready" row is the banner's own button while there are changes to publish.
    expect(screen.queryByRole('button', { name: 'Add हिन्दी to the link' })).toBeNull();
  });

  it('the plain Update never adds a language on its own', async () => {
    const studio = studioFor(docWith(['hi']), liveView([EN, HI_READY], { behind: true }));
    render(<ShareSheet studio={studio} open onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Update' }));
    await waitFor(() => expect(api.publishComic).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.publishComic).mock.calls[0]).toEqual([studio.doc!.id, { visibility: 'unlisted', languages: ['en'] }]);
  });

  it('keeps the pages the owner left out, and a listed comic stays listed', async () => {
    const blocked = { ...readiness([EN, HI_READY]), ok: false, drawnPages: 3, safety: { status: 'blocked' as const, blockedPages: [3], reasons: ['violence'] } };
    const studio = studioFor(docWith(['hi']), liveView([EN, HI_READY], { visibility: 'public', excludedPageIds: ['pg_3'], readiness: blocked }));
    render(<ShareSheet studio={studio} open onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add हिन्दी to the link' }));
    await waitFor(() => expect(api.publishComic).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.publishComic).mock.calls[0][1]).toEqual({ visibility: 'public', languages: ['en', 'hi'], excludePageIds: ['pg_3'] });
  });

  it('two finished languages go in one tap; the row names what the link carries today', async () => {
    const studio = studioFor(docWith(['hi', 'te', 'ta']), liveView([EN, { lang: 'ta', publishable: true, blocking: [], requested: true }, HI_READY, TE_READY], { languages: ['en', 'ta'] }));
    render(<ShareSheet studio={studio} open onClose={vi.fn()} />);
    const row = screen.getByRole('group', { name: 'Languages ready for your link' });
    expect(row).toHaveTextContent('हिन्दी and తెలుగు are ready. Readers of your link still get English and தமிழ் only.');
    fireEvent.click(within(row).getByRole('button', { name: 'Add हिन्दी and తెలుగు to the link' }));
    await waitFor(() => expect(api.publishComic).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.publishComic).mock.calls[0][1]).toEqual({ visibility: 'unlisted', languages: ['en', 'ta', 'hi', 'te'] });
  });

  it('offers nothing for a translation that is not finished, one already on the link, or a comic that is not live', () => {
    const waiting = { ...HI_READY, publishable: false, blocking: ['2 lines waiting for review.'] };
    const { unmount } = render(<ShareSheet studio={studioFor(docWith(['hi']), liveView([EN, waiting]))} open onClose={vi.fn()} />);
    expect(screen.queryByRole('group', { name: 'Languages ready for your link' })).toBeNull();
    unmount();
    const onLink = render(<ShareSheet studio={studioFor(docWith(['hi']), liveView([EN, { ...HI_READY, requested: true }], { languages: ['en', 'hi'] }))} open onClose={vi.fn()} />);
    expect(screen.queryByRole('group', { name: 'Languages ready for your link' })).toBeNull();
    onLink.unmount();
    render(<ShareSheet studio={studioFor(docWith(['hi'], false), privateView([EN, HI_READY]))} open onClose={vi.fn()} />);
    expect(screen.queryByRole('group', { name: 'Languages ready for your link' })).toBeNull();
    expect(screen.queryByRole('button', { name: /to the link$/ })).toBeNull();
  });

  it('a failed add says why and changes nothing', async () => {
    vi.mocked(api.publishComic).mockRejectedValueOnce(new Error("Hindi isn't ready to publish yet: 2 lines waiting for review."));
    render(<ShareSheet studio={studioFor(docWith(['hi']), liveView([EN, HI_READY]))} open onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add हिन्दी to the link' }));
    expect(await screen.findByRole('alert')).toHaveTextContent("Hindi isn't ready to publish yet");
    expect(screen.getByRole('button', { name: 'Add हिन्दी to the link' })).toBeEnabled();
  });
});

describe('ShareSheet: a first publish starts with every finished language ticked (AH-2)', () => {
  it('a private comic with a finished Hindi edition opens "Link only" with Hindi ticked, and Publish sends both', async () => {
    const studio = studioFor(docWith(['hi'], false), privateView([EN, HI_READY]));
    render(<ShareSheet studio={studio} open onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('radio', { name: 'Link only' }));
    expect(screen.getByRole('checkbox', { name: /हिन्दी/ })).toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: 'Publish' }));
    await waitFor(() => expect(api.publishComic).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.publishComic).mock.calls[0][1]).toMatchObject({ visibility: 'unlisted', languages: ['en', 'hi'] });
  });
});

describe('the stage off: an account it does not admit gets today’s sheet', () => {
  it('a non-admin sees no "ready" row, no "Update with …" and no note; Update is the one button it was', async () => {
    const studio = studioFor(docWith(['hi']), liveView([EN, HI_READY], { behind: true }), false);
    render(<ShareSheet studio={studio} open onClose={vi.fn()} />);
    expect(screen.queryByRole('group', { name: 'Languages ready for your link' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Update with/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /to the link$/ })).toBeNull();
    expect(screen.queryByText(/Readers still get/)).toBeNull();
    const update = screen.getByRole('button', { name: 'Update' });
    expect(update.className).toBe('min-h-[44px] rounded-xl bg-[var(--ds-accent)] px-3 font-semibold text-white disabled:opacity-50');
    expect(update).not.toHaveAttribute('aria-describedby');
    fireEvent.click(update);
    await waitFor(() => expect(api.publishComic).toHaveBeenCalledWith(studio.doc!.id, { visibility: 'unlisted', languages: ['en'] }));
  });

  it('its markup is the markup of a comic with nothing to offer (live sheet, behind banner, first publish)', () => {
    const nothing = { ...HI_READY, publishable: false, blocking: ['2 lines waiting for review.'] };
    for (const over of [{}, { behind: true }] as Array<Partial<PublicationOwnerView>>) {
      const off = render(<ShareSheet studio={studioFor(docWith(['hi']), liveView([EN, HI_READY], over), false)} open onClose={vi.fn()} />);
      const offMarkup = markup();
      off.unmount();
      // The same comic for an admin whose Hindi is not finished: the stage is on and has nothing to add.
      const base = render(<ShareSheet studio={studioFor(docWith(['hi']), liveView([EN, nothing], over), true)} open onClose={vi.fn()} />);
      expect(offMarkup).toBe(markup());
      base.unmount();
    }
    // First publish: Hindi stays unticked for a non-admin, exactly as before.
    render(<ShareSheet studio={studioFor(docWith(['hi'], false), privateView([EN, HI_READY]), false)} open onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('radio', { name: 'Link only' }));
    const hindi = screen.getByRole('checkbox', { name: /हिन्दी/ });
    expect(hindi).not.toBeChecked();
    expect(hindi).not.toBeDisabled();
  });
});

describe('a viewer of a share link can never trigger any of this', () => {
  it('the reader’s share button never mounts the Share sheet, and never calls the studio API or the network', async () => {
    const fetchSpy = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', fetchSpy);
    vi.stubGlobal('navigator', { ...navigator, share: undefined, userAgent: 'test' });
    render(<ShareButton target={{ url: `https://comics.dreamstreamstudio.ai/c/${SLUG}`, title: 'Rooftop Heist' }} />);
    fireEvent.click(screen.getByRole('button', { name: /Share/ }));
    expect(await screen.findByRole('menu')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('button', { name: /to the link$|^Update/ })).toBeNull();
    expect(api.publishComic).not.toHaveBeenCalled();
    expect(api.updatePublication).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('the public reader mounts the share button with a link only (no studio controller, so no Share sheet)', () => {
    const src = readFileSync(resolve(__dirname, '../PublicComicReader.tsx'), 'utf8');
    const uses = src.match(/<ShareButton\b[^>]*>/g) || [];
    expect(uses.length).toBeGreaterThan(0);
    for (const use of uses) {
      expect(use).toContain('target=');
      expect(use).not.toContain('studio=');
    }
    expect(src).not.toMatch(/<ShareSheet\b|<PublishPanel\b/);
  });

  it('the owner’s one tap is a republish, which is free: no translate, quote or draw call is made', async () => {
    const fetchSpy = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', fetchSpy);
    const studio = studioFor(docWith(['hi']), liveView([EN, HI_READY]));
    render(<ShareSheet studio={studio} open onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add हिन्दी to the link' }));
    await waitFor(() => expect(api.publishComic).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(studio.refresh).toHaveBeenCalled());
    expect(studio.act).not.toHaveBeenCalled();
    expect(studio.send).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
