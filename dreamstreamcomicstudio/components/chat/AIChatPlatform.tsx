import React, { lazy, Suspense, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Code2, Loader2, Map as MapIcon, Maximize2, Minimize2, PanelLeftClose, PanelLeftOpen, X } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { initTheme } from '../../services/theme';
import { getLockedChatModel, getShowChatModelSelector, onAppSettingsChanged } from '../../services/appSettings';
import { applyLockedChatModel } from '../../services/chatModelResolve';
import { ChatSidebar } from './ChatSidebar';
import { ChatConversation } from './ChatConversation';
import { ChatModelPicker } from './ChatModelPicker';
import { ChatProjectModal } from './ChatProjectModal';
import { ChatSettingsModal } from './ChatSettingsModal';
import { listCustomAgents } from '../../services/chatAgents';
import { ChatPanelContext } from './panelContext';
import { applyAgentStep } from './agentActivity';
import { AllowanceBanner } from './AllowanceBanner';
import { UsageMeter } from '../usage/UsageMeter';
import { MediaPanel, type MediaPanelData } from './MediaPanel';
import type { PlaygroundData } from './MultiFilePlayground';
import type { ChatArtifact, MapArtifact, AgentActivityEvent, AgentActivityArtifact } from '../../apiTypes';
import { CANVAS_BG, SIDEBAR_BG, GLASS, HEADING, INK, ACCENT_TEXT, CONTROL_BTN, TRANSITION } from './studioDesign';
import { persistUiState, resolveInitialUiState } from '../../services/viewState';
import { getAdminAccess } from '../../services/billing';
import { isFreeOnly, setFreeOnly } from '../../services/freeOnlyMode';
import {
  connectedDataNoticeOf,
  connectorMarkerFor,
  isFreeModel,
  mayRunOnFreeModel,
  standardModelStep,
  stoppedTurnMarker,
  type ConnectedDataAction
} from './connectorPrivacy';
import { API_KEYS_HREF } from '../usage/links';
import { ArtifactTurnsContext, type ArtifactTurnRef, type ArtifactTurnsValue } from './artifacts/ChatArtifacts';
import {
  abortStream,
  beginStream,
  dropHotSession,
  endStream,
  getHotSession,
  hotSessions,
  isStreaming,
  holdHotSession,
  putHotSession,
  retainChatView,
  streamingIds,
  subscribeChatStreams
} from '../../services/chatStreams';

const MapPanel = lazy(() => import('./MapPanel'));
const MultiFilePlayground = lazy(() => import('./MultiFilePlayground'));

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

/**
 * Slim header for the non-chat views: the sidebar toggle, the view title and the user's usage
 * left (P1-LIMITS) — one calm meter, percent + friendly units, never dollars. The meter renders
 * nothing for admins / exempt accounts / while the usage backend is unavailable, and is the
 * compact 44 px gauge on phones so the row never overflows at 320–360 px.
 */
export const StudioViewHeader: React.FC<{
  title: string;
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  compactMeter: boolean;
}> = ({ title, sidebarOpen, onToggleSidebar, compactMeter }) => (
  <div className={`relative z-20 flex min-w-0 items-center gap-2 sm:gap-3 px-3 sm:px-4 py-3 border-b border-[var(--ds-hairline)] ${GLASS}`}>
    <button
      onClick={onToggleSidebar}
      className={`${CONTROL_BTN} p-2 sm:p-1.5 tap-target shrink-0`}
      title={sidebarOpen ? 'Hide sidebar' : 'Show sidebar'}
      aria-label={sidebarOpen ? 'Hide sidebar' : 'Show sidebar'}
    >
      {sidebarOpen ? <PanelLeftClose className="w-4 h-4" /> : <PanelLeftOpen className="w-4 h-4" />}
    </button>
    <span className={`min-w-0 truncate text-sm ${HEADING}`}>{title}</span>
    <UsageMeter compact={compactMeter} className="ml-auto" />
  </div>
);

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
import type { ChatMemoryResponse, ChatReasoningLevel, ChatRequestMessage, ChatMessagePart, UniversalAssistantContext } from '../../apiTypes';
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
  getChatSession,
  isChatSessionVisible,
  shownVariantIndex,
  getLastActiveChatSessionId,
  isChatMemoryConnected,
  isChatOwnedBy,
  markChatMemoryConnected,
  listChatProjects,
  listChatSessions,
  saveChatProject,
  saveChatSession,
  setChatMemory,
  setLastActiveChatSessionId,
  syncFromCloud,
  wasDeletedThisSession,
  type ChatArtifactState,
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

/**
 * One stored turn as a request message. An assistant turn that connected-account content entered
 * carries `connectorData: true` (the server's mark on its reply, or a connector tool among its tool
 * events), so the server refuses a free-model turn of this chat without a lookup
 * (components/chat/connectorPrivacy.ts).
 */
export const toRequestMessage = (turn: ChatTurn): ChatRequestMessage => {
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
    return { role: turn.role, content: parts, ...connectorMarkerFor(turn) };
  }
  return { role: turn.role, content: text, ...connectorMarkerFor(turn) };
};

/** A turn that is part of the conversation the model sees: not a failed attempt, not a notice. */
export const isHistoryTurn = (turn: ChatTurn): boolean => !turn.error && !turn.notice;

