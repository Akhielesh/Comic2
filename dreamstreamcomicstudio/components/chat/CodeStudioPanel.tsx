// Full Code Studio panel — Sandpack editor + live preview for multi-file apps emitted by the
// generate_app tool / the in-studio generator. Rendered in the resizable side panel and as the
// Code Studio's instant in-browser preview.
//
// Apps are normalized into Sandpack's canonical shape first (see sandpackProject.ts) so a real
// Vite project structure (/index.html → /src/main.tsx → /src/App.tsx) actually mounts instead of
// crashing on a missing #root ("Cannot set properties of null (setting 'innerHTML')").
//
// Uses the composed Sandpack API (Provider + Layout) instead of <Sandpack> so we can observe
// runtime/compile errors and surface a one-click "Fix with AI" autodebug loop (onError).

import React, { useEffect } from 'react';
import {
  SandpackProvider, SandpackLayout, SandpackCodeEditor, SandpackPreview, useSandpack,
} from '@codesandbox/sandpack-react';
import type { CodeStudioArtifact } from '../../apiTypes';
import { buildSandpackProject } from '../studio/workspace/sandpackProject';

export interface CodeStudioPanelProps {
  data: CodeStudioArtifact;
  /** Height of the editor/preview in pixels (responsive to panel mode). */
  editorHeight?: number;
  /** Show only the running app (no Sandpack editor) — the studio has its own Monaco editor. */
  previewOnly?: boolean;
  /** Called with the preview's current error message (or null when clean) — drives autodebug. */
  onError?: (message: string | null) => void;
}

/** Bridges Sandpack's bundler error out to the parent (for the "Fix with AI" loop). */
const ErrorWatcher: React.FC<{ onError: (message: string | null) => void }> = ({ onError }) => {
  const { sandpack } = useSandpack();
  const message = sandpack.error?.message ?? null;
  useEffect(() => { onError(message); }, [message, onError]);
  return null;
};

const CodeStudioPanel: React.FC<CodeStudioPanelProps> = ({ data, editorHeight = 520, previewOnly = false, onError }) => {
  const { template, files, entry, dependencies } = buildSandpackProject(data);

  return (
    <div className="h-full overflow-auto bg-[#0b0b0f]">
      <SandpackProvider
        template={template}
        theme="dark"
        files={files}
        customSetup={entry || dependencies ? { entry, dependencies } : undefined}
      >
        <SandpackLayout>
          {!previewOnly && (
            <SandpackCodeEditor showTabs showLineNumbers closableTabs={false} style={{ height: editorHeight }} />
          )}
          <SandpackPreview showOpenInCodeSandbox={false} showRefreshButton style={{ height: editorHeight }} />
        </SandpackLayout>
        {onError && <ErrorWatcher onError={onError} />}
      </SandpackProvider>
    </div>
  );
};

export default CodeStudioPanel;
