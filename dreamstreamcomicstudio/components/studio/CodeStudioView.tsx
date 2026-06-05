// Code Studio — the dedicated workspace route (Sprint 0 shell, filled out in Sprint 1).
//
// A themeable, animated 3-pane workspace (Prompt/Build · Code · Live preview) over a
// Console/Logs bar. The Code pane hosts the real editor (Monaco + tabs + file tree). The
// workspace theme (Black / White / DreamStream) is Code-Studio-only and switches live.
//
// Gating: admins are never feature-gated; everyone else sees Code Studio only when the live
// flag is on. Non-admins still get an instant in-browser preview of a handed-off app so the
// single "Open in Code Studio" CTA never dead-ends.

import React, { Suspense, lazy, useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft, Play, Square, Share2, Download, FileCode, Terminal,
  Sparkles, Cpu, Lock, Mail, Cloud, Loader2,
} from 'lucide-react';
import type { CodeStudioArtifact } from '../../apiTypes';
import { Reveal, Stagger, StaggerItem, Skeleton, StatusPulse, Lift, ThemeSwitcher, useStudioTheme } from './kit';
import type { RunStatus } from './kit';
import { CodeWorkspace, useStudioWorkspace, isPathDirty, workspaceToArtifact } from './workspace';
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
  = ({ title, icon, className, children }) => {
    const t = useStudioTheme();
    return (
      <section className={`flex min-h-0 flex-col rounded-xl border ${t.edge} ${t.panel} overflow-hidden ${className ?? ''}`}>
        <header className={`flex items-center gap-2 px-3 py-2 border-b ${t.edge} ${t.panelAlt}`}>
          <span className={t.accent}>{icon}</span>
          <span className={`text-xs font-semibold tracking-wide ${t.textDim} uppercase`}>{title}</span>
        </header>
        <div className="min-h-0 flex-1 overflow-auto">{children}</div>
      </section>
    );
  };

