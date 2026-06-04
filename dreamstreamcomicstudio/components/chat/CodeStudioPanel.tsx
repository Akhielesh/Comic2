// Full Code Studio panel — Sandpack editor + live preview for multi-file apps
// emitted by the generate_app tool. Rendered in the resizable side panel.
// Supports Code/Preview tabs and passes editorHeight for responsive sizing.

import React from 'react';
import { Sandpack } from '@codesandbox/sandpack-react';
import type { CodeStudioArtifact } from '../../apiTypes';

// Sandpack's built-in templates (static maps to vanilla since Sandpack has no
// "static" preset — it's treated as plain HTML with no build step).
const SANDPACK_TEMPLATE = (t: string): 'react-ts' | 'react' | 'vanilla-ts' | 'vanilla' => {
  const map: Record<string, 'react-ts' | 'react' | 'vanilla-ts' | 'vanilla'> = {
    'react-ts': 'react-ts',
    react: 'react',
    'vanilla-ts': 'vanilla-ts',
    vanilla: 'vanilla',
    static: 'vanilla',
  };
  return map[t] ?? 'react-ts';
};

export interface CodeStudioPanelProps {
  data: CodeStudioArtifact;
  /** Height of the code editor portion in pixels (responsive to panel mode). */
  editorHeight?: number;
}

const CodeStudioPanel: React.FC<CodeStudioPanelProps> = ({ data, editorHeight = 520 }) => {
  const files: Record<string, string> = {};
  for (const f of data.files) {
    files[f.path] = f.content;
  }

  const template = SANDPACK_TEMPLATE(data.template);

  return (
    <div className="h-full overflow-auto bg-[#151515]">
      <Sandpack
        template={template}
        theme="dark"
        files={files}
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
