// Publish panel readiness (sharing.md §7.3 #2; gate F3/F4 follow-up): a cover the publish gate would
// REFUSE — drawn, but from an image outside the studio (publication.ts OUTSIDE_IMAGE_STATUS) — says so
// in the readiness list, instead of 'No cover yet' while "Publish" then answers 422.
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ComicDoc } from '../../../shared/comic/doc';
import { editionReadiness, lineSourceHash } from '../../../shared/comic/i18n';
import type { PublicationOwnerView, PublishReadiness } from '../../../shared/comic/publication';
import { makeSampleDoc } from '../conversation/testing/fixtures';
import { PublishPanel, readinessRows } from './PublishPanel';

/** The server's word for drawn art that isn't server-made (server/src/comic/publication/publication.ts OUTSIDE_IMAGE_STATUS). */
const OUTSIDE_IMAGE_STATUS = 'uses an image from outside the studio — redraw it or upload the image again';

const readiness = (missing: PublishReadiness['missing']): PublishReadiness => ({
  ok: missing.length === 0,
  drawnPages: 3,
  plannedPages: 3,
  missing,
  stalePages: [],
  safety: { status: 'cleared', blockedPages: [], reasons: [] },
  languages: [{ lang: 'en', publishable: true, blocking: [] }]
});

const coverRow = (r: PublishReadiness) => readinessRows(r, makeSampleDoc()).find((row) => /cover/i.test(row.text));

describe('readinessRows — the cover line', () => {
  it('a cover from outside the studio repeats the gate’s refusal (it is drawn, so never "No cover yet")', () => {
    const row = coverRow(readiness([{ kind: 'cover', status: OUTSIDE_IMAGE_STATUS }]));
    expect(row).toEqual({ ok: 'warn', text: `Cover ${OUTSIDE_IMAGE_STATUS}` });
    expect(readinessRows(readiness([{ kind: 'cover', status: OUTSIDE_IMAGE_STATUS }]), makeSampleDoc()).map((r) => r.text)).not.toContain('No cover yet — the preview uses page 1');
  });

  it('a cover with no art yet keeps the "No cover yet" line, whatever stage it is at', () => {
    for (const status of ['not drawn yet', 'waiting to draw', 'drawing now', "didn't draw"]) {
      expect(coverRow(readiness([{ kind: 'cover', status }]))).toEqual({ ok: 'warn', text: 'No cover yet — the preview uses page 1' });
    }
    // No readiness at all (still loading): the same calm line, never a claim of readiness.
    expect(coverRow(undefined as unknown as PublishReadiness)).toEqual({ ok: 'warn', text: 'No cover yet — the preview uses page 1' });
  });

  it('a cover the gate accepts reads "Cover ready", and pages keep their own lines', () => {
    expect(coverRow(readiness([]))).toEqual({ ok: true, text: 'Cover ready' });
    const rows = readinessRows(readiness([{ kind: 'page', n: 2, status: OUTSIDE_IMAGE_STATUS }]), makeSampleDoc());
    expect(rows.map((r) => r.text)).toContain(`Page 2: ${OUTSIDE_IMAGE_STATUS}`);
    expect(coverRow(readiness([{ kind: 'page', n: 2, status: OUTSIDE_IMAGE_STATUS }]))).toEqual({ ok: true, text: 'Cover ready' });
  });
});

