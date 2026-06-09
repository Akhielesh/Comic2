import React, { useEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Bot, BookmarkPlus, Check, RotateCcw, Send, Sparkles, X } from 'lucide-react';
import { AssistantMessage, AssistantLimitInfo, UniversalAssistantContext } from '../apiTypes';
import { MessageCard } from './MessageCard';
import { queryUniversalAssistant } from '../services/geminiService';
import { ApiError } from '../services/apiClient';
import { Project } from '../types';
import { buildProjectSnapshot, summarizeAllProjects, summarizeProject } from '../services/assistantContext';
import { getUsageLimits, getUserProfile, loadArtifactsForProject, loadTestRuns } from '../services/db';
import { buildTestLabSummary, getRecentTestRuns } from '../services/testLabAnalytics';
import { useAuth } from '../contexts/AuthContext';
import { captureError, captureEvent } from '../services/telemetry';
import { detectSentiment, submitFeedback } from '../services/feedback';
import { FeedbackButtons } from './feedback/FeedbackButtons';

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
};

const maskEmail = (email?: string | null) => {
  if (!email || !email.includes('@')) return undefined;
  const [name, domain] = email.split('@');
  if (!name || !domain) return undefined;
  const prefix = name.length <= 2 ? name[0] : name.slice(0, 2);
  return `${prefix}***@${domain}`;
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
  { label: 'What can I do here?', prompt: 'Give me a quick tour: what can I do in DreamStream Comic Studio?' },
  { label: 'Tokens & limits', prompt: 'How do tokens, plans, and usage limits work on my account?' },
  { label: 'Fix my API keys', prompt: 'Help me check and fix my API key configuration.' }
];

/** Three-dot typing indicator (chat-native, replaces the old "Processing..." chip). */
const TypingDots: React.FC = () => (
  <div className="flex items-center gap-1 px-3.5 py-2.5 bg-white border-2 border-black rounded-2xl rounded-bl-md w-fit" aria-label="Assistant is typing">
    {[0, 1, 2].map((i) => (
      <span
        key={i}
        className="w-1.5 h-1.5 rounded-full bg-slate-400 animate-bounce"
        style={{ animationDelay: `${i * 0.15}s`, animationDuration: '0.9s' }}
      />
    ))}
  </div>
);

