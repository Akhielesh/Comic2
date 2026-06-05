// HistoryPanel (Sprint 3, S3.3): version history for the loaded project. Lists snapshots
// written on each Build; restoring loads that version's files as the new working baseline
// (non-destructive — building again snapshots a fresh version). Collapsible to stay tidy.

import React, { useEffect, useState } from 'react';
import { History, ChevronRight, ChevronDown, Undo2, RefreshCw, Loader2, Bot, User } from 'lucide-react';
import { useStudioWorkspace } from './workspaceStore';
import { listStudioVersions, getStudioVersionFiles, type StudioVersionSummary } from '../../../services/studioApi';
import { useStudioTheme } from '../kit';

const rel = (iso: string): string => {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const s = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60); if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60); if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
};

export const HistoryPanel: React.FC = () => {
  const t = useStudioTheme();
  const projectId = useStudioWorkspace((s) => s.projectId);
  const replaceFiles = useStudioWorkspace((s) => s.replaceFiles);
  const [open, setOpen] = useState(false);
  const [versions, setVersions] = useState<StudioVersionSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [restoring, setRestoring] = useState<string | null>(null);

  const load = () => {
    if (!projectId) { setVersions([]); return; }
    setError(null);
    setVersions(null);
    listStudioVersions(projectId)
      .then(setVersions)
      .catch((e) => { setError((e as Error)?.message || 'Could not load history.'); setVersions([]); });
  };
  useEffect(() => { if (open) load(); }, [open, projectId]); // eslint-disable-line react-hooks/exhaustive-deps

  const restore = async (vid: string) => {
    if (!projectId) return;
    setRestoring(vid);
    setError(null);
    try {
      const files = await getStudioVersionFiles(projectId, vid);
      replaceFiles(files);
    } catch (e) {
      setError((e as Error)?.message || 'Could not restore that version.');
    } finally {
      setRestoring(null);
    }
  };

  if (!projectId) {
    return <p className={`text-[11px] ${t.textFaint}`}><History className="mr-1 inline w-3.5 h-3.5" />Versions appear after your first Build.</p>;
  }

  const Chevron = open ? ChevronDown : ChevronRight;

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1">
        <button onClick={() => setOpen((o) => !o)} className={`flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wide ${t.textFaint}`}>
          <Chevron className="w-3.5 h-3.5" />
          <History className="w-3.5 h-3.5" /> History
          {versions && versions.length > 0 && <span className={`ml-1 ${t.accent}`}>{versions.length}</span>}
        </button>
        {open && (
          <button onClick={load} title="Refresh" className={`ml-auto rounded p-0.5 ${t.hover} ${t.textFaint}`}>
            <RefreshCw className="w-3 h-3" />
          </button>
        )}
      </div>

      {open && (
        <>
          {error && <p className="text-[11px] font-semibold text-rose-500">{error}</p>}
          {versions === null && <div className={`flex items-center gap-2 text-[11px] ${t.textFaint}`}><Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading…</div>}
          {versions && versions.length === 0 && !error && <p className={`text-[11px] ${t.textFaint}`}>No versions yet.</p>}
          {versions && versions.map((v) => (
            <div key={v.id} className={`flex items-center gap-2 rounded-md border ${t.edge} px-2 py-1.5`}>
              {v.createdBy === 'user' ? <User className={`w-3.5 h-3.5 shrink-0 ${t.textFaint}`} /> : <Bot className={`w-3.5 h-3.5 shrink-0 ${t.accent}`} />}
              <div className="min-w-0">
                <p className={`truncate text-xs ${t.text}`}>{v.label || 'build'}</p>
                <p className={`text-[10px] ${t.textFaint}`}>{v.createdBy} · {rel(v.createdAt)}</p>
              </div>
              <button
                onClick={() => restore(v.id)}
                disabled={restoring === v.id}
                title="Restore this version into the editor"
                className={`ml-auto inline-flex items-center gap-1 text-[11px] font-semibold rounded-full border ${t.edge} px-2 py-0.5 ${t.textDim} ${t.hover} disabled:opacity-60`}
              >
                {restoring === v.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <Undo2 className="w-3 h-3" />} Restore
              </button>
            </div>
          ))}
        </>
      )}
    </div>
  );
};