describe('readinessRows — pictures publishing leaves out (Ship 2, PD-5)', () => {
  it('lists each page’s printed photos and panel pictures in plain words, as a warning that never blocks', () => {
    const r: PublishReadiness = { ...readiness([]), leftOutPictures: [{ n: 1, photos: 1, frames: 0 }, { n: 3, photos: 2, frames: 1 }, { n: 4, photos: 0, frames: 2 }] };
    const rows = readinessRows(r, makeSampleDoc()).filter((row) => /can’t be published/.test(row.text));
    expect(rows).toEqual([
      { ok: 'warn', text: 'Page 1: 1 printed photo can’t be published — readers see the drawing there' },
      { ok: 'warn', text: 'Page 3: 2 printed photos and 1 panel picture can’t be published — readers see the drawing there' },
      { ok: 'warn', text: 'Page 4: 2 panel pictures can’t be published — readers see the drawing there' }
    ]);
    // No git words and no money in the copy.
    for (const row of rows) expect(row.text).not.toMatch(/\$|commit|branch|merge|diff/i);
  });

  it('says nothing when there is nothing left out (older views have no field) and caps the list at four pages', () => {
    expect(readinessRows(readiness([]), makeSampleDoc()).some((row) => /can’t be published/.test(row.text))).toBe(false);
    const many: PublishReadiness = { ...readiness([]), leftOutPictures: [1, 2, 3, 4, 5, 6].map((n) => ({ n, photos: 1, frames: 0 })) };
    expect(readinessRows(many, makeSampleDoc()).filter((row) => /can’t be published/.test(row.text))).toHaveLength(4);
  });

  it('renders inside the Readiness list with the warning icon (the same row as every other readiness line)', () => {
    const view = { readiness: { ...readiness([]), leftOutPictures: [{ n: 2, photos: 1, frames: 1 }] }, languages: [], allowDownload: true, allowEmbed: true, showCreator: false } as unknown as PublicationOwnerView;
    render(<PublishPanel doc={makeSampleDoc()} view={view} visibility="unlisted" onPublish={() => undefined} />);
    const item = screen.getByText('Page 2: 1 printed photo and 1 panel picture can’t be published — readers see the drawing there').closest('li')!;
    expect(item.closest('ul')!.getAttribute('aria-label')).toBe('Readiness');
    expect(item.querySelector('[aria-label="Needs attention"]')).not.toBeNull();
  });
});

/** A complete, reviewed Hindi edition (what the server's editionReadiness() calls publishable). */
const withHindi = (doc: ComicDoc): ComicDoc => {
  doc.format = { ...doc.format, language: 'en', lettering: 'overlay' };
  const lines = doc.pages.flatMap((p) => p.panels.flatMap((pn) => pn.lines)).filter((l) => l.text.trim());
  const translated = Object.fromEntries(lines.map((l) => [l.id, { text: `HI:${l.text}`, status: 'reviewed' as const, sourceHash: lineSourceHash(l), at: 1 }]));
  doc.i18n = { editions: { hi: { lang: 'hi', lines: translated, balloons: {}, register: 'everyday' } }, glossary: [] };
  return doc;
};

/** GET /publication for a never-published comic: readiness lists EVERY edition the doc holds, requested or not. */
const unpublishedView = (languages: PublishReadiness['languages']): PublicationOwnerView => ({
  visibility: 'private',
  status: null,
  languages: ['en'],
  allowDownload: true,
  allowEmbed: true,
  showCreator: false,
  publishedRev: 0,
  docRev: 3,
  behind: false,
  readiness: { ok: true, drawnPages: 3, plannedPages: 3, missing: [], stalePages: [], safety: { status: 'cleared', blockedPages: [], reasons: [] }, languages }
});

describe('PublishPanel language chips', () => {
  it('offers a finished translation on the first publish (enabled, no "not ready"), and sends it when ticked', () => {
    const doc = withHindi(makeSampleDoc());
    expect(editionReadiness(doc, 'hi').publishable).toBe(true);
    const onPublish = vi.fn();
    const view = unpublishedView([
      { lang: 'en', publishable: true, blocking: [], requested: true },
      { lang: 'hi', publishable: true, blocking: [], requested: false }
    ]);
    render(<PublishPanel doc={doc} view={view} visibility="unlisted" onPublish={onPublish} />);
    const hindi = screen.getByRole('checkbox', { name: /हिन्दी/ });
    expect(hindi).not.toBeDisabled();
    expect(hindi.closest('label')?.textContent).not.toMatch(/not ready/);
    fireEvent.click(hindi);
    fireEvent.click(screen.getByRole('button', { name: 'Publish' }));
    expect(onPublish).toHaveBeenCalledWith(expect.objectContaining({ visibility: 'unlisted', languages: ['en', 'hi'] }));
  });

  it('the original is always published: its chip stays ticked and cannot be unticked, and the request lists it first even when an old row left it out', () => {
    const doc = withHindi(makeSampleDoc());
    const onPublish = vi.fn();
    const view = { ...unpublishedView([{ lang: 'en', publishable: true, blocking: [], requested: true }, { lang: 'hi', publishable: true, blocking: [], requested: true }]), languages: ['hi'] };
    render(<PublishPanel doc={doc} view={view} visibility="unlisted" onPublish={onPublish} />);
    const english = screen.getByRole('checkbox', { name: /English/ });
    expect(english).toBeChecked();
    expect(english).toBeDisabled();
    expect(english.closest('label')?.textContent).toMatch(/original/);
    expect(screen.getByText(/Readers always get the original/)).toBeInTheDocument();
    fireEvent.click(english);
    expect(english).toBeChecked();
    // Editions can still be unticked (the original keeps the publication valid on its own).
    const hindi = screen.getByRole('checkbox', { name: /हिन्दी/ });
    expect(hindi).toBeChecked();
    expect(hindi).not.toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Publish' }));
    expect(onPublish).toHaveBeenCalledWith(expect.objectContaining({ languages: ['en', 'hi'] }));
  });

  it('an unfinished edition stays "not ready" and cannot be ticked', () => {
    const doc = withHindi(makeSampleDoc());
    const view = unpublishedView([
      { lang: 'en', publishable: true, blocking: [], requested: true },
      { lang: 'hi', publishable: false, blocking: ['2 lines waiting for review.'], requested: false }
    ]);
    render(<PublishPanel doc={doc} view={view} visibility="unlisted" onPublish={vi.fn()} />);
    const hindi = screen.getByRole('checkbox', { name: /हिन्दी/ });
    expect(hindi).toBeDisabled();
    expect(hindi.closest('label')?.textContent).toMatch(/not ready/);
  });
});

