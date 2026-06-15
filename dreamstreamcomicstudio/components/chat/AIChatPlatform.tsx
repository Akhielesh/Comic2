import React, { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { Code2, ExternalLink, Loader2, Map as MapIcon, Maximize2, Minimize2, PanelLeftClose, PanelLeftOpen, X } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { initTheme } from '../../services/theme';
import { getLockedChatModel, getShowChatModelSelector, onAppSettingsChanged } from '../../services/appSettings';
import { ChatSidebar } from './ChatSidebar';
import { ChatConversation } from './ChatConversation';
import { ChatModelPicker } from './ChatModelPicker';
import { ChatProjectModal } from './ChatProjectModal';
import { ChatSettingsModal } from './ChatSettingsModal';
import { listCustomAgents } from '../../services/chatAgents';
import { ChatPanelContext } from './panelContext';
import { applyAgentStep } from './agentActivity';
import { AllowanceBanner } from './AllowanceBanner';
import { MediaPanel, type MediaPanelData } from './MediaPanel';
import type { PlaygroundData } from './MultiFilePlayground';
import type { ChatArtifact, CodeStudioArtifact, MapArtifact, AgentActivityEvent, AgentActivityArtifact } from '../../apiTypes';
import { CANVAS_BG, SIDEBAR_BG, GLASS, HEADING, INK, ACCENT_TEXT, CONTROL_BTN, TRANSITION } from './studioDesign';
import { persistUiState, resolveInitialUiState } from '../../services/viewState';
import { getAdminAccess } from '../../services/billing';

const MapPanel = lazy(() => import('./MapPanel'));
const MultiFilePlayground = lazy(() => import('./MultiFilePlayground'));
const CodeStudioPanel = lazy(() => import('./CodeStudioPanel'));

// ---------------------------------------------------------------------------
// Studio views (built in parallel — exact prop contracts, see each file).
// `pickExport` tolerates both default and named exports from those modules.
// ---------------------------------------------------------------------------

type StudioView = 'chat' | 'home' | 'library' | 'dashboards' | 'gallery';

interface ChatHomeProps {
  userName?: string;
  sessions: ChatSession[];
  onResume: (sessionId: string) => void;
  onStartChat: (seedText?: string) => void;
  onOpenLibrary: () => void;
  onOpenDashboards: () => void;
}
interface LibraryViewProps {
  sessions: ChatSession[];
  onOpenSource: (sessionId: string) => void;
  onUseInChat: (item: LibraryItem) => void;
  sidebarControl?: React.ReactNode;
}
interface DashboardsViewProps {
  /** Renders the sidebar toggle inside the dashboards top bar (its own header is
   *  hidden for this view to reclaim the vertical space). */
  sidebarControl?: React.ReactNode;
  /** Hand a pasted link / "ask …" from the dashboard bar off to a new chat. */
  onAsk?: (text: string) => void;
}
interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  sessions: ChatSession[];
  onResume: (id: string) => void;
  onNavigate: (view: 'home' | 'library' | 'dashboards') => void;
  onAsk: (text: string) => void;
}

const pickExport = <P,>(m: Record<string, unknown>, name: string): { default: React.ComponentType<P> } => ({
  default: ((m as { default?: unknown }).default ?? m[name]) as React.ComponentType<P>
});

const ChatHome = lazy(() => import('./ChatHome').then((m) => pickExport<ChatHomeProps>(m, 'ChatHome')));
const LibraryView = lazy(() => import('./LibraryView').then((m) => pickExport<LibraryViewProps>(m, 'LibraryView')));
import { FloatingVideoDock } from './FloatingVideoDock';
const DashboardsView = lazy(() => import('./DashboardsView').then((m) => pickExport<DashboardsViewProps>(m, 'DashboardsView')));
const GalleryStudio = lazy(() => import('./GalleryStudio').then((m) => pickExport<{ sidebarControl?: React.ReactNode; onTry?: (prompt: string) => void }>(m, 'GalleryStudio')));
const CommandPalette = lazy(() => import('./CommandPalette').then((m) => pickExport<CommandPaletteProps>(m, 'CommandPalette')));
import { deriveModelFeatures } from '../../services/chatFeatures';
import { getCapabilities } from '../../services/modelCapabilities';
import { fetchModelCatalog, prettyModelLabel, sourceLabel, type CatalogModel } from '../../services/modelCatalog';
import { setActiveModelInfo } from '../../services/activeModelBeacon';
import type { ChatReasoningLevel, ChatRequestMessage, ChatMessagePart, UniversalAssistantContext } from '../../apiTypes';
import type { Project } from '../../types';
import { sendChatMessageStream, runSwarmStream, updateChatMemory, generateChatTitle, friendlyChatError } from '../../services/chatApi';
import { runRecipe } from '../../services/recipes';
import type { LibraryItem } from '../../services/chatLibrary';
import { gatherClientContext } from '../../services/clientContext';
import { toggleConnector, type ChatConnector } from '../../services/chatConnectors';
import { recommendModels, detectTools } from '../../services/chatSuggest';
import { isSourceInScope } from '../../services/sourceGovernance';
import type { ModelSourceId } from '../../services/modelSelection';
import { listAllMcpServers, getMcpServersByIds, onMcpServersChanged } from '../../services/mcpServers';
import { recordToolEvents } from '../../services/toolAnalytics';
import { captureError, captureEvent } from '../../services/telemetry';
import { isLegacyStudioEnabled } from '../../services/studioFlags';
import type { McpServerConfig } from '../../apiTypes';
import {
  branchSession,
  consumePendingChatModel,
  createChatProject,
  createEmptySession,
  deleteChatProject,
  deleteChatSession,
  deriveSessionTitle,
  getChatMemory,
  getLastActiveChatSessionId,
  listChatProjects,
  listChatSessions,
  saveChatProject,
  saveChatSession,
  setChatMemory,
  setLastActiveChatSessionId,
  syncFromCloud,
  wasDeletedThisSession,
  type ChatAttachment,
  type ChatProject,
  type ChatSession,
  type ChatTurn,
  type ChatTurnVariant
} from '../../services/chatStorage';

interface AIChatPlatformProps {
  onBack: () => void;
  /** The user's projects — used to build sanitized DreamStream context when the connector is on. */
  projects: Project[];
}

// Lightweight, read-only DreamStream workspace context. Sent only when the connector
// toggle is on; the server re-sanitizes it through the assistant allowlist.
const buildDreamStreamContext = (projects: Project[]): UniversalAssistantContext => ({
  view: 'chat',
  allProjectsSummary: projects.slice(0, 30).map((p) => ({
    id: p.id,
    name: p.name,
    step: p.state.step,
    scenes: p.state.scenes.length,
    panels: p.state.panels.length,
    updatedAt: p.updatedAt,
    isGenerating: !!p.state.generationStatus?.isActive
  })) as UniversalAssistantContext['allProjectsSummary'],
  appSnapshot: {
    view: 'chat',
    totalProjects: projects.length,
    lastUpdatedProject: projects[0]
      ? { id: projects[0].id, name: projects[0].name, updatedAt: projects[0].updatedAt }
      : undefined
  } as UniversalAssistantContext['appSnapshot']
});

// Decode a base64 data: URL back to its text (UTF-8 safe). Used to inline 'text'
// (pasted-block) attachments into the message so the model reads them.
const decodeTextAttachment = (dataUrl: string): string => {
  try {
    const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
    return decodeURIComponent(escape(atob(b64)));
  } catch {
    return '';
  }
};

const toRequestMessage = (turn: ChatTurn): ChatRequestMessage => {
  const atts = turn.attachments || [];
  // Pasted long-text chips are folded back into the prompt so the model sees every word.
  let text = turn.content || '';
  for (const a of atts) {
    if (a.kind !== 'text') continue;
    const body = decodeTextAttachment(a.dataUrl);
    if (body) text += `${text ? '\n\n' : ''}[Pasted text — ${a.name}]\n"""\n${body}\n"""`;
  }
  // Only true images go to the model as image parts; documents (PDFs/CSVs) are
  // viewer-/tool-only, and 'text' was just inlined above.
  const imageAtts = atts.filter((a) => a.kind === 'image');
  if (imageAtts.length > 0) {
    const parts: ChatMessagePart[] = [];
    if (text) parts.push({ type: 'text', text });
    for (const att of imageAtts) parts.push({ type: 'image_url', image_url: { url: att.dataUrl } });
    return { role: turn.role, content: parts };
  }
  return { role: turn.role, content: text };
};

