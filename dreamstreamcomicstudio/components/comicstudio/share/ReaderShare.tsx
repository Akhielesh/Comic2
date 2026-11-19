// The reader's Share on a share link (share title page SP-2; sharing.md §7.3). Web Share first: one tap hands the
// title and the link to the system share sheet. Without it (desktop browsers, most in-app browsers) a small ds Menu
// opens instead: Copy link, the channel intents (WhatsApp, X, Telegram, Facebook, Email) and LinkedIn, each link tagged
// with its channel. After a switch to a non-default edition the caller passes `editionLink` and the menu adds "Copy
// link to the {language} edition"; the menu then always opens (with a "Share…" row when Web Share exists), so the
// edition stays one tap away on phones too, while the plain Share still passes on the bare link.
//
// `onShared(channel)` fires once per share: each completed Web Share, and each channel (Copy link, an intent, LinkedIn)
// once per opening of the menu, so Copy link then WhatsApp counts both and a second copy counts nothing. Opening the
// menu, a closed share sheet and a failed copy are not shares.
//
// A copy can go through a hidden field in the page (no Clipboard API, or one that refuses, as in-app browsers do):
// focus moves there for a moment, which is not a step out of the menu, so the menu stays open, the row says what
// happened, and focus comes back to the row.
//
// Read-only by construction: no studio controller, no network, no studio API. It imports none of the studio's Share
// sheet code (ReaderShare.test.tsx walks its imports), so the share title page can load it without the sheet.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Link2, Share2 } from 'lucide-react';
import { DENSITY } from '../../chat/studioDesign';
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '../../ds/Menu';
import { CHANNEL_LABEL, INTENT_CHANNELS, intentUrl, type IntentChannel } from './shareModel';
import { readerShareTriggerClass } from './readerShareTrigger';
import { LINKEDIN_LABEL, linkedinShareUrl, withVia } from './shareTargets';
import { useShareCapabilities } from './useShareCapabilities';

/** How a reader shared: the system share sheet, a copied link, a channel intent or LinkedIn. */
export type ReaderShareChannel = 'native' | 'copy' | IntentChannel | 'linkedin';

/** The words around the menu. The page passes the edition's own (the reader strings); channel names stay as they are. */
export interface ReaderShareLabels {
  share: string;
  shareNative: string;
  copyLink: string;
  copied: string;
  copyFailed: string;
}

export const READER_SHARE_LABELS: ReaderShareLabels = {
  share: 'Share',
  shareNative: CHANNEL_LABEL.native,
  copyLink: CHANNEL_LABEL.copy,
  copied: 'Link copied',
  copyFailed: 'Couldn’t copy. Copy it from the address bar.'
};

export interface ReaderShareProps {
  /** The link to pass on (shareTargets.shareLinkFor). */
  url: string;
  title: string;
  /** Extra words for the system share sheet (the logline). */
  text?: string;
  /** "Copy link to the {language} edition" and its link, after a switch to a non-default edition (editionLinkFor). */
  editionLink?: { label: string; url: string };
  /** Icon only (a 44 × 44 slot); the label is then the button's name. */
  compact?: boolean;
  onShared?: (channel: ReaderShareChannel) => void;
  labels?: Partial<ReaderShareLabels>;
  /** Open the menu at mount: a Share tap the page recorded before the app was ready. */
  defaultOpen?: boolean;
  className?: string;
}

/** Every row is a 44 px target (the menu's rows are 44 px under a coarse pointer only). */
const ROW = DENSITY.touch;
/** The width the reader's share popover always had (so the stylesheet gains nothing). */
const MENU_WIDTH = 'w-[min(260px,calc(100vw-24px))]';

type CopyTarget = 'link' | 'edition';

