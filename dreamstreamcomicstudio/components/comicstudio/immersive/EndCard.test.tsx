// The End card's actions (sharepage SPEC §5.0.5, SP-3): exactly one filled button, chosen in a fixed order
// (the next issue, then Up next, then Browse the Library; Read again only when the host gives none of them), an
// outlined "Make comics like this" link beside it, a ghost row for everything else, the display face for
// "The End" (no Bangers), 44 px targets, and the paper's focus ring on every control.
import React from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ComicDoc } from '../../../shared/comic/doc';
import { FONT_DISPLAY } from '../../chat/studioDesign';
import { makeSampleDoc } from '../board/__fixtures__/sampleDoc';
import type { ReaderLanguageSlot } from '../i18n/ReaderLanguagePicker';
import { EndCard, type EndCardActions } from './EndCard';

const LIBRARY = 'https://comics.example.test/library';
const REGISTER = 'https://comics.example.test/#register';
const UP_NEXT: NonNullable<EndCardActions['upNext']> = {
  href: '/c/brick-bridge?src=up_next',
  title: 'Brick Bridge',
  logline: 'Two rivals have one night to rebuild a bridge before the river rises.',
  coverUrl: 'https://media.example.test/pub/brick-bridge/cover-w480.webp'
};
const NEXT_ISSUE: NonNullable<EndCardActions['nextIssue']> = {
  href: '/c/saffron-thief-2',
  label: 'Issue 2',
  title: 'The Saffron Thief: The Return',
  coverUrl: 'https://media.example.test/pub/saffron-thief-2/cover-w480.webp'
};

const LANGUAGE: ReaderLanguageSlot = {
  current: 'en',
  options: [
    { code: 'en', label: 'English', native: 'English', status: 'ready' },
    { code: 'hi', label: 'Hindi', native: 'हिन्दी', status: 'ready' }
  ],
  onChange: () => undefined
};

const renderCard = (endCard: EndCardActions | undefined, extra: Partial<React.ComponentProps<typeof EndCard>> = {}, doc: ComicDoc = makeSampleDoc()) =>
  render(
    <EndCard
      doc={doc}
      endCard={endCard}
      active={false}
      chapters={[]}
      language={LANGUAGE}
      onReadAgain={() => undefined}
      onShare={() => undefined}
      onDownload={() => undefined}
      dense={false}
      {...extra}
    />
  );

const card = () => screen.getByTestId('end-card');
const primaries = () => Array.from(card().querySelectorAll('[data-primary]'));
const controls = () => Array.from(card().querySelectorAll<HTMLElement>('a, button'));
const FILLED = 'bg-[var(--ds-reader-ink)]';
const filled = () => controls().filter((el) => el.className.split(/\s+/).includes(FILLED));

