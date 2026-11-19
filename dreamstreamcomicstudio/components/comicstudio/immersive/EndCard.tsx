// The End card (reader.md §6.3; sharepage SPEC §5.0.5): the last page of the book. "The End" in the display
// face, the title, the creator's credits line (or the public author name — never an email), who starred, and
// what to do next. Exactly one filled button, in this order of preference: the next issue of a series, Up next
// (a comic to read next, with its cover), Browse the Library; Read again only when the host gives none of them.
// Beside it, an outlined "Make comics like this" (register interest; the host leaves it out for the owner and in
// embeds). Everything else (Read again, Share, another language, Download) is a ghost row. Focus lands on the
// heading when the reader arrives here. The End card is a page: its focus ring is the paper's
// (--ds-reader-focus, ≥ 4.5:1 on the paper in both themes), never the app accent, and it takes no colour.

import React from 'react';
import { ArrowRight, Download, Languages, LibraryBig, RotateCcw, Share2 } from 'lucide-react';
import type { ComicDoc } from '../../../shared/comic/doc';
import { readerOf } from '../../../shared/comic/doc';
import { FONT_DISPLAY, RADIUS_PANEL, RADIUS_ROUND } from '../../chat/studioDesign';
import type { ReaderLanguageSlot } from '../i18n/ReaderLanguagePicker';

/**
 * What the host offers after the last page (ImmersiveReaderEndCard is this type). Every address is optional:
 * an absent one hides its action, and only a same-origin path or an http(s) address is ever rendered.
 */
export interface EndCardActions {
  /** The public author name: "Created by {name}" when the comic carries no credits line. */
  authorName?: string;
  /** The link Share passes on (the reader's own share: Web Share, else the clipboard). */
  shareUrl?: string;
  /** The next issue of a series (the studio program's series): the filled "Next: {label}". */
  nextIssue?: { href: string; label: string; title: string; coverUrl?: string };
  /** A comic to read next on this device (the w480 cover): the filled "Read next". */
  upNext?: { href: string; title: string; logline?: string; coverUrl?: string };
  /** The public Library: the filled button when there is nothing to read next. */
  browseLibraryHref?: string;
  /** Register interest on the comics landing: the outlined "Make comics like this". */
  makeLikeThisHref?: string;
}

export interface EndCardProps {
  doc: ComicDoc;
  endCard?: EndCardActions;
  active: boolean;
  chapters: { n: number; title: string }[];
  language?: ReaderLanguageSlot;
  onReadAgain(): void;
  onShare?: () => void;
  onDownload?: () => void;
  downloadBusy?: boolean;
  /** Compact type for small page boxes. */
  dense: boolean;
}

/** The card's words in one place (the reader's chrome copy moves to i18n/readerStrings with the title page). */
const COPY = {
  theEnd: 'The End',
  createdBy: (name: string) => `Created by ${name}`,
  starring: (names: string) => `Starring ${names}`,
  upNext: 'Up next',
  readNext: 'Read next',
  nextIssue: (label: string) => `Next: ${label}`,
  browseLibrary: 'Browse the Library',
  makeComicsLikeThis: 'Make comics like this',
  readAgain: 'Read again',
  share: 'Share',
  readIn: (name: string) => `Read in ${name}`,
  download: 'Download',
  preparing: 'Preparing…',
  madeWith: 'Made with DreamStream'
};

/** A same-origin path or an http(s) address; anything else (javascript:, data:, a protocol-relative //host) is dropped. */
const safeHref = (href: string | undefined): string | undefined => {
  const h = href?.trim();
  if (!h) return undefined;
  return /^\/(?![/\\])/.test(h) || /^https?:\/\//i.test(h) ? h : undefined;
};

type Primary =
  | { kind: 'nextIssue'; href: string; label: string; title: string; coverUrl?: string }
  | { kind: 'upNext'; href: string; label: string; title: string; logline?: string; coverUrl?: string }
  | { kind: 'library'; href: string; label: string }
  | { kind: 'readAgain' };

