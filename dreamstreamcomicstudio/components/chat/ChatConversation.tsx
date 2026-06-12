import React, { useEffect, useMemo, useRef, useState } from 'react';
import { PanelLeftOpen, PanelLeftClose, ChevronDown, Sparkles, Cpu, Pencil, Check, X, Hash, Braces } from 'lucide-react';
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
import { CHAT_SKILLS, type ChatSkill } from '../../services/chatSkills';
import { ChatContextMeter } from './ChatContextMeter';
import { ChatModelSuggester } from './ChatModelSuggester';
import { FollowUpChips } from './FollowUpChips';
import {
  CANVAS_BG, GLASS, HAIRLINE, MENU, MUTED, INK, LABEL, TRANSITION, SHADOW_SOFT,
  CONTROL_BTN, PILL, HEADING, ACCENT_TEXT, ACCENT_SOFT_BG, HOVER_LIFT
} from './studioDesign';

interface ChatConversationProps {
  session: ChatSession;
  features: ChatModelFeatures;
  busy: boolean;
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  onOpenModelPicker: () => void;
  onSend: (text: string, attachments: ChatAttachment[]) => void;
  onRunSkill: (skill: ChatSkill, arg: string) => void;
  /** Click a skill suggestion → prefill the composer with its command. */
  onPickSkill: (skill: ChatSkill) => void;
  seedText?: string;
  onSeedConsumed?: () => void;
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

// Copy a chat handle for support/analysis. The PRIMARY action copies just the short
// session ID (one click) — that alone is enough to look the chat up. The big JSON
// debug bundle is a discreet secondary (the caret), for when the chat isn't synced.
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
    <div ref={ref} className="relative flex items-center">
      {/* Primary: copy the short session ID */}
      <button
        onClick={() => copy('id')}
        title={`Copy chat ID (${session.id})`}
        aria-label="Copy chat ID"
        className={`flex items-center gap-1 rounded-l-xl border border-r-0 border-[var(--ds-hairline)] bg-[var(--ds-surface-soft)] px-2 py-1.5 sm:py-1 text-[11px] font-semibold ${MUTED} ${TRANSITION} hover:bg-[var(--ds-hover)] hover:text-[var(--ds-ink)]`}
      >
        {done === 'id' ? <Check className="h-3.5 w-3.5 text-green-600" /> : <Hash className="h-3.5 w-3.5" />}
        {done === 'id' ? 'Copied' : 'ID'}
      </button>
      {/* Secondary: the full debug bundle */}
      <button
        onClick={() => setOpen((v) => !v)}
        title="More copy options"
        aria-label="More copy options"
        className={`flex items-center rounded-r-xl border border-[var(--ds-hairline)] bg-[var(--ds-surface-soft)] px-1.5 sm:px-1 py-1.5 sm:py-1 ${MUTED} ${TRANSITION} hover:bg-[var(--ds-hover)] hover:text-[var(--ds-ink)]`}
      >
        <ChevronDown className="h-3.5 w-3.5" />
      </button>
      {open && (
        <div className={`absolute right-0 top-full z-30 mt-1 w-56 overflow-hidden ${MENU} animate-fade-in`}>
          <button onClick={() => copy('id')} className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-semibold hover:bg-[var(--ds-hover)]">
            <Hash className="h-3.5 w-3.5 shrink-0" /> Copy chat ID
          </button>
          <button onClick={() => copy('bundle')} className="flex w-full items-center gap-2 border-t border-[var(--ds-hairline)] px-3 py-2 text-left text-xs font-semibold hover:bg-[var(--ds-hover)]">
            <Braces className="h-3.5 w-3.5 shrink-0" /> Copy full debug bundle
            <span className="ml-auto text-[9px] font-normal text-[var(--ds-muted)]">large</span>
          </button>
          <div className={`border-t border-[var(--ds-hairline)] bg-[var(--ds-well)] px-3 py-1.5 text-[10px] leading-snug ${MUTED}`}>
            The ID alone is enough to look up a synced chat. The bundle is for unsynced chats.
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
  onRunSkill,
  onPickSkill,
  seedText,
  onSeedConsumed,
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

  // Track scroll position to toggle the "jump to latest" button, AND remember the
  // reading position per session (sessionStorage). Tab switches / window changes can
  // remount this component — without the restore below, returning to the tab dumped
  // the user at the top of the thread instead of where they left off.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      const nearBottom = isNearBottom(el);
      setAtBottom(nearBottom);
      try {
        const store = JSON.parse(window.sessionStorage.getItem('ds.chat.scroll.v1') ?? '{}') as Record<string, number | 'bottom'>;
        store[session.id] = nearBottom ? 'bottom' : el.scrollTop;
        window.sessionStorage.setItem('ds.chat.scroll.v1', JSON.stringify(store));
      } catch {
        /* private mode — position just isn't remembered */
      }
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
    return () => el.removeEventListener('scroll', onScroll);
  }, [session.id]);