describe('EndCard: one filled button, in order of preference', () => {
  it('a next issue wins over Up next and the Library: "Next: {label}" is the one filled link', () => {
    renderCard({ nextIssue: NEXT_ISSUE, upNext: UP_NEXT, browseLibraryHref: LIBRARY, makeLikeThisHref: REGISTER });
    expect(primaries()).toHaveLength(1);
    const primary = screen.getByRole('link', { name: 'Next: Issue 2' });
    expect(primary).toHaveAttribute('data-primary');
    expect(primary).toHaveAttribute('href', NEXT_ISSUE.href);
    expect(filled()).toEqual([primary]);
    expect(within(card()).getByText(NEXT_ISSUE.title)).toBeInTheDocument();
    // Up next and the Library step aside: neither is offered beside the next issue.
    expect(screen.queryByRole('link', { name: 'Read next' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Browse the Library' })).toBeNull();
  });

  it('Up next wins over the Library: a card with the cover, title and one-line logline, and the filled "Read next"', () => {
    renderCard({ upNext: UP_NEXT, browseLibraryHref: LIBRARY, makeLikeThisHref: REGISTER });
    expect(primaries()).toHaveLength(1);
    const primary = screen.getByRole('link', { name: 'Read next' });
    expect(primary).toHaveAttribute('data-primary');
    expect(primary).toHaveAttribute('href', UP_NEXT.href);
    expect(primary).toHaveAccessibleDescription(`${UP_NEXT.title} ${UP_NEXT.logline}`);
    expect(filled()).toEqual([primary]);
    const upNext = card().querySelector('[data-part="up-next"]') as HTMLElement;
    expect(upNext).toBeTruthy();
    expect(within(upNext).getByText('Up next')).toBeInTheDocument();
    expect(within(upNext).getByText(UP_NEXT.title)).toBeInTheDocument();
    const logline = within(upNext).getByText(UP_NEXT.logline!);
    expect(logline.className).toMatch(/\btruncate\b/);
    expect(screen.queryByRole('link', { name: 'Browse the Library' })).toBeNull();
  });

  it('with neither, "Browse the Library" is the one filled link', () => {
    renderCard({ browseLibraryHref: LIBRARY, makeLikeThisHref: REGISTER });
    expect(primaries()).toHaveLength(1);
    const primary = screen.getByRole('link', { name: 'Browse the Library' });
    expect(primary).toHaveAttribute('data-primary');
    expect(primary).toHaveAttribute('href', LIBRARY);
    expect(filled()).toEqual([primary]);
    expect(card().querySelector('[data-part="up-next"]')).toBeNull();
  });

  it('a host that gives none of them (the studio’s own reader) keeps Read again as the one filled button', () => {
    const onReadAgain = vi.fn();
    renderCard({}, { onReadAgain });
    expect(primaries()).toHaveLength(1);
    const again = screen.getByRole('button', { name: /Read again/ });
    expect(again).toHaveAttribute('data-primary');
    expect(filled()).toEqual([again]);
    fireEvent.click(again);
    expect(onReadAgain).toHaveBeenCalledTimes(1);
    renderCard(undefined);
    expect(screen.getAllByTestId('end-card').at(-1)!.querySelectorAll('[data-primary]')).toHaveLength(1);
  });

  it('Read again, Share, Read in … and Download sit in the ghost row beside a filled link: never filled', () => {
    const onShare = vi.fn();
    const onDownload = vi.fn();
    renderCard({ browseLibraryHref: LIBRARY }, { onShare, onDownload });
    for (const name of [/Read again/, /Share/, /Read in हिन्दी/, /Download/]) {
      const ghost = screen.getByRole('button', { name });
      expect(ghost).not.toHaveAttribute('data-primary');
      expect(ghost.className.split(/\s+/)).not.toContain(FILLED);
    }
    fireEvent.click(screen.getByRole('button', { name: /Share/ }));
    fireEvent.click(screen.getByRole('button', { name: /Download/ }));
    expect(onShare).toHaveBeenCalledTimes(1);
    expect(onDownload).toHaveBeenCalledTimes(1);
  });

  it('a link that is not a path or an http(s) address is never rendered: the next choice takes the filled slot', () => {
    renderCard({
      nextIssue: { ...NEXT_ISSUE, href: 'javascript:alert(1)' },
      upNext: { ...UP_NEXT, href: 'javascript:alert(1)' },
      browseLibraryHref: '//elsewhere.example.test/',
      makeLikeThisHref: 'data:text/html,hi'
    });
    expect(primaries()).toHaveLength(1);
    expect(screen.getByRole('button', { name: /Read again/ })).toHaveAttribute('data-primary');
    expect(card().querySelectorAll('a')).toHaveLength(0);
  });

  // The URL parser drops tab, CR and LF anywhere and reads "\" as "/", so each of these becomes //host.
  it.each(['/\t/elsewhere.example/', '/\n/elsewhere.example/', '/\r\\elsewhere.example/', '/\\elsewhere.example/', '\t//elsewhere.example/'])(
    'a path the browser would read as another host (%j) is never rendered, as a link or as a cover',
    (bad) => {
      renderCard({
        nextIssue: { ...NEXT_ISSUE, href: bad },
        upNext: { ...UP_NEXT, href: bad },
        browseLibraryHref: bad,
        makeLikeThisHref: bad
      });
      expect(card().querySelectorAll('a')).toHaveLength(0);
      expect(screen.getByRole('button', { name: /Read again/ })).toHaveAttribute('data-primary');
      cleanup();
      renderCard({ upNext: { ...UP_NEXT, coverUrl: bad } });
      expect(card().querySelector('img')).toBeNull();
    }
  );

  it('plain paths and http(s) addresses still render as typed', () => {
    renderCard({ upNext: UP_NEXT, makeLikeThisHref: '/#register' });
    expect(screen.getByRole('link', { name: 'Read next' })).toHaveAttribute('href', UP_NEXT.href);
    expect(screen.getByRole('link', { name: 'Make comics like this' })).toHaveAttribute('href', '/#register');
    expect(card().querySelector('img')).toHaveAttribute('src', UP_NEXT.coverUrl);
  });
});

describe('EndCard: the Up next card hands a tap to its one link', () => {
  // The card sits inside the reader's tap-to-turn zones (BookStage, WebtoonStage and the inline reader let a tap
  // on a link through): a tap on the cover must open the comic, never turn the page back.
  it.each([
    ['Up next', { upNext: UP_NEXT }, 'Read next', UP_NEXT],
    ['the next issue', { nextIssue: NEXT_ISSUE }, 'Next: Issue 2', NEXT_ISSUE]
  ] as const)('%s: every part of the card is inside a hidden copy of the filled link (no second tab stop)', (_label, actions, name, next) => {
    renderCard(actions);
    const primary = screen.getByRole('link', { name });
    const part = card().querySelector<HTMLElement>('[data-part="up-next"]')!;
    expect(part.tagName).toBe('A');
    expect(part).toHaveAttribute('href', primary.getAttribute('href'));
    expect(part).toHaveAttribute('tabindex', '-1');
    expect(part).toHaveAttribute('aria-hidden', 'true');
    for (const el of [part, ...Array.from(part.querySelectorAll<HTMLElement>('*'))]) expect(el.closest('a')).toBe(part);
    expect(part.querySelector('img')).toBeTruthy();
    expect(within(part).getByText(next.title).closest('a')).toBe(part);
    // Screen readers meet the comic once, on the filled link: its title (and logline) are the link's description.
    expect(screen.getAllByRole('link').filter((a) => a.getAttribute('href') === next.href)).toEqual([primary]);
    expect(primary).toHaveAccessibleDescription('logline' in next ? `${next.title} ${next.logline}` : next.title);
  });
});

describe('EndCard: "Make comics like this"', () => {
  it('is an outlined link to register interest, beside the filled one', () => {
    renderCard({ browseLibraryHref: LIBRARY, makeLikeThisHref: REGISTER });
    const make = screen.getByRole('link', { name: 'Make comics like this' });
    expect(make.tagName).toBe('A');
    expect(make).toHaveAttribute('href', REGISTER);
    expect(make).not.toHaveAttribute('data-primary');
    const classes = make.className.split(/\s+/);
    expect(classes).toContain('border');
    expect(classes).toContain('border-[var(--ds-reader-ink)]');
    expect(classes).toContain('bg-transparent');
    expect(classes).not.toContain(FILLED);
    // It shares the row with the filled link.
    expect(make.parentElement).toBe(screen.getByRole('link', { name: 'Browse the Library' }).parentElement);
  });

  it('is absent when the host gives no address (the owner, an embed)', () => {
    renderCard({ browseLibraryHref: LIBRARY });
    expect(screen.queryByRole('link', { name: 'Make comics like this' })).toBeNull();
  });

  it('the accent "Make your own comic" is gone, and nothing on the card reads the app accent', () => {
    renderCard({ upNext: UP_NEXT, browseLibraryHref: LIBRARY, makeLikeThisHref: REGISTER });
    expect(within(card()).queryByText(/Make your own/)).toBeNull();
    for (const el of [card(), ...Array.from(card().querySelectorAll<HTMLElement>('*'))]) {
      expect(String(el.getAttribute('class') ?? '')).not.toMatch(/--ds-accent/);
    }
  });
});

describe('EndCard: type, images, targets and focus', () => {
  it('"The End" is in the display face; no inline style names Bangers', () => {
    renderCard({ upNext: UP_NEXT, browseLibraryHref: LIBRARY, makeLikeThisHref: REGISTER });
    const heading = screen.getByRole('heading', { name: 'The End' });
    expect(heading.className.split(/\s+/)).toContain(FONT_DISPLAY);
    const styled = [card(), ...Array.from(card().querySelectorAll<HTMLElement>('[style]'))];
    for (const el of styled) expect(el.getAttribute('style') ?? '').not.toMatch(/bangers/i);
  });

  it('the Up next and next-issue covers load lazily and are decorative', () => {
    const { unmount } = renderCard({ upNext: UP_NEXT, browseLibraryHref: LIBRARY });
    const img = card().querySelector('[data-part="up-next"] img') as HTMLImageElement;
    expect(img).toBeTruthy();
    expect(img).toHaveAttribute('src', UP_NEXT.coverUrl);
    expect(img).toHaveAttribute('loading', 'lazy');
    expect(img).toHaveAttribute('decoding', 'async');
    expect(img).toHaveAttribute('alt', '');
    unmount();
    renderCard({ nextIssue: NEXT_ISSUE });
    const next = card().querySelector('[data-part="up-next"] img') as HTMLImageElement;
    expect(next).toHaveAttribute('src', NEXT_ISSUE.coverUrl);
    expect(next).toHaveAttribute('loading', 'lazy');
  });

  it('a card without a cover shows no image (no broken image box)', () => {
    renderCard({ upNext: { ...UP_NEXT, coverUrl: undefined } });
    expect(card().querySelector('[data-part="up-next"]')).toBeTruthy();
    expect(card().querySelector('img')).toBeNull();
  });

  it('every action is at least 44 px tall (min-h-11), in the dense layout too', () => {
    for (const dense of [false, true]) {
      const { unmount } = renderCard({ upNext: UP_NEXT, browseLibraryHref: LIBRARY, makeLikeThisHref: REGISTER }, { dense });
      expect(controls().length).toBeGreaterThanOrEqual(6);
      for (const el of controls()) expect(el.className.split(/\s+/), el.textContent ?? '').toContain('min-h-11');
      unmount();
    }
  });

  it('every action takes the paper’s focus ring (the End card is a page), never the app ring', () => {
    renderCard({ nextIssue: NEXT_ISSUE, makeLikeThisHref: REGISTER });
    for (const el of controls()) {
      const classes = el.className.split(/\s+/);
      expect(classes, el.textContent ?? '').toContain('focus-visible:ring-[var(--ds-reader-focus)]');
      expect(classes, el.textContent ?? '').toContain('focus-visible:ring-offset-[var(--ds-reader-paper-back)]');
      expect(el.className).not.toMatch(/--ds-focus\b|--ds-ring\b/);
    }
  });

  it('focus lands on "The End" when the reader arrives, and credits and cast still show', () => {
    renderCard({ authorName: 'A. Writer', browseLibraryHref: LIBRARY }, { active: true });
    expect(screen.getByRole('heading', { name: 'The End' })).toHaveFocus();
    expect(within(card()).getByText(/Starring/)).toBeInTheDocument();
    expect(within(card()).getByText('Made with DreamStream')).toBeInTheDocument();
  });
});