/** The one filled action (SPEC §5.0.5): next issue > Up next > Browse the Library > Read again. */
const primaryOf = (a: EndCardActions | undefined): Primary => {
  const next = a?.nextIssue && safeHref(a.nextIssue.href);
  if (next && a?.nextIssue) return { kind: 'nextIssue', href: next, label: COPY.nextIssue(a.nextIssue.label), title: a.nextIssue.title, coverUrl: safeHref(a.nextIssue.coverUrl) };
  const up = a?.upNext && safeHref(a.upNext.href);
  if (up && a?.upNext) return { kind: 'upNext', href: up, label: COPY.readNext, title: a.upNext.title, logline: a.upNext.logline, coverUrl: safeHref(a.upNext.coverUrl) };
  const library = safeHref(a?.browseLibraryHref);
  if (library) return { kind: 'library', href: library, label: COPY.browseLibrary };
  return { kind: 'readAgain' };
};

/** Every action: a 44 px pill with the paper's focus ring (offset on the paper, so it reads on any page colour). */
const BTN = `press inline-flex min-h-11 max-w-full items-center justify-center gap-2 ${RADIUS_ROUND} font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-[var(--ds-reader-focus)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--ds-reader-paper-back)]`;
/** The one filled action: ink on the paper. */
const FILLED = `${BTN} px-5 text-[14px] bg-[var(--ds-reader-ink)] text-[var(--ds-reader-paper-back)] hover:opacity-90`;
/** The outlined action beside it: an ink hairline, no fill. */
const OUTLINED = `${BTN} px-5 text-[14px] border border-[var(--ds-reader-ink)] bg-transparent text-[var(--ds-reader-ink)] hover:bg-[var(--ds-reader-wash)]`;
/** The ghost row: words and an icon, a wash only on hover. */
const GHOST = `${BTN} px-4 text-[13px] bg-transparent text-[var(--ds-reader-ink)] hover:bg-[var(--ds-reader-wash)]`;

