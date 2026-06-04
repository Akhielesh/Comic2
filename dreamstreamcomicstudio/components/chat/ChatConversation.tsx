import React, { useEffect, useMemo, useRef, useState } from 'react';
import { PanelLeftOpen, PanelLeftClose, ChevronDown, Sparkles, Cpu, Pencil, Check, X, Bug, Hash, Braces, Copy } from 'lucide-react';
import type { ChatSession, ChatAttachment } from '../../services/chatStorage';
import { serializeDebugBundle } from '../../services/chatDebug';
import type { ChatReasoningLevel } from '../../apiTypes';
import type { ChatModelFeatures } from '../../services/chatFeatures';
import type { ChatConnector } from '../../services/chatConnectors';
import type { CatalogModel } from '../../services/modelCatalog';
import type { McpServerConfig } from '../../apiTypes';
import { estimateTokens } from '../../services/chatUtils';
import { ChatMessageView } from './ChatMessageView';
import { ChatComposer } from './ChatComposer';
import { ChatContextMeter } from './ChatContextMeter';
import { ChatModelSuggester } from './ChatModelSuggester';

interface ChatConversationProps {
  session: ChatSession;
  features: ChatModelFeatures;
  busy: boolean;
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  onOpenModelPicker: () => void;
  onSend: (text: string, attachments: ChatAttachment[]) => void;
  onStop: () => void;
  onBranch: (turnId: string, chooseNewModel: boolean) => void;
  onRegenerate: (turnId: string) => void;
  onEditUserMessage: (turnId: string, newText: string) => void;
  onSelectVariant: (turnId: string, index: number) => void;
  onReasoningChange: (level: ChatReasoningLevel) => void;
  onWebToggle: (on: boolean) => void;
  onSwarmToggle: (on: boolean) => void;
  onDreamstreamToggle: (on: boolean) => void;
  onToggleConnector: (connector: ChatConnector, on: boolean) => void;
  mcpServers: McpServerConfig[];
  onToggleMcpServer: (id: string, on: boolean) => void;
  onRenameTitle: (title: string) => void;
  /** Catalog (text models) for the "help me pick" suggester in the empty state. */
  suggestModels: CatalogModel[];
  onStartWithModel: (model: CatalogModel, goal: string) => void;
}

const SUGGESTIONS = [
  'Compare three options in a Markdown table',
  'Explain a concept with a code example',
  'Draft a plan with numbered steps',
  'Summarize the latest on a topic (turn on Web)'
];

// "Copy debug" menu: hand a chat off for analysis without copying the whole
// transcript. "Copy chat ID" copies the short id (resolvable from chat_sync);
// "Copy debug bundle" copies structured JSON of what happened each turn (model
// used vs. requested, tool runs, notices/errors, artifacts).
const ChatDebugMenu: React.FC<{ session: ChatSession }> = ({ session }) => {
  const [open, setOpen] = useState(false);
  const [done, setDone] = useState<'id' | 'bundle' | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const copy = async (kind: 'id' | 'bundle') => {
    try {
      await navigator.clipboard.writeText(kind === 'id' ? session.id : serializeDebugBundle(session));
      setDone(kind);
      setTimeout(() => setDone(null), 1500);
    } catch {
      /* clipboard unavailable */
    }
    setOpen(false);
  };

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        title="Copy chat ID / debug bundle"
        aria-label="Copy debug info"
        className="flex items-center gap-1 rounded-lg border-2 border-black/15 px-1.5 py-1 text-slate-500 transition-colors hover:border-black/40 hover:text-black"
      >
        {done ? <Check className="h-3.5 w-3.5 text-green-600" /> : <Bug className="h-3.5 w-3.5" />}
      </button>
      {open && (
        <div className="absolute right-0 z-30 mt-1 w-52 overflow-hidden rounded-lg border-2 border-black bg-white shadow-comic animate-fade-in">
          <button onClick={() => copy('id')} className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-bold hover:bg-brand-yellow/30">
            <Hash className="h-3.5 w-3.5 shrink-0" /> Copy chat ID
          </button>
          <button onClick={() => copy('bundle')} className="flex w-full items-center gap-2 border-t border-black/10 px-3 py-2 text-left text-xs font-bold hover:bg-brand-yellow/30">
            <Braces className="h-3.5 w-3.5 shrink-0" /> Copy debug bundle
            <span className="ml-auto"><Copy className="h-3 w-3 text-slate-400" /></span>
          </button>
          <div className="border-t border-black/10 bg-slate-50 px-3 py-1.5 text-[10px] leading-snug text-slate-500">
            Paste either into a dev chat to analyze what happened.
          </div>
        </div>
      )}
    </div>
  );
};

