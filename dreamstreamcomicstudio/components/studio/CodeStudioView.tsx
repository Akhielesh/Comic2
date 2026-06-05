// Code Studio — the dedicated workspace route (Sprint 0, S0.4).
//
// This is the *skeleton* of the real product (plan §4): a dark, animated 3-pane shell
// (Prompt/Build · Code · Live preview) over a Console/Logs bar. Sprint 1+ fills the panes
// with the resizable layout, Monaco editor, streaming logs and the agentic BuildTrace; here
// we stand up the shell, the design language (Motion Kit + studio theme), the chat hand-off,
// and a working "Run live" that drives the existing launch backend (S0.1/S0.3).
//
// Gating: admins are never feature-gated; everyone else sees Code Studio only when the live
// flag is on. Non-admins still get an instant in-browser preview of a handed-off app so the
// single "Open in Code Studio" CTA never dead-ends.

import React, { Suspense, lazy, useMemo, useState } from 'react';
import {
  ArrowLeft, Play, Square, Share2, Download, FileCode, FolderTree, Terminal,
  Sparkles, Cpu, Lock, Mail, Cloud, Loader2,
} from 'lucide-react';
import type { CodeStudioArtifact } from '../../apiTypes';
import { Reveal, Stagger, StaggerItem, Skeleton, StatusPulse, studioTheme, Lift } from './kit';
import type { RunStatus } from './kit';
import { launchLiveStudio, stopLiveStudio } from '../../services/studioApi';
import { isLiveStudioEnabled } from '../../services/studioFlags';
import { downloadArtifactZip } from '../../services/studioLauncher';

// Sandpack peek is heavy and legacy-ish — load it only when actually shown.
const CodeStudioPanel = lazy(() => import('../chat/CodeStudioPanel'));

export interface CodeStudioViewProps {
  /** App handed off from chat (if any). */
  artifact: CodeStudioArtifact | null;
  isAdmin: boolean;
  onBack: () => void;
  onNavigate: (view: string) => void;
}

const PaneFrame: React.FC<{ title: React.ReactNode; icon: React.ReactNode; className?: string; children: React.ReactNode }>
  = ({ title, icon, className, children }) => (
    <section className={`flex min-h-0 flex-col rounded-xl border ${studioTheme.edge} ${studioTheme.panel} overflow-hidden ${className ?? ''}`}>
      <header className={`flex items-center gap-2 px-3 py-2 border-b ${studioTheme.edge} ${studioTheme.panelAlt}`}>
        <span className={studioTheme.accent}>{icon}</span>
        <span className={`text-xs font-semibold tracking-wide ${studioTheme.textDim} uppercase`}>{title}</span>
      </header>
      <div className="min-h-0 flex-1 overflow-auto">{children}</div>
    </section>
  );

