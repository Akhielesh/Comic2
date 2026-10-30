// Comic History — "Earlier (images only)" for comics older than History (versions plan §8, §11; package H5).
//
// A v4/v5 comic's History starts the day it is first opened, but its drawings are older. The shared derivation
// (shared/comic/history/earlier.ts, H6a) lists exactly what the comic already holds — every drawing per owner and per
// local day, newest first, each gap worded "not recorded" — and this view renders it: the title, the note, the days,
// and a moment's facts (money through the viewer's own formatter, so governed users never read '$').
// "Use this version" opens the timeline's MediaPreview (render_use, free, with the timeline's own Undo toast), only
// for a drawing that is not held back, not already in the book, and whose owner is a live target (earlierUseOf).

import React, { useMemo, useState } from 'react';
import { EyeOff, Globe2, Images, Trash2 } from 'lucide-react';
import { FOCUS_RING, RADIUS_CONTROL } from '../../chat/studioDesign';
import { earlierFacts, earlierHistory, localParts, type EarlierMoment } from '../../../shared/comic/history/index';
import { useCostFormat } from '../conversation/cost';
import { MediaPreview } from '../timeline/MediaPreview';
import { UndoToast, useTimelineEdit } from '../timeline/UndoToast';
import type { MediaItem } from '../timeline/bookModel';
import { ACTOR_INFO, earlierUseOf, whenText } from './historyModel';
import type { HistoryStudio } from './useHistory';
import { ActorGlyph, cx, HistorySheet, Overline, PrimaryBtn } from './ui';

export interface EarlierImagesProps {
  studio: HistoryStudio;
  /** When History started (the `start` moment's createdAt), null when unknown. */
  startedAt: number | null;
  now: number;
  tz: string;
}

/** The viewer's local day of `now`: the Earlier groups only change when it does (Today / Yesterday labels). */
const localDayOf = (now: number, tz: string): string => {
  try {
    const p = localParts(now, tz);
    return `${p.y}-${p.m}-${p.d}`;
  } catch {
    return String(Math.floor(now / 86_400_000));
  }
};

/**
 * "Page 3, v1: open" — the tile's name (the same words as before the shared derivation). A drawing moment with no
 * v-number is a panel picture or overlay a restore archived (shared/comic/history/earlier.ts): it is named from its own
 * words, "An overlay from page 2: open", never just its page's.
 */
const tileLabel = (m: EarlierMoment): string =>
  m.kind === 'drawing' && m.versionN === undefined ? `${m.label}: open` : `${m.owner.label}${m.versionN ? `, v${m.versionN}` : ''}: open`;

/** Each tile's name, distinct within a day: tiles that would read the same (two overlays from page 2) say "1 of 2". */
const tileNames = (tiles: EarlierMoment[]): Map<string, string> => {
  const same = new Map<string, EarlierMoment[]>();
  for (const m of tiles) {
    const name = tileLabel(m);
    same.set(name, [...(same.get(name) || []), m]);
  }
  const out = new Map<string, string>();
  for (const [name, list] of same) list.forEach((m, i) => out.set(m.id, list.length > 1 ? name.replace(/: open$/, ` (${i + 1} of ${list.length}): open`) : name));
  return out;
};

