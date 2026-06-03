// Heavy, lazy-loaded React/JS playground. Imported via React.lazy from CodeBlock so
// Sandpack only ships to users who actually open a "Run" tab (code-split chunk).

import React from 'react';
import { Sandpack } from '@codesandbox/sandpack-react';

interface ReactPlaygroundProps {
  code: string;
  lang: string;
}

const ReactPlayground: React.FC<ReactPlaygroundProps> = ({ code, lang }) => {
  const l = lang.toLowerCase();
  const isTs = l === 'tsx' || l === 'ts' || l === 'typescript';
  const looksReact =
    l === 'tsx' || l === 'jsx' || /from\s+['"]react['"]|import\s+React|export\s+default/.test(code);

  if (looksReact) {
    const file = isTs ? '/App.tsx' : '/App.js';
    return (
      <Sandpack
        template={isTs ? 'react-ts' : 'react'}
        theme="dark"
        files={{ [file]: code }}
        options={{ editorHeight: 360, showTabs: false, showLineNumbers: true }}
      />
    );
  }

  const file = isTs ? '/index.ts' : '/index.js';
  return (
    <Sandpack
      template={isTs ? 'vanilla-ts' : 'vanilla'}
      theme="dark"
      files={{ [file]: code }}
      options={{ editorHeight: 360, showTabs: false, showConsole: true, showLineNumbers: true }}
    />
  );
};

export default ReactPlayground;
