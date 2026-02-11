
import React, { useState, useRef, useEffect } from 'react';
import { Bot, X, Send, Sparkles, Copy, Check } from 'lucide-react';
import { Project, ChatMessage } from '../types';
import { queryMasterAssistant } from '../services/geminiService';
import { loadArtifactsForProject, loadTestRuns } from '../services/db';
import { MessageCard } from './MessageCard';
import { buildProjectSnapshot, summarizeProject } from '../services/assistantContext';
import { buildProjectReport } from '../services/reporting';
import { ResizablePanel } from './ResizablePanel'; // Kept for types if needed, but switching to Draggable
import { DraggablePanel } from './DraggablePanel';
import { buildTestLabSummary, getRecentTestRuns } from '../services/testLabAnalytics';

const areMessagesEqual = (a: ChatMessage[] = [], b: ChatMessage[] = []) => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i].id !== b[i].id || a[i].role !== b[i].role || a[i].text !== b[i].text) return false;
  }
  return true;
};

const withTimeout = async <T,>(promise: Promise<T>, ms: number) => {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error("timeout")), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
};

interface MasterAssistantProps {
  activeProject?: Project;
  projects?: Project[];
  currentView: 'home' | 'dashboard' | 'editor' | 'reader' | 'test' | 'learn' | 'gallery' | 'settings' | 'privacy' | 'terms';
  onPersistChat?: (messages: ChatMessage[]) => void;
}

import { getShowAssistant } from '../services/appSettings';

