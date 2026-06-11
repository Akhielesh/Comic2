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
  Sparkles, Cpu, Mail, Loader2, Command as CommandIcon, Moon, Sun, Palette, Undo2, MessageSquarePlus, Check,
  Eye, FilePlus, Users, Maximize2, Minimize2, Video, Terminal, ChevronUp, ChevronRight, Fingerprint, ShieldCheck,
} from 'lucide-react';

/** Normalized error signature for self-heal loop detection — collapse whitespace and cap length so
 *  trivially-different-but-same errors (shifted line numbers etc.) compare equal across attempts. */
const errSig = (e: string): string => e.replace(/\s+/g, ' ').trim().slice(0, 160);
import type { CodeStudioArtifact, CodeStudioTemplate, StudioBuildPlan, StudioAnswer, StudioClarifyResult } from '../../apiTypes';
import {
  Reveal, Skeleton, StatusPulse, FocusToggle, ResizableSplit, Confetti, CommandPalette, ShortcutsHelp,
  StudioAurora, useIsWide, useStudioTheme, useStudioThemeStore, useStudioFocus,
} from './kit';
import type { RunStatus, Command } from './kit';
import {
  CodeWorkspace, LogsConsole, PreviewFrame, BuildTrace, ChangesPanel, HistoryPanel, PromptComposer,
  ConversationThread, ActivityFeed, ServicesPanel, ClarifyPanel, LiveProgress, SuggestionsPanel, ContextUsageBar, PublishPanel, BackendPanel,
  useStudioConversation, useStudioActivity, useStudioBuild,
  useStudioWorkspace, useStudioLogs, isPathDirty, workspaceCurrentArtifact,
  detectProjectKind, projectKindLabel, isWebProject, runHint, diffLines, diffStat,
  analyzeProject, applyRuntimeStatus, insightsSummary, insightsToMarkdown, issuesToFixPrompt,
  suggestNextSteps, computeContextUsage,
} from './workspace';
import type { ProgressPhase } from './workspace';
import { StudioStart } from './StudioStart';
import { StudioBuildFlow, type StudioFlowState } from './StudioBuildFlow';
import { clarifyStudioApp, planStudioApp } from '../../services/studioPlanApi';
import { describeApiError } from '../../services/apiErrors';
import { saveStudioChat, loadStudioChat } from '../../services/studioChatHistory';
import { getStudioModelSelection, getStudioAgents, getStudioAutoRunAgents, getStudioRuntime, STUDIO_MODEL_CHANGED } from '../../services/studioModelSelection';
import { stopLiveStudio, getStudioStatus } from '../../services/studioApi';
import { StudioModeBadge } from './StudioModeBadge';
import { generateStudioApp, streamGenerateStudioApp } from '../../services/studioGenerateApi';
import { streamStudioBuild, type BuildStage } from '../../services/studioBuildApi';
import { streamStudioAgents } from '../../services/studioAgentsApi';
import { resolveStudioAgentIds, studioAgentName } from '../../services/studioAgents';
import { createStudioSession } from '../../services/studioSessions';
import { hasUsableKey } from '../../services/apiKeys';
import { getDeployUrl, setDeployUrl } from '../../services/studioDeployUrl';
import { ensureSupabaseDependency, getBackend } from '../../services/studioBackend';
import { isProviderEnabled } from '../../services/sourceGovernance';
import { isLiveStudioEnabled } from '../../services/studioFlags';
import { downloadArtifactZip } from '../../services/studioLauncher';
import { exportProjectMarkdown, printPreview } from '../../services/studioExport';
import { startPreviewRecording, screenRecordingSupported, type ActiveRecording } from '../../services/studioRecord';

// Sandpack peek is heavy and legacy-ish — load it only when actually shown.
const CodeStudioPanel = lazy(() => import('../chat/CodeStudioPanel'));
// The settings panel pulls in the live model catalog — load it only when opened (keeps it out
// of the studio's eager bundle and the view's import graph).
const StudioSettingsPanel = lazy(() =>
  import('./StudioSettingsPanel').then((m) => ({ default: m.StudioSettingsPanel }))
);

export interface CodeStudioViewProps {
  /** App handed off from chat (if any). */
  artifact: CodeStudioArtifact | null;
  isAdmin: boolean;
  onBack: () => void;
  onNavigate: (view: string) => void;
}

const PaneFrame: React.FC<{ title: React.ReactNode; icon: React.ReactNode; className?: string; actions?: React.ReactNode; children: React.ReactNode }>
  = ({ title, icon, className, actions, children }) => {
    const t = useStudioTheme();
    return (
      <section className={`flex h-full w-full min-h-0 flex-col rounded-lg border ${t.edge} ${t.panel} overflow-hidden ${className ?? ''}`}>
        <header className={`flex items-center gap-2 px-3 py-2 border-b ${t.edge} ${t.panelAlt}`}>
          <span className={t.accent}>{icon}</span>
          <span className={`text-xs font-semibold tracking-wide ${t.textDim} uppercase`}>{title}</span>
          {actions ? <div className="ml-auto flex items-center gap-1">{actions}</div> : null}
        </header>
        <div className="min-h-0 flex-1 overflow-auto">{children}</div>
      </section>
    );
  };

