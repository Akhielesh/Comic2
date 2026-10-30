// Comic History — one moment (versions plan §8 "Moment detail"; package H5).
//
// "What changed", grouped ("Page 3 — Dialogue: 2 lines · Art: redrawn", "Telugu — 12 lines changed"), each group
// with [Compare]; a sticky bar (safe-area padded) with [Read this version] [Compare with now] [Restore…]; and More:
// Name this version (the newest moment), Undo this AI change (the latest AI moment). Reading, comparing and
// restoring are free.

import React, { useEffect, useState } from 'react';
import { MoreHorizontal } from 'lucide-react';
import type { ChangeGroup, VersionRow } from '../../../shared/comic/history/types';
import { MENU, MENU_ITEM, FOCUS_ITEM } from '../../chat/studioDesign';
import { historyErrorText, useHistoryApi } from './historyApi';
import { ACTOR_INFO, changeGroupsOf, rowMetaText, type MoneyWords } from './historyModel';
import type { HistoryStudio } from './useHistory';
import { ActorGlyph, cx, IconBtn, Note, Overline, PrimaryBtn, QuietBtn } from './ui';

export interface MomentDetailProps {
  studio: HistoryStudio;
  versionId: string;
  /** The list as loaded (newest first): the row itself when known, and whether it is the newest / the latest AI run. */
  rows: readonly VersionRow[];
  money: MoneyWords;
  tz: string;
  onRead(versionId: string): void;
  onCompare(versionId: string, pageId?: string): void;
  onRestore(versionId: string): void;
  onUndoAi(): void;
  onName(): void;
}

export const MomentDetail: React.FC<MomentDetailProps> = ({ studio, versionId, rows, money, tz, onRead, onCompare, onRestore, onUndoAi, onName }) => {
  const api = useHistoryApi();
  const projectId = studio.doc?.id;
  const known = rows.find((r) => r.id === versionId) ?? null;
  const [row, setRow] = useState<VersionRow | null>(known);
  const [groups, setGroups] = useState<ChangeGroup[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [menu, setMenu] = useState(false);
  useEffect(() => {
    if (!projectId) return;
    const ctrl = new AbortController();
    setError(null);
    api
      .detail(projectId, versionId, { signal: ctrl.signal })
      .then((d) => {
        if (ctrl.signal.aborted) return;
        setRow(d.row);
        setGroups(d.groups.length ? d.groups : changeGroupsOf(d.row.changes));
      })
      .catch((err) => {
        if (ctrl.signal.aborted) return;
        // The list row is enough to show what changed; say so only when there is nothing at all.
        if (known) setGroups(changeGroupsOf(known.changes));
        else setError(historyErrorText(err, "This moment can't be opened. Nothing in your comic changed.") || null);
      });
    return () => ctrl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, projectId, versionId]);

  if (error) return <Note tone="attention">{error}</Note>;
  if (!row) return <Note>Opening this moment…</Note>;
  const actor = ACTOR_INFO[row.actor] ?? ACTOR_INFO.system;
  const newest = rows[0]?.id === row.id;
  const latestAi = rows.find((r) => r.kind === 'ai')?.id === row.id;
  const more = [
    ...(newest ? [{ id: 'name', label: 'Name this version', run: onName }] : []),
    ...(latestAi ? [{ id: 'undo', label: 'Undo this AI change', run: onUndoAi }] : [])
  ];

  return (
    <section aria-label={`Moment: ${row.name || row.label}`} className="flex min-w-0 flex-col" data-moment-detail={row.id}>
      <div className="flex min-w-0 items-start gap-3 px-4 pt-2">
        <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-[var(--ds-hairline)] bg-[var(--ds-well)] text-[var(--ds-ink)]">
          <ActorGlyph icon={actor.icon} />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="m-0 text-[16px] font-semibold leading-6 text-[var(--ds-ink)] [overflow-wrap:anywhere]">{row.name || row.label}</h3>
          <p className="m-0 text-[12.5px] tabular-nums text-[var(--ds-muted)] [overflow-wrap:anywhere]">
            {actor.words} · {rowMetaText(row, money, tz)}
          </p>
          {row.name && row.label && row.label !== row.name && <p className="m-0 mt-0.5 text-[12.5px] text-[var(--ds-muted)] [overflow-wrap:anywhere]">{row.label}</p>}
          {row.note && <p className="m-0 mt-1 text-[13px] text-[var(--ds-ink)] [overflow-wrap:anywhere]">“{row.note}”</p>}
        </div>
        {more.length > 0 && (
          <div className="relative shrink-0">
            <IconBtn label="More" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu((m) => !m)}>
              <MoreHorizontal className="h-4 w-4" aria-hidden />
            </IconBtn>
            {menu && (
              <div role="menu" className={cx('absolute right-0 top-full z-10 mt-1 w-56 max-w-[calc(100vw-32px)] py-1', MENU)}>
                {more.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setMenu(false);
                      m.run();
                    }}
                    className={cx(MENU_ITEM, FOCUS_ITEM, 'min-h-11 text-[var(--ds-ink)]')}
                  >
                    {m.label} · Free
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="min-w-0 px-4 pb-3 pt-3">
        <Overline as="h3">What changed</Overline>
        {groups === null && <p className="m-0 py-2 text-[13px] text-[var(--ds-muted)]">Reading what changed…</p>}
        {groups && !groups.length && (
          <p className="m-0 py-2 text-[13px] text-[var(--ds-muted)]">{row.kind === 'start' ? 'History starts here.' : row.kind === 'named' ? 'You named the book as it was.' : 'Not recorded for this moment.'}</p>
        )}
        {groups && groups.length > 0 && (
          <ul className="m-0 list-none p-0">
            {groups.map((g) => (
              <li key={g.key} className="flex min-w-0 flex-wrap items-center gap-2 border-b border-[var(--ds-hairline)] py-2 last:border-b-0" data-change-group={g.key}>
                <p className="m-0 min-w-0 flex-1 text-[13.5px] leading-5 text-[var(--ds-ink)] [overflow-wrap:anywhere]">
                  <span className="font-semibold">{g.title}</span>
                  {g.lines.length ? <span className="text-[var(--ds-muted)]"> — {g.lines.join(' · ')}</span> : null}
                </p>
                <QuietBtn onClick={() => onCompare(row.id, g.pageId)} aria-label={`Compare ${g.title} with now`}>
                  Compare
                </QuietBtn>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="sticky bottom-0 mt-auto flex min-w-0 flex-wrap gap-2 border-t border-[var(--ds-hairline)] bg-[var(--ds-surface-strong)] px-4 py-2" style={{ paddingBottom: 'calc(var(--sa-bottom-eff, 0px) + 8px)' }}>
        <QuietBtn onClick={() => onRead(row.id)} className="flex-1">
          Read this version
        </QuietBtn>
        <QuietBtn onClick={() => onCompare(row.id)} className="flex-1">
          Compare with now
        </QuietBtn>
        <PrimaryBtn onClick={() => onRestore(row.id)} className="flex-1">
          Restore…
        </PrimaryBtn>
      </div>
    </section>
  );
};

export default MomentDetail;
