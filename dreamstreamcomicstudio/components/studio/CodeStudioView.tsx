// Code Studio — the dedicated workspace route. A themeable, animated, resizable 3-pane
// workspace (Prompt/Build · Code · Live preview) over a streaming Console/Logs panel. The
// Code pane hosts the real editor (Monaco + tabs + file tree); panes resize with persisted
// sizes (wide screens) and stack on small ones. Workspace theme is Code-Studio-only.
//
// Gating: admins are never feature-gated; everyone else sees Code Studio only when the live
// flag is on. Non-admins still get an instant in-browser preview of a handed-off app so the
// single "Open in Code Studio" CTA never dead-ends.

import React, { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft, Wand2, Square, Share2, Download, FileCode, Cloud,
  Sparkles, Cpu, Lock, Mail, Loader2, Command as CommandIcon, Moon, Sun, Palette, Undo2, MessageSquarePlus, Check,
} from 'lucide-react';
import type { CodeStudioArtifact, CodeStudioTemplate } from '../../apiTypes';
import {
  Reveal, Skeleton, StatusPulse, Lift, ThemeSwitcher, ResizableSplit, Confetti, CommandPalette, ShortcutsHelp,
  StudioAurora, useIsWide, useStudioTheme, useStudioThemeStore,
} from './kit';
import type { RunStatus, Command } from './kit';
import {
  CodeWorkspace, LogsConsole, PreviewFrame, BuildTrace, ChangesPanel, HistoryPanel, PromptComposer, useStudioBuild,
  useStudioWorkspace, useStudioLogs, isPathDirty, workspaceCurrentArtifact,
} from './workspace';
import { StudioStart } from './StudioStart';
import { stopLiveStudio } from '../../services/studioApi';
import { generateStudioApp } from '../../services/studioGenerateApi';
import { streamStudioBuild, type BuildStage } from '../../services/studioBuildApi';
import { getOpenRouterKey } from '../../services/appSettings';
import { isProviderEnabled } from '../../services/sourceGovernance';
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

// One-click refine prompts (Lovable-style "what next") shown under the iterate composer.
const QUICK_ACTIONS: { label: string; prompt: string }[] = [
  { label: '✨ Polish UI', prompt: 'Polish the visual design — spacing, typography, colors, and overall aesthetics. Keep all behavior.' },
  { label: '🌙 Dark mode', prompt: 'Add a dark mode toggle and make the styling adapt to it.' },
  { label: '📱 Responsive', prompt: 'Make the layout fully responsive and great on mobile.' },
  { label: '🎬 Animations', prompt: 'Add tasteful, smooth animations and transitions.' },
  { label: '🧪 Sample data', prompt: 'Pre-fill the app with realistic sample data so it looks alive on first load.' },
];

