import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Bot, Loader2, Send, Sparkles, X } from 'lucide-react';
import { AssistantMessage, AssistantLimitInfo, UniversalAssistantContext } from '../apiTypes';
import { MessageCard } from './MessageCard';
import { queryUniversalAssistant } from '../services/geminiService';
import { ApiError } from '../services/apiClient';
import { Project } from '../types';
import { buildProjectSnapshot, summarizeAllProjects, summarizeProject } from '../services/assistantContext';
import { getUsageLimits, getUserProfile, loadArtifactsForProject, loadTestRuns } from '../services/db';
import { buildTestLabSummary, getRecentTestRuns } from '../services/testLabAnalytics';
import { useAuth } from '../contexts/AuthContext';

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
    '**Summary:** You reached the current assistant usage limit.',
    '**Warnings:** Please wait for the limit window to reset before sending another message.',
    '**Next:**',
    retryAt
      ? `1. Try again after ${retryAt}.`
      : '1. Try again once the rate limit window resets.',
    `2. Current limit scope: ${scope}.`
  ].join('\n');
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

export const UniversalAssistant: React.FC<UniversalAssistantProps> = ({
  currentView,
  activeProject,
  projects
}) => {
  const { user } = useAuth();
  const [isOpen, setIsOpen] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState<ChatItem[]>([
    {
      id: crypto.randomUUID(),
      role: 'model',
      text: '**Summary:** I can help with DreamStream Comic Studio setup, projects, account, and troubleshooting.\n**Warnings:** I only answer DreamStream platform-specific questions.\n**Next:** 1. Ask what you need help with in the app.'
    }
  ]);
  const [lastLimitInfo, setLastLimitInfo] = useState<AssistantLimitInfo | undefined>(undefined);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

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
          isPremium: usage.is_premium
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

  const handleSend = async () => {
    const message = input.trim();
    if (!message || isSending) return;

    const userMessage: ChatItem = {
      id: crypto.randomUUID(),
      role: 'user',
      text: message
    };

    const history = assistantHistory.slice(-24);
    setMessages((prev) => [...prev, userMessage]);
    setInput('');
    setStatusMessage(null);
    setIsSending(true);

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
            text: '**Summary:** Assistant request failed.\n**Warnings:** I could not process that request right now.\n**Next:** 1. Try again in a moment. 2. Check API key and network status in Settings.'
          }
        ]);
      }
      setStatusMessage(error instanceof Error ? error.message : 'Request failed');
    } finally {
      setIsSending(false);
    }
  };

  const containerClassName = isMobile
    ? 'fixed inset-x-0 bottom-0 z-50 h-[78vh] bg-white border-t-4 border-black rounded-t-2xl shadow-2xl flex flex-col'
    : 'fixed bottom-6 left-6 z-50 w-[420px] h-[580px] bg-white border-4 border-black rounded-2xl shadow-[8px_8px_0px_0px_rgba(0,0,0,0.45)] flex flex-col';

  return (
    <>
      {!isOpen && (
        <button
          type="button"
          onClick={() => setIsOpen(true)}
          className="fixed bottom-6 left-6 z-50 w-14 h-14 bg-black text-brand-yellow border-4 border-white rounded-full shadow-comic hover:scale-105 transition-transform flex items-center justify-center"
          aria-label="Open Universal Assistant"
        >
          <Sparkles className="w-7 h-7" />
        </button>
      )}

      {isOpen && (
        <div className={containerClassName}>
          <div className="bg-black text-brand-yellow px-4 py-3 flex items-center justify-between shrink-0">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-full bg-brand-yellow text-black border-2 border-white flex items-center justify-center">
                <Bot size={18} />
              </div>
              <div>
                <p className="font-display text-lg leading-none">Universal Assistant</p>
                <p className="text-[10px] uppercase tracking-wide text-white/80">Platform scope only</p>
              </div>
            </div>
            <button type="button" onClick={() => setIsOpen(false)} className="text-white hover:text-brand-red">
              <X size={22} />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto p-3 space-y-3 bg-slate-50">
            {messages.map((message) => (
              <div key={message.id} className={message.role === 'user' ? 'flex justify-end' : 'flex justify-start'}>
                {message.role === 'user' ? (
                  <div className="max-w-[85%] px-3 py-2 rounded-lg border-2 border-black bg-white text-sm font-medium whitespace-pre-wrap">
                    {message.text}
                  </div>
                ) : (
                  <div className="max-w-[92%] space-y-1">
                    {message.offTopicBlocked && (
                      <div className="text-[10px] font-bold uppercase tracking-wide text-brand-red">
                        Platform scope enforced
                      </div>
                    )}
                    <MessageCard text={message.text} />
                  </div>
                )}
              </div>
            ))}

            {isSending && (
              <div className="flex justify-start">
                <div className="inline-flex items-center gap-2 text-xs border border-slate-300 rounded-md px-2 py-1 bg-white">
                  <Loader2 className="w-3 h-3 animate-spin" />
                  Processing...
                </div>
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>

          <div className="border-t-2 border-black p-3 bg-white shrink-0">
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={input}
                onChange={(event) => setInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    void handleSend();
                  }
                }}
                placeholder="Ask about DreamStream features or your current project..."
                className="flex-1 border-2 border-black rounded-md px-3 py-2 text-sm bg-slate-50 focus:bg-white focus:outline-none"
              />
              <button
                type="button"
                onClick={() => void handleSend()}
                disabled={isSending || !input.trim()}
                className="h-10 w-10 rounded-md border-2 border-black bg-brand-yellow hover:bg-black hover:text-brand-yellow transition-colors disabled:opacity-50 flex items-center justify-center"
              >
                <Send size={16} />
              </button>
            </div>

            <div className="mt-2 text-[11px] text-slate-500 flex items-center justify-between gap-3">
              <span>{isAuthenticated ? 'Signed-in mode' : 'Guest mode'}</span>
              {lastLimitInfo?.scope !== 'bypass' && typeof lastLimitInfo?.remaining === 'number' && typeof lastLimitInfo?.limit === 'number' && (
                <span>{lastLimitInfo.remaining}/{lastLimitInfo.limit} remaining</span>
              )}
            </div>

            {statusMessage && (
              <div className="mt-1 text-[11px] text-brand-red">{statusMessage}</div>
            )}
          </div>
        </div>
      )}
    </>
  );
};
