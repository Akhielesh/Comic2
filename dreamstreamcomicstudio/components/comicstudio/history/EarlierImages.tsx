// Comic History — "Earlier (images only)" for comics older than History (versions plan §8, §11; package H5).
//
// A v4/v5 comic's History starts the day it is first opened, but its drawings are older: every earlier version and
// archived image it already holds (AssetRef.at), newest first by day. Only drawings were recorded back then, and the
// section says so. Tapping one opens the timeline's MediaPreview — "Use for this page" and the other choices are
// free (render_use), with the timeline's own Undo toast.

import React, { useMemo, useState } from 'react';
import { Images } from 'lucide-react';
import { FOCUS_RING, RADIUS_CONTROL } from '../../chat/studioDesign';
import { MediaPreview } from '../timeline/MediaPreview';
import { UndoToast, useTimelineEdit } from '../timeline/UndoToast';
import { earlierImageGroups, earlierNote } from './historyModel';
import type { HistoryStudio } from './useHistory';
import { cx, HistorySheet, Overline } from './ui';

export interface EarlierImagesProps {
  studio: HistoryStudio;
  /** When History started (the `start` moment), null when unknown. */
  startedAt: number | null;
  now: number;
  tz: string;
}

export const EarlierImages: React.FC<EarlierImagesProps> = ({ studio, startedAt, now, tz }) => {
  const doc = studio.doc;
  const groups = useMemo(() => (doc ? earlierImageGroups(doc, startedAt, now, tz) : []), [doc, startedAt, now, tz]);
  const items = useMemo(() => groups.flatMap((g) => g.items), [groups]);
  const [index, setIndex] = useState<number | null>(null);
  const edit = useTimelineEdit(studio);
  if (!doc || !items.length) return null;
  return (
    <section aria-labelledby="history-earlier" className="min-w-0 border-t border-[var(--ds-hairline)] pt-2" data-history-earlier>
      <div className="flex min-w-0 items-center gap-2 px-4">
        <Images className="h-4 w-4 shrink-0 text-[var(--ds-muted)]" aria-hidden />
        <h3 id="history-earlier" className="m-0 min-w-0 flex-1 text-[14px] font-semibold text-[var(--ds-ink)]">
          Earlier (images only)
        </h3>
      </div>
      <p className="m-0 px-4 pt-0.5 text-[12.5px] leading-5 text-[var(--ds-muted)]">
        {earlierNote(startedAt, tz)} Using an earlier drawing is free.
      </p>
      {groups.map((g) => (
        <div key={g.label} className="min-w-0">
          <Overline as="p" className="px-4 pt-2">
            {g.label}
          </Overline>
          <ul className="m-0 flex min-w-0 list-none flex-wrap gap-2 px-4 py-2">
            {g.items.map((item) => {
              const i = items.indexOf(item);
              const url = studio.urlFor(item.asset, { width: 160 });
              return (
                <li key={item.path} className="shrink-0">
                  <button
                    type="button"
                    onClick={() => setIndex(i)}
                    aria-label={`${item.owner.label}${item.versionLabel ? `, ${item.versionLabel}` : ''}: open`}
                    className={cx('flex min-h-11 flex-col items-center gap-1', RADIUS_CONTROL, FOCUS_RING)}
                  >
                    <span className={cx('relative block h-[84px] w-14 overflow-hidden border border-[var(--ds-hairline)] bg-[var(--ds-well)]', RADIUS_CONTROL)}>
                      {url ? <img src={url} alt="" className="absolute inset-0 h-full w-full object-cover" draggable={false} loading="lazy" /> : <span className="studio-shimmer absolute inset-0" aria-hidden />}
                    </span>
                    <span className="block w-14 truncate text-center text-[11px] text-[var(--ds-muted)]">{item.owner.label}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
      <HistorySheet open={index !== null} onClose={() => setIndex(null)} label="Earlier drawing" detents={['full']}>
        {index !== null && (
          <div className="min-w-0 px-4 pb-4">
            <MediaPreview studio={studio} doc={doc} items={items} index={index} onIndex={setIndex} edit={edit} />
          </div>
        )}
      </HistorySheet>
      <UndoToast entry={edit.toast} onUndo={edit.undo} onDismiss={edit.dismiss} />
    </section>
  );
};

export default EarlierImages;
