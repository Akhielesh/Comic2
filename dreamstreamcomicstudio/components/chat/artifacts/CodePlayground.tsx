import React, { useState } from 'react';
import { Terminal, Play, Loader2, AlertTriangle, RotateCcw, Copy, Check } from 'lucide-react';
import { runJavaScript, type JsRunResult } from '../../../services/jsRunner';
import { runPython, isPythonRuntimeLoaded } from '../../../services/pyRunner';
import type { CodeExerciseArtifact } from '../../../apiTypes';
import { Surface, SurfaceTitle, Badge } from './kit';

// An interactive code playground the AI generates for learning. The user writes code and
// runs it in a sandboxed Web Worker — real output, real errors — so they actually
// practise rather than just read. JavaScript and Python execute live (Python via Pyodide,
// lazy-loaded on first run); other languages render the starter read-only with a note.

const JS_LANGS = new Set(['javascript', 'js', 'node', 'nodejs', '']);
const PY_LANGS = new Set(['python', 'py', 'python3']);

export const CodePlayground: React.FC<{ data: CodeExerciseArtifact }> = ({ data }) => {
  const lang = (data.language || 'javascript').toLowerCase();
  const isPython = PY_LANGS.has(lang);
  const canRun = JS_LANGS.has(lang) || isPython;
  const defaultStarter = isPython ? '# write Python here\nprint("hello")' : '// write JavaScript here\nconsole.log("hello");';
  const [code, setCode] = useState(data.starterCode || defaultStarter);
  const [result, setResult] = useState<JsRunResult | null>(null);
  const [running, setRunning] = useState(false);
  const [copied, setCopied] = useState(false);

  const starter = data.starterCode || defaultStarter;
  const copy = async () => {
    try { await navigator.clipboard.writeText(code); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* clipboard unavailable */ }
  };

  const run = async () => {
    if (!code.trim() || running || !canRun) return;
    setRunning(true);
    setResult(null);
    try {
      setResult(await (isPython ? runPython(code) : runJavaScript(code)));
    } catch (e) {
      setResult({ logs: [], error: (e as Error)?.message || 'Could not run the code.' });
    } finally {
      setRunning(false);
    }
  };

  const levelColor: Record<string, string> = {
    log: 'text-slate-100', info: 'text-sky-300', warn: 'text-amber-300', error: 'text-red-400'
  };

  return (
    <Surface
      accent="#059669"
      header={
        <div className="flex items-start gap-2">
          <span className="mt-0.5 shrink-0 rounded-lg bg-[var(--ds-well-strong)] p-1.5 text-[var(--ds-muted)]">
            <Terminal className="w-4 h-4" />
          </span>
          <SurfaceTitle>{data.title || 'Code practice'}</SurfaceTitle>
        </div>
      }
      right={<Badge color="#059669">{isPython ? 'Python · Pyodide' : canRun ? 'JavaScript · sandboxed' : `${data.language} · read-only`}</Badge>}
    >
      <div className="px-3 pb-3 space-y-3">
        {data.instructions && <p className="text-sm text-[var(--ds-muted)]">{data.instructions}</p>}
        {data.task && (
          <div className="text-sm text-[var(--ds-ink)] rounded-xl bg-[var(--ds-well)] p-2.5">
            <span className="font-semibold text-emerald-800">Task:</span> {data.task}
          </div>
        )}

        <textarea
          value={code}
          onChange={(e) => setCode(e.target.value)}
          onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); void run(); } }}
          rows={Math.min(16, Math.max(4, code.split('\n').length))}
          spellCheck={false}
          readOnly={!canRun}
          className="w-full font-mono text-[13px] border border-[var(--ds-hairline)] rounded-xl p-2.5 bg-slate-900 text-slate-100 focus:outline-none focus:border-[var(--ds-accent)] resize-y"
          placeholder="Write code here…"
        />

        {canRun ? (
          <div className="flex items-center gap-2">
            <button
              onClick={() => void run()}
              disabled={running || !code.trim()}
              className="flex items-center gap-1.5 text-sm font-semibold rounded-lg px-4 py-1.5 bg-[var(--ds-accent)] text-white transition-colors duration-200 hover:bg-[var(--ds-accent-hover)] disabled:opacity-40"
            >
              {running ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />} Run
            </button>
            {running && isPython && !isPythonRuntimeLoaded() ? (
              <span className="text-[11px] text-[var(--ds-muted)]">Downloading Python runtime (first run, ~6MB)…</span>
            ) : (
              <span className="text-[11px] text-[var(--ds-muted)]">⌘/Ctrl + Enter</span>
            )}
            <button onClick={copy} title="Copy code" className="ml-auto flex items-center gap-1 rounded-lg border border-[var(--ds-hairline)] bg-[var(--ds-surface-soft)] px-2 py-1 text-[11px] font-semibold text-[var(--ds-muted)] transition-colors duration-200 hover:bg-[var(--ds-hover)] hover:text-[var(--ds-ink)]">
              {copied ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
            </button>
            <button onClick={() => setCode(starter)} title="Reset to starter code" className="flex items-center gap-1 rounded-lg border border-[var(--ds-hairline)] bg-[var(--ds-surface-soft)] px-2 py-1 text-[11px] font-semibold text-[var(--ds-muted)] transition-colors duration-200 hover:bg-[var(--ds-hover)] hover:text-[var(--ds-ink)]">
              <RotateCcw className="w-3.5 h-3.5" />
            </button>
          </div>
        ) : (
          <p className="text-[12px] text-[var(--ds-muted)]">Live run currently supports JavaScript. This {data.language} snippet is shown as a reference.</p>
        )}

        {/* Console output: captured logs + any thrown error. */}
        {result && (
          <div className="border border-[var(--ds-hairline)] rounded-xl overflow-hidden">
            <div className="bg-[var(--ds-well)] px-2.5 py-1.5 text-[11px] font-semibold text-[var(--ds-muted)] border-b border-[var(--ds-hairline-soft)] flex items-center gap-1.5">
              <Terminal className="w-3.5 h-3.5" /> Console
            </div>
            <div className="bg-slate-900 max-h-72 overflow-y-auto p-2.5 font-mono text-[12px] leading-relaxed">
              {result.logs.length === 0 && !result.error && <div className="text-slate-500 italic">No output.</div>}
              {result.logs.map((l, i) => (
                <div key={i} className={`whitespace-pre-wrap break-words ${levelColor[l.level] || 'text-slate-100'}`}>{l.text}</div>
              ))}
              {result.error && (
                <div className="flex items-start gap-1.5 text-red-400 whitespace-pre-wrap break-words mt-1">
                  <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" /> {result.error}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </Surface>
  );
};
