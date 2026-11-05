// The End card (reader.md §6.3): the last page of the book. "The End", the title, the creator's credits
// line (or the public author name — never an email), who starred, and what to do next: read again,
// Guided replay, share, another language, download, make your own. Focus lands on the heading when
// the reader arrives here.

import React from 'react';
import { Download, Languages, RotateCcw, ScanEye, Share2, Sparkles } from 'lucide-react';
import type { ComicDoc } from '../../../shared/comic/doc';
import { readerOf } from '../../../shared/comic/doc';
import type { ReaderLanguageSlot } from '../i18n/ReaderLanguagePicker';
import type { ImmersiveReaderEndCard } from './ImmersiveReader';

export interface EndCardProps {
  doc: ComicDoc;
  endCard?: ImmersiveReaderEndCard;
  active: boolean;
  chapters: { n: number; title: string }[];
  language?: ReaderLanguageSlot;
  onReadAgain(): void;
  onGuidedReplay?: () => void;
  onShare?: () => void;
  onDownload?: () => void;
  downloadBusy?: boolean;
  /** Compact type for small page boxes. */
  dense: boolean;
}

const btn =
  'press inline-flex min-h-11 items-center justify-center gap-2 rounded-full px-4 text-[13px] font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-[var(--ds-accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--ds-reader-paper-back)]';

export const EndCard: React.FC<EndCardProps> = ({ doc, endCard, active, chapters, language, onReadAgain, onGuidedReplay, onShare, onDownload, downloadBusy, dense }) => {
  const heading = React.useRef<HTMLHeadingElement>(null);
  React.useEffect(() => {
    if (active) heading.current?.focus({ preventScroll: true });
  }, [active]);
  const reader = readerOf(doc);
  const credits = reader.credits || (endCard?.authorName ? `Created by ${endCard.authorName}` : undefined);
  const stars = doc.cast.filter((c) => c.tier === 'lead' || c.tier === 'support').map((c) => c.name).filter(Boolean);
  const title = doc.cover.title || doc.brief.title;
  // An edition without a status is a published one (the slot only marks 'ready' explicitly when it can).
  const otherLang = language && language.options.find((o) => o.code !== language.current && (o.status === undefined || o.status === 'ready'));
  return (
    <div className="absolute inset-0 overflow-y-auto overscroll-contain text-[var(--ds-reader-ink)]" style={{ containerType: 'inline-size' }} data-testid="end-card">
      <div className={`flex min-h-full flex-col items-center justify-center ${dense ? 'gap-2' : 'gap-3'} px-[8%] py-[8%] text-center`}>
        <h2
          ref={heading}
          tabIndex={-1}
          className="outline-none"
          style={{ fontFamily: 'Bangers, ui-sans-serif, system-ui', fontSize: dense ? 'clamp(28px, 9cqw, 44px)' : 'clamp(36px, 10cqw, 64px)', letterSpacing: '0.04em', lineHeight: 1 }}
        >
          The End
        </h2>
        {title && <p className="max-w-full text-[15px] font-semibold [overflow-wrap:anywhere]">{title}</p>}
        {credits && <p className="max-w-full text-[13px] text-[var(--ds-reader-ink-soft)] [overflow-wrap:anywhere]">{credits}</p>}
        {stars.length > 0 && <p className="max-w-full text-[12px] text-[var(--ds-reader-ink-soft)] [overflow-wrap:anywhere]">Starring {stars.slice(0, 6).join(', ')}</p>}
        {chapters.length > 1 && !dense && (
          <ol className="max-w-full text-[12px] text-[var(--ds-reader-ink-soft)]">
            {chapters.slice(0, 8).map((c) => (
              <li key={c.n} className="truncate">
                p{c.n} · {c.title}
              </li>
            ))}
          </ol>
        )}
        <div className="mt-2 flex max-w-full flex-wrap justify-center gap-2">
          <button type="button" onClick={onReadAgain} className={`${btn} bg-[var(--ds-reader-ink)] text-[var(--ds-reader-paper-back)] hover:opacity-90`}>
            <RotateCcw className="h-4 w-4" aria-hidden /> Read again
          </button>
          {onGuidedReplay && (
            <button type="button" onClick={onGuidedReplay} className={`${btn} bg-[var(--ds-reader-wash)] hover:bg-[var(--ds-reader-wash-strong)]`}>
              <ScanEye className="h-4 w-4" aria-hidden /> Guided replay
            </button>
          )}
          {onShare && (
            <button type="button" onClick={onShare} className={`${btn} bg-[var(--ds-reader-wash)] hover:bg-[var(--ds-reader-wash-strong)]`}>
              <Share2 className="h-4 w-4" aria-hidden /> Share
            </button>
          )}
          {otherLang && (
            <button type="button" onClick={() => language!.onChange(otherLang.code)} className={`${btn} bg-[var(--ds-reader-wash)] hover:bg-[var(--ds-reader-wash-strong)]`}>
              <Languages className="h-4 w-4" aria-hidden /> Read in {otherLang.native || otherLang.label}
            </button>
          )}
          {onDownload && (
            <button type="button" onClick={onDownload} disabled={downloadBusy} className={`${btn} bg-[var(--ds-reader-wash)] hover:bg-[var(--ds-reader-wash-strong)] disabled:opacity-50`}>
              <Download className="h-4 w-4" aria-hidden /> {downloadBusy ? 'Preparing…' : 'Download'}
            </button>
          )}
          {endCard?.onMakeYourOwn && (
            <button type="button" onClick={endCard.onMakeYourOwn} className={`${btn} bg-[var(--ds-accent)] text-white hover:bg-[var(--ds-accent-hover)]`}>
              <Sparkles className="h-4 w-4" aria-hidden /> Make your own comic
            </button>
          )}
        </div>
        <p className="mt-2 text-[11px] tracking-wide text-[var(--ds-reader-ink-faint)]">Made with DreamStream</p>
      </div>
    </div>
  );
};

export default EndCard;
