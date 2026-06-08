import React, { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { Code2, ExternalLink, Loader2, Map as MapIcon, Maximize2, Minimize2, X } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { ChatSidebar } from './ChatSidebar';
import { ChatConversation } from './ChatConversation';
import { ChatModelPicker } from './ChatModelPicker';
import { ChatProjectModal } from './ChatProjectModal';
import { ChatSettingsModal } from './ChatSettingsModal';
import { listCustomAgents } from '../../services/chatAgents';
import { ChatPanelContext } from './panelContext';
import { MediaPanel, type MediaPanelData } from './MediaPanel';
import type { PlaygroundData } from './MultiFilePlayground';
import type { ChatArtifact, CodeStudioArtifact, MapArtifact } from '../../apiTypes';

const MapPanel = lazy(() => import('./MapPanel'));
const MultiFilePlayground = lazy(() => import('./MultiFilePlayground'));
const CodeStudioPanel = lazy(() => import('./CodeStudioPanel'));
import { deriveModelFeatures } from '../../services/chatFeatures';
import { getCapabilities } from '../../services/modelCapabilities';
import { fetchModelCatalog, type CatalogModel } from '../../services/modelCatalog';
import type { ChatReasoningLevel, ChatRequestMessage, ChatMessagePart, UniversalAssistantContext } from '../../apiTypes';
import type { Project } from '../../types';
import { sendChatMessageStream, runSwarmStream, updateChatMemory, friendlyChatError } from '../../services/chatApi';
import { runRecipe } from '../../services/recipes';
import type { ChatSkill } from '../../services/chatSkills';
import { gatherClientContext } from '../../services/clientContext';
import { toggleConnector, type ChatConnector } from '../../services/chatConnectors';
import { recommendModels, detectTools } from '../../services/chatSuggest';
import { isProviderEnabled } from '../../services/sourceGovernance';
import type { ModelSourceId } from '../../services/modelSelection';
import { listMcpServers, getMcpServersByIds, onMcpServersChanged } from '../../services/mcpServers';
import { recordToolEvents } from '../../services/toolAnalytics';
import { captureError } from '../../services/telemetry';
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
  listChatProjects,
  listChatSessions,
  saveChatProject,
  saveChatSession,
  setChatMemory,
  syncFromCloud,
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

const toRequestMessage = (turn: ChatTurn): ChatRequestMessage => {
  // Only image attachments go to the model; documents (PDFs) are viewer-only.
  const imageAtts = (turn.attachments || []).filter((a) => a.kind !== 'document');
  if (imageAtts.length > 0) {
    const parts: ChatMessagePart[] = [];
    if (turn.content) parts.push({ type: 'text', text: turn.content });
    for (const att of imageAtts) parts.push({ type: 'image_url', image_url: { url: att.dataUrl } });
    return { role: turn.role, content: parts };
  }
  return { role: turn.role, content: turn.content };
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
  error: v.error
});

const composeSystemPrompt = (memory: string, persona?: string): string | undefined => {
  const parts: string[] = [];
  if (persona && persona.trim()) parts.push(persona.trim());
  if (memory && memory.trim()) parts.push(`Durable facts to remember about the user:\n${memory.trim()}`);
  return parts.length ? parts.join('\n\n') : undefined;
};