// Project a stored variant's fields onto the visible assistant turn (used when
// finalizing a new answer and when the user flips between regenerated versions).
const applyVariant = (turn: ChatTurn, v: ChatTurnVariant): ChatTurn => ({
  ...turn,
  content: v.content,
  model: v.model,
  requestedModel: v.requestedModel,
  reasoningLevel: v.reasoningLevel,
  webSearch: v.webSearch,
  reasoning: v.reasoning,
  citations: v.citations,
  toolEvents: v.toolEvents,
  images: v.images,
  artifacts: v.artifacts,
  notices: v.notices,
  durationMs: v.durationMs,
  error: v.error
});

const composeSystemPrompt = (memory: string, persona?: string): string | undefined => {
  const parts: string[] = [];
  if (persona && persona.trim()) parts.push(persona.trim());
  if (memory && memory.trim()) {
    // Inject stored memory WITH a relevance guard. Without this the model forced every
    // stored fact onto every question — e.g. applying a stale "10 years of job-search
    // experience" note to a student's biology question. Memory is background, not a lens.
    parts.push(
      `Background facts about the user (from earlier conversations) — use ONLY when they are clearly relevant to the current question:\n${memory.trim()}\n\n` +
        `Relevance rules: treat these as optional background, never a frame. If a fact does not obviously apply to what the user is asking right now, ignore it — do NOT bend the answer to fit it, and do not assume the user's profile/role/experience unless the current message implies it. If stored facts seem to contradict the current message, trust the current message.`
    );
  }
  return parts.length ? parts.join('\n\n') : undefined;
};

// When a turn ends — finishes, errors, or is STOPPED — any live `swarm_trace` must
// stop showing "working…": settle still-running/pending agents to a terminal state so
// the agent card never spins forever after the answer is done or aborted.
const settleSwarmTrace = <T extends { type: string; data: unknown }>(artifacts?: T[]): T[] | undefined =>
  artifacts?.map((a) => {
    if (a.type !== 'swarm_trace') return a;
    const d = (a.data || {}) as { agents?: { status?: string }[] };
    if (!Array.isArray(d.agents)) return a;
    return {
      ...a,
      data: { ...d, agents: d.agents.map((g) => (g?.status === 'running' || g?.status === 'pending' ? { ...g, status: 'done' } : g)) }
    } as T;
  });