export const MasterAssistant: React.FC<MasterAssistantProps> = ({ activeProject, projects = [], currentView, onPersistChat }) => {
  const [isEnabled, setIsEnabled] = useState(getShowAssistant());

  // Re-check setting on mount/view change
  useEffect(() => {
    setIsEnabled(getShowAssistant());
    const interval = setInterval(() => setIsEnabled(getShowAssistant()), 2000); // Poll for setting change (simple sync)
    return () => clearInterval(interval);
  }, []);

  const createMessage = (role: ChatMessage['role'], text: string): ChatMessage => ({
    id: crypto.randomUUID(),
    role,
    text,
    timestamp: Date.now()
  });
  const [isOpen, setIsOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([
    createMessage('model', "Hello! I'm your DreamStream Studio Assistant. I can help you create your comic, fix issues, or explain features. What's on your mind?")
  ]);
  const [input, setInput] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const hasHydrated = useRef(false);
  const lastPersistedRef = useRef<ChatMessage[]>([]);
  const summaryCacheRef = useRef<Map<string, { ts: number; summary: any }>>(new Map());

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isOpen]);

  const showNudge = !isOpen && !!activeProject?.state.scriptChecklist?.missing?.length;

  useEffect(() => {
    if (!activeProject) return;
    if (activeProject.state.assistantChat && activeProject.state.assistantChat.length > 0) {
      const normalized = activeProject.state.assistantChat.map((msg) => ({
        id: msg.id || crypto.randomUUID(),
        role: msg.role,
        text: msg.text,
        timestamp: msg.timestamp || Date.now()
      }));
      setMessages(normalized);
      lastPersistedRef.current = normalized;
    } else if (!hasHydrated.current) {
      const initialMessages = [
        createMessage('model', "Hello! I'm your DreamStream Studio Assistant. I can help you create your comic, fix issues, or explain features. What's on your mind?")
      ];
      setMessages(initialMessages);
      lastPersistedRef.current = initialMessages;
    }
    hasHydrated.current = true;
  }, [activeProject?.id]);

  useEffect(() => {
    if (!activeProject || !onPersistChat) return;
    if (!hasHydrated.current) return;
    if (areMessagesEqual(lastPersistedRef.current, messages)) return;
    onPersistChat(messages);
    lastPersistedRef.current = messages;
  }, [messages, activeProject?.id, onPersistChat]);

  const handleSend = async () => {
    if (!input.trim()) return;

    const userMsg: ChatMessage = createMessage('user', input);
    setMessages(prev => [...prev, userMsg]);
    setInput('');
    setIsTyping(true);

    try {
      let artifactSummary: {
        total: number;
        byStage: Record<string, number>;
        byType: Record<string, number>;
        lastPrompts: Array<{ stage?: string; model?: string; prompt?: string }>;
      } | undefined;
      let reportSummary: {
        cost?: { currency?: string; totalCost?: number; estimatedArtifacts?: number };
        storage?: { imageCount?: number; imageBytes?: number; panelsCount?: number; artifactsCount?: number; indexedDb?: Record<string, unknown> };
        aiUsage?: { totalTokens?: number; totalArtifacts?: number };
      } | undefined;
      if (activeProject) {
        try {
          const artifacts = await withTimeout(loadArtifactsForProject(activeProject.id), 1200);
          artifactSummary = {
            total: artifacts.length,
            byStage: artifacts.reduce((acc: Record<string, number>, a) => {
              const key = a.stage || 'unknown';
              acc[key] = (acc[key] || 0) + 1;
              return acc;
            }, {}),
            byType: artifacts.reduce((acc: Record<string, number>, a) => {
              acc[a.type] = (acc[a.type] || 0) + 1;
              return acc;
            }, {}),
            lastPrompts: artifacts.slice(-5).map(a => ({ stage: a.stage, model: a.model, prompt: a.prompt?.slice(0, 200) }))
          };
          const report = await buildProjectReport(
            {
              id: activeProject.id,
              name: activeProject.name,
              createdAt: activeProject.createdAt,
              updatedAt: activeProject.updatedAt,
              state: activeProject.state
            },
            artifacts,
            {},
            activeProject.state.pricingConfig
          );
          reportSummary = {
            cost: {
              currency: report.cost_summary.currency,
              totalCost: report.cost_summary.totalCost,
              estimatedArtifacts: report.cost_summary.estimatedArtifactCount
            },
            storage: {
              imageCount: report.storage.imageCount,
              imageBytes: report.storage.imageBytes,
              panelsCount: report.storage.panelsCount,
              artifactsCount: report.storage.artifactsCount,
              indexedDb: report.storage.indexedDb
            },
            aiUsage: {
              totalTokens: report.ai_usage.totalTokens,
              totalArtifacts: report.ai_usage.totalArtifacts
            }
          };
        } catch {
          artifactSummary = undefined;
          reportSummary = undefined;
        }
      }
      const panelPlanSummary = activeProject ? {
        plannedPanels: activeProject.state.panels.length,
        generatedPanels: activeProject.state.panels.filter(p => p.imageId).length,
        textLayout: activeProject.state.textLayout || 'caption'
      } : {};
      const projectSnapshot = activeProject ? buildProjectSnapshot(activeProject) : undefined;
      const sortedByUpdated = projects.slice().sort((a, b) => b.updatedAt - a.updatedAt);
      const lastUpdatedProject = sortedByUpdated[0];
      const appSnapshot = {
        view: currentView,
        totalProjects: projects.length,
        generatingProjects: projects
          .filter(p => p.state.generationStatus?.isActive)
          .map(p => ({
            id: p.id,
            name: p.name,
            step: p.state.step,
            progress: p.state.generationStatus?.progress,
            currentStep: p.state.generationStatus?.currentStepDescription
          })),
        lastUpdatedProject: lastUpdatedProject
          ? {
            id: lastUpdatedProject.id,
            name: lastUpdatedProject.name,
            updatedAt: lastUpdatedProject.updatedAt
          }
          : undefined
      };

      const allProjectsSummary = await Promise.all(projects.map(async (project) => {
        const cached = summaryCacheRef.current.get(project.id);
        if (cached && Date.now() - cached.ts < 30_000) return cached.summary;
        const summary = await summarizeProject(project);
        summaryCacheRef.current.set(project.id, { ts: Date.now(), summary });
        return summary;
      }));

      let testLabSummary;
      let testLabRecentRuns;
      try {
        const runs = await withTimeout(loadTestRuns(50), 1200);
        testLabSummary = buildTestLabSummary(runs);
        testLabRecentRuns = getRecentTestRuns(runs, 10);
      } catch {
        testLabSummary = undefined;
        testLabRecentRuns = undefined;
      }

      const trimmedHistory = messages.slice(-6);
      const responseText = await queryMasterAssistant(
        userMsg.text,
        trimmedHistory,
        {
          view: currentView,
          project: activeProject,
          artifactSummary,
          panelPlanSummary,
          pricingConfig: activeProject?.state.pricingConfig,
          reportSummary,
          allProjectsSummary,
          projectSnapshot,
          appSnapshot,
          testLabSummary,
          testLabRecentRuns
        }
      );
      setMessages(prev => [...prev, createMessage('model', responseText)]);
    } catch (e) {
      console.error(e);
      setMessages(prev => [...prev, createMessage('model', "System Error: Unable to process request.")]);
    } finally {
      setIsTyping(false);
    }
  };

  const formatTime = (timestamp: number) =>
    new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(timestamp));

  const handleCopy = async (message: ChatMessage) => {
    try {
      await navigator.clipboard.writeText(message.text);
      setCopiedId(message.id);
      setTimeout(() => setCopiedId(null), 1500);
    } catch (e) {
      console.error(e);
    }
  };

  if (!isEnabled) return null;

  return (
    <>
      {/* Floating Toggle Button */}
      {!isOpen && (
        <>
          <button
            onClick={() => setIsOpen(true)}
            className="fixed bottom-6 left-6 z-50 w-14 h-14 bg-black text-brand-yellow border-4 border-white rounded-full shadow-comic hover:scale-110 transition-transform flex items-center justify-center group"
            aria-label="Open Assistant"
          >
            <Sparkles className="w-8 h-8 group-hover:animate-spin" />
          </button>
          {showNudge && (
            <button
              onClick={() => setIsOpen(true)}
              className="fixed bottom-24 left-6 z-50 bg-white text-black border-2 border-black rounded-lg px-3 py-2 text-xs font-bold shadow-comic"
            >
              Stuck? I can help.
            </button>
          )}
        </>
      )}

      {/* Chat Window */}
      {isOpen && (
        <DraggablePanel
          storageKey="dreamstream.masterAssistant.pos_v2"
          defaultSize={{ width: 384, height: 500 }}
          minSize={{ width: 320, height: 400 }}
          className="z-50 bg-white rounded-xl border-4 border-black flex flex-col overflow-hidden"
          headerBar={
            <div className="bg-black text-brand-yellow p-4 flex justify-between items-center shrink-0">
              <div className="flex items-center gap-2 pointer-events-none">
                <div className="w-8 h-8 bg-brand-yellow rounded-full flex items-center justify-center border-2 border-white text-black">
                  <Bot size={20} />
                </div>
                <h3 className="font-display text-lg tracking-wide">Studio Assistant</h3>
              </div>
              <button onPointerDown={(e) => e.stopPropagation()} onClick={() => setIsOpen(false)} className="text-white hover:text-brand-red transition-colors cursor-pointer">
                <X size={24} />
              </button>
            </div>
          }
        >
          {/* Main Content (No Header here, it's in headerBar) */}
          <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4 bg-slate-50 custom-scrollbar">
            {messages.map((msg) => (
              <div key={msg.id} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                <div className={`max-w-[85%] p-3 rounded-lg text-sm font-medium border-2 border-black shadow-sm ${msg.role === 'user' ? 'bg-white text-black rounded-tr-none' : 'bg-brand-blue text-white rounded-tl-none'
                  }`}>
                  <div className="flex items-center justify-between gap-2 mb-2">
                    <div className="text-[10px] font-bold uppercase opacity-70">
                      {msg.role === 'user' ? 'You' : 'Assistant'}
                    </div>
                    <button
                      onClick={() => handleCopy(msg)}
                      className="text-[10px] font-bold uppercase flex items-center gap-1 opacity-70 hover:opacity-100"
                    >
                      {copiedId === msg.id ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                      {copiedId === msg.id ? 'Copied' : 'Copy'}
                    </button>
                  </div>
                  <MessageCard text={msg.text} />
                  <div className="mt-2 text-[10px] font-mono opacity-60">{formatTime(msg.timestamp)}</div>
                </div>
              </div>
            ))}
            {isTyping && (
              <div className="flex justify-start">
                <div className="bg-brand-blue/50 text-white p-2 rounded-lg rounded-tl-none text-xs animate-pulse">
                  Analyzing Project State...
                </div>
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>

          {/* Input */}
          <div className="mt-auto p-3 bg-white border-t-4 border-black">
            <div className="flex gap-2">
              <input
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleSend()}
                placeholder="Ask for help..."
                className="flex-1 bg-slate-100 border-2 border-black rounded px-3 py-2 text-sm focus:outline-none focus:bg-white transition-colors"
                onPointerDown={(e) => e.stopPropagation()} // Allow text selection/focus without dragging
              />
              <button
                onClick={handleSend}
                disabled={!input.trim() || isTyping}
                className="bg-brand-yellow border-2 border-black rounded p-2 hover:bg-black hover:text-brand-yellow transition-colors disabled:opacity-50"
              >
                <Send size={18} />
              </button>
            </div>
          </div>
        </DraggablePanel>
      )}
    </>
  );
};
