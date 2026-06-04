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

// Build-only tooling that Sandpack supplies itself (it bundles in-browser, it does
// not run Vite/TS). Including these as "dependencies" would make Sandpack try to
// install a bundler it doesn't use, so we strip them.
const BUILD_ONLY_DEPS = new Set([
  'vite', '@vitejs/plugin-react', '@vitejs/plugin-react-swc', 'typescript',
  'react-scripts', 'webpack', 'esbuild', 'parcel', '@types/react', '@types/react-dom'
]);

/** Pull runtime npm dependencies out of the project's package.json, if it ships one. */
const extractDependencies = (data: CodeStudioArtifact): Record<string, string> | undefined => {
  const pkg = data.files.find((f) => f.path.replace(/^\/+/, '') === 'package.json');
  if (!pkg) return undefined;
  try {
    const parsed = JSON.parse(pkg.content) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    const merged = { ...(parsed.dependencies || {}), ...(parsed.devDependencies || {}) };
    const deps: Record<string, string> = {};
    for (const [name, version] of Object.entries(merged)) {
      if (!BUILD_ONLY_DEPS.has(name)) deps[name] = version;
    }
    return Object.keys(deps).length ? deps : undefined;
  } catch {
    return undefined;
  }
};

const CodeStudioPanel: React.FC<CodeStudioPanelProps> = ({ data, editorHeight = 520 }) => {
  const files: Record<string, string> = {};
  for (const f of data.files) {
    // package.json is consumed via customSetup.dependencies below; passing it as a
    // file too would clash with Sandpack's own template package.json.
    if (f.path.replace(/^\/+/, '') === 'package.json') continue;
    files[f.path] = f.content;
  }

  const template = SANDPACK_TEMPLATE(data.template);
  const dependencies = extractDependencies(data);

  return (
    <div className="h-full overflow-auto bg-[#151515]">
      <Sandpack
        template={template}
        theme="dark"
        files={files}
        customSetup={dependencies ? { dependencies } : undefined}
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
