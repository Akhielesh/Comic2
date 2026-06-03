import React, { useEffect, useRef } from 'react';
import { PanelLeftOpen, PanelLeftClose, ChevronDown, Sparkles, Cpu } from 'lucide-react';
import type { ChatSession, ChatAttachment } from '../../services/chatStorage';
import type { ChatReasoningLevel } from '../../apiTypes';
import type { ChatModelFeatures } from '../../services/chatFeatures';
import { ChatMessageView } from './ChatMessageView';
import { ChatComposer } from './ChatComposer';

interface ChatConversationProps {
  session: ChatSession;
  features: ChatModelFeatures;
  busy: boolean;
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  onOpenModelPicker: () => void;
  onSend: (text: string, attachments: ChatAttachment[]) => void;
  onStop: () => void;
  onBranch: (turnId: string) => void;
  onReasoningChange: (level: ChatReasoningLevel) => void;
  onWebToggle: (on: boolean) => void;
  onDreamstreamToggle: (on: boolean) => void;
}

const SUGGESTIONS = [
  'Compare three options in a Markdown table',
  'Explain a concept with a code example',
  'Draft a plan with numbered steps',
  'Summarize the latest on a topic (turn on Web)'
];

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
  onReasoningChange,
  onWebToggle,
  onDreamstreamToggle
}) => {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [session.turns.length, busy]);

  const modelLabel = session.modelName || session.modelId || 'Auto (free)';

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
          className="flex items-center gap-2 border-2 border-black rounded-lg px-3 py-1.5 bg-white hover:bg-slate-50 min-w-0"
          title="Switch model"
        >
          <Cpu className="w-4 h-4 shrink-0 text-brand-blue" />
          <span className="font-bold text-sm truncate max-w-[200px]">{modelLabel}</span>
          <ChevronDown className="w-4 h-4 shrink-0 text-slate-500" />
        </button>

        <div className="ml-auto hidden sm:flex items-center gap-1.5 text-[11px] text-slate-500">
          {session.dreamstreamAccess && <span className="px-1.5 py-0.5 rounded border-2 border-black bg-brand-yellow font-bold text-black">DreamStream</span>}
          {features.vision && <span className="px-1.5 py-0.5 rounded border border-slate-300">Vision</span>}
          {features.reasoning && <span className="px-1.5 py-0.5 rounded border border-slate-300">Reasoning</span>}
          {features.longContext && <span className="px-1.5 py-0.5 rounded border border-slate-300">Long ctx</span>}
        </div>
      </div>

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-5 space-y-5 bg-slate-50">
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
          </div>
        ) : (
          session.turns.map((turn) => (
            <ChatMessageView
              key={turn.id}
              turn={turn}
              onBranch={turn.role === 'assistant' && !turn.error ? () => onBranch(turn.id) : undefined}
            />
          ))
        )}

        {busy && (
          <div className="flex gap-3">
            <div className="shrink-0 w-9 h-9 rounded-full border-2 border-black bg-brand-yellow flex items-center justify-center">
              <Sparkles className="w-4 h-4" />
            </div>
            <div className="border-2 border-black rounded-xl px-4 py-3 shadow-comic bg-slate-50 flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-slate-400 animate-bounce" style={{ animationDelay: '0ms' }} />
              <span className="w-2 h-2 rounded-full bg-slate-400 animate-bounce" style={{ animationDelay: '150ms' }} />
              <span className="w-2 h-2 rounded-full bg-slate-400 animate-bounce" style={{ animationDelay: '300ms' }} />
            </div>
          </div>
        )}
      </div>

      <ChatComposer
        busy={busy}
        features={features}
        reasoningLevel={session.reasoningLevel}
        webSearch={session.webSearch}
        dreamstreamAccess={session.dreamstreamAccess}
        onReasoningChange={onReasoningChange}
        onWebToggle={onWebToggle}
        onDreamstreamToggle={onDreamstreamToggle}
        onSend={onSend}
        onStop={onStop}
      />
    </div>
  );
};