/**
 * The assistant turn a STOPPED (or cut off) generation leaves: its partial answer stays and is sent
 * back as history, so it keeps a connected-content marker when the stream's `meta` said the turn may
 * carry connected content, or its live trace shows a connector tool (connectorPrivacy.ts
 * stoppedTurnMarker). The live trace is settled so its card stops spinning.
 */
export const toStoppedTurn = (turn: ChatTurn, metaConnectorPrivacy = false): ChatTurn => ({
  ...turn,
  ...stoppedTurnMarker({ metaConnectorPrivacy, artifacts: turn.artifacts }),
  artifacts: settleLiveTrace(turn.artifacts)
});

/**
 * The assistant turn a connected-data refusal leaves (connectorPrivacy.ts connectedDataNoticeOf): the
 * server's copy as a calm notice, with what the attempt had started cleared. Never an error turn.
 */
export const toNoticeTurn = (
  turn: ChatTurn,
  notice: { kind: NonNullable<ChatTurn['notice']>['kind']; message: string }
): ChatTurn => ({
  ...turn,
  artifacts: settleLiveTrace(turn.artifacts),
  content: notice.message,
  notice: { kind: notice.kind },
  error: undefined,
  reasoning: undefined,
  durationMs: undefined
});

// Project a stored variant's fields onto the visible assistant turn (used when
// finalizing a new answer and when the user flips between regenerated versions).
export const applyVariant = (turn: ChatTurn, v: ChatTurnVariant): ChatTurn => ({
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
  error: v.error,
  connectorData: v.connectorData,
  notice: undefined
});

/**
 * The persona plus the long-term memory block. Memory distilled from connected-account content
 * (`memoryConnected`) is left out of a turn that may run on a free model (`freeTurn`): free models
 * never receive connected content, and the server can only strip this block for users who still
 * have a connection (docs/DATA_CONNECTORS.md). The persona is always kept.
 */
