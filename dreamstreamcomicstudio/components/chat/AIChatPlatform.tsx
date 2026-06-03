import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { ChatSidebar } from './ChatSidebar';
import { ChatConversation } from './ChatConversation';
import { ChatModelPicker } from './ChatModelPicker';
import { deriveModelFeatures } from '../../services/chatFeatures';
import { getCapabilities } from '../../services/modelCapabilities';
import { fetchModelCatalog, type CatalogModel } from '../../services/modelCatalog';
import type { ChatReasoningLevel, ChatRequestMessage, ChatMessagePart, UniversalAssistantContext } from '../../apiTypes';
import type { Project } from '../../types';
import { sendChatMessage } from '../../services/chatApi';
import {
  branchSession,
  consumePendingChatModel,
  createEmptySession,
  deleteChatSession,
  deriveSessionTitle,
  getChatMemory,
  listChatSessions,
  saveChatSession,
  setChatMemory,
  type ChatAttachment,
  type ChatSession,
  type ChatTurn
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
  if (turn.attachments && turn.attachments.length > 0) {
    const parts: ChatMessagePart[] = [];
    if (turn.content) parts.push({ type: 'text', text: turn.content });
    for (const att of turn.attachments) parts.push({ type: 'image_url', image_url: { url: att.dataUrl } });
    return { role: turn.role, content: parts };
  }
  return { role: turn.role, content: turn.content };
};

const composeSystemPrompt = (memory: string, persona?: string): string | undefined => {
  const parts: string[] = [];
  if (persona && persona.trim()) parts.push(persona.trim());
  if (memory && memory.trim()) parts.push(`Durable facts to remember about the user:\n${memory.trim()}`);
  return parts.length ? parts.join('\n\n') : undefined;
};

export const AIChatPlatform: React.FC<AIChatPlatformProps> = ({ onBack, projects }) => {
  const { user } = useAuth();
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<Map<string, CatalogModel>>(new Map());
  const [busy, setBusy] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [showModelPicker, setShowModelPicker] = useState(false);
  const [initialized, setInitialized] = useState(false);
  const [memory, setMemory] = useState('');
  const abortRef = useRef<AbortController | null>(null);

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
      const stored = await listChatSessions();
      if (!active) return;
      setMemory(getChatMemory(user?.id));

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

  const resolvedModel = activeSession?.modelId ? catalog.get(activeSession.modelId) || null : null;
  const features = useMemo(() => deriveModelFeatures(resolvedModel), [resolvedModel]);

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
            webSearch: activeSession.webSearch
          }
        : {}
    );
    void saveChatSession(base);
    setSessions((prev) => [base, ...prev]);
    setActiveId(base.id);
  };

  const handleDelete = (id: string) => {
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

  const handleSelectModel = (model: CatalogModel) => {
    setCatalog((prev) => (prev.has(model.id) ? prev : new Map(prev).set(model.id, model)));
    const supportsReasoning = getCapabilities(model).reasoning;
    if (activeId) {
      updateSession(activeId, (s) => ({
        ...s,
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

  const handleBranch = (turnId: string) => {
    if (!activeSession) return;
    const branched = branchSession(activeSession, turnId);
    void saveChatSession(branched);
    setSessions((prev) => [branched, ...prev]);
    setActiveId(branched.id);
  };

  const handleEditMemory = () => {
    const next = window.prompt(
      'Memory — durable facts the AI should remember in every chat (e.g. your name, preferences, projects):',
      memory
    );
    if (next !== null) {
      setChatMemory(next, user?.id);
      setMemory(next);
    }
  };

  const handleStop = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    setBusy(false);
  };

  const handleSend = async (text: string, attachments: ChatAttachment[]) => {
    if (!activeSession || busy) return;
    if (!text && attachments.length === 0) return;

    const sessionId = activeSession.id;
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

    setBusy(true);
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const reqMessages = baseTurns.filter((t) => !t.error).map(toRequestMessage);
      const res = await sendChatMessage(
        {
          messages: reqMessages,
          model: activeSession.modelId || undefined,
          source: activeSession.source || undefined,
          reasoningLevel: activeSession.reasoningLevel,
          webSearch: activeSession.webSearch,
          systemPrompt: composeSystemPrompt(getChatMemory(user?.id), activeSession.systemPrompt),
          ...(activeSession.dreamstreamAccess ? { dreamstreamContext: buildDreamStreamContext(projects) } : {})
        },
        { signal: controller.signal }
      );

      const aiTurn: ChatTurn = {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: res.text || '(no response)',
        model: res.model,
        reasoningLevel: res.reasoningLevel,
        webSearch: res.webSearch,
        createdAt: Date.now()
      };
      updateSession(sessionId, (s) => ({ ...s, turns: [...s.turns, aiTurn], updatedAt: Date.now() }));
    } catch (err) {
      if (controller.signal.aborted) return;
      const errTurn: ChatTurn = {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: `**Couldn't complete that.** ${(err as Error)?.message || 'The request failed. Check your API key in Settings → API Configuration and try again.'}`,
        error: true,
        createdAt: Date.now()
      };
      updateSession(sessionId, (s) => ({ ...s, turns: [...s.turns, errTurn], updatedAt: Date.now() }));
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      setBusy(false);
    }
  };

  if (!initialized || !activeSession) {
    return (
      <div className="h-[calc(100vh-73px)] flex items-center justify-center bg-slate-50">
        <Loader2 className="w-8 h-8 animate-spin text-brand-blue" />
      </div>
    );
  }

  return (
    <div className="h-[calc(100vh-73px)] flex overflow-hidden bg-white">
      {sidebarOpen && (
        <ChatSidebar
          sessions={sessions}
          activeId={activeId}
          hasMemory={Boolean(memory.trim())}
          onSelect={setActiveId}
          onNew={handleNew}
          onDelete={handleDelete}
          onRename={handleRename}
          onEditMemory={handleEditMemory}
          onBack={onBack}
        />
      )}

      <ChatConversation
        session={activeSession}
        features={features}
        busy={busy}
        sidebarOpen={sidebarOpen}
        onToggleSidebar={() => setSidebarOpen((v) => !v)}
        onOpenModelPicker={() => setShowModelPicker(true)}
        onSend={handleSend}
        onStop={handleStop}
        onBranch={handleBranch}
        onReasoningChange={(level) =>
          activeId && updateSession(activeId, (s) => ({ ...s, reasoningLevel: level, updatedAt: Date.now() }))
        }
        onWebToggle={(on) =>
          activeId && updateSession(activeId, (s) => ({ ...s, webSearch: on, updatedAt: Date.now() }))
        }
        onDreamstreamToggle={(on) =>
          activeId && updateSession(activeId, (s) => ({ ...s, dreamstreamAccess: on, updatedAt: Date.now() }))
        }
      />

      {showModelPicker && (
        <ChatModelPicker
          selectedModelId={activeSession.modelId}
          onSelect={handleSelectModel}
          onClose={() => setShowModelPicker(false)}
        />
      )}
    </div>
  );
};