export const CodeStudioView: React.FC<CodeStudioViewProps> = ({ artifact, isAdmin, onBack, onNavigate }) => {
  const t = useStudioTheme();
  const wide = useIsWide();
  const enabled = isAdmin || isLiveStudioEnabled();
  // Honest build-mode signal from the SERVER (is the live agentic Worker actually configured?),
  // independent of the client flag — so the header badge never claims "agentic" while builds 503.
  const [liveConfigured, setLiveConfigured] = useState<boolean | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    getStudioStatus()
      .then((s) => { if (alive) setLiveConfigured(s.liveConfigured); })
      .catch(() => { /* leave undefined → badge stays hidden rather than guessing */ });
    return () => { alive = false; };
  }, []);
  // The live agentic build is available when the server Worker is actually configured (the honest
  // signal) OR the user is an admin / has the live flag (so admins keep it before status resolves).
  // Additive: nobody who had the build loses it; a configured server now gets it by default.
  const liveAvailable = enabled || liveConfigured === true;
  const loadArtifact = useStudioWorkspace((s) => s.loadArtifact);
  const wsTitle = useStudioWorkspace((s) => s.title);
  const wsTemplate = useStudioWorkspace((s) => s.template);
  const wsFiles = useStudioWorkspace((s) => s.files);
  const wsBaseline = useStudioWorkspace((s) => s.baseline);
  const wsPaths = useStudioWorkspace((s) => s.paths);
  const wsProjectId = useStudioWorkspace((s) => s.projectId);
  const wsSessionId = useStudioWorkspace((s) => s.sessionId);
  const appendLog = useStudioLogs((s) => s.append);
  const logCount = useStudioLogs((s) => s.entries.length);
  const revertFile = useStudioWorkspace((s) => s.revertFile);
  const setTheme = useStudioThemeStore((s) => s.setTheme);
  const focus = useStudioFocus((s) => s.focus);
  const setFocus = useStudioFocus((s) => s.setFocus);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // The studio's own coding-model selection (independent of comics/chat), reflected in the pill.
  const [studioModel, setStudioModel] = useState(() => getStudioModelSelection());
  useEffect(() => {
    const onChange = () => setStudioModel(getStudioModelSelection());
    window.addEventListener(STUDIO_MODEL_CHANGED, onChange);
    return () => window.removeEventListener(STUDIO_MODEL_CHANGED, onChange);
  }, []);
  const runBuildRef = useRef<() => void>(() => {});
  // Lets handleGenerate auto-trigger the agent team (seamless mode) without a declaration-order issue.
  const runAgentsRef = useRef<() => void>(() => {});
  // Mirror of the live runId so the unmount cleanup can pause the sandbox without a stale closure.
  const runIdRef = useRef<string | null>(null);
  // The "engineering team" build flow for a NEW app: Understand → Plan → Build → Review.
  const [flow, setFlow] = useState<StudioFlowState>({ phase: 'idle', prompt: '', answers: [] });
  const flowTmplRef = useRef<CodeStudioTemplate | undefined>(undefined);
  // Lets the user cancel an in-flight generation (Stop button on the composer).
  const genAbortRef = useRef<AbortController | null>(null);
  // The last generation request, so a failed/cancelled run can be retried.
  const lastGenRef = useRef<{ prompt: string; tmpl?: CodeStudioTemplate } | null>(null);
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
  // Polyglot: classify the project so the preview renders web apps in-browser but shows an honest
  // "run it locally / cloud-run" panel for non-web projects (Python/Go/…) instead of a broken preview.
  const projectKind = useMemo(() => detectProjectKind(currentArtifact.files), [currentArtifact.files]);
  // Live code verification + metrics — pure, instant, recomputed only when the files change. This is
  // the studio's "it actually verified the code" surface (health score, issues, import graph).
  // NOTE: this is STATIC only; the real "does it run" signal (previewError) is folded in below via
  // applyRuntimeStatus so a failing app can never display as healthy.
  const baseInsights = useMemo(
    () => analyzeProject(currentArtifact.files, currentArtifact.template),
    [currentArtifact.files, currentArtifact.template]
  );

  // Load the handed-off app into the editor workspace.
  useEffect(() => {
    if (artifact) loadArtifact(artifact);
  }, [artifact, loadArtifact]);

  // Fresh build conversation + activity per studio entry (don't inherit a stale thread/feed).
  useEffect(() => {
    useStudioConversation.getState().clear();
    useStudioActivity.getState().reset();
  }, []);

  // Warm the instant-preview runtime (the heavy lazy Sandpack chunk) shortly after mount, so the
  // FIRST preview paints immediately instead of stalling on a ~1MB download when files arrive.
  // The quick view should feel ever-present — this is what makes it so.
  useEffect(() => {
    const id = window.setTimeout(() => { void import('../chat/CodeStudioPanel'); }, 1200);
    return () => window.clearTimeout(id);
  }, []);

  // Always have an identity to reference: ensure a session id (and a project id) the moment the
  // studio opens — and again after "New project" clears it — surfaced in the header and stamped onto
  // exports/reports, so there's never "nothing to reference it to".
  useEffect(() => {
    if (wsSessionId) return;
    const ws = useStudioWorkspace.getState();
    const s = createStudioSession();
    ws.setIdentity(ws.projectId ?? s.projectId, s.sessionId);
  }, [wsSessionId]);

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
  const [publishOpen, setPublishOpen] = useState(false);
  // The project's last successful deploy URL (permanent link), remembered across reloads.
  const [deployUrl, setDeployUrlState] = useState<string | null>(() => getDeployUrl(useStudioWorkspace.getState().projectId));
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);
  // The agent team is reviewing (drives the "reviewing" progress phase, distinct from a plain build).
  const [reviewing, setReviewing] = useState(false);
  // Conversational refine: when an iterate prompt is genuinely ambiguous, the agent asks a couple of
  // questions INLINE in the chat (multi-choice or free text) before building — gated so it never
  // bombards (off for trivial changes, and the server is tuned to usually ask nothing).
  const [iterateGate, setIterateGate] = useState<{ prompt: string; tmpl?: CodeStudioTemplate; clarify: StudioClarifyResult } | null>(null);
  const [gateLoading, setGateLoading] = useState(false);
  const [askBeforeBuild, setAskBeforeBuild] = useState<boolean>(() => {
    try { return window.localStorage.getItem('studio.askBeforeBuild') !== '0'; } catch { return true; }
  });
  const toggleAskBeforeBuild = useCallback(() => {
    setAskBeforeBuild((v) => {
      const next = !v;
      try { window.localStorage.setItem('studio.askBeforeBuild', next ? '1' : '0'); } catch { /* ignore */ }
      return next;
    });
  }, []);
  // undefined = "Auto" — the AI picks the best stack from the prompt (no forced choice).
  // Seed from the studio's saved default scaffold (Settings) when the user set one.
  const [template, setTemplate] = useState<CodeStudioTemplate | undefined>(
    () => (getStudioModelSelection().defaultTemplate as CodeStudioTemplate | null) ?? undefined
  );
  // The latest *persistent* preview error (sticky — only cleared when the preview actually recovers,
  // or when the user starts a new app / refine). Keeping it sticky is what makes "Fix with AI" always
  // reachable and stops the banner flashing on/off through each auto-repair cycle.
  const [previewError, setPreviewError] = useState<string | null>(null);
  // How many automatic fix attempts we've spent on the CURRENT error episode (state so the banner
  // re-renders: calm "auto-fixing…" bar while budget remains, clickable error once it's exhausted).
  const [autofixTries, setAutofixTries] = useState(0);
  const autofixTriesRef = useRef(0);
  const setTries = useCallback((n: number) => { autofixTriesRef.current = n; setAutofixTries(n); }, []);
  // Error signatures already auto-fixed in the CURRENT episode. The watchdog stops escalating the
  // moment an error recurs unchanged (the previous fix made no progress) — this is what makes a
  // higher attempt budget safe: we self-heal while genuinely making progress, and bail when stuck
  // instead of churning full-project rewrites on the same error.
  const attemptedErrorsRef = useRef<Set<string>>(new Set());
  const clearAutofix = useCallback(() => { setTries(0); attemptedErrorsRef.current.clear(); }, [setTries]);
  // Displayed insights = static analysis WITH the real preview error folded in, so "code health"
  // is honest: a preview that fails to run shows as failing (F), never 100/A.
  const insights = useMemo(() => applyRuntimeStatus(baseInsights, previewError), [baseInsights, previewError]);
  // Console/logs dock (under the preview) — collapsible, persisted.
  const [logsOpen, setLogsOpen] = useState<boolean>(() => {
    try { return window.localStorage.getItem('studio.logs.open') !== '0'; } catch { return true; }
  });
  useEffect(() => { try { window.localStorage.setItem('studio.logs.open', logsOpen ? '1' : '0'); } catch { /* ignore */ } }, [logsOpen]);
  // The noisy build internals (live file stream, self-heal trace, services, changes, history) live
  // in ONE collapsible disclosure so the chat reads cleanly at rest (the AI-Studio pattern). It
  // opens automatically while a build is running so live progress stays visible.
  const [detailsOpen, setDetailsOpen] = useState(false);
  // Fullscreen the live preview (covers the studio) when the user wants maximum real estate.
  const [previewFull, setPreviewFull] = useState(false);
  // Client-side screen recording of the preview → downloadable video (no server / no egress).
  const [recording, setRecording] = useState<ActiveRecording | null>(null);
  const togglePreviewRecording = async () => {
    if (recording) { recording.stop(); setRecording(null); return; }
    const r = await startPreviewRecording(wsTitle || 'preview');
    if (r) setRecording(r);
  };
  // The in-browser preview (Sandpack) reports transient compile/HMR blips while a refine streams in,
  // and only re-emits when the error *string* changes — so we debounce BOTH directions: a new error
  // must persist (~0.9s) before we surface it, and a recovery must hold (~0.5s) before we clear it.
  // That single debounce is what stops the flashing in both directions. Stable identity (deps: []) so
  // the Sandpack ErrorWatcher effect doesn't re-subscribe on every render.
  const previewErrTimer = useRef<number | null>(null);
  // Autonomous autofix budget per error episode. The loop is driven by the watchdog effect below
  // (not by Sandpack re-emitting), so it never silently stalls, and it ALWAYS terminates at a
  // clickable "Fix with AI" error once spent. The budget is a hard ceiling; in practice the loop
  // self-limits via progress detection (attemptedErrorsRef): it only escalates while each fix
  // changes the error, and stops immediately when the same error recurs. That is the difference
  // from the old blind MAX=4 (which churned full rewrites on the same hiccup) and the over-cautious
  // MAX=1 (which gave up before a 2-step fix could land). Manual retry is always available.
  const MAX_AUTOFIX = 3;
  const autofixRef = useRef<(msg: string) => void>(() => {});
  const generatingRef = useRef(false);
  const onPreviewError = useCallback((e: string | null) => {
    if (previewErrTimer.current) { clearTimeout(previewErrTimer.current); previewErrTimer.current = null; }
    previewErrTimer.current = window.setTimeout(() => {
      if (!e) {
        // Stable recovery → clear the error. We deliberately do NOT reset the auto-fix budget here:
        // a regenerate makes the preview flicker to "no error" mid-reload, and resetting on that
        // transient null re-armed MAX_AUTOFIX every cycle → endless rebuilds. The budget resets only
        // on a USER-initiated build/refine (handleGenerate non-autofix / runAgents / reset).
        setPreviewError(null);
        return;
      }
      // Stable error → make it the current (sticky) error; the watchdog effect drives any auto-fix.
      setPreviewError((prev) => (prev === e ? prev : e));
    }, e ? 900 : 500);
  }, [setTries]);

  // Keep a ref of `generating` so the (stable-identity) preview-error callback can gate autofix.
  useEffect(() => { generatingRef.current = generating; }, [generating]);

  // Auto-open the build-details disclosure while a build runs (so the live trace/changes are
  // visible); it stays where the user leaves it once idle.
  useEffect(() => { if (generating) setDetailsOpen(true); }, [generating]);

  // Auto-fix watchdog: whenever a persistent preview error is showing, nothing else is generating,
  // and we still have budget, kick off an automatic fix after a short settle (long enough for the
  // preview to re-render and report a recovery first, so we never "fix" an already-fixed app). This
  // effect — not Sandpack's error event — drives the loop, so it continues across DIFFERENT errors
  // (real progress) but bails the moment an error recurs unchanged, and always terminates at the
  // clickable error once the budget is spent.
  useEffect(() => {
    if (!hasFiles || previewUrl || !previewError || generating) return;
    if (autofixTriesRef.current >= MAX_AUTOFIX) return;
    // No progress since the last fix (same error) → stop auto-retrying; surface the manual button.
    if (attemptedErrorsRef.current.has(errSig(previewError))) return;
    const id = window.setTimeout(() => {
      if (generatingRef.current || !previewError || autofixTriesRef.current >= MAX_AUTOFIX) return;
      if (attemptedErrorsRef.current.has(errSig(previewError))) return;
      setTries(autofixTriesRef.current + 1);
      autofixRef.current(previewError);
    }, 700);
    return () => window.clearTimeout(id);
  }, [previewError, generating, hasFiles, previewUrl, setTries]);

  // Surface the verifier's result in the console whenever the code settles (not mid-stream), so the
  // logs show real, specific output ("Verified N files · health X/100 · K issues") instead of silence.
  const lastVerifyRef = useRef<string>('');
  useEffect(() => {
    if (!hasFiles || generating) return;
    const summary = insightsSummary(insights);
    if (summary === lastVerifyRef.current) return;
    lastVerifyRef.current = summary;
    appendLog(insights.counts.error ? 'warn' : 'success', summary);
  }, [insights, hasFiles, generating, appendLog]);

  // Pause the live sandbox when the user leaves the studio (unmount) — never leave a container
  // running (and billing) after they navigate away. Mirror runId so the cleanup isn't stale.
  useEffect(() => { runIdRef.current = runId; }, [runId]);
  useEffect(() => () => { const id = runIdRef.current; if (id) void stopLiveStudio(id).catch(() => {}); }, []);

  // One chat per build: persist this project's conversation, and restore it when a project opens.
  const convoMessages = useStudioConversation((s) => s.messages);
  useEffect(() => {
    if (wsProjectId && convoMessages.length) saveStudioChat(wsProjectId, convoMessages);
  }, [convoMessages, wsProjectId]);
  // Keep the (full-height, left) chat scrolled to the latest message — like a real chat thread.
  const chatScrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = chatScrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [convoMessages, generating]);
  useEffect(() => {
    if (!wsProjectId) return;
    const saved = loadStudioChat(wsProjectId);
    if (saved && saved.length && useStudioConversation.getState().messages.length === 0) {
      useStudioConversation.getState().setMessages(saved);
    }
  }, [wsProjectId]);

  // Esc cancels an in-flight generation (only listens while generating).
  useEffect(() => {
    if (!generating) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') genAbortRef.current?.abort(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [generating]);

  // Agentic build: stream plan → run → observe → fix → done, self-healing errors. The final
  // preview URL is the live app. Drives the BuildTrace + logs + run status.
  const stageLevel = (stage: BuildStage) =>
    stage === 'done' ? 'success' : stage === 'stopped' || stage === 'observe' ? 'warn' : 'info' as const;

  const runBuild = async () => {
    if (!hasFiles || !liveAvailable || status === 'starting') return;
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
            if (/not configured|STUDIO_NOT_CONFIGURED/i.test(msg)) {
              setStatus('idle');
              appendLog('system', 'Cloud sandbox not configured — showing the in-browser preview instead.');
              return;
            }
            useStudioBuild.getState().fail(msg);
            setStatus('error'); setError(msg); appendLog('error', msg);
          },
        }
      );
    } catch (err) {
      const msg = (err as Error)?.message || 'Build failed.';
      // Worker not deployed / unreachable → soft-fall back to the instant in-browser preview.
      if (/not configured|STUDIO_NOT_CONFIGURED|50[23]/i.test(msg)) {
        setStatus('idle');
        appendLog('system', 'Cloud sandbox not available — using the in-browser preview instead.');
        return;
      }
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
  const handleGenerate = async (
    prompt: string,
    tmpl?: CodeStudioTemplate,
    opts?: { plan?: StudioBuildPlan; answers?: StudioAnswer[]; autoReview?: boolean; autofix?: boolean }
  ): Promise<{ ok: boolean; error?: string }> => {
    if (generating) return { ok: false, error: 'busy' };
    lastGenRef.current = { prompt, tmpl };
    const refining = hasFiles;
    setGenerating(true);
    setGenError(null);
    // A user-initiated build/refine clears the current error and resets the auto-fix budget. An
    // AUTOMATIC fix keeps the sticky error (so the calm "auto-fixing…" bar stays put and never
    // flashes back to a clickable error mid-loop) until the preview genuinely recovers.
    if (!opts?.autofix) { setPreviewError(null); clearAutofix(); }
    const convo = useStudioConversation.getState();
    if (!refining) {
      convo.clear(); // a brand-new app starts a fresh thread
      // Every new project gets a stored, client-generated project + session id from creation.
      const ws = useStudioWorkspace.getState();
      if (!ws.projectId) {
        const s = createStudioSession();
        ws.setIdentity(s.projectId, s.sessionId);
        appendLog('system', `New project — ${s.tag}`);
      }
    }
    convo.pushUser(prompt);
    convo.pushAssistant(refining ? 'Updating your app…' : 'Generating your app…', 'pending');
    useStudioActivity.getState().begin();
    appendLog('system', refining ? `Refining: ${prompt}` : `Generating app: ${prompt}`);

    // If the user connected a real backend, tell the model to USE it (not mocks) on refines — this
    // is what makes "connect a backend" actually flow into the AI's work. Only the API payload is
    // augmented; the chat bubble keeps the user's original words.
    const backendConn = getBackend(useStudioWorkspace.getState().projectId);
    const apiPrompt = refining && !opts?.autofix && backendConn?.provider === 'supabase'
      ? `${prompt}\n\n(This app is connected to a Supabase backend — import { supabase } from './lib/supabaseClient'. Use it for data persistence/auth instead of mock/in-memory data.)`
      : prompt;
    const input = {
      prompt: apiPrompt,
      template: tmpl ?? template,
      files: refining ? currentArtifact.files.map((f) => ({ path: f.path, content: f.content })) : undefined,
      title: refining ? wsTitle : undefined,
      plan: refining ? undefined : opts?.plan,
      answers: refining ? undefined : opts?.answers,
    };
    let outcome: { ok: boolean; error?: string } = { ok: false };
    // Pre-edit snapshot so we can mark each streamed file new/modified and, on success, annotate
    // it with a +added/−removed diff stat (diff-centric live edits).
    const baseline = new Map((input.files ?? []).map((f) => [f.path, f.content]));

    const controller = new AbortController();
    genAbortRef.current = controller;
    const { signal } = controller;

    const succeed = (artifact: CodeStudioArtifact) => {
      // Annotate each file with its diff vs the pre-edit version (refine only).
      if (refining) {
        for (const f of artifact.files) {
          const old = baseline.get(f.path);
          if (old !== undefined) {
            const { added, removed } = diffStat(diffLines(old, f.content));
            useStudioActivity.getState().upsertFile({ path: f.path, status: 'written', change: 'modified', added, removed });
          } else {
            useStudioActivity.getState().upsertFile({ path: f.path, status: 'written', change: 'new' });
          }
        }
      }
      loadArtifact(artifact);
      const summary = `${refining ? 'Updated' : 'Built'} "${artifact.title}" — ${artifact.files.length} file${artifact.files.length === 1 ? '' : 's'}`;
      useStudioConversation.getState().resolveLastAssistant(`${summary}.`, 'done');
      useStudioActivity.getState().finish('done', `✓ ${summary}`);
      appendLog('success', `${summary}. Live preview is below; press Build to run it in a cloud container.`);
      outcome = { ok: true };
      // The agent team reviews EVERY build — new apps and refines alike — so nothing ships on the
      // model's first answer (it's a baked-in pipeline stage, not an optional button). It's a
      // PURE-LLM pass (no cloud worker), so it runs for everyone, not just admins/live-flag users.
      // The one exception is an AUTOMATIC fix: re-reviewing on top of the autofix watchdog would
      // loop and churn, so a silent self-heal never triggers the team.
      if (!opts?.autofix && (opts?.autoReview || getStudioAutoRunAgents())) {
        appendLog('system', refining ? 'The agent team is reviewing your changes…' : 'The agent team is reviewing your new app…');
        setTimeout(() => runAgentsRef.current(), 80);
      }
    };
    const failWith = (msg: string) => {
      useStudioConversation.getState().resolveLastAssistant(msg, 'error');
      useStudioActivity.getState().finish('error', msg);
      setGenError(msg);
      appendLog('error', msg);
      outcome = { ok: false, error: msg };
    };
    const cancelled = () => {
      useStudioConversation.getState().resolveLastAssistant('Generation stopped.', 'error');
      useStudioActivity.getState().finish('error', 'Generation stopped.');
      appendLog('warn', 'Generation stopped.');
      outcome = { ok: false, error: 'cancelled' };
    };

    try {
      // Stream the build so the activity feed shows files appearing live; fall back to the
      // blocking generate if the SSE transport isn't available (but not if the user cancelled).
      let artifact: CodeStudioArtifact | null = null;
      let streamError: string | null = null;
      try {
        await streamGenerateStudioApp(input, {
          onPhase: (label) => { if (label) useStudioActivity.getState().pushPhase(label); },
          onFile: (f) => useStudioActivity.getState().upsertFile({
            ...f,
            change: refining ? (baseline.has(f.path) ? 'modified' : 'new') : undefined,
          }),
          onResult: (a) => { artifact = a; },
          onError: (msg) => { streamError = msg; },
        }, signal);
      } catch (streamErr) {
        if (signal.aborted) throw streamErr;
        artifact = await generateStudioApp(input, signal);
      }
      if (artifact) succeed(artifact);
      else failWith(streamError || 'The model did not return a valid app. Try rephrasing your idea.');
    } catch (err) {
      // Friendly, classified message (cold start / rate-limit / server) instead of a raw error —
      // the activity feed already exposes a Retry, so the user gets a clear cause + a way forward.
      if (signal.aborted) cancelled();
      else failWith(describeApiError(err));
    } finally {
      setGenerating(false);
      genAbortRef.current = null;
    }
    return outcome;
  };

  // Cancel an in-flight generation (the composer's Stop button).
  const cancelGenerate = () => { genAbortRef.current?.abort(); };

  // Multi-agent refine: a team of specialists (architecture, code, frontend, ui, design, data,
  // security, verification) sequentially reviews + refines the current app. Streams a per-agent
  // trace into the activity feed; on success the refined files replace the workspace.
  const runAgents = async () => {
    if (generating || !hasFiles) return;
    const agentIds = resolveStudioAgentIds(getStudioAgents());
    const names = agentIds.map(studioAgentName).join(', ');
    setGenerating(true);
    setGenError(null);
    setPreviewError(null); clearAutofix();
    setReviewing(true);
    const convo = useStudioConversation.getState();
    convo.pushUser(`Refine with agents: ${names}`);
    convo.pushAssistant('Your agent team is refining the app…', 'pending');
    const activity = useStudioActivity.getState();
    activity.begin();
    appendLog('system', `Refining with ${agentIds.length} agents: ${names}`);

    const controller = new AbortController();
    genAbortRef.current = controller;
    const { signal } = controller;

    const files = currentArtifact.files.map((f) => ({ path: f.path, content: f.content }));
    let refined: { path: string; content: string }[] | null = null;
    let trace: { id: string; name: string; status: 'done' | 'skipped' | 'error'; note?: string; changed: string[] }[] = [];
    let streamError: string | null = null;
    try {
      await streamStudioAgents(
        { files, projectId: wsProjectId ?? undefined, title: wsTitle, template: currentArtifact.template },
        {
          onPlan: (p) => {
            activity.pushPhase(`Review team (${p.agents.length}): ${p.agents.map((a) => a.name).join(', ')}`);
            appendLog('system', `Lead assembled the review team on ${p.model.split('/').pop()}: ${p.agents.map((a) => a.name).join(', ')}`);
          },
          onAgent: (s) => {
            if (s.status === 'running') { activity.pushPhase(`${s.name} reviewing… (${s.index + 1}/${s.total})`); return; }
            const changed = s.changed || [];
            if (s.status === 'done') {
              changed.forEach((path) => activity.upsertFile({ path, status: 'written', change: 'modified' }));
              activity.pushPhase(`${s.name}: ${s.note || 'updated'} · ${changed.length} file${changed.length === 1 ? '' : 's'}`);
              appendLog('success', `[${s.name}] ${s.note || 'updated'}`);
            } else if (s.status === 'skipped') {
              activity.pushPhase(`${s.name}: no changes needed`);
              appendLog('info', `[${s.name}] no changes needed`);
            } else if (s.status === 'error') {
              activity.pushPhase(`${s.name} failed`);
              appendLog('warn', `[${s.name}] ${s.note || 'failed'}`);
            }
          },
          onResult: (r) => { refined = r.files; trace = r.trace || []; },
          onError: (msg) => { streamError = msg; },
        },
        signal
      );
      if (refined && (refined as { path: string; content: string }[]).length) {
        const list = refined as { path: string; content: string }[];
        const artifact: CodeStudioArtifact = { title: wsTitle || currentArtifact.title, template: currentArtifact.template, files: list };
        loadArtifact(artifact);
        // Lead aggregation — one summary that keeps an eye on what the whole team did.
        const improved = trace.filter((x) => x.status === 'done');
        const skipped = trace.filter((x) => x.status === 'skipped');
        const errored = trace.filter((x) => x.status === 'error');
        const parts: string[] = [`Lead review complete — "${artifact.title}", ${list.length} file${list.length === 1 ? '' : 's'}.`];
        if (improved.length) parts.push(`Improved by ${improved.map((a) => a.name).join(', ')}.`);
        if (skipped.length) parts.push(`${skipped.length} agent${skipped.length === 1 ? '' : 's'} found nothing to change.`);
        if (errored.length) parts.push(`${errored.length} hit an error (${errored.map((a) => a.name).join(', ')}).`);
        const lead = parts.join(' ');
        convo.resolveLastAssistant(lead, 'done');
        activity.pushPhase('Lead aggregated the team review');
        activity.finish('done', `✓ ${lead}`);
        appendLog('success', `${lead} Live preview updated.`);
      } else {
        const msg = streamError || 'The agents made no changes.';
        convo.resolveLastAssistant(msg, streamError ? 'error' : 'done');
        activity.finish(streamError ? 'error' : 'done', msg);
        if (streamError) { setGenError(streamError); appendLog('error', streamError); }
      }
    } catch (err) {
      if (signal.aborted) {
        convo.resolveLastAssistant('Refinement stopped.', 'error');
        activity.finish('error', 'Refinement stopped.');
        appendLog('warn', 'Refinement stopped.');
      } else {
        const msg = (err as Error)?.message || 'Agent refinement failed.';
        setGenError(msg);
        convo.resolveLastAssistant(msg, 'error');
        activity.finish('error', msg);
        appendLog('error', msg);
      }
    } finally {
      setGenerating(false);
      setReviewing(false);
      genAbortRef.current = null;
    }
  };
  runAgentsRef.current = runAgents;

  // --- New-app build flow: Understand (clarify) → Plan → Build → Review (agent team) ---
  const goToPlan = async (prompt: string, answers: StudioAnswer[]) => {
    setFlow((f) => ({ ...f, phase: 'planning', prompt, answers }));
    try {
      const plan = await planStudioApp(prompt, answers);
      setFlow((f) => ({ ...f, phase: 'plan', plan, answers }));
    } catch (err) {
      // The plan is ADVISORY — generate works fine without one. So a plan failure must never
      // dead-end the flow at an error screen: log it honestly and build directly from the idea.
      appendLog('warn', `Couldn't draft a build plan (${describeApiError(err)}) — building directly from your idea.`);
      await runFlowBuild(undefined, answers, prompt);
    }
  };

  const startNewApp = async (prompt: string, tmpl?: CodeStudioTemplate) => {
    const p = prompt.trim();
    if (!p || generating) return;
    flowTmplRef.current = tmpl;
    setFlow({ phase: 'clarifying', prompt: p, answers: [] });
    try {
      const clarify = await clarifyStudioApp(p);
      if (clarify.questions.length) setFlow({ phase: 'questions', prompt: p, clarify, answers: [] });
      else await goToPlan(p, []); // nothing to ask → plan straight away
    } catch {
      await goToPlan(p, []); // clarify is best-effort
    }
  };

  const submitAnswers = (answers: StudioAnswer[]) => { void goToPlan(flow.prompt, answers); };
  const skipQuestions = () => { void goToPlan(flow.prompt, []); };
  const regeneratePlan = () => { void goToPlan(flow.prompt, flow.answers); };

  // Run the BUILD stage of the flow — from a reviewed plan, or (when planning failed) directly
  // from the idea with no plan. Shared by buildFromPlan and goToPlan's graceful degrade.
  const runFlowBuild = async (plan: StudioBuildPlan | undefined, answers: StudioAnswer[], prompt: string) => {
    setFlow((f) => ({ ...f, phase: 'building', prompt, answers }));
    // Opt-in deep agent review; otherwise the worker self-heal loop (below) is the primary "run".
    const autoReview = getStudioAutoRunAgents();
    const res = await handleGenerate(prompt, flowTmplRef.current, { plan, answers, autoReview });
    if (res.ok || res.error === 'cancelled') {
      setFlow({ phase: 'idle', prompt: '', answers: [] });
      // Run it in the REAL sandbox (cloud worker, self-healing). Soft-falls back to the in-browser
      // preview when the worker isn't available. Skipped if the agent review is already running.
      if (res.ok && liveAvailable && getStudioRuntime() !== 'browser' && !autoReview) {
        setTimeout(() => runBuildRef.current(), 150);
      }
    } else {
      setFlow((f) => ({ ...f, phase: 'error', error: res.error || 'Build failed.' }));
    }
  };

  const buildFromPlan = async () => {
    if (!flow.plan) return;
    await runFlowBuild(flow.plan, flow.answers, flow.prompt);
  };

  const resetFlow = () => { genAbortRef.current?.abort(); setFlow({ phase: 'idle', prompt: '', answers: [] }); };
  const retryFlow = () => {
    if (flow.phase !== 'error') return;
    if (flow.plan) void buildFromPlan();
    else void startNewApp(flow.prompt, flowTmplRef.current);
  };

  // Retry the last generation after a failure or cancel (Retry button on the activity feed).
  const retryLastGenerate = () => {
    const last = lastGenRef.current;
    if (last && !generating) void handleGenerate(last.prompt, last.tmpl);
  };

  // Fold the user's clarify answers into the refine request.
  const composeRefinePrompt = (prompt: string, answers: StudioAnswer[]): string =>
    answers.length
      ? `${prompt}\n\nMy answers:\n${answers.map((a) => `- ${a.question} → ${a.answer}`).join('\n')}`
      : prompt;

  // The iterate composer's submit. For a substantial change we let the agent ask a couple of sharp
  // questions first (conversational refine, rendered inline in the chat); trivial changes go straight
  // to building. Best-effort: any clarify hiccup just falls through and builds — never blocks.
  const onComposerSubmit = async (prompt: string, tmpl?: CodeStudioTemplate) => {
    const p = prompt.trim();
    if (!p || generating || gateLoading) return;
    const trivial = p.length < 18;
    if (!askBeforeBuild || trivial || !hasFiles) { void handleGenerate(p, tmpl); return; }
    setGateLoading(true);
    try {
      const res = await clarifyStudioApp(p, { files: currentArtifact.files.map((f) => ({ path: f.path, content: f.content })) });
      if (res.questions.length) { setIterateGate({ prompt: p, tmpl, clarify: res }); return; }
    } catch {
      /* clarify is best-effort — fall through and just build */
    } finally {
      setGateLoading(false);
    }
    void handleGenerate(p, tmpl);
  };

  const submitIterateAnswers = (answers: StudioAnswer[]) => {
    const gate = iterateGate;
    if (!gate) return;
    setIterateGate(null);
    void handleGenerate(composeRefinePrompt(gate.prompt, answers), gate.tmpl);
  };
  const skipIterateGate = () => {
    const gate = iterateGate;
    if (!gate) return;
    setIterateGate(null);
    void handleGenerate(gate.prompt, gate.tmpl);
  };

  // Export a shareable verification report (markdown) stamped with the project + session id.
  const exportReport = () => {
    const md = insightsToMarkdown(insights, { title: wsTitle, projectId: wsProjectId, sessionId: wsSessionId });
    try {
      const blob = new Blob([md], { type: 'text/markdown' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${(wsTitle || 'project').replace(/[^\w.-]+/g, '_')}-report.md`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      appendLog('info', 'Exported the project report.');
    } catch {
      appendLog('warn', 'Could not export the report.');
    }
  };

  // Start over: clear the workspace + thread + activity back to the projects/start screen.
  const newProject = () => {
    genAbortRef.current?.abort();
    // Pause the live sandbox for the project we're leaving (don't keep a container running).
    if (runId) { void stopLiveStudio(runId).catch(() => {}); appendLog('system', 'Paused the live sandbox.'); }
    useStudioWorkspace.getState().reset();
    useStudioConversation.getState().clear();
    useStudioActivity.getState().reset();
    setFlow({ phase: 'idle', prompt: '', answers: [] });
    setStatus('idle'); setRunId(null); setPreviewUrl(null);
    setError(null); setGenError(null); setPreviewError(null); clearAutofix();
  };

  // Leave Code Studio entirely — pause any live sandbox first.
  const leaveStudio = () => {
    if (runId) void stopLiveStudio(runId).catch(() => {});
    onBack();
  };

  // Jump from an activity-feed file row straight into the editor (and reveal the Code pane).
  const openFileInEditor = (path: string) => {
    useStudioWorkspace.getState().openFile(path);
    if (focus === 'preview') setFocus('code');
  };

  // Scaffold /.env.example with the env vars the AI's code references (Services panel).
  const addEnvExample = (content: string) => {
    useStudioWorkspace.getState().addFile('/.env.example', content);
    if (focus === 'preview') setFocus('code');
    appendLog('success', 'Added /.env.example with the variables this app expects.');
  };

  // Autodebug: feed the preview's error back to the model as a refine ("fix this"). The auto-loop
  // (watchdog effect) calls this with the budget already incremented; the manual "Fix with AI"
  // button resets the budget so the loop re-engages from scratch.
  const handleAutofix = (errorMsg: string, manual = false) => {
    if (!errorMsg || generating) return;
    // Manual retry = "try this exact error again": clear the loop guard so the watchdog re-engages,
    // and spend one attempt now. The automatic path arrives with the budget already incremented.
    if (manual) { attemptedErrorsRef.current.clear(); setTries(1); }
    // Mark this error as attempted so a fix that leaves it unchanged stops the loop (see watchdog).
    attemptedErrorsRef.current.add(errSig(errorMsg));
    appendLog('warn', `Auto-fixing the preview error… (attempt ${autofixTriesRef.current || 1}/${MAX_AUTOFIX})`);
    void handleGenerate(
      `The live preview shows this error — find the ROOT CAUSE and fix it so the app runs cleanly. Return the full corrected files; do not reintroduce the error:\n\n${errorMsg}`,
      undefined,
      { autofix: true }
    );
  };
  autofixRef.current = (msg: string) => handleAutofix(msg, false);

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

  // Attempt a one-click deploy to the chosen provider (best-effort). The client normalizes a
  // not-yet-wired server into an honest "unavailable" so the Publish panel guides the manual path
  // instead of pretending the app shipped. Dynamic import keeps the apiClient chain lazy.
  // Surface the project's remembered deploy URL whenever the open project changes.
  useEffect(() => { setDeployUrlState(getDeployUrl(wsProjectId)); }, [wsProjectId]);

  const handleDeploy = async (target: 'cloudflare' | 'vercel' | 'supabase') => {
    appendLog('system', `Deploying to ${target}…`);
    try {
      const { deployStudioApp } = await import('../../services/studioDeployApi');
      const res = await deployStudioApp({
        projectId: wsProjectId,
        title: wsTitle,
        target,
        files: currentArtifact.files.map((f) => ({ path: f.path, content: f.content })),
      });
      // Remember a successful deploy's permanent URL so it sticks in the header + Publish panel.
      if (res.status === 'live' && res.url) { setDeployUrl(wsProjectId, res.url); setDeployUrlState(res.url); }
      appendLog(res.status === 'live' ? 'success' : res.status === 'error' ? 'error' : 'info',
        `Deploy ${res.status}${res.url ? ` — ${res.url}` : ''}${res.message ? ` — ${res.message}` : ''}`);
      return res;
    } catch (err) {
      const message = (err as Error)?.message || 'Deploy failed.';
      appendLog('error', message);
      return { status: 'error' as const, message };
    }
  };

  // Command palette actions (filtered + run by the ⌘K palette).
  const commands: Command[] = [];
  if (hasFiles && liveAvailable) commands.push({ id: 'build', label: status === 'live' ? 'Re-build & run' : 'Build & run', hint: '⏎', icon: <Wand2 className="w-4 h-4" />, keywords: 'run agent compile heal', run: runBuild });
  if (status === 'live') commands.push({ id: 'stop', label: 'Stop run', icon: <Square className="w-4 h-4" />, keywords: 'halt kill end', run: stopLive });
  if (dirtyCount > 0) commands.push({ id: 'revert', label: `Revert all changes (${dirtyCount})`, icon: <Undo2 className="w-4 h-4" />, keywords: 'undo discard reset', run: () => dirtyList.forEach((p) => revertFile(p)) });
  if (hasFiles) commands.push({ id: 'zip', label: 'Download .zip', icon: <Download className="w-4 h-4" />, keywords: 'export save download', run: () => void downloadArtifactZip(currentArtifact) });
  if (hasFiles) commands.push({ id: 'export-md', label: 'Export as Markdown', icon: <Download className="w-4 h-4" />, keywords: 'export markdown md share copy docs', run: () => exportProjectMarkdown(currentArtifact) });
  if (hasFiles) commands.push({ id: 'print-pdf', label: 'Print / Save as PDF', icon: <FileCode className="w-4 h-4" />, keywords: 'print pdf export save preview', run: () => printPreview(previewUrl) });
  if (hasFiles && (insights.counts.error + insights.counts.warn) > 0) commands.push({ id: 'fix-issues', label: `Fix ${insights.counts.error + insights.counts.warn} code issue(s) with AI`, icon: <ShieldCheck className="w-4 h-4" />, keywords: 'verify fix repair lint errors issues health quality', run: () => void handleGenerate(issuesToFixPrompt(insights.issues)) });
  if (hasFiles) commands.push({ id: 'report', label: 'Export project report', icon: <Download className="w-4 h-4" />, keywords: 'report insights health verify metrics export markdown', run: exportReport });
  if (wsProjectId || wsSessionId) commands.push({
    id: 'copy-ids', label: 'Copy project & session IDs', icon: <Fingerprint className="w-4 h-4" />,
    keywords: 'id identity session project reference fingerprint support copy',
    run: () => {
      try {
        void navigator.clipboard?.writeText(`project: ${wsProjectId ?? '—'}\nsession: ${wsSessionId ?? '—'}`);
        appendLog('info', 'Copied project & session id to clipboard.');
      } catch { /* clipboard unavailable */ }
    },
  });
  commands.push({ id: 'theme-black', label: 'Theme: Black', icon: <Moon className="w-4 h-4" />, keywords: 'dark oled appearance theme', run: () => setTheme('black') });
  commands.push({ id: 'theme-white', label: 'Theme: White', icon: <Sun className="w-4 h-4" />, keywords: 'light appearance theme', run: () => setTheme('light') });
  commands.push({ id: 'theme-brand', label: 'Theme: DreamStream', icon: <Palette className="w-4 h-4" />, keywords: 'brand comic appearance theme', run: () => setTheme('brand') });
  if (hasFiles) {
    commands.push({ id: 'focus-preview', label: 'View: Preview', icon: <Eye className="w-4 h-4" />, keywords: 'layout preview running app toggle right pane', run: () => setFocus('preview') });
    commands.push({ id: 'focus-code', label: 'View: Code', icon: <FileCode className="w-4 h-4" />, keywords: 'layout editor code toggle right pane review', run: () => setFocus('code') });
  }
  if (hasFiles) commands.push({ id: 'new', label: 'New project', icon: <FilePlus className="w-4 h-4" />, keywords: 'new reset start over fresh blank clear', run: newProject });
  commands.push({ id: 'chat', label: 'Build from chat', icon: <MessageSquarePlus className="w-4 h-4" />, keywords: 'new prompt generate describe', run: () => onNavigate('chat') });
  if (hasFiles) commands.push({ id: 'agents', label: 'Refine with agent team', icon: <Users className="w-4 h-4" />, keywords: 'agents multi specialist architecture security verification data design refine improve review team', run: runAgents });
  if (hasFiles) commands.push({ id: 'publish', label: 'Publish & share', icon: <Share2 className="w-4 h-4" />, keywords: 'deploy share publish cloudflare vercel supabase host link ship bundle', run: () => setPublishOpen(true) });
  commands.push({ id: 'studio-settings', label: 'Code Studio settings (coding model & agents)', icon: <Cpu className="w-4 h-4" />, keywords: 'model coding source openrouter nvidia settings configure preferences creativity iterations agents', run: () => setSettingsOpen(true) });
  commands.push({ id: 'help', label: 'Keyboard shortcuts', icon: <CommandIcon className="w-4 h-4" />, keywords: 'keys help cheatsheet', run: () => setHelpOpen(true) });
  commands.push({ id: 'back', label: 'Back', icon: <ArrowLeft className="w-4 h-4" />, keywords: 'exit leave close', run: leaveStudio });

  const projectName = wsTitle || 'Untitled project';
  // Build model tier: BYOK (your OpenRouter key → frontier models) vs. free-first auto.
  // hasUsableKey covers the managed store, the legacy slot AND the account ("key on
  // file" from any device/studio) — a key added in Settings → API Configuration used
  // to be invisible here.
  const hasByok = isProviderEnabled('openrouter') && hasUsableKey('openrouter');

  // Live context-window usage for the next refine (project files + conversation vs the model's window).
  const pinnedModel = studioModel.mode === 'specific' ? studioModel.model : null;
  const ctxUsage = useMemo(
    () => computeContextUsage(currentArtifact.files, convoMessages, pinnedModel),
    [currentArtifact.files, convoMessages, pinnedModel]
  );
  // Which "working" phase the calm live-progress surface should show.
  const progressActive = generating || status === 'starting';
  const progressPhase: ProgressPhase = reviewing ? 'reviewing' : status === 'starting' ? 'building' : previewError ? 'fixing' : 'generating';
  // Heuristic next-step suggestions (instant fallback while the AI suggestion call resolves) —
  // backend-aware: reflects whether this project already has a connected DB.
  const hasBackend = !!getBackend(wsProjectId);
  const fallbackSuggestions = useMemo(() => suggestNextSteps(insights, { hasBackend }), [insights, hasBackend]);

  // ---- Panes (defined once, placed into the resizable or stacked layout) ----
  // Chat pane — full height on the left. The conversation history scrolls and fills the column;
  // the composer is pinned at the bottom (like a real chat), so the build history is always visible.
  const promptPane = (
    <section className={`flex h-full w-full min-h-0 flex-col rounded-lg border ${t.edge} ${t.panel} overflow-hidden`}>
      <header className={`flex flex-col gap-1.5 px-3 py-2 border-b ${t.edge} ${t.panelAlt}`}>
        <div className="flex items-center gap-2">
          <span className={t.accent}><Sparkles className="w-4 h-4" /></span>
          <span className={`text-xs font-semibold tracking-wide ${t.textDim} uppercase`}>Chat · Build</span>
        </div>
        {/* Context-usage limits bar — how full the coding model's window is for the next refine. */}
        {hasFiles && <ContextUsageBar usage={ctxUsage} />}
      </header>
      {/* Scrollable history — the build conversation stays primary and clean (like Google AI
          Studio); the noisy build internals collapse into a single on-demand disclosure. */}
      <div ref={chatScrollRef} className="min-h-0 flex-1 overflow-auto p-3 space-y-3">
        {/* The build conversation (your prompts + the agent's outcomes) — the full history.
            Bubbles are interactive: copy any message, or re-send one of your prompts. */}
        <ConversationThread onResend={(text) => void handleGenerate(text)} />
        {/* Build details — collapsed at rest so the chat reads cleanly; auto-opens while building so
            the live file stream, self-heal trace, services, changes and history stay visible. The
            old always-on "Code health" panel was already removed as noise; this finishes the job by
            folding the remaining six stacked panels into one disclosure. */}
        {hasFiles && (
          <div className={`rounded-lg border ${t.edge} ${t.panel} overflow-hidden`}>
            <button
              type="button"
              onClick={() => setDetailsOpen((o) => !o)}
              aria-expanded={detailsOpen}
              className={`flex w-full items-center gap-2 px-3 py-2 ${t.panelAlt} ${t.hover} ${t.focusRing}`}
            >
              <ChevronRight className={`w-3.5 h-3.5 shrink-0 ${t.textFaint} transition-transform ${detailsOpen ? 'rotate-90' : ''}`} />
              <span className={`text-[11px] font-semibold uppercase tracking-wide ${t.textDim}`}>Activity &amp; changes</span>
              {generating && <Loader2 className={`w-3 h-3 animate-spin ${t.accent}`} />}
              {dirtyCount > 0 && (
                <span className={`ml-auto rounded-full ${t.accentSoft} ${t.accent} px-1.5 text-[10px] font-bold`}>{dirtyCount}</span>
              )}
            </button>
            {detailsOpen && (
              <div className={`border-t ${t.edge} p-3 space-y-3`}>
                {/* Live, synchronous activity — files appearing as the AI writes them. Rows jump to file. */}
                <ActivityFeed onOpenFile={openFileInEditor} onRetry={retryLastGenerate} />
                {/* The agentic self-heal build trace (plan → run → observe → fix). */}
                <BuildTrace />
                {/* What backends/connections the AI's code expects + a one-click .env scaffold. */}
                <ServicesPanel
                  files={currentArtifact.files}
                  hasEnvExample={wsPaths.includes('/.env.example')}
                  onAddEnvExample={addEnvExample}
                  onConnect={() => onNavigate('settings')}
                />
                {/* Bring-your-own backend: wire a real Supabase DB into the app (env + typed client). */}
                <BackendPanel
                  projectId={wsProjectId}
                  onConnect={(injected) => {
                    const ws = useStudioWorkspace.getState();
                    injected.forEach((f) => ws.addFile(f.path, f.content));
                    // Ensure the scaffolded client's dependency resolves (else the preview breaks).
                    const pkg = currentArtifact.files.find((f) => f.path === '/package.json');
                    if (pkg) {
                      const patched = ensureSupabaseDependency(pkg.content);
                      if (patched !== pkg.content) ws.addFile('/package.json', patched);
                    }
                    appendLog('success', 'Connected Supabase — added /.env.local + /lib/supabaseClient.ts (and @supabase/supabase-js). Refine to read/write your data.');
                    if (focus === 'preview') setFocus('code');
                  }}
                />
                <ChangesPanel />
                <HistoryPanel />
              </div>
            )}
          </div>
        )}
      </div>
      {/* Pinned composer — iterate by prompt, refining the current app in place (no chat hand-off). */}
      <div className={`shrink-0 border-t ${t.edge} ${t.panelAlt} p-3 space-y-2`}>
        {/* Real, app-specific "what to build next" recommendations — replaces the hardcoded chips. */}
        {hasFiles && (
          <SuggestionsPanel
            files={currentArtifact.files}
            title={wsTitle}
            fallback={fallbackSuggestions}
            busy={generating || gateLoading}
            onPick={(p) => void handleGenerate(p)}
          />
        )}
        {/* Conversational refine — the agent asks a couple of sharp questions before a big change. */}
        {iterateGate && (
          <ClarifyPanel
            questions={iterateGate.clarify.questions}
            assumptions={iterateGate.clarify.assumptions}
            onSubmit={submitIterateAnswers}
            onSkip={skipIterateGate}
            busy={generating}
          />
        )}
        <PromptComposer mode="inline" onSubmit={onComposerSubmit} onCancel={cancelGenerate} busy={generating || gateLoading} error={genError} />
        <div className="flex items-center justify-between gap-2">
          <button
            onClick={toggleAskBeforeBuild}
            title={askBeforeBuild
              ? 'The agent may ask a quick question before a big change, then build. Click to turn off.'
              : 'The agent builds your changes immediately. Click to let it ask a question first when useful.'}
            className={`inline-flex items-center gap-1.5 text-[11px] font-medium ${t.textDim} ${t.hover} rounded-full px-2 py-1 ${t.focusRing}`}
          >
            <MessageSquarePlus className="w-3.5 h-3.5" />
            {askBeforeBuild ? 'Asks before big changes' : 'Builds immediately'}
          </button>
          {/* No "Review with agents" button — the specialist team now reviews EVERY build by
              default (a baked-in pipeline stage, not an opt-in). An explicit re-run is still in the
              command palette (⌘K → "Refine with agent team") for when you want another pass. */}
          {gateLoading && (
            <span className={`inline-flex items-center gap-1.5 text-[11px] ${t.textFaint}`}>
              <Loader2 className="w-3 h-3 animate-spin" /> Thinking…
            </span>
          )}
        </div>
      </div>
    </section>
  );

  const codePane = (
    <PaneFrame title="Code" icon={<FileCode className="w-4 h-4" />} actions={<FocusToggle labels />}>
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
    <PaneFrame
      title="Live preview"
      icon={<Cloud className="w-4 h-4" />}
      className={previewFull ? 'fixed inset-0 z-[60] rounded-none' : ''}
      actions={
        <>
          <FocusToggle labels className="mr-1" />
          {screenRecordingSupported() && (
            <button
              onClick={() => void togglePreviewRecording()}
              title={recording ? 'Stop recording' : 'Record preview to video'}
              className={`rounded p-1 ${t.hover} ${recording ? 'text-rose-400' : t.textFaint}`}
            >
              {recording ? <Square className="w-3.5 h-3.5" /> : <Video className="w-3.5 h-3.5" />}
            </button>
          )}
          <button
            onClick={() => setPreviewFull((v) => !v)}
            title={previewFull ? 'Exit fullscreen' : 'Fullscreen preview'}
            className={`rounded p-1 ${t.hover} ${t.textFaint}`}
          >
            {previewFull ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
          </button>
        </>
      }
    >
      {/* Calm, rolling live-progress strip — REPLACES the old flashing auto-fix / ⚠ error banners.
          While working it shows the real, rolling status; once work stops with an unresolved error it
          shows a single calm "couldn't fully resolve — Fix with AI" notice (no strobing). */}
      {hasFiles && (
        <LiveProgress
          variant="strip"
          phase={progressPhase}
          active={progressActive}
          error={!previewUrl ? previewError : null}
          onFix={previewError ? () => handleAutofix(previewError, true) : undefined}
        />
      )}
      {previewUrl ? (
        <PreviewFrame url={previewUrl} />
      ) : hasFiles && isWebProject(projectKind) ? (
        // Instant in-browser preview — works without the live worker. A live cloud Build
        // supersedes this with a real container URL when enabled. onError drives autodebug.
        <Suspense fallback={<div className="p-3"><Skeleton className="h-full min-h-[12rem] w-full" /></div>}>
          <CodeStudioPanel data={currentArtifact} editorHeight={460} previewOnly onError={onPreviewError} />
        </Suspense>
      ) : hasFiles ? (
        // Non-web project (Python/Go/…) — the browser can't run it. Be honest + helpful.
        <div className="h-full min-h-[14rem] flex flex-col items-center justify-center gap-3 p-6 text-center">
          <div className={`h-16 w-16 rounded-2xl border ${t.edge} ${t.panelAlt} flex items-center justify-center`}>
            <FileCode className={`w-7 h-7 ${t.accent}`} />
          </div>
          <p className={`text-sm font-semibold ${t.text}`}>{projectKindLabel(projectKind)} project</p>
          <p className={`text-xs ${t.textDim} max-w-xs`}>
            This isn't a browser app, so there's no in-page preview. Run it locally (see the README),
            download the project, or run it live in a cloud container.
          </p>
          {runHint(projectKind) && (
            <code className={`max-w-full overflow-auto rounded-md border ${t.edge} ${t.panelAlt} px-2.5 py-1.5 font-mono text-[11px] ${t.textDim}`}>
              $ {runHint(projectKind)}
            </code>
          )}
          <button
            onClick={() => void downloadArtifactZip(currentArtifact)}
            className={`inline-flex items-center gap-1.5 text-xs font-bold rounded-full border ${t.edgeStrong} px-3 py-1.5 ${t.text} ${t.hover} ${t.focusRing}`}
          >
            <Download className="w-3.5 h-3.5" /> Download .zip
          </button>
        </div>
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

  // Console/logs dock — lives to the RIGHT, below the preview, and quick-collapses to a slim bar.
  const logsDock = (
    <div className={`flex h-full w-full overflow-hidden rounded-lg border ${t.edge}`}>
      <LogsConsole onCollapse={() => setLogsOpen(false)} />
    </div>
  );
  const collapsedLogsBar = (
    <button
      onClick={() => setLogsOpen(true)}
      title="Show console"
      aria-label="Show console"
      className={`flex w-full shrink-0 items-center gap-2 rounded-lg border ${t.edge} ${t.panelAlt} px-3 py-1.5 ${t.hover} ${t.focusRing}`}
    >
      <Terminal className={`w-3.5 h-3.5 ${t.accent}`} />
      <span className={`text-[11px] font-semibold uppercase tracking-wide ${t.textDim}`}>Console · Logs</span>
      <span className={`text-[10px] ${t.textFaint}`}>{logCount}</span>
      <ChevronUp className={`ml-auto w-3.5 h-3.5 ${t.textFaint}`} />
    </button>
  );
  // Stack a primary pane (the preview, or code when preview is hidden) over the collapsible console.
  const withLogsDock = (mainPane: React.ReactNode, splitKey: string) =>
    logsOpen ? (
      <ResizableSplit direction="vertical" storageKey={splitKey} initial={[3, 1]} minPx={90}>
        {mainPane}
        {logsDock}
      </ResizableSplit>
    ) : (
      <div className="flex h-full min-h-0 w-full flex-col gap-2">
        <div className="flex min-h-0 flex-1">{mainPane}</div>
        {collapsedLogsBar}
      </div>
    );

  return (
    <div className={`relative overflow-hidden min-h-screen h-screen ${t.bg} ${t.text} flex flex-col`}>
      <StudioAurora className="-z-10" />
      {celebrate && <Confetti onDone={() => setCelebrate(false)} />}
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} commands={commands} />
      <ShortcutsHelp open={helpOpen} onClose={() => setHelpOpen(false)} />
      <PublishPanel
        open={publishOpen}
        onClose={() => setPublishOpen(false)}
        title={wsTitle}
        previewUrl={previewUrl}
        projectId={wsProjectId}
        deployedUrl={deployUrl}
        onDownloadZip={() => void downloadArtifactZip(currentArtifact)}
        onDeploy={handleDeploy}
      />
      {settingsOpen && (
        <Suspense fallback={null}>
          <StudioSettingsPanel open={settingsOpen} onClose={() => setSettingsOpen(false)} />
        </Suspense>
      )}
      {/* Top bar */}
      <Reveal distance={-8}>
        <div className={`flex items-center gap-3 px-4 h-14 border-b ${t.edge} ${t.panelAlt}`}>
          {/* Back is contextual: with a project open it returns to the studio's project list
              (so you can pick another); from the list it exits the studio. */}
          <button
            onClick={hasFiles ? newProject : leaveStudio}
            title={hasFiles ? 'Back to your projects' : 'Leave Code Studio'}
            className={`flex items-center gap-1.5 text-sm font-semibold ${t.textDim} ${t.hover} transition-colors ${t.focusRing} rounded-md px-1.5 py-1`}
          >
            <ArrowLeft className="w-4 h-4" /> {hasFiles ? 'Projects' : 'Back'}
          </button>
          <div className={`h-5 w-px ${t.edge} border-l`} />
          <div className="flex items-center gap-2 min-w-0">
            <span className={`font-display text-lg tracking-wide ${t.text} truncate`}>{projectName}</span>
            <button
              onClick={() => setSettingsOpen(true)}
              title={studioModel.mode === 'specific' && studioModel.model
                ? `Code Studio coding model: ${studioModel.model}. Click to change (independent of comics & chat).`
                : hasByok
                  ? 'Code Studio auto-picks a strong coder using your OpenRouter key (BYOK). Click to customize.'
                  : 'Code Studio auto-picks a strong open coder — free. Click to pin a model, source & build options.'}
              className={`hidden sm:inline-flex items-center gap-1 text-[11px] font-semibold rounded-full border ${t.edge} px-2 py-0.5 ${t.textDim} ${t.hover} ${t.focusRing}`}
            >
              <Cpu className="w-3 h-3" /> coding · {studioModel.mode === 'specific' && studioModel.model
                ? studioModel.model.split('/').pop()!.replace(/:free$/i, '')
                : (hasByok ? 'auto · your key' : 'auto · free')}
            </button>
            {dirtyCount > 0 && (
              <span className="hidden sm:inline-flex items-center gap-1 text-[11px] font-semibold text-amber-500" title="Unsaved edits in the working copy">
                ● {dirtyCount} unsaved
              </span>
            )}
            {/* Identity (project/session ids), theme, shortcuts help and the view toggle moved out
                of the header chrome and into the ⌘K palette — the AI-Studio bar keeps only what a
                user reaches for constantly: Back · Title · model · status · Share · download. */}
          </div>

          <div className="ml-auto flex items-center gap-2">
            <button
              onClick={() => setPaletteOpen(true)}
              title="Command palette (⌘K) — everything else lives here: themes, shortcuts, exports, IDs"
              className={`hidden md:inline-flex items-center gap-1 text-[11px] font-semibold rounded-full border ${t.edge} px-2 py-1 ${t.textDim} ${t.hover} ${t.focusRing}`}
            >
              <CommandIcon className="w-3 h-3" /> K
            </button>
            <StudioModeBadge liveConfigured={liveConfigured} className="hidden sm:block mr-1" />
            <StatusPulse status={status} className="mr-1" />
            {/* No top "Build" button — building happens through the prompt/chat. A live cloud run
                (when enabled) is available via ⌘K → "Build & run". Stop appears only while live. */}
            {status === 'live' && (
              <button
                onClick={stopLive}
                className={`flex items-center gap-1.5 text-sm font-bold rounded-full border ${t.edgeStrong} px-3 py-1.5 text-rose-500 ${t.hover} ${t.focusRing}`}
              >
                <Square className="w-3.5 h-3.5" /> Stop
              </button>
            )}
            {deployUrl && (
              <a
                href={deployUrl}
                target="_blank"
                rel="noreferrer"
                title={`Deployed — open the live app\n${deployUrl}`}
                className={`hidden lg:inline-flex items-center gap-1.5 text-xs font-bold rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2.5 py-1 text-emerald-500 hover:bg-emerald-500/20 ${t.focusRing}`}
              >
                <Cloud className="w-3.5 h-3.5" /> Live
              </a>
            )}
            {hasFiles && (
              <button
                onClick={() => setPublishOpen(true)}
                title="Publish & share — live link, deploy bundle, and one-click deploy to Cloudflare / Vercel / Supabase"
                className={`hidden md:flex items-center gap-1.5 text-sm font-semibold rounded-full border ${t.edge} px-3 py-1.5 ${t.textDim} ${t.hover} ${t.focusRing}`}
              >
                <Share2 className="w-3.5 h-3.5" /> Share
              </button>
            )}
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

      {/* The old "context bar" (model · runtime · agents · context% · status) was removed — it was
          a permanent second toolbar of internals. That info still lives one click away: the project
          title opens Settings (coding model · runtime · agents), and ⌘K surfaces the rest. */}

      {error && (
        <div className="px-4 py-2 text-xs font-semibold text-rose-500 bg-rose-500/10 border-b border-rose-500/20">
          {error}
        </div>
      )}

      {/* Instant-preview notice — shown only when the live agentic build truly isn't available.
          Framed as what the user HAS (an instant in-browser preview), not an apology for what's
          gated; cloud runs are a quiet upgrade, not a lock on the door. */}
      {!liveAvailable && (
        <div className={`px-4 py-2 text-xs border-b ${t.edge} ${t.panelAlt} flex flex-wrap items-center gap-2`}>
          <Sparkles className={`w-3.5 h-3.5 ${t.accent}`} />
          <span className={`${t.text} font-semibold`}>Instant preview</span>
          <span className={t.textDim}>— your app runs right here in the browser. One-click cloud runs &amp; sharing are rolling out.</span>
          <button
            onClick={() => onNavigate('home')}
            className={`ml-auto inline-flex items-center gap-1.5 text-[11px] font-bold rounded-full border ${t.edge} px-2.5 py-0.5 ${t.accent} ${t.hover} ${t.focusRing}`}
          >
            <Mail className="w-3 h-3" /> Get notified
          </button>
        </div>
      )}

      {/* No app loaded → either the engineering-team build flow (when active) or the projects
          start screen. The flow gates the workspace/preview until there's a real, built app. */}
      {!hasFiles ? (
        flow.phase !== 'idle' ? (
          <StudioBuildFlow
            state={flow}
            onSubmitAnswers={submitAnswers}
            onSkipQuestions={skipQuestions}
            onBuild={buildFromPlan}
            onRegeneratePlan={regeneratePlan}
            onBack={resetFlow}
            onRetry={retryFlow}
            busy={generating}
          />
        ) : (
          <StudioStart
            onNavigate={onNavigate}
            onGenerate={startNewApp}
            onCancelGenerate={cancelGenerate}
            onRetryGenerate={retryLastGenerate}
            generating={generating}
            genError={genError}
            template={template}
            onTemplateChange={setTemplate}
          />
        )
      ) : wide ? (
        // 30/70 two-pane workspace: a full-height chat on the LEFT (~30%) and ONE workspace pane on
        // the RIGHT (~70%) that toggles between the live Preview and the Code editor — no third column.
        // The console docks under the right pane (collapsible). The 3/7 weights are the 30/70 default;
        // the gutter is draggable and the chosen ratio persists.
        <div className="flex-1 min-h-0 p-3">
          <ResizableSplit direction="horizontal" storageKey="studio.split.main" initial={[3, 7]} minPx={300}>
            {promptPane}
            {withLogsDock(focus === 'code' ? codePane : previewPane, 'studio.split.dock')}
          </ResizableSplit>
        </div>
      ) : (
        // Stacked on small screens: chat, then the toggled workspace pane, then the console.
        <div className="flex-1 min-h-0 overflow-auto flex flex-col gap-3 p-3">
          <div className="min-h-[18rem] flex">{promptPane}</div>
          <div className="min-h-[22rem] flex">{focus === 'code' ? codePane : previewPane}</div>
          {logsOpen ? <div className="min-h-[12rem] flex">{logsDock}</div> : collapsedLogsBar}
        </div>
      )}
    </div>
  );
};
