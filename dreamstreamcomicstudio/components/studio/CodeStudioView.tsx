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
  Columns, Eye, FilePlus, Users, Maximize2, Minimize2,
} from 'lucide-react';
import type { CodeStudioArtifact, CodeStudioTemplate, StudioBuildPlan, StudioAnswer } from '../../apiTypes';
import {
  Reveal, Skeleton, StatusPulse, ThemeSwitcher, FocusToggle, ResizableSplit, Confetti, CommandPalette, ShortcutsHelp,
  StudioAurora, useIsWide, useStudioTheme, useStudioThemeStore, useStudioFocus,
} from './kit';
import type { RunStatus, Command } from './kit';
import {
  CodeWorkspace, LogsConsole, PreviewFrame, BuildTrace, ChangesPanel, HistoryPanel, PromptComposer,
  ConversationThread, ActivityFeed, ServicesPanel, useStudioConversation, useStudioActivity, useStudioBuild,
  useStudioWorkspace, useStudioLogs, isPathDirty, workspaceCurrentArtifact,
  detectProjectKind, projectKindLabel, isWebProject, runHint, diffLines, diffStat,
} from './workspace';
import { StudioStart } from './StudioStart';
import { StudioBuildFlow, type StudioFlowState } from './StudioBuildFlow';
import { clarifyStudioApp, planStudioApp } from '../../services/studioPlanApi';
import { saveStudioChat, loadStudioChat } from '../../services/studioChatHistory';
import { getStudioModelSelection, getStudioAgents, getStudioAutoRunAgents, getStudioRuntime, STUDIO_MODEL_CHANGED } from '../../services/studioModelSelection';
import { stopLiveStudio } from '../../services/studioApi';
import { generateStudioApp, streamGenerateStudioApp } from '../../services/studioGenerateApi';
import { streamStudioBuild, type BuildStage } from '../../services/studioBuildApi';
import { streamStudioAgents } from '../../services/studioAgentsApi';
import { resolveStudioAgentIds, studioAgentName } from '../../services/studioAgents';
import { createStudioSession } from '../../services/studioSessions';
import { getOpenRouterKey } from '../../services/appSettings';
import { isProviderEnabled } from '../../services/sourceGovernance';
import { isLiveStudioEnabled } from '../../services/studioFlags';
import { downloadArtifactZip } from '../../services/studioLauncher';

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

