// Comic History — read the book as it was (versions plan §5 "Read a version", §1 story 3; package H5).
//
// The reassembled, normalized book of one moment in the real reader (ComicReaderView: page, spread, guided view on
// phones, every language edition) — read-only: no editing, no downloads, no sharing, and the live book is never
// touched. A banner says so: "Viewing Tue 10:42 — read-only", with [Compare with now] [Restore…] [Back to now].

import React, { useMemo } from 'react';
import { Eye } from 'lucide-react';
import { i18nOf } from '../../../shared/comic/i18n';
import { languageSpec } from '../../../shared/comic/languages';
import { STATUS_SURFACE } from '../../chat/studioDesign';
import { ComicReaderView } from '../reader/ComicReaderView';
import type { ReaderLanguageSlot } from '../i18n/ReaderLanguagePicker';
import { whenText } from './historyModel';
import { useVersionBook, type HistoryStudio } from './useHistory';
import { cx, Note, PrimaryBtn, QuietBtn } from './ui';

export interface VersionReaderProps {
  studio: HistoryStudio;
  versionId: string;
  now: number;
  tz: string;
  onCompare(versionId: string): void;
  onRestore(versionId: string): void;
  onBack(): void;
}

export const VersionReader: React.FC<VersionReaderProps> = ({ studio, versionId, now, tz, onCompare, onRestore, onBack }) => {
  const { book, loading, error, urlFor, reload } = useVersionBook(studio, versionId);
  const [lang, setLang] = React.useState<string | null>(null);
  const editions = useMemo(() => (book ? Object.keys(i18nOf(book.doc).editions).sort() : []), [book]);
  if (loading && !book) return <Note>Opening this version…</Note>;
  if (error) return <Note tone="attention" action={<QuietBtn onClick={reload}>Try again</QuietBtn>}>{error}</Note>;
  if (!book) return null;
  const at = book.row ? book.row.name || whenText(book.row.contentAt, now, tz) : 'this moment';
  const source = book.doc.format.language;
  const languages = [source, ...editions.filter((l) => l !== source)];
  const slot: ReaderLanguageSlot | null =
    languages.length > 1 ? { current: lang ?? source, options: languages.map((code) => ({ code, label: languageSpec(code)?.english || code })), onChange: (code) => setLang(code) } : null;
  return (
    <section aria-label={`Viewing ${at}, read-only`} className="flex min-h-0 min-w-0 flex-col" data-version-reader data-readonly="true">
      <div role="status" className={cx('mx-4 mt-2 flex min-w-0 flex-wrap items-center gap-2 border px-3 py-2', 'rounded-[var(--ds-radius-control)]', STATUS_SURFACE.active)}>
        <Eye className="h-4 w-4 shrink-0 text-[var(--ds-ink)]" aria-hidden />
        <p className="m-0 min-w-0 flex-1 text-[13px] font-medium text-[var(--ds-ink)] [overflow-wrap:anywhere]">
          Viewing {at} — read-only
        </p>
      </div>
      <div className="min-h-0 min-w-0 flex-1 px-2 py-2" data-reader-host>
        <ComicReaderView
          key={versionId}
          doc={book.doc}
          urlFor={urlFor}
          autoFocus={false}
          syncUrl={false}
          allowDownload={false}
          zoomable
          {...(slot ? { language: slot } : {})}
        />
      </div>
      <div className="sticky bottom-0 flex min-w-0 flex-wrap gap-2 border-t border-[var(--ds-hairline)] bg-[var(--ds-surface-strong)] px-4 py-2" style={{ paddingBottom: 'calc(var(--sa-bottom-eff, 0px) + 8px)' }}>
        <QuietBtn onClick={() => onCompare(versionId)} className="flex-1">
          Compare with now
        </QuietBtn>
        <QuietBtn onClick={() => onRestore(versionId)} className="flex-1">
          Restore…
        </QuietBtn>
        <PrimaryBtn onClick={onBack} className="flex-1">
          Back to now
        </PrimaryBtn>
      </div>
    </section>
  );
};

export default VersionReader;
