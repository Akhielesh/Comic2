// Lazy multi-file Sandpack playground, shown in the side panel. Loads all of a
// message's code files at once so the user can run + iterate across files.

import React from 'react';
import { Sandpack } from '@codesandbox/sandpack-react';
import type { SandpackTemplate } from '../../services/chatUtils';

export interface PlaygroundData {
  files: Record<string, string>;
  template: SandpackTemplate;
  title?: string;
}

const MultiFilePlayground: React.FC<{ data: PlaygroundData }> = ({ data }) => (
  <div className="h-full overflow-auto">
    <Sandpack
      template={data.template}
      theme="dark"
      files={data.files}
      options={{ editorHeight: 560, showTabs: true, showLineNumbers: true }}
    />
  </div>
);

export default MultiFilePlayground;