// One-click refine prompts (Lovable-style "what next") shown under the iterate composer.
const QUICK_ACTIONS: { label: string; prompt: string }[] = [
  { label: '✨ Polish UI', prompt: 'Polish the visual design — spacing, typography, colors, and overall aesthetics. Keep all behavior.' },
  { label: '🌙 Dark mode', prompt: 'Add a dark mode toggle and make the styling adapt to it.' },
  { label: '📱 Responsive', prompt: 'Make the layout fully responsive and great on mobile.' },
  { label: '🎬 Animations', prompt: 'Add tasteful, smooth animations and transitions.' },
  { label: '🧪 Sample data', prompt: 'Pre-fill the app with realistic sample data so it looks alive on first load.' },
];

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

  // Load the handed-off app into the editor workspace.
  useEffect(() => {
    if (artifact) loadArtifact(artifact);
  }, [artifact, loadArtifact]);

  // Fresh build conversation + activity per studio entry (don't inherit a stale thread/feed).
  useEffect(() => {
    useStudioConversation.getState().clear();
    useStudioActivity.getState().reset();
  }, []);

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
  // undefined = "Auto" — the AI picks the best stack from the prompt (no forced choice).
  // Seed from the studio's saved default scaffold (Settings) when the user set one.
  const [template, setTemplate] = useState<CodeStudioTemplate | undefined>(
    () => (getStudioModelSelection().defaultTemplate as CodeStudioTemplate | null) ?? undefined
  );
  const [previewError, setPreviewError] = useState<string | null>(null);
  // True while the AI is auto-fixing a preview error — drives a CALM loading bar instead of the
  // old red banner that flashed on/off through each repair cycle.
  const [autofixing, setAutofixing] = useState(false);
  // Fullscreen the live preview (covers the studio) when the user wants maximum real estate.
  const [previewFull, setPreviewFull] = useState(false);
  // Debounce preview errors: the in-browser preview reports transient compile/HMR blips while a
  // refine streams in, which made the error banner flash. Only surface an error that *persists*
  // (~1.2s); clear it immediately on recovery. Stable identity so the watcher effect is steady.
  const previewErrTimer = useRef<number | null>(null);
  // Autonomous autofix: when a persistent preview error appears (and nothing else is building),
  // the AI fixes it automatically — no "Fix with AI" click needed — up to a small budget per app.
  const MAX_AUTOFIX = 4;
  const autofixCountRef = useRef(0);
  const autofixRef = useRef<(msg: string) => void>(() => {});
  const generatingRef = useRef(false);
  const onPreviewError = useCallback((e: string | null) => {
    if (previewErrTimer.current) { clearTimeout(previewErrTimer.current); previewErrTimer.current = null; }
    if (!e) { setPreviewError(null); setAutofixing(false); autofixCountRef.current = 0; return; }
    previewErrTimer.current = window.setTimeout(() => {
      setPreviewError(e);
      if (!generatingRef.current && autofixCountRef.current < MAX_AUTOFIX) {
        autofixCountRef.current += 1;
        setAutofixing(true); // calm "auto-fixing…" state, not a flashing error
        autofixRef.current(e);
      } else {
        setAutofixing(false); // already building, or budget exhausted → surface a clickable error
      }
    }, 1200);
  }, []);

  // Keep a ref of `generating` so the (stable-identity) preview-error callback can gate autofix.
  useEffect(() => { generatingRef.current = generating; }, [generating]);

  // Pause the live sandbox when the user leaves the studio (unmount) — never leave a container
  // running (and billing) after they navigate away. Mirror runId so the cleanup isn't stale.
  useEffect(() => { runIdRef.current = runId; }, [runId]);
  useEffect(() => () => { const id = runIdRef.current; if (id) void stopLiveStudio(id).catch(() => {}); }, []);

  // One chat per build: persist this project's conversation, and restore it when a project opens.
  const convoMessages = useStudioConversation((s) => s.messages);
  useEffect(() => {
    if (wsProjectId && convoMessages.length) saveStudioChat(wsProjectId, convoMessages);
  }, [convoMessages, wsProjectId]);
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
    opts?: { plan?: StudioBuildPlan; answers?: StudioAnswer[]; autoReview?: boolean }
  ): Promise<{ ok: boolean; error?: string }> => {
    if (generating) return { ok: false, error: 'busy' };
    lastGenRef.current = { prompt, tmpl };
    const refining = hasFiles;
    if (!refining) autofixCountRef.current = 0; // fresh autofix budget per new app
    setGenerating(true);
    setGenError(null);
    setPreviewError(null);
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

    const input = {
      prompt,
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
      // The agent team reviews a brand-new app (always for the build flow; opt-in otherwise).
      if (!refining && enabled && (opts?.autoReview || getStudioAutoRunAgents())) {
        appendLog('system', 'The agent team is reviewing your new app…');
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
      if (signal.aborted) cancelled();
      else failWith((err as Error)?.message || 'Generation failed.');
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
    setPreviewError(null);
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
      setFlow((f) => ({ ...f, phase: 'error', error: (err as Error)?.message || 'Could not draft a build plan.' }));
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

  const buildFromPlan = async () => {
    if (!flow.plan) return;
    setFlow((f) => ({ ...f, phase: 'building' }));
    // Opt-in deep agent review; otherwise the worker self-heal loop (below) is the primary "run".
    const autoReview = getStudioAutoRunAgents();
    const res = await handleGenerate(flow.prompt, flowTmplRef.current, { plan: flow.plan, answers: flow.answers, autoReview });
    if (res.ok || res.error === 'cancelled') {
      setFlow({ phase: 'idle', prompt: '', answers: [] });
      // Run it in the REAL sandbox (cloud worker, self-healing). Soft-falls back to the in-browser
      // preview when the worker isn't available. Skipped if the agent review is already running.
      if (res.ok && enabled && getStudioRuntime() !== 'browser' && !autoReview) {
        setTimeout(() => runBuildRef.current(), 150);
      }
    } else {
      setFlow((f) => ({ ...f, phase: 'error', error: res.error || 'Build failed.' }));
    }
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
    setError(null); setGenError(null); setPreviewError(null);
  };

  // Leave Code Studio entirely — pause any live sandbox first.
  const leaveStudio = () => {
    if (runId) void stopLiveStudio(runId).catch(() => {});
    onBack();
  };

  // Jump from an activity-feed file row straight into the editor (and reveal the Code pane).
  const openFileInEditor = (path: string) => {
    useStudioWorkspace.getState().openFile(path);
    if (focus === 'preview') setFocus('split');
  };

  // Scaffold /.env.example with the env vars the AI's code references (Services panel).
  const addEnvExample = (content: string) => {
    useStudioWorkspace.getState().addFile('/.env.example', content);
    if (focus === 'preview') setFocus('split');
    appendLog('success', 'Added /.env.example with the variables this app expects.');
  };

  // Autodebug: feed the preview's error back to the model as a refine ("fix this"). Runs both on
  // the manual button and automatically (autofixRef) when the preview keeps erroring.
  const handleAutofix = (errorMsg: string, manual = false) => {
    if (!errorMsg || generating) return;
    if (manual) { autofixCountRef.current = 0; setAutofixing(true); } // manual retry resets the budget
    appendLog('warn', `Auto-fixing the preview error… (attempt ${autofixCountRef.current || 1}/${MAX_AUTOFIX})`);
    void handleGenerate(`The live preview shows this error — find the ROOT CAUSE and fix it so the app runs cleanly. Return the full corrected files; do not reintroduce the error:\n\n${errorMsg}`);
  };
  autofixRef.current = handleAutofix;

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
  if (hasFiles) {
    commands.push({ id: 'focus-code', label: 'Focus: Code', icon: <FileCode className="w-4 h-4" />, keywords: 'layout maximize editor review code real estate', run: () => setFocus('code') });
    commands.push({ id: 'focus-split', label: 'Focus: Split', icon: <Columns className="w-4 h-4" />, keywords: 'layout three pane default code preview', run: () => setFocus('split') });
    commands.push({ id: 'focus-preview', label: 'Focus: Preview', icon: <Eye className="w-4 h-4" />, keywords: 'layout maximize preview review running app real estate', run: () => setFocus('preview') });
  }
  if (hasFiles) commands.push({ id: 'new', label: 'New project', icon: <FilePlus className="w-4 h-4" />, keywords: 'new reset start over fresh blank clear', run: newProject });
  commands.push({ id: 'chat', label: 'Build from chat', icon: <MessageSquarePlus className="w-4 h-4" />, keywords: 'new prompt generate describe', run: () => onNavigate('chat') });
  if (hasFiles) commands.push({ id: 'agents', label: 'Refine with agent team', icon: <Users className="w-4 h-4" />, keywords: 'agents multi specialist architecture security verification data design refine improve review team', run: runAgents });
  commands.push({ id: 'studio-settings', label: 'Code Studio settings (coding model & agents)', icon: <Cpu className="w-4 h-4" />, keywords: 'model coding source openrouter nvidia settings configure preferences creativity iterations agents', run: () => setSettingsOpen(true) });
  commands.push({ id: 'help', label: 'Keyboard shortcuts', icon: <CommandIcon className="w-4 h-4" />, keywords: 'keys help cheatsheet', run: () => setHelpOpen(true) });
  commands.push({ id: 'back', label: 'Back', icon: <ArrowLeft className="w-4 h-4" />, keywords: 'exit leave close', run: leaveStudio });

  const projectName = wsTitle || 'Untitled project';
  // Build model tier: BYOK (your OpenRouter key → frontier models) vs. free-first auto.
  const hasByok = isProviderEnabled('openrouter') && !!getOpenRouterKey();

  // Context bar labels (model · runtime · agents · status) — all from the live studio selection.
  const ctxModel = studioModel.mode === 'specific' && studioModel.model
    ? studioModel.model.split('/').pop()!.replace(/:free$/i, '')
    : (hasByok ? 'auto · your key' : 'auto · free');
  const ctxRuntime = { auto: 'Auto runtime', worker: 'Cloud worker', browser: 'In-browser' }[studioModel.runtime ?? 'auto'];
  const ctxAgents = resolveStudioAgentIds(studioModel.agents ?? null).length;
  const ctxStatus = generating ? 'working…' : status === 'live' ? 'live' : status === 'starting' ? 'starting…' : status === 'error' ? 'error' : 'ready';

  // ---- Panes (defined once, placed into the resizable or stacked layout) ----
  const promptPane = (
    <PaneFrame title="Prompt · Build" icon={<Sparkles className="w-4 h-4" />}>
      <div className="p-3 space-y-3">
        {/* The build conversation (your prompts + the agent's outcomes). */}
        <ConversationThread />
        {/* Live, synchronous activity — files appearing as the AI writes them (Sprint 1).
            Rows are clickable: jump straight to the file in the editor. */}
        <ActivityFeed onOpenFile={openFileInEditor} onRetry={retryLastGenerate} />
        {/* Iterate by prompt — refines the current app in place (no chat hand-off). */}
        <PromptComposer mode="inline" onSubmit={handleGenerate} onCancel={cancelGenerate} busy={generating} error={genError} />
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
        {/* The manual "Refine with agent team" button was removed: quality work now runs
            automatically (strong model + the server's completeness self-review + auto error-fix).
            The full specialist team is still available via the command palette when wanted. */}
        <BuildTrace />
        {/* What backends/connections the AI's code expects + a one-click .env scaffold (S4.1). */}
        <ServicesPanel
          files={currentArtifact.files}
          hasEnvExample={wsPaths.includes('/.env.example')}
          onAddEnvExample={addEnvExample}
          onConnect={() => onNavigate('settings')}
        />
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
    <PaneFrame
      title="Live preview"
      icon={<Cloud className="w-4 h-4" />}
      className={previewFull ? 'fixed inset-0 z-[60] rounded-none' : ''}
      actions={
        <button
          onClick={() => setPreviewFull((v) => !v)}
          title={previewFull ? 'Exit fullscreen' : 'Fullscreen preview'}
          className={`rounded p-1 ${t.hover} ${t.textFaint}`}
        >
          {previewFull ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
        </button>
      }
    >
      {/* Calm "auto-fixing" bar while the AI repairs preview/console errors automatically — replaces
          the old red banner that flashed on/off each repair cycle. */}
      {hasFiles && !previewUrl && (autofixing || (generating && previewError)) && (
        <div className="flex items-center gap-2 px-3 py-2 border-b border-violet-500/20 bg-violet-500/10 text-xs">
          <Loader2 className="w-3.5 h-3.5 shrink-0 animate-spin text-violet-400" />
          <span className="min-w-0 flex-1 text-violet-200/90">Auto-fixing errors so it runs cleanly…</span>
        </div>
      )}
      {/* Only a PERSISTENT, clickable error once auto-fix is exhausted (no flashing, easy to hit). */}
      {previewError && hasFiles && !previewUrl && !generating && !autofixing && (
        <div className="flex items-start gap-2 px-3 py-2 border-b border-rose-500/20 bg-rose-500/10 text-xs">
          <span className="mt-0.5 shrink-0 font-semibold text-rose-400">⚠ Error</span>
          <span className="min-w-0 flex-1 truncate text-rose-200/90" title={previewError}>{previewError}</span>
          <button
            onClick={() => handleAutofix(previewError, true)}
            className="shrink-0 inline-flex items-center gap-1 rounded-full bg-violet-500 px-2.5 py-1 text-[11px] font-bold text-white hover:bg-violet-400"
          >
            <Wand2 className="w-3 h-3" /> Fix with AI
          </button>
        </div>
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
            {hasFiles && <FocusToggle className="hidden lg:inline-flex" />}
            <ThemeSwitcher className="hidden sm:inline-flex" />
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

      {/* Context bar — at-a-glance: which model, runtime, agent team and build status are in play. */}
      {hasFiles && (
        <button
          onClick={() => setSettingsOpen(true)}
          title="Code Studio context — model · runtime · agents · status. Click to change in Settings."
          className={`flex items-center gap-2 px-4 py-1 border-b ${t.edge} ${t.panelAlt} text-[11px] ${t.textDim} ${t.hover} ${t.focusRing} overflow-x-auto whitespace-nowrap`}
        >
          <span className="inline-flex items-center gap-1"><Cpu className="w-3 h-3" /> {ctxModel}</span>
          <span className={t.textFaint}>·</span>
          <span className="inline-flex items-center gap-1"><Cloud className="w-3 h-3" /> {ctxRuntime}</span>
          <span className={t.textFaint}>·</span>
          <span className="inline-flex items-center gap-1"><Users className="w-3 h-3" /> {ctxAgents} agents</span>
          <span className={t.textFaint}>·</span>
          <span className={`inline-flex items-center gap-1 font-semibold ${status === 'live' ? 'text-emerald-500' : status === 'error' ? 'text-rose-500' : t.textDim}`}>{ctxStatus}</span>
        </button>
      )}

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
        <div className="flex-1 min-h-0 p-3">
          <ResizableSplit direction="vertical" storageKey="studio.split.v" initial={[3.2, 1]} minPx={110}>
            {/* Focus-aware horizontal layout — Code or Preview can take the full pane
                (each focus keeps its own resize state via a distinct storageKey). */}
            {focus === 'code' ? (
              <ResizableSplit direction="horizontal" storageKey="studio.split.h.code.v2" initial={[3.6, 6.4]} minPx={280}>
                {promptPane}
                {codePane}
              </ResizableSplit>
            ) : focus === 'preview' ? (
              <ResizableSplit direction="horizontal" storageKey="studio.split.h.preview.v2" initial={[3.6, 6.4]} minPx={280}>
                {promptPane}
                {previewPane}
              </ResizableSplit>
            ) : (
              <ResizableSplit direction="horizontal" storageKey="studio.split.h.v2" initial={[3.4, 3.1, 3.1]} minPx={260}>
                {promptPane}
                {codePane}
                {previewPane}
              </ResizableSplit>
            )}
            {logsPane}
          </ResizableSplit>
        </div>
      ) : (
        <div className="flex-1 min-h-0 overflow-auto flex flex-col gap-3 p-3">
          <div className="min-h-[15rem] flex">{promptPane}</div>
          {focus !== 'preview' && <div className="min-h-[22rem] flex">{codePane}</div>}
          {focus !== 'code' && <div className="min-h-[18rem] flex">{previewPane}</div>}
          <div className="min-h-[12rem] flex">{logsPane}</div>
        </div>
      )}
    </div>
  );
};