export const AIChatPlatform: React.FC<AIChatPlatformProps> = ({ onBack, projects }) => {
  const { user } = useAuth();
  // Apply the persisted light/dark theme to <html> as soon as the studio mounts,
  // and take it off again when leaving so the rest of the app stays light.
  useEffect(() => {
    initTheme();
    return () => document.documentElement.classList.remove('dark');
  }, []);
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [projectsList, setProjectsList] = useState<ChatProject[]>([]);
  const [projectModal, setProjectModal] = useState<{ editing: ChatProject | null } | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  // Which main view fills the area right of the sidebar. Selecting/creating a chat
  // always lands back on 'chat'; a null active session falls back to 'home'.
  // Continuity: a reload restores the last view (URL ?cview= → session memory),
  // so refreshing on Dashboards no longer bounces the user back to the default.
  const isStudioView = (v: string): v is StudioView => v === 'chat' || v === 'home' || v === 'library' || v === 'dashboards' || v === 'gallery';
  const [view, setView] = useState<StudioView>(() => resolveInitialUiState('chat.view', 'cview', isStudioView, 'chat'));
  useEffect(() => {
    persistUiState('chat.view', 'cview', view === 'chat' ? null : view);
  }, [view]);
  // Admin-only surfaces (Tools, System, Gallery). Default FALSE so non-admins never see
  // these options; confirmed admins get them after /api/admin/me resolves.
  const [isAdmin, setIsAdmin] = useState(false);
  useEffect(() => {
    let alive = true;
    getAdminAccess()
      .then((a) => { if (alive) setIsAdmin(!!a.isAdmin); })
      .catch(() => { /* not an admin / not signed in — stay false */ });
    return () => { alive = false; };
  }, []);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [catalog, setCatalog] = useState<Map<string, CatalogModel>>(new Map());
  // Per-session generation state, so several chats can stream at the same time and a
  // busy chat never blocks (or gets stopped by) another. `busyIds` = sessions whose
  // answer is currently generating.
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  // Sidebar starts open on desktop, closed on phones so the conversation owns the
  // whole screen (on mobile it opens as an overlay drawer, not an inline column).
  const [sidebarOpen, setSidebarOpen] = useState(
    () => typeof window === 'undefined' || window.matchMedia('(min-width: 768px)').matches
  );
  const [showModelPicker, setShowModelPicker] = useState(false);
  // The in-chat model picker can be hidden from Settings (model controlled there instead).
  const [showModelSelector, setShowModelSelector] = useState(() => getShowChatModelSelector());
  useEffect(() => onAppSettingsChanged(() => setShowModelSelector(getShowChatModelSelector())), []);
  const [initialized, setInitialized] = useState(false);
  const [memory, setMemory] = useState('');
  // Text to prefill the composer with (e.g. clicking a skill chip in the empty state).
  const [composerSeed, setComposerSeed] = useState('');
  const [settingsTab, setSettingsTab] = useState<'memory' | 'agents' | 'tools' | 'gallery' | null>(null);
  const [customAgents, setCustomAgents] = useState(() => listCustomAgents());
  const [mcpServers, setMcpServers] = useState<McpServerConfig[]>(() => listAllMcpServers());
  const [panel, setPanel] = useState<ChatArtifact | null>(null);
  const [panelFullscreen, setPanelFullscreen] = useState(false);
  const [panelWidth, setPanelWidth] = useState(440);
  const [isDesktop, setIsDesktop] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(min-width: 768px)').matches
  );
  // One AbortController per in-flight session, so stopping one chat doesn't cancel another.
  const abortMap = useRef<Map<string, AbortController>>(new Map());
  const markBusy = (id: string, on: boolean) =>
    setBusyIds((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  useEffect(() => {
    const mq = window.matchMedia('(min-width: 768px)');
    const onChange = () => setIsDesktop(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  // Live viewport height (URL-bar collapse / rotation / keyboard) so any px-based
  // sizing below follows the REAL viewport instead of a stale innerHeight snapshot —
  // a one-render-old innerHeight is what made the fullscreen code panel jump/overflow
  // on phones when the browser chrome collapsed.
  const [viewportH, setViewportH] = useState(() => (typeof window !== 'undefined' ? window.innerHeight : 800));
  useEffect(() => {
    const onResize = () => setViewportH(window.innerHeight);
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('orientationchange', onResize);
    };
  }, []);

  // Lock body scroll while any overlay (mobile sidebar drawer, modals, mobile/fullscreen
  // side panel) is open — otherwise iOS lets the page behind keep scrolling ("scroll
  // bleed") and the drawer feels glitchy.
  const overlayOpen =
    (sidebarOpen && !isDesktop) ||
    showModelPicker ||
    Boolean(projectModal) ||
    Boolean(settingsTab) ||
    Boolean(panel && (!isDesktop || panelFullscreen));
  useEffect(() => {
    if (!overlayOpen) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prevOverflow;
    };
  }, [overlayOpen]);

  useEffect(() => onMcpServersChanged(() => setMcpServers(listAllMcpServers())), []);

  // ⌘K / Ctrl-K toggles the command palette from anywhere in the studio.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const handleToggleMcpServer = (id: string, on: boolean) => {
    if (!activeId) return;
    updateSession(activeId, (s) => {
      const current = s.mcpServers || [];
      return { ...s, mcpServers: on ? Array.from(new Set([...current, id])) : current.filter((x) => x !== id), updatedAt: Date.now() };
    });
  };

  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = panelWidth;
    const onMove = (ev: MouseEvent) => setPanelWidth(Math.min(760, Math.max(320, startW + (startX - ev.clientX))));
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  // Load catalog (best-effort) for model-feature derivation + display names.
  useEffect(() => {
    let active = true;
    fetchModelCatalog({ modality: 'text' })
      .then((res) => {
        if (!active) return;
        const map = new Map<string, CatalogModel>();
        for (const m of res.models || []) map.set(m.id, m);
        setCatalog(map);
      })
      .catch(() => {
        /* features fall back to safe defaults */
      });
    return () => {
      active = false;
    };
  }, []);

  // Bootstrap sessions + any pending "Chat with this model" handoff from the Library.
  //
  // LOCAL-FIRST: the chat opens from IndexedDB immediately (sub-second) and the user's
  // last-open session is restored; cloud sync runs in the BACKGROUND and merges in any
  // remote sessions when it lands. The old flow blocked the whole screen on cloud sync
  // for up to 6s — that "loads… then resets" feeling on every entry.
  //
  // CRITICAL: this must ALWAYS finish (set `initialized`) within a few seconds, even if
  // IndexedDB hangs/fails — otherwise the render gate below (`!initialized`) strands the
  // user on the loading spinner forever (the long-standing "chat never loads" bug). So
  // every await is time-bounded, writes are fire-and-forget, and a finally block
  // guarantees we open at least an empty local chat.
  useEffect(() => {
    let active = true;
    // Resolve to `fallback` if `p` doesn't settle within `ms` (and never reject).
    const settleWithin = <T,>(p: Promise<T>, ms: number, fallback: T): Promise<T> =>
      Promise.race([p.catch(() => fallback), new Promise<T>((res) => setTimeout(() => res(fallback), ms))]);

    (async () => {
      try {
        const [stored, storedProjects] = await Promise.all([
          settleWithin(listChatSessions(), 4000, [] as ChatSession[]),
          settleWithin(listChatProjects(), 4000, [] as ChatProject[])
        ]);
        if (!active) return;
        setMemory(getChatMemory(user?.id));
        setCustomAgents(listCustomAgents(user?.id));
        setProjectsList(storedProjects);

        const pending = consumePendingChatModel();
        if (pending) {
          const session = createEmptySession({
            modelId: pending.id,
            modelName: pending.name,
            source: pending.source
          });
          void saveChatSession(session).catch(() => {});
          setSessions([session, ...stored]);
          setActiveId(session.id);
        } else if (stored.length > 0) {
          setSessions(stored);
          // Reopen the chat the user was last in (reload/tab-discard continuity);
          // fall back to the most recent session only when that one no longer exists.
          const lastId = getLastActiveChatSessionId();
          const restored = lastId && stored.some((s) => s.id === lastId) ? lastId : stored[0].id;
          setActiveId(restored);
        } else {
          // In-memory placeholder ONLY — deliberately not written to storage/cloud.
          // A new device with cloud history would otherwise mint an empty "New chat"
          // and push it to every other device before sync even ran; an untouched
          // placeholder gets saved on the first real message (updateSession) instead.
          const session = createEmptySession();
          setSessions([session]);
          setActiveId(session.id);
        }
      } catch {
        // Last resort: never strand the user on the spinner — open a fresh local chat.
        if (active) {
          const session = createEmptySession();
          setSessions([session]);
          setActiveId(session.id);
        }
      } finally {
        if (active) setInitialized(true);
      }

      // Background cloud sync (no-op when signed out / table missing): merge remote
      // sessions/projects into the open list without touching the user's active chat.
      try {
        await settleWithin(syncFromCloud().then(() => true), 12_000, false);
        if (!active) return;
        const [mergedRaw, mergedProjects] = await Promise.all([
          settleWithin(listChatSessions(), 4000, null as ChatSession[] | null),
          settleWithin(listChatProjects(), 4000, null as ChatProject[] | null)
        ]);
        if (!active) return;
        const merged = mergedRaw?.filter((s) => !wasDeletedThisSession(s.id)) ?? null;
        if (merged && merged.length > 0) {
          setSessions((prev) => {
            // Never regress what the user can see: keep the in-memory copy when it is at
            // least as new (covers a chat that is streaming right now), keep local-only
            // sessions the user actually USED, and add everything new from the cloud.
            // Untouched placeholders (zero turns) are dropped the moment real history
            // arrives — the invariant-repair effect below moves the user into it.
            const prevById = new Map(prev.map((s) => [s.id, s] as const));
            const mergedIds = new Set(merged.map((s) => s.id));
            const reconciled = merged.map((remote) => {
              const local = prevById.get(remote.id);
              return local && local.updatedAt >= remote.updatedAt ? local : remote;
            });
            const localOnly = prev.filter((s) => !mergedIds.has(s.id) && s.turns.length > 0);
            return [...localOnly, ...reconciled];
          });
        }
        if (mergedProjects && mergedProjects.length > 0) {
          // Union by id — never wipe a project that exists only in memory (e.g. its
          // IndexedDB write failed silently); cloud copies win for shared ids.
          setProjectsList((prev) => {
            const mergedIds = new Set(mergedProjects.map((p) => p.id));
            const localOnly = prev.filter((p) => !mergedIds.has(p.id) && !wasDeletedThisSession(p.id));
            return [...mergedProjects.filter((p) => !wasDeletedThisSession(p.id)), ...localOnly];
          });
        }
      } catch {
        /* cloud sync is best-effort; local chat already works */
      }
    })();
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const activeSession = useMemo(
    () => sessions.find((s) => s.id === activeId) || null,
    [sessions, activeId]
  );
  // Whether the CURRENTLY VIEWED chat is generating (drives the composer/stop UI).
  // Other chats may still be generating in the background.
  const busy = activeId ? busyIds.has(activeId) : false;
  // Latest active id, readable from inside async generation closures (which capture a
  // stale activeId) so a background chat doesn't hijack the shared side panel.
  const activeIdRef = useRef(activeId);
  useEffect(() => {
    activeIdRef.current = activeId;
    // Persist which chat is open so a reload restores it instead of the newest session.
    if (activeId) setLastActiveChatSessionId(activeId);
  }, [activeId]);

  // Invariant repair: the open chat must exist in the list. Covers every path that can
  // remove it (background cloud merge dropping an untouched placeholder, deletes) by
  // moving the user to their last-open session, else the newest one.
  useEffect(() => {
    if (!initialized || sessions.length === 0) return;
    if (activeId && sessions.some((s) => s.id === activeId)) return;
    const lastId = getLastActiveChatSessionId();
    setActiveId(lastId && sessions.some((s) => s.id === lastId) ? lastId : sessions[0].id);
  }, [initialized, sessions, activeId]);

  const resolvedModel = activeSession?.modelId ? catalog.get(activeSession.modelId) || null : null;
  // Publish the chat's REAL model to global chrome (header usage pill) — without this
  // the pill could only show the comic-generation defaults ("Auto") while in chat.
  useEffect(() => {
    const auto = !activeSession || activeSession.autoMode || !activeSession.modelId;
    setActiveModelInfo({
      surface: 'chat',
      label: auto ? 'Auto · best model per message' : resolvedModel?.name || prettyModelLabel(activeSession?.modelId),
      detail: !auto && (resolvedModel?.source || activeSession?.source)
        ? sourceLabel(resolvedModel?.source || activeSession?.source)
        : undefined
    });
    return () => setActiveModelInfo(null);
  }, [activeSession, resolvedModel]);
  const features = useMemo(() => deriveModelFeatures(resolvedModel), [resolvedModel]);
  const suggestModels = useMemo(() => Array.from(catalog.values()), [catalog]);

  const updateSession = (id: string, updater: (s: ChatSession) => ChatSession) => {
    setSessions((prev) => {
      const next = prev.map((s) => (s.id === id ? updater(s) : s));
      const changed = next.find((s) => s.id === id);
      if (changed) void saveChatSession(changed);
      return next;
    });
  };

  const handleNew = () => {
    // BUG FIX: "New chat" used to mint AND persist a fresh empty session on every click,
    // so repeatedly tapping it (or tapping it without ever typing) piled up identical
    // "New chat" rows in the sidebar. Two changes fix that:
    //   1) If an untouched, blank chat already exists, just focus it instead of making
    //      another — clicking "New chat" can never produce more than one empty row.
    //   2) A brand-new chat is an IN-MEMORY placeholder only (not written to storage /
    //      cloud); it gets persisted on the first real message (via updateSession in
    //      handleSend), exactly like the initial seed session. An unused new chat never
    //      clutters the list or syncs to other devices.
    const blank =
      activeSession && activeSession.turns.length === 0
        ? activeSession
        : sessions.find((s) => s.turns.length === 0);
    if (blank) {
      setActiveId(blank.id);
      setView('chat');
      return;
    }
    const base = createEmptySession(
      activeSession
        ? {
            modelId: activeSession.modelId,
            modelName: activeSession.modelName,
            source: activeSession.source,
            reasoningLevel: activeSession.reasoningLevel,
            webSearch: activeSession.webSearch,
            // Preserve the Auto-vs-pinned choice so a new chat behaves like the last.
            autoMode: activeSession.autoMode,
            lockedSource: activeSession.lockedSource,
            tools: [...activeSession.tools],
            // Carry over the user's enabled MCP servers/sources too — losing them on
            // every new chat was why source selections "never stuck".
            mcpServers: [...(activeSession.mcpServers || [])]
          }
        : {}
    );
    setSessions((prev) => [base, ...prev]);
    setActiveId(base.id);
    setView('chat');
  };

  // Start a brand-new chat from Home (optionally with seed text for the composer).
  // The compose event is dispatched a frame later so ChatConversation/ChatComposer
  // have mounted and registered their `dreamstream:compose` listener.
  const handleStartChat = (seedText?: string) => {
    handleNew();
    if (seedText) {
      requestAnimationFrame(() => {
        window.dispatchEvent(new CustomEvent('dreamstream:compose', { detail: { text: seedText } }));
      });
    }
  };

  const handleDelete = (id: string) => {
    // Stop any in-flight generation for the chat being removed.
    abortMap.current.get(id)?.abort();
    abortMap.current.delete(id);
    markBusy(id, false);
    void deleteChatSession(id);
    const next = sessions.filter((s) => s.id !== id);
    if (next.length === 0) {
      const fresh = createEmptySession();
      void saveChatSession(fresh);
      setSessions([fresh]);
      setActiveId(fresh.id);
      return;
    }
    setSessions(next);
    if (activeId === id) setActiveId(next[0].id);
  };

  const handleRename = (id: string, title: string) => {
    // A manual rename locks the title — the AI auto-title must never clobber it.
    updateSession(id, (s) => ({ ...s, title, titleAuto: false, updatedAt: Date.now() }));
  };

  // After the first message, name the chat from what the user is actually trying to do
  // (a concise AI title) instead of the first 48 chars. Fire-and-forget + guarded: it
  // only adopts the result while the title is still auto (a manual rename wins).
  const autoTitleSession = async (sessionId: string, firstMessage: string, source?: ModelSourceId | null) => {
    try {
      const { title } = await generateChatTitle([{ role: 'user', content: firstMessage }], source ?? undefined);
      const next = title.trim();
      if (!next) return;
      updateSession(sessionId, (s) => (s.titleAuto === false ? s : { ...s, title: next, titleAuto: true, updatedAt: Date.now() }));
    } catch {
      /* keep the deterministic fallback title */
    }
  };

  const handleMoveToProject = (sessionId: string, projectId: string | null) => {
    updateSession(sessionId, (s) => ({ ...s, projectId, updatedAt: Date.now() }));
  };

  const handleSaveProject = (name: string, icon: string, color: string) => {
    const editing = projectModal?.editing;
    if (editing) {
      const updated: ChatProject = { ...editing, name, icon, color, updatedAt: Date.now() };
      void saveChatProject(updated);
      setProjectsList((prev) => prev.map((p) => (p.id === updated.id ? updated : p)));
    } else {
      const project = createChatProject(name, icon, color);
      void saveChatProject(project);
      setProjectsList((prev) => [...prev, project]);
    }
    setProjectModal(null);
  };

  const handleDeleteProject = (projectId: string) => {
    void deleteChatProject(projectId);
    setProjectsList((prev) => prev.filter((p) => p.id !== projectId));
    // Reflect the unfiling locally (storage does the same).
    setSessions((prev) => prev.map((s) => (s.projectId === projectId ? { ...s, projectId: null } : s)));
  };

  const handleSelectModel = (model: CatalogModel) => {
    setCatalog((prev) => (prev.has(model.id) ? prev : new Map(prev).set(model.id, model)));
    const supportsReasoning = getCapabilities(model).reasoning;
    if (activeId) {
      updateSession(activeId, (s) => ({
        ...s,
        autoMode: false,
        modelId: model.id,
        modelName: model.name,
        source: model.source,
        webSearch: model.source === 'openrouter' ? s.webSearch : false,
        reasoningLevel: supportsReasoning ? s.reasoningLevel : ('none' as ChatReasoningLevel),
        updatedAt: Date.now()
      }));
    }
    setShowModelPicker(false);
  };

  const handleSelectAuto = (lockedSource: ModelSourceId | null) => {
    if (activeId) {
      updateSession(activeId, (s) => ({
        ...s,
        autoMode: true,
        lockedSource,
        modelId: null,
        modelName: lockedSource ? `Auto · ${sourceLabel(lockedSource)}` : 'Auto',
        source: null,
        updatedAt: Date.now()
      }));
    }
    setShowModelPicker(false);
  };

  // Suggester: set the chosen model on the session and immediately send the goal as
  // the first message (override avoids a state-flush race).
  const handleStartWithModel = (model: CatalogModel, goal: string) => {
    handleSelectModel(model);
    if (goal) void handleSend(goal, [], model);
  };

  const handleBranch = (turnId: string, chooseNewModel: boolean) => {
    if (!activeSession) return;
    const branched = branchSession(activeSession, turnId);
    void saveChatSession(branched);
    setSessions((prev) => [branched, ...prev]);
    setActiveId(branched.id);
    // "Branch + new model" opens the picker on the freshly-branched session.
    if (chooseNewModel) setShowModelPicker(true);
  };

  // Open the full settings panel (Memory / Agents / Tools) on the Memory tab.
  const handleEditMemory = () => setSettingsTab('memory');

  const handleStop = () => {
    if (!activeId) return;
    abortMap.current.get(activeId)?.abort();
    abortMap.current.delete(activeId);
    markBusy(activeId, false);
  };

  // Resolve which model/source/tools to use for a message. In Auto mode the app
  // picks the best model + the right tools per message; otherwise it uses the
  // session's pinned model (or a suggester override).
  const resolveRequest = (
    text: string,
    overrideModel?: CatalogModel
  ): { reqModel?: string; reqSource?: ModelSourceId; reqTools: string[] } => {
    let reqModel = overrideModel ? overrideModel.id : activeSession?.modelId || undefined;
    let reqSource: ModelSourceId | undefined = overrideModel ? overrideModel.source : activeSession?.source || undefined;
    let reqTools = activeSession?.tools || [];
    if (activeSession?.autoMode && !overrideModel) {
      const candidates = Array.from(catalog.values()).filter((m) => {
        if (activeSession.lockedSource && m.source !== activeSession.lockedSource) return false;
        return isSourceInScope(m.source);
      });
      const best = recommendModels(text || 'general question', candidates, 1)[0]?.model;
      if (best) {
        reqModel = best.id;
        reqSource = best.source;
      }
      // Auto-enable the relevant tools, but HONOR the user's explicit connector/tool
      // toggles: auto-detection ADDS tools it thinks are relevant, it never silently
      // discards the ones the user turned on. (Previously Auto mode overwrote the user's
      // selection every message, so the toggles felt ignored / "always auto-enabled".)
      reqTools =
        reqSource === 'nvidia'
          ? []
          : Array.from(new Set([...(activeSession.tools || []), ...detectTools(text)]));
    }
    // A model locked in Settings overrides the session/auto choice (a suggester override
    // still wins). This is what makes "lock the model from settings" actually take effect.
    const locked = getLockedChatModel();
    if (locked && !overrideModel) {
      reqModel = locked.id;
      reqSource = locked.source as ModelSourceId;
    }
    return { reqModel, reqSource, reqTools };
  };

  // Auto-memory: after each exchange, distill durable facts about the user and merge them
  // into their long-term memory in the background (logged-in users only). Runs from the
  // FIRST exchange — the previous "every other, skip the first" throttle meant something the
  // user said up front (name, location, what they're building) wasn't remembered until later.
  // It's cheap (a small, fast model call) and best-effort.
  const updateMemoryInBackground = (priorTurns: ChatTurn[], answerText: string) => {
    if (!user?.id || !answerText.trim()) return;
    const recent: ChatRequestMessage[] = priorTurns
      .filter((t) => !t.error)
      .slice(-5)
      .map(toRequestMessage);
    recent.push({ role: 'assistant', content: answerText });
    const current = getChatMemory(user.id);
    void updateChatMemory(recent, current)
      .then(({ memory: updated }) => {
        if (updated && updated.trim() && updated.trim() !== current.trim()) {
          setChatMemory(updated, user.id);
          setMemory(updated);
        }
      })
      .catch(() => {
        /* memory is best-effort */
      });
  };

  // Core streaming generation, shared by first-send, regenerate and edit-resend.
  // `regenerateTurnId` reuses (and archives the prior answer of) an existing
  // assistant turn; otherwise a fresh assistant turn is appended.
  const runGeneration = async (opts: {
    sessionId: string;
    baseTurns: ChatTurn[];
    reqModel?: string;
    reqSource?: ModelSourceId;
    reqTools: string[];
    regenerateTurnId?: string;
    /** When set, run a recipe (a `/`-skill) instead of a normal chat completion. */
    recipeRun?: { recipeId: string; values: Record<string, unknown> };
  }) => {
    const { sessionId, baseTurns, reqModel, reqSource, reqTools, regenerateTurnId, recipeRun } = opts;
    // Bind to the TARGET session (captured at send time), not whatever chat happens to
    // be active when an async tick resolves — so switching/creating chats mid-stream
    // never crosses settings or output between conversations.
    const session = sessions.find((s) => s.id === sessionId);
    if (!session) return;

    markBusy(sessionId, true);
    const controller = new AbortController();
    abortMap.current.set(sessionId, controller);
    // Per-turn timing for observability (the chat_turn telemetry event below).
    const turnStartedAt = Date.now();

    const setSessionState = (updater: (s: ChatSession) => ChatSession) =>
      setSessions((prev) => prev.map((s) => (s.id === sessionId ? updater(s) : s)));

    // Reuse the existing assistant turn (regenerate) or append a fresh placeholder.
    const aiTurnId = regenerateTurnId || crypto.randomUUID();
    if (regenerateTurnId) {
      setSessionState((s) => ({
        ...s,
        turns: s.turns.map((t) =>
          t.id === aiTurnId ? { ...t, content: '', reasoning: undefined, error: false, startedAt: turnStartedAt, durationMs: undefined } : t
        )
      }));
    } else {
      setSessionState((s) => ({
        ...s,
        turns: [...s.turns, { id: aiTurnId, role: 'assistant', content: '', createdAt: turnStartedAt, startedAt: turnStartedAt }]
      }));
    }

    try {
      const reqMessages = baseTurns.filter((t) => !t.error).map(toRequestMessage);
      // Situational context (date/timezone/locale/units/coarse location) so the model
      // isn't flying blind on "today"/"latest"/"near me". Never prompts for permission.
      const clientContext = await gatherClientContext().catch(() => undefined);
      // Files attached to the CURRENT user turn — sent so server-side tools (run_python)
      // can read/convert/process them. Only THIS turn's files, not the whole history.
      // 'text' (pasted-block) attachments are skipped — they're already inlined into the
      // message by toRequestMessage, so sending them again would duplicate the payload.
      const currentUserTurn = [...baseTurns].reverse().find((t) => t.role === 'user');
      const turnAttachments = (currentUserTurn?.attachments || [])
        .filter((a) => a.kind !== 'text')
        .map((a) => ({
          name: a.name,
          mimeType: a.mimeType,
          dataUri: a.dataUrl
        }));
      const reqBody = {
        messages: reqMessages,
        model: reqModel,
        source: reqSource,
        reasoningLevel: session.reasoningLevel,
        webSearch: session.webSearch,
        systemPrompt: composeSystemPrompt(getChatMemory(user?.id), session.systemPrompt),
        ...(clientContext ? { clientContext } : {}),
        ...(reqTools.length ? { tools: reqTools } : {}),
        // Custom agents only matter to the swarm (mode or tool); send them only then.
        ...((session.swarm || reqTools.includes('run_agent_swarm')) && customAgents.length ? { customAgents } : {}),
        ...((session.mcpServers || []).length ? { mcpServers: getMcpServersByIds(session.mcpServers || []) } : {}),
        ...(turnAttachments.length ? { attachments: turnAttachments } : {}),
        ...(session.dreamstreamAccess ? { dreamstreamContext: buildDreamStreamContext(projects) } : {})
      };
      const onDelta = (chunk: string) =>
        setSessionState((s) => ({
          ...s,
          turns: s.turns.map((t) => (t.id === aiTurnId ? { ...t, content: t.content + chunk } : t))
        }));
      // Stream the reasoning trace live so the user sees the model "thinking".
      const onReasoning = (chunk: string) =>
        setSessionState((s) => ({
          ...s,
          turns: s.turns.map((t) => (t.id === aiTurnId ? { ...t, reasoning: (t.reasoning || '') + chunk } : t))
        }));
      // A new turn is starting after tools ran — clear the prior turn's streamed
      // pre-tool narration so it doesn't pile up above the real answer.
      const onReset = () =>
        setSessionState((s) => ({
          ...s,
          turns: s.turns.map((t) => (t.id === aiTurnId ? { ...t, content: '', reasoning: undefined } : t))
        }));

      // Live plan/agent trace → a swarm_trace artifact on the turn (shared by the swarm
      // path and swarm-backed recipes like /research and /market).
      const onTrace = (trace: unknown) =>
        setSessionState((s) => ({
          ...s,
          turns: s.turns.map((t) =>
            t.id === aiTurnId
              ? { ...t, artifacts: [{ type: 'swarm_trace', data: trace }, ...((t.artifacts || []).filter((a) => a.type !== 'swarm_trace'))] }
              : t
          )
        }));

      // Live tool-loop steps → an `agent_activity` artifact on the turn, so the user
      // watches the DEFAULT agent work (search → read → fetch → synthesize) during the
      // long tool-grounded window before the answer streams. Transient: the finalize
      // step replaces the turn's artifacts with the server's, so this card yields to the
      // persistent collapsed "How it answered" panel once the answer lands.
      const onAgentStep = (event: AgentActivityEvent) =>
        setSessionState((s) => ({
          ...s,
          turns: s.turns.map((t) => {
            if (t.id !== aiTurnId) return t;
            const prior = (t.artifacts || []).find((a) => a.type === 'agent_activity')?.data as AgentActivityArtifact | undefined;
            const data = applyAgentStep(prior, event);
            const others = (t.artifacts || []).filter((a) => a.type !== 'agent_activity');
            return { ...t, artifacts: [{ type: 'agent_activity', data }, ...others] };
          })
        }));

      // Three generation paths: a `/`-skill recipe, the agent swarm, or a normal stream.
      const useSwarm = Boolean(session.swarm) && reqSource === 'openrouter';
      const res = recipeRun
        ? await (async () => {
            const outcome = await runRecipe(
              {
                recipeId: recipeRun.recipeId,
                values: recipeRun.values,
                messages: reqMessages,
                model: reqSource === 'openrouter' ? reqModel : undefined,
                source: 'openrouter',
                systemPrompt: reqBody.systemPrompt
              },
              { onDelta, onTrace },
              controller.signal
            );
            if (outcome.error) throw new Error(outcome.error);
            return {
              text: outcome.text,
              model: outcome.model || reqModel || 'recipe',
              requestedModel: reqModel,
              reasoningLevel: session.reasoningLevel,
              webSearch: session.webSearch,
              reasoning: undefined as string | undefined,
              citations: outcome.citations,
              toolEvents: outcome.toolEvents,
              images: outcome.images,
              artifacts: outcome.artifacts,
              notices: outcome.notices
            };
          })()
        : useSwarm
          ? await runSwarmStream(reqBody, { signal: controller.signal, onDelta, onReasoning, onTrace })
          : await sendChatMessageStream(reqBody, { signal: controller.signal, onDelta, onReasoning, onReset, onAgentStep });

      // Finalize: snapshot this answer as a variant and show it as the active one.
      updateSession(sessionId, (s) => ({
        ...s,
        turns: s.turns.map((t) => {
          if (t.id !== aiTurnId) return t;
          const variant: ChatTurnVariant = {
            content: res.text || t.content || '(no response)',
            model: res.model,
            requestedModel: res.requestedModel,
            reasoningLevel: res.reasoningLevel,
            webSearch: res.webSearch,
            reasoning: res.reasoning,
            citations: res.citations,
            toolEvents: res.toolEvents,
            images: res.images,
            artifacts: settleSwarmTrace(res.artifacts),
            notices: res.notices,
            durationMs: Date.now() - turnStartedAt,
            createdAt: Date.now()
          };
          const variants = [...(t.variants || []), variant];
          return { ...applyVariant(t, variant), variants, activeVariant: variants.length - 1 };
        }),
        updatedAt: Date.now()
      }));
      // Fold the tools that ran into local usage analytics (Settings → Tools).
      recordToolEvents(res.toolEvents);
      // Per-turn observability: capture a COMPACT success event (no message content) so
      // chat quality/latency/model/tool patterns are analyzable in the admin dashboard.
      captureEvent({
        eventType: 'chat_turn',
        severity: 'info',
        source: 'ai_chat',
        sessionId,
        metadata: {
          model: res.model,
          requestedModel: res.requestedModel || reqModel,
          source: reqSource,
          reasoningLevel: session.reasoningLevel,
          webSearch: Boolean(session.webSearch),
          swarm: Boolean(session.swarm),
          recipe: recipeRun?.recipeId,
          regenerate: Boolean(regenerateTurnId),
          latencyMs: Date.now() - turnStartedAt,
          toolCount: res.toolEvents?.length || 0,
          toolsFailed: res.toolEvents?.filter((e) => !e.ok).length || 0,
          citations: res.citations?.length || 0,
          notices: res.notices?.length || 0,
          contentLength: (res.text || '').length,
          empty: !((res.text || '').trim())
        }
      });
      // Only pop the side panel if this chat is the one being viewed — a background
      // chat finishing shouldn't yank a map open over the chat you're reading.
      const mapArtifact = res.artifacts?.find((a) => a.type === 'map');
      if (mapArtifact && sessionId === activeIdRef.current) setPanel(mapArtifact);
      // Legacy Sandpack side-panel auto-open is quarantined behind a dead flag (Sprint 0,
      // S0.2 / D3). Code apps now surface a single "Open in Code Studio" CTA on the card.
      const codeArtifact = res.artifacts?.find((a) => a.type === 'code_studio');
      if (isLegacyStudioEnabled() && codeArtifact && sessionId === activeIdRef.current) {
        setPanel(codeArtifact);
        setPanelFullscreen(false);
      }
      // Learn durable facts about the user from this exchange (background, throttled).
      updateMemoryInBackground(baseTurns, res.text || '');
    } catch (err) {
      if (controller.signal.aborted) {
        // Stopped mid-run: settle the live agent trace so its card doesn't spin forever.
        updateSession(sessionId, (s) => ({
          ...s,
          turns: s.turns.map((t) => (t.id === aiTurnId ? { ...t, artifacts: settleSwarmTrace(t.artifacts) } : t)),
          updatedAt: Date.now()
        }));
        return;
      }
      const friendly = friendlyChatError(err);
      // Record the failed chat (with its session/turn + model) so every failure is
      // collected for analysis, not just shown to the user and forgotten.
      captureError(err, {
        eventType: 'chat_failed',
        source: 'ai_chat',
        sessionId,
        message: friendly,
        metadata: {
          turnId: aiTurnId,
          requestedModel: reqModel,
          source: reqSource,
          reasoningLevel: session.reasoningLevel,
          webSearch: Boolean(session.webSearch),
          swarm: Boolean(session.swarm),
          latencyMs: Date.now() - turnStartedAt
        }
      });
      updateSession(sessionId, (s) => ({
        ...s,
        turns: s.turns.map((t) => {
          if (t.id !== aiTurnId) return t;
          // Keep any answer that already streamed in — don't blow it away with the error
          // (that was why a long/tool-heavy turn that got cut showed "aborted" and NOTHING
          // else). Surface the failure as a soft note appended below the partial content.
          const partial = (t.content || '').trim();
          if (partial) {
            return { ...t, artifacts: settleSwarmTrace(t.artifacts), content: `${t.content}\n\n---\n*⚠️ Response interrupted: ${friendly}*` };
          }
          return {
            ...t,
            artifacts: settleSwarmTrace(t.artifacts),
            content: `**Couldn't complete that.** ${friendly} If this keeps happening, check your API key in Settings → API Configuration.`,
            error: true
          };
        }),
        updatedAt: Date.now()
      }));
    } finally {
      if (abortMap.current.get(sessionId) === controller) abortMap.current.delete(sessionId);
      markBusy(sessionId, false);
    }
  };

  const handleSend = async (text: string, attachments: ChatAttachment[], overrideModel?: CatalogModel) => {
    if (!activeSession || busy) return;
    if (!text && attachments.length === 0) return;

    const sessionId = activeSession.id;
    // `busy` is React state and flips a tick late, so a mobile double-tap (touchend +
    // click) can fire two sends before it updates — which is how a chat ends up with two
    // identical user turns. `abortMap` is set synchronously when a generation starts, so
    // it's the reliable guard against a duplicate in-flight send for this chat.
    if (abortMap.current.has(sessionId)) return;
    const { reqModel, reqSource, reqTools } = resolveRequest(text, overrideModel);

    const userTurn: ChatTurn = {
      id: crypto.randomUUID(),
      role: 'user',
      content: text,
      attachments: attachments.length ? attachments : undefined,
      createdAt: Date.now()
    };
    const isFirst = activeSession.turns.length === 0;
    const baseTurns = [...activeSession.turns, userTurn];

    updateSession(sessionId, (s) => ({
      ...s,
      turns: baseTurns,
      title: isFirst && text ? deriveSessionTitle(text) : s.title,
      titleAuto: isFirst && text ? true : s.titleAuto,
      updatedAt: Date.now()
    }));

    // Kick off the AI title from the user's intent (non-blocking) the moment we have
    // their first message — the deterministic title shows instantly, the better one
    // swaps in a beat later.
    if (isFirst && text) void autoTitleSession(sessionId, text, reqSource);

    await runGeneration({ sessionId, baseTurns, reqModel, reqSource, reqTools });
  };

  // Library → "Use in a new chat": open a fresh chat and hand the composer the picked
  // file as an attachment. The composer listens for `dreamstream:attach` and adds it to
  // the draft so the user can ask about it. Works for both uploaded files (data URLs) and
  // generated/searched images (remote URLs — vision models accept those too).
  const handleUseLibraryItem = (item: LibraryItem) => {
    handleNew();
    setView('chat');
    requestAnimationFrame(() => {
      window.dispatchEvent(
        new CustomEvent('dreamstream:attach', {
          detail: {
            name: item.name,
            mimeType: item.mimeType || (item.kind === 'image' ? 'image/*' : 'application/octet-stream'),
            dataUrl: item.url,
            kind: item.kind === 'file' ? 'document' : 'image'
          }
        })
      );
    });
  };

  // Regenerate an assistant turn: re-run the prompt that produced it, keeping the
  // prior answer(s) as selectable versions.
  const handleRegenerate = async (turnId: string) => {
    if (!activeSession || busy) return;
    const turns = activeSession.turns;
    const idx = turns.findIndex((t) => t.id === turnId);
    if (idx < 0 || turns[idx].role !== 'assistant') return;

    // Preserve the existing answer as version 1 if it isn't already tracked (older
    // turns predate variant history), so regenerating never discards it.
    const target = turns[idx];
    if (!target.variants || target.variants.length === 0) {
      const seed: ChatTurnVariant = {
        content: target.content,
        model: target.model,
        requestedModel: target.requestedModel,
        reasoningLevel: target.reasoningLevel,
        webSearch: target.webSearch,
        reasoning: target.reasoning,
        citations: target.citations,
        toolEvents: target.toolEvents,
        images: target.images,
        artifacts: target.artifacts,
        createdAt: target.createdAt,
        error: target.error
      };
      updateSession(activeSession.id, (s) => ({
        ...s,
        turns: s.turns.map((t) => (t.id === turnId ? { ...t, variants: [seed], activeVariant: 0 } : t))
      }));
    }

    // The conversation up to (but excluding) this assistant turn is the prompt context.
    const baseTurns = turns.slice(0, idx);
    const lastUser = [...baseTurns].reverse().find((t) => t.role === 'user');
    const { reqModel, reqSource, reqTools } = resolveRequest(lastUser?.content || '');
    await runGeneration({ sessionId: activeSession.id, baseTurns, reqModel, reqSource, reqTools, regenerateTurnId: turnId });
  };

  // Edit a user message and resend: replace its text, drop everything after it, and
  // generate a fresh answer.
  const handleEditUserMessage = async (turnId: string, newText: string) => {
    if (!activeSession || busy) return;
    const text = newText.trim();
    if (!text) return;
    const turns = activeSession.turns;
    const idx = turns.findIndex((t) => t.id === turnId);
    if (idx < 0 || turns[idx].role !== 'user') return;

    const sessionId = activeSession.id;
    const editedTurn: ChatTurn = { ...turns[idx], content: text };
    const baseTurns = [...turns.slice(0, idx), editedTurn];
    updateSession(sessionId, (s) => ({ ...s, turns: baseTurns, updatedAt: Date.now() }));

    const { reqModel, reqSource, reqTools } = resolveRequest(text);
    await runGeneration({ sessionId, baseTurns, reqModel, reqSource, reqTools });
  };

  // Switch which regenerated version of an assistant turn is shown.
  const handleSelectVariant = (turnId: string, index: number) => {
    if (!activeSession) return;
    updateSession(activeSession.id, (s) => ({
      ...s,
      turns: s.turns.map((t) => {
        if (t.id !== turnId || !t.variants || !t.variants[index]) return t;
        return { ...applyVariant(t, t.variants[index]), variants: t.variants, activeVariant: index };
      }),
      updatedAt: Date.now()
    }));
  };

  if (!initialized) {
    return (
      <div className={`h-[100dvh] flex items-center justify-center ${CANVAS_BG}`}>
        <Loader2 className={`w-8 h-8 animate-spin ${ACCENT_TEXT}`} />
      </div>
    );
  }

  // No open session → land on Home (also covers the brief tick after a delete).
  let resolvedView: StudioView = view === 'chat' && !activeSession ? 'home' : view;
  // Gallery is an admin-only surface — a non-admin who deep-links ?cview=gallery falls back home.
  if (resolvedView === 'gallery' && !isAdmin) resolvedView = activeSession ? 'chat' : 'home';
  const accountName =
    (user?.user_metadata?.full_name as string | undefined) ||
    (user?.user_metadata?.name as string | undefined) ||
    user?.email?.split('@')[0] ||
    undefined;

  const isCodeStudio = panel?.type === 'code_studio';
  const panelTitle = (panel?.data as { title?: string } | undefined)?.title
    || (panel?.type === 'map' ? 'Map' : 'Preview');

  // Open the current code_studio app in a new browser tab. For vanilla/static
  // apps the main HTML file is opened as a blob URL. React apps use a CDN
  // bootstrap so the preview opens without a build step.
  const handleOpenNewTab = () => {
    if (!panel || panel.type !== 'code_studio') return;
    const artifact = panel.data as CodeStudioArtifact;
    const cssFiles = artifact.files.filter((f) => f.path.endsWith('.css'));
    const cssContent = cssFiles.map((f) => f.content).join('\n');
    const htmlFile = artifact.files.find((f) => f.path.endsWith('.html'));
    const appFile = artifact.files.find((f) => /\/App\.(tsx?|jsx?)$/.test(f.path));

    let html = '';
    if (htmlFile) {
      html = htmlFile.content;
    } else if (appFile && (artifact.template === 'react' || artifact.template === 'react-ts')) {
      html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"><title>${artifact.title}</title>
<script crossorigin src="https://unpkg.com/react@18/umd/react.development.js"></script>
<script crossorigin src="https://unpkg.com/react-dom@18/umd/react-dom.development.js"></script>
<script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>
<style>body{margin:0}${cssContent}</style>
</head>
<body>
<div id="root"></div>
<script type="text/babel" data-presets="react,typescript">
${appFile.content}
const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(React.createElement(typeof App !== 'undefined' ? App : () => React.createElement('p', null, 'Component not found')));
</script>
</body>
</html>`;
    } else {
      const jsFile = artifact.files.find((f) => f.path.endsWith('.js') || f.path.endsWith('.ts'));
      html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"><title>${artifact.title}</title>
<style>body{margin:0}${cssContent}</style>
</head>
<body>
${jsFile ? `<script>${jsFile.content}</script>` : '<p>No runnable entry file found.</p>'}
</body>
</html>`;
    }

    const blob = new Blob([html], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    window.open(url, '_blank');
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };

  const closePanel = () => {
    setPanel(null);
    setPanelFullscreen(false);
  };

  // editorHeight is responsive to fullscreen: fill more of the viewport when expanded.
  // Derived from the tracked viewport height (not window.innerHeight read at render
  // time) so it follows URL-bar collapse/rotation instead of jumping or overflowing.
  const codeEditorHeight = panelFullscreen
    ? Math.max(Math.min(480, viewportH - 96), Math.round(viewportH * 0.75))
    : 520;

  const panelContent = panel && (
    <>
      <div
        className={`flex items-center justify-between px-3 py-2 border-b border-[var(--ds-hairline)] shrink-0 ${GLASS}`}
      >
        <span className={`font-semibold text-sm flex items-center gap-1.5 min-w-0 ${INK}`}>
          {isCodeStudio
            ? <Code2 className={`w-4 h-4 shrink-0 ${ACCENT_TEXT}`} />
            : <MapIcon className={`w-4 h-4 shrink-0 ${ACCENT_TEXT}`} />}
          <span className="truncate">{panelTitle}</span>
        </span>
        <div className="flex items-center gap-1 shrink-0">
          {isCodeStudio && (
            <>
              <button
                onClick={handleOpenNewTab}
                title="Open static preview in new tab"
                className={`${CONTROL_BTN} p-1`}
              >
                <ExternalLink className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={() => setPanelFullscreen((v) => !v)}
                title={panelFullscreen ? 'Exit full screen' : 'Full screen'}
                className={`${CONTROL_BTN} p-1`}
              >
                {panelFullscreen
                  ? <Minimize2 className="w-3.5 h-3.5" />
                  : <Maximize2 className="w-3.5 h-3.5" />}
              </button>
            </>
          )}
          <button onClick={closePanel} className={`${CONTROL_BTN} p-1`}>
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>
      <div className={`flex-1 min-h-0 ${CANVAS_BG}`}>
        {panel.type === 'media' ? (
          <MediaPanel data={panel.data as MediaPanelData} />
        ) : (
          <Suspense fallback={<div className="flex items-center justify-center h-full"><Loader2 className={`w-6 h-6 animate-spin ${ACCENT_TEXT}`} /></div>}>
            {panel.type === 'map' && <MapPanel data={panel.data as MapArtifact} />}
            {panel.type === 'playground' && <MultiFilePlayground data={panel.data as PlaygroundData} />}
            {panel.type === 'code_studio' && (
              <CodeStudioPanel
                data={panel.data as CodeStudioArtifact}
                editorHeight={codeEditorHeight}
              />
            )}
          </Suspense>
        )}
      </div>
    </>
  );

  return (
    <ChatPanelContext.Provider value={setPanel}>
    <div className={`h-[100dvh] flex flex-col overflow-hidden ${CANVAS_BG} ${INK}`}>
      {/* Platform-allowance alerts (30/70/90/100%) — slim strip above the whole shell;
          renders nothing until a threshold is crossed (or while the backend is absent). */}
      <AllowanceBanner />
      <div className="flex-1 min-h-0 flex overflow-hidden">
      {sidebarOpen && (() => {
        // On phones the sidebar floats over the conversation as a drawer (with a tap-to-close
        // backdrop) instead of stealing a 288px column; selecting a chat closes it. On desktop
        // it stays an inline flex column exactly as before.
        const closeOnMobile = () => { if (!isDesktop) setSidebarOpen(false); };
        const sidebar = (
          <ChatSidebar
            sessions={sessions}
            projects={projectsList}
            activeId={activeId}
            generatingIds={busyIds}
            hasMemory={Boolean(memory.trim())}
            isAdmin={isAdmin}
            view={resolvedView}
            userName={accountName}
            userEmail={user?.email || undefined}
            onSelect={(id) => { setActiveId(id); setView('chat'); closeOnMobile(); }}
            onNew={() => { handleNew(); closeOnMobile(); }}
            onDelete={handleDelete}
            onRename={handleRename}
            onMoveToProject={handleMoveToProject}
            onNewProject={() => setProjectModal({ editing: null })}
            onEditProject={(project) => setProjectModal({ editing: project })}
            onDeleteProject={handleDeleteProject}
            onEditMemory={handleEditMemory}
            onBack={onBack}
            onOpenSearch={() => { setPaletteOpen(true); closeOnMobile(); }}
            onOpenLibrary={() => { setView('library'); closeOnMobile(); }}
            onOpenDashboards={() => { setView('dashboards'); closeOnMobile(); }}
            onOpenGallery={() => { if (!isAdmin) return; setView('gallery'); closeOnMobile(); }}
            onOpenTools={() => { if (!isAdmin) return; setSettingsTab('tools'); closeOnMobile(); }}
          />
        );
        if (isDesktop) return sidebar;
        return (
          <div className="fixed inset-0 z-40 flex md:hidden">
            <div
              className="absolute inset-0 bg-black/40 animate-fade-in touch-none"
              onClick={() => setSidebarOpen(false)}
              aria-hidden
            />
            {/* Drawer panel: paints the top notch area (safe-area inset) in the sidebar
                color and scrolls internally — the page behind is scroll-locked. */}
            <div
              className={`relative z-10 h-full max-w-[85vw] shadow-2xl animate-slide-in-left overscroll-contain pt-[env(safe-area-inset-top)] ${SIDEBAR_BG}`}
            >
              {sidebar}
            </div>
          </div>
        );
      })()}

      {resolvedView === 'chat' && activeSession ? (
      <ChatConversation
        session={activeSession}
        features={features}
        busy={busy}
        sidebarOpen={sidebarOpen}
        onToggleSidebar={() => setSidebarOpen((v) => !v)}
        showModelSelector={showModelSelector}
        onOpenModelPicker={() => setShowModelPicker(true)}
        onSend={handleSend}
        seedText={composerSeed}
        onSeedConsumed={() => setComposerSeed('')}
        onStop={handleStop}
        onBranch={handleBranch}
        onRegenerate={handleRegenerate}
        onEditUserMessage={handleEditUserMessage}
        onSelectVariant={handleSelectVariant}
        onReasoningChange={(level) =>
          activeId && updateSession(activeId, (s) => ({ ...s, reasoningLevel: level, updatedAt: Date.now() }))
        }
        onWebToggle={(on) =>
          activeId && updateSession(activeId, (s) => ({ ...s, webSearch: on, updatedAt: Date.now() }))
        }
        onDreamstreamToggle={(on) =>
          activeId && updateSession(activeId, (s) => ({ ...s, dreamstreamAccess: on, updatedAt: Date.now() }))
        }
        onToggleConnector={(connector: ChatConnector, on: boolean) =>
          activeId && updateSession(activeId, (s) => ({ ...s, tools: toggleConnector(connector, s.tools, on), updatedAt: Date.now() }))
        }
        mcpServers={mcpServers}
        onToggleMcpServer={handleToggleMcpServer}
        onRenameTitle={(title) => activeId && handleRename(activeId, title)}
        suggestModels={suggestModels}
        onStartWithModel={handleStartWithModel}
      />
      ) : (
      <div className={`flex-1 flex flex-col min-w-0 min-h-0 h-full ${CANVAS_BG}`}>
        {/* Slim header for the non-chat views — keeps the sidebar toggle reachable.
            `relative z-20` lifts it above the scrolling content below. Dashboards
            skip it entirely (the toggle moves into their own sticky bar) so the
            board content starts at the very top — no wasted title strip. */}
        {resolvedView !== 'dashboards' && resolvedView !== 'gallery' && resolvedView !== 'library' && (
        <div className={`relative z-20 flex items-center gap-2 sm:gap-3 px-3 sm:px-4 py-3 border-b border-[var(--ds-hairline)] ${GLASS}`}>
          <button
            onClick={() => setSidebarOpen((v) => !v)}
            className={`${CONTROL_BTN} p-2 sm:p-1.5 tap-target`}
            title={sidebarOpen ? 'Hide sidebar' : 'Show sidebar'}
          >
            {sidebarOpen ? <PanelLeftClose className="w-4 h-4" /> : <PanelLeftOpen className="w-4 h-4" />}
          </button>
          <span className={`text-sm ${HEADING}`}>Home</span>
        </div>
        )}
        <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden overscroll-contain [-webkit-overflow-scrolling:touch]">
          <Suspense
            fallback={
              <div className="h-full flex items-center justify-center">
                <Loader2 className={`w-6 h-6 animate-spin ${ACCENT_TEXT}`} />
              </div>
            }
          >
            {resolvedView === 'home' && (
              <ChatHome
                userName={accountName}
                sessions={sessions}
                onResume={(sessionId) => { setActiveId(sessionId); setView('chat'); }}
                onStartChat={handleStartChat}
                onOpenLibrary={() => setView('library')}
                onOpenDashboards={() => setView('dashboards')}
              />
            )}
            {resolvedView === 'library' && (
              <LibraryView
                sessions={sessions}
                onOpenSource={(sessionId) => { setActiveId(sessionId); setView('chat'); }}
                onUseInChat={handleUseLibraryItem}
                sidebarControl={
                  <button
                    onClick={() => setSidebarOpen((v) => !v)}
                    className={`${CONTROL_BTN} p-2 sm:p-1.5 tap-target shrink-0`}
                    title={sidebarOpen ? 'Hide sidebar' : 'Show sidebar'}
                  >
                    {sidebarOpen ? <PanelLeftClose className="w-4 h-4" /> : <PanelLeftOpen className="w-4 h-4" />}
                  </button>
                }
              />
            )}
            {resolvedView === 'dashboards' && (
              <DashboardsView
                onAsk={(text) => handleStartChat(text)}
                sidebarControl={
                  <button
                    onClick={() => setSidebarOpen((v) => !v)}
                    className={`${CONTROL_BTN} p-2 sm:p-1.5 tap-target shrink-0`}
                    title={sidebarOpen ? 'Hide sidebar' : 'Show sidebar'}
                  >
                    {sidebarOpen ? <PanelLeftClose className="w-4 h-4" /> : <PanelLeftOpen className="w-4 h-4" />}
                  </button>
                }
              />
            )}
            {resolvedView === 'gallery' && isAdmin && (
              <GalleryStudio
                onTry={(prompt) => { handleStartChat(prompt); setView('chat'); }}
                sidebarControl={
                  <button
                    onClick={() => setSidebarOpen((v) => !v)}
                    className={`${CONTROL_BTN} p-2 sm:p-1.5 tap-target shrink-0`}
                    title={sidebarOpen ? 'Hide sidebar' : 'Show sidebar'}
                  >
                    {sidebarOpen ? <PanelLeftClose className="w-4 h-4" /> : <PanelLeftOpen className="w-4 h-4" />}
                  </button>
                }
              />
            )}
          </Suspense>
          {/* Always-on-top mini video player — follows the user across views. */}
          <FloatingVideoDock />
        </div>
      </div>
      )}

      {/* Resizable side panel — sibling on desktop (unless fullscreen), overlay on mobile. */}
      {panel && isDesktop && !panelFullscreen && (
        <>
          <div onMouseDown={startResize} className={`w-1.5 cursor-col-resize bg-[var(--ds-hairline)] hover:bg-[var(--ds-accent)] shrink-0 ${TRANSITION}`} title="Drag to resize" />
          <div className={`flex flex-col shrink-0 border-l border-[var(--ds-hairline)] ${CANVAS_BG}`} style={{ width: panelWidth }}>
            {panelContent}
          </div>
        </>
      )}
      {panel && (!isDesktop || panelFullscreen) && (
        <div
          className={`fixed inset-0 z-50 flex flex-col pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] ${CANVAS_BG}`}
        >
          {panelContent}
        </div>
      )}

      {/* Command palette — platform-level, opened via ⌘K/Ctrl-K or the sidebar Search row. */}
      {paletteOpen && (
        <Suspense fallback={null}>
          <CommandPalette
            open={paletteOpen}
            onClose={() => setPaletteOpen(false)}
            sessions={sessions}
            onResume={(id) => { setActiveId(id); setView('chat'); setPaletteOpen(false); }}
            onNavigate={(v) => { setView(v); setPaletteOpen(false); }}
            onAsk={(text) => { setPaletteOpen(false); handleStartChat(text); }}
          />
        </Suspense>
      )}

      {showModelPicker && activeSession && showModelSelector && (
        <ChatModelPicker
          selectedModelId={activeSession.modelId}
          hasMessages={activeSession.turns.length > 0}
          conversationHasImages={activeSession.turns.some((t) => (t.attachments?.length || 0) > 0)}
          autoMode={activeSession.autoMode}
          lockedSource={activeSession.lockedSource}
          onSelect={handleSelectModel}
          onSelectAuto={handleSelectAuto}
          onClose={() => setShowModelPicker(false)}
        />
      )}

      {projectModal && (
        <ChatProjectModal
          project={projectModal.editing}
          onSave={handleSaveProject}
          onClose={() => setProjectModal(null)}
        />
      )}

      {settingsTab && (
        <ChatSettingsModal
          userId={user?.id}
          isAdmin={isAdmin}
          initialTab={settingsTab}
          onMemoryChange={setMemory}
          onAgentsChange={setCustomAgents}
          onClose={() => setSettingsTab(null)}
        />
      )}
      </div>
    </div>
    </ChatPanelContext.Provider>
  );
};
