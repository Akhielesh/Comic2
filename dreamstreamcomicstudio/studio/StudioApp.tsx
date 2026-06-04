// The dedicated Code Studio — a real in-browser dev environment (WebContainer) that
// runs in its own cross-origin-isolated tab. Boots Node, npm-installs, runs the Vite
// dev server, and gives the user an editor, a live preview, a terminal, AI debugging,
// and a one-click zip download. All execution is client-side; no server compute.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Play, RotateCw, Download, Bug, Terminal as TerminalIcon, Monitor, Loader2,
  FileCode, AlertTriangle, RefreshCw, CheckCircle2
} from 'lucide-react';
import type { WebContainer, WebContainerProcess } from '@webcontainer/api';
import { readStudioPayload, downloadProjectZip } from '../services/studioLauncher';
import { scaffold } from './scaffold';
import { bootContainer, filesToTree, runToExit, startProcess, writeFile } from './webcontainerRuntime';
import { requestAiFix } from './aiFix';
import type { CodeStudioArtifact } from '../apiTypes';

type Status = 'idle' | 'booting' | 'installing' | 'running' | 'ready' | 'error' | 'unsupported';

const STATUS_LABEL: Record<Status, string> = {
  idle: 'Idle',
  booting: 'Booting sandbox…',
  installing: 'Installing dependencies…',
  running: 'Starting dev server…',
  ready: 'Live',
  error: 'Error',
  unsupported: 'Unsupported'
};

const STATUS_COLOR: Record<Status, string> = {
  idle: 'bg-slate-200 text-slate-700',
  booting: 'bg-sky-200 text-sky-800',
  installing: 'bg-amber-200 text-amber-800',
  running: 'bg-amber-200 text-amber-800',
  ready: 'bg-lime-300 text-lime-900',
  error: 'bg-red-200 text-red-800',
  unsupported: 'bg-red-200 text-red-800'
};

const LOG_CAP = 600;
const guessLang = (path: string): string => path.split('.').pop()?.toLowerCase() || '';

