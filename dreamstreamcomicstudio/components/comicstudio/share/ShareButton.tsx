// Share button (contract §13.3): the studio header's Share slot (opens the Share sheet; a status
// dot shows green = Library + link, blue = Link only, amber = changes since publishing), and the reader's
// share action when given a `target`: that is ReaderShare (Web Share, else a small menu with Copy link,
// the channel intents and LinkedIn), which carries none of the Share sheet's code. ReaderShare and the ds Menu
// under it load on demand, so the studio, which imports this button for its header, never downloads them;
// until they arrive the same button stands in, and a tap on it opens the menu once they have. A load that
// fails never reaches the page: the stand-in stays and the next tap tries again.
// Icon + label from 768 px, icon-only when compact; 44 px targets. The sheet can also be opened
// from anywhere with `openShareSheet()` (a window event the mounted button listens for).

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Share2 } from 'lucide-react';
import type { StudioController } from '../types';
import { cx } from '../conversation/ui';
import type { ReaderShareProps } from './ReaderShare';
import { readerShareTriggerClass } from './readerShareTrigger';
import { ShareSheet } from './ShareSheet';

import { FOCUS_RING, STATUS_DOT, TONE_FILL } from '../../chat/studioDesign';
export interface ShareTarget {
  url: string;
  title: string;
  text?: string;
  coverUrl?: string;
  onShared?: ReaderShareProps['onShared'];
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

type ReaderShareView = React.ComponentType<ReaderShareProps>;
let readerShareView: ReaderShareView | null = null;
let readerShareLoad: Promise<ReaderShareView> | null = null;

/**
 * ReaderShare's chunk, fetched once. Not React.lazy: a failed fetch (offline, or a deploy that replaced the chunk; the
 * boot's preload handler may reload the page first) would throw into the app's error boundary and take the reader
 * with it. Here it only clears the cache, so the next tap fetches again.
 */
const loadReaderShare = (): Promise<ReaderShareView> =>
  (readerShareLoad ??= import('./ReaderShare')
    .then((m) => {
      if (!m?.ReaderShare) throw new Error('ReaderShare did not load');
      return (readerShareView = m.ReaderShare);
    })
    .catch((err: unknown) => {
      readerShareLoad = null;
      throw err;
    }));

/** The reader's Share: ReaderShare, with the same button standing in until it has loaded (a tap there is remembered). */
const ReaderShareTarget: React.FC<{ target: ShareTarget; compact?: boolean }> = ({ target, compact }) => {
  const [View, setView] = useState<ReaderShareView | null>(() => readerShareView);
  const [tapped, setTapped] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (View) return;
    let live = true;
    loadReaderShare().then(
      (loaded) => live && setView(() => loaded),
      () => undefined // the stand-in stays; a tap tries again
    );
    return () => {
      live = false;
    };
  }, [View, attempt]);
  if (View) return <View url={target.url} title={target.title} text={target.text} onShared={target.onShared} compact={compact} defaultOpen={tapped} />;
  return (
    <button
      type="button"
      data-loading=""
      aria-label={compact ? 'Share' : undefined}
      aria-haspopup="menu"
      aria-expanded={false}
      className={readerShareTriggerClass(compact)}
      onClick={() => {
        setTapped(true);
        setAttempt((n) => n + 1);
      }}
    >
      <Share2 className="size-[18px]" aria-hidden />
      {!compact && <span className="truncate">Share</span>}
    </button>
  );
};

export const ShareButton: React.FC<ShareButtonProps> = ({ studio, target, compact }) => {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  // Only a button that renders its sheet (the comic has loaded) answers an open request.
  const canOpen = useRef(false);
  canOpen.current = !!studio?.doc;
  useEffect(() => {
    if (!studio) return;
    const onOpen = (event: Event) => {
      if (!canOpen.current) return;
      setOpen(true);
      // Answered: useStudio's open_share then leaves the board where it is and asks the Read tab for no second sheet.
      event.preventDefault();
    };
    window.addEventListener(OPEN_SHARE_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_SHARE_EVENT, onOpen);
  }, [studio]);

  if (!studio && target) return <ReaderShareTarget target={target} compact={compact} />;
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
