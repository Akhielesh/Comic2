import React, { useEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { AlertTriangle, Bot, BookmarkPlus, Check, RotateCcw, Send, Sparkles, X } from 'lucide-react';
import { AssistantMessage, AssistantLimitInfo, UniversalAssistantContext } from '../apiTypes';
import { DictationButton } from './chat/DictationButton';
import { ReadReplyAloud } from './chat/ReadReplyAloud';
import { MessageCard } from './MessageCard';
import { queryUniversalAssistant } from '../services/geminiService';
import { ApiError } from '../services/apiClient';
import { Project } from '../types';
import { buildProjectSnapshot, summarizeAllProjects, summarizeProject } from '../services/assistantContext';
import { loadArtifactsForProject } from '../services/db';
import { useAuth } from '../contexts/AuthContext';
import { captureError, captureEvent } from '../services/telemetry';
import { detectSentiment, submitFeedback } from '../services/feedback';
import { FeedbackButtons } from './feedback/FeedbackButtons';
import { cn } from '../lib/utils';
import { Button, IconButton, buttonClasses, useReducedMotion } from './ds';
import {
  DENSITY,
  FADE_IN,
  FIELD,
  FOCUS_RING,
  MUTED,
  OVERLAY,
  RADIUS_CONTROL,
  RADIUS_PANEL,
  RADIUS_ROUND,
  RISE_IN,
  SECTION_ICON_TILE,
  STATUS_DOT,
  TONE_TEXT,
  WRAP_TEXT,
  Z
} from './chat/studioDesign';

/** A chat bubble: the panel radius with the corner nearest its speaker tucked to the small radius. */
const BUBBLE = `${RADIUS_PANEL} px-3.5 py-2.5`;

type ChatItem = {
  id: string;
  role: 'user' | 'model';
  text: string;
  offTopicBlocked?: boolean;
};

type UniversalAssistantProps = {
  currentView: string;
  activeProject?: Project;
  projects: Project[];
  /** When set, assistant replies show a "Save to story context" action that appends to the
   *  active project's creativeDirection (so the user can talk through their story and capture it). */
  onSaveCreativeDirection?: (text: string) => void;
  /** Hide the floating launcher (a reading surface: it would sit over the art). An open panel is not closed by it. */
  hideLauncher?: boolean;
};

const buildRateLimitMessage = (error: ApiError) => {
  const details = (error.details || {}) as Record<string, unknown>;
  const scope = typeof details.scope === 'string' ? details.scope : 'assistant';
  const retryAt = typeof details.resetAt === 'number'
    ? new Date(details.resetAt).toLocaleTimeString()
    : undefined;

  return [
    'You reached the current assistant usage limit.',
    retryAt ? `Try again after ${retryAt}.` : 'Try again once the rate limit window resets.',
    `Limit scope: ${scope}.`
  ].join(' ');
};

const getArtifactSummary = (artifacts: Array<{ stage?: string; type?: string; model?: string }>) => {
  const byStage: Record<string, number> = {};
  const byType: Record<string, number> = {};
  artifacts.forEach((artifact) => {
    const stage = artifact.stage || 'unknown';
    const type = artifact.type || 'unknown';
    byStage[stage] = (byStage[stage] || 0) + 1;
    byType[type] = (byType[type] || 0) + 1;
  });
  return {
    total: artifacts.length,
    byStage,
    byType,
    lastPrompts: artifacts.slice(-5).map((artifact) => ({
      stage: artifact.stage,
      model: artifact.model
    }))
  };
};

const SUGGESTIONS: Array<{ label: string; prompt: string }> = [
  { label: 'Explain a concept', prompt: 'Explain how rainbows form in everyday language.' },
  { label: 'Tokens & limits', prompt: 'How do tokens, plans, and usage limits work on my account?' },
  { label: 'Fix my API keys', prompt: 'Help me check and fix my API key configuration.' }
];

/** Three-dot typing indicator (chat-native, replaces the old "Processing..." chip). Holds still under reduced motion. */
const TypingDots: React.FC = () => (
  <div className={cn(BUBBLE, 'flex w-fit items-center gap-1 rounded-bl-[var(--ds-radius-sm)] border border-[var(--ds-hairline)] bg-[var(--ds-canvas)]')} aria-label="Assistant is typing">
    {[0, 1, 2].map((i) => (
      <span
        key={i}
        className="size-1.5 rounded-full bg-[var(--ds-muted)] motion-safe:animate-bounce"
        style={{ animationDelay: `calc(${i} * var(--ds-motion-medium))` }}
      />
    ))}
  </div>
);

export const UniversalAssistant: React.FC<UniversalAssistantProps> = ({
  currentView,
  activeProject,
  projects,
  onSaveCreativeDirection,
  hideLauncher = false
}) => {
  const { user } = useAuth();
  const reducedMotion = useReducedMotion();
  const [isOpen, setIsOpen] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const [input, setInput] = useState('');
  const dictationBase = useRef('');
  const insertDictation = (spoken: string) => setInput([dictationBase.current, spoken].filter(Boolean).join(' '));
  const [shareWorkspace, setShareWorkspace] = useState(false);
  const [savedMsgIds, setSavedMsgIds] = useState<Set<string>>(new Set());
  const [messages, setMessages] = useState<ChatItem[]>([]);
  const [lastLimitInfo, setLastLimitInfo] = useState<AssistantLimitInfo | undefined>(undefined);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const isAuthenticated = !!user;
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);

  useEffect(() => {
    const updateIsMobile = () => setIsMobile(window.innerWidth < 640);
    updateIsMobile();
    window.addEventListener('resize', updateIsMobile);
    return () => window.removeEventListener('resize', updateIsMobile);
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isOpen, isSending]);

  useEffect(() => {
    if (isOpen && !isMobile) inputRef.current?.focus();
  }, [isOpen, isMobile]);

  const assistantHistory: AssistantMessage[] = useMemo(
    () => messages.map((message) => ({ role: message.role, text: message.text })),
    [messages]
  );

  const buildContext = async (): Promise<UniversalAssistantContext> => {
    const base: UniversalAssistantContext = { view: currentView };
    if (!isAuthenticated || !shareWorkspace) return base;

    const [activeSummary, allSummaries, artifacts] = await Promise.all([
      activeProject ? summarizeProject(activeProject) : Promise.resolve(undefined),
      summarizeAllProjects(projects.slice(0, 12)),
      activeProject ? loadArtifactsForProject(activeProject.id) : Promise.resolve([])
    ]);

    const generatedPanels = activeProject
      ? activeProject.state.panels.filter((panel) => !!panel.imageId || !!panel.imageUrl).length
      : undefined;

    return {
      ...base,
      reportSummary: activeSummary ? {
        cost: activeSummary.cost,
        storage: activeSummary.storage,
        aiUsage: {
          totalArtifacts: activeSummary.artifacts
        }
      } : undefined,
      artifactSummary: getArtifactSummary(artifacts),
      panelPlanSummary: activeProject ? {
        plannedPanels: activeProject.state.panels.length,
        generatedPanels,
        textLayout: activeProject.state.textLayout
      } : undefined,
      allProjectsSummary: allSummaries,
      projectSnapshot: activeProject ? buildProjectSnapshot(activeProject) : undefined,
      appSnapshot: {
        view: currentView,
        totalProjects: projects.length,
        generatingProjects: projects
          .filter((project) => project.state.generationStatus?.isActive)
          .map((project) => ({ id: project.id, name: project.name })),
        lastUpdatedProject: projects[0]
          ? { id: projects[0].id, name: projects[0].name, updatedAt: projects[0].updatedAt }
          : undefined
      }
    };
  };

  const handleSend = async (overrideText?: string) => {
    const message = (overrideText ?? input).trim();
    if (!message || isSending || pending.current) return;
    const controller = new AbortController();
    pending.current = controller;

    const userMessage: ChatItem = {
      id: crypto.randomUUID(),
      role: 'user',
      text: message
    };

    const history = assistantHistory.slice(-24);
    setMessages((prev) => [...prev, userMessage]);
    // A suggestion chip sends its own prompt — it must not eat a draft the user typed.
    if (overrideText === undefined) setInput('');
    setStatusMessage(null);
    setIsSending(true);

    // Record sentiment counts only. A private conversation is not a support transcript.
    const sentiment = detectSentiment(message);
    if (sentiment) {
      captureEvent({
        eventType: 'assistant_user_sentiment',
        severity: sentiment === 'frustrated' ? 'warn' : 'info',
        source: 'universal_assistant',
        surface: currentView,
        metadata: { sentiment }
      });
      void submitFeedback({
        targetType: 'universal_assistant',
        sentiment,
        source: 'universal_assistant',
        surface: currentView,
        metadata: { auto: true, view: currentView }
      });
    }

    try {
      const context = await buildContext();
      if (controller.signal.aborted) return;
      const response = await queryUniversalAssistant(message, history, context, { signal: controller.signal, expectedAccountId: user?.id });
      if (controller.signal.aborted) return;
      setLastLimitInfo(response.limitInfo);
      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: 'model',
          text: response.text || 'No response returned.',
          offTopicBlocked: response.policy?.offTopicBlocked
        }
      ]);
    } catch (error) {
      if (controller.signal.aborted) return;
      if (error instanceof ApiError && error.status === 429) {
        setMessages((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            role: 'model',
            text: buildRateLimitMessage(error)
          }
        ]);
      } else {
        setMessages((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            role: 'model',
            text: 'I could not process that request right now. Try again in a moment, or check your API key and network status in Settings.'
          }
        ]);
      }
      setStatusMessage(error instanceof Error ? error.message : 'Request failed');
      captureError(error, {
        eventType: 'assistant_failed',
        source: 'universal_assistant',
        surface: currentView,
        metadata: { historyLength: history.length }
      });
    } finally {
      if (pending.current === controller) {
        pending.current = null;
        setIsSending(false);
      }
    }
  };

  const clearConversation = () => {
    pending.current?.abort();
    pending.current = null;
    setIsSending(false);
    setShareWorkspace(false);
    setMessages([]);
    setSavedMsgIds(new Set());
    setStatusMessage(null);
  };

  const showEmptyState = messages.length === 0 && !isSending;

  // Opaque Atlas panel (OVERLAY: the raised step, the overlay edge and shadow). Phones: a bottom sheet on the sheet
  // layer; from sm a floating panel bottom-left on the same layer, above the page chrome.
  const containerClassName = isMobile
    ? cn(OVERLAY, 'fixed inset-x-0 bottom-0 flex h-[78vh] flex-col overflow-hidden rounded-b-none', Z.sheet)
    : cn(OVERLAY, 'fixed bottom-6 left-6 flex h-[600px] max-h-[calc(100vh-3rem)] w-[400px] max-w-[calc(100vw-3rem)] flex-col overflow-hidden', Z.sheet);
  // Reduced motion: the launcher and the panel appear and leave without travelling or scaling.
  const pop = reducedMotion
    ? { initial: false as const, animate: { opacity: 1, scale: 1 }, exit: { opacity: 0 }, transition: { duration: 0 } }
    : { initial: { opacity: 0, scale: 0.6 }, animate: { opacity: 1, scale: 1 }, exit: { opacity: 0, scale: 0.6 }, transition: { type: 'spring' as const, stiffness: 420, damping: 28 } };
  const rise = reducedMotion
    ? { initial: false as const, animate: { opacity: 1, y: 0, scale: 1 }, exit: { opacity: 0 }, transition: { duration: 0 } }
    : { initial: { opacity: 0, y: 24, scale: 0.96 }, animate: { opacity: 1, y: 0, scale: 1 }, exit: { opacity: 0, y: 24, scale: 0.96 }, transition: { type: 'spring' as const, stiffness: 380, damping: 32 } };

  return (
    <>
      <AnimatePresence>
        {!isOpen && !hideLauncher && (
          <motion.button
            type="button"
            {...pop}
            onClick={() => setIsOpen(true)}
            className={cn(buttonClasses({ variant: 'default', size: 'icon' }), 'transition-[color,background-color,border-color,box-shadow] fixed bottom-6 left-6 size-14 shadow-[shadow:var(--ds-shadow-lift)]', RADIUS_ROUND, Z.chrome)}
            aria-label="Open assistant"
          >
            <Sparkles className="size-6" aria-hidden="true" />
          </motion.button>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {isOpen && (
          <motion.div
            {...rise}
            className={containerClassName}
            role="dialog"
            aria-label="DreamStream assistant"
          >
            {/* Header: identity + two quiet actions. Status lives here, not in the footer. */}
            <div className="flex shrink-0 items-center justify-between gap-2 border-b border-[var(--ds-hairline)] px-4 py-3">
              <div className="flex min-w-0 items-center gap-2.5">
                <div className={cn(SECTION_ICON_TILE, 'relative')}>
                  <Bot size={18} aria-hidden="true" />
                  <span className={cn('absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full ring-2 ring-[var(--ds-raised)]', STATUS_DOT.healthy)} aria-hidden />
                </div>
                <div className="min-w-0">
                  <p className="truncate text-[15px] font-semibold leading-5 text-[var(--ds-ink)]">Assistant</p>
                  <p className={cn('truncate text-[11px] leading-4', MUTED)}>
                    {isAuthenticated ? 'Signed in' : 'Guest mode'}
                  </p>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                {messages.length > 0 && (
                  <IconButton label="New conversation" onClick={clearConversation} className={MUTED}>
                    <RotateCcw size={16} />
                  </IconButton>
                )}
                <IconButton label="Close assistant" title={null} onClick={() => setIsOpen(false)} className={MUTED}>
                  <X size={18} />
                </IconButton>
              </div>
            </div>

            {/* Conversation */}
            <div className="flex-1 overflow-y-auto px-3 py-4 space-y-3">
              {showEmptyState && (
                <div className={cn("flex h-full flex-col items-center justify-center px-4 text-center", FADE_IN)}>
                  <div className={cn(SECTION_ICON_TILE, 'mb-4 size-12')}>
                    <Sparkles size={22} aria-hidden="true" />
                  </div>
                  <p className="text-[length:var(--ds-text-lg)] font-semibold leading-6 text-[var(--ds-ink)]">How can I help?</p>
                  <p className={cn('mb-5 mt-1 max-w-[15rem] text-[length:var(--ds-text-sm)]', MUTED)}>
                    Ask a question, think through an idea, or get help with DreamStream.
                  </p>
                  <div className="flex flex-col gap-2 w-full max-w-[16rem]">
                    {SUGGESTIONS.map((suggestion) => (
                      <Button
                        key={suggestion.label}
                        variant="outline"
                        onClick={() => void handleSend(suggestion.prompt)}
                        className="h-auto min-h-10 w-full justify-start px-3.5 py-2.5 text-left"
                      >
                        {suggestion.label}
                      </Button>
                    ))}
                  </div>
                </div>
              )}

              {messages.map((message) => (
                <div
                  key={message.id}
                  className={cn(RISE_IN, message.role === 'user' ? 'flex justify-end' : 'flex justify-start')}
                >
                  {message.role === 'user' ? (
                    <div className={cn(BUBBLE, 'max-w-[85%] whitespace-pre-wrap rounded-br-[var(--ds-radius-sm)] bg-[var(--ds-ink)] text-[length:var(--ds-text-base)] text-[var(--ds-canvas)]', WRAP_TEXT)}>
                      {message.text}
                    </div>
                  ) : (
                    <div className="max-w-[90%] group">
                      <div className={cn(RADIUS_PANEL, 'rounded-bl-[var(--ds-radius-sm)] border border-[var(--ds-hairline)] bg-[var(--ds-canvas)] px-1 py-0.5')}>
                        {message.offTopicBlocked && (
                          <div className={cn('flex items-center gap-1 px-2.5 pt-2 text-[11px] font-semibold leading-4', TONE_TEXT.danger)}>
                            <AlertTriangle size={12} aria-hidden="true" /> Platform scope enforced
                          </div>
                        )}
                        <MessageCard text={message.text} />
                      </div>
                      {/* Actions: always visible on touch screens (no hover there); on
                          pointer devices they reveal on hover/focus to keep the thread clean. */}
                      <div className="mt-1 flex flex-wrap items-center gap-2 px-1 transition-opacity duration-[var(--ds-motion-medium)] ease-[var(--ds-ease)] sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100">
                        <ReadReplyAloud text={message.text} />
                        {onSaveCreativeDirection && message.text.trim() && (
                          <button
                            onClick={() => { onSaveCreativeDirection(message.text); setSavedMsgIds((prev) => new Set(prev).add(message.id)); }}
                            className={cn('inline-flex min-h-6 items-center gap-1 px-1 text-[11px] font-medium text-[var(--ds-ink)] underline-offset-2 hover:underline', RADIUS_CONTROL, DENSITY.coarse, FOCUS_RING)}
                          >
                            {savedMsgIds.has(message.id)
                              ? <><Check size={12} /> Saved to story</>
                              : <><BookmarkPlus size={12} /> Save to story</>}
                          </button>
                        )}
                        <FeedbackButtons
                          targetType="universal_assistant"
                          targetId={message.id}
                          source="universal_assistant"
                          surface={currentView}
                          compact
                          metadata={{ offTopicBlocked: Boolean(message.offTopicBlocked) }}
                        />
                      </div>
                    </div>
                  )}
                </div>
              ))}

              {isSending && (
                <div className={cn(FADE_IN, 'flex justify-start')}>
                  <TypingDots />
                </div>
              )}
              <div ref={messagesEndRef} />
            </div>

            {/* Composer: one calm row; meta only when it matters. */}
            <div className="shrink-0 border-t border-[var(--ds-hairline)] p-3">
              {isAuthenticated && (activeProject || projects.length > 0) && (
                <label className="mb-2 flex items-center gap-2 text-xs text-[var(--ds-muted)]">
                  <input type="checkbox" checked={shareWorkspace} onChange={event => setShareWorkspace(event.target.checked)} />
                  Include my workspace summaries
                </label>
              )}
              <div className="flex items-center gap-2">
                <DictationButton disabled={isSending} align="start"
                  onStart={() => { dictationBase.current = input; }}
                  onPartial={insertDictation}
                  onFinal={spoken => { insertDictation(spoken); inputRef.current?.focus(); }}
                  onTypeInstead={() => inputRef.current?.focus()} />
                <input
                  ref={inputRef}
                  type="text"
                  value={input}
                  onChange={(event) => setInput(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      void handleSend();
                    }
                  }}
                  placeholder="Ask a question…"
                  className={cn(FIELD, 'h-11 min-w-0 flex-1 px-3.5 text-base md:text-[length:var(--ds-text-base)]')}
                />
                <Button
                  type="button"
                  size="icon"
                  onClick={() => void handleSend()}
                  disabled={isSending || !input.trim()}
                  aria-label="Send message"
                  className="size-11"
                >
                  <Send size={16} aria-hidden="true" />
                </Button>
              </div>

              {(statusMessage || (lastLimitInfo?.scope !== 'bypass' && typeof lastLimitInfo?.remaining === 'number' && typeof lastLimitInfo?.limit === 'number')) && (
                <div className="mt-1.5 flex items-center justify-between gap-3 text-[11px]">
                  <span className={cn('min-w-0 truncate', TONE_TEXT.danger)}>{statusMessage}</span>
                  {lastLimitInfo?.scope !== 'bypass' && typeof lastLimitInfo?.remaining === 'number' && typeof lastLimitInfo?.limit === 'number' && (
                    <span className={cn('shrink-0 tabular-nums', lastLimitInfo.remaining <= 5 ? `font-semibold ${TONE_TEXT.danger}` : MUTED)}>
                      {lastLimitInfo.remaining}/{lastLimitInfo.limit} left
                    </span>
                  )}
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
};