export const composeSystemPrompt = (
  memory: string,
  persona?: string,
  privacy: { memoryConnected?: boolean; freeTurn?: boolean } = {}
): string | undefined => {
  const parts: string[] = [];
  if (persona && persona.trim()) parts.push(persona.trim());
  const withholdMemory = Boolean(privacy.memoryConnected && privacy.freeTurn);
  if (memory && memory.trim() && !withholdMemory) {
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

/** What a finished generation returns (a chat, swarm or recipe reply). */
type AnswerPayload = {
  text?: string;
  model?: string;
  requestedModel?: string;
  reasoningLevel?: ChatReasoningLevel;
  webSearch?: boolean;
  reasoning?: string;
  citations?: ChatTurnVariant['citations'];
  toolEvents?: ChatTurnVariant['toolEvents'];
  images?: ChatTurnVariant['images'];
  artifacts?: ChatTurnVariant['artifacts'];
  notices?: ChatTurnVariant['notices'];
  connectorData?: boolean;
};

/**
 * The turn a finished generation leaves: the answer becomes a new version, shown as the active one.
 * The server's `connectorData` mark is kept on that version (and so on the turn), so the answer goes
 * back marked in every later request (toRequestMessage).
 */
export const withAnswer = (t: ChatTurn, res: AnswerPayload, durationMs: number, now = Date.now()): ChatTurn => {
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
    artifacts: settleLiveTrace(res.artifacts),
    notices: res.notices,
    durationMs,
    createdAt: now,
    ...(res.connectorData === true ? { connectorData: true } : {})
  };
  const variants = [...(t.variants || []), variant];
  return { ...applyVariant(t, variant), variants, activeVariant: variants.length - 1 };
};

/**
 * The system prompt of one turn: the persona and the user's long-term memory, except that memory
 * flagged as distilled from connected-account content stays out of a turn that may run on a free
 * model (an OpenRouter or Auto turn with Free only on, or a free model named:
 * connectorPrivacy.ts mayRunOnFreeModel). A direct-provider turn keeps it: it never runs on a free
 * model, and the server strips flagged memory itself where that provider is not confirmed for it.
 */
export const turnSystemPrompt = (
  userId: string | undefined,
  persona: string | undefined,
  model: { id?: string; isFree?: boolean; source?: string }
): string | undefined =>
  composeSystemPrompt(getChatMemory(userId), persona, {
    memoryConnected: isChatMemoryConnected(userId),
    freeTurn: mayRunOnFreeModel({ freeOnly: isFreeOnly(), model: model.id, modelIsFree: model.isFree, source: model.source })
  });

/**
 * What "Use a standard model" does (the calm notice), from the model the resend would actually use
 * (connectorPrivacy.ts standardModelStep): Auto's free pick → resend on Auto's best standard pick,
 * Free only left as it is; a free model the user chose (or a direct provider) → the model picker;
 * no model named under Free only → Free only off, then resend; already standard → resend.
 */
export type StandardModelAction =
  | { kind: 'pick-model' }
  | { kind: 'resend'; freeOnlyOff: boolean; overrideModel?: CatalogModel };

export const standardModelAction = (input: {
  freeOnly: boolean;
  /** The chat is on Auto and no model is locked in Settings. */
  auto: boolean;
  /** The resend's model and source, resolved as a send resolves them (resolveRequest). */
  reqModel?: string;
  reqSource?: string;
  /** The catalog says the resend's model is free (a $0 model without the `:free` suffix). */
  modelIsFree?: boolean;
  /** The refused message: Auto picks the standard model for it. */
  text: string;
  /** The models Auto may pick from (in scope, the chat's locked source). */
  candidates: CatalogModel[];
}): StandardModelAction => {
  const step = standardModelStep({
    freeOnly: input.freeOnly,
    model: input.reqModel,
    modelIsFree: input.modelIsFree,
    auto: input.auto,
    source: input.reqSource
  });
  if (step === 'pick-model') return { kind: 'pick-model' };
  if (step === 'free-only-off') return { kind: 'resend', freeOnlyOff: true };
  if (step === 'resend') return { kind: 'resend', freeOnlyOff: false };
  const standard = input.candidates.filter((m) => !isFreeModel(m.id, m.isFree));
  const best = recommendModels(input.text || 'general question', standard, 1)[0]?.model;
  return best ? { kind: 'resend', freeOnlyOff: false, overrideModel: best } : { kind: 'pick-model' };
};

/**
 * Keep what POST /api/chat/memory answered: the merged memory when it changed (returned, so the UI
 * can show it), and the connected-content flag when the server set it — sticky until the memory is
 * cleared, even when this exchange added nothing new.
 */
export const storeMemoryUpdate = (userId: string, current: string, res: ChatMemoryResponse): string | null => {
  const updated = typeof res.memory === 'string' ? res.memory : '';
  const changed = Boolean(updated.trim()) && updated.trim() !== current.trim();
  if (changed) setChatMemory(updated, userId);
  if (res.connectorData === true) markChatMemoryConnected(userId);
  return changed ? updated : null;
};

// When a turn ends — finishes, errors, or is STOPPED — any LIVE trace card must stop
// showing "working…": settle still-running/pending work to a terminal state so the
// `swarm_trace` and `agent_activity` cards never spin forever after the answer is done
// or the run was aborted. (On a clean finish the trace is usually replaced by the
// server's final artifacts anyway; this guards the abort/error paths that keep it.)
const settleLiveTrace = <T extends { type: string; data: unknown }>(artifacts?: T[]): T[] | undefined =>
  artifacts?.map((a) => {
    if (a.type === 'swarm_trace') {
      const d = (a.data || {}) as { agents?: { status?: string }[] };
      if (!Array.isArray(d.agents)) return a;
      return { ...a, data: { ...d, agents: d.agents.map((g) => (g?.status === 'running' || g?.status === 'pending' ? { ...g, status: 'done' } : g)) } } as T;
    }
    if (a.type === 'agent_activity') {
      const d = (a.data || {}) as { steps?: { status?: string }[]; done?: boolean };
      const steps = Array.isArray(d.steps) ? d.steps.map((s) => (s?.status === 'running' ? { ...s, status: 'done' } : s)) : d.steps;
      return { ...a, data: { ...d, steps, done: true } } as T;
    }
    return a;
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
  // The newest session list, readable synchronously (CHAT-0, bug B4). Every change to the list goes
  // through commitSessions, which computes from this ref — never inside a React updater — so a save
  // computed from it also runs after this view unmounts (a reply finishing in the background).
  const sessionsRef = useRef<ChatSession[]>([]);
  // False once this view unmounted: a late write then reads its base from IndexedDB, never from the
  // stale list this view held.
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    // While this view is mounted chatStreams keeps recent chats hot; once no view is, only the chats
    // a write may still arrive for (a reply streaming, a calendar write) stay in memory.
    const release = retainChatView();
    return () => {
      aliveRef.current = false;
      release();
    };
  }, []);
  const initializedRef = useRef(false);
  // The rows exactly as loaded at mount: a background cloud sync may replace these (it decided which
  // side changed); a row this view changed since keeps the newer copy.
  const loadedRowsRef = useRef<WeakSet<ChatSession>>(new WeakSet());
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
  // answer is currently generating — kept in services/chatStreams (module scope), so a view mounted
  // while a reply from an earlier view is still streaming shows it busy and cannot send over it.
  const busyIds = useSyncExternalStore(subscribeChatStreams, streamingIds, streamingIds);
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
  // Bumped when a generation ends, so the header usage meter re-reads usage left once, shortly
  // after something may have been spent (event-driven — never a timer).
  const [usageRefreshKey, setUsageRefreshKey] = useState(0);
  const noteGeneration = (on: boolean) => {
    if (!on) setUsageRefreshKey((k) => k + 1);
  };

  /**
   * Apply a change to the session list, computed from the newest list (sessionsRef), and mirror every
   * changed row that chatStreams keeps hot, so a view mounted later — or a reply finishing after this
   * one unmounted — starts from what this view shows.
   */
  const commitSessions = (fn: (prev: ChatSession[]) => ChatSession[]) => {
    const prev = sessionsRef.current;
    const next = fn(prev);
    if (next === prev) return;
    sessionsRef.current = next;
    setSessions(next);
    const before = new Map(prev.map((s) => [s.id, s] as const));
    for (const s of next) {
      if (before.get(s.id) !== s && getHotSession(s.id)) putHotSession(s, { notify: false });
    }
  };

  /** The newest copy of a chat: the hot copy (always, while it streams) or this view's, by time. */
  const latestSession = (id: string): ChatSession | undefined => {
    const hot = getHotSession(id);
    const mine = sessionsRef.current.find((s) => s.id === id);
    if (!hot) return mine;
    if (!mine || isStreaming(id)) return hot;
    return (hot.updatedAt || 0) >= (mine.updatedAt || 0) ? hot : mine;
  };

  useEffect(() => {
    const mq = window.matchMedia('(min-width: 768px)');
    const onChange = () => setIsDesktop(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
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

  // Escape closes the phone drawer — unless a menu inside it (which marks the key handled) or a
  // dialog over it takes the key first.
  const drawerOpen = sidebarOpen && !isDesktop;
  const dialogOpen = showModelPicker || Boolean(projectModal) || Boolean(settingsTab) || paletteOpen;
  useEffect(() => {
    if (!drawerOpen || dialogOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      setSidebarOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drawerOpen, dialogOpen]);

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
        const [loaded, storedProjects] = await Promise.all([
          settleWithin(listChatSessions(), 4000, [] as ChatSession[]),
          settleWithin(listChatProjects(), 4000, [] as ChatProject[])
        ]);
        if (!active) return;
        // A reply an earlier view started may still be streaming (or just finished): its newest copy
        // is in chatStreams, not yet (or only just) in IndexedDB. Start from it.
        const stored = withHotCopies(loaded);
        loadedRowsRef.current = new WeakSet(stored);
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
          commitSessions(() => [session, ...stored]);
          setActiveId(session.id);
        } else if (stored.length > 0) {
          commitSessions(() => stored);
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
          commitSessions(() => [session]);
          setActiveId(session.id);
        }
      } catch {
        // Last resort: never strand the user on the spinner — open a fresh local chat.
        if (active) {
          const session = createEmptySession();
          commitSessions(() => [session]);
          setActiveId(session.id);
        }
      } finally {
        if (active) {
          initializedRef.current = true;
          setInitialized(true);
        }
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
          commitSessions((prev) => {
            // Never regress what the user can see: keep the in-memory copy when it is at
            // least as new (covers a chat that is streaming right now), keep local-only
            // sessions the user actually USED, and add everything new from the cloud.
            // Untouched placeholders (zero turns) are dropped the moment real history
            // arrives — the invariant-repair effect below moves the user into it.
            // A row this view never touched takes the synced copy as is: the sync decided which
            // side changed, and an edit from a device whose clock runs behind carries an OLDER
            // time (CHAT-0, nav V.3-a).
            const prevById = new Map(prev.map((s) => [s.id, s] as const));
            const mergedIds = new Set(merged.map((s) => s.id));
            const reconciled = merged.map((remote) => {
              const local = prevById.get(remote.id);
              if (!local) return remote;
              if (isStreaming(local.id)) return local;
              if (loadedRowsRef.current.has(local)) return remote;
              return local.updatedAt >= remote.updatedAt ? local : remote;
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

  // What each acting artifact (calendar write, clarify answers) knows about its turn: whether the
  // conversation moved on past it, and its recorded outcome (CHAT-0, settle §6). Looked up by the
  // turn's own artifacts array, the one ChatMessageView renders.
  const artifactTurns = useMemo<ArtifactTurnsValue>(() => {
    const byArtifacts = new Map<unknown, ArtifactTurnRef>();
    if (activeSession) {
      let lastUser = -1;
      activeSession.turns.forEach((t, i) => {
        if (t.role === 'user') lastUser = i;
      });
      activeSession.turns.forEach((t, i) => {
        if (t.role !== 'assistant' || !t.artifacts || t.artifacts.length === 0) return;
        byArtifacts.set(t.artifacts, {
          sessionId: activeSession.id,
          turnId: t.id,
          passed: i < lastUser,
          busy,
          variant: shownVariantIndex(t),
          artifactState: t.artifactState,
          settle: (key, state) => settleArtifact(activeSession.id, t.id, key, state)
        });
      });
    }
    return { turnFor: (artifacts) => byArtifacts.get(artifacts) ?? null };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSession, busy]);
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

  /**
   * Change one chat and save it (CHAT-0, bug B4). The new copy is computed from the newest copy
   * (latestSession) and saved OUTSIDE any React updater: an updater never runs once this view has
   * unmounted, which is how a reply that finished in the background used to be lost. The copy is also
   * kept hot in chatStreams, so a view mounted meanwhile merges it instead of saving a stale copy
   * over it. After this view unmounted, a chat it no longer holds hot is changed from IndexedDB.
   */
  const updateSession = (id: string, updater: (s: ChatSession) => ChatSession) => {
    if (wasDeletedThisSession(id)) return;
    if (!aliveRef.current && !getHotSession(id)) {
      // Held hot until saved: a second late change made meanwhile builds on this one.
      const release = holdHotSession(id);
      void (async () => {
        const stored = await getChatSession(id);
        if (!stored) return;
        const fresh = getHotSession(id) ?? stored; // a newer copy may have landed meanwhile
        const next = updater(fresh);
        if (next === fresh) return;
        putHotSession(next);
        await saveChatSession(next);
      })()
        .catch(() => {})
        .finally(release);
      return;
    }
    const base = latestSession(id);
    if (!base) return;
    const next = updater(base);
    if (next === base) return;
    commitSessions((prev) => (prev.some((s) => s.id === id) ? prev.map((s) => (s.id === id ? next : s)) : prev));
    // Other views hear about it only when this one is gone (one chat view is mounted at a time).
    putHotSession(next, { notify: !aliveRef.current });
    void saveChatSession(next);
  };

  /** This view's list with every newer hot copy merged in (and hot chats it lacks added). */
  const withHotCopies = (list: ChatSession[]): ChatSession[] => {
    let changed = false;
    const ids = new Set(list.map((s) => s.id));
    const out = list.map((s) => {
      const hot = getHotSession(s.id);
      if (!hot || hot === s) return s;
      if (isStreaming(s.id) || (hot.updatedAt || 0) >= (s.updatedAt || 0)) {
        changed = true;
        return hot;
      }
      return s;
    });
    const missing = hotSessions().filter(
      (h) => !ids.has(h.id) && h.turns.length > 0 && !wasDeletedThisSession(h.id) && isChatSessionVisible(h)
    );
    if (missing.length) changed = true;
    return changed ? [...missing.reverse(), ...out] : list;
  };

  // Another view (one that has unmounted, with a reply still streaming) changed a chat: show it.
  useEffect(
    () =>
      subscribeChatStreams(() => {
        if (!initializedRef.current) return; // the load merges hot copies itself
        commitSessions(withHotCopies);
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  /** Record (or clear) the outcome of an acting artifact on its turn — CHAT-0, settle §6. */
  const settleArtifact = (sessionId: string, turnId: string, key: string, state: ChatArtifactState | null) =>
    updateSession(sessionId, (s) => ({
      ...s,
      turns: s.turns.map((t) => {
        if (t.id !== turnId) return t;
        const next = { ...(t.artifactState || {}) };
        if (state) next[key] = state;
        else delete next[key];
        return { ...t, artifactState: Object.keys(next).length ? next : undefined };
      }),
      updatedAt: Date.now()
    }));

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
        : sessionsRef.current.find((s) => s.turns.length === 0);
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
    commitSessions((prev) => [base, ...prev]);
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
    abortStream(id);
    void deleteChatSession(id);
    dropHotSession(id);
    const next = sessionsRef.current.filter((s) => s.id !== id);
    if (next.length === 0) {
      const fresh = createEmptySession();
      void saveChatSession(fresh);
      commitSessions(() => [fresh]);
      setActiveId(fresh.id);
      return;
    }
    commitSessions(() => next);
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
    commitSessions((prev) => prev.map((s) => (s.projectId === projectId ? { ...s, projectId: null } : s)));
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
    const branched = branchSession(latestSession(activeSession.id) ?? activeSession, turnId);
    void saveChatSession(branched);
    commitSessions((prev) => [branched, ...prev]);
    setActiveId(branched.id);
    // "Branch + new model" opens the picker on the freshly-branched session.
    if (chooseNewModel) setShowModelPicker(true);
  };

  // Open the full settings panel (Memory / Agents / Tools) on the Memory tab.
  const handleEditMemory = () => setSettingsTab('memory');

  const handleStop = () => {
    if (!activeId) return;
    abortStream(activeId);
  };

  // Resolve which model/source/tools to use for a message. In Auto mode the app
  // picks the best model + the right tools per message; otherwise it uses the
  // session's pinned model (or a suggester override).
  // The models Auto may pick from: in scope, and from the chat's locked source when it has one.
  const autoCandidates = (): CatalogModel[] =>
    Array.from(catalog.values()).filter((m) => {
      if (activeSession?.lockedSource && m.source !== activeSession.lockedSource) return false;
      return isSourceInScope(m.source);
    });

  const resolveRequest = (
    text: string,
    overrideModel?: CatalogModel
  ): { reqModel?: string; reqSource?: ModelSourceId; reqTools: string[] } => {
    let reqModel = overrideModel ? overrideModel.id : activeSession?.modelId || undefined;
    let reqSource: ModelSourceId | undefined = overrideModel ? overrideModel.source : activeSession?.source || undefined;
    let reqTools = activeSession?.tools || [];
    if (activeSession?.autoMode && !overrideModel) {
      const candidates = autoCandidates();
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
    // A model locked in Settings fills in for Auto chats (and chats with no pinned model) —
    // that's what makes "lock the model from settings" take effect as a default. But it must
    // NEVER replace a model the user explicitly pinned on THIS chat: that silent swap was the
    // bug where switching between chats surfaced the wrong (previous/locked) model. A one-off
    // suggester/branch override still wins over both. (See services/chatModelResolve.ts.)
    const effectiveLock = applyLockedChatModel({
      locked: getLockedChatModel(),
      hasOverride: Boolean(overrideModel),
      autoMode: Boolean(activeSession?.autoMode),
      sessionModelId: activeSession?.modelId
    });
    if (effectiveLock) {
      reqModel = effectiveLock.id;
      reqSource = effectiveLock.source as ModelSourceId;
    }
    return { reqModel, reqSource, reqTools };
  };

  // Auto-memory: after each exchange, distill durable facts about the user and merge them
  // into their long-term memory in the background (logged-in users only). Runs from the
  // FIRST exchange — the previous "every other, skip the first" throttle meant something the
  // user said up front (name, location, what they're building) wasn't remembered until later.
  // It's cheap (a small, fast model call) and best-effort.
  const updateMemoryInBackground = (
    priorTurns: ChatTurn[],
    answerText: string,
    chatOwner: string | undefined,
    answerConnectorData = false
  ) => {
    if (!user?.id || !answerText.trim()) return;
    // Facts learned from a chat go into its OWNER's memory only: a chat still on screen after
    // another tab switched this browser to a different account must not teach that account.
    if (!isChatOwnedBy(chatOwner, user.id)) return;
    const recent: ChatRequestMessage[] = priorTurns
      .filter(isHistoryTurn)
      .slice(-5)
      .map(toRequestMessage);
    recent.push({ role: 'assistant', content: answerText, ...(answerConnectorData ? { connectorData: true } : {}) });
    const current = getChatMemory(user.id);
    void updateChatMemory(recent, current, { memoryConnected: isChatMemoryConnected(user.id) })
      .then((res) => {
        const next = storeMemoryUpdate(user.id, current, res);
        if (next) setMemory(next);
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
    const session = latestSession(sessionId);
    if (!session) return;

    // Busy and abortable from module scope: the reply keeps streaming (and is saved) if this view
    // unmounts, and a view mounted meanwhile sees the chat busy (services/chatStreams).
    const controller = new AbortController();
    putHotSession(session, { notify: false });
    beginStream(sessionId, controller);
    // Per-turn timing for observability (the chat_turn telemetry event below).
    const turnStartedAt = Date.now();
    // The answer text on screen so far (a refusal after some of it streamed is not a notice).
    let streamedText = '';
    // The stream's `meta` said this turn may carry connected content: a reply the user stops (or that
    // is cut off) before `final` keeps that mark on its partial answer (toStoppedTurn).
    let metaConnectorPrivacy = false;
    const onMeta = (meta: { connectorPrivacy?: boolean }) => {
      if (meta.connectorPrivacy === true) metaConnectorPrivacy = true;
    };

    // Live updates (deltas, traces) without a save: the final updateSession saves the whole turn.
    const setSessionState = (updater: (s: ChatSession) => ChatSession) => {
      const base = latestSession(sessionId);
      if (!base) return;
      const next = updater(base);
      commitSessions((prev) => prev.map((s) => (s.id === sessionId ? next : s)));
      putHotSession(next, { notify: !aliveRef.current });
    };

    // Reuse the existing assistant turn (regenerate) or append a fresh placeholder.
    const aiTurnId = regenerateTurnId || crypto.randomUUID();
    if (regenerateTurnId) {
      setSessionState((s) => ({
        ...s,
        turns: s.turns.map((t) =>
          t.id === aiTurnId
            ? { ...t, content: '', reasoning: undefined, error: false, notice: undefined, startedAt: turnStartedAt, durationMs: undefined }
            : t
        )
      }));
    } else {
      setSessionState((s) => ({
        ...s,
        turns: [...s.turns, { id: aiTurnId, role: 'assistant', content: '', createdAt: turnStartedAt, startedAt: turnStartedAt }]
      }));
    }

    try {
      const reqMessages = baseTurns.filter(isHistoryTurn).map(toRequestMessage);
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
        systemPrompt: turnSystemPrompt(user?.id, session.systemPrompt, {
          id: reqModel,
          isFree: reqModel ? catalog.get(reqModel)?.isFree : undefined,
          source: reqSource
        }),
        // The long-term memory is flagged as distilled from connected content: the server keeps it off
        // every turn that withholds connected content, and a paid turn carrying it denies data collection.
        ...(isChatMemoryConnected(user?.id) ? { memoryConnected: true } : {}),
        ...(clientContext ? { clientContext } : {}),
        ...(reqTools.length ? { tools: reqTools } : {}),
        // Custom agents only matter to the swarm (mode or tool); send them only then.
        ...((session.swarm || reqTools.includes('run_agent_swarm')) && customAgents.length ? { customAgents } : {}),
        ...((session.mcpServers || []).length ? { mcpServers: getMcpServersByIds(session.mcpServers || []) } : {}),
        ...(turnAttachments.length ? { attachments: turnAttachments } : {}),
        ...(session.dreamstreamAccess ? { dreamstreamContext: buildDreamStreamContext(projects) } : {})
      };
      const onDelta = (chunk: string) => {
        streamedText += chunk;
        setSessionState((s) => ({
          ...s,
          turns: s.turns.map((t) => (t.id === aiTurnId ? { ...t, content: t.content + chunk } : t))
        }));
      };
      // Stream the reasoning trace live so the user sees the model "thinking".
      const onReasoning = (chunk: string) =>
        setSessionState((s) => ({
          ...s,
          turns: s.turns.map((t) => (t.id === aiTurnId ? { ...t, reasoning: (t.reasoning || '') + chunk } : t))
        }));
      // A new turn is starting after tools ran — clear the prior turn's streamed
      // pre-tool narration so it doesn't pile up above the real answer.
      const onReset = () => {
        streamedText = '';
        setSessionState((s) => ({
          ...s,
          turns: s.turns.map((t) => (t.id === aiTurnId ? { ...t, content: '', reasoning: undefined } : t))
        }));
      };

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
                systemPrompt: reqBody.systemPrompt,
                ...(reqBody.memoryConnected ? { memoryConnected: true } : {})
              },
              { onDelta, onTrace, onMeta },
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
              notices: outcome.notices,
              connectorData: outcome.connectorData
            };
          })()
        : useSwarm
          ? await runSwarmStream(reqBody, { signal: controller.signal, onMeta, onDelta, onReasoning, onTrace })
          : await sendChatMessageStream(reqBody, { signal: controller.signal, onMeta, onDelta, onReasoning, onReset, onAgentStep });

      // Finalize: snapshot this answer as a variant and show it as the active one.
      updateSession(sessionId, (s) => ({
        ...s,
        turns: s.turns.map((t) => (t.id === aiTurnId ? withAnswer(t, res, Date.now() - turnStartedAt) : t)),
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
      // Learn durable facts about the user from this exchange (background, throttled).
      updateMemoryInBackground(baseTurns, res.text || '', session.ownerUserId, res.connectorData === true);
    } catch (err) {
      if (controller.signal.aborted) {
        // Stopped mid-run: settle the live agent trace so its card doesn't spin forever, and keep the
        // connected-content mark on the partial answer that stays (it is sent back as history).
        updateSession(sessionId, (s) => ({
          ...s,
          turns: s.turns.map((t) => (t.id === aiTurnId ? toStoppedTurn(t, metaConnectorPrivacy) : t)),
          updatedAt: Date.now()
        }));
        return;
      }
      // The calm refusals of connected-account privacy (a free model would have received this
      // chat's connected content, or usage is used up and the free fallback is off for it): nothing
      // was sent or spent, so the turn becomes an info notice with two ways forward — never an
      // error turn, never "Couldn't complete that", never part of the history sent back.
      const notice = streamedText.trim() ? null : connectedDataNoticeOf(err);
      if (notice) {
        captureEvent({
          eventType: 'chat_connected_data_notice',
          severity: 'info',
          source: 'ai_chat',
          sessionId,
          metadata: { kind: notice.kind, requestedModel: reqModel, source: reqSource, swarm: Boolean(session.swarm), recipe: recipeRun?.recipeId }
        });
        updateSession(sessionId, (s) => ({
          ...s,
          turns: s.turns.map((t) => (t.id === aiTurnId ? toNoticeTurn(t, notice) : t)),
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
            // The partial answer stays history, like a stopped one: it keeps the connected-content mark.
            return { ...toStoppedTurn(t, metaConnectorPrivacy), content: `${t.content}\n\n---\n*⚠️ Response interrupted: ${friendly}*` };
          }
          return {
            ...t,
            artifacts: settleLiveTrace(t.artifacts),
            content: `**Couldn't complete that.** ${friendly} If this keeps happening, check your API key in Settings → API Configuration.`,
            error: true
          };
        }),
        updatedAt: Date.now()
      }));
    } finally {
      endStream(sessionId, controller);
      noteGeneration(false);
    }
  };

  const handleSend = async (text: string, attachments: ChatAttachment[], overrideModel?: CatalogModel) => {
    if (!activeSession || busy) return;
    if (!text && attachments.length === 0) return;

    const sessionId = activeSession.id;
    // `busy` is React state and flips a tick late, so a mobile double-tap (touchend +
    // click) can fire two sends before it updates — which is how a chat ends up with two
    // identical user turns. The stream registry is set synchronously when a generation starts
    // (and outlives this view), so it's the reliable guard against a duplicate in-flight send.
    if (isStreaming(sessionId)) return;
    // The newest turns, not this render's: a card may have just recorded its outcome on its turn
    // (the clarify card records "sent" and then posts its answers in the same tick).
    const current = latestSession(sessionId) ?? activeSession;
    const { reqModel, reqSource, reqTools } = resolveRequest(text, overrideModel);

    const userTurn: ChatTurn = {
      id: crypto.randomUUID(),
      role: 'user',
      content: text,
      attachments: attachments.length ? attachments : undefined,
      createdAt: Date.now()
    };
    const isFirst = current.turns.length === 0;
    const baseTurns = [...current.turns, userTurn];

    updateSession(sessionId, (s) => ({
      ...s,
      turns: [...s.turns, userTurn],
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
  const handleRegenerate = async (turnId: string, overrideModel?: CatalogModel) => {
    if (!activeSession || busy || isStreaming(activeSession.id)) return;
    const turns = (latestSession(activeSession.id) ?? activeSession).turns;
    const idx = turns.findIndex((t) => t.id === turnId);
    if (idx < 0 || turns[idx].role !== 'assistant') return;

    // Preserve the existing answer as version 1 if it isn't already tracked (older
    // turns predate variant history), so regenerating never discards it. A notice is not an
    // answer: re-running it replaces it.
    const target = turns[idx];
    if ((!target.variants || target.variants.length === 0) && !target.notice) {
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
        error: target.error,
        connectorData: target.connectorData
      };
      updateSession(activeSession.id, (s) => ({
        ...s,
        turns: s.turns.map((t) => (t.id === turnId ? { ...t, variants: [seed], activeVariant: 0 } : t))
      }));
    }

    // The conversation up to (but excluding) this assistant turn is the prompt context.
    const baseTurns = turns.slice(0, idx);
    const lastUser = [...baseTurns].reverse().find((t) => t.role === 'user');
    const { reqModel, reqSource, reqTools } = resolveRequest(lastUser?.content || '', overrideModel);
    await runGeneration({ sessionId: activeSession.id, baseTurns, reqModel, reqSource, reqTools, regenerateTurnId: turnId });
  };

  // The calm connected-data notice's actions (connectorPrivacy.ts CONNECTED_DATA_ACTIONS).
  //  - "Use a standard model": resolved from the model the resend would actually use
  //    (standardModelAction): Auto's free pick is replaced by Auto's best standard pick and the
  //    refused message is sent again (Free only stays as it is); a free model the user chose (pinned,
  //    or locked in Settings) opens the model picker; with no model named, Free only chose the free
  //    model, so it is turned off and the message sent again; a model that is already standard (the
  //    user just picked one) sends it again.
  //  - "New chat": a fresh chat with no connected content keeps working on free models.
  //  - "API keys": Settings → API keys (the usage refusal's other way forward).
  const handleNoticeAction = (turnId: string, action: ConnectedDataAction) => {
    if (action === 'new-chat') {
      handleNew();
      setView('chat');
      return;
    }
    if (action === 'api-keys') {
      try {
        window.location.assign(API_KEYS_HREF);
      } catch {
        /* navigation unavailable */
      }
      return;
    }
    if (!activeSession) return;
    const idx = activeSession.turns.findIndex((t) => t.id === turnId);
    if (idx < 0) return;
    const lastUser = [...activeSession.turns.slice(0, idx)].reverse().find((t) => t.role === 'user');
    const text = lastUser?.content || '';
    const lock = applyLockedChatModel({
      locked: getLockedChatModel(),
      hasOverride: false,
      autoMode: Boolean(activeSession.autoMode),
      sessionModelId: activeSession.modelId
    });
    const { reqModel, reqSource } = resolveRequest(text);
    const plan = standardModelAction({
      freeOnly: isFreeOnly(),
      auto: Boolean(activeSession.autoMode) && !lock,
      reqModel,
      reqSource,
      modelIsFree: reqModel ? catalog.get(reqModel)?.isFree : undefined,
      text,
      candidates: autoCandidates()
    });
    if (plan.kind === 'pick-model') {
      setShowModelPicker(true);
      return;
    }
    if (plan.freeOnlyOff) setFreeOnly(false);
    void handleRegenerate(turnId, plan.overrideModel);
  };

  // Edit a user message and resend: replace its text, drop everything after it, and
  // generate a fresh answer.
  const handleEditUserMessage = async (turnId: string, newText: string) => {
    if (!activeSession || busy || isStreaming(activeSession.id)) return;
    const text = newText.trim();
    if (!text) return;
    const turns = (latestSession(activeSession.id) ?? activeSession).turns;
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
  // One name across every studio (PATCH /api/account/name keeps display_name current).
  const meta = user?.user_metadata as Record<string, unknown> | undefined;
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  const accountName =
    str(meta?.display_name) ||
    str([meta?.first_name, meta?.last_name].filter((v) => typeof v === 'string' && v.trim()).join(' ')) ||
    str(meta?.full_name) ||
    str(meta?.name) ||
    user?.email?.split('@')[0] ||
    undefined;

  const isPlayground = panel?.type === 'playground';
  const panelTitle = (panel?.data as { title?: string } | undefined)?.title
    || (panel?.type === 'map' ? 'Map' : 'Preview');

  const closePanel = () => {
    setPanel(null);
    setPanelFullscreen(false);
  };

  const panelContent = panel && (
    <>
      <div
        className={`flex items-center justify-between px-3 py-2 border-b border-[var(--ds-hairline)] shrink-0 ${GLASS}`}
      >
        <span className={`font-semibold text-sm flex items-center gap-1.5 min-w-0 ${INK}`}>
          {isPlayground
            ? <Code2 className={`w-4 h-4 shrink-0 ${ACCENT_TEXT}`} />
            : <MapIcon className={`w-4 h-4 shrink-0 ${ACCENT_TEXT}`} />}
          <span className="truncate">{panelTitle}</span>
        </span>
        <div className="flex items-center gap-1 shrink-0">
          {/* Phones always show the panel full screen; on desktop it can expand. */}
          {isDesktop && (
            <button
              onClick={() => setPanelFullscreen((v) => !v)}
              title={panelFullscreen ? 'Exit full screen' : 'Full screen'}
              className={`${CONTROL_BTN} p-1`}
            >
              {panelFullscreen
                ? <Minimize2 className="w-3.5 h-3.5" />
                : <Maximize2 className="w-3.5 h-3.5" />}
            </button>
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
      <ArtifactTurnsContext.Provider value={artifactTurns}>
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
        onNoticeAction={handleNoticeAction}
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
        // Usage left (P1-LIMITS) in the chat header too: the compact 44 px gauge on phones and
        // tablets, the pill on desktop; nothing for admins / exempt accounts / an unavailable backend.
        headerAccessory={<UsageMeter compact={!isDesktop} refreshKey={usageRefreshKey} />}
      />
      </ArtifactTurnsContext.Provider>
      ) : (
      <div className={`flex-1 flex flex-col min-w-0 min-h-0 h-full ${CANVAS_BG}`}>
        {/* Slim header for the non-chat views — keeps the sidebar toggle reachable.
            `relative z-20` lifts it above the scrolling content below. Dashboards
            skip it entirely (the toggle moves into their own sticky bar) so the
            board content starts at the very top — no wasted title strip. */}
        {resolvedView !== 'dashboards' && resolvedView !== 'gallery' && resolvedView !== 'library' && (
        <StudioViewHeader
          title="Home"
          sidebarOpen={sidebarOpen}
          onToggleSidebar={() => setSidebarOpen((v) => !v)}
          compactMeter={!isDesktop}
        />
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
