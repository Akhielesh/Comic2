// CodeWorkspace (Sprint 1): the editor half of Code Studio — file tree + tabs + Monaco,
// all reading/writing the shared workspace store. Drops into the "Code" pane of CodeStudioView.

import React, { useMemo } from 'react';
import { FolderTree, FileCode } from 'lucide-react';
import { useStudioWorkspace, isPathDirty } from './workspaceStore';
import { FileTree } from './FileTree';
import { EditorTabs } from './EditorTabs';
import { MonacoEditor } from './MonacoEditor';
import { useStudioTheme } from '../kit';

export interface CodeWorkspaceProps {
  /** Editing disabled (e.g. while a build runs) renders the editor read-only. */
  readOnly?: boolean;
}

export const CodeWorkspace: React.FC<CodeWorkspaceProps> = ({ readOnly }) => {
  const t = useStudioTheme();
  const { files, baseline, paths, openPaths, activePath, openFile, closeFile, setActive, updateContent } =
    useStudioWorkspace();

  const dirty = useMemo(
    () => paths.filter((p) => isPathDirty({ files, baseline }, p)),
    [paths, files, baseline]
  );

  return (
    <div className="grid h-full min-h-0 grid-cols-[minmax(8rem,13rem)_minmax(0,1fr)]">
      {/* File tree */}
      <div className={`flex min-h-0 flex-col border-r ${t.edge} ${t.panelAlt}`}>
        <div className={`flex items-center gap-1.5 px-3 py-2 text-[11px] uppercase tracking-wide ${t.textFaint} border-b ${t.edge}`}>
          <FolderTree className="w-3.5 h-3.5" /> Explorer
        </div>
        <div className="min-h-0 flex-1 overflow-auto">
          <FileTree paths={paths} activePath={activePath} dirtyPaths={dirty} onOpen={openFile} />
        </div>
      </div>

      {/* Tabs + editor */}
      <div className={`flex min-h-0 flex-col ${t.editorBg}`}>
        <EditorTabs
          openPaths={openPaths}
          activePath={activePath}
          dirtyPaths={dirty}
          onSelect={setActive}
          onClose={closeFile}
        />
        <div className="min-h-0 flex-1">
          {activePath ? (
            <MonacoEditor
              path={activePath}
              value={files[activePath] ?? ''}
              onChange={(v) => updateContent(activePath, v)}
              readOnly={readOnly}
            />
          ) : (
            <div className="h-full flex flex-col items-center justify-center gap-2 text-center p-6">
              <FileCode className={`w-7 h-7 ${t.textFaint}`} />
              <p className={`text-sm ${t.textDim}`}>Select a file from the explorer to edit it.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