export const EarlierImages: React.FC<EarlierImagesProps> = ({ studio, startedAt, now, tz }) => {
  const doc = studio.doc;
  const day = localDayOf(now, tz);
  // Memoised on [doc, before, tz, local day of now]: `now` only feeds the day labels, which change with the day.
  const earlier = useMemo(
    () => (doc ? earlierHistory(doc, { now, tz, before: startedAt }) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [doc, startedAt, tz, day]
  );
  const cost = useCostFormat(studio);
  const [openId, setOpenId] = useState<string | null>(null);
  const [use, setUse] = useState<{ items: MediaItem[]; index: number } | null>(null);
  const edit = useTimelineEdit(studio);
  const opened = (openId && earlier?.moments.find((m) => m.id === openId)) || null;
  const useOffer = useMemo(() => (doc && opened ? earlierUseOf(doc, opened) : null), [doc, opened]);
  if (!doc || !earlier || !earlier.moments.length) return null;
  const close = () => {
    setOpenId(null);
    setUse(null);
  };
  return (
    <section aria-labelledby="history-earlier" className="min-w-0 border-t border-[var(--ds-hairline)] pt-2" data-history-earlier>
      <div className="flex min-w-0 items-center gap-2 px-4">
        <Images className="h-4 w-4 shrink-0 text-[var(--ds-muted)]" aria-hidden />
        <h3 id="history-earlier" className="m-0 min-w-0 flex-1 text-[14px] font-semibold text-[var(--ds-ink)]">
          {earlier.title}
        </h3>
      </div>
      <p className="m-0 px-4 pt-0.5 text-[12.5px] leading-5 text-[var(--ds-muted)]">{earlier.note} Using an earlier drawing is free.</p>
      {earlier.days.map((d) => {
        const moments = d.groups.flatMap((g) => g.moments);
        const tiles = moments.filter((m) => !!m.path);
        const names = tileNames(tiles);
        const events = moments.filter((m) => !m.path);
        return (
          <div key={d.key} className="min-w-0" data-earlier-day={d.key}>
            <Overline as="p" className="px-4 pt-2">
              {d.label}
            </Overline>
            {tiles.length > 0 && (
              <ul className="m-0 flex min-w-0 list-none flex-wrap gap-2 px-4 py-2">
                {tiles.map((m) => {
                  const url = m.thumbPath ? studio.urlFor(m.thumbPath, { width: 160 }) : undefined;
                  return (
                    <li key={m.id} className="shrink-0">
                      <button
                        type="button"
                        onClick={() => {
                          setUse(null);
                          setOpenId(m.id);
                        }}
                        aria-label={names.get(m.id) ?? tileLabel(m)}
                        data-earlier-moment={m.id}
                        className={cx('flex min-h-11 flex-col items-center gap-1', RADIUS_CONTROL, FOCUS_RING)}
                      >
                        <span className={cx('relative block h-[84px] w-14 overflow-hidden border border-[var(--ds-hairline)] bg-[var(--ds-well)]', RADIUS_CONTROL)}>
                          {m.blocked ? (
                            <span className="absolute inset-0 flex items-center justify-center text-[var(--ds-muted)]">
                              <EyeOff className="h-4 w-4" aria-hidden />
                            </span>
                          ) : url ? (
                            <img src={url} alt="" className="absolute inset-0 h-full w-full object-cover" draggable={false} loading="lazy" />
                          ) : (
                            <span className="studio-shimmer absolute inset-0" aria-hidden />
                          )}
                          {m.kind === 'deleted' && (
                            <span className="absolute bottom-0.5 right-0.5 rounded-full bg-[var(--ds-canvas)] p-0.5 text-[var(--ds-muted)]">
                              <Trash2 className="h-3 w-3" aria-hidden />
                            </span>
                          )}
                        </span>
                        <span className="block w-14 truncate text-center text-[11px] text-[var(--ds-muted)]">{m.owner.label}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
            {events.length > 0 && (
              <ul className="m-0 min-w-0 list-none px-4 pb-2">
                {events.map((m) => (
                  <li key={m.id} className="flex min-w-0 items-center gap-2 py-1 text-[12.5px] leading-5 text-[var(--ds-muted)]" data-earlier-event={m.kind}>
                    {m.kind === 'deleted' ? <Trash2 className="h-3.5 w-3.5 shrink-0" aria-hidden /> : <Globe2 className="h-3.5 w-3.5 shrink-0" aria-hidden />}
                    <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
                      {m.label}
                      {m.at ? ` · ${whenText(m.at, now, tz)}` : ''}
                      {m.languages?.length ? ` · ${m.languages.join(', ')}` : ''}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      })}
      <HistorySheet open={!!opened} onClose={close} label="Earlier drawing" detents={['full']}>
        {opened && use ? (
          <div className="min-w-0 px-4 pb-4">
            <MediaPreview studio={studio} doc={doc} items={use.items} index={use.index} onIndex={(index) => setUse((u) => (u ? { ...u, index } : u))} edit={edit} />
          </div>
        ) : opened ? (
          <EarlierMomentDetail studio={studio} moment={opened} now={now} tz={tz} money={cost.exact} onUse={useOffer ? () => setUse(useOffer) : undefined} />
        ) : null}
      </HistorySheet>
      <UndoToast entry={edit.toast} onUndo={edit.undo} onDismiss={edit.dismiss} />
    </section>
  );
};

/** One Earlier moment: the image (never a held-back one), what it was, and every fact — "not recorded" when missing. */
const EarlierMomentDetail: React.FC<{
  studio: HistoryStudio;
  moment: EarlierMoment;
  now: number;
  tz: string;
  money: (usd: number) => string;
  onUse?: () => void;
}> = ({ studio, moment: m, now, tz, money, onUse }) => {
  const url = m.path && !m.blocked ? studio.urlFor(m.path, { width: 1080 }) : undefined;
  const ratio = m.w && m.h ? m.w / m.h : 2 / 3;
  const facts = earlierFacts(m, money);
  return (
    <div className="min-w-0 space-y-3 px-4 pb-4" data-earlier-detail={m.id}>
      {m.path && (
        <div
          className={cx('relative mx-auto w-full overflow-hidden border border-[var(--ds-hairline)] bg-[var(--ds-well)]', RADIUS_CONTROL)}
          style={{ aspectRatio: String(ratio), maxWidth: `min(100%, ${Math.round(320 * Math.min(1.6, Math.max(0.6, ratio)))}px)` }}
        >
          {m.blocked ? (
            <span className="absolute inset-0 flex items-center justify-center text-[var(--ds-muted)]">
              <EyeOff className="h-5 w-5" aria-hidden />
            </span>
          ) : url ? (
            <img src={url} alt={tileLabel(m).replace(/: open$/, '')} className="absolute inset-0 h-full w-full object-contain" draggable={false} />
          ) : (
            <span className="studio-shimmer absolute inset-0" aria-hidden />
          )}
        </div>
      )}
      <div className="flex min-w-0 items-start gap-2">
        {m.by && <ActorGlyph icon={ACTOR_INFO[m.by].icon} className="mt-0.5 text-[var(--ds-muted)]" />}
        <div className="min-w-0 flex-1">
          <p className="m-0 text-[14px] font-semibold leading-5 text-[var(--ds-ink)] [overflow-wrap:anywhere]">{m.label}</p>
          {m.at !== null && <p className="m-0 text-[12.5px] leading-5 text-[var(--ds-muted)]">{whenText(m.at, now, tz, true)}</p>}
        </div>
      </div>
      {facts.length > 0 && (
        <ul className="m-0 min-w-0 list-none space-y-0.5 p-0 text-[12.5px] leading-5 text-[var(--ds-muted)]" data-earlier-facts>
          {facts.map((f) => (
            <li key={f} className="[overflow-wrap:anywhere]">
              {f}
            </li>
          ))}
        </ul>
      )}
      {onUse && (
        <PrimaryBtn onClick={onUse} className="w-full" data-earlier-use>
          Use this version
        </PrimaryBtn>
      )}
    </div>
  );
};

export default EarlierImages;
