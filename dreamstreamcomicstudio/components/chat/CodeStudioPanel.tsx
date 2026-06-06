// Full Code Studio panel — Sandpack editor + live preview for multi-file apps emitted by the
// generate_app tool / the in-studio generator. Rendered in the resizable side panel and as the
// Code Studio's instant in-browser preview.
//
// Apps are normalized into Sandpack's canonical shape first (see sandpackProject.ts) so a real
// Vite project structure (/index.html → /src/main.tsx → /src/App.tsx) actually mounts instead of
// crashing on a missing #root ("Cannot set properties of null (setting 'innerHTML')").

import React from 'react';
import { Sandpack } from '@codesandbox/sandpack-react';
import type { CodeStudioArtifact } from '../../apiTypes';
import { buildSandpackProject } from '../studio/workspace/sandpackProject';

export interface CodeStudioPanelProps {
  data: CodeStudioArtifact;
  /** Height of the code editor portion in pixels (responsive to panel mode). */
  editorHeight?: number;
}

const CodeStudioPanel: React.FC<CodeStudioPanelProps> = ({ data, editorHeight = 520 }) => {
  const { template, files, entry, dependencies } = buildSandpackProject(data);

  return (
    <div className="h-full overflow-auto bg-[#0b0b0f]">
      <Sandpack
        template={template}
        theme="dark"
        files={files}
        customSetup={entry || dependencies ? { entry, dependencies } : undefined}
        options={{
          editorHeight,
          showTabs: true,
          showLineNumbers: true,
          showRefreshButton: true,
          showNavigator: false,
          resizablePanels: true,
          closableTabs: false,
        }}
      />
    </div>
  );
};

export default CodeStudioPanel;
