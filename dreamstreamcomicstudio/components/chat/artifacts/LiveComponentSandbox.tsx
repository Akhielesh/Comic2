import React from 'react';
import { SandpackProvider, SandpackPreview } from '@codesandbox/sandpack-react';

// Preview-only Sandpack — the model-/MCP-authored component runs inside Sandpack's
// SANDBOXED iframe (no access to the host page, cookies, localStorage or our origin),
// the same vetted runtime the code playground already uses. Lazy-loaded so the heavy
// bundler chunk only ships when a user taps "Run" on a custom-component widget.

interface Props {
  code: string;
  height?: number;
  dependencies?: Record<string, string>;
}

const LiveComponentSandbox: React.FC<Props> = ({ code, height = 320, dependencies }) => (
  <SandpackProvider
    template="react-ts"
    theme="auto"
    files={{ '/App.tsx': code }}
    customSetup={dependencies && Object.keys(dependencies).length ? { dependencies } : undefined}
    options={{ recompileMode: 'delayed', recompileDelay: 400 }}
  >
    <SandpackPreview
      showOpenInCodeSandbox={false}
      showRefreshButton
      showSandpackErrorOverlay
      style={{ height }}
    />
  </SandpackProvider>
);

export default LiveComponentSandbox;