const PaneFrame: React.FC<{ title: React.ReactNode; icon: React.ReactNode; className?: string; children: React.ReactNode }>
  = ({ title, icon, className, children }) => {
    const t = useStudioTheme();
    return (
      <section className={`flex h-full w-full min-h-0 flex-col rounded-lg border ${t.edge} ${t.panel} overflow-hidden ${className ?? ''}`}>
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
  const wide = useIsWide();
  const enabled = isAdmin || isLiveStudioEnabled();
  const loadArtifact = useStudioWorkspace((s) => s.loadArtifact);
  const wsTitle = useStudioWorkspace((s) => s.title);
  const wsTemplate = useStudioWorkspace((s) => s.template);
  const wsFiles = useStudioWorkspace((s) => s.files);
  const wsBaseline = useStudioWorkspace((s) => s.baseline);
  const wsPaths = useStudioWorkspace((s) => s.paths);
  const wsProjectId = useStudioWorkspace((s) => s.projectId);
  const appendLog = useStudioLogs((s) => s.append);
  const revertFile = useStudioWorkspace((s) => s.revertFile);
  const setTheme = useStudioThemeStore((s) => s.setTheme);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const runBuildRef = useRef<() => void>(() => {});
  const hasFiles = wsPaths.length > 0;
  const dirtyList = useMemo(
    () => wsPaths.filter((p) => isPathDirty({ files: wsFiles, baseline: wsBaseline }, p)),
    [wsPaths, wsFiles, wsBaseline]
  );
  const dirtyCount = dirtyList.length;
  // The runnable app, built purely from the workspace store (works for chat hand-offs AND
  // projects opened from the start screen — read the working copy so edits boot).
  const currentArtifact = useMemo(
    () => workspaceCurrentArtifact({ title: wsTitle, template: wsTemplate, files: wsFiles, paths: wsPaths }),
    [wsTitle, wsTemplate, wsFiles, wsPaths]
  );

  // Load the handed-off app into the editor workspace.
  useEffect(() => {
    if (artifact) loadArtifact(artifact);
  }, [artifact, loadArtifact]);

  // Keyboard shortcuts: ⌘K palette · ⌘B / ⌘↵ Build · ⌘S (no-op — Code Studio saves on Build).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      const k = e.key.toLowerCase();
      if (k === 'k') { e.preventDefault(); setPaletteOpen((o) => !o); }
      else if (k === 'b' || e.key === 'Enter') { e.preventDefault(); runBuildRef.current(); }
      else if (k === 's') { e.preventDefault(); /* persisted on Build */ }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // "Run live" — drives the existing launch backend. Surfaces a clean error when the worker
  // isn't configured yet (the honest 503 from S0.1), which doubles as the S0.6 validation hook.
  const [status, setStatus] = useState<RunStatus>('idle');
  const [runId, setRunId] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [celebrate, setCelebrate] = useState(false);
  const [shareCopied, setShareCopied] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);
  const [template, setTemplate] = useState<CodeStudioTemplate>('react-ts');
  const [previewError, setPreviewError] = useState<string | null>(null);
  // Stable identity so the preview's ErrorWatcher effect doesn't re-fire every render.
  const onPreviewError = useCallback((e: string | null) => setPreviewError(e), []);

  // Agentic build: stream plan → run → observe → fix → done, self-healing errors. The final
  // preview URL is the live app. Drives the BuildTrace + logs + run status.
  const stageLevel = (stage: BuildStage) =>
    stage === 'done' ? 'success' : stage === 'stopped' || stage === 'observe' ? 'warn' : 'info' as const;

  const runBuild = async () => {
    if (!hasFiles || !enabled || status === 'starting') return;
    setStatus('starting');
    setError(null);
    setPreviewUrl(null);
    useStudioBuild.getState().begin();
    appendLog('system', `Building "${currentArtifact.title}" with self-healing…`);
    try {
      await streamStudioBuild(
        { projectId: wsProjectId ?? undefined, title: currentArtifact.title, template: currentArtifact.template, files: currentArtifact.files },
        {
          onStart: (d) => { setRunId(d.runId ?? null); if (d.projectId) useStudioWorkspace.getState().setProjectId(d.projectId); },
          onEvent: (e) => {
            useStudioBuild.getState().pushEvent(e);
            appendLog(stageLevel(e.stage), `[${e.stage}] ${e.message}`);
            if (e.observation?.summary) appendLog('warn', e.observation.summary);
            if (e.previewUrl) setPreviewUrl(e.previewUrl);
          },
          onResult: (r) => {
            useStudioBuild.getState().finish(r);
            if (r.ok) setCelebrate(true); // 🎉 green build
            if (r.previewUrl) { setPreviewUrl(r.previewUrl); setStatus('live'); }
            else setStatus(r.ok ? 'idle' : 'error');
            appendLog(r.ok ? 'success' : 'warn',
              r.ok ? `Build succeeded in ${r.iterations} iteration(s).` : `Build stopped: ${r.reason}`);
          },
          onError: (msg) => {
            useStudioBuild.getState().fail(msg);
            setStatus('error'); setError(msg); appendLog('error', msg);
          },
        }
      );
    } catch (err) {
      const msg = (err as Error)?.message || 'Build failed.';
      useStudioBuild.getState().fail(msg);
      setStatus('error');
      setError(msg);
      appendLog('error', msg);
    }
  };

  runBuildRef.current = runBuild;

  // Generate (or refine) an app from a plain-language prompt — IN the studio, no chat hand-off.
  // On success the files load into the workspace; if live runs are enabled we auto-build (the
  // agentic self-heal loop), otherwise the instant in-browser preview shows the app immediately.
  const handleGenerate = async (prompt: string, tmpl?: CodeStudioTemplate) => {
    if (generating) return;
    const refining = hasFiles;
    setGenerating(true);
    setGenError(null);
    setPreviewError(null);
    appendLog('system', refining ? `Refining: ${prompt}` : `Generating app: ${prompt}`);
    try {
      const artifact = await generateStudioApp({
        prompt,
        template: tmpl ?? template,
        files: refining ? currentArtifact.files.map((f) => ({ path: f.path, content: f.content })) : undefined,
        title: refining ? wsTitle : undefined,
      });
      loadArtifact(artifact);
      appendLog('success', `${refining ? 'Updated' : 'Generated'} "${artifact.title}" — ${artifact.files.length} file(s). Live preview is below; press Build to run it in a cloud container.`);
    } catch (err) {
      const msg = (err as Error)?.message || 'Generation failed.';
      setGenError(msg);
      appendLog('error', msg);
    } finally {
      setGenerating(false);
    }
  };

  // Autodebug: feed the preview's error back to the model as a refine ("fix this").
  const handleAutofix = (errorMsg: string) => {
    if (!errorMsg || generating) return;
    appendLog('warn', 'Auto-fixing the preview error…');
    void handleGenerate(`The live preview shows this error — find the root cause and fix it so the app runs cleanly:\n\n${errorMsg}`);
  };

  const stopLive = async () => {
    if (runId) { try { await stopLiveStudio(runId); } catch { /* best-effort */ } }
    setStatus('idle');
    setRunId(null);
    setPreviewUrl(null);
    appendLog('system', 'Run stopped.');
  };

  // Share the running app — copy its live preview link (works while the container is alive).
  const copyShare = async () => {
    if (!previewUrl) return;
    try {
      await navigator.clipboard?.writeText(previewUrl);
      setShareCopied(true);
      setTimeout(() => setShareCopied(false), 1500);
      appendLog('info', 'Preview link copied to clipboard.');
    } catch {
      appendLog('warn', 'Could not copy the link.');
    }
  };

  // Command palette actions (filtered + run by the ⌘K palette).
  const commands: Command[] = [];
  if (hasFiles && enabled) commands.push({ id: 'build', label: status === 'live' ? 'Re-build & run' : 'Build & run', hint: '⏎', icon: <Wand2 className="w-4 h-4" />, keywords: 'run agent compile heal', run: runBuild });
  if (status === 'live') commands.push({ id: 'stop', label: 'Stop run', icon: <Square className="w-4 h-4" />, keywords: 'halt kill end', run: stopLive });
  if (dirtyCount > 0) commands.push({ id: 'revert', label: `Revert all changes (${dirtyCount})`, icon: <Undo2 className="w-4 h-4" />, keywords: 'undo discard reset', run: () => dirtyList.forEach((p) => revertFile(p)) });
  if (hasFiles) commands.push({ id: 'zip', label: 'Download .zip', icon: <Download className="w-4 h-4" />, keywords: 'export save download', run: () => void downloadArtifactZip(currentArtifact) });
  commands.push({ id: 'theme-black', label: 'Theme: Black', icon: <Moon className="w-4 h-4" />, keywords: 'dark oled appearance theme', run: () => setTheme('black') });
  commands.push({ id: 'theme-white', label: 'Theme: White', icon: <Sun className="w-4 h-4" />, keywords: 'light appearance theme', run: () => setTheme('light') });
  commands.push({ id: 'theme-brand', label: 'Theme: DreamStream', icon: <Palette className="w-4 h-4" />, keywords: 'brand comic appearance theme', run: () => setTheme('brand') });
  commands.push({ id: 'chat', label: 'Build from chat', icon: <MessageSquarePlus className="w-4 h-4" />, keywords: 'new prompt generate describe', run: () => onNavigate('chat') });
  commands.push({ id: 'help', label: 'Keyboard shortcuts', icon: <CommandIcon className="w-4 h-4" />, keywords: 'keys help cheatsheet', run: () => setHelpOpen(true) });
  commands.push({ id: 'back', label: 'Back', icon: <ArrowLeft className="w-4 h-4" />, keywords: 'exit leave close', run: onBack });

  const projectName = wsTitle || 'Untitled project';
  // Build model tier: BYOK (your OpenRouter key → frontier models) vs. free-first auto.
  const hasByok = isProviderEnabled('openrouter') && !!getOpenRouterKey();

  // ---- Panes (defined once, placed into the resizable or stacked layout) ----
  const promptPane = (
    <PaneFrame title="Prompt · Build" icon={<Sparkles className="w-4 h-4" />}>
      <div className="p-3 space-y-3">
        {/* Iterate by prompt — refines the current app in place (no chat hand-off). */}
        <PromptComposer mode="inline" onSubmit={handleGenerate} busy={generating} error={genError} />
        <div className="flex flex-wrap gap-1.5">
          {QUICK_ACTIONS.map((a) => (
            <button
              key={a.label}
              onClick={() => handleGenerate(a.prompt)}
              disabled={generating}
              title={a.prompt}
              className={`rounded-full border ${t.edge} px-2.5 py-1 text-[11px] font-medium ${t.textDim} ${t.hover} disabled:opacity-50 ${t.focusRing}`}
            >
              {a.label}
            </button>
          ))}
        </div>
        <BuildTrace />
        <ChangesPanel />
        <HistoryPanel />
      </div>
    </PaneFrame>
  );

  const codePane = (
    <PaneFrame title="Code" icon={<FileCode className="w-4 h-4" />}>
      {hasFiles ? (
        <CodeWorkspace readOnly={!enabled} />
      ) : (
        <div className="p-3 space-y-2">
          <Skeleton className="h-3 w-3/4" /><Skeleton className="h-3 w-1/2" /><Skeleton className="h-3 w-2/3" />
        </div>
      )}
    </PaneFrame>
  );

  const previewPane = (
    <PaneFrame title="Live preview" icon={<Cloud className="w-4 h-4" />}>
      {previewError && hasFiles && !previewUrl && (
        <div className="flex items-start gap-2 px-3 py-2 border-b border-rose-500/20 bg-rose-500/10 text-xs">
          <span className="mt-0.5 shrink-0 font-semibold text-rose-400">⚠ Error</span>
          <span className="min-w-0 flex-1 truncate text-rose-200/90" title={previewError}>{previewError}</span>
          <button
            onClick={() => handleAutofix(previewError)}
            disabled={generating}
            className="shrink-0 inline-flex items-center gap-1 rounded-full bg-violet-500 px-2.5 py-1 text-[11px] font-bold text-white hover:bg-violet-400 disabled:opacity-50"
          >
            {generating ? <Loader2 className="w-3 h-3 animate-spin" /> : <Wand2 className="w-3 h-3" />} Fix with AI
          </button>
        </div>
      )}
      {previewUrl ? (
        <PreviewFrame url={previewUrl} />
      ) : hasFiles ? (
        // Instant in-browser preview — works without the live worker. A live cloud Build
        // supersedes this with a real container URL when enabled. onError drives autodebug.
        <Suspense fallback={<div className="p-3"><Skeleton className="h-full min-h-[12rem] w-full" /></div>}>
          <CodeStudioPanel data={currentArtifact} editorHeight={460} previewOnly onError={onPreviewError} />
        </Suspense>
      ) : (
        <div className="h-full min-h-[14rem] flex flex-col items-center justify-center gap-3 p-6 text-center">
          <div className={`h-16 w-16 rounded-2xl border ${t.edge} ${t.panelAlt} flex items-center justify-center`}>
            <Cloud className={`w-7 h-7 ${t.textFaint}`} />
          </div>
          <p className={`text-sm font-semibold ${t.textDim}`}>
            Press Run live to boot this app in a cloud container.
          </p>
          {status === 'starting' && (
            <div className="w-full max-w-xs space-y-2"><Skeleton className="h-3 w-full" /><Skeleton className="h-3 w-2/3" /></div>
          )}
        </div>
      )}
    </PaneFrame>
  );

  const logsPane = (
    <div className={`flex h-full w-full overflow-hidden rounded-lg border ${t.edge}`}>
      <LogsConsole />
    </div>
  );

  return (
    <div className={`relative overflow-hidden min-h-screen h-screen ${t.bg} ${t.text} flex flex-col`}>
      <StudioAurora className="-z-10" />
      {celebrate && <Confetti onDone={() => setCelebrate(false)} />}
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} commands={commands} />
      <ShortcutsHelp open={helpOpen} onClose={() => setHelpOpen(false)} />
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
            <button
              onClick={() => onNavigate('settings')}
              title={hasByok
                ? 'Builds run on a strong coding model using your OpenRouter key (BYOK). Manage keys in Settings.'
                : 'Builds run on a strong open coding model — free. Add your OpenRouter key in Settings for frontier models.'}
              className={`hidden sm:inline-flex items-center gap-1 text-[11px] font-semibold rounded-full border ${t.edge} px-2 py-0.5 ${t.textDim} ${t.hover} ${t.focusRing}`}
            >
              <Cpu className="w-3 h-3" /> coding · {hasByok ? 'your key' : 'free'}
            </button>
            {dirtyCount > 0 && (
              <span className="hidden sm:inline-flex items-center gap-1 text-[11px] font-semibold text-amber-500" title="Unsaved edits in the working copy">
                ● {dirtyCount} unsaved
              </span>
            )}
          </div>

          <div className="ml-auto flex items-center gap-2">
            <button
              onClick={() => setPaletteOpen(true)}
              title="Command palette (⌘K)"
              className={`hidden md:inline-flex items-center gap-1 text-[11px] font-semibold rounded-full border ${t.edge} px-2 py-1 ${t.textDim} ${t.hover} ${t.focusRing}`}
            >
              <CommandIcon className="w-3 h-3" /> K
            </button>
            <button
              onClick={() => setHelpOpen(true)}
              title="Keyboard shortcuts"
              aria-label="Keyboard shortcuts"
              className={`hidden md:inline-flex items-center justify-center h-6 w-6 rounded-full border ${t.edge} ${t.textDim} ${t.hover} ${t.focusRing}`}
            >
              <span className="text-[11px] font-bold">?</span>
            </button>
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
                  onClick={runBuild}
                  disabled={!enabled || !hasFiles || status === 'starting'}
                  title={enabled ? 'Build & run this app live, self-healing errors' : 'Code Studio is in private preview'}
                  className={`flex items-center gap-1.5 text-sm font-bold rounded-full px-3.5 py-1.5 ${t.accentText} ${t.accentBg} ${t.accentBgHover} disabled:opacity-50 disabled:cursor-not-allowed ${t.focusRing}`}
                >
                  {status === 'starting' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Wand2 className="w-3.5 h-3.5" />}
                  {status === 'starting' ? 'Building…' : 'Build'}
                </button>
              </Lift>
            )}
            <button
              onClick={copyShare}
              disabled={!previewUrl}
              title={previewUrl ? 'Copy the live preview link' : 'Build & run first to share the live app'}
              className={`hidden md:flex items-center gap-1.5 text-sm font-semibold rounded-full border ${t.edge} px-3 py-1.5 ${t.focusRing} ${previewUrl ? `${t.textDim} ${t.hover}` : `${t.textFaint} cursor-not-allowed`}`}
            >
              {shareCopied ? <Check className="w-3.5 h-3.5 text-emerald-500" /> : <Share2 className="w-3.5 h-3.5" />}
              {shareCopied ? 'Copied!' : 'Share'}
            </button>
            {hasFiles && (
              <button
                onClick={() => void downloadArtifactZip(currentArtifact)}
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
          <span className={`${t.text} font-semibold`}>You're building in instant-preview mode.</span>
          <span className={t.textDim}>Generate and edit apps with a live in-browser preview now — one-click cloud runs &amp; sharing are rolling out.</span>
          <button
            onClick={() => onNavigate('home')}
            className={`ml-auto inline-flex items-center gap-1.5 text-xs font-bold rounded-full border ${t.edgeStrong} px-3 py-1 ${t.accent} ${t.hover}`}
          >
            <Mail className="w-3.5 h-3.5" /> Get notified
          </button>
        </div>
      )}

      {/* No app loaded → the projects start screen (S1.7). Otherwise the workspace. */}
      {!hasFiles ? (
        <StudioStart
          onNavigate={onNavigate}
          onGenerate={handleGenerate}
          generating={generating}
          genError={genError}
          template={template}
          onTemplateChange={setTemplate}
        />
      ) : wide ? (
        <div className="flex-1 min-h-0 p-3">
          <ResizableSplit direction="vertical" storageKey="studio.split.v" initial={[3.2, 1]} minPx={110}>
            <ResizableSplit direction="horizontal" storageKey="studio.split.h" initial={[2.4, 3.4, 3.2]} minPx={220}>
              {promptPane}
              {codePane}
              {previewPane}
            </ResizableSplit>
            {logsPane}
          </ResizableSplit>
        </div>
      ) : (
        <div className="flex-1 min-h-0 overflow-auto flex flex-col gap-3 p-3">
          <div className="min-h-[15rem] flex">{promptPane}</div>
          <div className="min-h-[22rem] flex">{codePane}</div>
          <div className="min-h-[18rem] flex">{previewPane}</div>
          <div className="min-h-[12rem] flex">{logsPane}</div>
        </div>
      )}
    </div>
  );
};