describe('PublishPanel — a published edition that went stale, and the readers\' default', () => {
  /** A live bilingual publication whose Hindi edition changed since publishing (no longer publishable). */
  const liveView = (over: Partial<PublicationOwnerView> = {}): PublicationOwnerView => ({
    ...unpublishedView([
      { lang: 'en', publishable: true, blocking: [], requested: true },
      { lang: 'hi', publishable: false, blocking: ['3 lines changed since translating.'], requested: true }
    ]),
    visibility: 'unlisted',
    status: 'live',
    slug: 'Ab3dEf6hIj9kLm2nP',
    languages: ['en', 'hi'],
    defaultLang: 'en',
    publishedRev: 3,
    ...over
  });

  it('a ticked edition that is no longer ready can be unticked (never ticked back), and the panel says why', () => {
    const doc = withHindi(makeSampleDoc());
    const onPublish = vi.fn();
    render(<PublishPanel doc={doc} view={liveView()} visibility="unlisted" onPublish={onPublish} />);
    const hindi = screen.getByRole('checkbox', { name: /हिन्दी/ });
    expect(hindi).toBeChecked();
    expect(hindi).not.toBeDisabled();
    expect(hindi.closest('label')?.textContent).toMatch(/not ready/);
    expect(screen.getByText(/Hindi isn’t ready to publish: untick it to publish without it/)).toBeInTheDocument();
    fireEvent.click(hindi);
    expect(hindi).not.toBeChecked();
    expect(hindi).toBeDisabled(); // not ready: it cannot be ticked again
    expect(screen.queryByText(/isn’t ready to publish/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Update published version' }));
    expect(onPublish).toHaveBeenCalledTimes(1);
    expect(onPublish.mock.calls[0][0].languages).toEqual(['en']);
    expect(onPublish.mock.calls[0][0]).not.toHaveProperty('defaultLang');
  });

  it('"Readers start in" picks the default edition among the ticked languages (starts at the published default)', () => {
    const doc = withHindi(makeSampleDoc());
    const onPublish = vi.fn();
    const ready = liveView({ defaultLang: 'hi', readiness: { ...liveView().readiness, languages: [{ lang: 'en', publishable: true, blocking: [], requested: true }, { lang: 'hi', publishable: true, blocking: [], requested: true }] } });
    render(<PublishPanel doc={doc} view={ready} visibility="unlisted" onPublish={onPublish} />);
    const startIn = screen.getByRole('combobox', { name: 'Readers start in' }) as HTMLSelectElement;
    expect(startIn.value).toBe('hi');
    expect([...startIn.options].map((o) => o.textContent)).toEqual(['English (original)', 'हिन्दी']);
    fireEvent.click(screen.getByRole('button', { name: 'Update published version' }));
    expect(onPublish).toHaveBeenLastCalledWith(expect.objectContaining({ languages: ['en', 'hi'], defaultLang: 'hi' }));
    fireEvent.change(startIn, { target: { value: 'en' } });
    fireEvent.click(screen.getByRole('button', { name: 'Update published version' }));
    expect(onPublish).toHaveBeenLastCalledWith(expect.objectContaining({ languages: ['en', 'hi'], defaultLang: 'en' }));
    // Only the original left: nothing to choose, and no default is sent.
    fireEvent.change(startIn, { target: { value: 'hi' } });
    fireEvent.click(screen.getByRole('checkbox', { name: /हिन्दी/ }));
    expect(screen.queryByRole('combobox', { name: 'Readers start in' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Update published version' }));
    expect(onPublish.mock.calls.at(-1)![0].languages).toEqual(['en']);
    expect(onPublish.mock.calls.at(-1)![0]).not.toHaveProperty('defaultLang');
  });

  it('a first publish that ticks a translation can start readers in it', () => {
    const doc = withHindi(makeSampleDoc());
    const onPublish = vi.fn();
    render(<PublishPanel doc={doc} view={unpublishedView([{ lang: 'en', publishable: true, blocking: [], requested: true }, { lang: 'hi', publishable: true, blocking: [], requested: false }])} visibility="unlisted" onPublish={onPublish} />);
    expect(screen.queryByRole('combobox', { name: 'Readers start in' })).toBeNull();
    fireEvent.click(screen.getByRole('checkbox', { name: /हिन्दी/ }));
    const startIn = screen.getByRole('combobox', { name: 'Readers start in' }) as HTMLSelectElement;
    expect(startIn.value).toBe('en');
    fireEvent.change(startIn, { target: { value: 'hi' } });
    fireEvent.click(screen.getByRole('button', { name: 'Publish' }));
    expect(onPublish).toHaveBeenCalledWith(expect.objectContaining({ languages: ['en', 'hi'], defaultLang: 'hi' }));
  });
});

// AH-1 (HONEST-PUBLISH): the panel never says the opposite of the truth while the owner view is on its way or
// could not be fetched. "Draw at least one page" is said only when it is true.
describe('PublishPanel — honest while the comic is being checked (AH-1)', () => {
  it('while the owner view is on its way the button reads "Checking your comic…" and nothing says "Draw at least one page"', () => {
    const onPublish = vi.fn();
    render(<PublishPanel doc={makeSampleDoc()} view={null} visibility="unlisted" check="loading" onPublish={onPublish} />);
    const checking = screen.getByRole('button', { name: 'Checking your comic…' });
    expect(checking).toBeDisabled();
    expect(checking).toHaveAttribute('aria-busy', 'true');
    expect(screen.queryByRole('button', { name: 'Publish' })).toBeNull();
    expect(screen.queryByText(/Draw at least one page/)).toBeNull();
    // The row above says the doc's own count (1 of 3), and nothing under the button contradicts it.
    expect(screen.getByText('1 of 3 pages drawn — undrawn pages are left out')).toBeInTheDocument();
    fireEvent.click(checking);
    expect(onPublish).not.toHaveBeenCalled();
  });

  it('a failed check says what happened and offers Try again; Publish waits for it', () => {
    const onRetry = vi.fn();
    const onPublish = vi.fn();
    render(<PublishPanel doc={makeSampleDoc()} view={null} visibility="unlisted" check="error" onRetry={onRetry} onPublish={onPublish} />);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Couldn’t check your comic.');
    expect(screen.queryByText(/Draw at least one page/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Publish' })).toBeDisabled();
    const retry = screen.getByRole('button', { name: 'Try again' });
    expect(retry.className).toContain('min-h-[44px]');
    fireEvent.click(retry);
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onPublish).not.toHaveBeenCalled();
  });

  it('with no owner view the drawn count is the doc’s own, the same number the readiness row shows', () => {
    const onPublish = vi.fn();
    const { unmount } = render(<PublishPanel doc={makeSampleDoc()} view={null} visibility="unlisted" onPublish={onPublish} />);
    expect(screen.getByText('1 of 3 pages drawn — undrawn pages are left out')).toBeInTheDocument();
    expect(screen.queryByText(/Draw at least one page/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Publish' }));
    expect(onPublish).toHaveBeenCalledTimes(1);
    unmount();
    // A comic with nothing drawn: the message is true, so it stays.
    const blank = makeSampleDoc();
    blank.pages = blank.pages.map((p) => ({ ...p, render: { status: 'none', history: [] } }));
    render(<PublishPanel doc={blank} view={null} visibility="unlisted" onPublish={onPublish} />);
    expect(screen.getByText('Draw at least one page to publish.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Publish' })).toBeDisabled();
  });

  it('when the server says no page is drawn, today’s message is unchanged (its count wins over the doc’s)', () => {
    const view = unpublishedView([{ lang: 'en', publishable: true, blocking: [], requested: true }]);
    view.readiness = { ...view.readiness, ok: false, drawnPages: 0 };
    render(<PublishPanel doc={makeSampleDoc()} view={view} visibility="unlisted" onPublish={vi.fn()} />);
    expect(screen.getByText('Draw at least one page to publish.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Publish' })).toBeDisabled();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Checking your comic…' })).toBeNull();
  });
});

// AH-2 (EDITIONS-ON-LINK): on a first publish every finished language starts ticked, and the ticks follow the owner
// view when it arrives. `tickReady` is the stage (the Share sheet passes it); without it the panel is as it was.
describe('PublishPanel — a first publish starts with every finished language ticked (AH-2)', () => {
  const EN = { lang: 'en', publishable: true, blocking: [], requested: true };
  const HI = { lang: 'hi', publishable: true, blocking: [], requested: false };

  it('a finished Hindi edition opens ticked, and Publish sends both languages', () => {
    const onPublish = vi.fn();
    render(<PublishPanel doc={withHindi(makeSampleDoc())} view={unpublishedView([EN, HI])} visibility="unlisted" tickReady onPublish={onPublish} />);
    const hindi = screen.getByRole('checkbox', { name: /हिन्दी/ });
    expect(hindi).toBeChecked();
    expect(hindi).not.toBeDisabled();
    // More than one language: the owner can pick where readers start (the original, unless they choose).
    expect((screen.getByRole('combobox', { name: 'Readers start in' }) as HTMLSelectElement).value).toBe('en');
    fireEvent.click(screen.getByRole('button', { name: 'Publish' }));
    expect(onPublish).toHaveBeenCalledWith(expect.objectContaining({ visibility: 'unlisted', languages: ['en', 'hi'], defaultLang: 'en' }));
  });

  it('the ticks follow the owner view when it arrives after the panel opened, and never say "not ready" before it does', () => {
    const doc = withHindi(makeSampleDoc());
    const onPublish = vi.fn();
    const { rerender } = render(<PublishPanel doc={doc} view={null} visibility="unlisted" check="loading" tickReady onPublish={onPublish} />);
    const hindi = () => screen.getByRole('checkbox', { name: /हिन्दी/ });
    expect(hindi()).not.toBeChecked();
    expect(hindi().closest('label')?.textContent).not.toMatch(/not ready/);
    rerender(<PublishPanel doc={doc} view={unpublishedView([EN, HI])} visibility="unlisted" tickReady onPublish={onPublish} />);
    expect(hindi()).toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: 'Publish' }));
    expect(onPublish).toHaveBeenCalledWith(expect.objectContaining({ languages: ['en', 'hi'] }));
  });

  it('the owner’s own choice wins: an unticked language stays unticked when the owner view refreshes', () => {
    const doc = withHindi(makeSampleDoc());
    const onPublish = vi.fn();
    const { rerender } = render(<PublishPanel doc={doc} view={unpublishedView([EN, HI])} visibility="unlisted" tickReady onPublish={onPublish} />);
    fireEvent.click(screen.getByRole('checkbox', { name: /हिन्दी/ }));
    expect(screen.getByRole('checkbox', { name: /हिन्दी/ })).not.toBeChecked();
    rerender(<PublishPanel doc={doc} view={unpublishedView([{ ...EN }, { ...HI }])} visibility="unlisted" tickReady onPublish={onPublish} />);
    expect(screen.getByRole('checkbox', { name: /हिन्दी/ })).not.toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: 'Publish' }));
    expect(onPublish.mock.calls[0][0].languages).toEqual(['en']);
  });

  it('never ticks a translation that is not finished, and stops ticking one that stops being ready', () => {
    const doc = withHindi(makeSampleDoc());
    const waiting = { ...HI, publishable: false, blocking: ['2 lines waiting for review.'] };
    const { rerender } = render(<PublishPanel doc={doc} view={unpublishedView([EN, waiting])} visibility="unlisted" tickReady onPublish={vi.fn()} />);
    const hindi = () => screen.getByRole('checkbox', { name: /हिन्दी/ });
    expect(hindi()).not.toBeChecked();
    expect(hindi()).toBeDisabled();
    expect(hindi().closest('label')?.textContent).toMatch(/not ready/);
    rerender(<PublishPanel doc={doc} view={unpublishedView([EN, HI])} visibility="unlisted" tickReady onPublish={vi.fn()} />);
    expect(hindi()).toBeChecked();
    rerender(<PublishPanel doc={doc} view={unpublishedView([EN, waiting])} visibility="unlisted" tickReady onPublish={vi.fn()} />);
    expect(hindi()).not.toBeChecked();
    expect(screen.queryByText(/isn’t ready to publish/)).toBeNull();
  });

  it('an update of a live link ticks only what the link carries (the sheet offers the rest in its own row)', () => {
    const doc = withHindi(makeSampleDoc());
    const live: PublicationOwnerView = { ...unpublishedView([EN, HI]), visibility: 'unlisted', status: 'live', slug: 'Ab3dEf6hIj9kLm2nP', languages: ['en'], defaultLang: 'en', publishedRev: 3 };
    render(<PublishPanel doc={doc} view={live} visibility="unlisted" tickReady onPublish={vi.fn()} />);
    expect(screen.getByRole('checkbox', { name: /हिन्दी/ })).not.toBeChecked();
    expect(screen.getByRole('button', { name: 'Update published version' })).toBeInTheDocument();
  });

  it('ticks no more languages than one publication carries (12 with the original)', () => {
    const doc = withHindi(makeSampleDoc());
    const langs = ['hi', 'te', 'ta', 'kn', 'ml', 'mr', 'bn', 'gu', 'pa', 'ur', 'es', 'fr', 'pt'];
    doc.i18n = { editions: Object.fromEntries(langs.map((lang) => [lang, { ...doc.i18n!.editions.hi, lang }])), glossary: [] };
    const onPublish = vi.fn();
    render(<PublishPanel doc={doc} view={unpublishedView([EN, ...langs.map((lang) => ({ ...HI, lang }))])} visibility="unlisted" tickReady onPublish={onPublish} />);
    fireEvent.click(screen.getByRole('button', { name: 'Publish' }));
    expect(onPublish.mock.calls[0][0].languages).toEqual(['en', ...langs.slice(0, 11)]);
    // The ones left out stay on offer, unticked.
    expect(screen.getByRole('checkbox', { name: /Português/ })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: /Português/ })).not.toBeDisabled();
  });

  it('without the stage the panel is as it was: the finished edition is offered, unticked', () => {
    const onPublish = vi.fn();
    render(<PublishPanel doc={withHindi(makeSampleDoc())} view={unpublishedView([EN, HI])} visibility="unlisted" onPublish={onPublish} />);
    expect(screen.getByRole('checkbox', { name: /हिन्दी/ })).not.toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: 'Publish' }));
    expect(onPublish.mock.calls[0][0].languages).toEqual(['en']);
  });
});

describe('PublishPanel', () => {
  it('shows the outside-image cover line in the readiness list, marked as needing attention', () => {
    const doc = makeSampleDoc();
    render(
      <PublishPanel
        doc={doc}
        view={{ slug: null, status: 'draft', visibility: 'unlisted', languages: ['en'], allowDownload: true, allowEmbed: true, showCreator: false, readiness: readiness([{ kind: 'cover', status: OUTSIDE_IMAGE_STATUS }]) } as never}
        visibility="unlisted"
        onPublish={vi.fn()}
      />
    );
    const list = screen.getByRole('list', { name: 'Readiness' });
    const line = Array.from(list.querySelectorAll('li')).find((li) => li.textContent?.includes(`Cover ${OUTSIDE_IMAGE_STATUS}`));
    expect(line).toBeTruthy();
    expect(line!.querySelector('[aria-label="Needs attention"]')).toBeTruthy();
    expect(screen.queryByText('No cover yet — the preview uses page 1')).toBeNull();
  });
});
