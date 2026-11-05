import React, { useEffect, useRef, useState } from 'react';
import { ArrowUpRight, Loader2 } from 'lucide-react';
import { cn } from '../../lib/utils';
import { FOCUS_ITEM, OVERLAY, OVERLINE, SCRIM } from '../chat/studioDesign';
import { buttonClasses } from '../ds';
import { EntryMark, type SiteEntries, type SiteEntry, type StudioEntryRow } from './studioEntries';
import { isPlainClick } from './siteLinks';
import { ThemeChoice } from './ThemeControls';

interface MobileMenuProps {
  id: string;
  entries: SiteEntries;
  isAuthenticated: boolean;
  onSignIn: () => void;
  onRequestAccess: () => void;
  /** Close the menu (after a row is chosen, or the scrim is pressed). */
  onClose: () => void;
  panelRef: React.RefObject<HTMLDivElement | null>;
}

const ROW = `flex min-h-11 w-full items-center gap-3 rounded-[var(--ds-radius-panel)] px-3 py-2 text-left text-[15px] transition-colors duration-[var(--ds-motion-fast)] ease-[var(--ds-ease)] ${FOCUS_ITEM}`;
const ROW_IDLE = 'text-ds-ink hover:bg-ds-overlay-hover';
// The page on screen: an ink-filled row (Atlas's active menu row). The marks, drawn in currentColor, invert with it.
const ROW_CURRENT = 'bg-ds-ink text-ds-canvas focus-visible:bg-ds-ink';

const isThenable = (value: unknown): value is PromiseLike<unknown> =>
  !!value && typeof (value as PromiseLike<unknown>).then === 'function';

/**
 * The navigation below the desktop row (< 1024 px): one panel under the header with every studio (each with
 * its mark and one line on what it is for), the public pages, the theme and, signed out, the two ways in.
 * Rows are at least 44 px tall. Escape, a press outside, the scrim and choosing a row close it; the header
 * locks the page's scroll while it is open (StaticSiteHeader).
 */
export const MobileMenu: React.FC<MobileMenuProps> = ({ id, entries, isAuthenticated, onSignIn, onRequestAccess, onClose, panelRef }) => {
  const [busy, setBusy] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => () => void (mounted.current = false), []);

  const run = (entry: SiteEntry) => {
    if (busy) return;
    const result = entry.onClick?.();
    if (isThenable(result)) {
      setBusy(entry.id);
      const settle = () => {
        if (!mounted.current) return;
        setBusy(null);
        onClose();
      };
      result.then(settle, settle);
      return;
    }
    onClose();
  };

  const link = (entry: SiteEntry, content: React.ReactNode, extra?: string) => (
    <a
      href={entry.href}
      rel={entry.external ? 'noopener' : undefined}
      aria-current={entry.current ? 'page' : undefined}
      aria-busy={busy === entry.id || undefined}
      onClick={(e) => {
        if (!entry.onClick) {
          onClose();
          return;
        }
        if (!isPlainClick(e)) return;
        e.preventDefault();
        run(entry);
      }}
      className={cn(ROW, entry.current ? ROW_CURRENT : ROW_IDLE, extra)}
    >
      {content}
    </a>
  );

  const studioRow = (entry: StudioEntryRow) => {
    const isBusy = busy === entry.id;
    const description = isBusy && entry.busyLabel ? entry.busyLabel : entry.description;
    return (
      <li key={entry.id}>
        {link(
          entry,
          <>
            <EntryMark mark={entry.mark} className="size-8" />
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-1.5 font-medium leading-5">
                {entry.label}
                {entry.badge ? (
                  <span className="rounded-[var(--ds-radius-chip)] border border-current px-1.5 py-px text-[10px] font-medium leading-4 opacity-70">{entry.badge}</span>
                ) : null}
                {entry.external ? <ArrowUpRight aria-hidden="true" className="size-3.5 opacity-60" /> : null}
              </span>
              {description ? <span className={cn('block truncate text-[13px] leading-5', entry.current ? 'text-ds-canvas/70' : 'text-ds-muted')}>{description}</span> : null}
            </span>
            {isBusy ? <Loader2 aria-hidden="true" className="size-4 shrink-0 animate-spin motion-reduce:animate-none" /> : null}
          </>,
          'py-2.5'
        )}
      </li>
    );
  };

  return (
    <>
      {/* The page dims under the menu; pressing it closes the menu. */}
      <div aria-hidden="true" onClick={onClose} className={cn(SCRIM, 'ds-fade-in fixed inset-x-0 bottom-0 top-16 lg:hidden')} />
      <div
        ref={panelRef}
        id={id}
        className={cn(
          OVERLAY,
          'ds-scale-in absolute inset-x-3 top-full mt-2 max-h-[calc(100dvh-5.5rem)] origin-top overflow-y-auto overscroll-contain rounded-[var(--ds-radius-feature)] p-1.5 sm:left-auto sm:right-6 sm:w-96 lg:hidden'
        )}
      >
        <nav aria-label="Studios and pages">
          <p className={cn(OVERLINE, 'px-3 pb-1 pt-2')}>Studios</p>
          <ul className="flex flex-col gap-0.5">{entries.studios.map(studioRow)}</ul>
          <p className={cn(OVERLINE, 'mt-2 border-t border-ds-hairline px-3 pb-1 pt-3')}>Explore</p>
          <ul className="flex flex-col gap-0.5">
            {entries.pages.map((page) => (
              <li key={page.id}>{link(page, <span className="font-medium">{page.label}</span>)}</li>
            ))}
          </ul>
        </nav>
        <div className="mt-2 flex items-center justify-between gap-4 border-t border-ds-hairline px-3 pb-2 pt-3">
          <span className="text-sm text-ds-muted">Theme</span>
          <ThemeChoice className="w-48" />
        </div>
        {!isAuthenticated ? (
          <div className="grid grid-cols-2 gap-2 border-t border-ds-hairline px-1.5 pb-1.5 pt-3">
            <button
              type="button"
              onClick={() => {
                onClose();
                onSignIn();
              }}
              className={buttonClasses({ variant: 'outline', size: 'lg', className: 'w-full rounded-full' })}
            >
              Sign in
            </button>
            <button
              type="button"
              onClick={() => {
                onClose();
                onRequestAccess();
              }}
              className={buttonClasses({ size: 'lg', className: 'w-full rounded-full' })}
            >
              Request access
            </button>
          </div>
        ) : null}
      </div>
    </>
  );
};
