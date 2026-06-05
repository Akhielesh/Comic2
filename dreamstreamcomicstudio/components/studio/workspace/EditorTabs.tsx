// Editor tab bar (Sprint 1): open files as closable tabs with a dirty dot + active underline.

import React from 'react';
import { X } from 'lucide-react';
import { useStudioTheme } from '../kit';

export interface EditorTabsProps {
  openPaths: string[];
  activePath: string | null;
  dirtyPaths: string[];
  onSelect: (path: string) => void;
  onClose: (path: string) => void;
}

const baseName = (path: string) => path.split('/').filter(Boolean).pop() || path;

export const EditorTabs: React.FC<EditorTabsProps> = ({ openPaths, activePath, dirtyPaths, onSelect, onClose }) => {
  const t = useStudioTheme();
  const dirty = new Set(dirtyPaths);
  if (openPaths.length === 0) return null;
  return (
    <div className={`flex items-stretch overflow-x-auto border-b ${t.edge} ${t.panelAlt}`}>
      {openPaths.map((path) => {
        const active = path === activePath;
        const isDirty = dirty.has(path);
        return (
          <div
            key={path}
            className={`group relative flex items-center gap-2 pl-3 pr-2 py-1.5 text-xs font-mono border-r ${t.edge} cursor-pointer whitespace-nowrap ${
              active ? `${t.editorBg} ${t.text}` : `${t.textDim} ${t.hover}`
            }`}
            onClick={() => onSelect(path)}
            title={path}
          >
            {active && <span className={`absolute inset-x-0 top-0 h-0.5 ${t.accentBg}`} />}
            <span className="truncate max-w-[12rem]">{baseName(path)}</span>
            {isDirty ? (
              <span className="h-1.5 w-1.5 rounded-full bg-amber-400 group-hover:hidden" title="Unsaved changes" />
            ) : null}
            <button
              onClick={(e) => { e.stopPropagation(); onClose(path); }}
              className={`rounded p-0.5 ${t.hover} ${isDirty ? 'hidden group-hover:inline-flex' : 'opacity-60 hover:opacity-100'}`}
              title="Close"
              aria-label={`Close ${baseName(path)}`}
            >
              <X className="w-3 h-3" />
            </button>
          </div>
        );
      })}
    </div>
  );
};
