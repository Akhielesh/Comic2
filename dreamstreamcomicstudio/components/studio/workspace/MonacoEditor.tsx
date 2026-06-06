// Monaco editor wrapped for Code Studio (Sprint 1): a dark theme matched to the workspace,
// per-file models (so undo history is preserved per tab), language inferred from the path,
// and JSX-tolerant TS settings. @monaco-editor/react loads Monaco lazily.

import React from 'react';
import Editor, { type BeforeMount, type OnMount } from '@monaco-editor/react';
import { Skeleton, useStudioTheme } from '../kit';

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

const defineStudioThemes: BeforeMount = (monaco) => {
  // Absolute-black dark theme.
  monaco.editor.defineTheme('studio-black', {
    base: 'vs-dark',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': '#0B0B0F',
      'editorGutter.background': '#0B0B0F',
      'editor.lineHighlightBackground': '#15151c',
      'editor.lineHighlightBorder': '#00000000',
      'editorLineNumber.foreground': '#3a3a46',
      'editorLineNumber.activeForeground': '#9a92b8',
      'editorIndentGuide.background1': '#1c1c26',
      'editor.selectionBackground': '#2c2452',
      'scrollbarSlider.background': '#7c5cff33',
    },
  });
  // Clean light theme (also used by the DreamStream brand theme).
  monaco.editor.defineTheme('studio-light', {
    base: 'vs',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': '#ffffff',
      'editorGutter.background': '#ffffff',
      'editor.lineHighlightBackground': '#f1f5f9',
      'editor.lineHighlightBorder': '#00000000',
      'editorLineNumber.foreground': '#cbd5e1',
      'editorLineNumber.activeForeground': '#64748b',
      'editor.selectionBackground': '#bae6fd',
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
  const t = useStudioTheme();
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
      theme={t.monaco}
      beforeMount={defineStudioThemes}
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
