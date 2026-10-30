// Comic History — "Classic snapshots (n)" of a comic brought in from the classic editor (versions plan §8, §11;
// package H5).
//
// The classic project's snapshots are kept safely on the server (beyond the old 20). Here they are read-only: each
// can start a NEW comic ("Start a new comic from this snapshot", free) — this comic is never changed by it.

import React, { useEffect, useState } from 'react';
import { Archive } from 'lucide-react';
import { useHistoryApi, historyErrorText, type ClassicSnapshotRow } from './historyApi';
import { whenText } from './historyModel';
import type { HistoryStudio } from './useHistory';
import { Note, QuietBtn } from './ui';

export interface ClassicSnapshotsProps {
  studio: HistoryStudio;
  /** The classic project this comic came from (its `import` moment). */
  classicProjectId: string;
  now: number;
  tz: string;
  /** Open the new comic (default: the studio URL for it). */
  onOpened?(projectId: string): void;
}

const openStudio = (projectId: string) => {
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  url.search = '';
  url.searchParams.set('view', 'studio');
  url.searchParams.set('id', projectId);
  window.location.assign(url.toString());
};

export const ClassicSnapshots: React.FC<ClassicSnapshotsProps> = ({ studio, classicProjectId, now, tz, onOpened = openStudio }) => {
  const api = useHistoryApi();
  const [snapshots, setSnapshots] = useState<ClassicSnapshotRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => {
    const ctrl = new AbortController();
    setError(null);
    api
      .classicSnapshots(classicProjectId, { signal: ctrl.signal })
      .then((res) => !ctrl.signal.aborted && setSnapshots(res.snapshots))
      .catch((err) => !ctrl.signal.aborted && setError(historyErrorText(err, "Couldn't load the classic snapshots. Nothing changed.") || null));
    return () => ctrl.abort();
  }, [api, classicProjectId]);
  if (!studio.doc) return null;
  const start = async (s: ClassicSnapshotRow) => {
    if (starting) return;
    setStarting(s.id);
    setNote(null);
    try {
      const { projectId } = await api.startFromClassicSnapshot(s.projectId, s.id);
      onOpened(projectId);
    } catch (err) {
      setNote(historyErrorText(err, "Couldn't start the new comic. Nothing was changed.") || null);
    } finally {
      setStarting(null);
    }
  };
  return (
    <section aria-labelledby="history-classic" className="min-w-0 border-t border-[var(--ds-hairline)] pt-2" data-history-classic>
      <div className="flex min-w-0 items-center gap-2 px-4">
        <Archive className="h-4 w-4 shrink-0 text-[var(--ds-muted)]" aria-hidden />
        <h3 id="history-classic" className="m-0 min-w-0 flex-1 text-[14px] font-semibold text-[var(--ds-ink)]">
          Classic snapshots{snapshots ? ` (${snapshots.length})` : ''}
        </h3>
      </div>
      <p className="m-0 px-4 pt-0.5 text-[12.5px] leading-5 text-[var(--ds-muted)]">Kept safely from the classic editor. Read-only here — starting a new comic from one is free and leaves this comic as it is.</p>
      {error && <Note tone="attention">{error}</Note>}
      {snapshots && !snapshots.length && <Note>No classic snapshots were kept for this comic.</Note>}
      {snapshots && snapshots.length > 0 && (
        <ul className="m-0 list-none px-4 py-2">
          {snapshots.map((s) => (
            <li key={s.id} className="flex min-w-0 flex-wrap items-center gap-2 border-b border-[var(--ds-hairline)] py-2 last:border-b-0" data-classic-snapshot={s.id}>
              <div className="min-w-0 flex-1">
                <p className="m-0 text-[13.5px] font-medium text-[var(--ds-ink)] [overflow-wrap:anywhere]">{s.name}</p>
                <p className="m-0 text-[12px] tabular-nums text-[var(--ds-muted)]">
                  {s.createdAt ? whenText(s.createdAt, now, tz) : 'Date not recorded'}
                  {typeof s.pages === 'number' ? ` · ${s.pages} ${s.pages === 1 ? 'page' : 'pages'}` : ''}
                </p>
              </div>
              <QuietBtn onClick={() => void start(s)} disabled={!!starting} aria-label={`Start a new comic from “${s.name}” (free)`}>
                {starting === s.id ? 'Starting…' : 'Start a new comic from this snapshot'}
              </QuietBtn>
            </li>
          ))}
        </ul>
      )}
      {note && <Note tone="attention">{note}</Note>}
    </section>
  );
};

export default ClassicSnapshots;
