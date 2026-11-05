// Share button (contract §13.3): the studio header's Share slot (opens the Share sheet; a status
// dot shows green = public, blue = unlisted, amber = changes since publishing), and the reader's
// share action when given a `target` (Web Share, else a small popover with Copy + intents).
// Icon + label from 768 px, icon-only when compact; 44 px targets. The sheet can also be opened
// from anywhere with `openShareSheet()` (a window event the mounted button listens for).

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Share2 } from 'lucide-react';
import type { StudioController } from '../types';
import { cx } from '../conversation/ui';
import { ShareSheet } from './ShareSheet';
import { CHANNEL_LABEL, INTENT_CHANNELS, intentUrl } from './shareModel';
import { useShareCapabilities } from './useShareCapabilities';

export interface ShareTarget {
  url: string;
  title: string;
  text?: string;
  coverUrl?: string;
}

export interface ShareButtonProps {
  studio?: StudioController;
  target?: ShareTarget;
  compact?: boolean;
}

export const OPEN_SHARE_EVENT = 'ds:open-share';

/** Open the studio Share sheet from anywhere (a card, a chip, the reader tab). */
export const openShareSheet = (): void => {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(OPEN_SHARE_EVENT));
};

const buttonCls = (compact?: boolean) =>
  cx(
    'relative inline-flex h-11 items-center justify-center gap-1.5 rounded-xl text-[13px] font-medium text-[var(--ds-ink)] hover:bg-[var(--ds-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#D97757]/40 touch-manipulation',
    compact ? 'w-11' : 'px-3'
  );

const TargetShare: React.FC<{ target: ShareTarget; compact?: boolean }> = ({ target, compact }) => {
  const caps = useShareCapabilities();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  const click = async () => {
    const result = await caps.share({ title: target.title, text: target.text, url: target.url });
    if (result === 'fallback') setOpen(true);
  };
  return (
    <div ref={ref} className="relative">
      <button type="button" onClick={click} aria-haspopup="menu" aria-expanded={open} className={buttonCls(compact)} aria-label={compact ? 'Share' : undefined}>
        <Share2 className="h-[18px] w-[18px]" aria-hidden />
        {!compact && <span>Share</span>}
      </button>
      {open && (
        <div role="menu" className="absolute right-0 top-full z-50 mt-1 w-[min(260px,calc(100vw-24px))] rounded-2xl border border-[var(--ds-hairline)] bg-[var(--ds-surface)] p-1.5 shadow-[0_8px_32px_rgba(0,0,0,0.2)]">
          <button
            type="button"
            role="menuitem"
            onClick={async () => setCopied(await caps.copy(target.url))}
            className="flex min-h-[44px] w-full items-center rounded-xl px-3 text-left text-[14px] text-[var(--ds-ink)] hover:bg-[var(--ds-hover)]"
          >
            {copied ? 'Link copied' : 'Copy link'}
          </button>
          {INTENT_CHANNELS.map((ch) => (
            <a
              key={ch}
              role="menuitem"
              href={intentUrl(ch, target.url, target.title)}
              target="_blank"
              rel="noopener noreferrer"
              className="flex min-h-[44px] items-center rounded-xl px-3 text-[14px] text-[var(--ds-ink)] hover:bg-[var(--ds-hover)]"
            >
              {CHANNEL_LABEL[ch]}
            </a>
          ))}
          <span className="sr-only" aria-live="polite">
            {copied ? 'Link copied' : ''}
          </span>
        </div>
      )}
    </div>
  );
};

export const ShareButton: React.FC<ShareButtonProps> = ({ studio, target, compact }) => {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  useEffect(() => {
    if (!studio) return;
    const onOpen = () => setOpen(true);
    window.addEventListener(OPEN_SHARE_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_SHARE_EVENT, onOpen);
  }, [studio]);

  if (!studio && target) return <TargetShare target={target} compact={compact} />;
  if (!studio || !studio.doc) return null;
  const m = studio.doc.publication;
  const behind = !!studio.publication?.behind;
  const dot = !m ? null : m.status === 'suspended' || behind ? 'bg-amber-500' : m.visibility === 'public' ? 'bg-emerald-500' : 'bg-sky-500';
  const label = !m ? 'Share (private)' : m.status === 'suspended' ? 'Share (paused)' : `Share (${m.visibility === 'public' ? 'public' : 'unlisted'}${behind ? ', changes not published' : ''})`;
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} aria-haspopup="dialog" aria-label={label} title={label} className={buttonCls(compact)}>
        <Share2 className="h-[18px] w-[18px]" aria-hidden />
        {!compact && <span className="hidden md:inline">Share</span>}
        {dot && <span aria-hidden className={cx('absolute right-1.5 top-1.5 h-2 w-2 rounded-full ring-2 ring-[var(--ds-surface)]', dot)} />}
      </button>
      <ShareSheet studio={studio} open={open} onClose={close} />
    </>
  );
};

export default ShareButton;
