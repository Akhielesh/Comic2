// Comic History — "3 pages changed since you published · See changes" (versions plan §5 "Now vs Published";
// package H5). Placed with one line in share/ShareSheet.tsx next to the "changes since publishing" note: it turns the
// publish card's yes/no `behind` into words, from the free owner compare of Published with now, and opens that
// compare in History. Renders nothing while Comic History is off or the comic is not published.

import React, { useEffect, useState } from 'react';
import { historyEnabled } from '../../../shared/comic/capabilities';
import { changedPageCount } from '../../../shared/comic/history/index';
import type { StudioController } from '../types';
import { FOCUS_RING, RADIUS_CONTROL } from '../../chat/studioDesign';
import { useHistoryApi } from './historyApi';
import { restorableId } from './historyModel';
import { requestOpenHistory } from './openHistory';

const cx = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(' ');

export const ChangesSincePublishLink: React.FC<{ studio: Pick<StudioController, 'caps' | 'doc'> }> = ({ studio }) => {
  const api = useHistoryApi();
  const on = historyEnabled(studio.caps) && !!studio.doc?.publication;
  const projectId = studio.doc?.id;
  const rev = studio.doc?.rev;
  const [state, setState] = useState<{ changed: number; from: string | null; same: boolean } | null>(null);
  useEffect(() => {
    if (!on || !projectId) return;
    const ctrl = new AbortController();
    api
      .compare(projectId, 'published', 'now', { signal: ctrl.signal })
      .then((res) => !ctrl.signal.aborted && setState({ changed: changedPageCount(res.diff), from: restorableId(res.a), same: !!res.diff.same }))
      .catch(() => !ctrl.signal.aborted && setState(null));
    return () => ctrl.abort();
  }, [api, on, projectId, rev]);
  // Nothing until the compare answers (and nothing when it can't: no published moment yet) — never a dead link. Nothing
  // either when the story is the same: the publication's fingerprint can differ by what the compare rightly hides
  // (quality checks, size variants, safety re-checks), and "something changed" would then be untrue.
  if (!on || !state?.from || state.same) return null;
  const words = state.changed ? `${state.changed} ${state.changed === 1 ? 'page' : 'pages'} changed since you published` : 'Only story details changed since you published';
  return (
    <span className="inline-flex min-w-0 flex-wrap items-center gap-1" data-history-entry="publish">
      <span className="min-w-0 text-[13px] text-[var(--ds-ink)]">{words} ·</span>
      <button
        type="button"
        onClick={() => requestOpenHistory({ view: 'compare', versionId: state.from! })}
        className={cx('inline-flex min-h-11 items-center px-1 text-[13px] font-semibold text-[var(--ds-ink)] underline underline-offset-2', RADIUS_CONTROL, FOCUS_RING)}
      >
        See changes
      </button>
    </span>
  );
};

export default ChangesSincePublishLink;