export const UniversalAssistant: React.FC<UniversalAssistantProps> = ({
  currentView,
  activeProject,
  projects,
  onSaveCreativeDirection
}) => {
  const { user } = useAuth();
  const [isOpen, setIsOpen] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const [input, setInput] = useState('');
  const [savedMsgIds, setSavedMsgIds] = useState<Set<string>>(new Set());
  const [messages, setMessages] = useState<ChatItem[]>([]);
  const [lastLimitInfo, setLastLimitInfo] = useState<AssistantLimitInfo | undefined>(undefined);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const isAuthenticated = !!user;

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
    const base: UniversalAssistantContext = {
      view: currentView,
      publicHints: [
        'Assistant scope is DreamStream Comic Studio only.',
        'For non-platform questions, use a general-purpose assistant.'
      ]
    };

    if (!isAuthenticated) return base;

    const [profile, usage, activeSummary, allSummaries, artifacts, testRuns] = await Promise.all([
      user ? getUserProfile(user.id) : Promise.resolve(null),
      getUsageLimits(),
      activeProject ? summarizeProject(activeProject) : Promise.resolve(undefined),
      summarizeAllProjects(projects.slice(0, 12)),
      activeProject ? loadArtifactsForProject(activeProject.id) : Promise.resolve([]),
      loadTestRuns(50)
    ]);

    const generatedPanels = activeProject
      ? activeProject.state.panels.filter((panel) => !!panel.imageId || !!panel.imageUrl).length
      : undefined;

    return {
      ...base,
      account: {
        isAuthenticated: true,
        username: profile?.username || undefined,
        maskedEmail: maskEmail(user?.email),
        isAdmin: user?.email === 'admin@test.com',
        planTier: usage?.plan_tier,
        usage: usage ? {
          imagesGenerated: usage.images_generated_count,
          maxImagesAllowed: usage.max_images_allowed,
          hasByok: usage.has_byok,
          isPremium: usage.is_premium,
          dailyRemainingCt: usage.daily_remaining_ct,
          availableCt: usage.available_ct
        } : undefined
      },
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
      },
      testLabSummary: buildTestLabSummary(testRuns) as unknown as Record<string, unknown>,
      testLabRecentRuns: getRecentTestRuns(testRuns, 5) as unknown as Record<string, unknown>[]
    };
  };

  const handleSend = async (overrideText?: string) => {
    const message = (overrideText ?? input).trim();
    if (!message || isSending) return;

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

    // Understand + write down disappointment: when the user vents at the assistant,
    // capture the sentiment as feedback automatically (no thumbs-down hunt required).
    const sentiment = detectSentiment(message);
    if (sentiment) {
      captureEvent({
        eventType: 'assistant_user_sentiment',
        severity: sentiment === 'frustrated' ? 'warn' : 'info',
        source: 'universal_assistant',
        surface: currentView,
        message,
        metadata: { sentiment }
      });
      void submitFeedback({
        targetType: 'universal_assistant',
        sentiment,
        comment: message,
        source: 'universal_assistant',
        surface: currentView,
        metadata: { auto: true, view: currentView }
      });
    }

    try {
      const context = await buildContext();
      const response = await queryUniversalAssistant(message, history, context);
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
      setIsSending(false);
    }
  };

  const clearConversation = () => {
    setMessages([]);
    setSavedMsgIds(new Set());
    setStatusMessage(null);
  };

  const showEmptyState = messages.length === 0 && !isSending;

  const containerClassName = isMobile
    ? 'fixed inset-x-0 bottom-0 z-50 h-[78vh] bg-slate-50 border-t-4 border-black rounded-t-2xl shadow-2xl flex flex-col overflow-hidden'
    : 'fixed bottom-6 left-6 z-50 w-[400px] h-[600px] max-h-[calc(100vh-3rem)] bg-slate-50 border-4 border-black rounded-2xl shadow-[8px_8px_0px_0px_rgba(0,0,0,0.45)] flex flex-col overflow-hidden';

  return (
    <>
      <AnimatePresence>
        {!isOpen && (
          <motion.button
            type="button"
            initial={{ opacity: 0, scale: 0.6 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.6 }}
            transition={{ type: 'spring', stiffness: 420, damping: 28 }}
            onClick={() => setIsOpen(true)}
            className="fixed bottom-6 left-6 z-50 w-14 h-14 bg-black text-brand-yellow border-4 border-white rounded-full shadow-comic hover:scale-105 active:scale-95 transition-transform flex items-center justify-center"
            aria-label="Open assistant"
          >
            <Sparkles className="w-6 h-6" />
          </motion.button>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ opacity: 0, y: 24, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 24, scale: 0.96 }}
            transition={{ type: 'spring', stiffness: 380, damping: 32 }}
            className={containerClassName}
            role="dialog"
            aria-label="DreamStream assistant"
          >
            {/* Header: identity + two quiet actions. Status lives here, not in the footer. */}
            <div className="bg-black text-white px-4 py-3 flex items-center justify-between shrink-0">
              <div className="flex items-center gap-2.5 min-w-0">
                <div className="relative w-9 h-9 rounded-full bg-brand-yellow text-black border-2 border-white flex items-center justify-center shrink-0">
                  <Bot size={18} />
                  <span className="absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full bg-green-400 border-2 border-black" aria-hidden />
                </div>
                <div className="min-w-0">
                  <p className="font-display text-lg leading-none truncate">Assistant</p>
                  <p className="text-[10px] text-white/60 truncate">
                    {isAuthenticated ? 'Knows your projects & account' : 'Guest mode'}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                {messages.length > 0 && (
                  <button
                    type="button"
                    onClick={clearConversation}
                    title="New conversation"
                    aria-label="New conversation"
                    className="p-2 rounded-lg text-white/60 hover:text-white hover:bg-white/10 transition-colors"
                  >
                    <RotateCcw size={16} />
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setIsOpen(false)}
                  aria-label="Close assistant"
                  className="p-2 rounded-lg text-white/60 hover:text-white hover:bg-white/10 transition-colors"
                >
                  <X size={18} />
                </button>
              </div>
            </div>

            {/* Conversation */}
            <div className="flex-1 overflow-y-auto px-3 py-4 space-y-3">
              {showEmptyState && (
                <div className="h-full flex flex-col items-center justify-center text-center px-4 animate-fade-in">
                  <div className="w-14 h-14 rounded-2xl bg-brand-yellow border-2 border-black shadow-comic flex items-center justify-center mb-4">
                    <Sparkles size={24} />
                  </div>
                  <p className="font-display text-2xl">How can I help?</p>
                  <p className="text-xs text-slate-500 mt-1 mb-5 max-w-[15rem]">
                    Ask about your projects, account, generation setup, or anything DreamStream.
                  </p>
                  <div className="flex flex-col gap-2 w-full max-w-[16rem]">
                    {SUGGESTIONS.map((suggestion) => (
                      <button
                        key={suggestion.label}
                        onClick={() => void handleSend(suggestion.prompt)}
                        className="w-full text-left text-sm font-bold border-2 border-black rounded-xl px-3.5 py-2.5 bg-white hover:bg-brand-yellow hover:-translate-y-0.5 transition-all shadow-comic-hover"
                      >
                        {suggestion.label}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {messages.map((message) => (
                <motion.div
                  key={message.id}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.16, ease: 'easeOut' }}
                  className={message.role === 'user' ? 'flex justify-end' : 'flex justify-start'}
                >
                  {message.role === 'user' ? (
                    <div className="max-w-[85%] px-3.5 py-2.5 rounded-2xl rounded-br-md bg-black text-white text-sm font-medium whitespace-pre-wrap">
                      {message.text}
                    </div>
                  ) : (
                    <div className="max-w-[90%] group">
                      <div className="bg-white border-2 border-black rounded-2xl rounded-bl-md px-1 py-0.5">
                        {message.offTopicBlocked && (
                          <div className="text-[10px] font-bold uppercase tracking-wide text-brand-red px-2.5 pt-2">
                            Platform scope enforced
                          </div>
                        )}
                        <MessageCard text={message.text} />
                      </div>
                      {/* Actions: always visible on touch screens (no hover there); on
                          pointer devices they reveal on hover/focus to keep the thread clean. */}
                      <div className="flex items-center gap-2 mt-1 px-1 transition-opacity sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100">
                        {onSaveCreativeDirection && message.text.trim() && (
                          <button
                            onClick={() => { onSaveCreativeDirection(message.text); setSavedMsgIds((prev) => new Set(prev).add(message.id)); }}
                            className="inline-flex items-center gap-1 text-[11px] font-bold text-brand-blue hover:underline"
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
                </motion.div>
              ))}

              {isSending && (
                <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex justify-start">
                  <TypingDots />
                </motion.div>
              )}
              <div ref={messagesEndRef} />
            </div>

            {/* Composer: one calm row; meta only when it matters. */}
            <div className="border-t-2 border-black p-3 bg-white shrink-0">
              <div className="flex items-center gap-2">
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
                  placeholder="Ask anything about DreamStream…"
                  className="flex-1 border-2 border-black rounded-xl px-3.5 py-2.5 text-sm bg-slate-50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-brand-yellow transition-shadow"
                />
                <button
                  type="button"
                  onClick={() => void handleSend()}
                  disabled={isSending || !input.trim()}
                  aria-label="Send message"
                  className="h-11 w-11 shrink-0 rounded-xl border-2 border-black bg-brand-yellow hover:bg-black hover:text-brand-yellow active:scale-95 transition-all disabled:opacity-40 disabled:hover:bg-brand-yellow disabled:hover:text-black flex items-center justify-center"
                >
                  <Send size={16} />
                </button>
              </div>

              {(statusMessage || (lastLimitInfo?.scope !== 'bypass' && typeof lastLimitInfo?.remaining === 'number' && typeof lastLimitInfo?.limit === 'number')) && (
                <div className="mt-1.5 flex items-center justify-between gap-3 text-[11px]">
                  <span className="text-brand-red truncate">{statusMessage}</span>
                  {lastLimitInfo?.scope !== 'bypass' && typeof lastLimitInfo?.remaining === 'number' && typeof lastLimitInfo?.limit === 'number' && (
                    <span className={`shrink-0 ${lastLimitInfo.remaining <= 5 ? 'text-brand-red font-bold' : 'text-slate-400'}`}>
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
