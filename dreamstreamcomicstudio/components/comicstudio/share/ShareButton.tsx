// Share button (contract §13.3): the studio header's Share slot (opens the Share sheet; a status
// dot shows green = Library + link, blue = Link only, amber = changes since publishing), and the reader's
// share action when given a `target`: that is ReaderShare (Web Share, else a small menu with Copy link,
// the channel intents and LinkedIn), which carries none of the Share sheet's code.
// Icon + label from 768 px, icon-only when compact; 44 px targets. The sheet can also be opened
// from anywhere with `openShareSheet()` (a window event the mounted button listens for).

import React, { useCallback, useEffect, useState } from 'react';
import { Share2 } from 'lucide-react';
import type { StudioController } from '../types';
import { cx } from '../conversation/ui';
import { ReaderShare } from './ReaderShare';
import { ShareSheet } from './ShareSheet';

import { FOCUS_RING, STATUS_DOT, TONE_FILL } from '../../chat/studioDesign';
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
    `relative inline-flex h-11 items-center justify-center gap-1.5 rounded-xl text-[13px] font-medium text-[var(--ds-ink)] hover:bg-[var(--ds-hover)] ${FOCUS_RING} touch-manipulation`,
    compact ? 'w-11' : 'px-3'
  );

export const ShareButton: React.FC<ShareButtonProps> = ({ studio, target, compact }) => {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  useEffect(() => {
    if (!studio) return;
    const onOpen = () => setOpen(true);
    window.addEventListener(OPEN_SHARE_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_SHARE_EVENT, onOpen);
  }, [studio]);

  if (!studio && target) return <ReaderShare url={target.url} title={target.title} text={target.text} compact={compact} />;
  if (!studio || !studio.doc) return null;
  const m = studio.doc.publication;
  const behind = !!studio.publication?.behind;
  const dot = !m ? null : m.status === 'suspended' || behind ? STATUS_DOT.attention : m.visibility === 'public' ? STATUS_DOT.healthy : TONE_FILL.info;
  const label = !m ? 'Share (private)' : m.status === 'suspended' ? 'Share (paused)' : `Share (${m.visibility === 'public' ? 'Library + link' : 'Link only'}${behind ? ', changes not published' : ''})`;
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