export const CodeStudioView: React.FC<CodeStudioViewProps> = ({ artifact, isAdmin, onBack, onNavigate }) => {
  const t = useStudioTheme();
  const enabled = isAdmin || isLiveStudioEnabled();
  const loadArtifact = useStudioWorkspace((s) => s.loadArtifact);
  const wsFiles = useStudioWorkspace((s) => s.files);
  const wsBaseline = useStudioWorkspace((s) => s.baseline);
  const wsPaths = useStudioWorkspace((s) => s.paths);
  const hasFiles = wsPaths.length > 0;
  const dirtyCount = useMemo(
    () => wsPaths.filter((p) => isPathDirty({ files: wsFiles, baseline: wsBaseline }, p)).length,
    [wsPaths, wsFiles, wsBaseline]
  );

  // Load the handed-off app into the editor workspace.
  useEffect(() => {
    if (artifact) loadArtifact(artifact);
  }, [artifact, loadArtifact]);

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
      // Run the working copy (so live edits are what boots), not just the original hand-off.
      const live = workspaceToArtifact(artifact, { files: wsFiles, paths: wsPaths });
      const res = await launchLiveStudio(live);
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
    <div className={`min-h-screen ${t.bg} ${t.text} flex flex-col`}>
      {/* Top bar */}
      <Reveal distance={-8}>
        <div className={`flex items-center gap-3 px-4 h-14 border-b ${t.edge} ${t.panelAlt}`}>
          <button
            onClick={onBack}
            className={`flex items-center gap-1.5 text-sm font-semibold ${t.textDim} ${t.hover} transition-colors ${t.focusRing} rounded-md px-1.5 py-1`}
          >
            <ArrowLeft className="w-4 h-4" /> Back
          </button>
          <div className={`h-5 w-px ${t.edge} border-l`} />
          <div className="flex items-center gap-2 min-w-0">
            <span className={`font-display text-lg tracking-wide ${t.text} truncate`}>{projectName}</span>
            <span className={`hidden sm:inline-flex items-center gap-1 text-[11px] font-semibold rounded-full border ${t.edge} px-2 py-0.5 ${t.textDim}`}>
              <Cpu className="w-3 h-3" /> coding · auto
            </span>
            {dirtyCount > 0 && (
              <span className="hidden sm:inline-flex items-center gap-1 text-[11px] font-semibold text-amber-500" title="Unsaved edits in the working copy">
                ● {dirtyCount} unsaved
              </span>
            )}
          </div>

          <div className="ml-auto flex items-center gap-2">
            <ThemeSwitcher className="hidden sm:inline-flex" />
            <StatusPulse status={status} className="mr-1" />
            {status === 'live' ? (
              <button
                onClick={stopLive}
                className={`flex items-center gap-1.5 text-sm font-bold rounded-full border ${t.edgeStrong} px-3 py-1.5 text-rose-500 ${t.hover} ${t.focusRing}`}
              >
                <Square className="w-3.5 h-3.5" /> Stop
              </button>
            ) : (
              <Lift>
                <button
                  onClick={runLive}
                  disabled={!enabled || !artifact || status === 'starting'}
                  title={enabled ? 'Run this app on a live cloud container' : 'Code Studio is in private preview'}
                  className={`flex items-center gap-1.5 text-sm font-bold rounded-full px-3.5 py-1.5 ${t.accentText} ${t.accentBg} ${t.accentBgHover} disabled:opacity-50 disabled:cursor-not-allowed ${t.focusRing}`}
                >
                  {status === 'starting' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
                  {status === 'starting' ? 'Starting…' : 'Run live'}
                </button>
              </Lift>
            )}
            <button
              disabled
              title="Sharing arrives in a later sprint"
              className={`hidden md:flex items-center gap-1.5 text-sm font-semibold rounded-full border ${t.edge} px-3 py-1.5 ${t.textFaint} cursor-not-allowed`}
            >
              <Share2 className="w-3.5 h-3.5" /> Share
            </button>
            {artifact && (
              <button
                onClick={() => void downloadArtifactZip(artifact)}
                title="Download all files as a .zip"
                className={`flex items-center gap-1.5 text-sm font-semibold rounded-full border ${t.edge} px-3 py-1.5 ${t.textDim} ${t.hover} ${t.focusRing}`}
              >
                <Download className="w-3.5 h-3.5" /> <span className="hidden sm:inline">.zip</span>
              </button>
            )}
          </div>
        </div>
      </Reveal>

      {error && (
        <div className="px-4 py-2 text-xs font-semibold text-rose-500 bg-rose-500/10 border-b border-rose-500/20">
          {error}
        </div>
      )}

      {/* Non-admin private-preview banner */}
      {!enabled && (
        <div className={`px-4 py-2.5 text-sm ${t.accentSoft} border-b ${t.edge} flex flex-wrap items-center gap-2`}>
          <Lock className={`w-4 h-4 ${t.accent}`} />
          <span className={`${t.text} font-semibold`}>Code Studio is in private preview.</span>
          <span className={t.textDim}>You can preview this app instantly below — live cloud runs are rolling out soon.</span>
          <button
            onClick={() => onNavigate('home')}
            className={`ml-auto inline-flex items-center gap-1.5 text-xs font-bold rounded-full border ${t.edgeStrong} px-3 py-1 ${t.accent} ${t.hover}`}
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
              <div className={`rounded-lg border ${t.edge} ${t.panelAlt} p-3`}>
                <p className={`text-sm ${t.textDim}`}>
                  {artifact
                    ? 'This app was handed off from chat. Run it live, or (coming in Sprint 2) refine it by prompt.'
                    : 'Describe an app and watch it build live. Or open one from chat.'}
                </p>
                <div className={`mt-3 rounded-md border ${t.edge} ${t.bg} px-3 py-2 text-sm ${t.textFaint}`}>
                  Describe a change…
                  <span className="ml-1 text-[10px] uppercase tracking-wide">(Sprint 2)</span>
                </div>
              </div>
              {/* BuildTrace placeholder */}
              <div className="space-y-2">
                <p className={`text-[11px] font-semibold uppercase tracking-wide ${t.textFaint}`}>Build trace</p>
                {['Plan', 'Run', 'Observe', 'Fix'].map((step) => (
                  <div key={step} className={`flex items-center gap-2 rounded-md border ${t.edge} px-2.5 py-2`}>
                    <StatusPulse status="idle" hideLabel />
                    <span className={`text-xs ${t.textDim}`}>{step}</span>
                    <Skeleton className="ml-auto h-2 w-16" />
                  </div>
                ))}
              </div>
            </div>
          </PaneFrame>
        </StaggerItem>

        {/* Code editor — Monaco + tabs + file tree (workspace store) */}
        <StaggerItem className="min-h-0 flex">
          <PaneFrame title="Code" icon={<FileCode className="w-4 h-4" />} className="flex-1">
            {hasFiles ? (
              <CodeWorkspace readOnly={!enabled} />
            ) : (
              <div className="p-3 space-y-2">
                <Skeleton className="h-3 w-3/4" /><Skeleton className="h-3 w-1/2" /><Skeleton className="h-3 w-2/3" />
              </div>
            )}
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
                  <div className={`h-16 w-16 rounded-2xl border ${t.edge} ${t.panelAlt} flex items-center justify-center`}>
                    <Cloud className={`w-7 h-7 ${t.textFaint}`} />
                  </div>
                </div>
                <p className={`text-sm font-semibold ${t.textDim}`}>
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
        <div className={`border-t ${t.edge} ${t.panelAlt} px-4 py-2`}>
          <div className={`flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide ${t.textFaint}`}>
            <Terminal className="w-3.5 h-3.5" /> Console · Logs
            <span className="ml-2 normal-case font-normal">streaming logs land in a later Sprint 1 increment</span>
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