export const AIChatPlatform: React.FC<AIChatPlatformProps> = ({ onBack, projects }) => {
  const { user } = useAuth();
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [projectsList, setProjectsList] = useState<ChatProject[]>([]);
  const [projectModal, setProjectModal] = useState<{ editing: ChatProject | null } | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
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
  const [initialized, setInitialized] = useState(false);
  const [memory, setMemory] = useState('');
  // Text to prefill the composer with (e.g. clicking a skill chip in the empty state).
  const [composerSeed, setComposerSeed] = useState('');
  const [settingsTab, setSettingsTab] = useState<'memory' | 'agents' | 'tools' | null>(null);
  const [customAgents, setCustomAgents] = useState(() => listCustomAgents());
  const [mcpServers, setMcpServers] = useState<McpServerConfig[]>(() => listMcpServers());
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

  useEffect(() => onMcpServersChanged(() => setMcpServers(listMcpServers())), []);

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
  useEffect(() => {
    let active = true;
    (async () => {
      // Best-effort cloud sync first (no-op until the chat_sync table exists / signed out).
      await syncFromCloud().catch(() => {});
      const [stored, storedProjects] = await Promise.all([listChatSessions(), listChatProjects()]);
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
        await saveChatSession(session);
        setSessions([session, ...stored]);
        setActiveId(session.id);
      } else if (stored.length > 0) {
        setSessions(stored);
        setActiveId(stored[0].id);
      } else {
        const session = createEmptySession();
        await saveChatSession(session);
        setSessions([session]);
        setActiveId(session.id);
      }
      setInitialized(true);
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
  }, [activeId]);

  const resolvedModel = activeSession?.modelId ? catalog.get(activeSession.modelId) || null : null;
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
    void saveChatSession(base);
    setSessions((prev) => [base, ...prev]);
    setActiveId(base.id);
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
    updateSession(id, (s) => ({ ...s, title, updatedAt: Date.now() }));
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

  const handleSelectAuto = (lockedSource: 'openrouter' | 'nvidia' | null) => {
    if (activeId) {
      updateSession(activeId, (s) => ({
        ...s,
        autoMode: true,
        lockedSource,
        modelId: null,
        modelName: lockedSource ? `Auto · ${lockedSource === 'openrouter' ? 'OpenRouter' : 'NVIDIA'}` : 'Auto',
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
        return isProviderEnabled(m.source);
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

    const setSessionState = (updater: (s: ChatSession) => ChatSession) =>
      setSessions((prev) => prev.map((s) => (s.id === sessionId ? updater(s) : s)));

    // Reuse the existing assistant turn (regenerate) or append a fresh placeholder.
    const aiTurnId = regenerateTurnId || crypto.randomUUID();
    if (regenerateTurnId) {
      setSessionState((s) => ({
        ...s,
        turns: s.turns.map((t) => (t.id === aiTurnId ? { ...t, content: '', reasoning: undefined, error: false } : t))
      }));
    } else {
      setSessionState((s) => ({
        ...s,
        turns: [...s.turns, { id: aiTurnId, role: 'assistant', content: '', createdAt: Date.now() }]
      }));
    }

    try {
      const reqMessages = baseTurns.filter((t) => !t.error).map(toRequestMessage);
      // Situational context (date/timezone/locale/units/coarse location) so the model
      // isn't flying blind on "today"/"latest"/"near me". Never prompts for permission.
      const clientContext = await gatherClientContext().catch(() => undefined);
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
          : await sendChatMessageStream(reqBody, { signal: controller.signal, onDelta, onReasoning, onReset });

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
            artifacts: res.artifacts,
            notices: res.notices,
            createdAt: Date.now()
          };
          const variants = [...(t.variants || []), variant];
          return { ...applyVariant(t, variant), variants, activeVariant: variants.length - 1 };
        }),
        updatedAt: Date.now()
      }));
      // Fold the tools that ran into local usage analytics (Settings → Tools).
      recordToolEvents(res.toolEvents);
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
        updateSession(sessionId, (s) => ({ ...s, updatedAt: Date.now() }));
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
        metadata: { turnId: aiTurnId }
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
            return { ...t, content: `${t.content}\n\n---\n*⚠️ Response interrupted: ${friendly}*` };
          }
          return {
            ...t,
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
      updatedAt: Date.now()
    }));

    await runGeneration({ sessionId, baseTurns, reqModel, reqSource, reqTools });
  };

  // Run a `/`-command skill: append a user turn showing the command, then stream the
  // matching recipe's result back into the conversation (same machinery as a normal turn).
  const handleRunSkill = async (skill: ChatSkill, arg: string) => {
    if (!activeSession || busy) return;
    const sessionId = activeSession.id;
    const display = `/${skill.command}${arg ? ` ${arg}` : ''}`;
    const userTurn: ChatTurn = {
      id: crypto.randomUUID(),
      role: 'user',
      content: display,
      createdAt: Date.now()
    };
    const isFirst = activeSession.turns.length === 0;
    const baseTurns = [...activeSession.turns, userTurn];
    updateSession(sessionId, (s) => ({
      ...s,
      turns: baseTurns,
      title: isFirst ? `${skill.label}: ${arg || skill.label}`.slice(0, 60) : s.title,
      updatedAt: Date.now()
    }));
    await runGeneration({
      sessionId,
      baseTurns,
      reqModel: activeSession.modelId || undefined,
      reqSource: activeSession.source || undefined,
      reqTools: [],
      recipeRun: { recipeId: skill.recipeId, values: skill.buildValues(arg) }
    });
  };

  // Click a skill chip: no-arg skills run immediately; otherwise prefill the composer
  // with the command so the user can type the argument.
  const handlePickSkill = (skill: ChatSkill) => {
    if (!skill.argRequired) {
      void handleRunSkill(skill, '');
      return;
    }
    setComposerSeed(`/${skill.command} `);
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

  if (!initialized || !activeSession) {
    return (
      <div className="h-[100dvh] flex items-center justify-center bg-slate-50">
        <Loader2 className="w-8 h-8 animate-spin text-brand-blue" />
      </div>
    );
  }

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
  const codeEditorHeight = panelFullscreen
    ? Math.max(480, Math.round(window.innerHeight * 0.75))
    : 520;

  const panelContent = panel && (
    <>
      <div
        className={`flex items-center justify-between px-3 py-2 border-b-2 border-black shrink-0 ${
          isCodeStudio ? 'bg-lime-100' : 'bg-sky-100'
        }`}
      >
        <span className="font-bold text-sm flex items-center gap-1.5 min-w-0">
          {isCodeStudio
            ? <Code2 className="w-4 h-4 shrink-0 text-lime-700" />
            : <MapIcon className="w-4 h-4 shrink-0" />}
          <span className="truncate">{panelTitle}</span>
        </span>
        <div className="flex items-center gap-1 shrink-0">
          {isCodeStudio && (
            <>
              <button
                onClick={handleOpenNewTab}
                title="Open static preview in new tab"
                className="border-2 border-black rounded p-1 bg-white hover:bg-lime-200"
              >
                <ExternalLink className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={() => setPanelFullscreen((v) => !v)}
                title={panelFullscreen ? 'Exit full screen' : 'Full screen'}
                className="border-2 border-black rounded p-1 bg-white hover:bg-lime-200"
              >
                {panelFullscreen
                  ? <Minimize2 className="w-3.5 h-3.5" />
                  : <Maximize2 className="w-3.5 h-3.5" />}
              </button>
            </>
          )}
          <button onClick={closePanel} className="border-2 border-black rounded p-1 bg-white hover:bg-brand-yellow">
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>
      <div className="flex-1 min-h-0 bg-slate-100">
        {panel.type === 'media' ? (
          <MediaPanel data={panel.data as MediaPanelData} />
        ) : (
          <Suspense fallback={<div className="flex items-center justify-center h-full"><Loader2 className="w-6 h-6 animate-spin text-brand-blue" /></div>}>
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
    <div className="h-[100dvh] flex overflow-hidden bg-white">
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
            onSelect={(id) => { setActiveId(id); closeOnMobile(); }}
            onNew={() => { handleNew(); closeOnMobile(); }}
            onDelete={handleDelete}
            onRename={handleRename}
            onMoveToProject={handleMoveToProject}
            onNewProject={() => setProjectModal({ editing: null })}
            onEditProject={(project) => setProjectModal({ editing: project })}
            onDeleteProject={handleDeleteProject}
            onEditMemory={handleEditMemory}
            onBack={onBack}
          />
        );
        if (isDesktop) return sidebar;
        return (
          <div className="fixed inset-0 z-40 flex md:hidden">
            <div className="absolute inset-0 bg-black/40 animate-fade-in" onClick={() => setSidebarOpen(false)} aria-hidden />
            <div className="relative z-10 h-full shadow-2xl animate-slide-in-left">{sidebar}</div>
          </div>
        );
      })()}

      <ChatConversation
        session={activeSession}
        features={features}
        busy={busy}
        sidebarOpen={sidebarOpen}
        onToggleSidebar={() => setSidebarOpen((v) => !v)}
        onOpenModelPicker={() => setShowModelPicker(true)}
        onSend={handleSend}
        onRunSkill={handleRunSkill}
        onPickSkill={handlePickSkill}
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
        onSwarmToggle={(on) =>
          activeId && updateSession(activeId, (s) => ({ ...s, swarm: on, updatedAt: Date.now() }))
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

      {/* Resizable side panel — sibling on desktop (unless fullscreen), overlay on mobile. */}
      {panel && isDesktop && !panelFullscreen && (
        <>
          <div onMouseDown={startResize} className="w-1.5 cursor-col-resize bg-black/10 hover:bg-brand-blue shrink-0" title="Drag to resize" />
          <div className="flex flex-col shrink-0 border-l-4 border-black bg-white" style={{ width: panelWidth }}>
            {panelContent}
          </div>
        </>
      )}
      {panel && (!isDesktop || panelFullscreen) && (
        <div className="fixed inset-0 z-50 flex flex-col bg-white">
          {panelContent}
        </div>
      )}

      {showModelPicker && (
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
          initialTab={settingsTab}
          onMemoryChange={setMemory}
          onAgentsChange={setCustomAgents}
          onClose={() => setSettingsTab(null)}
        />
      )}
    </div>
    </ChatPanelContext.Provider>
  );
};