export const EndCard: React.FC<EndCardProps> = ({ doc, endCard, active, chapters, language, onReadAgain, onShare, onDownload, downloadBusy, dense }) => {
  const heading = React.useRef<HTMLHeadingElement>(null);
  const nextTitleId = React.useId();
  React.useEffect(() => {
    if (active) heading.current?.focus({ preventScroll: true });
  }, [active]);
  const reader = readerOf(doc);
  const credits = reader.credits || (endCard?.authorName ? COPY.createdBy(endCard.authorName) : undefined);
  const stars = doc.cast.filter((c) => c.tier === 'lead' || c.tier === 'support').map((c) => c.name).filter(Boolean);
  const title = doc.cover.title || doc.brief.title;
  // An edition without a status is a published one (the slot only marks 'ready' explicitly when it can).
  const otherLang = language && language.options.find((o) => o.code !== language.current && (o.status === undefined || o.status === 'ready'));
  const primary = primaryOf(endCard);
  const makeHref = safeHref(endCard?.makeLikeThisHref);
  const next = primary.kind === 'nextIssue' || primary.kind === 'upNext' ? primary : null;
  const readAgain = (
    <button type="button" onClick={onReadAgain} className={primary.kind === 'readAgain' ? FILLED : GHOST} data-primary={primary.kind === 'readAgain' ? '' : undefined}>
      <RotateCcw className="h-4 w-4" aria-hidden /> {COPY.readAgain}
    </button>
  );
  return (
    <div className="absolute inset-0 overflow-y-auto overscroll-contain text-[var(--ds-reader-ink)]" style={{ containerType: 'inline-size' }} data-testid="end-card">
      <div className={`flex min-h-full flex-col items-center justify-center ${dense ? 'gap-2' : 'gap-3'} px-[8%] py-[8%] text-center`}>
        <h2
          ref={heading}
          tabIndex={-1}
          className={`${FONT_DISPLAY} font-semibold tracking-[-0.02em] outline-none`}
          style={{ fontSize: dense ? 'clamp(28px, 9cqw, 44px)' : 'clamp(36px, 10cqw, 64px)', lineHeight: 1 }}
        >
          {COPY.theEnd}
        </h2>
        {title && <p className="max-w-full text-[15px] font-semibold [overflow-wrap:anywhere]">{title}</p>}
        {credits && <p className="max-w-full text-[13px] text-[var(--ds-reader-ink-soft)] [overflow-wrap:anywhere]">{credits}</p>}
        {stars.length > 0 && <p className="max-w-full text-[12px] text-[var(--ds-reader-ink-soft)] [overflow-wrap:anywhere]">{COPY.starring(stars.slice(0, 6).join(', '))}</p>}
        {chapters.length > 1 && !dense && (
          <ol className="max-w-full text-[12px] text-[var(--ds-reader-ink-soft)]">
            {chapters.slice(0, 8).map((c) => (
              <li key={c.n} className="truncate">
                p{c.n} · {c.title}
              </li>
            ))}
          </ol>
        )}
        {next && (
          <div data-part="up-next" className={`mt-2 flex w-full max-w-[22rem] items-center gap-3 ${RADIUS_PANEL} bg-[var(--ds-reader-wash)] p-2 text-start`}>
            {next.coverUrl && (
              <img
                src={next.coverUrl}
                alt=""
                loading="lazy"
                decoding="async"
                className={`${dense ? 'w-10' : 'w-14'} aspect-[2/3] shrink-0 rounded-[var(--ds-radius-sm)] bg-[var(--ds-reader-wash-strong)] object-cover`}
              />
            )}
            <div className="min-w-0 flex-1">
              <p className="text-[11px] font-medium text-[var(--ds-reader-ink-soft)]">{COPY.upNext}</p>
              <p id={nextTitleId} dir="auto" className="line-clamp-2 text-[14px] font-semibold [overflow-wrap:anywhere]">
                {next.title}
              </p>
              {next.kind === 'upNext' && next.logline && (
                <p dir="auto" className="truncate text-[12px] text-[var(--ds-reader-ink-soft)]">
                  {next.logline}
                </p>
              )}
            </div>
          </div>
        )}
        <div className="mt-2 flex max-w-full flex-wrap justify-center gap-2">
          {primary.kind === 'readAgain' ? (
            readAgain
          ) : (
            <a href={primary.href} className={FILLED} data-primary="" aria-describedby={next ? nextTitleId : undefined}>
              {primary.kind === 'library' ? <LibraryBig className="h-4 w-4" aria-hidden /> : null}
              {primary.label}
              {next ? <ArrowRight className="h-4 w-4" aria-hidden /> : null}
            </a>
          )}
          {makeHref && (
            <a href={makeHref} className={OUTLINED}>
              {COPY.makeComicsLikeThis}
            </a>
          )}
        </div>
        {(primary.kind !== 'readAgain' || onShare || otherLang || onDownload) && (
          <div className="flex max-w-full flex-wrap justify-center gap-1">
            {primary.kind !== 'readAgain' && readAgain}
            {onShare && (
              <button type="button" onClick={onShare} className={GHOST}>
                <Share2 className="h-4 w-4" aria-hidden /> {COPY.share}
              </button>
            )}
            {otherLang && (
              <button type="button" onClick={() => language!.onChange(otherLang.code)} className={GHOST}>
                <Languages className="h-4 w-4" aria-hidden /> {COPY.readIn(otherLang.native || otherLang.label)}
              </button>
            )}
            {onDownload && (
              <button type="button" onClick={onDownload} disabled={downloadBusy} className={`${GHOST} disabled:opacity-50`}>
                <Download className="h-4 w-4" aria-hidden /> {downloadBusy ? COPY.preparing : COPY.download}
              </button>
            )}
          </div>
        )}
        <p className="mt-2 text-[11px] tracking-wide text-[var(--ds-reader-ink-faint)]">{COPY.madeWith}</p>
      </div>
    </div>
  );
};

export default EndCard;