export const ReaderShare: React.FC<ReaderShareProps> = ({ url, title, text, editionLink, compact, onShared, labels, defaultOpen = false, className }) => {
  const caps = useShareCapabilities();
  const words: ReaderShareLabels = { ...READER_SHARE_LABELS, ...labels };
  const [open, setOpenState] = useState(defaultOpen);
  const [copied, setCopied] = useState<CopyTarget | null>(null);
  const [failed, setFailed] = useState<CopyTarget | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const sharing = useRef(false);
  /** The channels already reported in this opening of the menu. */
  const reported = useRef(new Set<ReaderShareChannel>());
  /** Copies in flight: their hidden field takes focus outside the menu for a moment. */
  const copying = useRef(0);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  // A new link (a language switch) is not copied yet.
  useEffect(() => {
    setCopied(null);
    setFailed(null);
  }, [url, editionLink?.url]);

  const report = useCallback(
    (channel: ReaderShareChannel) => {
      if (reported.current.has(channel)) return;
      reported.current.add(channel);
      onShared?.(channel);
    },
    [onShared]
  );

  const setOpen = useCallback((next: boolean) => {
    if (next) {
      reported.current.clear();
      setCopied(null);
      setFailed(null);
    }
    setOpenState(next);
  }, []);

  /** The system share sheet with the plain link; a sheet that cannot share falls back to the menu. */
  const shareNative = useCallback(async () => {
    if (sharing.current) return;
    sharing.current = true;
    reported.current.delete('native'); // every completed share sheet is a share
    try {
      const result = await caps.share({ title, text, url });
      if (!alive.current) return;
      if (result === 'shared') report('native');
      else if (result === 'fallback') setOpen(true);
    } finally {
      sharing.current = false;
    }
  }, [caps, title, text, url, report, setOpen]);

  const activate = useCallback(() => {
    if (open) {
      setOpen(false);
      return;
    }
    // With an edition link there is a choice to make, so the menu opens (its first row is the system share sheet).
    if (editionLink) {
      setOpen(true);
      return;
    }
    void shareNative();
  }, [open, editionLink, setOpen, shareNative]);

  const copy = useCallback(
    async (target: CopyTarget, link: string) => {
      const back = document.activeElement;
      copying.current += 1;
      let ok = false;
      try {
        ok = await caps.copy(link);
      } finally {
        copying.current -= 1;
      }
      if (!alive.current) return;
      // The hidden field took focus and is gone, so focus sits on the page itself: give it back to the row, unless
      // the reader has moved on (the menu closed, or focus went somewhere on purpose).
      const now = document.activeElement;
      if (back instanceof HTMLElement && back !== now && back.isConnected && (!now || now === document.body)) back.focus({ preventScroll: true });
      setCopied(ok ? target : null);
      setFailed(ok ? null : target);
      if (ok) report('copy');
    },
    [caps, report]
  );

  const copyLabel = (target: CopyTarget, idle: string) => (copied === target ? words.copied : failed === target ? words.copyFailed : idle);
  const status = copied ? words.copied : failed ? words.copyFailed : '';

  return (
    <>
      <Menu open={open} onOpenChange={setOpen} modal={false}>
        <MenuTrigger asChild>
          <button
            ref={triggerRef}
            type="button"
            aria-label={compact ? words.share : undefined}
            className={readerShareTriggerClass(compact, className)}
            // The press never opens the menu by itself: the tap tries Web Share first (onClick below).
            onPointerDown={(e) => e.preventDefault()}
            onClick={(e) => {
              e.preventDefault();
              activate();
            }}
            onKeyDown={(e) => {
              // Enter and Space share too (↓ still opens the menu, as on every ds Menu).
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                activate();
              }
            }}
          >
            <Share2 className="size-[18px]" aria-hidden />
            {!compact && <span className="truncate">{words.share}</span>}
          </button>
        </MenuTrigger>
        <MenuContent
          align="end"
          className={MENU_WIDTH}
          // A press on the trigger toggles the menu (above); it is not a press outside it.
          onInteractOutside={(e) => {
            if (triggerRef.current?.contains(e.target as Node)) e.preventDefault();
          }}
          // A copy's hidden field is not a step out of the menu (see the top of the file).
          onFocusOutside={(e) => {
            if (copying.current > 0) e.preventDefault();
          }}
        >
          {editionLink && caps.canShare && (
            <MenuItem className={ROW} onSelect={() => void shareNative()}>
              <Share2 aria-hidden />
              <span className="min-w-0">{words.shareNative}</span>
            </MenuItem>
          )}
          <MenuItem
            className={ROW}
            onSelect={(e) => {
              e.preventDefault(); // stay open: the row says "Link copied"
              void copy('link', url);
            }}
          >
            {copied === 'link' ? <Check aria-hidden /> : <Link2 aria-hidden />}
            <span className="min-w-0">{copyLabel('link', words.copyLink)}</span>
          </MenuItem>
          {editionLink && (
            <MenuItem
              className={ROW}
              onSelect={(e) => {
                e.preventDefault();
                void copy('edition', editionLink.url);
              }}
            >
              {copied === 'edition' ? <Check aria-hidden /> : <Link2 aria-hidden />}
              <span className="min-w-0">{copyLabel('edition', editionLink.label)}</span>
            </MenuItem>
          )}
          <MenuSeparator />
          {INTENT_CHANNELS.map((ch) => (
            <MenuItem key={ch} asChild className={ROW} onSelect={() => report(ch)}>
              <a
                href={intentUrl(ch, withVia(url, ch), title)}
                {...(ch === 'email' ? {} : { target: '_blank' })}
                rel="noopener noreferrer"
              >
                {CHANNEL_LABEL[ch]}
              </a>
            </MenuItem>
          ))}
          <MenuItem asChild className={ROW} onSelect={() => report('linkedin')}>
            <a href={linkedinShareUrl(url)} target="_blank" rel="noopener noreferrer">
              {LINKEDIN_LABEL}
            </a>
          </MenuItem>
        </MenuContent>
      </Menu>
      <span className="sr-only" aria-live="polite">
        {status}
      </span>
    </>
  );
};

export default ReaderShare;
