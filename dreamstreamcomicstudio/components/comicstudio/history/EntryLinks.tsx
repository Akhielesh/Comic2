// Comic History — the small entry links other surfaces place with one line (versions plan §8 "Entry points";
// package H5): "See this page's history" in timeline/VersionStack.tsx and "· History" in the
// timeline/BookTimeline.tsx summary. Each opens the History panel (OPEN_HISTORY_EVENT) and renders nothing while
// Comic History is off (caps.history false).

import React from 'react';
import { History as HistoryIcon } from 'lucide-react';
import { historyEnabled } from '../../../shared/comic/capabilities';
import type { RenderTarget } from '../../../shared/comic/doc';
import { FOCUS_RING, RADIUS_CONTROL, TRANSITION } from '../../chat/studioDesign';
import type { StudioController } from '../types';
import { requestOpenHistory } from './openHistory';

const cx = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(' ');

const LINK = cx('inline-flex min-h-11 shrink-0 items-center gap-1 px-2 text-[12.5px] font-medium text-[var(--ds-ink)] underline-offset-2 hover:underline', RADIUS_CONTROL, FOCUS_RING, TRANSITION);

/** "See this page's history" (VersionStack): History filtered to the page. */
export const PageHistoryLink: React.FC<{ studio: Pick<StudioController, 'caps' | 'doc'>; target: RenderTarget }> = ({ studio, target }) => {
  if (!historyEnabled(studio.caps) || !studio.doc || target.kind !== 'page') return null;
  return (
    <button type="button" className={LINK} onClick={() => requestOpenHistory({ view: 'list', pageId: target.id })} data-history-entry="page">
      <HistoryIcon className="h-3.5 w-3.5" aria-hidden />
      See this page’s history
    </button>
  );
};

/** "· History" in the book timeline's summary line. */
export const TimelineHistoryLink: React.FC<{ studio: Pick<StudioController, 'caps' | 'doc'> }> = ({ studio }) => {
  if (!historyEnabled(studio.caps) || !studio.doc) return null;
  return (
    // The dock's 36 px summary row (its other controls are 28 px on fine pointers, 44 px on touch): the same here.
    <button
      type="button"
      className={cx('inline-flex h-7 shrink-0 items-center gap-1 px-2 text-[12px] font-medium text-[var(--ds-ink)] hover:bg-[var(--ds-hover)] coarse:h-11 coarse:min-w-11 coarse:justify-center coarse:px-3', RADIUS_CONTROL, FOCUS_RING, TRANSITION)}
      onClick={() => requestOpenHistory({ view: 'list' })}
      aria-label="Open History: every saved moment of this comic"
      data-history-entry="timeline"
    >
      <HistoryIcon className="h-3.5 w-3.5" aria-hidden />
      <span className="hidden sm:inline">History</span>
    </button>
  );
};