export const ChatConversation: React.FC<ChatConversationProps> = ({
  session,
  features,
  busy,
  sidebarOpen,
  onToggleSidebar,
  onOpenModelPicker,
  onSend,
  onStop,
  onBranch,
  onRegenerate,
  onEditUserMessage,
  onSelectVariant,
  onReasoningChange,
  onWebToggle,
  onSwarmToggle,
  onDreamstreamToggle,
  onToggleConnector,
  mcpServers,
  onToggleMcpServer,
  onRenameTitle,
  suggestModels,
  onStartWithModel
}) => {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState(session.title);
  const [atBottom, setAtBottom] = useState(true);

  // Consider "at bottom" when within 120px of the end, so we don't yank the view
  // up while the user is reading scrollback.
  const isNearBottom = (el: HTMLDivElement) => el.scrollHeight - el.scrollTop - el.clientHeight < 120;

  const scrollToBottom = (behavior: ScrollBehavior = 'smooth') => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior });
  };

  // Track scroll position to toggle the "jump to latest" button.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => setAtBottom(isNearBottom(el));
    el.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  // Auto-scroll on new content only when the user is already near the bottom.
  const lastTurnContent = session.turns[session.turns.length - 1]?.content;
  useEffect(() => {
    const el = scrollRef.current;
    if (el && isNearBottom(el)) scrollToBottom();
  }, [session.turns.length, lastTurnContent, busy]);

  const modelLabel = session.modelName || session.modelId || 'Auto (free)';

  const usedTokens = useMemo(
    () => session.turns.reduce((sum, t) => sum + estimateTokens(t.content) + (t.attachments?.length || 0) * 800, 0),
    [session.turns]
  );

  const commitTitle = () => {
    const next = titleDraft.trim();
    if (next && next !== session.title) onRenameTitle(next);
    setEditingTitle(false);
  };

  return (
    <div className="flex-1 flex flex-col min-w-0 h-full">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3 border-b-4 border-black bg-white">
        <button
          onClick={onToggleSidebar}
          className="border-2 border-black rounded-lg p-1.5 bg-white hover:bg-brand-yellow"
          title={sidebarOpen ? 'Hide chats' : 'Show chats'}
        >
          {sidebarOpen ? <PanelLeftClose className="w-4 h-4" /> : <PanelLeftOpen className="w-4 h-4" />}
        </button>

        <button
          onClick={onOpenModelPicker}
          className="flex items-center gap-2 border-2 border-black rounded-lg px-3 py-1.5 bg-white hover:bg-slate-50 min-w-0 shrink-0"
          title="Switch model"
        >
          <Cpu className="w-4 h-4 shrink-0 text-brand-blue" />
          <span className="font-bold text-sm truncate max-w-[180px]">{modelLabel}</span>
          <ChevronDown className="w-4 h-4 shrink-0 text-slate-500" />
        </button>

        {/* Editable session title */}
        <div className="flex-1 min-w-0 hidden sm:flex items-center">
          {editingTitle ? (
            <div className="flex items-center gap-1 w-full max-w-sm">
              <input
                autoFocus
                value={titleDraft}
                onChange={(e) => setTitleDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitTitle();
                  if (e.key === 'Escape') setEditingTitle(false);
                }}
                className="flex-1 min-w-0 text-sm font-bold border-2 border-black rounded px-2 py-1 outline-none"
              />
              <button onClick={commitTitle} className="text-green-600 hover:scale-110"><Check className="w-4 h-4" /></button>
              <button onClick={() => setEditingTitle(false)} className="text-slate-500 hover:scale-110"><X className="w-4 h-4" /></button>
            </div>
          ) : (
            <button
              onClick={() => { setTitleDraft(session.title); setEditingTitle(true); }}
              className="group flex items-center gap-1.5 min-w-0 text-slate-700 hover:text-black"
              title="Rename this chat"
            >
              <span className="font-bold text-sm truncate">{session.title}</span>
              <Pencil className="w-3.5 h-3.5 shrink-0 opacity-0 group-hover:opacity-100" />
            </button>
          )}
        </div>

        <div className="ml-auto flex items-center gap-2 shrink-0">
          <ChatDebugMenu session={session} />
          <ChatContextMeter usedTokens={usedTokens} contextLength={features.contextLength} features={features} />
          <div className="hidden lg:flex items-center gap-1.5 text-[11px] text-slate-500">
            {session.dreamstreamAccess && <span className="px-1.5 py-0.5 rounded border-2 border-black bg-brand-yellow font-bold text-black">DreamStream</span>}
            {features.vision && <span className="px-1.5 py-0.5 rounded border border-slate-300">Vision</span>}
            {features.reasoning && <span className="px-1.5 py-0.5 rounded border border-slate-300">Reasoning</span>}
          </div>
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 relative min-h-0">
      <div ref={scrollRef} className="absolute inset-0 overflow-y-auto px-4 py-5 space-y-5 bg-slate-50">
        {session.turns.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-center max-w-md mx-auto">
            <div className="w-16 h-16 rounded-2xl border-4 border-black bg-brand-yellow flex items-center justify-center shadow-comic mb-4">
              <Sparkles className="w-8 h-8" />
            </div>
            <h2 className="font-display text-3xl mb-1">AI Chat</h2>
            <p className="text-slate-600 text-sm mb-5">
              Chat with <span className="font-bold">{modelLabel}</span>. Ask anything — answers render with
              tables, code, links and images. Switch models anytime.
            </p>
            <div className="grid sm:grid-cols-2 gap-2 w-full">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  onClick={() => onSend(s, [])}
                  className="text-left text-xs font-semibold border-2 border-black rounded-lg px-3 py-2 bg-white shadow-comic hover:bg-brand-yellow/40 hover:translate-y-[1px]"
                >
                  {s}
                </button>
              ))}
            </div>

            <div className="w-full mt-4 flex flex-col items-center">
              <ChatModelSuggester models={suggestModels} onStart={onStartWithModel} />
            </div>
          </div>
        ) : (
          session.turns.map((turn, i) => (
            <ChatMessageView
              key={turn.id}
              turn={turn}
              busy={busy}
              onBranch={turn.role === 'assistant' && !turn.error ? (chooseNew) => onBranch(turn.id, chooseNew) : undefined}
              onRegenerate={turn.role === 'assistant' ? () => onRegenerate(turn.id) : undefined}
              onEdit={turn.role === 'user' ? (text) => onEditUserMessage(turn.id, text) : undefined}
              onSelectVariant={(index) => onSelectVariant(turn.id, index)}
              isLast={i === session.turns.length - 1}
            />
          ))
        )}

      </div>

      {/* Jump-to-latest button — appears when scrolled away from the bottom. */}
      {!atBottom && session.turns.length > 0 && (
        <button
          onClick={() => scrollToBottom()}
          className="absolute bottom-4 left-1/2 -translate-x-1/2 z-10 flex items-center gap-1 border-2 border-black rounded-full bg-white shadow-comic px-3 py-1.5 text-xs font-bold hover:bg-brand-yellow animate-fade-in"
          title="Jump to latest"
        >
          <ChevronDown className="w-4 h-4" /> Latest
        </button>
      )}
      </div>

      <ChatComposer
        busy={busy}
        features={features}
        reasoningLevel={session.reasoningLevel}
        webSearch={session.webSearch}
        swarm={Boolean(session.swarm)}
        swarmSupported={session.source !== 'nvidia'}
        dreamstreamAccess={session.dreamstreamAccess}
        enabledTools={session.tools}
        toolsSupported={session.source !== 'nvidia'}
        mcpServers={mcpServers}
        enabledMcpServers={session.mcpServers || []}
        onReasoningChange={onReasoningChange}
        onWebToggle={onWebToggle}
        onSwarmToggle={onSwarmToggle}
        onDreamstreamToggle={onDreamstreamToggle}
        onToggleConnector={onToggleConnector}
        onToggleMcpServer={onToggleMcpServer}
        onSend={onSend}
        onStop={onStop}
      />
    </div>
  );
};
