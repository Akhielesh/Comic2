// Comic History — the header's History control (versions plan §8 "Entry points"; package H5).
//
// lucide History, a 44 px target: icon-only with an aria-label on phones, labelled from md. It also hosts the History
// panel and answers OPEN_HISTORY_EVENT (typed "show history", the history card, the page and timeline links, "See
// changes since publishing", the ⋯ menu row) by opening it at the asked view — preventDefault tells the sender it was
// handled. With Comic History off (caps.history false) it renders nothing and listens to nothing.
//
// Phone headers narrower than HISTORY_HEADER_ICON_MIN_WIDTH show no icon (measured in the QA build: with a governed
// user's usage meter and the "saved by software" chip, one more 44 px icon overflows the header by 30 px at 320 px,
// 40 px at 360 px and 10 px at 390 px, and squeezes the title to ~20 px up to 430 px). There History is a row in the
// ⋯ menu (wave note: components/comicstudio/ComicStudio.tsx) and the board's History tab; this slot still hosts the
// panel and answers every open request.

import React, { useEffect, useRef, useState } from 'react';
import { History as HistoryIcon } from 'lucide-react';
import { historyEnabled } from '../../../shared/comic/capabilities';
import { FOCUS_RING, RADIUS_CONTROL, TRANSITION } from '../../chat/studioDesign';
import { HistoryPanel, type HistoryOpenRequest } from './HistoryPanel';
import { OPEN_HISTORY_EVENT, type OpenHistoryRequest } from './openHistory';
import type { HistoryStudio } from './useHistory';
import { useFormFactor } from '../mobile/useFormFactor';
import { cx } from './ui';

/** A compact (phone) header shows the History icon only from this width; narrower, History lives in the ⋯ menu. */
export const HISTORY_HEADER_ICON_MIN_WIDTH = 480;

let requestSeq = 0;

export const HistoryButton: React.FC<{ studio: HistoryStudio; compact: boolean }> = ({ studio, compact }) => {
  const enabled = historyEnabled(studio.caps) && !!studio.doc;
  const ff = useFormFactor();
  const showIcon = !compact || ff.width >= HISTORY_HEADER_ICON_MIN_WIDTH;
  const [open, setOpen] = useState(false);
  const [request, setRequest] = useState<HistoryOpenRequest | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!enabled || typeof window === 'undefined') return;
    const onOpen = (e: Event) => {
      e.preventDefault();
      const detail = ((e as CustomEvent<OpenHistoryRequest>).detail || {}) as OpenHistoryRequest;
      requestSeq += 1;
      setRequest({ ...detail, seq: requestSeq });
      setOpen(true);
    };
    window.addEventListener(OPEN_HISTORY_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_HISTORY_EVENT, onOpen);
  }, [enabled]);
  if (!enabled) return null;
  return (
    <>
      {showIcon && (
        <button
          ref={buttonRef}
          type="button"
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-label={compact ? 'History' : undefined}
          title="History — free to look back and restore"
          onClick={() => {
            requestSeq += 1;
            setRequest({ seq: requestSeq });
            setOpen(true);
          }}
          className={cx('inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center gap-1.5 text-[13px] font-medium text-[var(--ds-ink)] hover:bg-[var(--ds-hover)]', RADIUS_CONTROL, FOCUS_RING, TRANSITION, compact ? 'w-11' : 'px-3')}
          data-history-entry="header"
        >
          <HistoryIcon className="h-[18px] w-[18px]" aria-hidden />
          {!compact && <span className="hidden md:inline">History</span>}
          {!compact && <span className="sr-only md:hidden">History</span>}
        </button>
      )}
      <HistoryPanel studio={studio} open={open} onClose={() => setOpen(false)} request={request} />
    </>
  );
};

export default HistoryButton;
