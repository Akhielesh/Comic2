// The read-only link field + Copy + Share… with a "Link options" disclosure (language, start
// page). Every share action tags ?via= for analytics. 44 px targets; the URL field scrolls
// instead of overflowing; copy is announced through aria-live.

import React, { useMemo, useState } from 'react';
import { Check, ChevronDown, Copy, Share2 } from 'lucide-react';
import type { PublicationOwnerView } from '../../../shared/comic/publication';
import { languageSpec } from '../../../shared/comic/languages';
import { shareLinkFor } from './shareModel';
import { useShareCapabilities } from './useShareCapabilities';
import { cx } from '../conversation/ui';

export interface ShareLinkCardProps {
  view: PublicationOwnerView;
  title: string;
  description?: string;
  /** Called when native share is unavailable or failed (show the fallback list). */
  onFallback?: (url: string) => void;
  pageCount?: number;
}

const btn =
  'inline-flex min-h-[44px] items-center justify-center gap-1.5 rounded-xl px-4 text-[14px] font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#D97757]/50 touch-manipulation';

export const ShareLinkCard: React.FC<ShareLinkCardProps> = ({ view, title, description, onFallback, pageCount }) => {
  const caps = useShareCapabilities();
  const [lang, setLang] = useState<string | undefined>(undefined);
  const [page, setPage] = useState<number | undefined>(undefined);
  const [copied, setCopied] = useState(false);
  const [open, setOpen] = useState(false);
  const url = useMemo(() => shareLinkFor(view, { lang, page }) || '', [view, lang, page]);
  if (!url) return null;
  const withVia = (via: 'copy' | 'native') => shareLinkFor(view, { lang, page, via }) || url;

  const copy = async () => {
    const ok = await caps.copy(withVia('copy'));
    setCopied(ok);
    if (ok) window.setTimeout(() => setCopied(false), 2500);
  };
  const share = async () => {
    const result = await caps.share({ title, text: description, url: withVia('native') });
    if (result === 'fallback') onFallback?.(url);
  };

  return (
    <div className="min-w-0 space-y-2">
      <label htmlFor="ds-share-url" className="block text-[11px] font-semibold uppercase tracking-wider text-[var(--ds-muted)]">
        Read-only link
      </label>
      <input
        id="ds-share-url"
        readOnly
        value={url}
        onFocus={(e) => e.currentTarget.select()}
        className="block h-11 w-full min-w-0 overflow-x-auto text-ellipsis rounded-xl border border-[var(--ds-hairline)] bg-[var(--ds-well)] px-3 font-mono text-[13px] text-[var(--ds-ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#D97757]/40"
      />
      <div className="grid grid-cols-2 gap-2">
        <button type="button" onClick={copy} className={cx(btn, 'border border-[var(--ds-hairline)] bg-[var(--ds-surface-soft)] text-[var(--ds-ink)] hover:bg-[var(--ds-hover)]')}>
          {copied ? <Check className="h-4 w-4" aria-hidden /> : <Copy className="h-4 w-4" aria-hidden />}
          {copied ? 'Copied' : 'Copy'}
        </button>
        <button type="button" onClick={share} className={cx(btn, 'bg-[var(--ds-accent)] text-white hover:bg-[var(--ds-accent-hover)]')}>
          <Share2 className="h-4 w-4" aria-hidden /> Share…
        </button>
      </div>
      <span className="sr-only" aria-live="polite">
        {copied ? 'Link copied' : ''}
      </span>
      <div>
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          className="inline-flex min-h-[44px] items-center gap-1 rounded-lg px-1 text-[13px] font-medium text-[var(--ds-muted)] hover:text-[var(--ds-ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#D97757]/40"
        >
          <ChevronDown className={cx('h-4 w-4 transition-transform motion-reduce:transition-none', open && 'rotate-180')} aria-hidden /> Link options
        </button>
        {open && (
          <div className="mt-1 flex flex-wrap gap-3">
            {view.languages.length > 1 && (
              <label className="flex min-w-0 items-center gap-2 text-[13px] text-[var(--ds-ink)]">
                Language
                <select
                  value={lang || ''}
                  onChange={(e) => setLang(e.target.value || undefined)}
                  className="h-11 min-w-0 rounded-xl border border-[var(--ds-hairline)] bg-[var(--ds-surface-soft)] px-2 text-[13px]"
                >
                  <option value="">Reader’s default</option>
                  {view.languages.map((l) => (
                    <option key={l} value={l}>
                      {languageSpec(l)?.endonym || l}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label className="flex items-center gap-2 text-[13px] text-[var(--ds-ink)]">
              Open at page
              <input
                type="number"
                min={1}
                max={pageCount || 500}
                inputMode="numeric"
                value={page ?? ''}
                placeholder="1"
                onChange={(e) => {
                  const n = Number(e.target.value);
                  setPage(Number.isInteger(n) && n >= 1 ? Math.min(n, pageCount || 500) : undefined);
                }}
                className="h-11 w-20 rounded-xl border border-[var(--ds-hairline)] bg-[var(--ds-surface-soft)] px-2 text-[13px] tabular-nums"
              />
            </label>
          </div>
        )}
      </div>
    </div>
  );
};

export default ShareLinkCard;