export const CodeStudioView: React.FC<CodeStudioViewProps> = ({ artifact, isAdmin, onBack, onNavigate }) => {
  const enabled = isAdmin || isLiveStudioEnabled();
  const files = artifact?.files ?? [];
  const [activePath, setActivePath] = useState<string | null>(files[0]?.path ?? null);
  const activeFile = useMemo(
    () => files.find((f) => f.path === activePath) ?? files[0] ?? null,
    [files, activePath]
  );

  // "Run live" — drives the existing launch backend. Surfaces a clean error when the worker
  // isn't configured yet (the honest 503 from S0.1), which doubles as the S0.6 validation hook.
  const [status, setStatus] = useState<RunStatus>('idle');
  const [runId, setRunId] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const runLive = async () => {
    if (!artifact) return;
    setStatus('starting');
    setError(null);
    setPreviewUrl(null);
    try {
      const res = await launchLiveStudio(artifact);
      setRunId(res.runId ?? null);
      if (res.previewUrl) {
        setPreviewUrl(res.previewUrl);
        setStatus('live');
        window.open(res.previewUrl, '_blank', 'noopener');
      } else {
        setStatus('error');
        setError('The live preview started but returned no URL yet.');
      }
    } catch (err) {
      setStatus('error');
      setError((err as Error)?.message || 'Live Studio is unavailable right now.');
    }
  };

  const stopLive = async () => {
    if (runId) { try { await stopLiveStudio(runId); } catch { /* best-effort */ } }
    setStatus('idle');
    setRunId(null);
    setPreviewUrl(null);
  };

  const projectName = artifact?.title || 'Untitled project';

  return (
    <div className={`min-h-screen ${studioTheme.bg} ${studioTheme.text} flex flex-col`}>
      {/* Top bar */}
      <Reveal distance={-8}>
        <div className={`flex items-center gap-3 px-4 h-14 border-b ${studioTheme.edge} ${studioTheme.panelAlt}`}>
          <button
            onClick={onBack}
            className={`flex items-center gap-1.5 text-sm font-semibold ${studioTheme.textDim} hover:text-white transition-colors ${studioTheme.focusRing} rounded-md px-1.5 py-1`}
          >
            <ArrowLeft className="w-4 h-4" /> Back
          </button>
          <div className={`h-5 w-px ${studioTheme.edge} border-l`} />
          <div className="flex items-center gap-2 min-w-0">
            <span className="font-display text-lg tracking-wide text-white truncate">{projectName}</span>
            <span className={`hidden sm:inline-flex items-center gap-1 text-[11px] font-semibold rounded-full border ${studioTheme.edge} px-2 py-0.5 ${studioTheme.textDim}`}>
              <Cpu className="w-3 h-3" /> coding · auto
            </span>
          </div>

          <div className="ml-auto flex items-center gap-2">
            <StatusPulse status={status} className="mr-1" />
            {status === 'live' ? (
              <button
                onClick={stopLive}
                className={`flex items-center gap-1.5 text-sm font-bold rounded-full border ${studioTheme.edgeStrong} px-3 py-1.5 text-rose-300 hover:bg-white/5 ${studioTheme.focusRing}`}
              >
                <Square className="w-3.5 h-3.5" /> Stop
              </button>
            ) : (
              <Lift>
                <button
                  onClick={runLive}
                  disabled={!enabled || !artifact || status === 'starting'}
                  title={enabled ? 'Run this app on a live cloud container' : 'Code Studio is in private preview'}
                  className={`flex items-center gap-1.5 text-sm font-bold rounded-full px-3.5 py-1.5 text-black ${studioTheme.accentBg} ${studioTheme.accentBgHover} disabled:opacity-50 disabled:cursor-not-allowed ${studioTheme.focusRing}`}
                >
                  {status === 'starting' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
                  {status === 'starting' ? 'Starting…' : 'Run live'}
                </button>
              </Lift>
            )}
            <button
              disabled
              title="Sharing arrives in a later sprint"
              className={`hidden sm:flex items-center gap-1.5 text-sm font-semibold rounded-full border ${studioTheme.edge} px-3 py-1.5 ${studioTheme.textFaint} cursor-not-allowed`}
            >
              <Share2 className="w-3.5 h-3.5" /> Share
            </button>
            {artifact && (
              <button
                onClick={() => void downloadArtifactZip(artifact)}
                title="Download all files as a .zip"
                className={`flex items-center gap-1.5 text-sm font-semibold rounded-full border ${studioTheme.edge} px-3 py-1.5 ${studioTheme.textDim} hover:bg-white/5 ${studioTheme.focusRing}`}
              >
                <Download className="w-3.5 h-3.5" /> <span className="hidden sm:inline">.zip</span>
              </button>
            )}
          </div>
        </div>
      </Reveal>

      {error && (
        <div className="px-4 py-2 text-xs font-semibold text-rose-300 bg-rose-500/10 border-b border-rose-500/20">
          {error}
        </div>
      )}

      {/* Non-admin private-preview banner */}
      {!enabled && (
        <div className="px-4 py-2.5 text-sm bg-sky-500/10 border-b border-sky-500/20 flex flex-wrap items-center gap-2">
          <Lock className="w-4 h-4 text-sky-300" />
          <span className="text-sky-100 font-semibold">Code Studio is in private preview.</span>
          <span className={studioTheme.textDim}>You can preview this app instantly below — live cloud runs are rolling out soon.</span>
          <button
            onClick={() => onNavigate('home')}
            className="ml-auto inline-flex items-center gap-1.5 text-xs font-bold rounded-full border border-sky-400/40 px-3 py-1 text-sky-200 hover:bg-sky-500/10"
          >
            <Mail className="w-3.5 h-3.5" /> Get notified
          </button>
        </div>
      )}

      {/* 3-pane workspace */}
      <Stagger className="flex-1 grid min-h-0 gap-3 p-3 grid-cols-1 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)_minmax(0,1.1fr)]">
        {/* Prompt / Build */}
        <StaggerItem className="min-h-0 flex">
          <PaneFrame title="Prompt · Build" icon={<Sparkles className="w-4 h-4" />} className="flex-1">
            <div className="p-3 space-y-3">
              <div className={`rounded-lg border ${studioTheme.edge} ${studioTheme.panelAlt} p-3`}>
                <p className={`text-sm ${studioTheme.textDim}`}>
                  {artifact
                    ? 'This app was handed off from chat. Run it live, or (coming in Sprint 2) refine it by prompt.'
                    : 'Describe an app and watch it build live. Or open one from chat.'}
                </p>
                <div className={`mt-3 rounded-md border ${studioTheme.edge} bg-black/30 px-3 py-2 text-sm ${studioTheme.textFaint}`}>
                  Describe a change…
                  <span className="ml-1 text-[10px] uppercase tracking-wide">(Sprint 2)</span>
                </div>
              </div>
              {/* BuildTrace placeholder */}
              <div className="space-y-2">
                <p className={`text-[11px] font-semibold uppercase tracking-wide ${studioTheme.textFaint}`}>Build trace</p>
                {['Plan', 'Run', 'Observe', 'Fix'].map((step) => (
                  <div key={step} className={`flex items-center gap-2 rounded-md border ${studioTheme.edge} px-2.5 py-2`}>
                    <StatusPulse status="idle" hideLabel />
                    <span className={`text-xs ${studioTheme.textDim}`}>{step}</span>
                    <Skeleton className="ml-auto h-2 w-16" />
                  </div>
                ))}
              </div>
            </div>
          </PaneFrame>
        </StaggerItem>

        {/* Code editor */}
        <StaggerItem className="min-h-0 flex">
          <PaneFrame title="Code" icon={<FileCode className="w-4 h-4" />} className="flex-1">
            <div className="grid h-full grid-cols-[minmax(7rem,12rem)_minmax(0,1fr)] min-h-0">
              {/* File tree */}
              <div className={`border-r ${studioTheme.edge} ${studioTheme.panelAlt} overflow-auto`}>
                <div className={`flex items-center gap-1.5 px-2.5 py-2 text-[11px] uppercase tracking-wide ${studioTheme.textFaint}`}>
                  <FolderTree className="w-3.5 h-3.5" /> Files
                </div>
                {files.length === 0 && <p className={`px-2.5 py-2 text-xs ${studioTheme.textFaint}`}>No files yet.</p>}
                {files.map((f) => {
                  const name = f.path.split('/').filter(Boolean).pop() || f.path;
                  const active = activeFile?.path === f.path;
                  return (
                    <button
                      key={f.path}
                      onClick={() => setActivePath(f.path)}
                      className={`flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left text-xs font-mono truncate ${active ? `bg-sky-500/15 ${studioTheme.accent}` : `${studioTheme.textDim} hover:bg-white/5`}`}
                      title={f.path}
                    >
                      <FileCode className="w-3 h-3 shrink-0 opacity-70" /> {name}
                    </button>
                  );
                })}
              </div>
              {/* Read-only code view (Monaco lands in Sprint 1) */}
              <div className="min-h-0 overflow-auto bg-black/30">
                {activeFile ? (
                  <pre className="p-3 text-[12px] leading-relaxed font-mono text-slate-300 whitespace-pre-wrap break-words">
                    {activeFile.content}
                  </pre>
                ) : (
                  <div className="p-3 space-y-2"><Skeleton className="h-3 w-3/4" /><Skeleton className="h-3 w-1/2" /><Skeleton className="h-3 w-2/3" /></div>
                )}
              </div>
            </div>
          </PaneFrame>
        </StaggerItem>

        {/* Live preview */}
        <StaggerItem className="min-h-0 flex">
          <PaneFrame title="Live preview" icon={<Cloud className="w-4 h-4" />} className="flex-1">
            {previewUrl ? (
              <iframe title="Live preview" src={previewUrl} className="h-full w-full bg-white" />
            ) : !enabled && artifact ? (
              // Non-admin: instant in-browser peek so the CTA never dead-ends (decision D3).
              <Suspense fallback={<div className="p-3"><Skeleton className="h-full min-h-[12rem] w-full" /></div>}>
                <CodeStudioPanel data={artifact} editorHeight={420} />
              </Suspense>
            ) : (
              <div className="h-full min-h-[14rem] flex flex-col items-center justify-center gap-3 p-6 text-center">
                <div className="relative">
                  <div className="h-16 w-16 rounded-2xl border border-white/10 bg-white/[0.03] flex items-center justify-center">
                    <Cloud className={`w-7 h-7 ${studioTheme.textFaint}`} />
                  </div>
                </div>
                <p className={`text-sm font-semibold ${studioTheme.textDim}`}>
                  {artifact ? 'Press Run live to boot this app in a cloud container.' : 'Your live app will appear here.'}
                </p>
                {status === 'starting' && (
                  <div className="w-full max-w-xs space-y-2"><Skeleton className="h-3 w-full" /><Skeleton className="h-3 w-2/3" /></div>
                )}
              </div>
            )}
          </PaneFrame>
        </StaggerItem>
      </Stagger>

      {/* Console / Logs */}
      <Reveal delay={0.15}>
        <div className={`border-t ${studioTheme.edge} ${studioTheme.panelAlt} px-4 py-2`}>
          <div className={`flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide ${studioTheme.textFaint}`}>
            <Terminal className="w-3.5 h-3.5" /> Console · Logs
            <span className="ml-2 normal-case font-normal">streaming logs land in Sprint 1</span>
          </div>
          <div className="mt-1.5 space-y-1">
            <Skeleton className="h-2.5 w-2/3" />
            <Skeleton className="h-2.5 w-1/2" />
          </div>
        </div>
      </Reveal>
    </div>
  );
};
