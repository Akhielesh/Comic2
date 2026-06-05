// Monaco editor wrapped for Code Studio (Sprint 1): a dark theme matched to the workspace,
// per-file models (so undo history is preserved per tab), language inferred from the path,
// and JSX-tolerant TS settings. @monaco-editor/react loads Monaco lazily.

import React from 'react';
import Editor, { type BeforeMount, type OnMount } from '@monaco-editor/react';
import { Skeleton } from '../kit';

const langFromPath = (path: string): string => {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  switch (ext) {
    case 'ts':
    case 'tsx': return 'typescript';
    case 'js':
    case 'jsx':
    case 'mjs':
    case 'cjs': return 'javascript';
    case 'json': return 'json';
    case 'css': return 'css';
    case 'scss':
    case 'sass': return 'scss';
    case 'less': return 'less';
    case 'html':
    case 'htm': return 'html';
    case 'md':
    case 'markdown': return 'markdown';
    case 'yml':
    case 'yaml': return 'yaml';
    default: return 'plaintext';
  }
};

const defineStudioTheme: BeforeMount = (monaco) => {
  monaco.editor.defineTheme('studio-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': '#0e1219',
      'editorGutter.background': '#0e1219',
      'editor.lineHighlightBackground': '#11151f',
      'editor.lineHighlightBorder': '#00000000',
      'editorLineNumber.foreground': '#3b465c',
      'editorLineNumber.activeForeground': '#7c8aa5',
      'editorIndentGuide.background1': '#1c2433',
      'editor.selectionBackground': '#21314d',
      'scrollbarSlider.background': '#1c243388',
    },
  });
};

export interface MonacoEditorProps {
  path: string;
  value: string;
  onChange: (value: string) => void;
  readOnly?: boolean;
}

export const MonacoEditor: React.FC<MonacoEditorProps> = ({ path, value, onChange, readOnly }) => {
  const handleMount: OnMount = (_editor, monaco) => {
    // Be permissive: this is a previewing editor, not a type-checker. Keep JSX working and
    // suppress noisy semantic squiggles for snippets that reference uninstalled modules.
    const ts = monaco.languages.typescript;
    const opts = {
      jsx: ts.JsxEmit.React,
      allowJs: true,
      allowNonTsExtensions: true,
      esModuleInterop: true,
      target: ts.ScriptTarget.Latest,
      moduleResolution: ts.ModuleResolutionKind.NodeJs,
    };
    ts.typescriptDefaults.setCompilerOptions(opts);
    ts.javascriptDefaults.setCompilerOptions(opts);
    ts.typescriptDefaults.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: false });
  };

  return (
    <Editor
      path={path}
      language={langFromPath(path)}
      value={value}
      theme="studio-dark"
      beforeMount={defineStudioTheme}
      onMount={handleMount}
      onChange={(v) => onChange(v ?? '')}
      loading={<div className="p-3 h-full"><Skeleton className="h-full min-h-[12rem] w-full" /></div>}
      options={{
        readOnly,
        fontSize: 13,
        lineHeight: 20,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        smoothScrolling: true,
        automaticLayout: true,
        tabSize: 2,
        fontLigatures: true,
        padding: { top: 10, bottom: 10 },
        renderLineHighlight: 'line',
        cursorBlinking: 'smooth',
        scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8 },
        overviewRulerLanes: 0,
        guides: { indentation: true },
      }}
    />
  );
};
