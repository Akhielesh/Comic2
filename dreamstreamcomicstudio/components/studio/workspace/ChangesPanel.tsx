// ChangesPanel (Sprint 3, S3.1/S3.3): the "what changed since you opened this" view — the
// dirty files (working copy vs. loaded baseline), each expandable to a diff, with per-file and
// bulk revert. Self-contained (no backend); changes persist on the next Build.

import React, { useMemo, useState } from 'react';
import { GitCompare, ChevronRight, ChevronDown, Undo2 } from 'lucide-react';
import { useStudioWorkspace, isPathDirty } from './workspaceStore';
import { diffLines, diffStat } from './diff';
import { DiffView } from './DiffView';
import { useStudioTheme } from '../kit';

const baseName = (p: string) => p.split('/').filter(Boolean).pop() || p;

const ChangedFile: React.FC<{ path: string; oldText: string; newText: string; onOpen: () => void; onRevert: () => void }> =
  ({ path, oldText, newText, onOpen, onRevert }) => {
    const t = useStudioTheme();
    const [open, setOpen] = useState(false);
    const stat = useMemo(() => diffStat(diffLines(oldText, newText)), [oldText, newText]);
    const Chevron = open ? ChevronDown : ChevronRight;
    return (
      <div className={`rounded-md border ${t.edge}`}>
        <div className={`flex items-center gap-1.5 px-2 py-1.5 ${t.hover}`}>
          <button onClick={() => setOpen((o) => !o)} className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
            <Chevron className={`w-3.5 h-3.5 shrink-0 ${t.textFaint}`} />
            <button onClick={(e) => { e.stopPropagation(); onOpen(); }} className={`truncate text-xs font-mono ${t.text}`} title={path}>
              {baseName(path)}
            </button>
            <span className="ml-1 shrink-0 text-[10px] font-semibold">
              {stat.added > 0 && <span className="text-emerald-600">+{stat.added}</span>}
              {stat.removed > 0 && <span className="ml-1 text-rose-600">-{stat.removed}</span>}
            </span>
          </button>
          <button onClick={onRevert} title="Revert this file" aria-label={`Revert ${baseName(path)}`} className={`shrink-0 rounded p-0.5 ${t.hover} ${t.textDim}`}>
            <Undo2 className="w-3.5 h-3.5" />
          </button>
        </div>
        {open && <div className="px-2 pb-2"><DiffView oldText={oldText} newText={newText} /></div>}
      </div>
    );
  };

export const ChangesPanel: React.FC = () => {
  const t = useStudioTheme();
  const { files, baseline, paths, openFile, revertFile } = useStudioWorkspace();
  const dirty = useMemo(
    () => paths.filter((p) => isPathDirty({ files, baseline }, p)),
    [paths, files, baseline]
  );

  if (dirty.length === 0) return null;

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <p className={`text-[11px] font-semibold uppercase tracking-wide ${t.textFaint}`}>
          <GitCompare className="mr-1 inline w-3.5 h-3.5" />Changes
          <span className={`ml-1 ${t.accent}`}>{dirty.length}</span>
        </p>
        <button
          onClick={() => dirty.forEach((p) => revertFile(p))}
          className={`ml-auto inline-flex items-center gap-1 text-[11px] font-semibold rounded-full border ${t.edge} px-2 py-0.5 ${t.textDim} ${t.hover}`}
          title="Revert all changes to the loaded version"
        >
          <Undo2 className="w-3 h-3" /> Revert all
        </button>
      </div>
      <div className="space-y-1.5">
        {dirty.map((p) => (
          <ChangedFile
            key={p}
            path={p}
            oldText={baseline[p] ?? ''}
            newText={files[p] ?? ''}
            onOpen={() => openFile(p)}
            onRevert={() => revertFile(p)}
          />
        ))}
      </div>
    </div>
  );
};