  // On mount / session switch: restore the saved reading position ("where I left off").
  // Unsaved (first open) defaults to the latest message.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let saved: number | 'bottom' | undefined;
    try {
      saved = (JSON.parse(window.sessionStorage.getItem('ds.chat.scroll.v1') ?? '{}') as Record<string, number | 'bottom'>)[session.id];
    } catch {
      saved = undefined;
    }
    if (typeof saved === 'number') el.scrollTo({ top: saved, behavior: 'auto' });
    else scrollToBottom('auto');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id]);

  // Auto-scroll on new content only when the user is already near the bottom.
  const lastTurnContent = session.turns[session.turns.length - 1]?.content;
  useEffect(() => {
    const el = scrollRef.current;
    if (el && isNearBottom(el)) scrollToBottom();
  }, [session.turns.length, lastTurnContent, busy]);

  // Keyboard handling (phones): when the on-screen keyboard opens/closes the visual
  // viewport resizes — keep the thread pinned to the latest message if the user was
  // already at the bottom, so the conversation doesn't end up "stuck" behind the
  // keyboard mid-thread.
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const onResize = () => {
      const el = scrollRef.current;
      if (el && isNearBottom(el)) scrollToBottom('auto');
    };
    vv.addEventListener('resize', onResize);
    return () => vv.removeEventListener('resize', onResize);
  }, []);

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
    <div className={`flex-1 flex flex-col min-w-0 min-h-0 h-full ${CANVAS_BG}`}>
      {/* Header. `relative z-20` is load-bearing: GLASS's backdrop-blur creates a
          stacking context, and without an explicit z-index the positioned messages
          container below paints OVER the header's dropdowns (session/debug menu,
          context meter popover) — they open but appear "covered" by the thread. */}
      <div className={`relative z-20 flex items-center gap-2 sm:gap-3 px-3 sm:px-4 py-3 border-b border-[var(--ds-hairline)] ${GLASS}`}>
        <button
          onClick={onToggleSidebar}
          className={`${CONTROL_BTN} p-2 sm:p-1.5 tap-target`}
          title={sidebarOpen ? 'Hide chats' : 'Show chats'}
        >
          {sidebarOpen ? <PanelLeftClose className="w-4 h-4" /> : <PanelLeftOpen className="w-4 h-4" />}
        </button>

        <button
          onClick={onOpenModelPicker}
          className={`flex items-center gap-2 ${CONTROL_BTN} px-3 py-2 sm:py-1.5 min-w-0`}
          title="Switch model"
        >
          <Cpu className={`w-4 h-4 shrink-0 ${ACCENT_TEXT}`} />
          <span className={`font-semibold text-sm truncate max-w-[120px] sm:max-w-[180px] ${INK}`}>{modelLabel}</span>
          <ChevronDown className="w-4 h-4 shrink-0 text-[var(--ds-muted)]" />
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
                className={`flex-1 min-w-0 text-sm font-semibold ${HAIRLINE} rounded-xl bg-[var(--ds-surface-soft)] px-2 py-1 outline-none focus:border-[#D97757]/40`}
              />
              <button onClick={commitTitle} className="text-green-600 hover:scale-110"><Check className="w-4 h-4" /></button>
              <button onClick={() => setEditingTitle(false)} className="text-[var(--ds-muted)] hover:scale-110"><X className="w-4 h-4" /></button>
            </div>
          ) : (
            <button
              onClick={() => { setTitleDraft(session.title); setEditingTitle(true); }}
              className={`group flex items-center gap-1.5 min-w-0 ${MUTED} hover:text-[var(--ds-ink)] ${TRANSITION}`}
              title="Rename this chat"
            >
              <span className="font-semibold text-sm truncate">{session.title}</span>
              <Pencil className="w-3.5 h-3.5 shrink-0 hover-reveal" />
            </button>
          )}
        </div>

        <div className="ml-auto flex items-center gap-2 shrink-0">
          <ChatDebugMenu session={session} />
          <ChatContextMeter usedTokens={usedTokens} contextLength={features.contextLength} features={features} />
          <div className={`hidden lg:flex items-center gap-1.5 text-[11px] ${MUTED}`}>
            {session.dreamstreamAccess && <span className={`px-1.5 py-0.5 rounded-full ${HAIRLINE} ${ACCENT_SOFT_BG} font-semibold ${ACCENT_TEXT}`}>DreamStream</span>}
            {features.vision && <span className={`px-1.5 py-0.5 rounded-full ${HAIRLINE}`}>Vision</span>}
            {features.reasoning && <span className={`px-1.5 py-0.5 rounded-full ${HAIRLINE}`}>Reasoning</span>}
          </div>
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 relative min-h-0">
      {/* Thread is the ONLY vertical scroller; overscroll-contain stops the rubber-band
          from bleeding into the page, overflow-x-hidden stops wide artifacts/code from
          causing page-level horizontal scroll on phones. */}
      <div
        ref={scrollRef}
        className={`absolute inset-0 overflow-y-auto overflow-x-hidden overscroll-contain [-webkit-overflow-scrolling:touch] px-3 sm:px-4 py-5 space-y-5 ${CANVAS_BG}`}
      >
        {session.turns.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-center max-w-md mx-auto">
            <div className={`w-16 h-16 ${GLASS} ${HAIRLINE} ${SHADOW_SOFT} rounded-2xl flex items-center justify-center mb-4`}>
              <Sparkles className={`w-8 h-8 ${ACCENT_TEXT}`} />
            </div>
            <h2 className={`text-3xl ${HEADING} mb-1`}>Chat Studio</h2>
            <p className={`${MUTED} text-sm mb-5`}>
              Chat with <span className={`font-semibold ${INK}`}>{modelLabel}</span>. Ask anything — answers render with
              tables, code, links and images. Switch models anytime.
            </p>
            <div className="grid sm:grid-cols-2 gap-2 w-full">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  onClick={() => onSend(s, [])}
                  className={`text-left text-xs font-medium ${GLASS} ${HAIRLINE} ${SHADOW_SOFT} rounded-xl px-3 py-2 ${TRANSITION} hover:bg-[var(--ds-raised)] ${HOVER_LIFT}`}
                >
                  {s}
                </button>
              ))}
            </div>

            {/* Skills: type `/` in the box, or tap one to get started. */}
            <div className="w-full mt-4">
              <div className={`mb-1.5 ${LABEL}`}>
                Skills — type <code className="rounded bg-[var(--ds-well-strong)] px-1">/</code> in the box
              </div>
              <div className="flex flex-wrap justify-center gap-1.5">
                {CHAT_SKILLS.slice(0, 7).map((s) => (
                  <button
                    key={s.command}
                    onClick={() => onPickSkill(s)}
                    title={s.description}
                    className={`flex items-center gap-1 ${PILL} px-2.5 py-1 text-[11px] font-medium hover:bg-[var(--ds-raised)] ${HOVER_LIFT}`}
                  >
                    <span>{s.emoji}</span> /{s.command}
                  </button>
                ))}
              </div>
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
              sessionId={session.id}
              busy={busy}
              onBranch={turn.role === 'assistant' && !turn.error ? (chooseNew) => onBranch(turn.id, chooseNew) : undefined}
              onRegenerate={turn.role === 'assistant' ? () => onRegenerate(turn.id) : undefined}
              onEdit={turn.role === 'user' ? (text) => onEditUserMessage(turn.id, text) : undefined}
              onSelectVariant={(index) => onSelectVariant(turn.id, index)}
              isLast={i === session.turns.length - 1}
            />
          ))
        )}

        {/* Proactive follow-up suggestions after the latest completed answer. */}
        {session.turns.length > 0 && (
          <FollowUpChips session={session} busy={busy} onSend={(text) => onSend(text, [])} />
        )}

      </div>

      {/* Jump-to-latest — a quiet arrow-only button; hidden whenever the user is
          already reading the latest part of the thread. */}
      {!atBottom && session.turns.length > 0 && (
        <button
          onClick={() => scrollToBottom()}
          className={`absolute bottom-4 left-1/2 -translate-x-1/2 z-10 flex h-9 w-9 items-center justify-center rounded-full ${PILL} ${SHADOW_SOFT} hover:bg-[var(--ds-raised)] animate-fade-in`}
          title="Jump to latest"
          aria-label="Jump to latest"
        >
          <ChevronDown className="w-4 h-4" />
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
        onRunSkill={onRunSkill}
        seedText={seedText}
        onSeedConsumed={onSeedConsumed}
        onStop={onStop}
      />
    </div>
  );
};