export const StudioApp: React.FC = () => {
  const [artifact] = useState<CodeStudioArtifact | null>(() => readStudioPayload());
  const [files, setFiles] = useState<Record<string, string>>({});
  const [devCmd, setDevCmd] = useState<[string, string[]]>(['npm', ['run', 'dev']]);
  const [installCmd, setInstallCmd] = useState<[string, string[]]>(['npm', ['install']]);
  const [activeFile, setActiveFile] = useState<string>('');
  const [status, setStatus] = useState<Status>('idle');
  const [log, setLog] = useState<string[]>([]);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [rightTab, setRightTab] = useState<'preview' | 'terminal'>('preview');
  const [fixing, setFixing] = useState(false);

  const wcRef = useRef<WebContainer | null>(null);
  const devProcRef = useRef<WebContainerProcess | null>(null);
  const logEndRef = useRef<HTMLDivElement>(null);
  const writeTimers = useRef<Record<string, number>>({});

  const appendLog = useCallback((chunk: string) => {
    setLog((prev) => {
      const next = (prev.join('') + chunk).split('\n');
      return next.slice(-LOG_CAP);
    });
  }, []);

  useEffect(() => {
    if (rightTab === 'terminal') logEndRef.current?.scrollIntoView({ block: 'end' });
  }, [log, rightTab]);

  // Boot + scaffold + install + run, once, on mount.
  useEffect(() => {
    if (!artifact) return;
    if (typeof window !== 'undefined' && !window.crossOriginIsolated) {
      setStatus('unsupported');
      return;
    }
    const result = scaffold(artifact);
    setFiles(result.files);
    setInstallCmd(result.installCommand);
    setDevCmd(result.devCommand);
    setActiveFile(
      Object.keys(result.files).find((p) => /src\/App\.(t|j)sx?$/.test(p)) ||
      Object.keys(result.files).find((p) => p.endsWith('.html')) ||
      Object.keys(result.files)[0] || ''
    );

    let cancelled = false;
    (async () => {
      try {
        setStatus('booting');
        const wc = await bootContainer();
        if (cancelled) return;
        wcRef.current = wc;
        wc.on('server-ready', (_port, url) => {
          setPreviewUrl(url);
          setStatus('ready');
        });
        wc.on('error', (e) => appendLog(`\n[sandbox error] ${e.message}\n`));

        await wc.mount(filesToTree(result.files));

        setStatus('installing');
        appendLog(`$ ${result.installCommand[0]} ${result.installCommand[1].join(' ')}\n`);
        const code = await runToExit(wc, result.installCommand[0], result.installCommand[1], appendLog);
        if (cancelled) return;
        if (code !== 0) {
          appendLog(`\nInstall exited with code ${code}.\n`);
          setStatus('error');
          setRightTab('terminal');
          return;
        }

        setStatus('running');
        appendLog(`\n$ ${result.devCommand[0]} ${result.devCommand[1].join(' ')}\n`);
        devProcRef.current = await startProcess(wc, result.devCommand[0], result.devCommand[1], appendLog);
      } catch (err) {
        if (cancelled) return;
        appendLog(`\n[boot failed] ${(err as Error)?.message || err}\n`);
        setStatus('error');
        setRightTab('terminal');
      }
    })();

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [artifact]);

  // Edit a file: update state immediately, debounce the write into the live container.
  const onEdit = (path: string, content: string) => {
    setFiles((prev) => ({ ...prev, [path]: content }));
    const wc = wcRef.current;
    if (!wc) return;
    window.clearTimeout(writeTimers.current[path]);
    writeTimers.current[path] = window.setTimeout(() => {
      void writeFile(wc, path, content).catch((e) => appendLog(`\n[write failed] ${path}: ${e}\n`));
    }, 250);
  };

  const restartDev = async () => {
    const wc = wcRef.current;
    if (!wc) return;
    devProcRef.current?.kill();
    setPreviewUrl(null);
    setStatus('running');
    appendLog(`\n$ ${devCmd[0]} ${devCmd[1].join(' ')}\n`);
    devProcRef.current = await startProcess(wc, devCmd[0], devCmd[1], appendLog);
  };

  const reinstall = async () => {
    const wc = wcRef.current;
    if (!wc) return;
    devProcRef.current?.kill();
    setPreviewUrl(null);
    setStatus('installing');
    appendLog(`\n$ ${installCmd[0]} ${installCmd[1].join(' ')}\n`);
    const code = await runToExit(wc, installCmd[0], installCmd[1], appendLog);
    if (code !== 0) { setStatus('error'); setRightTab('terminal'); return; }
    await restartDev();
  };

  const onDebug = async () => {
    if (fixing) return;
    setFixing(true);
    setRightTab('terminal');
    appendLog(`\n— Asking AI to debug (${Object.keys(files).length} files)…\n`);
    try {
      const errorLog = log.join('').split('\n').slice(-80).join('\n');
      const { files: fixed, note } = await requestAiFix(files, errorLog);
      const changed = Object.keys(fixed);
      if (!changed.length) {
        appendLog('AI returned no changes.\n');
        return;
      }
      appendLog(`AI fixed ${changed.length} file(s)${note ? `: ${note}` : ''}\n${changed.map((c) => `  • ${c}`).join('\n')}\n`);
      const wc = wcRef.current;
      const next = { ...files };
      for (const [p, c] of Object.entries(fixed)) {
        next[p] = c;
        if (wc) await writeFile(wc, p, c);
      }
      setFiles(next);
      if (changed.includes('package.json')) await reinstall();
      else await restartDev();
    } catch (err) {
      appendLog(`\n[debug failed] ${(err as Error)?.message || err}\n`);
    } finally {
      setFixing(false);
    }
  };

  const sortedPaths = useMemo(() => Object.keys(files).sort(), [files]);
  const busy = status === 'booting' || status === 'installing' || status === 'running';

  if (!artifact) {
    return (
      <div className="h-[100dvh] flex items-center justify-center bg-slate-100 text-center p-6">
        <div>
          <FileCode className="w-10 h-10 mx-auto text-slate-400 mb-3" />
          <p className="font-bold text-slate-700">No project to open</p>
          <p className="text-sm text-slate-500 mt-1">Generate an app in chat, then click “Build in Studio”.</p>
        </div>
      </div>
    );
  }

  if (status === 'unsupported') {
    return (
      <div className="h-[100dvh] flex items-center justify-center bg-slate-100 text-center p-6">
        <div className="max-w-md">
          <AlertTriangle className="w-10 h-10 mx-auto text-amber-500 mb-3" />
          <p className="font-bold text-slate-700">This browser can’t run the live sandbox</p>
          <p className="text-sm text-slate-500 mt-1">
            The WebContainer needs cross-origin isolation, which your browser doesn’t support here
            (Safari is limited). You can still edit and download the code as a zip.
          </p>
          <button
            onClick={() => downloadProjectZip(artifact.title, files)}
            className="mt-4 inline-flex items-center gap-1.5 text-sm font-bold border-2 border-black rounded-full px-3 py-1 bg-lime-400 hover:bg-lime-300"
          >
            <Download className="w-4 h-4" /> Download .zip
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="h-[100dvh] flex flex-col bg-[#0f0f0f] text-slate-100">
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-3 py-2 border-b-2 border-black bg-lime-100 text-black shrink-0">
        <FileCode className="w-4 h-4 shrink-0 text-lime-700" />
        <span className="font-bold text-sm truncate">{artifact.title}</span>
        <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full flex items-center gap-1 ${STATUS_COLOR[status]}`}>
          {busy && <Loader2 className="w-3 h-3 animate-spin" />}
          {status === 'ready' && <CheckCircle2 className="w-3 h-3" />}
          {STATUS_LABEL[status]}
        </span>
        <div className="flex-1" />
        <button onClick={restartDev} disabled={busy} title="Restart dev server" className="inline-flex items-center gap-1 text-xs font-bold border-2 border-black rounded px-2 py-1 bg-white hover:bg-lime-200 disabled:opacity-40">
          <RotateCw className="w-3.5 h-3.5" /> Restart
        </button>
        <button onClick={reinstall} disabled={busy} title="Reinstall dependencies & run" className="inline-flex items-center gap-1 text-xs font-bold border-2 border-black rounded px-2 py-1 bg-white hover:bg-lime-200 disabled:opacity-40">
          <RefreshCw className="w-3.5 h-3.5" /> Reinstall
        </button>
        <button onClick={onDebug} disabled={fixing} title="Ask AI to find and fix the error" className="inline-flex items-center gap-1 text-xs font-bold border-2 border-black rounded px-2 py-1 bg-brand-yellow hover:translate-y-[1px] disabled:opacity-40">
          {fixing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Bug className="w-3.5 h-3.5" />} Debug with AI
        </button>
        <button onClick={() => downloadProjectZip(artifact.title, files)} title="Download project as .zip" className="inline-flex items-center gap-1 text-xs font-bold border-2 border-black rounded px-2 py-1 bg-white hover:bg-lime-200">
          <Download className="w-3.5 h-3.5" /> .zip
        </button>
      </div>

      {/* Body: editor | preview/terminal */}
      <div className="flex-1 min-h-0 flex">
        {/* File explorer */}
        <div className="w-48 shrink-0 border-r border-black/40 bg-[#161616] overflow-y-auto">
          {sortedPaths.map((p) => (
            <button
              key={p}
              onClick={() => setActiveFile(p)}
              className={`w-full text-left px-3 py-1.5 text-[11px] font-mono truncate flex items-center gap-1.5 ${
                activeFile === p ? 'bg-lime-500/20 text-lime-200' : 'text-slate-400 hover:bg-white/5'
              }`}
              title={p}
            >
              <FileCode className="w-3 h-3 shrink-0 opacity-60" />
              {p}
            </button>
          ))}
        </div>

        {/* Editor */}
        <div className="flex-1 min-w-0 flex flex-col border-r border-black/40">
          <div className="px-3 py-1.5 text-[11px] font-mono text-slate-400 border-b border-black/40 bg-[#161616] flex items-center justify-between">
            <span className="truncate">{activeFile}</span>
            <span className="uppercase opacity-50">{guessLang(activeFile)}</span>
          </div>
          <textarea
            value={files[activeFile] ?? ''}
            onChange={(e) => onEdit(activeFile, e.target.value)}
            spellCheck={false}
            className="flex-1 min-h-0 w-full resize-none bg-[#0f0f0f] text-slate-100 font-mono text-[12.5px] leading-relaxed p-3 outline-none"
            wrap="off"
          />
        </div>

        {/* Right: preview / terminal */}
        <div className="w-[46%] min-w-[320px] shrink-0 flex flex-col bg-white text-black">
          <div className="flex items-center border-b-2 border-black bg-slate-100 shrink-0">
            <button onClick={() => setRightTab('preview')} className={`flex items-center gap-1 px-3 py-1.5 text-xs font-bold ${rightTab === 'preview' ? 'bg-white border-b-2 border-lime-500' : 'text-slate-500'}`}>
              <Monitor className="w-3.5 h-3.5" /> Preview
            </button>
            <button onClick={() => setRightTab('terminal')} className={`flex items-center gap-1 px-3 py-1.5 text-xs font-bold ${rightTab === 'terminal' ? 'bg-white border-b-2 border-lime-500' : 'text-slate-500'}`}>
              <TerminalIcon className="w-3.5 h-3.5" /> Terminal
            </button>
            {previewUrl && rightTab === 'preview' && (
              <a href={previewUrl} target="_blank" rel="noopener" className="ml-auto mr-2 text-[11px] font-bold text-lime-700 hover:underline flex items-center gap-1">
                <Play className="w-3 h-3" /> Open
              </a>
            )}
          </div>

          {rightTab === 'preview' ? (
            <div className="flex-1 min-h-0 bg-white">
              {previewUrl ? (
                <iframe title="preview" src={previewUrl} className="w-full h-full border-0" allow="cross-origin-isolated" />
              ) : (
                <div className="h-full flex flex-col items-center justify-center text-slate-400 gap-2">
                  <Loader2 className="w-6 h-6 animate-spin" />
                  <span className="text-xs font-bold">{STATUS_LABEL[status]}</span>
                </div>
              )}
            </div>
          ) : (
            <div className="flex-1 min-h-0 bg-[#0f0f0f] text-slate-200 overflow-y-auto">
              <pre className="text-[11.5px] font-mono whitespace-pre-wrap break-words p-3">{log.join('')}</pre>
              <div ref={logEndRef} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
